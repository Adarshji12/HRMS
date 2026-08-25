"""Timesheets: derived hours, manual entries, submission and approval."""

from __future__ import annotations

import csv
import io
import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import (
    Approver,
    deny_page,
    CurrentUser,
    DbSession,
    Exporter,
    TeamViewer,
    audit,
    visible_user_ids,
)
from app.core.config import settings
from app.db.session import SessionLocal
from app.models import (
    ApprovalStatus,
    EntrySource,
    Organization,
    Project,
    Role,
    TimeEntry,
    User,
)
from app.services import email, notifications as notif, timesheets as ts

router = APIRouter(prefix="/timesheets", tags=["timesheets"])

PERIOD = r"^(daily|weekly|monthly)$"


class TimeEntryIn(BaseModel):
    user_id: uuid.UUID | None = None  # admins/managers may log for someone else
    entry_date: date
    minutes: int = Field(ge=1, le=1440)
    project_id: uuid.UUID | None = None
    task_id: uuid.UUID | None = None
    description: str | None = Field(default=None, max_length=2000)
    is_billable: bool = False


class ReviewRequest(BaseModel):
    note: str | None = Field(default=None, max_length=2000)


def _target_user(db, viewer: User, user_id: uuid.UUID | None) -> User:
    """Resolve whose timesheet this is, and refuse if out of scope."""
    if user_id is None or user_id == viewer.id:
        return viewer
    target = db.get(User, user_id)
    if target is None or target.org_id != viewer.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Employee not found")
    allowed = visible_user_ids(db, viewer)
    if allowed is not None and user_id not in allowed:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not permitted for this employee")
    return target


def _resolve_period(
    db, org_id: uuid.UUID, day: date | None, period_type: str
) -> tuple[date, date]:
    tz_name = ts.org_timezone(db, org_id)
    anchor = day or datetime.now(ts.reports.tz_for(tz_name)).date()
    return ts.period_bounds(anchor, period_type)


# --------------------------------------------------------------------------- #
# Reading
# --------------------------------------------------------------------------- #


@router.get("")
def my_timesheet(
    viewer: CurrentUser,
    db: DbSession,
    user_id: uuid.UUID | None = None,
    day: date | None = None,
    period: str = Query(default="weekly", pattern=PERIOD),
) -> dict:
    """One person's timesheet for the period containing ``day``."""
    deny_page(viewer, "timesheets")
    target = _target_user(db, viewer, user_id)
    start, end = _resolve_period(db, viewer.org_id, day, period)
    sheet = ts.build(db, target, start, end, period, ts.org_timezone(db, viewer.org_id))

    entries = db.scalars(
        select(TimeEntry)
        .where(
            TimeEntry.user_id == target.id,
            TimeEntry.entry_date >= start,
            TimeEntry.entry_date <= end,
        )
        .order_by(TimeEntry.entry_date, TimeEntry.created_at)
    ).all()
    projects = {
        p.id: p.name
        for p in db.scalars(select(Project).where(Project.org_id == viewer.org_id)).all()
    }

    return {
        **sheet.as_dict(),
        "can_edit": _can_edit(sheet, viewer, target),
        "can_review": viewer.role_enum.can_view_team and viewer.id != target.id,
        "entries": [
            {
                "id": str(e.id),
                "entry_date": e.entry_date.isoformat(),
                "minutes": e.minutes,
                "project_id": str(e.project_id) if e.project_id else None,
                "project_name": projects.get(e.project_id),
                "description": e.description,
                "is_billable": e.is_billable,
                "source": e.source,
            }
            for e in entries
        ],
    }


def _can_edit(sheet: ts.Timesheet, viewer: User, target: User) -> bool:
    """Submitted and approved periods are frozen for the employee.

    An admin can still correct them — a genuine error after approval has to be
    fixable — but the approval snapshot keeps the number payroll used.
    """
    locked = sheet.approval is not None and sheet.approval.status_enum.is_locked
    if not locked:
        return viewer.id == target.id or viewer.role_enum.can_view_team
    return viewer.role_enum.can_administer


@router.get("/team")
def team_timesheets(
    viewer: TeamViewer,
    db: DbSession,
    day: date | None = None,
    period: str = Query(default="weekly", pattern=PERIOD),
) -> dict:
    """One row per employee in scope, for the period."""
    deny_page(viewer, "timesheets")
    start, end = _resolve_period(db, viewer.org_id, day, period)
    tz_name = ts.org_timezone(db, viewer.org_id)

    scope = visible_user_ids(db, viewer)
    stmt = select(User).where(User.org_id == viewer.org_id, User.is_active.is_(True))
    if scope is not None:
        stmt = stmt.where(User.id.in_(scope))
    users = db.scalars(stmt.order_by(User.full_name)).all()

    rows = []
    for user in users:
        sheet = ts.build(db, user, start, end, period, tz_name)
        data = sheet.as_dict()
        rows.append(
            {
                "user_id": data["user_id"],
                "full_name": data["full_name"],
                "email": data["email"],
                "totals": data["totals"],
                "approval": data["approval"],
            }
        )

    return {
        "period_type": period,
        "period_start": start.isoformat(),
        "period_end": end.isoformat(),
        "timezone": tz_name,
        "rows": rows,
        "totals": {
            key: sum(r["totals"][key] for r in rows)
            for key in (
                "worked_minutes", "tracked_minutes", "entered_minutes",
                "billable_minutes", "overtime_minutes", "expected_minutes",
            )
        },
        "pending_approvals": sum(
            1 for r in rows if r["approval"]["status"] == ApprovalStatus.SUBMITTED.value
        ),
    }


# --------------------------------------------------------------------------- #
# Manual entries
# --------------------------------------------------------------------------- #


@router.post("/entries", status_code=status.HTTP_201_CREATED)
def create_entry(
    payload: TimeEntryIn, viewer: CurrentUser, request: Request, db: DbSession
) -> dict:
    target = _target_user(db, viewer, payload.user_id)
    period_type = "weekly"
    start, _ = ts.period_bounds(payload.entry_date, period_type)
    sheet = ts.build(db, target, *ts.period_bounds(payload.entry_date, period_type),
                     period_type, ts.org_timezone(db, viewer.org_id))
    if not _can_edit(sheet, viewer, target):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "reason": "period_locked",
                "message": "That week has been submitted. Ask an administrator to reopen it.",
            },
        )

    if payload.project_id is not None:
        project = db.get(Project, payload.project_id)
        if project is None or project.org_id != viewer.org_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")

    entry = TimeEntry(
        org_id=viewer.org_id,
        user_id=target.id,
        project_id=payload.project_id,
        task_id=payload.task_id,
        entry_date=payload.entry_date,
        minutes=payload.minutes,
        description=payload.description,
        is_billable=payload.is_billable,
        source=EntrySource.MANUAL.value,
        created_by_user_id=viewer.id,
    )
    db.add(entry)
    db.flush()
    audit(db, org_id=viewer.org_id, actor=viewer, action="timesheet.entry_added",
          request=request, target_type="time_entry", target_id=str(entry.id),
          detail={"for": str(target.id), "minutes": payload.minutes})
    db.commit()
    return {"id": str(entry.id), "period_start": start.isoformat()}


@router.delete("/entries/{entry_id}", status_code=status.HTTP_204_NO_CONTENT,
               response_model=None)
def delete_entry(
    entry_id: uuid.UUID, viewer: CurrentUser, db: DbSession
) -> None:
    entry = db.get(TimeEntry, entry_id)
    if entry is None or entry.org_id != viewer.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Entry not found")
    target = _target_user(db, viewer, entry.user_id)

    sheet = ts.build(db, target, *ts.period_bounds(entry.entry_date, "weekly"), "weekly",
                     ts.org_timezone(db, viewer.org_id))
    if not _can_edit(sheet, viewer, target):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"reason": "period_locked",
                    "message": "That week has been submitted and cannot be edited."},
        )
    db.delete(entry)
    db.commit()


# --------------------------------------------------------------------------- #
# Submission and approval
# --------------------------------------------------------------------------- #


@router.post("/submit")
def submit(
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
    day: date | None = None,
    period: str = Query(default="weekly", pattern=PERIOD),
    user_id: uuid.UUID | None = None,
) -> dict:
    target = _target_user(db, viewer, user_id)
    start, end = _resolve_period(db, viewer.org_id, day, period)
    approval = ts.get_or_create_approval(db, target, start, end, period)

    if approval.status_enum is ApprovalStatus.APPROVED:
        raise HTTPException(status.HTTP_409_CONFLICT, "This period is already approved")

    approval.status = ApprovalStatus.SUBMITTED.value
    approval.submitted_at = datetime.now(timezone.utc)
    approval.reviewed_at = None
    approval.reviewed_by_user_id = None
    audit(db, org_id=viewer.org_id, actor=viewer, action="timesheet.submitted",
          request=request, target_type="timesheet", target_id=str(approval.id),
          detail={"period": f"{start}..{end}"})
    db.commit()
    return {"status": approval.status, "period_start": start.isoformat()}


def _notify_decision(
    background: BackgroundTasks,
    db: DbSession,
    org_id: uuid.UUID,
    target: User,
    reviewer: User,
    decision: str,
    start: date,
    end: date,
    note: str | None,
) -> None:
    """Tell the employee a decision was made about their hours.

    Queued rather than awaited: app.services.email is synchronous SMTP, and its
    own docstring warns that a handshake inside a request is a slow endpoint
    waiting to happen. An approval must not fail, or crawl, because the mail
    provider is having a bad afternoon.

    The dedupe key is the period plus the decision, so a rejection followed by a
    later approval both send — they are two different pieces of news — while a
    double-click on Approve sends once.
    """
    period = f"{start.isoformat()} to {end.isoformat()}"
    url = _console_url(org_id, db, "/timesheets")

    def _send() -> None:
        with SessionLocal() as fresh:
            person = fresh.get(User, target.id)
            if person is None:
                return
            notif.dispatch(
                fresh, person, notif.Kind.TIMESHEET_DECIDED,
                dedupe_key=f"{start.isoformat()}:{decision}",
                subject=f"Timesheet {decision} - {period}",
                send_fn=lambda: email.send_timesheet_decided(
                    to=person.email, name=person.full_name, decision=decision,
                    period=period, reviewer=reviewer.full_name, note=note or "", url=url,
                    org_id=person.org_id,
                ),
            )

    background.add_task(_send)


def _console_url(org_id: uuid.UUID, db: DbSession, path: str) -> str:
    org = db.get(Organization, org_id)
    port = f":{settings.public_port}" if settings.public_port else ""
    slug = org.slug if org else ""
    return f"{settings.public_scheme}://{slug}.{settings.base_domain}{port}{path}"


@router.post("/{user_id}/approve")
def approve(
    user_id: uuid.UUID,
    payload: ReviewRequest,
    viewer: Approver,
    request: Request,
    background: BackgroundTasks,
    db: DbSession,
    day: date | None = None,
    period: str = Query(default="weekly", pattern=PERIOD),
) -> dict:
    # Self-review, the already-decided guard, the stamp and the audit row are
    # all `services.workflow`'s now, reached through `ts.decide`. This handler
    # used to hold them, which is why timesheets were the one flow that could
    # be approved twice.
    target = _target_user(db, viewer, user_id)
    start, end = _resolve_period(db, viewer.org_id, day, period)
    approval = ts.decide(
        db, viewer=viewer, target=target, period_start=start, period_end=end,
        period_type=period, approve=True, note=payload.note,
        tz_name=ts.org_timezone(db, viewer.org_id), request=request,
    )
    db.commit()
    _notify_decision(background, db, viewer.org_id, target, viewer, "approved",
                     start, end, payload.note)
    return {"status": approval.status, "approved_worked_minutes": approval.approved_worked_minutes}


@router.post("/{user_id}/reject")
def reject(
    user_id: uuid.UUID,
    payload: ReviewRequest,
    viewer: Approver,
    request: Request,
    background: BackgroundTasks,
    db: DbSession,
    day: date | None = None,
    period: str = Query(default="weekly", pattern=PERIOD),
) -> dict:
    target = _target_user(db, viewer, user_id)
    start, end = _resolve_period(db, viewer.org_id, day, period)
    # The "give a reason" rule is the kernel's, and so is refusing to return a
    # period that has already been signed off.
    approval = ts.decide(
        db, viewer=viewer, target=target, period_start=start, period_end=end,
        period_type=period, approve=False, note=payload.note,
        tz_name=ts.org_timezone(db, viewer.org_id), request=request,
    )
    db.commit()
    _notify_decision(background, db, viewer.org_id, target, viewer, "returned for changes",
                     start, end, payload.note)
    return {"status": approval.status}


# --------------------------------------------------------------------------- #
# Export
# --------------------------------------------------------------------------- #


@router.get("/export.csv")
def export_csv(
    viewer: Exporter,
    db: DbSession,
    start: date | None = None,
    end: date | None = None,
) -> StreamingResponse:
    deny_page(viewer, "timesheets")
    tz_name = ts.org_timezone(db, viewer.org_id)
    end = end or datetime.now(ts.reports.tz_for(tz_name)).date()
    start = start or end - timedelta(days=27)
    if end < start:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "end is before start")
    if (end - start).days > 366:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Range exceeds one year")

    scope = visible_user_ids(db, viewer)
    stmt = select(User).where(User.org_id == viewer.org_id, User.is_active.is_(True))
    if scope is not None:
        stmt = stmt.where(User.id.in_(scope))
    users = db.scalars(stmt.order_by(User.full_name)).all()

    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(
        ["date", "employee", "email", "weekday", "working_day", "tracked_h", "entered_h",
         "worked_h", "billable_h", "expected_h", "overtime_h", "shortfall_h",
         "first_activity", "last_activity"]
    )

    for user in users:
        sheet = ts.build(db, user, start, end, "monthly", tz_name)
        for row in sheet.days:
            writer.writerow(
                [
                    row.day.isoformat(), user.full_name, user.email,
                    row.day.strftime("%a"), "yes" if row.is_working_day else "no",
                    round(row.tracked_minutes / 60, 2),
                    round(row.entered_minutes / 60, 2),
                    round(row.worked_minutes / 60, 2),
                    round(row.billable_minutes / 60, 2),
                    round(row.expected_minutes / 60, 2),
                    round(row.overtime_minutes / 60, 2),
                    round(row.shortfall_minutes / 60, 2),
                    row.first_activity.isoformat() if row.first_activity else "",
                    row.last_activity.isoformat() if row.last_activity else "",
                ]
            )

    buf.seek(0)
    filename = f"timesheets-{start.isoformat()}-to-{end.isoformat()}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
