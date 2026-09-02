"""Departments, teams, designations, schedules and the reporting hierarchy."""

from __future__ import annotations

import uuid

from fastapi import (
    APIRouter,
    File,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
    status,
)
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy import func, select

from app.api.deps import deny_page, AdminUser, CurrentUser, DbSession, TeamViewer, audit, visible_user_ids
from app.models import Department, Designation, Organization, Team, User, WorkSchedule
from app.schemas.common import CompanyProfileIn, CompanyProfileOut
from app.services import branding
from app.schemas.org_structure import (
    AssignRequest,
    DepartmentIn,
    DepartmentOut,
    DesignationIn,
    DesignationOut,
    ScheduleIn,
    ScheduleOut,
    TeamIn,
    TeamOut,
)
from app.services import hierarchy
from app.services import subscriptions as subs

router = APIRouter(prefix="/org", tags=["org-structure"])


def _counts_by(db, column, org_id: uuid.UUID) -> dict:
    return {
        row[0]: int(row[1])
        for row in db.execute(
            select(column, func.count(User.id))
            .where(User.org_id == org_id, User.is_active.is_(True))
            .group_by(column)
        )
        if row[0] is not None
    }


def _user_names(db, org_id: uuid.UUID) -> dict[uuid.UUID, str]:
    return {
        row[0]: row[1]
        for row in db.execute(select(User.id, User.full_name).where(User.org_id == org_id))
    }


# --------------------------------------------------------------------------- #
# Modules this workspace has
# --------------------------------------------------------------------------- #


@router.get("/modules")
def enabled_modules(user: CurrentUser, db: DbSession) -> dict:
    """Which HRMS modules this workspace may use, for the console's navigation.

    Authenticated, and deliberately not folded into ``/auth/tenant``: that one is
    public so the sign-in page can name the company, and it exposes nothing else
    on purpose. Which modules a company bought is commercial information about
    that company, and an unauthenticated endpoint answering it would let anyone
    who can guess a slug enumerate what every customer is paying for.

    The console hides nav for anything off. That is presentation only — the real
    gate is ``require_module`` on the router, which still refuses a hand-typed
    URL. Hiding without gating would be theatre; gating without hiding is what
    the console does today, and it means a link that always 402s.
    """
    org = db.get(Organization, user.org_id)
    ent = subs.entitlement(db, org)
    state = ent.module_state()
    return {
        # A flat list is what the nav actually consumes; the map is for the
        # billing page, which wants to say *why* something is unavailable.
        "enabled": [key for key, value in state.items() if value["enabled"]],
        "modules": {
            key: {"enabled": value["enabled"], "in_plan": value["in_plan"]}
            for key, value in state.items()
        },
    }


# --------------------------------------------------------------------------- #
# Departments
# --------------------------------------------------------------------------- #


@router.get("/departments", response_model=list[DepartmentOut])
def list_departments(viewer: CurrentUser, db: DbSession) -> list[DepartmentOut]:
    departments = db.scalars(
        select(Department).where(Department.org_id == viewer.org_id).order_by(Department.name)
    ).all()
    members = _counts_by(db, User.department_id, viewer.org_id)
    names = _user_names(db, viewer.org_id)
    team_counts = {
        row[0]: int(row[1])
        for row in db.execute(
            select(Team.department_id, func.count(Team.id))
            .where(Team.org_id == viewer.org_id)
            .group_by(Team.department_id)
        )
        if row[0] is not None
    }
    return [
        DepartmentOut(
            **{c.name: getattr(d, c.name) for c in Department.__table__.columns
               if c.name in DepartmentOut.model_fields},
            head_name=names.get(d.head_user_id),
            team_count=team_counts.get(d.id, 0),
            member_count=members.get(d.id, 0),
        )
        for d in departments
    ]


@router.post("/departments", response_model=DepartmentOut, status_code=status.HTTP_201_CREATED)
def create_department(
    payload: DepartmentIn, admin: AdminUser, request: Request, db: DbSession
) -> DepartmentOut:
    if db.scalar(
        select(Department.id).where(
            Department.org_id == admin.org_id, Department.name == payload.name.strip()
        )
    ):
        raise HTTPException(status.HTTP_409_CONFLICT, "A department with that name exists")

    department = Department(org_id=admin.org_id, **payload.model_dump())
    department.name = payload.name.strip()
    db.add(department)
    db.flush()
    audit(db, org_id=admin.org_id, actor=admin, action="department.created", request=request,
          target_type="department", target_id=str(department.id))
    db.commit()
    return DepartmentOut(
        **{c.name: getattr(department, c.name) for c in Department.__table__.columns
           if c.name in DepartmentOut.model_fields}
    )


@router.patch("/departments/{department_id}", response_model=DepartmentOut)
def update_department(
    department_id: uuid.UUID, payload: DepartmentIn, admin: AdminUser, db: DbSession
) -> DepartmentOut:
    department = db.get(Department, department_id)
    if department is None or department.org_id != admin.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Department not found")
    if payload.parent_id == department.id:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "A department cannot be its own parent"
        )

    for field, value in payload.model_dump().items():
        setattr(department, field, value)
    department.name = payload.name.strip()
    db.commit()
    return DepartmentOut(
        **{c.name: getattr(department, c.name) for c in Department.__table__.columns
           if c.name in DepartmentOut.model_fields}
    )


@router.delete("/departments/{department_id}", status_code=status.HTTP_204_NO_CONTENT,
               response_model=None)
def delete_department(department_id: uuid.UUID, admin: AdminUser, db: DbSession) -> None:
    department = db.get(Department, department_id)
    if department is None or department.org_id != admin.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Department not found")
    # Employees keep existing; the FK is SET NULL. Deleting a department must
    # never take its people with it.
    db.delete(department)
    db.commit()


# --------------------------------------------------------------------------- #
# Teams
# --------------------------------------------------------------------------- #


@router.get("/teams", response_model=list[TeamOut])
def list_teams(viewer: CurrentUser, db: DbSession) -> list[TeamOut]:
    teams = db.scalars(
        select(Team).where(Team.org_id == viewer.org_id).order_by(Team.name)
    ).all()
    members = _counts_by(db, User.team_id, viewer.org_id)
    names = _user_names(db, viewer.org_id)
    departments = {
        d.id: d.name
        for d in db.scalars(select(Department).where(Department.org_id == viewer.org_id)).all()
    }
    return [
        TeamOut(
            **{c.name: getattr(t, c.name) for c in Team.__table__.columns
               if c.name in TeamOut.model_fields},
            department_name=departments.get(t.department_id),
            manager_name=names.get(t.manager_user_id),
            member_count=members.get(t.id, 0),
        )
        for t in teams
    ]


@router.post("/teams", response_model=TeamOut, status_code=status.HTTP_201_CREATED)
def create_team(payload: TeamIn, admin: AdminUser, request: Request, db: DbSession) -> TeamOut:
    if db.scalar(
        select(Team.id).where(Team.org_id == admin.org_id, Team.name == payload.name.strip())
    ):
        raise HTTPException(status.HTTP_409_CONFLICT, "A team with that name exists")

    team = Team(org_id=admin.org_id, **payload.model_dump())
    team.name = payload.name.strip()
    db.add(team)
    db.flush()

    # Naming someone team manager without the manager role would silently give
    # them a team they cannot open.
    if team.manager_user_id:
        _promote_to_manager(db, admin.org_id, team.manager_user_id)

    audit(db, org_id=admin.org_id, actor=admin, action="team.created", request=request,
          target_type="team", target_id=str(team.id))
    db.commit()
    return TeamOut(
        **{c.name: getattr(team, c.name) for c in Team.__table__.columns
           if c.name in TeamOut.model_fields}
    )


@router.patch("/teams/{team_id}", response_model=TeamOut)
def update_team(team_id: uuid.UUID, payload: TeamIn, admin: AdminUser, db: DbSession) -> TeamOut:
    team = db.get(Team, team_id)
    if team is None or team.org_id != admin.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Team not found")
    for field, value in payload.model_dump().items():
        setattr(team, field, value)
    team.name = payload.name.strip()
    if team.manager_user_id:
        _promote_to_manager(db, admin.org_id, team.manager_user_id)
    db.commit()
    return TeamOut(
        **{c.name: getattr(team, c.name) for c in Team.__table__.columns
           if c.name in TeamOut.model_fields}
    )


@router.delete("/teams/{team_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_team(team_id: uuid.UUID, admin: AdminUser, db: DbSession) -> None:
    team = db.get(Team, team_id)
    if team is None or team.org_id != admin.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Team not found")
    db.delete(team)
    db.commit()


def _promote_to_manager(db, org_id: uuid.UUID, user_id: uuid.UUID) -> None:
    user = db.get(User, user_id)
    if user is None or user.org_id != org_id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Unknown manager")
    if user.role == "employee":
        user.role = "manager"


# --------------------------------------------------------------------------- #
# Designations & schedules
# --------------------------------------------------------------------------- #


@router.get("/designations", response_model=list[DesignationOut])
def list_designations(viewer: CurrentUser, db: DbSession) -> list[DesignationOut]:
    rows = db.scalars(
        select(Designation)
        .where(Designation.org_id == viewer.org_id)
        .order_by(Designation.level.desc(), Designation.name)
    ).all()
    members = _counts_by(db, User.designation_id, viewer.org_id)
    return [
        DesignationOut(
            id=d.id, name=d.name, level=d.level, is_active=d.is_active,
            member_count=members.get(d.id, 0),
        )
        for d in rows
    ]


@router.post("/designations", response_model=DesignationOut, status_code=status.HTTP_201_CREATED)
def create_designation(payload: DesignationIn, admin: AdminUser, db: DbSession) -> DesignationOut:
    if db.scalar(
        select(Designation.id).where(
            Designation.org_id == admin.org_id, Designation.name == payload.name.strip()
        )
    ):
        raise HTTPException(status.HTTP_409_CONFLICT, "That designation exists")
    designation = Designation(org_id=admin.org_id, name=payload.name.strip(), level=payload.level)
    db.add(designation)
    db.commit()
    return DesignationOut(
        id=designation.id, name=designation.name, level=designation.level,
        is_active=designation.is_active,
    )


@router.delete("/designations/{designation_id}", status_code=status.HTTP_204_NO_CONTENT,
               response_model=None)
def delete_designation(designation_id: uuid.UUID, admin: AdminUser, db: DbSession) -> None:
    designation = db.get(Designation, designation_id)
    if designation is None or designation.org_id != admin.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Designation not found")
    db.delete(designation)
    db.commit()


@router.get("/schedules", response_model=list[ScheduleOut])
def list_schedules(viewer: CurrentUser, db: DbSession) -> list[ScheduleOut]:
    rows = db.scalars(
        select(WorkSchedule).where(WorkSchedule.org_id == viewer.org_id).order_by(WorkSchedule.name)
    ).all()
    members = _counts_by(db, User.schedule_id, viewer.org_id)
    return [
        ScheduleOut(
            **{c.name: getattr(s, c.name) for c in WorkSchedule.__table__.columns
               if c.name in ScheduleOut.model_fields},
            expected_minutes=s.expected_minutes,
            member_count=members.get(s.id, 0),
        )
        for s in rows
    ]


@router.post("/schedules", response_model=ScheduleOut, status_code=status.HTTP_201_CREATED)
def create_schedule(payload: ScheduleIn, admin: AdminUser, db: DbSession) -> ScheduleOut:
    if payload.is_default:
        # Exactly one default, or "the default schedule" means nothing.
        db.execute(
            WorkSchedule.__table__.update()
            .where(WorkSchedule.org_id == admin.org_id)
            .values(is_default=False)
        )
    schedule = WorkSchedule(org_id=admin.org_id, **payload.model_dump())
    db.add(schedule)
    db.flush()
    db.commit()
    return ScheduleOut(
        **{c.name: getattr(schedule, c.name) for c in WorkSchedule.__table__.columns
           if c.name in ScheduleOut.model_fields},
        expected_minutes=schedule.expected_minutes,
    )


# --------------------------------------------------------------------------- #
# Hierarchy & assignment
# --------------------------------------------------------------------------- #


@router.get("/hierarchy")
def org_hierarchy(
    viewer: CurrentUser,
    db: DbSession,
    root_id: uuid.UUID | None = Query(default=None),
) -> dict:
    """The reporting tree.

    A manager gets their own subtree rather than the whole company — the same
    scoping every other endpoint uses, applied to the shape of the chart.
    """
    deny_page(viewer, "hierarchy")

    # An employee sees their own reporting line and nothing else. Previously
    # this endpoint required the team-viewer role, so asking "who is my
    # manager?" returned 403 — a question nobody should have to file a ticket
    # for on a product that watches their screen.
    if not viewer.role_enum.can_view_team:
        return {
            "roots": hierarchy.reporting_line(db, viewer),
            "scoped": True,
            "line_only": True,
        }

    allowed = visible_user_ids(db, viewer)
    effective_root = root_id
    if allowed is not None and effective_root is None:
        effective_root = viewer.id
    if allowed is not None and effective_root not in allowed:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not permitted for that employee")

    return {
        "roots": hierarchy.build_tree(db, viewer.org_id, effective_root),
        "scoped": allowed is not None,
    }


@router.post("/assign")
def assign_members(
    payload: AssignRequest, admin: AdminUser, request: Request, db: DbSession
) -> dict:
    """Bulk placement, used by the roster's multi-select."""
    users = db.scalars(
        select(User).where(User.org_id == admin.org_id, User.id.in_(payload.user_ids))
    ).all()
    if len(users) != len(set(payload.user_ids)):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "One or more employees were not found")

    _validate_owned(db, admin.org_id, Department, payload.department_id)
    _validate_owned(db, admin.org_id, Team, payload.team_id)
    _validate_owned(db, admin.org_id, Designation, payload.designation_id)
    _validate_owned(db, admin.org_id, WorkSchedule, payload.schedule_id)

    if payload.manager_id is not None:
        manager = db.get(User, payload.manager_id)
        if manager is None or manager.org_id != admin.org_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Manager not found")

    rejected: list[str] = []
    for user in users:
        if payload.manager_id is not None:
            if hierarchy.would_create_cycle(db, user.id, payload.manager_id):
                # Reject just this one and carry on: failing the whole batch
                # because of a single loop would be worse.
                rejected.append(user.full_name)
                continue
            user.manager_id = payload.manager_id
        elif payload.clear_manager:
            user.manager_id = None

        if payload.department_id is not None:
            user.department_id = payload.department_id
        elif payload.clear_department:
            user.department_id = None

        if payload.team_id is not None:
            user.team_id = payload.team_id
        elif payload.clear_team:
            user.team_id = None

        if payload.designation_id is not None:
            user.designation_id = payload.designation_id
        if payload.schedule_id is not None:
            user.schedule_id = payload.schedule_id

    audit(db, org_id=admin.org_id, actor=admin, action="org.members_assigned", request=request,
          detail={"count": len(users) - len(rejected), "rejected": rejected})
    db.commit()

    return {
        "updated": len(users) - len(rejected),
        "rejected": rejected,
        "message": (
            f"{len(rejected)} employee(s) skipped: that manager would create a "
            f"reporting loop." if rejected else "Done."
        ),
    }


def _validate_owned(db, org_id: uuid.UUID, model, record_id: uuid.UUID | None) -> None:
    if record_id is None:
        return
    record = db.get(model, record_id)
    if record is None or record.org_id != org_id:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"{model.__name__} not found in this organisation"
        )


# --------------------------------------------------------------------------- #
# Company profile — who this company is, and the logo that brands its console
# --------------------------------------------------------------------------- #


def _company_out(org: Organization) -> CompanyProfileOut:
    """One place that turns the row into the response.

    ``has_logo`` is computed from the key and the key never leaves the server —
    it is an internal storage path, and putting it in a response body invites
    somebody to try fetching it directly.
    """
    out = CompanyProfileOut.model_validate(org)
    out.has_logo = bool(org.logo_key)
    return out


def _org_of(db, viewer: User) -> Organization:
    org = db.get(Organization, viewer.org_id)
    if org is None:
        # Only reachable if the tenant row was deleted under a live session.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Organisation not found")
    return org


@router.get("/company", response_model=CompanyProfileOut)
def company_profile(viewer: CurrentUser, db: DbSession) -> CompanyProfileOut:
    """Readable by everyone who works here.

    Not gated to administrators: this is the company's own name, address and
    contact details, which are already printed on the reader's payslip and offer
    letter. Editing it is a different question — see below.
    """
    return _company_out(_org_of(db, viewer))


@router.put("/company", response_model=CompanyProfileOut)
def update_company_profile(
    payload: CompanyProfileIn, admin: AdminUser, request: Request, db: DbSession
) -> CompanyProfileOut:
    """A partial update: only the fields present in the body are written.

    That is what makes two administrators editing different halves of the page
    safe, and it is why every field on ``CompanyProfileIn`` is optional. An
    emptied text box arrives as ``""`` and is stored as NULL — the schema does
    that, and the reason is on it: ``legal_name or name`` is what letters and
    payslips print, and an empty string would win that fallback and put a blank
    company on a legal document.
    """
    org = _org_of(db, admin)

    changed: list[str] = []
    for field, value in payload.model_dump(exclude_unset=True).items():
        if getattr(org, field) != value:
            setattr(org, field, value)
            changed.append(field)

    if changed:
        audit(db, org_id=org.id, actor=admin, action="org.profile_updated", request=request,
              detail={"fields": sorted(changed)})
    db.commit()
    db.refresh(org)
    return _company_out(org)


@router.post("/company/logo", response_model=CompanyProfileOut)
async def upload_company_logo(
    admin: AdminUser,
    request: Request,
    db: DbSession,
    file: UploadFile = File(...),
) -> CompanyProfileOut:
    """Replace the console's product mark with this company's own.

    Whatever arrives is decoded, downscaled and re-encoded as a PNG the server
    produced — the uploaded bytes are never stored and never served. See
    ``services/branding.py`` for why that is not optional.
    """
    org = _org_of(db, admin)
    # One byte past the ceiling, so an oversize upload is refused on its size
    # rather than after the whole thing has been buffered.
    raw = await file.read(branding.MAX_LOGO_BYTES + 1)
    try:
        branding.store_logo(db, org, raw)
    except branding.BrandingError as error:
        raise HTTPException(
            error.status_code, detail={"reason": error.code, "message": error.message}
        ) from error

    audit(db, org_id=org.id, actor=admin, action="org.logo_updated", request=request)
    db.commit()
    db.refresh(org)
    return _company_out(org)


@router.delete("/company/logo", response_model=CompanyProfileOut)
def delete_company_logo(
    admin: AdminUser, request: Request, db: DbSession
) -> CompanyProfileOut:
    """Back to the product mark. Clearing a logo nobody set is not an error."""
    org = _org_of(db, admin)
    had = bool(org.logo_key)
    branding.clear_logo(db, org)
    if had:
        audit(db, org_id=org.id, actor=admin, action="org.logo_cleared", request=request)
    db.commit()
    db.refresh(org)
    return _company_out(org)


@router.get("/company/logo")
def company_logo(viewer: CurrentUser, db: DbSession) -> Response:
    """The image itself, for the console chrome.

    Authenticated, like every other stored object: the permission check runs
    here on each request, which is exactly what handing out a storage key would
    have thrown away. It is a per-tenant singleton, so it needs no id in the
    path — the caller's own token says which company is being asked about, and
    there is no way to spell another one.
    """
    org = _org_of(db, viewer)
    try:
        served = branding.serve_logo(org)
    except branding.BrandingError as error:
        raise HTTPException(
            error.status_code, detail={"reason": error.code, "message": error.message}
        ) from error

    if served.url:
        # 307 keeps the method and is not cached, which matters because the URL
        # behind it expires.
        return RedirectResponse(served.url, status_code=status.HTTP_307_TEMPORARY_REDIRECT)
    return FileResponse(served.path, media_type=branding.STORED_CONTENT_TYPE)
