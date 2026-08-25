"""One queue: everything waiting for this person to decide.

Until now, "what is waiting for me" was several different screens. A manager who
approves leave, timesheets, attendance corrections, expense claims and loans had
to remember that all five existed and visit each one; anything they forgot sat
there until the employee chased it. The decision kernel made this cheap to fix —
:mod:`app.services.workflow` already knows every flow and what its awaiting-a-
decision state is called — so this module asks each flow for its own queue and
normalises the answers into one list.

**Each flow's own permission rule decides what it contributes, and this module
does not have an opinion.** That is the whole safety argument. A viewer who may
not approve expense claims contributes nothing from expenses; they do not get a
403 that kills the entire queue, and they do not get a peek at somebody's
spending through a door the expenses module did not open. The scoping is the
same: hierarchy for leave, regularization and expenses, the administrator
capability for loans, the approver flag for timesheets — each read from the flow
that owns it, never re-derived here.

**A refusal from one flow is an empty list, not an error.** A queue that 403s
because one of six sources says no is a queue nobody can use. What it must never
do is *silently* drop a flow that failed for some other reason, so an
unexpected error propagates; only the flow's own "you may not" is swallowed.

**Nothing here decides anything.** Every item carries the route that does, and
the guards live where they always did.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import User
from app.models.leave import LeaveApplication, LeaveStatus, LeaveType
from app.models.performance import PerformanceReview, ReviewCycle, ReviewStatus
from app.models.timesheet import ApprovalStatus, TimesheetApproval
from app.services import expenses as expense_svc
from app.services import hierarchy
from app.services import loans as loan_svc
from app.services import regularization as reg_svc
from app.services import workflow


@dataclass(slots=True)
class Pending:
    """One thing waiting for a decision, in whatever flow it came from.

    Flattened deliberately. The alternative — a union of five shapes the console
    switches on — puts the knowledge of six modules into a rendering component,
    and the queue's whole point is that the person reading it should not have to
    think about which module a request came from.
    """

    kind: str
    #: The record's own id, which the deciding route takes.
    id: uuid.UUID
    #: Whose request it is.
    user_id: uuid.UUID
    user_name: str
    #: A one-line description. "Earned Leave, 2 days" — enough to triage on.
    title: str
    #: When it started waiting. Sorted on, so it is never null.
    since: date
    #: Money involved, in paise, where the flow has any. Null where it does not:
    #: a leave request has no amount, and rendering ₹0.00 would be a lie.
    amount_paise: int | None = None
    #: Extra context the console shows under the title.
    detail: str | None = None

    @property
    def waiting_days(self) -> int:
        return max((date.today() - self.since).days, 0)


def _names(db: Session, org_id: uuid.UUID) -> dict[uuid.UUID, str]:
    return {
        row.id: row.full_name
        for row in db.scalars(select(User).where(User.org_id == org_id))
    }


# --------------------------------------------------------------------------- #
# One adapter per flow
# --------------------------------------------------------------------------- #
#
# Each returns [] when the viewer may not decide that kind. None of them
# re-implements a scoping rule; they call the flow's own queue where one exists,
# and where one does not they use the same hierarchy helper the flow's own
# listing uses.


def _leave(db: Session, viewer: User, names: dict) -> list[Pending]:
    if not getattr(viewer, "can_approve_leave", False):
        return []
    scope = hierarchy.visible_user_ids(db, viewer)
    stmt = select(LeaveApplication).where(
        LeaveApplication.org_id == viewer.org_id,
        LeaveApplication.status == LeaveStatus.PENDING.value,
    )
    if scope is not None:
        stmt = stmt.where(LeaveApplication.user_id.in_(scope))
    types = {t.id: t.name for t in db.scalars(
        select(LeaveType).where(LeaveType.org_id == viewer.org_id))}
    out = []
    for row in db.scalars(stmt):
        if row.user_id == viewer.id and not _may_self_review(workflow.LEAVE, viewer):
            # An item that cannot be acted on is worse than an absent one: it is
            # a button that always fails.
            continue
        days = row.duration_milli_days / 1000
        out.append(Pending(
            kind="leave", id=row.id, user_id=row.user_id,
            user_name=names.get(row.user_id, "—"),
            title=f"{types.get(row.leave_type_id, 'Leave')}, {days:g} day"
                  f"{'' if days == 1 else 's'}",
            detail=f"{row.start_date} to {row.end_date}",
            since=row.created_at.date() if row.created_at else row.start_date,
        ))
    return out


def _timesheets(db: Session, viewer: User, names: dict) -> list[Pending]:
    if not getattr(viewer, "can_approve_timesheets", False):
        return []
    scope = hierarchy.visible_user_ids(db, viewer)
    stmt = select(TimesheetApproval).where(
        TimesheetApproval.org_id == viewer.org_id,
        TimesheetApproval.status == ApprovalStatus.SUBMITTED.value,
    )
    if scope is not None:
        stmt = stmt.where(TimesheetApproval.user_id.in_(scope))
    # Only *submitted* periods, not every draft week in the calendar. The
    # timesheet policy lets a manager approve a draft directly — that is how
    # most weeks are signed off — but a queue listing every unsubmitted week for
    # every employee would have thousands of rows and be unusable.
    return [
        Pending(
            kind="timesheet", id=row.id, user_id=row.user_id,
            user_name=names.get(row.user_id, "—"),
            title=f"Timesheet, {row.period_type}",
            detail=f"{row.period_start} to {row.period_end}",
            since=row.submitted_at.date() if row.submitted_at else row.period_end,
        )
        for row in db.scalars(stmt)
        if row.user_id != viewer.id or _may_self_review(workflow.TIMESHEET, viewer)
    ]


def _regularizations(db: Session, viewer: User, names: dict) -> list[Pending]:
    if not getattr(viewer, "can_approve_regularization", False):
        return []
    return [
        Pending(
            kind="regularization", id=row.id, user_id=row.user_id,
            user_name=names.get(row.user_id, "—"),
            title="Attendance correction",
            detail=str(row.date),
            since=row.created_at.date() if row.created_at else row.date,
        )
        for row in reg_svc.review_queue(db, viewer)
        if row.user_id != viewer.id or _may_self_review(workflow.REGULARIZATION, viewer)
    ]


def _expenses(db: Session, viewer: User, names: dict) -> list[Pending]:
    try:
        claims = expense_svc.review_queue(db, viewer)
    except expense_svc.ExpenseError as refusal:
        # Only the flow's own "you may not". Anything else is a real failure and
        # must not be turned into an empty section that looks like "nothing
        # waiting".
        if refusal.code != "not_permitted":
            raise
        return []
    return [
        Pending(
            kind="expense", id=claim.id, user_id=claim.user_id,
            user_name=names.get(claim.user_id, "—"),
            title=claim.title,
            amount_paise=claim.total_amount,
            since=claim.submitted_at.date() if claim.submitted_at
            else claim.created_at.date(),
        )
        for claim in claims
    ]


def _loans(db: Session, viewer: User, names: dict) -> list[Pending]:
    if not loan_svc.can_approve(viewer):
        return []
    return [
        Pending(
            kind="loan", id=loan.id, user_id=loan.user_id,
            user_name=names.get(loan.user_id, "—"),
            title=loan.purpose or "Salary advance",
            amount_paise=loan.principal,
            since=loan.requested_on or loan.created_at.date(),
        )
        for loan in loan_svc.list_loans(db, viewer, status="requested")
        if loan.user_id != viewer.id or _may_self_review(workflow.LOAN, viewer)
    ]


def _performance(db: Session, viewer: User, names: dict) -> list[Pending]:
    """Reviews waiting on this viewer as the assigned manager.

    Scoped by **assignment**, not by the reporting tree: the review records who
    was meant to write it, and a reorganisation mid-cycle must not move somebody's
    appraisal to a manager who did not watch them work. HR sees the ones assigned
    to them, not everybody's — running the round is not the same as writing the
    manager's half, and a hundred rows nobody can act on is not a queue.
    """
    rows = db.scalars(
        select(PerformanceReview).where(
            PerformanceReview.org_id == viewer.org_id,
            PerformanceReview.status == ReviewStatus.SELF_SUBMITTED.value,
            PerformanceReview.manager_id == viewer.id,
        )
    )
    cycles = {
        c.id: c.name for c in db.scalars(
            select(ReviewCycle).where(ReviewCycle.org_id == viewer.org_id))
    }
    return [
        Pending(
            kind="performance", id=row.id, user_id=row.user_id,
            user_name=names.get(row.user_id, "—"),
            title=f"Review — {cycles.get(row.cycle_id, 'appraisal')}",
            detail="self-assessment submitted",
            since=row.self_submitted_at.date() if row.self_submitted_at
            else row.created_at.date(),
        )
        for row in rows
        if row.user_id != viewer.id or _may_self_review(workflow.PERFORMANCE, viewer)
    ]


def _may_self_review(policy: workflow.Policy, viewer: User) -> bool:
    """Whether this viewer could decide their own, per the flow's policy.

    Used to keep un-actionable rows out of the queue rather than to enforce
    anything — the enforcement is the kernel's, on the way in. Two places
    reading the same policy is the point; two places with their own copy of the
    rule would be the problem.
    """
    try:
        workflow.ensure_not_self(policy, _Subject(viewer.id), viewer)
    except workflow.WorkflowError:
        return False
    return True


class _Subject:
    """A stand-in whose subject is the viewer, for asking the policy a
    hypothetical question without a record in hand."""

    def __init__(self, user_id: uuid.UUID) -> None:
        self.user_id = user_id


ADAPTERS = {
    "leave": _leave,
    "timesheet": _timesheets,
    "regularization": _regularizations,
    "expense": _expenses,
    "loan": _loans,
    "performance": _performance,
}


def pending_for(db: Session, viewer: User) -> list[Pending]:
    """Everything awaiting this viewer's decision, oldest first.

    Oldest first, always. A queue sorted newest-first buries the request
    somebody has been waiting a fortnight on — the same reasoning
    ``regularization.review_queue`` gives, applied across all of them at once,
    and more true here because the oldest item is now competing with five flows
    for attention rather than one.
    """
    names = _names(db, viewer.org_id)
    items: list[Pending] = []
    for adapter in ADAPTERS.values():
        items.extend(adapter(db, viewer, names))
    return sorted(items, key=lambda item: (item.since, item.kind))


def counts_for(db: Session, viewer: User) -> dict[str, int]:
    """How many of each kind are waiting — for a badge, without the payload.

    Separate from :func:`pending_for` so a navigation badge on every page does
    not build and discard the full list. It still runs the same adapters, so it
    can never disagree with the queue about what is waiting.
    """
    counts = {kind: 0 for kind in ADAPTERS}
    names = _names(db, viewer.org_id)
    for kind, adapter in ADAPTERS.items():
        counts[kind] = len(adapter(db, viewer, names))
    counts["total"] = sum(counts.values())
    return counts
