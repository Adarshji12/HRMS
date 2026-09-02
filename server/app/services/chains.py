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
from decimal import Decimal
from typing import Any, Callable
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
    WorkflowRule,
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
                WorkflowLevel.rule_id.is_(None),
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
            WorkflowLevel.rule_id.is_(None),
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
        WorkflowLevel.org_id == org_id,
        WorkflowLevel.kind == kind,
        # Rule rungs carry `department_id = NULL` exactly like the company-wide
        # chain, so without this they would be read as part of it — and, since
        # `set_levels` deletes what this returns before writing, saving the
        # company chain would delete every rule's levels.
        WorkflowLevel.rule_id.is_(None),
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
        # Through .has, not getattr: a capability-addressed chain level must
        # find the people a named role granted it, not only those with the
        # column set.
        return capability is None or viewer.has(capability)
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
    subject: User, capability: str | None = None, record: Any = None,
) -> list[WorkflowStep]:
    """Write the chain onto a record entering the flow.

    Returns ``[]`` when the flow has no chain configured, which is the signal to
    the kernel that this is an ordinary single-step approval.

    ``record`` is the thing being approved — the claim, the leave application.
    It is what conditional rules read to decide the routing ("over ₹50,000 adds
    finance"), and it is optional: without it only the rules about the requester
    can match, and the rest fall through to the department chain. That is the
    right failure, because it is the routing this product had before rules.

    **The routing decision is made once, here, and then written down.** The
    steps carry the resolved chain, so editing a rule tomorrow cannot rewrite
    who approves a request submitted today — the same discipline the levels
    already had, extended to the rule that chose them.

    Idempotent: a record that already has steps keeps them. Re-entering a flow —
    a returned performance review resubmitted, say — must not restart a chain
    whose first two levels already approved.
    """
    existing = steps_for(db, record_id)
    if existing:
        return existing

    rungs, rule = resolve_chain(db, org_id, kind, subject, record)
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
            note=(
                "Resolved to the requester" if skipped
                # Written on every rung rather than only the first: a step is
                # read on its own in the approvals queue, and "which rule sent
                # this to me" is the question the reviewer has.
                else (f"Routed by rule: {rule.name}" if rule else None)
            ),
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
    db: Session, *, kind: str, record_id: uuid.UUID, subject: User, record: Any = None,
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
        record=record,
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


# --------------------------------------------------------------------------- #
# Conditional routing
#
# A rule is a condition plus a whole chain, and the first rule whose condition
# holds supplies the chain. Everything in this section is about two questions:
# what a condition may ask about, and what happens when it cannot be answered.
#
# The second question is the one that matters. A condition referring to a field
# this flow does not have, an operator nobody implemented, a record that is not
# loaded — every one of those resolves to **not matched**, never to matched and
# never to an exception. A rule engine that throws takes down the submit button;
# one that matches on failure routes a ₹9,00,000 claim through whichever chain
# happened to be written first. Not matching is the only safe direction: the
# record falls through to the next rule, and ultimately to the fallback or to
# the plain department chain, which is where it went before rules existed.
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Field:
    """One thing a condition may ask about, for one flow.

    ``read`` takes ``(record, subject)`` and returns a comparable value, or
    ``None`` when it cannot be worked out — a missing record, an empty column, a
    date arithmetic that needs a value nobody filled in. ``None`` never matches.
    """

    key: str
    label: str
    #: money | number | days | choice | id | text — what the console renders.
    type: str
    read: Callable[[Any, User], Any]
    #: Where the console fetches options for `choice`/`id` fields, if anywhere.
    options: str | None = None
    help: str | None = None


def _subject_department(_record: Any, subject: User) -> Any:
    return subject.department_id


def _subject_team(_record: Any, subject: User) -> Any:
    return subject.team_id


def _subject_designation(_record: Any, subject: User) -> Any:
    return subject.designation_id


def _subject_role(_record: Any, subject: User) -> Any:
    return subject.role


#: Fields every flow has, because they are about the person rather than the
#: request. A rule can route on these alone — "everything from Sales goes to the
#: sales director" is a legitimate chain with no amount in it.
COMMON_FIELDS: tuple[Field, ...] = (
    Field("department", "Department", "id", _subject_department, options="departments"),
    Field("team", "Team", "id", _subject_team, options="teams"),
    Field("designation", "Designation", "id", _subject_designation, options="designations"),
    Field("role", "Role", "choice", _subject_role, options="roles"),
)


def _amount(attr: str) -> Callable[[Any, User], Any]:
    """Read a money column off the record. Paise, like every amount here."""

    def read(record: Any, _subject: User) -> Any:
        return getattr(record, attr, None) if record is not None else None

    return read


def _attr(attr: str) -> Callable[[Any, User], Any]:
    def read(record: Any, _subject: User) -> Any:
        return getattr(record, attr, None) if record is not None else None

    return read


def _leave_days(record: Any, _subject: User) -> Any:
    """Calendar days applied for, as a number the console can compare against.

    Milli-days are the storage unit and a terrible thing to write a rule in:
    nobody thinks "more than 3000". Divided here so a rule says 3.
    """
    if record is None or getattr(record, "duration_milli_days", None) is None:
        return None
    return record.duration_milli_days / 1000


def _leave_notice(record: Any, _subject: User) -> Any:
    """How many days' warning was given — applied-on to first day off.

    Negative for leave applied for after it started, which is exactly the case
    a company wants to route differently, so it is not clamped at zero.
    """
    if record is None:
        return None
    start = getattr(record, "start_date", None)
    applied = getattr(record, "applied_at", None)
    if start is None or applied is None:
        return None
    applied_day = applied.date() if hasattr(applied, "date") else applied
    return (start - applied_day).days


def _expense_categories(record: Any, _subject: User) -> Any:
    """Every category on the claim, as a list.

    A list rather than one value, because a claim holds many lines and may span
    categories. It is compared with ``any_of`` / ``none_of``, which is why those
    operators exist at all — see the note on OPERATORS.
    """
    if record is None:
        return None
    lines = getattr(record, "lines", None)
    if lines is None:
        return None
    return [line.category_id for line in lines if line.category_id is not None]


#: Per flow, on top of COMMON_FIELDS. A flow absent from here can still be
#: routed on who the requester is, which is what the common fields are for.
FLOW_FIELDS: dict[str, tuple[Field, ...]] = {
    "expense": (
        Field("amount", "Claim total", "money", _amount("total_amount"),
              help="The whole claim, not one line."),
        Field("category", "Expense category", "id", _expense_categories,
              options="expense-categories",
              help="A claim can hold several. Use “is any of” to catch a claim "
                   "that contains one, and “is none of” to catch one that does not."),
        Field("project", "Project", "id", _attr("project_id"), options="projects"),
    ),
    "leave": (
        Field("leave_type", "Leave type", "id", _attr("leave_type_id"), options="leave-types"),
        Field("days", "Days applied for", "days", _leave_days),
        Field("notice_days", "Days of notice", "days", _leave_notice,
              help="From the day it was applied for to the first day off. "
                   "Negative when the leave had already started."),
    ),
    "loan": (
        Field("amount", "Amount requested", "money", _amount("principal")),
        Field("loan_type", "Loan type", "text", _attr("loan_type")),
        Field("instalments", "Instalments", "number", _attr("instalment_count")),
    ),
}


def fields_for(kind: str) -> tuple[Field, ...]:
    """Everything a rule on this flow may ask about."""
    return COMMON_FIELDS + FLOW_FIELDS.get(kind, ())


#: The operators, and what each means for a *list* value like expense
#: categories. `any_of` and `none_of` exist because a claim spanning Travel and
#: Meals is genuinely both, and `eq` has no honest answer for it.
OPERATORS: dict[str, str] = {
    "eq": "is",
    "ne": "is not",
    "gt": "is more than",
    "gte": "is at least",
    "lt": "is less than",
    "lte": "is at most",
    "any_of": "is any of",
    "none_of": "is none of",
}


def _as_number(value: Any) -> float | None:
    """Coerce to a number, or None. Never raises — see the section note."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float, Decimal)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def _same(left: Any, right: Any) -> bool:
    """Equality across the string/UUID boundary.

    Rule values arrive from JSON, so a department id is a string and the
    subject's is a UUID. Comparing them directly is False for every rule
    anybody writes, which would look exactly like "conditions do not work".
    """
    if left is None or right is None:
        return False
    return str(left) == str(right)


def evaluate_clause(clause: Any, record: Any, subject: User, kind: str) -> bool:
    """One clause, against one record. False for anything it cannot answer."""
    if not isinstance(clause, dict):
        return False

    field_key = clause.get("field")
    operator = clause.get("op")
    wanted = clause.get("value")

    field = next((f for f in fields_for(kind) if f.key == field_key), None)
    if field is None or operator not in OPERATORS:
        # An unknown field or operator — a rule written for a flow it was later
        # moved off, or a hand-edited row. Not matched, never an exception.
        return False

    try:
        actual = field.read(record, subject)
    except Exception:  # noqa: BLE001 - a broken read must not break submission
        return False
    if actual is None:
        return False

    # Multi-valued fields: the only operators that mean anything are the set
    # ones, and using another on them is a rule that cannot be satisfied.
    if isinstance(actual, (list, tuple, set)):
        values = {str(v) for v in actual}
        if operator == "any_of":
            return bool(values & {str(v) for v in (wanted or [])})
        if operator == "none_of":
            return not (values & {str(v) for v in (wanted or [])})
        if operator == "eq":
            return bool(values) and values == {str(wanted)}
        return False

    if operator in ("any_of", "none_of"):
        contained = any(_same(actual, option) for option in (wanted or []))
        return contained if operator == "any_of" else not contained

    if operator == "eq":
        return _same(actual, wanted)
    if operator == "ne":
        return not _same(actual, wanted)

    left, right = _as_number(actual), _as_number(wanted)
    if left is None or right is None:
        return False
    if operator == "gt":
        return left > right
    if operator == "gte":
        return left >= right
    if operator == "lt":
        return left < right
    if operator == "lte":
        return left <= right
    return False


def matches(rule: WorkflowRule, record: Any, subject: User) -> bool:
    """Whether a rule's conditions all hold.

    ANDed, and an empty list matches everything — which is what makes a
    fallback rule a rule rather than a special case in the resolver.
    """
    if rule.is_fallback:
        return True
    conditions = rule.conditions or []
    if not isinstance(conditions, list):
        return False
    return all(evaluate_clause(clause, record, subject, rule.kind) for clause in conditions)


def rules_for(db: Session, org_id: uuid.UUID, kind: str) -> list[WorkflowRule]:
    """Active rules for a flow, in the order they are evaluated.

    Fallback last whatever its priority says: a fallback that sorted first would
    match everything and make every rule below it dead, which is a
    misconfiguration nobody would spot from the screen.
    """
    rows = list(db.scalars(
        select(WorkflowRule).where(
            WorkflowRule.org_id == org_id,
            WorkflowRule.kind == kind,
            WorkflowRule.is_active.is_(True),
        )
    ))
    rows.sort(key=lambda r: (r.is_fallback, r.priority, r.created_at))
    return rows


def match_rule(
    db: Session, org_id: uuid.UUID, kind: str, record: Any, subject: User
) -> WorkflowRule | None:
    """The first rule that applies, or None when nothing does.

    None is not a failure. It means this company either writes no rules for
    this flow or wrote none that fit, and the caller falls back to the plain
    department chain — the behaviour that existed before rules did.
    """
    for rule in rules_for(db, org_id, kind):
        if matches(rule, record, subject):
            return rule
    return None


def levels_of_rule(db: Session, rule: WorkflowRule) -> list[WorkflowLevel]:
    return list(db.scalars(
        select(WorkflowLevel)
        .where(WorkflowLevel.rule_id == rule.id, WorkflowLevel.is_active.is_(True))
        .order_by(WorkflowLevel.level)
    ))


def resolve_chain(
    db: Session, org_id: uuid.UUID, kind: str, subject: User, record: Any = None
) -> tuple[list[WorkflowLevel], WorkflowRule | None]:
    """The chain to write onto this record, and the rule that chose it.

    The single place routing is decided, so "why did this go to three people"
    has one answer with one implementation behind it. Order:

    1. The first matching rule's levels, if a rule matches **and has any**.
    2. Otherwise the department chain, then the company-wide one.

    A matching rule with no rungs falls through rather than producing an empty
    chain. An empty chain means "no chain" to the kernel, which silently turns a
    routed approval into a single-step one — so a half-built rule must not be
    able to switch routing off for everybody it matches.
    """
    rule = match_rule(db, org_id, kind, record, subject)
    if rule is not None:
        rungs = levels_of_rule(db, rule)
        if rungs:
            return rungs, rule
    return levels_for(db, org_id, kind, subject.department_id), None


# --------------------------------------------------------------------------- #
# Rule administration
# --------------------------------------------------------------------------- #


def set_rules(
    db: Session, viewer: User, kind: str, payload, *, request: Request | None = None
) -> list[WorkflowRule]:
    """Replace every rule for one flow, in one write.

    A replace rather than per-rule edits, for the same reason ``set_levels`` is:
    the order of the rules *is* the routing, and a screen that saves one rule at
    a time makes reordering three separate saves any of which can fail halfway.

    Rules a company deletes take their rungs with them through the cascade.
    """
    existing = list(db.scalars(
        select(WorkflowRule).where(
            WorkflowRule.org_id == viewer.org_id, WorkflowRule.kind == kind
        )
    ))
    for row in existing:
        db.delete(row)
    db.flush()

    made: list[WorkflowRule] = []
    seen_fallback = False
    for index, spec in enumerate(payload):
        if spec.is_fallback:
            if seen_fallback:
                raise ChainError(
                    "two_fallbacks",
                    "Only one rule can be the fallback — it is what everything "
                    "unmatched falls to, and two of them means the second is dead.",
                )
            seen_fallback = True

        if len(spec.levels) > MAX_LEVELS:
            raise ChainError(
                "too_many_levels",
                f"“{spec.name}” has {len(spec.levels)} levels. A chain may have at "
                f"most {MAX_LEVELS}.",
            )
        for position, rung in enumerate(spec.levels, start=1):
            if ReviewerRule(rung.reviewer_rule) is ReviewerRule.NAMED_USER:
                if rung.reviewer_user_id is None:
                    raise ChainError(
                        "reviewer_required",
                        f"“{spec.name}” level {position} names a person but none was chosen.",
                    )
                person = db.get(User, rung.reviewer_user_id)
                if person is None or person.org_id != viewer.org_id:
                    raise ChainError("not_found", "No such colleague.", 404)
            if rung.escalate_after_days and rung.escalate_to_user_id is None:
                raise ChainError(
                    "escalation_point_required",
                    f"“{spec.name}” level {position} escalates after "
                    f"{rung.escalate_after_days} days but has nobody to escalate to.",
                )

        rule = WorkflowRule(
            org_id=viewer.org_id,
            kind=kind,
            name=spec.name.strip(),
            priority=spec.priority if spec.priority is not None else (index + 1) * 10,
            conditions=[] if spec.is_fallback else [c.model_dump() for c in spec.conditions],
            is_fallback=spec.is_fallback,
            is_active=spec.is_active,
        )
        db.add(rule)
        db.flush()

        for position, rung in enumerate(spec.levels, start=1):
            db.add(WorkflowLevel(
                org_id=viewer.org_id,
                kind=kind,
                department_id=None,
                rule_id=rule.id,
                level=position,
                reviewer_rule=rung.reviewer_rule,
                reviewer_user_id=rung.reviewer_user_id,
                auto_forward_days=rung.auto_forward_days,
                escalate_after_days=rung.escalate_after_days,
                escalate_to_user_id=rung.escalate_to_user_id,
                is_active=True,
            ))
        made.append(rule)

    if request is not None:
        audit(db, org_id=viewer.org_id, actor=viewer, action="workflow.rules_set",
              request=request, target_type="workflow_rules", target_id=kind,
              detail={"rules": len(made)})
    db.commit()
    return rules_for(db, viewer.org_id, kind)
