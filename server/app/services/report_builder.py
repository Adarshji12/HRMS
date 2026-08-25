"""The reporting engine.

Twenty-one report types, one shape. Each builder returns columns *and* rows, so
the UI renders any report with one table component and exports any of them with
one CSV writer — adding a twenty-second report means adding a function here and
nothing else. Thirteen of these covered device activity; the other eight came
with the HRMS modules and needed no change to the endpoint, the table component
or the CSV writer, which is the shape earning its keep.

Columns carry a ``type`` so formatting is decided once, centrally: ``duration``
renders as "7h 30m" on screen and as decimal hours in CSV, because a spreadsheet
cannot sum "7h 30m". Getting that wrong is the classic export bug.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Callable

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.models import (
    ActivitySegment,
    Department,
    Designation,
    Device,
    Organization,
    Project,
    Screenshot,
    Team,
    User,
    WorkSession,
)
from app.services import reports as agg
from app.services import timesheets as ts

ColumnType = str  # "text" | "duration" | "number" | "percent" | "money" | "date" | "time"


@dataclass
class Column:
    key: str
    label: str
    type: ColumnType = "text"

    def as_dict(self) -> dict:
        return {"key": self.key, "label": self.label, "type": self.type}


@dataclass
class Report:
    key: str
    title: str
    description: str
    columns: list[Column]
    rows: list[dict] = field(default_factory=list)
    totals: dict | None = None

    def as_dict(self) -> dict:
        return {
            "key": self.key,
            "title": self.title,
            "description": self.description,
            "columns": [c.as_dict() for c in self.columns],
            "rows": self.rows,
            "totals": self.totals,
            "row_count": len(self.rows),
        }


@dataclass
class Filters:
    org_id: uuid.UUID
    start: date
    end: date
    tz_name: str
    scope: list[uuid.UUID] | None  # None = whole org
    project_id: uuid.UUID | None = None

    @property
    def window(self) -> tuple[datetime, datetime]:
        return agg.range_bounds(self.start, self.end, self.tz_name)

    def apply_user(self, stmt, column):
        if self.scope is not None:
            return stmt.where(column.in_(self.scope))
        return stmt


# --------------------------------------------------------------------------- #
# Shared helpers
# --------------------------------------------------------------------------- #


def _users(db: Session, f: Filters) -> list[User]:
    stmt = select(User).where(User.org_id == f.org_id).order_by(User.full_name)
    if f.scope is not None:
        stmt = stmt.where(User.id.in_(f.scope))
    return list(db.scalars(stmt).all())


def _lookup(db: Session, model, org_id: uuid.UUID) -> dict[uuid.UUID, str]:
    return {
        row[0]: row[1]
        for row in db.execute(select(model.id, model.name).where(model.org_id == org_id))
    }


def _segment_totals_by_user(db: Session, f: Filters) -> dict[uuid.UUID, agg.Totals]:
    start, end = f.window
    return agg.per_user_totals(db, f.org_id, start, end)


def _pct(part: int, whole: int) -> float:
    return round(100 * part / whole, 1) if whole else 0.0


# --------------------------------------------------------------------------- #
# Reports
# --------------------------------------------------------------------------- #


def time_report(db: Session, f: Filters) -> Report:
    totals = _segment_totals_by_user(db, f)
    teams = _lookup(db, Team, f.org_id)
    rows = []
    for user in _users(db, f):
        t = totals.get(user.id)
        if t is None:
            continue
        rows.append({
            "employee": user.full_name, "email": user.email,
            "team": teams.get(user.team_id) or "—",
            "tracked": t.tracked_s, "active": t.active_s, "idle": t.idle_s,
            "efficiency": t.efficiency_pct,
        })
    rows.sort(key=lambda r: r["tracked"], reverse=True)
    return Report(
        "time", "Time Report",
        "Total tracked, active and idle time per employee.",
        [
            Column("employee", "Employee"), Column("email", "Email"), Column("team", "Team"),
            Column("tracked", "Tracked", "duration"), Column("active", "Active", "duration"),
            Column("idle", "Idle", "duration"), Column("efficiency", "Active %", "percent"),
        ],
        rows,
        {"tracked": sum(r["tracked"] for r in rows), "active": sum(r["active"] for r in rows),
         "idle": sum(r["idle"] for r in rows)},
    )


def activity_report(db: Session, f: Filters) -> Report:
    """Per employee per day — the granular one people export into Excel."""
    users = {u.id: u for u in _users(db, f)}
    rows = []
    day = f.start
    while day <= f.end:
        d0, d1 = agg.day_bounds(day, f.tz_name)
        for uid, t in agg.per_user_totals(db, f.org_id, d0, d1).items():
            user = users.get(uid)
            if user is None:
                continue
            rows.append({
                "date": day.isoformat(), "employee": user.full_name,
                "tracked": t.tracked_s, "active": t.active_s, "idle": t.idle_s,
                "productive": t.productive_s, "unproductive": t.unproductive_s,
                "productivity": t.productivity_pct,
            })
        day += timedelta(days=1)
    return Report(
        "activity", "Activity Report",
        "Daily activity per employee across the range.",
        [
            Column("date", "Date", "date"), Column("employee", "Employee"),
            Column("tracked", "Tracked", "duration"), Column("active", "Active", "duration"),
            Column("idle", "Idle", "duration"), Column("productive", "Productive", "duration"),
            Column("unproductive", "Unproductive", "duration"),
            Column("productivity", "Productivity", "percent"),
        ],
        rows,
    )


def productivity_report(db: Session, f: Filters) -> Report:
    totals = _segment_totals_by_user(db, f)
    teams = _lookup(db, Team, f.org_id)
    rows = []
    for user in _users(db, f):
        t = totals.get(user.id)
        if t is None:
            continue
        rows.append({
            "employee": user.full_name, "team": teams.get(user.team_id) or "—",
            "productive": t.productive_s, "neutral": t.neutral_s,
            "unproductive": t.unproductive_s, "productivity": t.productivity_pct,
        })
    rows.sort(key=lambda r: r["productivity"], reverse=True)
    return Report(
        "productivity", "Productivity Report",
        "Productive, neutral and unproductive split per employee.",
        [
            Column("employee", "Employee"), Column("team", "Team"),
            Column("productive", "Productive", "duration"),
            Column("neutral", "Neutral", "duration"),
            Column("unproductive", "Unproductive", "duration"),
            Column("productivity", "Productivity", "percent"),
        ],
        rows,
    )


def employee_report(db: Session, f: Filters) -> Report:
    totals = _segment_totals_by_user(db, f)
    teams = _lookup(db, Team, f.org_id)
    departments = _lookup(db, Department, f.org_id)
    titles = _lookup(db, Designation, f.org_id)
    names = {u.id: u.full_name for u in _users(db, f)}
    rows = []
    for user in _users(db, f):
        t = totals.get(user.id, agg.Totals())
        rows.append({
            "employee": user.full_name, "email": user.email,
            "code": user.employee_code or "—",
            "designation": titles.get(user.designation_id) or "—",
            "team": teams.get(user.team_id) or "—",
            "department": departments.get(user.department_id) or "—",
            "manager": names.get(user.manager_id) or "—",
            "status": "Active" if user.is_active else "Disabled",
            "tracked": t.tracked_s, "productivity": t.productivity_pct,
        })
    return Report(
        "employee", "Employee Report",
        "Roster with placement, reporting line and tracked time.",
        [
            Column("employee", "Employee"), Column("email", "Email"), Column("code", "Code"),
            Column("designation", "Designation"), Column("team", "Team"),
            Column("department", "Department"), Column("manager", "Manager"),
            Column("status", "Status"), Column("tracked", "Tracked", "duration"),
            Column("productivity", "Productivity", "percent"),
        ],
        rows,
    )


def team_report(db: Session, f: Filters) -> Report:
    totals = _segment_totals_by_user(db, f)
    teams = _lookup(db, Team, f.org_id)
    buckets: dict[str, dict] = {}
    for user in _users(db, f):
        name = teams.get(user.team_id) or "Unassigned"
        b = buckets.setdefault(name, {"team": name, "members": 0, "tracked": 0, "active": 0,
                                      "productive": 0, "unproductive": 0})
        b["members"] += 1
        t = totals.get(user.id)
        if t:
            b["tracked"] += t.tracked_s
            b["active"] += t.active_s
            b["productive"] += t.productive_s
            b["unproductive"] += t.unproductive_s
    rows = sorted(buckets.values(), key=lambda r: r["tracked"], reverse=True)
    for r in rows:
        r["avg_per_member"] = round(r["tracked"] / max(1, r["members"]))
        r["productivity"] = _pct(r["productive"], r["productive"] + r["unproductive"])
    return Report(
        "team", "Team Report",
        "Aggregated hours and productivity per team.",
        [
            Column("team", "Team"), Column("members", "Members", "number"),
            Column("tracked", "Tracked", "duration"),
            # Active was already being summed per team on every run and then
            # thrown away — the row carried the key, no column declared it, so
            # both the table and the CSV writer dropped it silently. Every other
            # row-level report exposes active time; this one was computing it
            # and hiding it.
            Column("active", "Active", "duration"),
            Column("avg_per_member", "Avg / member", "duration"),
            Column("productive", "Productive", "duration"),
            Column("unproductive", "Unproductive", "duration"),
            Column("productivity", "Productivity", "percent"),
        ],
        rows,
    )


def _breakdown(db: Session, f: Filters, by: str, label: str) -> list[dict]:
    start, end = f.window
    items = agg.top_breakdown(db, f.org_id, start, end, by=by, user_ids=f.scope, limit=200)
    total = sum(i["duration_s"] for i in items) or 1
    return [
        {
            label: i["label"], "duration": i["duration_s"], "active": i["active_s"],
            "share": round(100 * i["duration_s"] / total, 1),
            "classification": i["productivity"],
        }
        for i in items
    ]


def application_report(db: Session, f: Filters) -> Report:
    return Report(
        "application", "Application Report",
        "Time spent per desktop application.",
        [
            Column("application", "Application"), Column("duration", "Total", "duration"),
            Column("active", "Active", "duration"), Column("share", "Share", "percent"),
            Column("classification", "Class"),
        ],
        _breakdown(db, f, "app", "application"),
    )


def website_report(db: Session, f: Filters) -> Report:
    return Report(
        "website", "Website Report",
        "Time spent per website domain, across all browsers.",
        [
            Column("website", "Website"), Column("duration", "Total", "duration"),
            Column("active", "Active", "duration"), Column("share", "Share", "percent"),
            Column("classification", "Class"),
        ],
        _breakdown(db, f, "domain", "website"),
    )


def screenshot_report(db: Session, f: Filters) -> Report:
    start, end = f.window
    stmt = (
        select(
            Screenshot.user_id, func.count(Screenshot.id),
            func.coalesce(func.sum(Screenshot.file_size), 0),
            func.min(Screenshot.captured_at), func.max(Screenshot.captured_at),
        )
        .where(Screenshot.org_id == f.org_id, Screenshot.captured_at >= start,
               Screenshot.captured_at < end)
        .group_by(Screenshot.user_id)
    )
    stmt = f.apply_user(stmt, Screenshot.user_id)
    names = {u.id: u.full_name for u in _users(db, f)}
    rows = [
        {
            "employee": names.get(uid, "—"), "captures": int(count),
            "storage_mb": round(int(size) / 1024 / 1024, 1),
            "first": first.isoformat() if first else None,
            "last": last.isoformat() if last else None,
        }
        for uid, count, size, first, last in db.execute(stmt)
    ]
    rows.sort(key=lambda r: r["captures"], reverse=True)
    return Report(
        "screenshot", "Screenshot Report",
        "Capture counts and storage per employee.",
        [
            Column("employee", "Employee"), Column("captures", "Captures", "number"),
            Column("storage_mb", "Storage (MB)", "number"),
            Column("first", "First capture", "time"), Column("last", "Last capture", "time"),
        ],
        rows,
    )


def timesheet_report(db: Session, f: Filters) -> Report:
    rows = []
    for user in _users(db, f):
        sheet = ts.build(db, user, f.start, f.end, "monthly", f.tz_name).as_dict()
        t = sheet["totals"]
        rows.append({
            "employee": user.full_name,
            "worked": t["worked_minutes"] * 60,
            "tracked": t["tracked_minutes"] * 60,
            "entered": t["entered_minutes"] * 60,
            "expected": t["expected_minutes"] * 60,
            "overtime": t["overtime_minutes"] * 60,
            "shortfall": t["shortfall_minutes"] * 60,
            "billable": t["billable_minutes"] * 60,
            "status": sheet["approval"]["status"],
        })
    rows.sort(key=lambda r: r["worked"], reverse=True)
    return Report(
        "timesheet", "Timesheet Report",
        "Worked against expected hours, with overtime and approval state.",
        [
            Column("employee", "Employee"), Column("worked", "Worked", "duration"),
            Column("tracked", "Tracked", "duration"), Column("entered", "Entered", "duration"),
            Column("expected", "Expected", "duration"), Column("overtime", "Overtime", "duration"),
            Column("shortfall", "Shortfall", "duration"),
            Column("billable", "Billable", "duration"), Column("status", "Status"),
        ],
        rows,
    )


def project_report(db: Session, f: Filters) -> Report:
    start, end = f.window
    stmt = (
        select(
            ActivitySegment.project_id,
            func.coalesce(func.sum(ActivitySegment.duration_s), 0),
            func.coalesce(
                func.sum(case((ActivitySegment.is_billable.is_(True),
                               ActivitySegment.duration_s), else_=0)), 0),
        )
        .where(ActivitySegment.org_id == f.org_id,
               ActivitySegment.started_at >= start, ActivitySegment.started_at < end,
               ActivitySegment.project_id.is_not(None))
        .group_by(ActivitySegment.project_id)
    )
    stmt = f.apply_user(stmt, ActivitySegment.user_id)
    projects = {p.id: p for p in db.scalars(
        select(Project).where(Project.org_id == f.org_id)).all()}

    rows = []
    for pid, total, billable in db.execute(stmt):
        project = projects.get(pid)
        if project is None:
            continue
        rows.append({
            "project": project.name, "client": project.client_name or "—",
            "status": project.status,
            "tracked": int(total), "billable": int(billable),
            "non_billable": int(total) - int(billable),
            "budget": project.budget_minutes * 60,
            "amount": round(int(billable) / 3600 * project.hourly_rate),
        })
    rows.sort(key=lambda r: r["tracked"], reverse=True)
    return Report(
        "project", "Project Report",
        "Hours and billable value per project.",
        [
            Column("project", "Project"), Column("client", "Client"), Column("status", "Status"),
            Column("tracked", "Tracked", "duration"), Column("billable", "Billable", "duration"),
            Column("non_billable", "Non-billable", "duration"),
            Column("budget", "Budget", "duration"), Column("amount", "Value", "money"),
        ],
        rows,
        {"tracked": sum(r["tracked"] for r in rows), "amount": sum(r["amount"] for r in rows)},
    )


def attendance_report(db: Session, f: Filters) -> Report:
    """Per employee per day: first in, last out, and whether they showed up.

    Presence comes from work sessions where available and falls back to
    activity, because an agent that crashed still leaves segments behind — and
    marking someone absent for a crash is the kind of error that ends trust in
    the whole system.
    """
    users = _users(db, f)
    rows = []
    for user in users:
        sheet = ts.build(db, user, f.start, f.end, "monthly", f.tz_name)
        for row in sheet.days:
            if not row.is_working_day and row.worked_minutes == 0:
                continue
            d0, d1 = agg.day_bounds(row.day, f.tz_name)
            session = db.scalar(
                select(func.min(WorkSession.started_at)).where(
                    WorkSession.user_id == user.id,
                    WorkSession.started_at >= d0, WorkSession.started_at < d1,
                )
            )
            present = row.worked_minutes > 0
            rows.append({
                "date": row.day.isoformat(), "employee": user.full_name,
                "status": "Present" if present else ("Absent" if row.is_working_day else "Off"),
                "first_in": (session or row.first_activity).isoformat()
                if (session or row.first_activity) else None,
                "last_out": row.last_activity.isoformat() if row.last_activity else None,
                "worked": row.worked_minutes * 60,
                "expected": row.expected_minutes * 60,
                "overtime": row.overtime_minutes * 60,
            })
    return Report(
        "attendance", "Attendance Report",
        "Daily presence with first-in and last-out times.",
        [
            Column("date", "Date", "date"), Column("employee", "Employee"),
            Column("status", "Status"), Column("first_in", "First in", "time"),
            Column("last_out", "Last out", "time"), Column("worked", "Worked", "duration"),
            Column("expected", "Expected", "duration"),
            Column("overtime", "Overtime", "duration"),
        ],
        rows,
    )


def idle_report(db: Session, f: Filters) -> Report:
    totals = _segment_totals_by_user(db, f)
    rows = []
    for user in _users(db, f):
        t = totals.get(user.id)
        if t is None:
            continue
        rows.append({
            "employee": user.full_name, "tracked": t.tracked_s, "idle": t.idle_s,
            "active": t.active_s, "idle_pct": _pct(t.idle_s, t.tracked_s),
        })
    rows.sort(key=lambda r: r["idle"], reverse=True)
    return Report(
        "idle", "Idle Time Report",
        "Idle time per employee. Idle means no keyboard or mouse input — not absence.",
        [
            Column("employee", "Employee"), Column("tracked", "Tracked", "duration"),
            Column("active", "Active", "duration"), Column("idle", "Idle", "duration"),
            Column("idle_pct", "Idle %", "percent"),
        ],
        rows,
    )


def coding_report(db: Session, f: Filters) -> Report:
    """Time per repository and branch.

    Populated only where the agent can see git context. Lines of code is
    deliberately absent: it cannot be observed from outside an editor, and a
    keystroke-derived estimate rewards verbose code.
    """
    start, end = f.window
    stmt = (
        select(
            ActivitySegment.repo_name, ActivitySegment.branch_name, ActivitySegment.user_id,
            func.coalesce(func.sum(ActivitySegment.duration_s), 0),
            func.coalesce(func.sum(ActivitySegment.active_s), 0),
        )
        .where(ActivitySegment.org_id == f.org_id,
               ActivitySegment.started_at >= start, ActivitySegment.started_at < end,
               ActivitySegment.repo_name.is_not(None))
        .group_by(ActivitySegment.repo_name, ActivitySegment.branch_name,
                  ActivitySegment.user_id)
    )
    stmt = f.apply_user(stmt, ActivitySegment.user_id)
    names = {u.id: u.full_name for u in _users(db, f)}
    rows = [
        {
            "repository": repo, "branch": branch or "—", "employee": names.get(uid, "—"),
            "tracked": int(total), "active": int(active),
        }
        for repo, branch, uid, total, active in db.execute(stmt)
    ]
    rows.sort(key=lambda r: r["tracked"], reverse=True)
    return Report(
        "coding", "Coding Activity Report",
        "Time per repository and branch. Requires an agent that reports git context; "
        "lines of code is not measurable from outside the editor and is not estimated.",
        [
            Column("repository", "Repository"), Column("branch", "Branch"),
            Column("employee", "Employee"), Column("tracked", "Tracked", "duration"),
            Column("active", "Active", "duration"),
        ],
        rows,
    )


# --------------------------------------------------------------------------- #
# HRMS
#
# Eight builders, same contract as the thirteen above: columns + rows, one
# `type` per column so formatting is decided centrally. They read models
# directly rather than calling the module services — a report is a read-only
# projection and must not be able to trip a service's write path or its locking.
# --------------------------------------------------------------------------- #


def _days(milli_days: int) -> float:
    """Milli-days to days for display.

    Balances are stored as integer thousandths of a day (D-012) so half-days and
    accrual remainders survive arithmetic exactly. Presentation is the one place
    that division is safe, because nothing downstream adds these back up — the
    CSV writer emits this number and stops.
    """
    return round(milli_days / 1000, 3)


_LATE_EARLY_COLUMNS = [
    Column("date", "Date", "date"), Column("employee", "Employee"),
    Column("shift", "Shift"),
    Column("check_in", "In", "time"), Column("check_out", "Out", "time"),
    Column("late", "Late by", "duration"), Column("early_out", "Left early by", "duration"),
    Column("missing_punch", "Missing punch"), Column("regularized", "Regularized"),
]

_REGULARIZATION_COLUMNS = [
    Column("date", "Date", "date"), Column("employee", "Employee"),
    Column("requested_in", "Requested in", "time"),
    Column("requested_out", "Requested out", "time"),
    Column("reason", "Reason"), Column("status", "Status"),
    Column("filed_by", "Filed by"), Column("reviewed_by", "Reviewed by"),
    Column("reviewed_at", "Reviewed at", "date"), Column("review_note", "Note"),
]

_LEAVE_BALANCE_COLUMNS = [
    Column("employee", "Employee"), Column("leave_type", "Leave type"),
    Column("year", "Year", "number"),
    Column("opening", "Opening", "number"), Column("accrued", "Accrued", "number"),
    Column("used", "Used", "number"), Column("adjusted", "Adjusted", "number"),
    Column("available", "Available", "number"),
    Column("adjustment_reason", "Adjustment reason"),
]

_LEAVE_APPLICATION_COLUMNS = [
    Column("employee", "Employee"), Column("leave_type", "Leave type"),
    Column("start", "From", "date"), Column("end", "To", "date"),
    Column("days", "Days", "number"), Column("half_day", "Half day"),
    Column("status", "Status"), Column("reason", "Reason"),
    Column("reviewed_by", "Reviewed by"), Column("applied_at", "Applied", "date"),
]

_HOLIDAY_COLUMNS = [
    Column("date", "Date", "date"), Column("holiday", "Holiday"),
    Column("kind", "Kind"), Column("taken_by", "Taken by", "number"),
    Column("eligible", "Eligible", "number"), Column("uptake_pct", "Uptake", "percent"),
    Column("active", "Active"),
]

_ASSET_REGISTER_COLUMNS = [
    Column("asset_tag", "Tag"), Column("category", "Category"),
    Column("serial_number", "Serial"), Column("status", "Status"),
    Column("holder", "Held by"), Column("held_since", "Held since", "date"),
    Column("purchase_date", "Purchased", "date"),
]

_ASSET_HISTORY_COLUMNS = [
    Column("asset_tag", "Tag"), Column("category", "Category"),
    Column("holder", "Holder"),
    Column("assigned_at", "Issued", "date"), Column("returned_at", "Returned", "date"),
    Column("open", "Still held"),
    Column("issue_note", "Issue note"), Column("return_note", "Return note"),
]

_ONBOARDING_COLUMNS = [
    Column("employee", "Employee"), Column("joining_date", "Joining", "date"),
    Column("template", "Checklist"), Column("status", "Status"),
    Column("done", "Done", "number"), Column("in_progress", "In progress", "number"),
    Column("pending", "Pending", "number"), Column("skipped", "Skipped", "number"),
    Column("complete_pct", "Complete", "percent"),
]

def late_early_report(db: Session, f: Filters) -> Report:
    """Who arrived late or left early, against the shift in force that day.

    Punctuality is *computed*, never read from a column (D-010). ``day_out``
    resolves it against the rota that applied on the date itself, so backdating
    a shift assignment corrects this report instead of leaving it lying — which
    a stored ``is_late`` flag would.
    """
    from app.models import AttendanceRecord
    from app.services import attendance as att

    org = db.get(Organization, f.org_id)
    users = _users(db, f)
    names = {u.id: u.full_name for u in users}
    if not users:
        return Report("late_early", "Late/Early Log", "No employees in scope.",
                      _LATE_EARLY_COLUMNS, [])

    resolver = att.ShiftResolver(db, f.org_id, [u.id for u in users])
    stmt = (
        select(AttendanceRecord)
        .where(
            AttendanceRecord.org_id == f.org_id,
            AttendanceRecord.date >= f.start,
            AttendanceRecord.date <= f.end,
            AttendanceRecord.user_id.in_(list(names)),
        )
        .order_by(AttendanceRecord.date, AttendanceRecord.user_id)
    )

    rows: list[dict] = []
    late_total = early_total = 0
    for record in db.scalars(stmt).all():
        view = att.day_out(record, org, resolver.shift_for(record.user_id, record.date))
        # Only rows with something to answer for. A report of every day, most of
        # them blank, is a report nobody opens twice.
        if not (view.is_late or view.is_early_out or view.is_missing_punch):
            continue
        late_total += view.late_minutes
        early_total += view.early_out_minutes
        rows.append({
            "date": record.date.isoformat(),
            "employee": names.get(record.user_id, ""),
            "shift": view.shift_name or "Unassigned",
            "check_in": view.check_in_at.isoformat() if view.check_in_at else None,
            "check_out": view.check_out_at.isoformat() if view.check_out_at else None,
            "late": view.late_minutes * 60,
            "early_out": view.early_out_minutes * 60,
            "missing_punch": "Yes" if view.is_missing_punch else "",
            "regularized": "Yes" if view.is_regularized else "",
        })

    return Report(
        "late_early", "Late/Early Log",
        "Arrivals after grace and departures before shift end, measured against the "
        "shift in force on each day. Days with nothing to report are omitted.",
        _LATE_EARLY_COLUMNS, rows,
        {"late": late_total * 60, "early_out": early_total * 60},
    )


def regularization_report(db: Session, f: Filters) -> Report:
    """Every attendance correction asked for, and what happened to it.

    This is the audit surface for D-006: an attendance row points at only the
    *latest* approved correction, so the history of a contested day lives here
    and nowhere else.
    """
    from app.models import RegularizationRequest

    users = _users(db, f)
    names = {u.id: u.full_name for u in users}
    all_names = {u.id: u.full_name for u in db.scalars(
        select(User).where(User.org_id == f.org_id)).all()}

    stmt = (
        select(RegularizationRequest)
        .where(
            RegularizationRequest.org_id == f.org_id,
            RegularizationRequest.date >= f.start,
            RegularizationRequest.date <= f.end,
        )
        .order_by(RegularizationRequest.date.desc())
    )
    if f.scope is not None:
        stmt = stmt.where(RegularizationRequest.user_id.in_(list(names)))

    rows = []
    for req in db.scalars(stmt).all():
        rows.append({
            "date": req.date.isoformat(),
            "employee": all_names.get(req.user_id, ""),
            "requested_in": req.requested_check_in.isoformat() if req.requested_check_in else None,
            "requested_out": req.requested_check_out.isoformat() if req.requested_check_out else None,
            "reason": req.reason,
            "status": req.status.replace("_", " ").title(),
            "filed_by": all_names.get(req.created_by_user_id, "") if req.created_by_user_id else "",
            "reviewed_by": all_names.get(req.reviewed_by_user_id, "") if req.reviewed_by_user_id else "",
            "reviewed_at": req.reviewed_at.isoformat() if req.reviewed_at else None,
            "review_note": req.review_note or "",
        })
    return Report(
        "regularization", "Regularization Log",
        "Attendance corrections requested, approved and rejected. The full history "
        "of a day, including corrections that were later superseded.",
        _REGULARIZATION_COLUMNS, rows,
    )


def leave_balance_report(db: Session, f: Filters) -> Report:
    """Balances with their components shown, never a single number.

    The four components are stored separately on purpose so a manual correction
    is visible and auditable rather than a silent overwrite. Collapsing them
    here would undo exactly that, so the report shows all four and the derived
    figure beside them.
    """
    from app.models import LeaveBalance, LeaveType

    users = _users(db, f)
    names = {u.id: u.full_name for u in users}
    types = {t.id: t for t in db.scalars(
        select(LeaveType).where(LeaveType.org_id == f.org_id)).all()}

    stmt = select(LeaveBalance).where(LeaveBalance.org_id == f.org_id)
    if f.scope is not None:
        stmt = stmt.where(LeaveBalance.user_id.in_(list(names)))

    rows = []
    for bal in db.scalars(stmt).all():
        ltype = types.get(bal.leave_type_id)
        if ltype is None:
            continue
        available = (
            bal.opening_milli_days + bal.accrued_milli_days
            + bal.adjusted_milli_days - bal.used_milli_days
        )
        rows.append({
            "employee": names.get(bal.user_id, ""),
            "leave_type": ltype.name,
            "year": bal.year,
            "opening": _days(bal.opening_milli_days),
            "accrued": _days(bal.accrued_milli_days),
            "used": _days(bal.used_milli_days),
            "adjusted": _days(bal.adjusted_milli_days),
            "available": _days(available),
            "adjustment_reason": bal.adjusted_reason or "",
        })
    rows.sort(key=lambda r: (r["employee"], r["leave_type"]))
    return Report(
        "leave_balance", "Leave Balance",
        "Opening, accrued, used and manually adjusted, with the available figure "
        "derived from them. The components are shown because a correction that is "
        "not visible is not auditable.",
        _LEAVE_BALANCE_COLUMNS, rows,
    )


def leave_applications_report(db: Session, f: Filters) -> Report:
    """Applications overlapping the window, with the duration that was frozen.

    ``duration_milli_days`` is reported as stored, never recomputed — the whole
    point of freezing it at apply time is that a later holiday-calendar edit
    cannot retroactively change what was debited.
    """
    from app.models import LeaveApplication, LeaveType

    users = _users(db, f)
    names = {u.id: u.full_name for u in users}
    all_names = {u.id: u.full_name for u in db.scalars(
        select(User).where(User.org_id == f.org_id)).all()}
    types = {t.id: t.name for t in db.scalars(
        select(LeaveType).where(LeaveType.org_id == f.org_id)).all()}

    stmt = (
        select(LeaveApplication)
        .where(
            LeaveApplication.org_id == f.org_id,
            # Overlap, not containment: leave spanning the window edge is still
            # leave taken in the window.
            LeaveApplication.end_date >= f.start,
            LeaveApplication.start_date <= f.end,
        )
        .order_by(LeaveApplication.start_date.desc())
    )
    if f.scope is not None:
        stmt = stmt.where(LeaveApplication.user_id.in_(list(names)))

    rows = []
    total = 0
    for app_row in db.scalars(stmt).all():
        total += app_row.duration_milli_days
        rows.append({
            "employee": all_names.get(app_row.user_id, ""),
            "leave_type": types.get(app_row.leave_type_id, ""),
            "start": app_row.start_date.isoformat(),
            "end": app_row.end_date.isoformat(),
            "days": _days(app_row.duration_milli_days),
            "half_day": app_row.half_day_session or "",
            "status": app_row.status.replace("_", " ").title(),
            "reason": app_row.reason or "",
            "reviewed_by": all_names.get(app_row.reviewed_by_user_id, "")
            if app_row.reviewed_by_user_id else "",
            "applied_at": app_row.applied_at.isoformat() if app_row.applied_at else None,
        })
    return Report(
        "leave_applications", "Leave Applications",
        "Leave overlapping the window, with the duration frozen at the time of "
        "application.",
        _LEAVE_APPLICATION_COLUMNS, rows, {"days": _days(total)},
    )


def holiday_utilization_report(db: Session, f: Filters) -> Report:
    """Holidays in the window, and for optional ones, who opted in.

    A fixed holiday has no opt-in and reports headcount as the whole scope; an
    optional one reports only the people who chose it. Reporting both as the
    same number is what makes an optional-holiday list useless.
    """
    from app.models import Holiday, OptionalHolidayOptIn

    users = _users(db, f)
    scope_ids = {u.id for u in users}

    holidays = db.scalars(
        select(Holiday).where(
            Holiday.org_id == f.org_id,
            Holiday.holiday_date >= f.start,
            Holiday.holiday_date <= f.end,
        ).order_by(Holiday.holiday_date)
    ).all()

    opt_ins: dict[uuid.UUID, int] = {}
    for hid, uid in db.execute(
        select(OptionalHolidayOptIn.holiday_id, OptionalHolidayOptIn.user_id)
        .where(OptionalHolidayOptIn.org_id == f.org_id)
    ):
        if uid in scope_ids:
            opt_ins[hid] = opt_ins.get(hid, 0) + 1

    rows = []
    for hol in holidays:
        optional = bool(hol.is_optional)
        taken = opt_ins.get(hol.id, 0) if optional else len(scope_ids)
        rows.append({
            "date": hol.holiday_date.isoformat(),
            "holiday": hol.name,
            "kind": "Optional" if optional else "Fixed",
            "taken_by": taken,
            "eligible": len(scope_ids),
            "uptake_pct": round(taken * 100 / len(scope_ids), 1) if scope_ids else 0,
            "active": "" if hol.is_active else "Inactive",
        })
    return Report(
        "holiday_utilization", "Holiday Utilization",
        "Holidays in the window. Optional holidays count only the employees who "
        "opted in; fixed holidays apply to everyone in scope.",
        _HOLIDAY_COLUMNS, rows,
    )


def asset_register_report(db: Session, f: Filters) -> Report:
    """Every asset and who is holding it now.

    The holder comes from the open assignment row rather than from
    ``assets.status``, because the ledger is the record and the status column is
    a denormalised convenience that a service bug could desynchronise.
    """
    from app.models import Asset, AssetAssignment

    all_names = {u.id: u.full_name for u in db.scalars(
        select(User).where(User.org_id == f.org_id)).all()}

    holders: dict[uuid.UUID, tuple[uuid.UUID, datetime]] = {}
    for row in db.execute(
        select(AssetAssignment.asset_id, AssetAssignment.user_id, AssetAssignment.assigned_at)
        .where(AssetAssignment.org_id == f.org_id, AssetAssignment.returned_at.is_(None))
    ):
        holders[row[0]] = (row[1], row[2])

    rows = []
    for asset in db.scalars(
        select(Asset).where(Asset.org_id == f.org_id).order_by(Asset.asset_tag)
    ).all():
        held = holders.get(asset.id)
        rows.append({
            "asset_tag": asset.asset_tag,
            "category": asset.category.replace("_", " ").title(),
            "serial_number": asset.serial_number or "",
            "status": asset.status.replace("_", " ").title(),
            "holder": all_names.get(held[0], "") if held else "",
            "held_since": held[1].isoformat() if held else None,
            "purchase_date": asset.purchase_date.isoformat() if asset.purchase_date else None,
        })
    return Report(
        "asset_register", "Asset Register",
        "Every asset with its current holder, taken from the custody ledger rather "
        "than the status column.",
        _ASSET_REGISTER_COLUMNS, rows,
    )


def asset_history_report(db: Session, f: Filters) -> Report:
    """Custody movements in the window — issues and returns.

    Included on overlap rather than on ``assigned_at`` alone, so a laptop issued
    last quarter and returned this one appears in the quarter it came back.
    """
    from app.models import Asset, AssetAssignment
    from sqlalchemy import or_

    all_names = {u.id: u.full_name for u in db.scalars(
        select(User).where(User.org_id == f.org_id)).all()}
    assets = {a.id: a for a in db.scalars(
        select(Asset).where(Asset.org_id == f.org_id)).all()}

    start_dt, end_dt = f.window
    rows = []
    for row in db.scalars(
        select(AssetAssignment)
        .where(
            AssetAssignment.org_id == f.org_id,
            or_(
                AssetAssignment.assigned_at.between(start_dt, end_dt),
                AssetAssignment.returned_at.between(start_dt, end_dt),
            ),
        )
        .order_by(AssetAssignment.assigned_at.desc())
    ).all():
        asset = assets.get(row.asset_id)
        rows.append({
            "asset_tag": asset.asset_tag if asset else "",
            "category": asset.category.replace("_", " ").title() if asset else "",
            "holder": all_names.get(row.user_id, ""),
            "assigned_at": row.assigned_at.isoformat() if row.assigned_at else None,
            "returned_at": row.returned_at.isoformat() if row.returned_at else None,
            "open": "Yes" if row.returned_at is None else "",
            "issue_note": row.assigned_condition_note or "",
            "return_note": row.returned_condition_note or "",
        })
    return Report(
        "asset_history", "Assignment History",
        "Issues and returns overlapping the window, including custody still open.",
        _ASSET_HISTORY_COLUMNS, rows,
    )


def onboarding_status_report(db: Session, f: Filters) -> Report:
    """New hires and how far through their checklist they are.

    Progress counts ``skipped`` as settled, matching the rule the offboarding
    gate uses: an item somebody deliberately waived must not hold a pipeline
    open forever.
    """
    from app.models import OnboardingInstance, OnboardingTask

    all_names = {u.id: u.full_name for u in db.scalars(
        select(User).where(User.org_id == f.org_id)).all()}

    stmt = (
        select(OnboardingInstance)
        .where(
            OnboardingInstance.org_id == f.org_id,
            OnboardingInstance.joining_date >= f.start,
            OnboardingInstance.joining_date <= f.end,
        )
        .order_by(OnboardingInstance.joining_date.desc())
    )
    if f.scope is not None:
        stmt = stmt.where(OnboardingInstance.user_id.in_(f.scope))

    instances = list(db.scalars(stmt).all())
    counts: dict[uuid.UUID, dict[str, int]] = {}
    if instances:
        for iid, status, n in db.execute(
            select(OnboardingTask.instance_id, OnboardingTask.status, func.count())
            .where(OnboardingTask.instance_id.in_([i.id for i in instances]))
            .group_by(OnboardingTask.instance_id, OnboardingTask.status)
        ):
            counts.setdefault(iid, {})[status] = n

    rows = []
    for inst in instances:
        by_status = counts.get(inst.id, {})
        total = sum(by_status.values())
        settled = by_status.get("done", 0) + by_status.get("skipped", 0)
        rows.append({
            "employee": all_names.get(inst.user_id, ""),
            "joining_date": inst.joining_date.isoformat() if inst.joining_date else None,
            "template": inst.template_name or "",
            "status": inst.status.replace("_", " ").title(),
            "done": by_status.get("done", 0),
            "in_progress": by_status.get("in_progress", 0),
            "pending": by_status.get("pending", 0),
            "skipped": by_status.get("skipped", 0),
            "complete_pct": round(settled * 100 / total, 1) if total else 0,
        })
    return Report(
        "onboarding_status", "Onboarding Status",
        "New hires joining in the window and their checklist progress. Skipped "
        "items count as settled — a deliberately waived task must not hold a "
        "pipeline open forever.",
        _ONBOARDING_COLUMNS, rows,
    )


BUILDERS: dict[str, Callable[[Session, Filters], Report]] = {
    "time": time_report,
    "activity": activity_report,
    "productivity": productivity_report,
    "employee": employee_report,
    "team": team_report,
    "application": application_report,
    "website": website_report,
    "screenshot": screenshot_report,
    "timesheet": timesheet_report,
    "project": project_report,
    "attendance": attendance_report,
    "idle": idle_report,
    "coding": coding_report,
    # HRMS
    "late_early": late_early_report,
    "regularization": regularization_report,
    "leave_balance": leave_balance_report,
    "leave_applications": leave_applications_report,
    "holiday_utilization": holiday_utilization_report,
    "asset_register": asset_register_report,
    "asset_history": asset_history_report,
    "onboarding_status": onboarding_status_report,
}


CATALOGUE = [
    {"key": "time", "title": "Time Report", "group": "Time"},
    {"key": "activity", "title": "Activity Report", "group": "Time"},
    # Retitled, key deliberately unchanged. The HRMS Attendance module (punch +
    # geofence) is ground truth about whether someone was at work; this report
    # only ever knew whether a device was busy, and the two must not both be
    # called "Attendance" once the new one ships — see HRMS_EXPANSION_PLAN §10.
    #
    # The key stays "attendance" because the console puts it in the URL (?r=key),
    # so changing it would silently break every bookmarked or shared link to this
    # report. A key that no longer matches its title is a small internal oddity;
    # a dead link somebody saved is a user-visible regression. The title is what
    # anyone actually reads.
    {"key": "attendance", "title": "Device Activity Presence", "group": "Time"},
    {"key": "idle", "title": "Idle Time Report", "group": "Time"},
    {"key": "timesheet", "title": "Timesheet Report", "group": "Time"},
    {"key": "productivity", "title": "Productivity Report", "group": "Productivity"},
    {"key": "application", "title": "Application Report", "group": "Productivity"},
    {"key": "website", "title": "Website Report", "group": "Productivity"},
    {"key": "screenshot", "title": "Screenshot Report", "group": "Productivity"},
    {"key": "employee", "title": "Employee Report", "group": "People"},
    {"key": "team", "title": "Team Report", "group": "People"},
    {"key": "project", "title": "Project Report", "group": "Work"},
    {"key": "coding", "title": "Coding Activity Report", "group": "Work"},
    # HRMS. New groups rather than rows appended to Time/People: these answer
    # questions about employment, not about what a machine was doing.
    {"key": "late_early", "title": "Late/Early Log", "group": "Attendance"},
    {"key": "regularization", "title": "Regularization Log", "group": "Attendance"},
    {"key": "leave_balance", "title": "Leave Balance", "group": "Leave"},
    {"key": "leave_applications", "title": "Leave Applications", "group": "Leave"},
    {"key": "holiday_utilization", "title": "Holiday Utilization", "group": "Leave"},
    {"key": "asset_register", "title": "Asset Register", "group": "Assets"},
    {"key": "asset_history", "title": "Assignment History", "group": "Assets"},
    {"key": "onboarding_status", "title": "Onboarding Status", "group": "Onboarding"},
]


def build(db: Session, key: str, f: Filters) -> Report:
    builder = BUILDERS.get(key)
    if builder is None:
        raise KeyError(key)
    return builder(db, f)


def org_timezone(db: Session, org_id: uuid.UUID) -> str:
    org = db.get(Organization, org_id)
    return org.timezone if org else "UTC"
