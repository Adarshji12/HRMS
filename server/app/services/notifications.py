"""Alerting: what is worth telling someone, and telling them exactly once.

Two things live here. ``Kind`` is the catalogue — every alert the product can
send, who it is for, and whether a person may switch it off. ``dispatch`` is the
single door every alert goes through: it checks the recipient's preference,
claims the de-duplication key, sends, and records the outcome.

The distinction that shapes all of it is **event versus condition**.

An event happened once — a timesheet was approved, a device enrolled. Sending it
twice is a bug you notice immediately.

A condition stays true — three timesheets are pending, a trial ends in nine
days, an agent has been silent since 16:02. The periodic runner re-evaluates
these every time it wakes, so without de-duplication a fifteen-minute cadence
mails someone ninety-six times about one silent agent. That is not a smaller
version of being useful; it is how a monitoring product teaches its own staff to
filter it into a folder they never open.

So conditions carry their value in the dedupe key. "agent-silent:2026-08-18" is
a different key from "agent-silent:2026-08-19" — the alert fires again the next
day it is true, and never twice on the same one.
"""

from __future__ import annotations

import enum
import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import NotificationLog, NotificationPreference, Role, User
from app.services import email, mailconfig

log = logging.getLogger(__name__)


class Audience(str, enum.Enum):
    EMPLOYEE = "employee"       # the person being tracked, about themselves
    MANAGER = "manager"         # someone who reviews other people's work
    ADMIN = "admin"             # owner/admin, about the workspace itself


@dataclass(frozen=True)
class KindSpec:
    key: str
    label: str
    description: str
    audience: Audience
    default_on: bool
    #: False for security and compliance mail, which cannot be switched off.
    optional: bool = True


class Kind(str, enum.Enum):
    """The catalogue. Adding one here is the only registration needed."""

    AGENT_SILENT = "agent_silent"
    TIMESHEET_DECIDED = "timesheet_decided"
    TIMESHEET_DUE = "timesheet_due"
    APPROVALS_PENDING = "approvals_pending"
    WEEKLY_SUMMARY = "weekly_summary"
    BILLING_ATTENTION = "billing_attention"
    CAPACITY_WARNING = "capacity_warning"
    DEVICE_ENROLLED = "device_enrolled"

    # --- HRMS ---------------------------------------------------------------
    REGULARIZATION_SUBMITTED = "regularization_submitted"
    REGULARIZATION_DECIDED = "regularization_decided"
    LEAVE_APPLIED = "leave_applied"
    LEAVE_DECIDED = "leave_decided"
    LEAVE_CANCELLED = "leave_cancelled"
    LEAVE_BALANCE_LOW = "leave_balance_low"
    TICKET_ASSIGNED = "ticket_assigned"
    TICKET_RESOLVED = "ticket_resolved"
    OFFBOARDING_COMPLETED = "offboarding_completed"

    @property
    def spec(self) -> KindSpec:
        return SPECS[self]


SPECS: dict[Kind, KindSpec] = {
    Kind.AGENT_SILENT: KindSpec(
        key="agent_silent",
        label="My agent stopped reporting",
        description=(
            "Sent when the desktop agent goes quiet during your working hours. "
            "Tracking gaps are usually only noticed the next day, by which time "
            "the time is gone."
        ),
        audience=Audience.EMPLOYEE,
        default_on=True,
    ),
    Kind.TIMESHEET_DECIDED: KindSpec(
        key="timesheet_decided",
        label="My timesheet was approved or returned",
        description="A decision was made on a timesheet you submitted.",
        audience=Audience.EMPLOYEE,
        default_on=True,
        # A decision about someone's pay is not marketing. It stays on.
        optional=False,
    ),
    Kind.TIMESHEET_DUE: KindSpec(
        key="timesheet_due",
        label="My timesheet is due",
        description="Sent near the end of a period while your timesheet is still a draft.",
        audience=Audience.EMPLOYEE,
        default_on=True,
    ),
    Kind.WEEKLY_SUMMARY: KindSpec(
        key="weekly_summary",
        label="My weekly summary",
        description="Your own hours and productivity for last week, once a week.",
        audience=Audience.EMPLOYEE,
        default_on=True,
    ),
    Kind.APPROVALS_PENDING: KindSpec(
        key="approvals_pending",
        label="Timesheets awaiting my approval",
        description="A daily reminder while submitted timesheets sit unreviewed.",
        audience=Audience.MANAGER,
        default_on=True,
    ),
    Kind.BILLING_ATTENTION: KindSpec(
        key="billing_attention",
        label="Billing needs attention",
        description="Trial ending, payment overdue, or a suspended subscription.",
        audience=Audience.ADMIN,
        default_on=True,
        optional=False,
    ),
    Kind.CAPACITY_WARNING: KindSpec(
        key="capacity_warning",
        label="Seat or storage limit",
        description="Sent when seats run out or screenshot storage passes 90%.",
        audience=Audience.ADMIN,
        default_on=True,
    ),
    Kind.DEVICE_ENROLLED: KindSpec(
        key="device_enrolled",
        label="A device was enrolled against my account",
        description=(
            "Sent when a machine binds to your account with your enrolment key. "
            "If it was not you, that is worth knowing immediately."
        ),
        audience=Audience.EMPLOYEE,
        default_on=True,
        optional=False,
    ),

    # --- HRMS ---------------------------------------------------------------
    # Two of these are non-optional, on the same principle that already makes
    # timesheet_decided non-optional: a decision somebody else made about your
    # attendance record or your leave balance is not marketing, and it is not
    # something the person it happened to may be opted out of hearing.
    Kind.REGULARIZATION_SUBMITTED: KindSpec(
        key="regularization_submitted",
        label="Attendance corrections awaiting my approval",
        description=(
            "Sent when someone who reports to you asks to correct an attendance "
            "record."
        ),
        # An EVENT, deduplicated per request id — not a condition.
        #
        # This description originally promised a daily re-fire while requests sat
        # unreviewed, which reads as a condition and would need a periodic sweep
        # to evaluate it. Phase 2 owns no scheduler job, so nothing would ever
        # have re-fired and the catalogue would have been describing behaviour
        # the product does not have. Corrected to match what ships. A pending-
        # approvals digest is a legitimate future job (approvals_pending already
        # does exactly that for timesheets) — but it would be a second Kind, not
        # a promise quietly attached to this one.
        audience=Audience.MANAGER,
        default_on=True,
    ),
    Kind.REGULARIZATION_DECIDED: KindSpec(
        key="regularization_decided",
        label="My attendance correction was approved or rejected",
        description="A decision was made on an attendance correction you asked for.",
        audience=Audience.EMPLOYEE,
        default_on=True,
        # A decision about someone's attendance record is not marketing. It is
        # also the only notice they get that their own record was rewritten.
        optional=False,
    ),
    Kind.LEAVE_APPLIED: KindSpec(
        key="leave_applied",
        label="Leave requests awaiting my approval",
        description="Sent when one of your reports applies for leave.",
        audience=Audience.MANAGER,
        default_on=True,
    ),
    Kind.LEAVE_DECIDED: KindSpec(
        key="leave_decided",
        label="My leave was approved or rejected",
        description="A decision was made on leave you applied for.",
        audience=Audience.EMPLOYEE,
        default_on=True,
        # Spends a balance and changes whether they are expected at work.
        optional=False,
    ),
    Kind.LEAVE_CANCELLED: KindSpec(
        key="leave_cancelled",
        label="Approved leave was withdrawn",
        description=(
            "Sent to the approving manager when an employee cancels leave that "
            "was already approved. Not covered by the decision alert — that "
            "decision had already been made, and cover may have been arranged "
            "around it."
        ),
        audience=Audience.MANAGER,
        default_on=True,
    ),
    Kind.LEAVE_BALANCE_LOW: KindSpec(
        key="leave_balance_low",
        label="My leave balance is running low",
        description=(
            "Sent near the end of the policy year when accrued leave is about to "
            "lapse or run out."
        ),
        audience=Audience.EMPLOYEE,
        default_on=True,
    ),
    Kind.TICKET_ASSIGNED: KindSpec(
        key="ticket_assigned",
        label="A helpdesk ticket was assigned to me",
        description="Sent when a support ticket is routed to you.",
        audience=Audience.EMPLOYEE,
        default_on=True,
    ),
    Kind.TICKET_RESOLVED: KindSpec(
        key="ticket_resolved",
        label="My helpdesk ticket was resolved",
        description="Sent when a ticket you raised is marked resolved.",
        audience=Audience.EMPLOYEE,
        default_on=True,
    ),
    Kind.OFFBOARDING_COMPLETED: KindSpec(
        key="offboarding_completed",
        label="An exit completed on my team",
        description=(
            "Sent when a leaver's clearance finishes: their account is "
            "deactivated and their devices stop collecting at that moment. IT and "
            "the reporting manager both need to know it has actually happened, "
            "not that it was scheduled."
        ),
        audience=Audience.MANAGER,
        default_on=True,
    ),
}


def wants(db: Session, user: User, kind: Kind) -> bool:
    """Whether this person should receive this kind.

    An inactive account, or one with no address, is never mailed. Beyond that,
    a stored preference wins; absence falls back to the kind's default, so a new
    alert type needs no backfill row per user.
    """
    if not user.is_active or not user.email:
        return False
    spec = kind.spec
    if not spec.optional:
        return True
    pref = db.scalar(
        select(NotificationPreference).where(
            NotificationPreference.user_id == user.id,
            NotificationPreference.kind == kind.value,
        )
    )
    return spec.default_on if pref is None else pref.email_enabled


def already_sent(db: Session, user: User, kind: Kind, dedupe_key: str) -> bool:
    return db.scalar(
        select(NotificationLog.id).where(
            NotificationLog.org_id == user.org_id,
            NotificationLog.user_id == user.id,
            NotificationLog.kind == kind.value,
            NotificationLog.dedupe_key == dedupe_key,
        )
    ) is not None


def dispatch(
    db: Session,
    user: User,
    kind: Kind,
    dedupe_key: str,
    subject: str,
    body: str = "",
    html: str | None = None,
    send_fn: Callable[[], bool] | None = None,
) -> bool:
    """Send one alert, once. True when it was sent or logged, False when skipped.

    The row is written and committed BEFORE the SMTP call, and the unique
    constraint is what makes the claim exclusive: two runners racing on the same
    condition both try to insert, one gets IntegrityError, and only the winner
    talks to the mail server. Claiming after sending would let both send.

    The cost of that ordering is that a crash between the insert and the send
    loses one message rather than duplicating it. For alerts that repeat while
    their condition holds — which is most of these — the next tick with a new
    key covers it, and losing one beats mailing twice.
    """
    if not wants(db, user, kind):
        return False

    entry = NotificationLog(
        org_id=user.org_id,
        user_id=user.id,
        kind=kind.value,
        dedupe_key=dedupe_key,
        channel="email",
        subject=subject[:300],
        status="pending",
    )
    db.add(entry)
    try:
        db.commit()
    except IntegrityError:
        # Someone else already claimed this exact alert. Not an error.
        db.rollback()
        return False

    try:
        # send_fn lets a caller use one of the rich templates in app.services.email
        # while this function still owns the claim, the log row and the outcome —
        # so wording lives with the other wording and de-duplication stays in
        # exactly one place.
        delivered = (
            send_fn() if send_fn
            else email.send(user.email, subject, body, html, org_id=user.org_id)
        )
        if delivered:
            entry.status = "sent"
        else:
            # email.send returns False for two very different situations and
            # they must not share a status: with no connector the body went to
            # the log on purpose, but with one configured a False means the
            # handshake failed and nobody received anything. Reporting the
            # second as "logged" is how a broken mail server looks healthy on
            # the dashboard.
            entry.status = (
                "logged" if not mailconfig.resolve(db, user.org_id).configured else "failed"
            )
            if entry.status == "failed":
                # The real SMTP rejection, not a pointer to a log file. An auth
                # failure, an unknown recipient and a blocked port need three
                # different fixes and this is the only place the operator sees.
                entry.error = (
                    email.last_error() or "delivery failed with no error reported"
                )[:2000]
        entry.sent_at = datetime.now(timezone.utc)
    except Exception as exc:  # noqa: BLE001 - never let a mail failure abort a run
        entry.status = "failed"
        entry.error = str(exc)[:2000]
        log.exception("notification %s to %s failed", kind.value, user.email)
    db.commit()
    # "logged" counts: with no connector, writing the body to the log is the
    # intended outcome, not a failure. "failed" does not.
    return entry.status in ("sent", "logged")


def recipients_for(db: Session, org_id: uuid.UUID, audience: Audience) -> list[User]:
    """Everyone in one organisation who should receive an audience's alerts."""
    stmt = select(User).where(User.org_id == org_id, User.is_active.is_(True))
    users = list(db.scalars(stmt).all())
    if audience is Audience.EMPLOYEE:
        return users
    if audience is Audience.MANAGER:
        return [u for u in users if u.role_enum.can_view_team]
    return [u for u in users if u.role_enum.can_administer]


def set_preference(db: Session, user: User, kind: Kind, enabled: bool) -> None:
    """Upsert one opt-out. Mandatory kinds silently keep their value."""
    if not kind.spec.optional:
        return
    pref = db.scalar(
        select(NotificationPreference).where(
            NotificationPreference.user_id == user.id,
            NotificationPreference.kind == kind.value,
        )
    )
    if pref is None:
        db.add(
            NotificationPreference(
                org_id=user.org_id, user_id=user.id, kind=kind.value, email_enabled=enabled
            )
        )
    else:
        pref.email_enabled = enabled


def preferences_for(db: Session, user: User) -> list[dict]:
    """The catalogue as this person sees it — only kinds their role can receive."""
    stored = {
        p.kind: p.email_enabled
        for p in db.scalars(
            select(NotificationPreference).where(NotificationPreference.user_id == user.id)
        ).all()
    }
    out = []
    for kind, spec in SPECS.items():
        if spec.audience is Audience.MANAGER and not user.role_enum.can_view_team:
            continue
        if spec.audience is Audience.ADMIN and not user.role_enum.can_administer:
            continue
        out.append(
            {
                "kind": spec.key,
                "label": spec.label,
                "description": spec.description,
                "audience": spec.audience.value,
                "optional": spec.optional,
                "enabled": stored.get(spec.key, spec.default_on) if spec.optional else True,
            }
        )
    return out


__all__ = [
    "Audience",
    "Kind",
    "KindSpec",
    "Role",
    "SPECS",
    "already_sent",
    "dispatch",
    "preferences_for",
    "recipients_for",
    "set_preference",
    "wants",
]
