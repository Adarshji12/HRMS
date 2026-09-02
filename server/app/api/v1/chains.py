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
from app.models import User, WorkflowRule
from app.schemas.chains import (
    ChainOut,
    ConditionOut,
    FieldOut,
    LevelOut,
    LevelsIn,
    PreviewIn,
    RuleOut,
    RulesIn,
    StepOut,
    SweepOut,
    VocabularyOut,
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


def _rule_out(db, row, names) -> RuleOut:
    """One rule with its chain, resolved for display."""
    rungs = sorted(row.levels, key=lambda level: level.level)
    return RuleOut(
        id=row.id, kind=row.kind, name=row.name, priority=row.priority,
        conditions=[ConditionOut(**clause) for clause in (row.conditions or [])
                    if isinstance(clause, dict)],
        is_fallback=row.is_fallback, is_active=row.is_active,
        levels=[_level_out(rung, names) for rung in rungs],
    )


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


# --------------------------------------------------------------------------- #
# Conditional routing
#
# A rule is a condition plus a whole chain; the first rule whose condition holds
# supplies the chain, and a flow with no matching rule falls back to the plain
# department chain above — which is exactly the behaviour that existed before
# rules did, so a company that writes none sees no change.
# --------------------------------------------------------------------------- #


@router.get("/vocabulary/{kind}", response_model=VocabularyOut)
def vocabulary(kind: str, viewer: CurrentUser) -> VocabularyOut:
    """What a rule on this flow may ask about, and how.

    Served rather than hardcoded in the console: the field list is per flow — a
    leave application has no amount — and a second copy of it in TypeScript is
    one that goes stale the day somebody adds a field here.
    """
    if kind not in workflow.POLICIES:
        raise svc.ChainError("unknown_flow", f"There is no “{kind}” flow.", 404)
    return VocabularyOut(
        fields=[
            FieldOut(key=f.key, label=f.label, type=f.type, options=f.options, help=f.help)
            for f in svc.fields_for(kind)
        ],
        operators=dict(svc.OPERATORS),
    )


@router.get("/rules/{kind}", response_model=list[RuleOut])
def rules(kind: str, admin: AdminUser, db: DbSession) -> list[RuleOut]:
    """Every rule for a flow, in the order they are evaluated.

    Including inactive ones, unlike the resolver: an administrator switching a
    rule off still has to be able to see it, and a rule that vanished when
    disabled would look deleted.
    """
    if kind not in workflow.POLICIES:
        raise svc.ChainError("unknown_flow", f"There is no “{kind}” flow.", 404)

    rows = list(db.scalars(
        select(WorkflowRule).where(
            WorkflowRule.org_id == admin.org_id, WorkflowRule.kind == kind
        )
    ))
    rows.sort(key=lambda r: (r.is_fallback, r.priority, r.created_at))
    names = _names(db, admin.org_id)
    return [_rule_out(db, row, names) for row in rows]


@router.put("/rules/{kind}", response_model=list[RuleOut])
def set_rules(
    kind: str, payload: RulesIn, admin: AdminUser, db: DbSession, request: Request
) -> list[RuleOut]:
    """Replace every rule for one flow, in order.

    A replace rather than per-rule edits: the order of the rules *is* the
    routing, so saving one at a time makes a reorder three saves any of which
    can fail half way, leaving a routing nobody chose.

    **Requests already in flight are untouched**, exactly as with levels: their
    steps were written when they were submitted, and the rule that chose them is
    recorded on the step rather than looked up again.
    """
    if kind not in workflow.POLICIES:
        raise svc.ChainError("unknown_flow", f"There is no “{kind}” flow.", 404)

    saved = svc.set_rules(db, admin, kind, payload.rules, request=request)
    names = _names(db, admin.org_id)
    return [_rule_out(db, row, names) for row in saved]


@router.post("/rules/{kind}/preview", response_model=RuleOut | None)
def preview(
    kind: str, payload: PreviewIn, admin: AdminUser, db: DbSession
) -> RuleOut | None:
    """Which rule would route a request like this one, without submitting it.

    The answer to "I have written six rules, which one catches a ₹60,000 travel
    claim from Sales" — a question an administrator otherwise answers by filing
    a real claim and watching where it goes.

    Evaluated against the **saved** rules, so it tells the truth about what is
    configured rather than about what is on the screen.
    """
    if kind not in workflow.POLICIES:
        raise svc.ChainError("unknown_flow", f"There is no “{kind}” flow.", 404)

    subject = db.get(User, payload.subject_user_id) if payload.subject_user_id else admin
    if subject is None or subject.org_id != admin.org_id:
        raise svc.ChainError("not_found", "No such colleague.", 404)

    matched = svc.match_rule(db, admin.org_id, kind, _Probe(payload.values), subject)
    if matched is None:
        return None
    return _rule_out(db, matched, _names(db, admin.org_id))


class _Probe:
    """A stand-in record built from the values typed into the preview.

    Every field reader in ``services.chains`` reads attributes off the record,
    so a plain object with those attributes is enough to exercise the real
    evaluator. That is the point: the preview must not be a second
    implementation of matching, or it will answer differently from the thing it
    is previewing.
    """

    def __init__(self, values: dict) -> None:
        for key, value in (values or {}).items():
            setattr(self, key, value)

    def __getattr__(self, _name: str):  # anything not supplied is simply absent
        return None
