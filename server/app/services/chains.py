"""Approval chains: configuring them, walking them, and chasing them.

:mod:`app.services.workflow` decides. This decides *who decides next*.

The contract with the kernel is deliberately narrow — three functions:

* :func:`begin` writes the chain onto a record when it enters the flow, or
  returns ``None`` if the flow has no chain configured.
* :func:`current_step` says which rung is waiting.
* :func:`advance` records one decision and answers the only question the kernel
  needs: **is this record finished, or does it move to somebody else?**

Everything else here is configuration and the escalation sweep.

The rule that keeps seven existing flows working
--------------------------------------------------

**No configured chain means exactly the behaviour that came before.** Every
function here returns ``None`` or an empty list when a flow has no levels, the
kernel takes its original single-step path, and no step rows are written. A
company that never opens the setup screen sees no change at all.

That is the correct default rather than a compatibility shim. A two-person
company routing leave through three levels is a company where nothing gets
approved.

Resolution, and what happens when it finds nobody
---------------------------------------------------

A level says *how* to find its reviewer — the requester's manager, that
manager's manager, the department head, a named person, or anybody holding the
flow's capability. Relationships rather than names, because a chain naming Priya
breaks the day Priya changes team.

When a rule resolves to nobody, the step is written **unassigned** and the chain
stops there rather than skipping it. A level with no reviewer is a configuration
problem somebody must see; skipping it would approve things through a gate that
was supposed to exist, silently, which is the worst of the three options.

The one case that *is* skipped is a rung resolving to the requester themselves —
common at the top of a reporting tree, where the department head's own claim
routes to the department head. Asking somebody to approve their own request is
not a gate either, and the kernel's self-review rule already refuses it, so the
step is marked ``skipped`` with that recorded rather than left to deadlock.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import audit
from app.services import attendance
from app.models import Department, Role, User
from app.models.workflowlevels import (
    MAX_LEVELS,
    ReviewerRule,
    StepStatus,
    WorkflowLevel,
    WorkflowStep,
)


class ChainError(HTTPException):
    """A typed refusal, in the house style. ``{"reason", "message"}``."""

    def __init__(self, code: str, message: str, status_code: int = 422) -> None:
        super().__init__(status_code, detail={"reason": code, "message": message})
        self.code = code


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #


def levels_for(
    db: Session, org_id: uuid.UUID, kind: str, department_id: uuid.UUID | None
) -> list[WorkflowLevel]:
    """The chain that applies, department first.

    A department chain **replaces** the company-wide one rather than extending
    it. A chain half inherited and half local is one nobody can read off the
    screen, and "which levels apply to me" stops having an answer anybody can
    give without opening two records.
    """
    if department_id is not None:
        local = list(db.scalars(
            select(WorkflowLevel).where(
                WorkflowLevel.org_id == org_id,
                WorkflowLevel.kind == kind,
                WorkflowLevel.department_id == department_id,
                WorkflowLevel.is_active.is_(True),
            ).order_by(WorkflowLevel.level)
        ))
        if local:
            return local
    return list(db.scalars(
        select(WorkflowLevel).where(
            WorkflowLevel.org_id == org_id,
            WorkflowLevel.kind == kind,
            WorkflowLevel.department_id.is_(None),
            WorkflowLevel.is_active.is_(True),
        ).order_by(WorkflowLevel.level)
    ))


def set_levels(
    db: Session, viewer: User, kind: str, department_id: uuid.UUID | None, rungs,
    *, request: Request | None = None,
) -> list[WorkflowLevel]:
    """Replace one scope's chain.

    A replace rather than a merge, the same choice payroll and goals make: a
    merge leaves a rung from a draft nobody wanted, and a chain with a stale
    level 3 in it approves through a gate the administrator thought they had
    removed.

    **Existing in-flight requests are untouched.** Their steps were written when
    they entered the flow and are read from there, never back through this — see
    the module docstring.
    """
    if len(rungs) > MAX_LEVELS:
        raise ChainError(
            "too_many_levels",
            f"An approval chain may have at most {MAX_LEVELS} levels. More than "
            "that is a signature process, not an approval chain.",
        )

    for position, rung in enumerate(rungs, start=1):
        rule = ReviewerRule(rung.reviewer_rule)
        if rule is ReviewerRule.NAMED_USER:
            if rung.reviewer_user_id is None:
                raise ChainError(
                    "reviewer_required",
                    f"Level {position} names a person but none was chosen.",
                )
            person = db.get(User, rung.reviewer_user_id)
            if person is None or person.org_id != viewer.org_id:
                raise ChainError("not_found", "No such colleague.", 404)
        if rung.escalate_after_days and rung.escalate_to_user_id is None:
            raise ChainError(
                "escalation_point_required",
                f"Level {position} escalates after {rung.escalate_after_days} days "
                "but has nobody to escalate to.",
            )

    for existing in levels_scoped(db, viewer.org_id, kind, department_id):
        db.delete(existing)
    db.flush()

    made: list[WorkflowLevel] = []
    for position, rung in enumerate(rungs, start=1):
        row = WorkflowLevel(
            org_id=viewer.org_id, kind=kind, department_id=department_id,
            level=position, reviewer_rule=rung.reviewer_rule,
            reviewer_user_id=rung.reviewer_user_id,
            auto_forward_days=rung.auto_forward_days,
            escalate_after_days=rung.escalate_after_days,
            escalate_to_user_id=rung.escalate_to_user_id,
        )
        db.add(row)
        made.append(row)
    db.flush()
    audit(db, org_id=viewer.org_id, actor=viewer, action="workflow.levels_set",
          request=request, target_type="workflow_levels", target_id=kind,
          detail={"kind": kind, "department": str(department_id) if department_id else None,
                  "levels": len(made)})
    db.commit()
    return levels_scoped(db, viewer.org_id, kind, department_id)


def levels_scoped(
    db: Session, org_id: uuid.UUID, kind: str, department_id: uuid.UUID | None
) -> list[WorkflowLevel]:
    """Exactly one scope's rows — no falling back to the company-wide chain.

    Distinct from :func:`levels_for` on purpose. The editor has to show an empty
    department chain as empty, or an administrator opening it sees the inherited
    levels and believes they are editing them.
    """
    stmt = select(WorkflowLevel).where(
        WorkflowLevel.org_id == org_id, WorkflowLevel.kind == kind
    )
    stmt = stmt.where(
        WorkflowLevel.department_id == department_id if department_id is not None
        else WorkflowLevel.department_id.is_(None)
    )
    return list(db.scalars(stmt.order_by(WorkflowLevel.level)))


# --------------------------------------------------------------------------- #
# Resolution
# --------------------------------------------------------------------------- #


def resolve_reviewer(
    db: Session, level: WorkflowLevel, subject: User, *, capability: str | None
) -> uuid.UUID | None:
    """Who this rung asks. ``None`` when the rule finds nobody.

    ``None`` is a real answer and the caller must not treat it as "skip": see
    the module docstring on why an unassigned step beats a silently missing one.
    """
    rule = ReviewerRule(level.reviewer_rule)

    if rule is ReviewerRule.REPORTING_MANAGER:
        return subject.manager_id
    if rule is ReviewerRule.SKIP_LEVEL_MANAGER:
        if subject.manager_id is None:
            return None
        manager = db.get(User, subject.manager_id)
        return manager.manager_id if manager else None
    if rule is ReviewerRule.DEPARTMENT_HEAD:
        if subject.department_id is None:
            return None
        department = db.get(Department, subject.department_id)
        return department.head_user_id if department else None
    if rule is ReviewerRule.NAMED_USER:
        return level.reviewer_user_id
    if rule is ReviewerRule.CAPABILITY:
        # A queue rather than a person: nobody is named, and the first holder to
        # act decides. `reviewer_user_id` stays null and `may_act` checks the
        # flag instead.
        return None
    return None


def may_act(db: Session, step: WorkflowStep, viewer: User, *, capability: str | None) -> bool:
    """Whether this person may decide this rung.

    Three ways, and the third is the one worth stating: an **owner may act on
    any rung**. Not because owners outrank the chain, but because a chain whose
    named reviewer has left, or whose department head is vacant, would otherwise
    deadlock with no way out except editing the database. The audit row records
    who actually acted, so an owner short-circuiting a level is visible rather
    than indistinguishable from the level working.
    """
    if step.reviewer_user_id is not None and step.reviewer_user_id == viewer.id:
        return True
    if ReviewerRule(step.reviewer_rule) is ReviewerRule.CAPABILITY:
        return capability is None or bool(getattr(viewer, capability, False))
    return viewer.role_enum is Role.OWNER


# --------------------------------------------------------------------------- #
# Walking a chain
# --------------------------------------------------------------------------- #


def steps_for(db: Session, record_id: uuid.UUID) -> list[WorkflowStep]:
    return list(db.scalars(
        select(WorkflowStep)
        .where(WorkflowStep.record_id == record_id)
        .order_by(WorkflowStep.level)
    ))


def current_step(db: Session, record_id: uuid.UUID) -> WorkflowStep | None:
    """The rung waiting on somebody, or ``None`` if the chain is done or absent."""
    return next((step for step in steps_for(db, record_id) if step.is_open), None)


def begin(
    db: Session, *, org_id: uuid.UUID, kind: str, record_id: uuid.UUID,
    subject: User, capability: str | None = None,
) -> list[WorkflowStep]:
    """Write the chain onto a record entering the flow.

    Returns ``[]`` when the flow has no chain configured, which is the signal to
    the kernel that this is an ordinary single-step approval.

    Idempotent: a record that already has steps keeps them. Re-entering a flow —
    a returned performance review resubmitted, say — must not restart a chain
    whose first two levels already approved.
    """
    existing = steps_for(db, record_id)
    if existing:
        return existing

    rungs = levels_for(db, org_id, kind, subject.department_id)
    if not rungs:
        return []

    made: list[WorkflowStep] = []
    for rung in rungs:
        reviewer_id = resolve_reviewer(db, rung, subject, capability=capability)
        # A rung resolving to the requester is not a gate. The kernel's own
        # self-review rule would refuse it anyway, so it is recorded as skipped
        # rather than left to deadlock.
        skipped = reviewer_id is not None and reviewer_id == subject.id
        step = WorkflowStep(
            org_id=org_id, kind=kind, record_id=record_id,
            subject_user_id=subject.id, level=rung.level,
            reviewer_rule=rung.reviewer_rule, reviewer_user_id=reviewer_id,
            status=StepStatus.SKIPPED.value if skipped else StepStatus.PENDING.value,
            note="Resolved to the requester" if skipped else None,
            auto_forward_days=rung.auto_forward_days,
            escalate_after_days=rung.escalate_after_days,
            escalate_to_user_id=rung.escalate_to_user_id,
        )
        db.add(step)
        made.append(step)
    db.flush()

    first = next((s for s in made if s.is_open), None)
    if first is not None:
        first.started_at = _now()
        db.flush()
    return made


def start_for(
    db: Session, *, kind: str, record_id: uuid.UUID, subject: User,
) -> list[WorkflowStep]:
    """Begin the chain for a request that has just been submitted.

    The one call each flow's submit path makes. Deliberately not folded into
    :func:`decide`: a chain written lazily on the first decision would have its
    first rung consumed by whoever happened to look, and the level-1 reviewer —
    the entire point of routing — would never be the person the queue is waiting
    on.

    Returns ``[]`` when the flow has no chain, which every caller ignores. The
    capability is read from the flow's policy rather than passed, so a service
    adding this call cannot get it wrong.
    """
    from app.services import workflow

    policy = workflow.POLICIES.get(kind)
    return begin(
        db, org_id=subject.org_id, kind=kind, record_id=record_id,
        subject=subject, capability=policy.capability if policy else None,
    )


def is_current_reviewer(db: Session, record_id: uuid.UUID, viewer: User) -> bool:
    """Whether this person is the rung a record is waiting on.

    **This widens visibility, deliberately and narrowly**, and it is the one
    place in this module that does. A chain routing expense claims to Finance at
    level 2 is useless if Finance cannot see the claim: every module scopes its
    own records by line management, and somebody two departments away is out of
    scope by that rule however the chain is configured.

    So each flow's own scope check consults this as an **additional allow**,
    never as an override of a denial. What it grants is exactly: this one
    record, to the person the chain is currently waiting on, while it is still
    waiting. It grants nothing once the step is decided, nothing on other
    records, and nothing to the levels above or below.
    """
    step = current_step(db, record_id)
    if step is None:
        return False
    if step.reviewer_user_id is not None:
        return step.reviewer_user_id == viewer.id
    # A CAPABILITY rung names nobody: the flag is the gate, and the flow's own
    # permission check has already applied it by the time this is asked.
    return ReviewerRule(step.reviewer_rule) is ReviewerRule.CAPABILITY


@dataclass(slots=True)
class Advance:
    """What one decision did to the chain.

    ``final`` is the only thing the kernel acts on: it stamps the record when
    True and leaves it pending when False. The rest is for the response, so a
    reviewer is told "approved, now with Anita" rather than just "approved".
    """

    final: bool
    step: WorkflowStep | None = None
    next_step: WorkflowStep | None = None
    total: int = 0


def advance(
    db: Session, *, record_id: uuid.UUID, viewer: User, approve: bool,
    note: str | None, capability: str | None = None,
) -> Advance:
    """Record one decision on the current rung.

    **A rejection is terminal** at any level. Sending it back to level 1 for
    another attempt is a resubmission, which is the requester's act and a
    different endpoint — a chain that loops on rejection is one where nobody can
    say whether a request was refused or is still going.
    """
    steps = steps_for(db, record_id)
    if not steps:
        # No chain on this record: an ordinary single-step approval.
        return Advance(final=True)

    step = next((s for s in steps if s.is_open), None)
    if step is None:
        # Every rung is settled but the kernel was called again. Its own
        # already-decided guard is the right refusal here, so say nothing.
        return Advance(final=True, total=len(steps))

    if not may_act(db, step, viewer, capability=capability):
        raise ChainError(
            "not_your_step",
            f"This is waiting on level {step.level} of {len(steps)}, and that is "
            "not yours to decide.",
            403,
        )

    step.status = (StepStatus.APPROVED if approve else StepStatus.REJECTED).value
    step.acted_by = viewer.id
    step.acted_at = _now()
    step.note = (note or "").strip() or None
    db.flush()

    if not approve:
        return Advance(final=True, step=step, total=len(steps))

    following = next((s for s in steps if s.level > step.level and s.is_open), None)
    if following is None:
        return Advance(final=True, step=step, total=len(steps))

    following.started_at = _now()
    db.flush()
    return Advance(final=False, step=step, next_step=following, total=len(steps))


# --------------------------------------------------------------------------- #
# The sweep
# --------------------------------------------------------------------------- #


def sweep(db: Session, org_id: uuid.UUID | None = None) -> dict:
    """Auto-forward and escalate rungs that have waited too long.

    Meant for the scheduler. Returns counts rather than rows: the caller logs a
    number, and a job that returned every affected step would hold a company's
    entire pending queue in memory to do it.

    **Escalation is checked before auto-forward.** A rung configured for both
    should reach a human who can act, not slide past them to the next level —
    the point of escalating is that somebody did not respond, and forwarding
    quietly achieves the opposite.
    """
    now = _now()
    stmt = select(WorkflowStep).where(
        WorkflowStep.status == StepStatus.PENDING.value,
        WorkflowStep.started_at.is_not(None),
    )
    if org_id is not None:
        stmt = stmt.where(WorkflowStep.org_id == org_id)

    escalated = forwarded = 0
    for step in db.scalars(stmt):
        # SQLite round-trips DateTime(timezone=True) as naive while Postgres
        # returns it aware; subtracting without normalising is one dialect away
        # from a TypeError that only appears in production.
        started = attendance.as_utc(step.started_at)
        waited = now - started
        if step.escalate_after_days and waited >= timedelta(days=step.escalate_after_days) \
                and step.escalate_to_user_id and step.reviewer_user_id != step.escalate_to_user_id:
            # Reassign rather than close: the rung still needs deciding, by
            # somebody else. Marking it `escalated` and moving on would approve
            # through a gate nobody passed.
            step.reviewer_user_id = step.escalate_to_user_id
            step.started_at = now
            step.note = (
                f"Escalated after {step.escalate_after_days} days with no decision."
            )
            escalated += 1
            continue
        if step.auto_forward_days and waited >= timedelta(days=step.auto_forward_days):
            step.status = StepStatus.ESCALATED.value
            step.acted_at = now
            step.note = (
                f"Auto-forwarded after {step.auto_forward_days} days with no decision."
            )
            following = next(
                (s for s in steps_for(db, step.record_id)
                 if s.level > step.level and s.is_open),
                None,
            )
            if following is not None:
                following.started_at = now
            forwarded += 1
    db.commit()
    return {"escalated": escalated, "auto_forwarded": forwarded}
