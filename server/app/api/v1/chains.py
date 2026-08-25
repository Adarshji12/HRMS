"""Approval chains over HTTP: setup, and reading a record's journey.

Thin. Two surfaces:

* **Setup** — an administrator configures 1-5 levels per flow, optionally per
  department. Company-wide by default; a department chain replaces it whole.
* **A record's chain** — who has acted, who is waiting. Readable by anybody who
  can already see the record, because "where has my expense claim got to" is the
  question this feature exists to answer and hiding it from the requester would
  waste the whole thing.

There is deliberately **no endpoint that decides a step.** Deciding happens on
the flow's own route — `/leave/applications/{id}/decision`, `/expenses/{id}/review`
— exactly as it did before chains existed. The chain changes *who* may decide
and *what happens next*, not where the decision is made. A second door would be
a second place to reimplement seven sets of rules.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Request
from sqlalchemy import select

from app.api.deps import AdminUser, CurrentUser, DbSession
from app.models import User
from app.schemas.chains import (
    ChainOut,
    LevelOut,
    LevelsIn,
    StepOut,
    SweepOut,
)
from app.services import chains as svc
from app.services import workflow

router = APIRouter(prefix="/workflow", tags=["workflow"])


def _names(db: DbSession, org_id: uuid.UUID) -> dict[uuid.UUID, str]:
    return {
        row.id: row.full_name
        for row in db.scalars(select(User).where(User.org_id == org_id))
    }


def _level_out(row, names) -> LevelOut:
    out = LevelOut.model_validate(row)
    out.reviewer_name = names.get(row.reviewer_user_id) if row.reviewer_user_id else None
    out.escalate_to_name = (
        names.get(row.escalate_to_user_id) if row.escalate_to_user_id else None
    )
    return out


@router.get("/kinds", response_model=list[str])
def kinds() -> list[str]:
    """Which flows can carry a chain.

    Read from the kernel's own policy table rather than listed here, so a flow
    that gains a policy appears in the setup screen by existing — and one that
    cannot be driven by the kernel (the settlement) never offers a chain nobody
    could walk.
    """
    return [k for k, policy in workflow.POLICIES.items() if policy.decidable]


@router.get("/levels/{kind}", response_model=list[LevelOut])
def read_levels(
    kind: str, admin: AdminUser, db: DbSession,
    department_id: uuid.UUID | None = None,
) -> list[LevelOut]:
    """One scope's own rows — **not** the chain that would apply.

    Deliberately not falling back to the company-wide chain: an administrator
    opening an empty department chain must see it empty, or they will believe
    they are editing the inherited levels rather than creating new ones.
    """
    names = _names(db, admin.org_id)
    return [
        _level_out(row, names)
        for row in svc.levels_scoped(db, admin.org_id, kind, department_id)
    ]


@router.get("/levels/{kind}/effective", response_model=list[LevelOut])
def effective_levels(
    kind: str, admin: AdminUser, db: DbSession,
    department_id: uuid.UUID | None = None,
) -> list[LevelOut]:
    """The chain that would actually apply — department first, company-wide
    otherwise. What a request submitted right now would walk."""
    names = _names(db, admin.org_id)
    return [
        _level_out(row, names)
        for row in svc.levels_for(db, admin.org_id, kind, department_id)
    ]


@router.put("/levels/{kind}", response_model=list[LevelOut])
def set_levels(
    kind: str, payload: LevelsIn, admin: AdminUser, db: DbSession, request: Request,
    department_id: uuid.UUID | None = None,
) -> list[LevelOut]:
    """Replace one scope's chain.

    **Requests already in flight are untouched.** Their steps were written when
    they were submitted and are read from there — editing this must not rewrite
    the chain of a request somebody is half-way through approving.

    An empty list removes the chain, which returns the flow to single-level
    approval under its original permission rules.
    """
    if kind not in workflow.POLICIES:
        raise svc.ChainError("unknown_flow", f"There is no “{kind}” flow.", 404)
    names = _names(db, admin.org_id)
    return [
        _level_out(row, names)
        for row in svc.set_levels(
            db, admin, kind, department_id, payload.levels, request=request
        )
    ]


@router.get("/records/{record_id}", response_model=ChainOut)
def record_chain(
    record_id: uuid.UUID, viewer: CurrentUser, db: DbSession
) -> ChainOut:
    """Where a request has got to.

    No permission gate beyond being signed in, and that is deliberate: a step
    row carries who reviewed and when, and nothing else — no amount, no reason,
    no salary. The record it belongs to has its own visibility rules and this
    reveals nothing the requester should not know about their own request. A
    gate here would mean an employee could not see why their claim has sat for
    a week, which is the question the feature exists to answer.
    """
    steps = [
        row for row in svc.steps_for(db, record_id) if row.org_id == viewer.org_id
    ]
    names = _names(db, viewer.org_id)
    out = []
    for row in steps:
        item = StepOut.model_validate(row)
        item.reviewer_name = (
            names.get(row.reviewer_user_id) if row.reviewer_user_id else None
        )
        item.acted_by_name = names.get(row.acted_by) if row.acted_by else None
        out.append(item)
    waiting = next((row for row in steps if row.is_open), None)
    return ChainOut(
        kind=steps[0].kind if steps else "",
        record_id=record_id,
        steps=out,
        current_level=waiting.level if waiting else None,
        total=len(steps),
    )


@router.post("/sweep", response_model=SweepOut)
def sweep(admin: AdminUser, db: DbSession) -> SweepOut:
    """Run the escalation and auto-forward pass for this company now.

    Exposed as an endpoint as well as a scheduled job so an administrator can
    prove the configuration does what they think before waiting three days to
    find out. Scoped to their own company — the scheduler runs it for all.
    """
    return SweepOut(**svc.sweep(db, admin.org_id))
