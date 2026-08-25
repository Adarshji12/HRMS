"""Projects, tasks, members and time attribution."""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import case, delete, func, select

from app.api.deps import (
    deny_page,
    AdminUser,
    CurrentUser,
    DbSession,
    TeamViewer,
    audit,
    deny_unless,
    visible_user_ids,
)
from app.models import (
    ActivitySegment,
    Organization,
    Project,
    ProjectMember,
    ProjectRule,
    ProjectStatus,
    Task,
    User,
)
from app.schemas.project import (
    AttributeRequest,
    MemberIn,
    MemberOut,
    ProjectIn,
    ProjectOut,
    ProjectRuleIn,
    ProjectRuleOut,
    TaskIn,
    TaskOut,
)
from app.services import attribution as attrib
from app.services import reports

router = APIRouter(prefix="/projects", tags=["projects"])

RUPEE = 100


def _get_project(db, org_id: uuid.UUID, project_id: uuid.UUID) -> Project:
    project = db.get(Project, project_id)
    if project is None or project.org_id != org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    return project


def _tracked_by_project(db, org_id: uuid.UUID) -> dict[uuid.UUID, tuple[int, int]]:
    """(total seconds, billable seconds) per project, in one query."""
    rows = db.execute(
        select(
            ActivitySegment.project_id,
            func.coalesce(func.sum(ActivitySegment.duration_s), 0),
            func.coalesce(
                func.sum(
                    case((ActivitySegment.is_billable.is_(True), ActivitySegment.duration_s),
                         else_=0)
                ),
                0,
            ),
        )
        .where(ActivitySegment.org_id == org_id, ActivitySegment.project_id.is_not(None))
        .group_by(ActivitySegment.project_id)
    )
    return {row[0]: (int(row[1]), int(row[2])) for row in rows}


def _project_out(project: Project, names: dict, counts: dict, tracked: dict) -> ProjectOut:
    total, billable = tracked.get(project.id, (0, 0))
    members, tasks, open_tasks = counts.get(project.id, (0, 0, 0))
    return ProjectOut(
        **{c.name: getattr(project, c.name) for c in Project.__table__.columns
           if c.name in ProjectOut.model_fields},
        manager_name=names.get(project.manager_user_id),
        member_count=members,
        task_count=tasks,
        open_task_count=open_tasks,
        tracked_seconds=total,
        billable_seconds=billable,
    )


# --------------------------------------------------------------------------- #
# Projects
# --------------------------------------------------------------------------- #


@router.get("", response_model=list[ProjectOut])
def list_projects(
    viewer: CurrentUser,
    db: DbSession,
    status_filter: str | None = Query(default=None, alias="status"),
    include_archived: bool = False,
) -> list[ProjectOut]:
    deny_page(viewer, "projects")
    stmt = select(Project).where(Project.org_id == viewer.org_id).order_by(Project.name)
    if status_filter:
        stmt = stmt.where(Project.status == status_filter)
    elif not include_archived:
        stmt = stmt.where(Project.status != ProjectStatus.ARCHIVED.value)

    projects = list(db.scalars(stmt).all())

    # An employee sees only the projects they are on. Project names can be
    # client names, so the full list is not public inside the company.
    if not viewer.role_enum.can_view_team:
        mine = set(
            db.scalars(
                select(ProjectMember.project_id).where(ProjectMember.user_id == viewer.id)
            ).all()
        )
        projects = [p for p in projects if p.id in mine]

    names = {
        row[0]: row[1]
        for row in db.execute(select(User.id, User.full_name).where(User.org_id == viewer.org_id))
    }
    member_counts = {
        row[0]: int(row[1])
        for row in db.execute(
            select(ProjectMember.project_id, func.count(ProjectMember.id))
            .where(ProjectMember.org_id == viewer.org_id)
            .group_by(ProjectMember.project_id)
        )
    }
    task_rows = db.execute(
        select(
            Task.project_id,
            func.count(Task.id),
            func.sum(case((Task.status != "done", 1), else_=0)),
        )
        .where(Task.org_id == viewer.org_id)
        .group_by(Task.project_id)
    )
    task_counts = {row[0]: (int(row[1]), int(row[2] or 0)) for row in task_rows}
    counts = {
        p.id: (
            member_counts.get(p.id, 0),
            task_counts.get(p.id, (0, 0))[0],
            task_counts.get(p.id, (0, 0))[1],
        )
        for p in projects
    }

    tracked = _tracked_by_project(db, viewer.org_id)
    return [_project_out(p, names, counts, tracked) for p in projects]


@router.post("", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
def create_project(
    payload: ProjectIn, admin: AdminUser, request: Request, db: DbSession
) -> ProjectOut:
    deny_unless(admin, "can_manage_projects", "manage projects")
    if payload.code:
        existing = db.scalar(
            select(Project.id).where(
                Project.org_id == admin.org_id, Project.code == payload.code.strip().upper()
            )
        )
        if existing:
            raise HTTPException(status.HTTP_409_CONFLICT, "A project with that code exists")

    data = payload.model_dump(exclude={"hourly_rate_rupees", "budget_hours"})
    project = Project(
        org_id=admin.org_id,
        **data,
        hourly_rate=round(payload.hourly_rate_rupees * RUPEE),
        budget_minutes=round(payload.budget_hours * 60),
    )
    project.name = payload.name.strip()
    if project.code:
        project.code = project.code.strip().upper()
    db.add(project)
    db.flush()

    audit(db, org_id=admin.org_id, actor=admin, action="project.created", request=request,
          target_type="project", target_id=str(project.id))
    db.commit()
    return _project_out(project, {}, {}, {})


@router.patch("/{project_id}", response_model=ProjectOut)
def update_project(
    project_id: uuid.UUID, payload: ProjectIn, admin: AdminUser, db: DbSession
) -> ProjectOut:
    deny_unless(admin, "can_manage_projects", "manage projects")
    project = _get_project(db, admin.org_id, project_id)
    for field, value in payload.model_dump(
        exclude={"hourly_rate_rupees", "budget_hours"}
    ).items():
        setattr(project, field, value)
    project.name = payload.name.strip()
    project.hourly_rate = round(payload.hourly_rate_rupees * RUPEE)
    project.budget_minutes = round(payload.budget_hours * 60)

    # Note: existing segments keep the billable flag they were recorded with.
    # Re-flagging history here would rewrite invoices already raised from it.
    db.commit()
    return _project_out(project, {}, {}, _tracked_by_project(db, admin.org_id))


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_project(project_id: uuid.UUID, admin: AdminUser, db: DbSession) -> None:
    deny_unless(admin, "can_manage_projects", "manage projects")
    project = _get_project(db, admin.org_id, project_id)
    tracked = db.scalar(
        select(func.count(ActivitySegment.id)).where(ActivitySegment.project_id == project.id)
    )
    if tracked:
        # Deleting would null out the attribution on real recorded time, which
        # silently changes past reports. Archiving keeps the history intact.
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "reason": "project_has_time",
                "message": (
                    f"{tracked} tracked entries belong to this project. "
                    f"Archive it instead so the history stays accurate."
                ),
            },
        )
    db.delete(project)
    db.commit()


# --------------------------------------------------------------------------- #
# Members
# --------------------------------------------------------------------------- #


@router.get("/{project_id}/members", response_model=list[MemberOut])
def list_members(project_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> list[MemberOut]:
    _get_project(db, viewer.org_id, project_id)
    rows = db.execute(
        select(ProjectMember, User)
        .join(User, User.id == ProjectMember.user_id)
        .where(ProjectMember.project_id == project_id)
        .order_by(User.full_name)
    ).all()
    tracked = {
        row[0]: int(row[1])
        for row in db.execute(
            select(ActivitySegment.user_id, func.coalesce(func.sum(ActivitySegment.duration_s), 0))
            .where(ActivitySegment.project_id == project_id)
            .group_by(ActivitySegment.user_id)
        )
    }
    return [
        MemberOut(
            id=member.id, user_id=user.id, full_name=user.full_name, email=user.email,
            role=member.role, hourly_rate=member.hourly_rate,
            tracked_seconds=tracked.get(user.id, 0),
        )
        for member, user in rows
    ]


@router.post("/{project_id}/members", response_model=MemberOut, status_code=status.HTTP_201_CREATED)
def add_member(
    project_id: uuid.UUID, payload: MemberIn, admin: AdminUser, db: DbSession
) -> MemberOut:
    deny_unless(admin, "can_manage_projects", "manage projects")
    _get_project(db, admin.org_id, project_id)
    user = db.get(User, payload.user_id)
    if user is None or user.org_id != admin.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Employee not found")

    existing = db.scalar(
        select(ProjectMember).where(
            ProjectMember.project_id == project_id, ProjectMember.user_id == payload.user_id
        )
    )
    if existing is not None:
        existing.role = payload.role
        existing.hourly_rate = round(payload.hourly_rate_rupees * RUPEE)
        member = existing
    else:
        member = ProjectMember(
            org_id=admin.org_id, project_id=project_id, user_id=payload.user_id,
            role=payload.role, hourly_rate=round(payload.hourly_rate_rupees * RUPEE),
        )
        db.add(member)
    db.flush()
    db.commit()
    return MemberOut(
        id=member.id, user_id=user.id, full_name=user.full_name, email=user.email,
        role=member.role, hourly_rate=member.hourly_rate,
    )


@router.delete("/{project_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT,
               response_model=None)
def remove_member(
    project_id: uuid.UUID, user_id: uuid.UUID, admin: AdminUser, db: DbSession
) -> None:
    deny_unless(admin, "can_manage_projects", "manage projects")
    _get_project(db, admin.org_id, project_id)
    # _get_project above already refused a project outside this organisation,
    # so this only has to distinguish "removed" from "was never a member".
    result = db.execute(
        delete(ProjectMember).where(
            ProjectMember.project_id == project_id, ProjectMember.user_id == user_id
        )
    )
    if result.rowcount == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That person is not a member of this project")
    db.commit()


# --------------------------------------------------------------------------- #
# Tasks
# --------------------------------------------------------------------------- #


@router.get("/{project_id}/tasks", response_model=list[TaskOut])
def list_tasks(project_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> list[TaskOut]:
    _get_project(db, viewer.org_id, project_id)
    tasks = db.scalars(
        select(Task).where(Task.project_id == project_id).order_by(Task.created_at.desc())
    ).all()
    names = {
        row[0]: row[1]
        for row in db.execute(select(User.id, User.full_name).where(User.org_id == viewer.org_id))
    }
    tracked = {
        row[0]: int(row[1])
        for row in db.execute(
            select(ActivitySegment.task_id, func.coalesce(func.sum(ActivitySegment.duration_s), 0))
            .where(ActivitySegment.project_id == project_id, ActivitySegment.task_id.is_not(None))
            .group_by(ActivitySegment.task_id)
        )
    }
    return [
        TaskOut(
            **{c.name: getattr(t, c.name) for c in Task.__table__.columns
               if c.name in TaskOut.model_fields},
            assignee_name=names.get(t.assignee_user_id),
            tracked_seconds=tracked.get(t.id, 0),
        )
        for t in tasks
    ]


@router.post("/{project_id}/tasks", response_model=TaskOut, status_code=status.HTTP_201_CREATED)
def create_task(
    project_id: uuid.UUID, payload: TaskIn, admin: TeamViewer, db: DbSession
) -> TaskOut:
    _get_project(db, admin.org_id, project_id)
    task = Task(
        org_id=admin.org_id,
        project_id=project_id,
        **payload.model_dump(exclude={"estimate_hours"}),
        estimate_minutes=round(payload.estimate_hours * 60),
    )
    task.title = payload.title.strip()
    db.add(task)
    db.flush()
    db.commit()
    return TaskOut(
        **{c.name: getattr(task, c.name) for c in Task.__table__.columns
           if c.name in TaskOut.model_fields}
    )


@router.patch("/{project_id}/tasks/{task_id}", response_model=TaskOut)
def update_task(
    project_id: uuid.UUID, task_id: uuid.UUID, payload: TaskIn, viewer: TeamViewer, db: DbSession
) -> TaskOut:
    task = db.get(Task, task_id)
    if task is None or task.org_id != viewer.org_id or task.project_id != project_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Task not found")
    for field, value in payload.model_dump(exclude={"estimate_hours"}).items():
        setattr(task, field, value)
    task.estimate_minutes = round(payload.estimate_hours * 60)
    db.commit()
    return TaskOut(
        **{c.name: getattr(task, c.name) for c in Task.__table__.columns
           if c.name in TaskOut.model_fields}
    )


# --------------------------------------------------------------------------- #
# Attribution rules and manual assignment
# --------------------------------------------------------------------------- #


@router.get("/rules/all", response_model=list[ProjectRuleOut])
def list_rules(viewer: CurrentUser, db: DbSession) -> list[ProjectRuleOut]:
    rows = db.execute(
        select(ProjectRule, Project.name)
        .join(Project, Project.id == ProjectRule.project_id)
        .where(ProjectRule.org_id == viewer.org_id)
        .order_by(ProjectRule.priority.desc(), ProjectRule.pattern)
    ).all()
    return [
        ProjectRuleOut(
            **{c.name: getattr(rule, c.name) for c in ProjectRule.__table__.columns
               if c.name in ProjectRuleOut.model_fields},
            project_name=name,
        )
        for rule, name in rows
    ]


@router.post("/rules", response_model=ProjectRuleOut, status_code=status.HTTP_201_CREATED)
def create_rule(payload: ProjectRuleIn, admin: AdminUser, db: DbSession) -> ProjectRuleOut:
    deny_unless(admin, "can_manage_projects", "manage projects")
    project = _get_project(db, admin.org_id, payload.project_id)
    pattern = payload.pattern.lower().strip().removeprefix("www.")

    existing = db.scalar(
        select(ProjectRule).where(
            ProjectRule.org_id == admin.org_id,
            ProjectRule.match_type == payload.match_type,
            ProjectRule.pattern == pattern,
        )
    )
    if existing is not None:
        existing.project_id = payload.project_id
        existing.task_id = payload.task_id
        existing.priority = payload.priority
        rule = existing
    else:
        rule = ProjectRule(
            org_id=admin.org_id, project_id=payload.project_id, task_id=payload.task_id,
            match_type=payload.match_type, pattern=pattern, priority=payload.priority,
        )
        db.add(rule)
    db.flush()
    db.commit()
    return ProjectRuleOut(
        **{c.name: getattr(rule, c.name) for c in ProjectRule.__table__.columns
           if c.name in ProjectRuleOut.model_fields},
        project_name=project.name,
    )


@router.delete("/rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_rule(rule_id: uuid.UUID, admin: AdminUser, db: DbSession) -> None:
    deny_unless(admin, "can_manage_projects", "manage projects")
    result = db.execute(
        delete(ProjectRule).where(
            ProjectRule.id == rule_id, ProjectRule.org_id == admin.org_id
        )
    )
    if result.rowcount == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Rule not found")
    db.commit()


@router.post("/attribute")
def attribute_segments(
    payload: AttributeRequest, viewer: TeamViewer, request: Request, db: DbSession
) -> dict:
    """Assign already-recorded time to a project. Always beats rules."""
    if payload.project_id is not None:
        _get_project(db, viewer.org_id, payload.project_id)

    allowed = visible_user_ids(db, viewer)
    stmt = select(ActivitySegment).where(
        ActivitySegment.org_id == viewer.org_id,
        ActivitySegment.id.in_(payload.segment_ids),
    )
    if allowed is not None:
        stmt = stmt.where(ActivitySegment.user_id.in_(allowed))
    segments = db.scalars(stmt).all()

    attributor = attrib.Attributor.for_org(db, viewer.org_id)
    for segment in segments:
        attrib.set_manual(segment, payload.project_id, payload.task_id, attributor)

    audit(db, org_id=viewer.org_id, actor=viewer, action="project.time_attributed",
          request=request, detail={"segments": len(segments),
                                  "project_id": str(payload.project_id) if payload.project_id else None})
    db.commit()
    return {
        "updated": len(segments),
        "skipped": len(payload.segment_ids) - len(segments),
    }


@router.post("/reattribute")
def reattribute(
    admin: AdminUser, db: DbSession, days: int = Query(default=30, ge=1, le=365)
) -> dict:
    """Re-run the rule engine over recent history.

    Segments attributed manually are left alone — the whole point of tracking
    ``project_source``.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    attributor = attrib.Attributor.for_org(db, admin.org_id)
    segments = db.scalars(
        select(ActivitySegment).where(
            ActivitySegment.org_id == admin.org_id, ActivitySegment.started_at >= cutoff
        )
    ).all()

    changed = 0
    for segment in segments:
        resolved = attributor.resolve(
            app_exec=segment.app_exec,
            url_domain=segment.url_domain,
            window_title=segment.window_title,
            repo_name=segment.repo_name,
        )
        if attrib.apply(segment, resolved):
            changed += 1

    db.commit()
    return {"scanned": len(segments), "changed": changed}


# --------------------------------------------------------------------------- #
# Reporting
# --------------------------------------------------------------------------- #


@router.get("/report")
def project_report(
    viewer: TeamViewer,
    db: DbSession,
    start: date | None = None,
    end: date | None = None,
) -> dict:
    """Time and cost per project for a date range."""
    deny_page(viewer, "projects")
    org = db.get(Organization, viewer.org_id)
    tz_name = org.timezone if org else "UTC"
    # Defaults resolve in the org's timezone, not the server's — the same bug
    # that made "today" empty for every non-UTC tenant.
    end = end or datetime.now(reports.tz_for(tz_name)).date()
    start = start or end - timedelta(days=29)
    if end < start:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "end is before start")
    win_start, win_end = reports.range_bounds(start, end, tz_name)

    scope = visible_user_ids(db, viewer)
    stmt = (
        select(
            ActivitySegment.project_id,
            func.coalesce(func.sum(ActivitySegment.duration_s), 0),
            func.coalesce(func.sum(ActivitySegment.active_s), 0),
            func.coalesce(
                func.sum(
                    case((ActivitySegment.is_billable.is_(True), ActivitySegment.duration_s),
                         else_=0)
                ),
                0,
            ),
        )
        .where(
            ActivitySegment.org_id == viewer.org_id,
            ActivitySegment.started_at >= win_start,
            ActivitySegment.started_at < win_end,
            ActivitySegment.project_id.is_not(None),
        )
        .group_by(ActivitySegment.project_id)
    )
    if scope is not None:
        stmt = stmt.where(ActivitySegment.user_id.in_(scope))

    projects = {
        p.id: p for p in db.scalars(select(Project).where(Project.org_id == viewer.org_id)).all()
    }

    rows = []
    for project_id, total, active, billable in db.execute(stmt):
        project = projects.get(project_id)
        if project is None:
            continue
        cost = round(billable / 3600 * project.hourly_rate)
        rows.append(
            {
                "project_id": str(project_id),
                "name": project.name,
                "code": project.code,
                "client_name": project.client_name,
                "status": project.status,
                "tracked_s": int(total),
                "active_s": int(active),
                "billable_s": int(billable),
                "non_billable_s": int(total) - int(billable),
                "budget_minutes": project.budget_minutes,
                "budget_used_pct": (
                    round(100 * (total / 60) / project.budget_minutes, 1)
                    if project.budget_minutes else None
                ),
                "hourly_rate": project.hourly_rate,
                "billable_amount": cost,
            }
        )
    rows.sort(key=lambda r: r["tracked_s"], reverse=True)

    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "timezone": tz_name,
        "projects": rows,
        "totals": {
            "tracked_s": sum(r["tracked_s"] for r in rows),
            "billable_s": sum(r["billable_s"] for r in rows),
            "billable_amount": sum(r["billable_amount"] for r in rows),
        },
    }
