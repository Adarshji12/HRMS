"""Timesheet derivation.

Worked minutes come from two sources that are added, never merged:

* **Tracked** — ``ActivitySegment.duration_s``, what the agent actually saw.
* **Entered** — ``TimeEntry.minutes``, typed in for work the agent could not
  see (a client meeting, a site visit, a phone call).

They are reported separately as well as summed, because "8h, of which 2h was
typed in by hand" is a materially different claim from "8h tracked", and a
manager approving payroll needs to see which they are signing.

Overtime is computed against the employee's ``WorkSchedule``, per day. Summing
a week and comparing to 40h would hide the case that matters: four normal days
and one fourteen-hour Thursday.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from fastapi import Request
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.models import (
    ActivitySegment,
    ApprovalStatus,
    Organization,
    TimeEntry,
    TimesheetApproval,
    User,
    WorkSchedule,
)
from app.services import reports
from app.services import workflow

PeriodType = str  # "daily" | "weekly" | "monthly"


# --------------------------------------------------------------------------- #
# Period arithmetic
# --------------------------------------------------------------------------- #


def period_bounds(day: date, period_type: PeriodType) -> tuple[date, date]:
    """Inclusive [start, end] for the period containing ``day``.

    Weeks start Monday — ISO, and what every Indian and European payroll
    expects. If a customer needs Sunday starts this is the one place to change.
    """
    if period_type == "daily":
        return day, day
    if period_type == "monthly":
        start = day.replace(day=1)
        next_month = (start + timedelta(days=32)).replace(day=1)
        return start, next_month - timedelta(days=1)
    start = day - timedelta(days=day.weekday())
    return start, start + timedelta(days=6)


def iter_days(start: date, end: date):
    current = start
    while current <= end:
        yield current
        current += timedelta(days=1)


# --------------------------------------------------------------------------- #
# Derivation
# --------------------------------------------------------------------------- #


@dataclass
class DayRow:
    day: date
    tracked_minutes: int = 0
    entered_minutes: int = 0
    active_minutes: int = 0
    idle_minutes: int = 0
    billable_minutes: int = 0
    expected_minutes: int = 0
    is_working_day: bool = True
    first_activity: datetime | None = None
    last_activity: datetime | None = None

    @property
    def worked_minutes(self) -> int:
        return self.tracked_minutes + self.entered_minutes

    @property
    def overtime_minutes(self) -> int:
        # Only on a day the employee was expected to work; a Saturday shift is
        # counted whole rather than measured against a zero expectation.
        if not self.is_working_day:
            return self.worked_minutes
        return max(0, self.worked_minutes - self.expected_minutes)

    @property
    def shortfall_minutes(self) -> int:
        if not self.is_working_day:
            return 0
        return max(0, self.expected_minutes - self.worked_minutes)

    def as_dict(self) -> dict:
        return {
            "date": self.day.isoformat(),
            "weekday": self.day.strftime("%a"),
            "is_working_day": self.is_working_day,
            "tracked_minutes": self.tracked_minutes,
            "entered_minutes": self.entered_minutes,
            "worked_minutes": self.worked_minutes,
            "active_minutes": self.active_minutes,
            "idle_minutes": self.idle_minutes,
            "billable_minutes": self.billable_minutes,
            "non_billable_minutes": max(0, self.worked_minutes - self.billable_minutes),
            "expected_minutes": self.expected_minutes,
            "overtime_minutes": self.overtime_minutes,
            "shortfall_minutes": self.shortfall_minutes,
            "first_activity": self.first_activity.isoformat() if self.first_activity else None,
            "last_activity": self.last_activity.isoformat() if self.last_activity else None,
        }


@dataclass
class Timesheet:
    user_id: uuid.UUID
    full_name: str
    email: str
    period_type: PeriodType
    period_start: date
    period_end: date
    timezone: str
    days: list[DayRow] = field(default_factory=list)
    approval: TimesheetApproval | None = None

    def _sum(self, attr: str) -> int:
        return sum(getattr(d, attr) for d in self.days)

    def as_dict(self) -> dict:
        approval = self.approval
        return {
            "user_id": str(self.user_id),
            "full_name": self.full_name,
            "email": self.email,
            "period_type": self.period_type,
            "period_start": self.period_start.isoformat(),
            "period_end": self.period_end.isoformat(),
            "timezone": self.timezone,
            "days": [d.as_dict() for d in self.days],
            "totals": {
                "tracked_minutes": self._sum("tracked_minutes"),
                "entered_minutes": self._sum("entered_minutes"),
                "worked_minutes": self._sum("worked_minutes"),
                "active_minutes": self._sum("active_minutes"),
                "idle_minutes": self._sum("idle_minutes"),
                "billable_minutes": self._sum("billable_minutes"),
                "non_billable_minutes": max(
                    0, self._sum("worked_minutes") - self._sum("billable_minutes")
                ),
                "expected_minutes": self._sum("expected_minutes"),
                "overtime_minutes": self._sum("overtime_minutes"),
                "shortfall_minutes": self._sum("shortfall_minutes"),
                "days_worked": sum(1 for d in self.days if d.worked_minutes > 0),
                "working_days": sum(1 for d in self.days if d.is_working_day),
            },
            "approval": {
                "id": str(approval.id),
                "status": approval.status,
                "submitted_at": approval.submitted_at.isoformat() if approval.submitted_at else None,
                "reviewed_at": approval.reviewed_at.isoformat() if approval.reviewed_at else None,
                "note": approval.note,
                "approved_worked_minutes": approval.approved_worked_minutes,
                "approved_overtime_minutes": approval.approved_overtime_minutes,
            }
            if approval
            else {"status": ApprovalStatus.DRAFT.value},
        }


def _schedule_for(db: Session, user: User) -> WorkSchedule | None:
    if user.schedule_id:
        schedule = db.get(WorkSchedule, user.schedule_id)
        if schedule is not None:
            return schedule
    return db.scalar(
        select(WorkSchedule).where(
            WorkSchedule.org_id == user.org_id, WorkSchedule.is_default.is_(True)
        )
    )


def build(
    db: Session,
    user: User,
    period_start: date,
    period_end: date,
    period_type: PeriodType,
    org_timezone: str,
) -> Timesheet:
    tz_name = user.timezone or org_timezone
    schedule = _schedule_for(db, user)

    sheet = Timesheet(
        user_id=user.id,
        full_name=user.full_name,
        email=user.email,
        period_type=period_type,
        period_start=period_start,
        period_end=period_end,
        timezone=tz_name,
    )

    rows: dict[date, DayRow] = {}
    for day in iter_days(period_start, period_end):
        is_working = schedule.works_on(day.weekday()) if schedule else day.weekday() < 5
        rows[day] = DayRow(
            day=day,
            is_working_day=is_working,
            expected_minutes=(schedule.expected_minutes if schedule and is_working else 0)
            or (480 if is_working and schedule is None else 0),
        )

    # Tracked time, bucketed per calendar day in the employee's own timezone.
    # Done day by day rather than with a SQL date_trunc: that function is
    # Postgres-only at a timezone, and this has to run on the SQLite dev
    # database too. One period is at most 31 small queries.
    for day, row in rows.items():
        start_utc, end_utc = reports.day_bounds(day, tz_name)
        result = db.execute(
            select(
                func.coalesce(func.sum(ActivitySegment.duration_s), 0),
                func.coalesce(func.sum(ActivitySegment.active_s), 0),
                func.coalesce(func.sum(ActivitySegment.idle_s), 0),
                func.min(ActivitySegment.started_at),
                func.max(ActivitySegment.ended_at),
            ).where(
                ActivitySegment.user_id == user.id,
                ActivitySegment.started_at >= start_utc,
                ActivitySegment.started_at < end_utc,
            )
        ).one()
        row.tracked_minutes = round(int(result[0]) / 60)
        row.active_minutes = round(int(result[1]) / 60)
        row.idle_minutes = round(int(result[2]) / 60)
        row.first_activity = result[3]
        row.last_activity = result[4]

        billable = db.scalar(
            select(func.coalesce(func.sum(ActivitySegment.duration_s), 0)).where(
                ActivitySegment.user_id == user.id,
                ActivitySegment.started_at >= start_utc,
                ActivitySegment.started_at < end_utc,
                ActivitySegment.is_billable.is_(True),
            )
        )
        row.billable_minutes = round(int(billable or 0) / 60)

    # Manual entries: one query for the whole period, keyed on entry_date.
    for entry_date, minutes, billable in db.execute(
        select(
            TimeEntry.entry_date,
            func.coalesce(func.sum(TimeEntry.minutes), 0),
            func.coalesce(
                func.sum(case((TimeEntry.is_billable.is_(True), TimeEntry.minutes), else_=0)),
                0,
            ),
        )
        .where(
            TimeEntry.user_id == user.id,
            TimeEntry.entry_date >= period_start,
            TimeEntry.entry_date <= period_end,
        )
        .group_by(TimeEntry.entry_date)
    ):
        row = rows.get(entry_date)
        if row is not None:
            row.entered_minutes += int(minutes)
            row.billable_minutes += int(billable)

    sheet.days = [rows[day] for day in sorted(rows)]
    sheet.approval = db.scalar(
        select(TimesheetApproval).where(
            TimesheetApproval.user_id == user.id,
            TimesheetApproval.period_start == period_start,
            TimesheetApproval.period_type == period_type,
        )
    )
    return sheet


def org_timezone(db: Session, org_id: uuid.UUID) -> str:
    org = db.get(Organization, org_id)
    return org.timezone if org else "UTC"


def get_or_create_approval(
    db: Session,
    user: User,
    period_start: date,
    period_end: date,
    period_type: PeriodType,
) -> TimesheetApproval:
    approval = db.scalar(
        select(TimesheetApproval).where(
            TimesheetApproval.user_id == user.id,
            TimesheetApproval.period_start == period_start,
            TimesheetApproval.period_type == period_type,
        )
    )
    if approval is None:
        approval = TimesheetApproval(
            org_id=user.org_id,
            user_id=user.id,
            period_type=period_type,
            period_start=period_start,
            period_end=period_end,
        )
        db.add(approval)
        db.flush()
    return approval


def decide(
    db: Session,
    *,
    viewer: User,
    target: User,
    period_start: date,
    period_end: date,
    period_type: PeriodType,
    approve: bool,
    note: str | None,
    tz_name: str,
    request: Request | None = None,
) -> TimesheetApproval:
    """Sign off a period, or return it for changes. Does not commit.

    **This used to live in the router**, which is why it was the one approval
    flow with no already-decided guard: there was nowhere the rule was written
    down to be compared against the other five. It is now
    ``services.workflow``'s, declared in ``workflow.TIMESHEET``.

    Approval freezes the totals. That is deliberately duplicated from the
    derived figures: this is the number payroll was run against, and it must not
    move when a segment is later corrected or a retention job deletes old
    activity.
    """
    def freeze() -> None:
        sheet = build(db, target, period_start, period_end, period_type, tz_name)
        totals = sheet.as_dict()["totals"]
        approval.approved_worked_minutes = totals["worked_minutes"]
        approval.approved_billable_minutes = totals["billable_minutes"]
        approval.approved_overtime_minutes = totals["overtime_minutes"]

    approval = get_or_create_approval(db, target, period_start, period_end, period_type)
    workflow.decide(
        db, policy=workflow.TIMESHEET, record=approval, reviewer=viewer,
        approve=approve, note=note, request=request, on_approve=freeze,
        detail={"period": f"{period_start}..{period_end}",
                "worked_minutes": approval.approved_worked_minutes},
    )
    return approval
