"""Dashboard and reporting endpoints."""

from __future__ import annotations

import csv
import io
import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from fastapi.responses import (
    FileResponse,
    JSONResponse,
    RedirectResponse,
    StreamingResponse,
)
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import delete, func, or_, select

from app.api.deps import (
    OwnerUser,
    deny_page,
    deny_unless,
    AdminUser,
    CurrentUser,
    DbSession,
    TeamViewer,
    audit,
    get_org_settings,
    visible_user_ids,
)
from app.core.config import settings
from app.core.security import generate_enrollment_key, hash_password
from app.models import (
    ActivitySegment,
    Department,
    Device,
    Organization,
    Project,
    ProjectMember,
    Team,
    ProductivityRule,
    Role,
    Screenshot,
    User,
    WorkSession,
)
from app.schemas.common import (
    DeviceOut,
    OrgSettingsOut,
    OrgSettingsUpdate,
    RuleCreate,
    RuleOut,
    UserCreate,
    UserOut,
    UserUpdate,
    UserWithKeyOut,
)
from app.services import agentdist, hierarchy, mailconfig, reports, storage
from app.services import roles as role_svc, subscriptions as subs
from app.services.classifier import seed_default_rules

router = APIRouter(prefix="/admin", tags=["admin"])

MAX_REPORT_DAYS = 92


def _org_tz(db, org_id: uuid.UUID) -> str:
    org = db.get(Organization, org_id)
    return org.timezone if org else "UTC"


def _today(tz_name: str) -> date:
    """"Today" as the organisation sees it.

    Not ``datetime.now(timezone.utc).date()``: the query window is built in the
    org timezone, so a UTC-derived default silently returns the wrong day (and
    often an empty one) for every org not sitting on UTC.
    """
    return datetime.now(reports.tz_for(tz_name)).date()


def _resolve_scope(
    db, viewer: User, user_id: uuid.UUID | None
) -> list[uuid.UUID] | None:
    """Intersect the requested user filter with what the viewer may see.

    Note the read endpoints here take ``CurrentUser``, not ``TeamViewer``: an
    employee is allowed in and simply resolves to a scope of themselves. Role is
    enforced by *scoping*, not by refusing entry, so an employee can see their
    own hours and screenshots — which is what makes monitoring defensible — while
    still being unable to see a colleague's. Write endpoints remain AdminUser.
    """
    allowed = visible_user_ids(db, viewer)
    if user_id is None:
        return allowed
    if allowed is not None and user_id not in allowed:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not permitted for this employee")
    return [user_id]


def _filter_scope(
    db,
    viewer: User,
    user_id: uuid.UUID | None = None,
    team_id: uuid.UUID | None = None,
    department_id: uuid.UUID | None = None,
) -> list[uuid.UUID] | None:
    """``_resolve_scope`` plus the team and department pickers.

    Every narrowing is an intersection, never a union: a manager who filters by
    a team they do not manage still sees only their own people, and an employee
    filtering by anything still sees only themselves. ``None`` means "no filter
    needed" and is only reachable when the viewer sees the whole organisation
    and asked for no narrowing.
    """
    scope = _resolve_scope(db, viewer, user_id)
    if team_id is None and department_id is None:
        return scope
    stmt = select(User.id).where(User.org_id == viewer.org_id)
    if team_id is not None:
        stmt = stmt.where(User.team_id == team_id)
    if department_id is not None:
        stmt = stmt.where(User.department_id == department_id)
    picked = set(db.scalars(stmt).all())
    return sorted(picked if scope is None else picked & set(scope), key=str)


def _local_iso(value, tz_name: str) -> str:
    """UTC instant -> ISO string in the workspace timezone.

    SQLite hands these back naive, so the tzinfo has to be re-attached before
    converting or the offset is applied twice.
    """
    if value is None:
        return ""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(reports.tz_for(tz_name)).isoformat(timespec="seconds")


def _csv_response(buf: io.StringIO, filename: str) -> StreamingResponse:
    """One place for the headers, so every export downloads rather than renders."""
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _require_visible(db, viewer: User, user_id: uuid.UUID) -> User:
    target = db.get(User, user_id)
    if target is None or target.org_id != viewer.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Employee not found")
    allowed = visible_user_ids(db, viewer)
    if allowed is not None and user_id not in allowed:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not permitted for this employee")
    return target


# --------------------------------------------------------------------------- #
# Dashboard
# --------------------------------------------------------------------------- #


@router.get("/dashboard")
def dashboard(
    viewer: CurrentUser,
    db: DbSession,
    day: date | None = Query(default=None, description="defaults to today in the org timezone"),
    team_id: uuid.UUID | None = None,
    department_id: uuid.UUID | None = None,
) -> dict:
    tz_name = _org_tz(db, viewer.org_id)
    day = day or _today(tz_name)
    start, end = reports.day_bounds(day, tz_name)
    scope = visible_user_ids(db, viewer)

    # Drill-down narrows the scope; it never widens it. A manager filtering by
    # a team they do not manage still sees only their own people.
    if team_id or department_id:
        stmt = select(User.id).where(User.org_id == viewer.org_id)
        if team_id:
            stmt = stmt.where(User.team_id == team_id)
        if department_id:
            stmt = stmt.where(User.department_id == department_id)
        filtered = set(db.scalars(stmt).all())
        scope = sorted(filtered if scope is None else filtered & set(scope), key=str)

    rows = reports.user_day_rows(db, viewer.org_id, start, end)
    if scope is not None:
        allowed = set(scope)
        rows = [r for r in rows if r.user_id in allowed]

    totals = reports.totals_for(db, viewer.org_id, start, end, scope)

    shot_count = db.scalar(
        select(func.count(Screenshot.id)).where(
            Screenshot.org_id == viewer.org_id,
            Screenshot.captured_at >= start,
            Screenshot.captured_at < end,
            *( [Screenshot.user_id.in_(scope)] if scope is not None else [] ),
        )
    )
    # Both counts are scoped like everything else on this response. They were
    # not, which meant an employee — who resolves to a scope of themselves and
    # correctly saw "Employees 1" — still read the organisation's real team and
    # project totals off the same row of tiles. Small numbers, but they are
    # exactly the org shape that scoping exists to withhold.
    project_stmt = select(func.count(func.distinct(Project.id))).where(
        Project.org_id == viewer.org_id, Project.status == "active"
    )
    team_stmt = select(func.count(func.distinct(Team.id))).where(Team.org_id == viewer.org_id)
    if scope is not None:
        project_stmt = project_stmt.join(
            ProjectMember, ProjectMember.project_id == Project.id
        ).where(ProjectMember.user_id.in_(scope))
        team_stmt = team_stmt.join(User, User.team_id == Team.id).where(User.id.in_(scope))
    project_count = db.scalar(project_stmt)
    team_count = db.scalar(team_stmt)

    return {
        "date": day.isoformat(),
        "timezone": tz_name,
        # What this response covers, so the console can say so instead of
        # guessing from the viewer's role. "self" is a scope of exactly one
        # person and that person is the viewer — the case the old subtitle
        # still called "Whole company".
        "scope": (
            "org" if scope is None
            else "self" if scope == [viewer.id]
            else "team"
        ),
        "totals": totals.as_dict(),
        "online_count": sum(1 for r in rows if r.is_online),
        "offline_count": sum(1 for r in rows if not r.is_online),
        "working_count": sum(1 for r in rows if r.totals.tracked_s > 0),
        "employee_count": len(rows),
        "screenshot_count": int(shot_count or 0),
        "project_count": int(project_count or 0),
        "team_count": int(team_count or 0),
        "employees": [
            {
                "user_id": str(r.user_id),
                "full_name": r.full_name,
                "email": r.email,
                "team": r.team,
                "is_online": r.is_online,
                "first_activity": r.first_activity,
                "last_activity": r.last_activity,
                **r.totals.as_dict(),
            }
            for r in rows
        ],
        "top_apps": reports.top_breakdown(db, viewer.org_id, start, end, by="app",
                                          user_ids=scope),
        "top_domains": reports.top_breakdown(db, viewer.org_id, start, end, by="domain",
                                             user_ids=scope),
        "browsers": reports.top_breakdown(db, viewer.org_id, start, end, by="browser",
                                          user_ids=scope, limit=8),
        "hourly": reports.hourly_histogram(db, viewer.org_id, start, end, tz_name, scope),
    }


@router.get("/activity")
def activity_log(
    viewer: CurrentUser,
    db: DbSession,
    start: date | None = None,
    end: date | None = None,
    user_id: uuid.UUID | None = None,
    team_id: uuid.UUID | None = None,
    department_id: uuid.UUID | None = None,
    kind: str = Query(default="all", pattern=r"^(all|apps|websites)$"),
    productivity: str | None = Query(default=None, pattern=r"^(productive|unproductive|neutral)$"),
    q: str | None = Query(default=None, description="app, domain or window title"),
    limit: int = Query(default=200, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
) -> dict:
    """Flat Apps & Websites log across the org, scoped to what the viewer may see.

    Deliberately a *segment* list rather than an aggregate: the spec asks for
    start, end and duration per usage, which an aggregate cannot answer.
    """
    deny_page(viewer, "apps")
    tz_name = _org_tz(db, viewer.org_id)
    end = end or _today(tz_name)
    start = start or end
    _validate_range(start, end)
    win_start, win_end = reports.range_bounds(start, end, tz_name)

    scope = _filter_scope(db, viewer, user_id, team_id, department_id)
    stmt = select(ActivitySegment).where(
        ActivitySegment.org_id == viewer.org_id,
        ActivitySegment.started_at >= win_start,
        ActivitySegment.started_at < win_end,
    )
    if scope is not None:
        stmt = stmt.where(ActivitySegment.user_id.in_(scope))
    if kind == "websites":
        stmt = stmt.where(ActivitySegment.url_domain.is_not(None))
    elif kind == "apps":
        stmt = stmt.where(ActivitySegment.is_browser.is_(False))
    if productivity:
        stmt = stmt.where(ActivitySegment.productivity == productivity)
    if q:
        needle = f"%{q.strip().lower()}%"
        stmt = stmt.where(
            or_(
                func.lower(ActivitySegment.app_name).like(needle),
                func.lower(ActivitySegment.url_domain).like(needle),
                func.lower(ActivitySegment.window_title).like(needle),
            )
        )

    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.scalars(
        stmt.order_by(ActivitySegment.started_at.desc()).limit(limit).offset(offset)
    ).all()

    names = {
        row[0]: row[1]
        for row in db.execute(select(User.id, User.full_name).where(User.org_id == viewer.org_id))
    }

    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "timezone": tz_name,
        "total": int(total),
        "items": [
            {
                "id": str(s.id),
                "user_id": str(s.user_id),
                "employee": names.get(s.user_id, "—"),
                "started_at": s.started_at,
                "ended_at": s.ended_at,
                "duration_s": s.duration_s,
                "active_s": s.active_s,
                "idle_s": s.idle_s,
                "app_name": s.app_name,
                "window_title": s.window_title,
                "is_browser": s.is_browser,
                "browser": s.browser,
                "url_domain": s.url_domain,
                "url_full": s.url_full,
                "productivity": s.productivity,
                "is_idle": s.is_idle,
                "project_id": str(s.project_id) if s.project_id else None,
                "is_billable": s.is_billable,
            }
            for s in rows
        ],
    }


@router.get("/employees/{user_id}/range")
def employee_range(
    user_id: uuid.UUID,
    viewer: CurrentUser,
    db: DbSession,
    start: date | None = Query(default=None, description="defaults to 6 days before end"),
    end: date | None = Query(default=None, description="defaults to today in the employee's tz"),
) -> dict:
    """One employee across a span of days.

    Separate from ``/day`` rather than a parameter on it, because the two
    answer different questions and carry different payloads: a timeline strip
    and an hour histogram describe a single day and mean nothing across a
    month, while a per-day series is noise on a single day.

    Deliberately not served by /reports/summary, which already computes all of
    this. That endpoint is gated on the Reports page, so reusing it would mean
    an administrator whose Reports page is switched off could no longer open an
    employee — two unrelated permissions welded together by an implementation
    detail.
    """
    deny_page(viewer, "activity")
    target = _require_visible(db, viewer, user_id)
    tz_name = target.timezone or _org_tz(db, viewer.org_id)
    end = end or _today(tz_name)
    start = start or end - timedelta(days=6)
    _validate_range(start, end)
    win_start, win_end = reports.range_bounds(start, end, tz_name)

    shot_count = db.scalar(
        select(func.count(Screenshot.id)).where(
            Screenshot.user_id == user_id,
            Screenshot.captured_at >= win_start,
            Screenshot.captured_at < win_end,
        )
    )

    sessions = db.scalars(
        select(WorkSession)
        .where(
            WorkSession.user_id == user_id,
            WorkSession.started_at >= win_start,
            WorkSession.started_at < win_end,
        )
        .order_by(WorkSession.started_at.desc())
        .limit(500)
    ).all()

    daily = reports.daily_series(db, viewer.org_id, start, end, tz_name, [user_id])
    # Days with nothing recorded are still returned by daily_series, which is
    # what makes a gap visible in the chart. They must not count towards the
    # average, though, or a fortnight's holiday quietly halves someone's
    # apparent working day.
    worked = [d for d in daily if d["tracked_s"] > 0]

    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "timezone": tz_name,
        "employee": UserOut.model_validate(target).model_dump(mode="json"),
        "totals": reports.totals_for(db, viewer.org_id, win_start, win_end, [user_id]).as_dict(),
        "days_in_range": len(daily),
        "days_worked": len(worked),
        "avg_tracked_s": round(sum(d["tracked_s"] for d in worked) / len(worked)) if worked else 0,
        "screenshot_count": int(shot_count or 0),
        "daily": daily,
        "attendance": [
            {
                "started_at": s.started_at,
                "ended_at": s.ended_at,
                "duration_s": s.duration_s,
                "end_reason": s.end_reason,
            }
            for s in sessions
        ],
        "top_apps": reports.top_breakdown(db, viewer.org_id, win_start, win_end, by="app",
                                          user_ids=[user_id], limit=20),
        "top_domains": reports.top_breakdown(db, viewer.org_id, win_start, win_end, by="domain",
                                             user_ids=[user_id], limit=20),
    }


@router.get("/employees/{user_id}/day")
def employee_day(
    user_id: uuid.UUID,
    viewer: CurrentUser,
    db: DbSession,
    day: date | None = Query(default=None, description="defaults to today in the employee's tz"),
) -> dict:
    deny_page(viewer, "activity")
    target = _require_visible(db, viewer, user_id)
    tz_name = target.timezone or _org_tz(db, viewer.org_id)
    day = day or _today(tz_name)
    start, end = reports.day_bounds(day, tz_name)

    segments = db.scalars(
        select(ActivitySegment)
        .where(
            ActivitySegment.user_id == user_id,
            ActivitySegment.started_at >= start,
            ActivitySegment.started_at < end,
        )
        .order_by(ActivitySegment.started_at)
        .limit(5000)
    ).all()

    sessions = db.scalars(
        select(WorkSession)
        .where(
            WorkSession.user_id == user_id,
            WorkSession.started_at >= start,
            WorkSession.started_at < end,
        )
        .order_by(WorkSession.started_at)
    ).all()

    shot_count = db.scalar(
        select(func.count(Screenshot.id)).where(
            Screenshot.user_id == user_id,
            Screenshot.captured_at >= start,
            Screenshot.captured_at < end,
        )
    )

    return {
        "date": day.isoformat(),
        "timezone": tz_name,
        "employee": UserOut.model_validate(target).model_dump(mode="json"),
        "totals": reports.totals_for(db, viewer.org_id, start, end, [user_id]).as_dict(),
        "screenshot_count": int(shot_count or 0),
        "attendance": [
            {
                "started_at": s.started_at,
                "ended_at": s.ended_at,
                "duration_s": s.duration_s,
                "end_reason": s.end_reason,
            }
            for s in sessions
        ],
        "top_apps": reports.top_breakdown(db, viewer.org_id, start, end, by="app",
                                          user_ids=[user_id]),
        "top_domains": reports.top_breakdown(db, viewer.org_id, start, end, by="domain",
                                             user_ids=[user_id]),
        "hourly": reports.hourly_histogram(db, viewer.org_id, start, end, tz_name, [user_id]),
        "timeline": [
            {
                "id": str(s.id),
                "started_at": s.started_at,
                "ended_at": s.ended_at,
                "duration_s": s.duration_s,
                "active_s": s.active_s,
                "idle_s": s.idle_s,
                "app_name": s.app_name,
                "window_title": s.window_title,
                "is_browser": s.is_browser,
                "browser": s.browser,
                "url_domain": s.url_domain,
                "url_full": s.url_full,
                "productivity": s.productivity,
                "is_idle": s.is_idle,
            }
            for s in segments
        ],
    }


# --------------------------------------------------------------------------- #
# Employees
# --------------------------------------------------------------------------- #


@router.get("/employees", response_model=list[UserWithKeyOut])
def list_employees(viewer: CurrentUser, db: DbSession) -> list[User]:
    stmt = select(User).where(User.org_id == viewer.org_id).order_by(User.full_name)
    allowed = visible_user_ids(db, viewer)
    if allowed is not None:
        stmt = stmt.where(User.id.in_(allowed))
    return list(db.scalars(stmt).all())


@router.post("/employees", response_model=UserWithKeyOut, status_code=status.HTTP_201_CREATED)
def create_employee(
    payload: UserCreate, admin: AdminUser, request: Request, db: DbSession
) -> User:
    email = payload.email.lower()
    if db.scalar(select(User).where(User.org_id == admin.org_id, User.email == email)):
        raise HTTPException(status.HTTP_409_CONFLICT, "An account with that email exists")

    # Seats are what the customer paid for; enforce before creating, not after.
    org = db.get(Organization, admin.org_id)
    subs.ensure_seat_available(db, org)
    try:
        role = Role(payload.role)
    except ValueError:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Unknown role") from None
    if role == Role.OWNER:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Cannot create another owner")

    # A role_id is a grant of permissions, so it is checked against this tenant
    # rather than trusted — an id from another company would otherwise hand this
    # person that company's permission set.
    if payload.role_id is not None:
        assigned = role_svc.get_role(db, admin.org_id, payload.role_id)
        if assigned.base_role == Role.OWNER.value:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                detail={
                    "reason": "owner_role_reserved",
                    "message": "The Owner role belongs to the account holder and "
                               "cannot be assigned. Use Administrator instead.",
                },
            )
        # The named role decides the level; the `role` field becomes a mirror of
        # it so the coarse checks and anything reading the column agree.
        role = Role(assigned.base_role)

    user = User(
        org_id=admin.org_id,
        email=email,
        full_name=payload.full_name,
        role=role.value,
        timezone=payload.timezone,
        employee_code=payload.employee_code,
        phone=payload.phone,
        joined_on=payload.joined_on,
        department_id=payload.department_id,
        team_id=payload.team_id,
        designation_id=payload.designation_id,
        schedule_id=payload.schedule_id,
        manager_id=payload.manager_id,
        password_hash=hash_password(payload.password) if payload.password else None,
        enrollment_key=generate_enrollment_key(),
        can_view_screenshots=payload.can_view_screenshots,
        can_approve_timesheets=payload.can_approve_timesheets,
        can_export_data=payload.can_export_data,
        can_manage_projects=payload.can_manage_projects,
        # The five HRMS flags were accepted by UserCreate and then dropped here,
        # so an admin creating someone with can_manage_onboarding=false got a
        # user with it set to true — the model default. A restriction that is
        # silently not applied is worse than one that is refused, because the
        # screen said it worked. update_employee never had the bug: it uses a
        # generic setattr loop, which is why the fix only needed applying once.
        can_approve_leave=payload.can_approve_leave,
        can_approve_regularization=payload.can_approve_regularization,
        can_punch_anywhere=payload.can_punch_anywhere,
        # The named role, when one was chosen. Validated below rather than
        # trusted: a role_id from another tenant would otherwise grant this
        # person that tenant's permissions.
        role_id=payload.role_id,
        can_manage_assets=payload.can_manage_assets,
        can_manage_onboarding=payload.can_manage_onboarding,
        can_manage_helpdesk=payload.can_manage_helpdesk,
        # Pre-boarding (§4.1): HR creates the hire before day one so the
        # onboarding checklist can start. `status` is descriptive workflow state
        # only — `is_active` remains the sole authentication gate (D-016), and a
        # pre-joiner is normally created with no password, which is what
        # actually stops them signing in.
        status=payload.status,
        hidden_pages=payload.hidden_pages,
    )
    db.add(user)
    db.flush()
    audit(db, org_id=admin.org_id, actor=admin, action="employee.created", request=request,
          target_type="user", target_id=str(user.id))
    db.commit()
    return user


@router.patch("/employees/{user_id}", response_model=UserWithKeyOut)
def update_employee(
    user_id: uuid.UUID, payload: UserUpdate, admin: AdminUser, request: Request, db: DbSession
) -> User:
    user = db.get(User, user_id)
    if user is None or user.org_id != admin.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Employee not found")
    if user.role_enum == Role.OWNER and admin.role_enum != Role.OWNER:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the owner can modify the owner")

    data = payload.model_dump(exclude_unset=True)
    if (password := data.pop("password", None)) is not None:
        user.password_hash = hash_password(password)
    if (role := data.pop("role", None)) is not None:
        try:
            user.role = Role(role).value
        except ValueError:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Unknown role") from None
    if "manager_id" in data and hierarchy.would_create_cycle(db, user.id, data["manager_id"]):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "reason": "reporting_cycle",
                "message": "That manager reports to this employee, directly or indirectly.",
            },
        )
    # Same check as the create path: a role_id is a grant, so it is validated
    # against this tenant instead of being written straight through by the loop
    # below.
    if "role_id" in data and data["role_id"] is not None:
        assigned = role_svc.get_role(db, admin.org_id, data["role_id"])
        if assigned.base_role == Role.OWNER.value:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                detail={
                    "reason": "owner_role_reserved",
                    "message": "The Owner role belongs to the account holder and "
                               "cannot be assigned. Use Administrator instead.",
                },
            )
        # The column mirrors the role's level, so the coarse can_administer /
        # can_view_team checks and anything reading `role` stay in agreement
        # with what the named role actually grants.
        data["role"] = assigned.base_role

    for field, value in data.items():
        setattr(user, field, value)

    # Refuse the edit that leaves nobody able to administer the tenant.
    #
    # Deactivating the last administrator, or demoting them to employee, locks
    # every remaining person out of settings, billing and employee management —
    # and out of the screen that would undo it. It is the same class of failure
    # as switching geofencing to `required` with no office locations (D-014),
    # arriving through a third door, and offboarding completion already guards
    # its own version of it.
    #
    # Checked against *other* rows so an autoflush of the pending change above
    # cannot make the org look administered by the very user being demoted. The
    # message says "promote somebody first" rather than "you may not leave",
    # because the operation is legitimate — it just cannot be the last one.
    if not user.is_active or not user.role_enum.can_administer:
        others = db.scalar(
            select(func.count()).select_from(User).where(
                User.org_id == admin.org_id,
                User.id != user.id,
                User.is_active.is_(True),
                User.role.in_([Role.OWNER.value, Role.ADMIN.value]),
            )
        )
        if not others:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail={
                    "reason": "last_administrator",
                    "message": (
                        "This is the only active administrator. Promote someone "
                        "else to admin first, then repeat this change."
                    ),
                },
            )

    if payload.is_active is False:
        # Deactivating an employee must stop collection, not just hide them.
        db.execute(
            Device.__table__.update().where(Device.user_id == user.id).values(is_active=False)
        )

    audit(db, org_id=admin.org_id, actor=admin, action="employee.updated", request=request,
          target_type="user", target_id=str(user.id), detail=data)
    db.commit()
    return user


@router.post("/employees/{user_id}/rotate-key", response_model=UserWithKeyOut)
def rotate_enrollment_key(
    user_id: uuid.UUID, admin: AdminUser, request: Request, db: DbSession
) -> User:
    user = db.get(User, user_id)
    if user is None or user.org_id != admin.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Employee not found")
    user.enrollment_key = generate_enrollment_key()
    audit(db, org_id=admin.org_id, actor=admin, action="employee.key_rotated", request=request,
          target_type="user", target_id=str(user.id))
    db.commit()
    return user


@router.get("/employees/{user_id}/devices", response_model=list[DeviceOut])
def list_devices(user_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> list[Device]:
    _require_visible(db, viewer, user_id)
    return list(
        db.scalars(
            select(Device).where(Device.user_id == user_id).order_by(Device.created_at.desc())
        ).all()
    )


@router.post(
    "/devices/{device_id}/revoke",
    status_code=status.HTTP_204_NO_CONTENT,
    # Explicit: without it FastAPI infers NoneType from `-> None` and rejects a
    # 204 route as "must not have a response body".
    response_model=None,
)
def revoke_device(
    device_id: uuid.UUID, admin: AdminUser, request: Request, db: DbSession
) -> None:
    device = db.get(Device, device_id)
    if device is None or device.org_id != admin.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Device not found")
    device.is_active = False
    audit(db, org_id=admin.org_id, actor=admin, action="device.revoked", request=request,
          target_type="device", target_id=str(device.id))
    db.commit()


# --------------------------------------------------------------------------- #
# Screenshots
# --------------------------------------------------------------------------- #


def _screenshot_scope(
    db,
    viewer: User,
    user_id: uuid.UUID | None = None,
    team_id: uuid.UUID | None = None,
    department_id: uuid.UUID | None = None,
) -> list[uuid.UUID]:
    """Like _filter_scope, but never widens past the viewer's own captures when
    they are not permitted to see other people's.

    Their own are always visible. Being monitored and not being allowed to see
    what was recorded of you is the position this product exists to avoid — and
    it is the same reason the tray icon is not optional.
    """
    scope = _filter_scope(db, viewer, user_id, team_id, department_id)
    if viewer.can_view_screenshots:
        return scope
    # Only an explicit request for somebody else is refused out loud. Simply
    # opening the page narrows to their own captures instead of erroring: a
    # manager who may not see their team's screenshots should still land on a
    # working page showing theirs, not a 403 on the whole screen.
    if user_id is not None and user_id != viewer.id:
        deny_unless(viewer, "can_view_screenshots", "view other people's screenshots")
    return [viewer.id]


@router.get("/screenshots")
def list_screenshots(
    viewer: CurrentUser,
    db: DbSession,
    day: date | None = Query(default=None, description="defaults to today in the org timezone"),
    start: date | None = Query(default=None, description="range start; overrides day"),
    end: date | None = Query(default=None, description="range end; overrides day"),
    user_id: uuid.UUID | None = None,
    team_id: uuid.UUID | None = None,
    department_id: uuid.UUID | None = None,
    limit: int = Query(default=200, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> dict:
    scope = _screenshot_scope(db, viewer, user_id, team_id, department_id)
    tz_name = _org_tz(db, viewer.org_id)
    # `day` is kept because links and bookmarks carry it; a start/end pair wins
    # when given. Screenshots were single-day only, which made "show me last
    # Tuesday afternoon and Wednesday" two searches and no way to export both.
    if start or end:
        end = end or start or _today(tz_name)
        start = start or end
        _validate_range(start, end)
        win_start, win_end = reports.range_bounds(start, end, tz_name)
    else:
        day = day or _today(tz_name)
        win_start, win_end = reports.day_bounds(day, tz_name)
    start_bound, end_bound = win_start, win_end

    stmt = select(Screenshot).where(
        Screenshot.org_id == viewer.org_id,
        Screenshot.captured_at >= start_bound,
        Screenshot.captured_at < end_bound,
    )
    if scope is not None:
        stmt = stmt.where(Screenshot.user_id.in_(scope))

    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    shots = db.scalars(
        stmt.order_by(Screenshot.captured_at.desc()).limit(limit).offset(offset)
    ).all()

    return {
        "total": int(total),
        # The org timezone is authoritative for a workforce tool: a manager in
        # another zone must still read capture times in the workspace's zone,
        # not their own. The client formats against this, not the browser.
        "timezone": tz_name,
        "items": [
            {
                "id": str(s.id),
                "user_id": str(s.user_id),
                "captured_at": s.captured_at,
                "app_name": s.app_name,
                "window_title": s.window_title,
                "url_domain": s.url_domain,
                "productivity": s.productivity,
                "activity_pct": s.activity_pct,
                "monitor_count": s.monitor_count,
                "blurred": s.blurred,
                "width": s.width,
                "height": s.height,
                "thumb_url": f"/api/v1/admin/screenshots/{s.id}/image?variant=thumb",
                "full_url": f"/api/v1/admin/screenshots/{s.id}/image?variant=full",
            }
            for s in shots
        ],
    }


@router.get("/screenshots/{shot_id}/image")
def screenshot_image(
    shot_id: uuid.UUID,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
    # RedirectResponse is a Response subclass, so one annotation covers both
    # the local-disk and object-storage paths.
    variant: str = Query(default="full", pattern="^(full|thumb)$"),
) -> Response:
    shot = db.get(Screenshot, shot_id)
    if shot is None or shot.org_id != viewer.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Screenshot not found")
    _require_visible(db, viewer, shot.user_id)
    # Someone else's capture needs the permission as well as the visibility.
    # Your own is always yours to look at.
    if shot.user_id != viewer.id:
        deny_unless(viewer, "can_view_screenshots", "view other people's screenshots")

    key = shot.thumb_key if variant == "thumb" and shot.thumb_key else shot.storage_key
    try:
        served = storage.serve(key)
    except (FileNotFoundError, storage.StorageError):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Image data missing") from None

    if variant == "full":
        # Only full-size views are logged; thumbnail rendering in a grid is not
        # meaningfully "viewing" and would drown the audit trail.
        #
        # Note this is written *before* the redirect is issued, so the audit
        # record exists even on an object-storage backend where the bytes never
        # pass through this server.
        audit(db, org_id=viewer.org_id, actor=viewer, action="screenshot.viewed",
              request=request, target_type="screenshot", target_id=str(shot.id),
              detail={"subject_user_id": str(shot.user_id)})
        db.commit()

    if served.url:
        # Presigned and short-lived. The permission checks above have already
        # run; 307 keeps the method and avoids caching the redirect.
        return RedirectResponse(served.url, status_code=status.HTTP_307_TEMPORARY_REDIRECT)
    return FileResponse(served.path, media_type="image/jpeg")


@router.delete(
    "/screenshots/{shot_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None
)
def delete_screenshot(
    shot_id: uuid.UUID, admin: AdminUser, request: Request, db: DbSession
) -> None:
    shot = db.get(Screenshot, shot_id)
    if shot is None or shot.org_id != admin.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Screenshot not found")
    storage.delete(shot.storage_key)
    storage.delete(shot.thumb_key)
    db.delete(shot)
    audit(db, org_id=admin.org_id, actor=admin, action="screenshot.deleted", request=request,
          target_type="screenshot", target_id=str(shot_id))
    db.commit()


# --------------------------------------------------------------------------- #
# Reports
# --------------------------------------------------------------------------- #


def _validate_range(start: date, end: date) -> None:
    if end < start:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "end is before start")
    if (end - start).days + 1 > MAX_REPORT_DAYS:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"Range exceeds {MAX_REPORT_DAYS} days",
        )


@router.get("/reports/summary")
def report_summary(
    viewer: CurrentUser,
    db: DbSession,
    start: date | None = Query(default=None, description="defaults to 6 days before end"),
    end: date | None = Query(default=None, description="defaults to today in the org timezone"),
    user_id: uuid.UUID | None = None,
) -> dict:
    deny_page(viewer, "reports")
    tz_name = _org_tz(db, viewer.org_id)
    end = end or _today(tz_name)
    start = start or end - timedelta(days=6)
    _validate_range(start, end)
    scope = _resolve_scope(db, viewer, user_id)
    win_start, win_end = reports.range_bounds(start, end, tz_name)

    per_user = reports.per_user_totals(db, viewer.org_id, win_start, win_end)
    users = {
        u.id: u
        for u in db.scalars(select(User).where(User.org_id == viewer.org_id)).all()
    }
    teams = reports.team_names(db, viewer.org_id)

    by_user = []
    for uid, totals in per_user.items():
        if scope is not None and uid not in scope:
            continue
        u = users.get(uid)
        if u is None:
            continue
        by_user.append(
            {
                "user_id": str(uid),
                "full_name": u.full_name,
                "team": teams.get(u.team_id),
                **totals.as_dict(),
            }
        )
    by_user.sort(key=lambda r: r["tracked_s"], reverse=True)

    by_team: dict[str, dict] = {}
    for row in by_user:
        team = row["team"] or "Unassigned"
        bucket = by_team.setdefault(
            team, {"team": team, "members": 0, "tracked_s": 0, "active_s": 0,
                   "productive_s": 0, "unproductive_s": 0, "neutral_s": 0}
        )
        bucket["members"] += 1
        for k in ("tracked_s", "active_s", "productive_s", "unproductive_s", "neutral_s"):
            bucket[k] += row[k]

    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "timezone": tz_name,
        "totals": reports.totals_for(db, viewer.org_id, win_start, win_end, scope).as_dict(),
        "daily": reports.daily_series(db, viewer.org_id, start, end, tz_name, scope),
        "by_user": by_user,
        "by_team": sorted(by_team.values(), key=lambda r: r["tracked_s"], reverse=True),
        "top_apps": reports.top_breakdown(db, viewer.org_id, win_start, win_end, by="app",
                                          user_ids=scope, limit=20),
        "top_domains": reports.top_breakdown(db, viewer.org_id, win_start, win_end, by="domain",
                                             user_ids=scope, limit=20),
    }


@router.get("/reports/export.csv")
def report_csv(
    viewer: CurrentUser,
    db: DbSession,
    start: date | None = Query(default=None, description="defaults to 6 days before end"),
    end: date | None = Query(default=None, description="defaults to today in the org timezone"),
    user_id: uuid.UUID | None = None,
    team_id: uuid.UUID | None = None,
    department_id: uuid.UUID | None = None,
) -> StreamingResponse:
    """Per-employee, per-day activity for a range.

    The three narrowing parameters are not decoration: this took only the date
    range and applied the viewer's visibility, so every caller that *had*
    narrowed — the dashboard's team picker, and "My performance", which asks for
    exactly one person — silently got a file covering everyone they could see.
    A manager exporting their own week received their whole team's.
    """
    deny_page(viewer, "reports")
    deny_unless(viewer, "can_export_data", "export data")
    tz_name = _org_tz(db, viewer.org_id)
    end = end or _today(tz_name)
    start = start or end - timedelta(days=6)
    _validate_range(start, end)
    scope = _filter_scope(db, viewer, user_id, team_id, department_id)

    users = {u.id: u for u in db.scalars(select(User).where(User.org_id == viewer.org_id)).all()}
    teams = reports.team_names(db, viewer.org_id)

    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(
        ["date", "employee", "email", "team", "tracked_h", "active_h", "idle_h",
         "productive_h", "unproductive_h", "neutral_h", "productivity_pct"]
    )

    day = start
    while day <= end:
        d0, d1 = reports.day_bounds(day, tz_name)
        for uid, totals in reports.per_user_totals(db, viewer.org_id, d0, d1).items():
            if scope is not None and uid not in scope:
                continue
            u = users.get(uid)
            if u is None:
                continue
            writer.writerow(
                [
                    day.isoformat(), u.full_name, u.email, teams.get(u.team_id) or "",
                    round(totals.tracked_s / 3600, 2),
                    round(totals.active_s / 3600, 2),
                    round(totals.idle_s / 3600, 2),
                    round(totals.productive_s / 3600, 2),
                    round(totals.unproductive_s / 3600, 2),
                    round(totals.neutral_s / 3600, 2),
                    totals.productivity_pct,
                ]
            )
        day += timedelta(days=1)

    buf.seek(0)
    filename = f"activity-{start.isoformat()}-to-{end.isoformat()}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# --------------------------------------------------------------------------- #
# Settings & rules
# --------------------------------------------------------------------------- #


@router.get("/activity/export.csv")
def activity_csv(
    viewer: CurrentUser,
    db: DbSession,
    start: date | None = None,
    end: date | None = None,
    user_id: uuid.UUID | None = None,
    team_id: uuid.UUID | None = None,
    department_id: uuid.UUID | None = None,
    kind: str = Query(default="all", pattern=r"^(all|apps|websites)$"),
    productivity: str | None = Query(default=None, pattern=r"^(productive|unproductive|neutral)$"),
    q: str | None = Query(default=None),
) -> StreamingResponse:
    """The Apps & Websites log, one row per usage, honouring every filter.

    The screen pages at 200 rows; this does not. An export that silently
    returned only the visible page would be worse than no export — the file
    looks complete and is not. There is a hard cap instead, high enough that a
    normal range never reaches it.
    """
    deny_page(viewer, "apps")
    deny_unless(viewer, "can_export_data", "export data")
    tz_name = _org_tz(db, viewer.org_id)
    end = end or _today(tz_name)
    start = start or end
    _validate_range(start, end)
    win_start, win_end = reports.range_bounds(start, end, tz_name)
    scope = _filter_scope(db, viewer, user_id, team_id, department_id)

    stmt = select(ActivitySegment).where(
        ActivitySegment.org_id == viewer.org_id,
        ActivitySegment.started_at >= win_start,
        ActivitySegment.started_at < win_end,
    )
    if scope is not None:
        stmt = stmt.where(ActivitySegment.user_id.in_(scope))
    if kind == "apps":
        stmt = stmt.where(ActivitySegment.url_domain.is_(None))
    elif kind == "websites":
        stmt = stmt.where(ActivitySegment.url_domain.is_not(None))
    if productivity:
        stmt = stmt.where(ActivitySegment.productivity == productivity)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(
            or_(
                ActivitySegment.app_name.ilike(like),
                ActivitySegment.url_domain.ilike(like),
                ActivitySegment.window_title.ilike(like),
            )
        )

    users = {u.id: u for u in db.scalars(select(User).where(User.org_id == viewer.org_id)).all()}
    teams = reports.team_names(db, viewer.org_id)

    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(
        ["started_at", "ended_at", "employee", "email", "team", "application",
         "domain", "window_title", "productivity", "duration_h", "active_h",
         "idle_h", "is_idle"]
    )
    for seg in db.scalars(stmt.order_by(ActivitySegment.started_at.desc()).limit(50000)).all():
        u = users.get(seg.user_id)
        writer.writerow(
            [
                _local_iso(seg.started_at, tz_name),
                _local_iso(seg.ended_at, tz_name),
                u.full_name if u else "", u.email if u else "",
                (teams.get(u.team_id) or "") if u else "",
                seg.app_name or "", seg.url_domain or "", seg.window_title or "",
                seg.productivity or "",
                round((seg.duration_s or 0) / 3600, 3),
                round((seg.active_s or 0) / 3600, 3),
                round((seg.idle_s or 0) / 3600, 3),
                "yes" if seg.is_idle else "no",
            ]
        )
    return _csv_response(buf, f"apps-websites-{start.isoformat()}-to-{end.isoformat()}.csv")


@router.get("/screenshots/export.csv")
def screenshots_csv(
    viewer: CurrentUser,
    db: DbSession,
    day: date | None = None,
    start: date | None = None,
    end: date | None = None,
    user_id: uuid.UUID | None = None,
    team_id: uuid.UUID | None = None,
    department_id: uuid.UUID | None = None,
) -> StreamingResponse:
    """An index of captures, not the images.

    Deliberately metadata only: a CSV cannot carry JPEGs, and a zip of every
    screenshot in a range is a data-protection decision rather than a button.
    """
    tz_name = _org_tz(db, viewer.org_id)
    if start or end:
        end = end or start or _today(tz_name)
        start = start or end
    else:
        day = day or _today(tz_name)
        start = end = day
    _validate_range(start, end)
    win_start, win_end = reports.range_bounds(start, end, tz_name)
    deny_unless(viewer, "can_export_data", "export data")
    scope = _screenshot_scope(db, viewer, user_id, team_id, department_id)

    stmt = select(Screenshot).where(
        Screenshot.org_id == viewer.org_id,
        Screenshot.captured_at >= win_start,
        Screenshot.captured_at < win_end,
    )
    if scope is not None:
        stmt = stmt.where(Screenshot.user_id.in_(scope))

    users = {u.id: u for u in db.scalars(select(User).where(User.org_id == viewer.org_id)).all()}
    teams = reports.team_names(db, viewer.org_id)

    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(
        ["captured_at", "employee", "email", "team", "application", "window_title",
         "domain", "monitors", "activity_pct"]
    )
    for shot in db.scalars(stmt.order_by(Screenshot.captured_at.desc()).limit(50000)).all():
        u = users.get(shot.user_id)
        writer.writerow(
            [
                _local_iso(shot.captured_at, tz_name),
                u.full_name if u else "", u.email if u else "",
                (teams.get(u.team_id) or "") if u else "",
                shot.app_name or "", shot.window_title or "", shot.url_domain or "",
                shot.monitor_count, shot.activity_pct,
            ]
        )
    return _csv_response(buf, f"screenshots-{start.isoformat()}-to-{end.isoformat()}.csv")


@router.get("/employees/export.csv")
def employees_csv(viewer: CurrentUser, db: DbSession) -> StreamingResponse:
    """The roster the viewer is allowed to see — without enrolment keys.

    UserWithKeyOut carries the key so an administrator can hand it to one
    person. A spreadsheet of every key is a different thing entirely, and is
    not what "export the employee list" should quietly mean.
    """
    deny_unless(viewer, "can_export_data", "export data")
    scope = visible_user_ids(db, viewer)
    stmt = select(User).where(User.org_id == viewer.org_id)
    if scope is not None:
        stmt = stmt.where(User.id.in_(scope))
    teams = reports.team_names(db, viewer.org_id)
    departments = {
        d.id: d.name
        for d in db.scalars(select(Department).where(Department.org_id == viewer.org_id)).all()
    }
    people = db.scalars(stmt.order_by(User.full_name)).all()
    everyone = {
        u.id: u for u in db.scalars(select(User).where(User.org_id == viewer.org_id)).all()
    }

    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(
        ["employee", "email", "employee_code", "role", "team", "department",
         "manager", "timezone", "status", "joined_on", "created_at"]
    )
    for u in people:
        manager = everyone.get(u.manager_id) if u.manager_id else None
        writer.writerow(
            [
                u.full_name, u.email, u.employee_code or "", u.role,
                teams.get(u.team_id) or "", departments.get(u.department_id) or "",
                manager.full_name if manager else "",
                u.timezone, "active" if u.is_active else "inactive",
                u.joined_on.isoformat() if u.joined_on else "",
                u.created_at.date().isoformat() if u.created_at else "",
            ]
        )
    return _csv_response(buf, "employees.csv")


# --------------------------------------------------------------------------- #
# Outbound mail — the workspace's own connector
# --------------------------------------------------------------------------- #


class MailIn(BaseModel):
    smtp_host: str = Field(default="", max_length=255)
    smtp_port: int = Field(default=587, ge=1, le=65535)
    smtp_user: str = Field(default="", max_length=255)
    #: Omit to keep the stored password, "" to clear it. Never returned.
    smtp_password: str | None = None
    smtp_use_tls: bool = True
    email_from: str = Field(default="", max_length=255)


class MailTestIn(BaseModel):
    to: EmailStr


def _org_mail_state(db, org_id: uuid.UUID, row) -> dict:
    effective = mailconfig.resolve(db, org_id)
    return {
        "smtp_host": row.smtp_host,
        "smtp_port": row.smtp_port,
        "smtp_user": row.smtp_user,
        "smtp_use_tls": row.smtp_use_tls,
        "email_from": row.email_from,
        "has_password": bool(row.smtp_password_enc),
        # What is actually carrying the mail today. An owner with a blank form
        # is not broken — they are inheriting the platform's connector, and the
        # screen has to say which, or a blank form reads as "nothing works".
        "effective_source": effective.source,
        "effective_host": effective.host,
        "configured": effective.configured,
        "last_test": {
            "at": row.last_test_at.isoformat() if row.last_test_at else None,
            "to": row.last_test_to,
            "ok": row.last_test_ok,
            "error": row.last_test_error,
        },
    }


@router.get("/mail")
def read_org_mail(owner: OwnerUser, db: DbSession) -> dict:
    return _org_mail_state(db, owner.org_id, mailconfig.get_or_create(db, owner.org_id))


@router.put("/mail")
def update_org_mail(
    payload: MailIn, owner: OwnerUser, request: Request, db: DbSession
) -> dict:
    row = mailconfig.get_or_create(db, owner.org_id)
    row.smtp_host = payload.smtp_host.strip()
    row.smtp_port = payload.smtp_port
    row.smtp_user = payload.smtp_user.strip()
    row.smtp_use_tls = payload.smtp_use_tls
    row.email_from = payload.email_from.strip()
    if payload.smtp_password is not None:
        row.smtp_password_enc = mailconfig.encrypt(payload.smtp_password)

    audit(db, org_id=owner.org_id, actor=owner, action="mail.configured", request=request,
          target_type="mail", target_id="settings",
          # Host and user only; a password is not audit material.
          detail={"host": row.smtp_host, "port": row.smtp_port, "user": row.smtp_user})
    db.commit()
    db.refresh(row)
    return _org_mail_state(db, owner.org_id, row)


@router.post("/mail/test")
def test_org_mail(payload: MailTestIn, owner: OwnerUser, db: DbSession) -> dict:
    """Prove it works before anyone relies on it.

    "Saved" only means the form validated. The gap between that and "a message
    arrived" is every wrong password, blocked port and rejected sender there is.
    """
    row = mailconfig.get_or_create(db, owner.org_id)
    config = mailconfig.resolve(db, owner.org_id)
    if not config.configured:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Set an SMTP host and save it before sending a test",
        )
    ok, error = mailconfig.send_test(config, str(payload.to))
    row.last_test_at = datetime.now(timezone.utc)
    row.last_test_to = str(payload.to)
    row.last_test_ok = ok
    row.last_test_error = None if ok else (error or "")[:2000]
    db.commit()
    db.refresh(row)
    return {"ok": ok, "error": row.last_test_error,
            **_org_mail_state(db, owner.org_id, row)}


@router.get("/settings", response_model=OrgSettingsOut)
def read_settings(viewer: CurrentUser, db: DbSession) -> OrgSettingsOut:
    return OrgSettingsOut.model_validate(get_org_settings(db, viewer.org_id))


@router.get("/subscription")
def my_subscription(viewer: CurrentUser, db: DbSession) -> dict:
    """What this company is on, and how much of it is used.

    Available to every signed-in user, not just admins: an employee hitting a
    seat limit deserves to see why rather than a bare error.
    """
    org = db.get(Organization, viewer.org_id)
    ent = subs.entitlement(db, org)
    sub = ent.subscription
    return {
        "organization": {"name": org.name, "slug": org.slug, "status": org.status},
        "plan": {
            "id": ent.plan.id,
            "name": ent.plan.name,
            "features": list(ent.plan.features),
            "base_price_annual": ent.plan.base_price_annual,
            "per_employee_month": ent.plan.per_employee_month,
            "max_screenshot_retention_days": ent.plan.max_screenshot_retention_days,
            "max_activity_retention_days": ent.plan.max_activity_retention_days,
            "min_screenshot_interval_s": ent.plan.min_screenshot_interval_s,
        },
        "status": ent.status.value,
        "billing_cycle": sub.billing_cycle if sub else None,
        "period_start": sub.period_start if sub else None,
        "period_end": sub.period_end if sub else None,
        "days_remaining": ent.days_remaining,
        "total_amount": sub.total_amount if sub else 0,
        "currency": sub.currency if sub else "INR",
        "usage": subs.usage_for(db, org),
    }


@router.put("/settings", response_model=None)
def update_settings(
    payload: OrgSettingsUpdate, admin: AdminUser, request: Request, db: DbSession
) -> OrgSettingsOut | JSONResponse:
    settings = get_org_settings(db, admin.org_id)
    changes = payload.model_dump(exclude_unset=True)
    before = {k: getattr(settings, k) for k in changes}
    for field, value in changes.items():
        setattr(settings, field, value)

    # Plan limits are enforced here rather than validated in the schema: the cap
    # depends on the caller's subscription, which Pydantic cannot see.
    org = db.get(Organization, admin.org_id)
    capped = subs.clamp_settings_to_plan(settings, subs.entitlement(db, org).plan)

    audit(db, org_id=admin.org_id, actor=admin, action="settings.updated", request=request,
          target_type="org_settings", target_id=str(admin.org_id),
          detail={"before": before, "after": changes, "capped": capped})
    db.commit()

    result = OrgSettingsOut.model_validate(settings)
    if capped:
        # Silently clamping would look like the save failed.
        return JSONResponse(
            status_code=status.HTTP_200_OK,
            content={**result.model_dump(mode="json"), "plan_limits_applied": capped},
        )
    return result


@router.get("/rules", response_model=list[RuleOut])
def list_rules(viewer: CurrentUser, db: DbSession) -> list[ProductivityRule]:
    return list(
        db.scalars(
            select(ProductivityRule)
            .where(ProductivityRule.org_id == viewer.org_id)
            .order_by(ProductivityRule.match_type, ProductivityRule.pattern)
        ).all()
    )


@router.post("/rules", response_model=RuleOut, status_code=status.HTTP_201_CREATED)
def create_rule(
    payload: RuleCreate, admin: AdminUser, request: Request, db: DbSession
) -> ProductivityRule:
    pattern = payload.pattern.lower().strip().removeprefix("www.")
    existing = db.scalar(
        select(ProductivityRule).where(
            ProductivityRule.org_id == admin.org_id,
            ProductivityRule.match_type == payload.match_type,
            ProductivityRule.pattern == pattern,
        )
    )
    if existing is not None:
        existing.productivity = payload.productivity
        existing.priority = payload.priority
        existing.label = payload.label
        db.commit()
        return existing

    rule = ProductivityRule(
        org_id=admin.org_id,
        match_type=payload.match_type,
        pattern=pattern,
        productivity=payload.productivity,
        priority=payload.priority,
        label=payload.label,
    )
    db.add(rule)
    audit(db, org_id=admin.org_id, actor=admin, action="rule.created", request=request,
          detail={"pattern": pattern, "productivity": payload.productivity})
    db.commit()
    return rule


@router.delete(
    "/rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None
)
def delete_rule(rule_id: uuid.UUID, admin: AdminUser, db: DbSession) -> None:
    # 404 when nothing matched, rather than 204 regardless. The WHERE clause
    # is correctly scoped, so a foreign id deletes nothing — but reporting
    # success for it tells every client the rule is gone when it is not, and
    # makes a genuine authorisation bug indistinguishable from a no-op.
    result = db.execute(
        delete(ProductivityRule).where(
            ProductivityRule.id == rule_id, ProductivityRule.org_id == admin.org_id
        )
    )
    if result.rowcount == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Rule not found")
    db.commit()


@router.post("/rules/restore-defaults")
def restore_default_rules(admin: AdminUser, db: DbSession) -> dict:
    added = seed_default_rules(db, admin.org_id)
    db.commit()
    return {"added": added}


@router.post("/reclassify")
def reclassify(admin: AdminUser, db: DbSession, days: int = Query(default=7, ge=1, le=92)) -> dict:
    """Re-apply the current rule set to recent history.

    Classification is stored on the row at ingest time, so a rule added today
    would otherwise only affect tomorrow's data.
    """
    from app.services.classifier import Classifier

    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    classifier = Classifier.for_org(db, admin.org_id)
    segments = db.scalars(
        select(ActivitySegment).where(
            ActivitySegment.org_id == admin.org_id, ActivitySegment.started_at >= cutoff
        )
    ).all()

    changed = 0
    for seg in segments:
        new = classifier.classify(
            app_exec=seg.app_exec,
            url_domain=seg.url_domain,
            window_title=seg.window_title,
            is_idle=seg.is_idle,
        )
        if new != seg.productivity:
            seg.productivity = new
            changed += 1

    db.commit()
    return {"scanned": len(segments), "changed": changed}


# --------------------------------------------------------------------------- #
# Agent downloads
# --------------------------------------------------------------------------- #


@router.get("/agent/bundles")
def list_agent_bundles(viewer: CurrentUser) -> dict:
    """What the console can hand an administrator to send to their staff.

    Available to any signed-in member of the organisation, not just admins. The
    bundle carries no secret — enrolment is the key, which is per person and
    shown elsewhere — and an employee reinstalling on a replacement laptop
    should not have to go back through their administrator for the installer.

    ``server_url`` is what the employee types at the setup prompt. Null unless
    it has been configured explicitly, in which case the console falls back to
    the origin it is being viewed on — correct whenever the console and API
    share a host, which they do behind the bundled nginx.
    """
    bundles = agentdist.list_bundles()
    return {
        "bundles": [b.as_dict() for b in bundles],
        "server_url": settings.agent_server_url or None,
        # Named so somebody who copied a build in and cannot see it is told why,
        # in the place they are looking.
        "ignored": agentdist.ignored_names(),
    }


@router.get("/agent/bundles/{name}/download")
def download_agent_bundle(name: str, viewer: CurrentUser) -> FileResponse:
    # Resolved against the listing, never by joining `name` onto a directory —
    # so there is no traversal here to get wrong.
    bundle = agentdist.find(name)
    if bundle is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail={
                "reason": "bundle_missing",
                "message": (
                    "That agent build is not on this server. Ask whoever deploys "
                    "it to copy the bundle into the agent downloads directory."
                ),
            },
        )
    return FileResponse(
        bundle.path,
        media_type="application/octet-stream",
        filename=bundle.name,
    )
