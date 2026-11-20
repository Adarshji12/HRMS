"""Company event mails: the editable, switchable emails HR sees under Settings → Notifications.

Email only. Each event has a built-in subject and body, which a company may switch on or off and
reword. Placeholders in braces — {name}, {manager}, {company}, {date}, {years}, {target}, {amount},
{period} — are filled in when it is sent; an unknown placeholder is left as written.

A mail is claimed in the notification log before it is sent, so a daily job that runs twice, or a
double-clicked button, never sends twice.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import date

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.base import utcnow
from app.db.session import SessionLocal
from app.models import (
    EmployeeProfile, NotificationLog, NotificationOrgSettings, NotificationRule, Organization, User,
)
from app.services import email, mailconfig

log = logging.getLogger(__name__)

PLACEHOLDERS = ["name", "manager", "company", "date", "years", "target", "amount", "period"]


@dataclass(frozen=True)
class Event:
    key: str
    label: str
    description: str
    audience: str            # "employee" | "manager"
    schedule: str | None     # "Daily" for the ones a job sends
    default_on: bool
    subject: str
    body: str


EVENTS: dict[str, Event] = {e.key: e for e in [
    Event("birthday", "Employee Birthday", "Wish the employee on the day.", "employee", "Daily", False,
          "Happy birthday, {name}!",
          "Hi {name},\n\nWishing you a very happy birthday from everyone at {company}. Have a wonderful day!"),
    Event("work_anniversary", "Employee Work Anniversary", "Wish the employee on the anniversary of their joining date.",
          "employee", "Daily", False,
          "Happy work anniversary, {name}!",
          "Hi {name},\n\nToday marks {years} with {company}. Thank you for everything you do."),
    Event("leave_applied", "Leave Applied", "Tell the reporting manager that a request is waiting for them.", "manager", None, True,
          "Leave request from {name}",
          "{name} has applied for leave.\n\n{detail}"),
    Event("leave_approved", "Leave Approved", "Tell the employee their leave has been approved.", "employee", None, True,
          "Your leave request was approved",
          "Hi {name},\n\nYour leave request has been approved.\n\n{detail}"),
    Event("sales_target_assigned", "Sales Target Assigned", "Tell the employee a target has been assigned to them.", "employee", None, False,
          "Your sales target for {period}",
          "Hi {name},\n\nYour target for {period} is {target}. Good luck!"),
    Event("sales_target_completed", "Sales Target Completed", "Tell the reporting manager when a target is met.", "manager", None, False,
          "{name} met their sales target for {period}",
          "{name} has met the target of {target} for {period}. The incentive is {amount}."),
    Event("new_employee_onboarding", "New Employee Onboarding", "Tell the reporting manager when somebody joins their team.",
          "manager", None, False,
          "{name} is joining your team",
          "{name} has been added to your team and joins on {date}. Please welcome them and help them settle in."),
]}


class _Safe(dict):
    def __missing__(self, key: str) -> str:
        return "{" + key + "}"


def render(template: str, ctx: dict) -> str:
    try:
        return template.format_map(_Safe(ctx))
    except (ValueError, IndexError, AttributeError, KeyError):
        return template


def rule_for(db: Session, org_id: uuid.UUID, key: str) -> tuple[bool, str, str]:
    """(on, subject template, body template) for a company, falling back to the defaults."""
    event = EVENTS[key]
    row = db.scalar(select(NotificationRule).where(NotificationRule.org_id == org_id, NotificationRule.event == key))
    if row is None:
        return event.default_on, event.subject, event.body
    return row.is_enabled, (row.subject or event.subject), (row.body or event.body)


def customise(db: Session, org_id: uuid.UUID, key: str, subject: str, body: str, ctx: dict) -> tuple[bool, str, str]:
    """For mails an existing flow already sends: the company's on/off, and its wording when it has any.

    The caller's own subject and body stand unless the company wrote its own.
    """
    row = db.scalar(select(NotificationRule).where(NotificationRule.org_id == org_id, NotificationRule.event == key))
    if row is None:
        return EVENTS[key].default_on, subject, body
    return (
        row.is_enabled,
        render(row.subject, ctx) if row.subject else subject,
        render(row.body, ctx) if row.body else body,
    )


def _deliver(db: Session, org_id: uuid.UUID, recipient: User, key: str, dedupe: str, subject: str, body: str) -> bool:
    if not recipient.is_active or not recipient.email:
        return False
    entry = NotificationLog(org_id=org_id, user_id=recipient.id, kind=key, dedupe_key=dedupe[:120],
                            channel="email", subject=subject[:300], status="pending")
    db.add(entry)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return False
    try:
        if email.send(recipient.email, subject, body, None, org_id=org_id):
            entry.status = "sent"
        else:
            entry.status = "logged" if not mailconfig.resolve(db, org_id).configured else "failed"
            if entry.status == "failed":
                entry.error = (email.last_error() or "delivery failed")[:2000]
        entry.sent_at = utcnow()
    except Exception as exc:  # noqa: BLE001 - a mail failure must never break the caller
        entry.status = "failed"
        entry.error = str(exc)[:2000]
        log.exception("event mail %s failed", key)
    db.commit()
    return entry.status in ("sent", "logged")


def send_in(db: Session, key: str, subject_user: User, *, dedupe: str, ctx: dict | None = None) -> bool:
    """Send one event mail about ``subject_user`` using ``db``. Commits."""
    event = EVENTS[key]
    on, subject_t, body_t = rule_for(db, subject_user.org_id, key)
    if not on:
        return False
    recipient = subject_user
    manager = db.get(User, subject_user.manager_id) if subject_user.manager_id else None
    if event.audience == "manager":
        if manager is None:
            return False
        recipient = manager
    org = db.get(Organization, subject_user.org_id)
    full = {"name": subject_user.full_name, "manager": manager.full_name if manager else "",
            "company": org.name if org else "", "date": "", "years": "", "target": "", "amount": "",
            "period": "", "detail": "", **(ctx or {})}
    return _deliver(db, subject_user.org_id, recipient, key, dedupe, render(subject_t, full), render(body_t, full))


def send_event(key: str, user_id: uuid.UUID, *, dedupe: str, ctx: dict | None = None) -> bool:
    """Same, in a session of its own, for use after a request has committed (e.g. a background task)."""
    with SessionLocal() as db:
        user = db.get(User, user_id)
        return bool(user) and send_in(db, key, user, dedupe=dedupe, ctx=ctx)


def run_daily(on: date | None = None) -> dict:
    """The birthday and work-anniversary mails, for the organisations that switched them on."""
    from app.services.leave import org_today

    totals = {"birthday": 0, "work_anniversary": 0}
    with SessionLocal() as db:
        for org in db.scalars(select(Organization)).all():
            today = on or org_today(db, org.id)
            people = list(db.scalars(select(User).where(User.org_id == org.id, User.is_active.is_(True))))
            if rule_for(db, org.id, "birthday")[0]:
                born = {p.user_id: p.date_of_birth for p in db.scalars(
                    select(EmployeeProfile).where(EmployeeProfile.org_id == org.id, EmployeeProfile.date_of_birth.is_not(None)))}
                for person in people:
                    dob = born.get(person.id)
                    if dob and (dob.month, dob.day) == (today.month, today.day):
                        totals["birthday"] += send_in(db, "birthday", person, dedupe=f"birthday:{today.year}")
            if rule_for(db, org.id, "work_anniversary")[0]:
                for person in people:
                    joined = person.joined_on
                    if joined and joined.year < today.year and (joined.month, joined.day) == (today.month, today.day):
                        years = today.year - joined.year
                        totals["work_anniversary"] += send_in(
                            db, "work_anniversary", person, dedupe=f"anniversary:{today.year}",
                            ctx={"years": f"{years} year{'s' if years != 1 else ''}"})
    return totals


def org_settings(db: Session, org_id: uuid.UUID) -> NotificationOrgSettings:
    row = db.get(NotificationOrgSettings, org_id)
    return row if row is not None else NotificationOrgSettings(org_id=org_id, probation_alert=True, document_alert=True)
