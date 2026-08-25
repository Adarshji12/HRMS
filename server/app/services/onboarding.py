"""Onboarding checklists: template maintenance, instantiation, tasks, documents.

``api/v1/onboarding.py`` maps HTTP onto the functions here and holds no rules.

**The one design decision a reader would otherwise get wrong: instantiation is
a copy, and it is an explicit act.**

*A copy.* ``instantiate`` reads the template's tasks once and writes physically
duplicated rows onto the instance — title, description, category, owner role,
sort order, document requirement — and resolves ``due_offset_days`` against the
instance's own ``joining_date`` into a concrete ``due_date`` at that moment.
Nothing on a live checklist is ever read back through the template. Editing,
reordering or deleting a template task afterwards must not rewrite the
checklist of somebody already working through it: a task they ticked off last
week silently becoming a different task is the failure this module exists to
prevent, and ``source_template_task_id`` is provenance for reporting only
(``SET NULL``), never a lookup.

*An explicit act.* Creating a ``users`` row does not create a checklist. There
are deliberately two doors, and they are not the same door:

* ``create_instance`` / ``instantiate`` — the direct call. Unconditional. HR
  clicks "start onboarding" and gets a checklist, whatever the joining date is,
  including for somebody imported a fortnight ago.
* ``maybe_start_for_new_hire`` — the conditional hook, safe to call from a user
  creation path. It declines (returns ``None``) unless the hire has a joining
  date of today or later, has no open instance already, and a template actually
  matches them.

Wiring instantiation into user creation as an unavoidable side effect was
rejected in Phase 0 and the reason still holds: the first thing a new tenant
does is bulk-import its existing staff, every one of them with a historical
joining date, and a side effect would spawn two hundred checklists of overdue
tasks for people who have worked there for years. The date guard alone is not
enough either, because it removes HR's ability to start one by hand for a hire
imported last week. So the guard lives in the hook and the door beside it stays
unguarded.

**Documents never touch the database.** Bytes go to ``services/storage.py``
under the key convention it already mints for screenshots, and ``storage_key``
is never serialised into any response — clients get a permission-checked
download endpoint, exactly as screenshots do. A key handed to a client is a
capability it can replay, and one whose neighbours it can enumerate.

Nothing here imports the assets module. ``it_setup`` is a string literal that
Assets keys off from its own side; the dependency runs one way only.
"""

from __future__ import annotations

import re
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import PurePosixPath

from fastapi import HTTPException, Request
from fastapi import status as http_status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.api.deps import audit, deny_unless
from app.models import (
    Department,
    OnboardingDocument,
    OnboardingInstance,
    OnboardingInstanceStatus,
    OnboardingTask,
    OnboardingTaskStatus,
    OnboardingTemplate,
    OnboardingTemplateTask,
    User,
    UserStatus,
)
from app.models.onboarding import CATEGORY_ORDER
from app.schemas.onboarding import (
    OnboardingDocumentOut,
    OnboardingDocumentVerifyIn,
    OnboardingInstanceDetailOut,
    OnboardingInstanceIn,
    OnboardingInstanceOut,
    OnboardingInstanceUpdateIn,
    OnboardingTaskGroupOut,
    OnboardingTaskIn,
    OnboardingTaskOut,
    OnboardingTaskStatusIn,
    OnboardingTemplateDetailOut,
    OnboardingTemplateIn,
    OnboardingTemplateOut,
    OnboardingTemplateTaskIn,
    OnboardingTemplateTaskOut,
)
from app.services import leave as leave_svc
from app.services import corehr, storage

MANAGE = "manage onboarding"

#: Upload ceiling for a collected document. A module constant rather than a new
#: setting because ``core/config.py`` is the integration seam and a new env var
#: for one module's file size is not worth widening it; 15 MB comfortably holds
#: a scanned multi-page contract while still refusing somebody's holiday video.
MAX_DOCUMENT_BYTES = 15 * 1024 * 1024

#: Extensions we are willing to put on a storage key. The key is opaque and the
#: suffix is cosmetic — the backend never executes anything and
#: ``LocalBackend._abs`` already refuses a key that escapes the root — but an
#: unfiltered, caller-chosen suffix ends up in filesystem paths, so it is
#: whitelisted rather than trusted.
_SAFE_SUFFIX = re.compile(r"^\.[A-Za-z0-9]{1,8}$")


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------- #
# Lookups. Every one of these filters on org_id; none of them trust an id alone.
# --------------------------------------------------------------------------- #


def get_template(db: Session, org_id: uuid.UUID, template_id: uuid.UUID) -> OnboardingTemplate:
    """404 rather than 403 on a cross-tenant miss.

    A 403 would confirm the id exists somewhere, which is itself a disclosure
    across a tenant boundary. Same posture as ``_get_project``.
    """
    row = db.get(OnboardingTemplate, template_id)
    if row is None or row.org_id != org_id:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Onboarding template not found")
    return row


def get_instance(db: Session, org_id: uuid.UUID, instance_id: uuid.UUID) -> OnboardingInstance:
    row = db.get(OnboardingInstance, instance_id)
    if row is None or row.org_id != org_id:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Onboarding checklist not found")
    return row


def get_task(db: Session, org_id: uuid.UUID, task_id: uuid.UUID) -> OnboardingTask:
    row = db.get(OnboardingTask, task_id)
    if row is None or row.org_id != org_id:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Onboarding task not found")
    return row


def get_document(db: Session, org_id: uuid.UUID, document_id: uuid.UUID) -> OnboardingDocument:
    row = db.get(OnboardingDocument, document_id)
    if row is None or row.org_id != org_id:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Document not found")
    return row


def _get_user(db: Session, org_id: uuid.UUID, user_id: uuid.UUID) -> User:
    user = db.get(User, user_id)
    if user is None or user.org_id != org_id:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Employee not found")
    return user


def _names(db: Session, org_id: uuid.UUID, ids) -> dict[uuid.UUID, str]:
    """``{user_id: full_name}`` for a set of ids, in one query.

    Every ``*_name`` display field on the schemas resolves through this. A
    checklist of forty tasks with per-row assignee lookups is forty queries on
    a page that is always opened.
    """
    wanted = {i for i in ids if i is not None}
    if not wanted:
        return {}
    rows = db.execute(
        select(User.id, User.full_name).where(User.org_id == org_id, User.id.in_(wanted))
    ).all()
    return {row[0]: row[1] for row in rows}


# --------------------------------------------------------------------------- #
# Serialisation
# --------------------------------------------------------------------------- #


def _template_task_out(row: OnboardingTemplateTask) -> OnboardingTemplateTaskOut:
    return OnboardingTemplateTaskOut(
        id=row.id,
        template_id=row.template_id,
        title=row.title,
        description=row.description,
        category=row.category,
        owner_role=row.owner_role,
        due_offset_days=row.due_offset_days,
        sort_order=row.sort_order,
        requires_document=row.requires_document,
        doc_type=row.doc_type,
    )


def _template_out(
    row: OnboardingTemplate,
    *,
    department_name: str | None,
    task_count: int,
    instance_count: int,
) -> OnboardingTemplateOut:
    return OnboardingTemplateOut(
        id=row.id,
        name=row.name,
        description=row.description,
        department_id=row.department_id,
        is_active=row.is_active,
        created_at=row.created_at,
        department_name=department_name,
        task_count=task_count,
        instance_count=instance_count,
    )


def _task_out(
    row: OnboardingTask,
    *,
    today: date,
    names: dict[uuid.UUID, str],
    document_count: int = 0,
) -> OnboardingTaskOut:
    return OnboardingTaskOut(
        id=row.id,
        instance_id=row.instance_id,
        title=row.title,
        description=row.description,
        category=row.category,
        owner_role=row.owner_role,
        sort_order=row.sort_order,
        due_date=row.due_date,
        status=row.status,
        assignee_user_id=row.assignee_user_id,
        completed_by=row.completed_by,
        completed_at=row.completed_at,
        notes=row.notes,
        requires_document=row.requires_document,
        doc_type=row.doc_type,
        created_at=row.created_at,
        assignee_name=names.get(row.assignee_user_id) if row.assignee_user_id else None,
        completed_by_name=names.get(row.completed_by) if row.completed_by else None,
        # Computed against the org's local today, passed in by the caller. The
        # model refuses to guess a timezone and so does this.
        is_overdue=row.is_overdue(today),
        document_count=document_count,
    )


def _document_out(
    row: OnboardingDocument, *, names: dict[uuid.UUID, str]
) -> OnboardingDocumentOut:
    """Built field by explicit field, never a ``**model_dump()`` splat.

    ``storage_key`` is a column on the row and is deliberately absent from the
    schema. A splat, or a ``model_validate(row)`` against a schema that later
    gained the field, would put an internal storage handle in a response body
    and nobody would notice until it was replayed. Listing the fields means the
    key can only leak if somebody types it.
    """
    return OnboardingDocumentOut(
        id=row.id,
        instance_id=row.instance_id,
        task_id=row.task_id,
        doc_type=row.doc_type,
        file_name=row.file_name,
        content_type=row.content_type,
        file_size=row.file_size,
        uploaded_by=row.uploaded_by,
        verified_by=row.verified_by,
        verified_at=row.verified_at,
        verification_note=row.verification_note,
        created_at=row.created_at,
        uploaded_by_name=names.get(row.uploaded_by) if row.uploaded_by else None,
        verified_by_name=names.get(row.verified_by) if row.verified_by else None,
        is_verified=row.is_verified,
    )


def _counts(tasks: list[OnboardingTask], today: date) -> dict[str, int]:
    return {
        "total_tasks": len(tasks),
        # DONE only. A skip is a legitimate ending but it is not work done, and
        # counting it as such would let a checklist read 100% complete when
        # every item on it was waved through.
        "completed_tasks": sum(1 for t in tasks if t.status_enum is OnboardingTaskStatus.DONE),
        "closed_tasks": sum(1 for t in tasks if t.status_enum.is_closed),
        "overdue_tasks": sum(1 for t in tasks if t.is_overdue(today)),
    }


def _instance_out(
    row: OnboardingInstance,
    *,
    today: date,
    user: User | None,
    manager_name: str | None,
    tasks: list[OnboardingTask],
    docs_pending: int,
) -> OnboardingInstanceOut:
    return OnboardingInstanceOut(
        id=row.id,
        user_id=row.user_id,
        template_id=row.template_id,
        template_name=row.template_name,
        joining_date=row.joining_date,
        status=row.status,
        started_at=row.started_at,
        completed_at=row.completed_at,
        notes=row.notes,
        created_at=row.created_at,
        user_name=user.full_name if user else None,
        user_email=user.email if user else None,
        department_name=user.department_name if user else None,
        designation_name=user.designation_name if user else None,
        manager_name=manager_name,
        documents_pending_verification=docs_pending,
        **_counts(tasks, today),
    )


def _grouped(
    tasks: list[OnboardingTask],
    today: date,
    names: dict[uuid.UUID, str],
    doc_counts: dict[uuid.UUID, int],
) -> list[OnboardingTaskGroupOut]:
    """Tasks bucketed by category in ``CATEGORY_ORDER``.

    A list of groups rather than a dict, because JSON objects carry no ordering
    guarantee and the console renders these sections in a fixed order. Empty
    categories are omitted: a checklist with no compliance items should not
    render an empty "Compliance" heading.
    """
    buckets: dict[str, list[OnboardingTask]] = {}
    for task in tasks:
        buckets.setdefault(task.category, []).append(task)

    # A category not in CATEGORY_ORDER (a value written before an enum member
    # was retired, say) still renders, at the end, rather than vanishing.
    ordered = [c for c in CATEGORY_ORDER if c in buckets]
    ordered += sorted(c for c in buckets if c not in CATEGORY_ORDER)

    groups: list[OnboardingTaskGroupOut] = []
    for category in ordered:
        rows = sorted(buckets[category], key=lambda t: (t.sort_order, t.created_at))
        groups.append(
            OnboardingTaskGroupOut(
                category=category,
                tasks=[
                    _task_out(
                        t, today=today, names=names, document_count=doc_counts.get(t.id, 0)
                    )
                    for t in rows
                ],
                total=len(rows),
                completed=sum(1 for t in rows if t.status_enum is OnboardingTaskStatus.DONE),
                overdue=sum(1 for t in rows if t.is_overdue(today)),
            )
        )
    return groups


# --------------------------------------------------------------------------- #
# Templates
# --------------------------------------------------------------------------- #


def list_templates(
    db: Session, org_id: uuid.UUID, *, include_inactive: bool = True
) -> list[OnboardingTemplateOut]:
    stmt = select(OnboardingTemplate).where(OnboardingTemplate.org_id == org_id)
    if not include_inactive:
        stmt = stmt.where(OnboardingTemplate.is_active.is_(True))
    rows = list(db.scalars(stmt.order_by(OnboardingTemplate.name)).all())
    if not rows:
        return []
    ids = [r.id for r in rows]

    # Three aggregate queries for the whole page rather than three per row.
    task_counts = dict(
        db.execute(
            select(OnboardingTemplateTask.template_id, func.count())
            .where(
                OnboardingTemplateTask.org_id == org_id,
                OnboardingTemplateTask.template_id.in_(ids),
            )
            .group_by(OnboardingTemplateTask.template_id)
        ).all()
    )
    instance_counts = dict(
        db.execute(
            select(OnboardingInstance.template_id, func.count())
            .where(
                OnboardingInstance.org_id == org_id,
                OnboardingInstance.template_id.in_(ids),
            )
            .group_by(OnboardingInstance.template_id)
        ).all()
    )
    dept_ids = {r.department_id for r in rows if r.department_id}
    dept_names: dict[uuid.UUID, str] = {}
    if dept_ids:
        dept_names = {
            row[0]: row[1]
            for row in db.execute(
                select(Department.id, Department.name).where(
                    Department.org_id == org_id, Department.id.in_(dept_ids)
                )
            ).all()
        }

    return [
        _template_out(
            r,
            department_name=dept_names.get(r.department_id) if r.department_id else None,
            task_count=int(task_counts.get(r.id, 0)),
            instance_count=int(instance_counts.get(r.id, 0)),
        )
        for r in rows
    ]


def _template_tasks(
    db: Session, org_id: uuid.UUID, template_id: uuid.UUID
) -> list[OnboardingTemplateTask]:
    return list(
        db.scalars(
            select(OnboardingTemplateTask)
            .where(
                OnboardingTemplateTask.org_id == org_id,
                OnboardingTemplateTask.template_id == template_id,
            )
            .order_by(OnboardingTemplateTask.sort_order, OnboardingTemplateTask.created_at)
        ).all()
    )


def template_detail(
    db: Session, org_id: uuid.UUID, template_id: uuid.UUID
) -> OnboardingTemplateDetailOut:
    row = get_template(db, org_id, template_id)
    dept_name = None
    if row.department_id:
        dept = db.get(Department, row.department_id)
        dept_name = dept.name if dept and dept.org_id == org_id else None
    tasks = _template_tasks(db, org_id, row.id)
    instance_count = int(
        db.scalar(
            select(func.count())
            .select_from(OnboardingInstance)
            .where(
                OnboardingInstance.org_id == org_id,
                OnboardingInstance.template_id == row.id,
            )
        )
        or 0
    )
    return OnboardingTemplateDetailOut(
        **_template_out(
            row,
            department_name=dept_name,
            task_count=len(tasks),
            instance_count=instance_count,
        ).model_dump(),
        tasks=[_template_task_out(t) for t in tasks],
    )


def _write_template_tasks(
    db: Session, template: OnboardingTemplate, payloads: list[OnboardingTemplateTaskIn]
) -> None:
    """Replace a template's blueprint rows wholesale.

    Delete-and-recreate rather than a diff, and this is safe *only* because of
    the copy rule: no live checklist reads through these rows, so destroying
    them cannot disturb a hire mid-onboarding. The single casualty is
    ``OnboardingTask.source_template_task_id``, which goes NULL — provenance
    for template-effectiveness reporting, nothing user-visible. A diff would
    buy back that reporting link at the cost of matching rows by title, which
    is wrong the first time a task is renamed.
    """
    for existing in _template_tasks(db, template.org_id, template.id):
        db.delete(existing)
    db.flush()
    for index, item in enumerate(payloads):
        db.add(
            OnboardingTemplateTask(
                org_id=template.org_id,
                template_id=template.id,
                title=item.title.strip(),
                description=item.description,
                category=item.category,
                owner_role=item.owner_role,
                due_offset_days=item.due_offset_days,
                # The client's own ordering wins when it sends one; the
                # enumerate fallback keeps a payload that left every sort_order
                # at its default from collapsing into an arbitrary order.
                sort_order=item.sort_order or index,
                requires_document=item.requires_document,
                doc_type=(item.doc_type or None),
            )
        )
    db.flush()


def create_template(
    db: Session,
    org_id: uuid.UUID,
    payload: OnboardingTemplateIn,
    *,
    actor: User,
    request: Request | None = None,
) -> OnboardingTemplateDetailOut:
    name = payload.name.strip()
    # Checked here for the readable message; uq_onboarding_template_org_name is
    # what actually decides.
    if db.scalar(
        select(OnboardingTemplate.id).where(
            OnboardingTemplate.org_id == org_id, OnboardingTemplate.name == name
        )
    ):
        raise HTTPException(
            http_status.HTTP_409_CONFLICT, f"A template named {name} already exists"
        )
    if payload.department_id is not None:
        dept = db.get(Department, payload.department_id)
        if dept is None or dept.org_id != org_id:
            raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Department not found")

    template = OnboardingTemplate(
        org_id=org_id,
        name=name,
        description=payload.description,
        department_id=payload.department_id,
        is_active=payload.is_active,
    )
    db.add(template)
    db.flush()
    _write_template_tasks(db, template, payload.tasks or [])

    audit(db, org_id=org_id, actor=actor, action="onboarding.template.created",
          request=request, target_type="onboarding_template", target_id=str(template.id),
          detail={"name": name, "task_count": len(payload.tasks or [])})
    db.commit()
    return template_detail(db, org_id, template.id)


def update_template(
    db: Session,
    org_id: uuid.UUID,
    template_id: uuid.UUID,
    payload: OnboardingTemplateIn,
    *,
    actor: User,
    request: Request | None = None,
) -> OnboardingTemplateDetailOut:
    """Edit a blueprint. In-flight checklists are untouched, by construction.

    There is deliberately no code here that reaches into ``onboarding_tasks``.
    That is not an omission — it is the guarantee. Renaming a task, reordering
    the list, moving an offset or deleting a row changes what the *next* hire
    gets and nothing about the hires already running.
    """
    template = get_template(db, org_id, template_id)
    name = payload.name.strip()
    clash = db.scalar(
        select(OnboardingTemplate.id).where(
            OnboardingTemplate.org_id == org_id,
            OnboardingTemplate.name == name,
            OnboardingTemplate.id != template.id,
        )
    )
    if clash:
        raise HTTPException(
            http_status.HTTP_409_CONFLICT, f"A template named {name} already exists"
        )
    if payload.department_id is not None:
        dept = db.get(Department, payload.department_id)
        if dept is None or dept.org_id != org_id:
            raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Department not found")

    template.name = name
    template.description = payload.description
    template.department_id = payload.department_id
    template.is_active = payload.is_active
    # None means "leave the tasks alone" — an is_active toggle from the list
    # screen sends no tasks and must not wipe the checklist. An empty list is a
    # different instruction and really does mean "this template has no tasks".
    if payload.tasks is not None:
        _write_template_tasks(db, template, payload.tasks)

    audit(db, org_id=org_id, actor=actor, action="onboarding.template.updated",
          request=request, target_type="onboarding_template", target_id=str(template.id),
          detail={"name": name, "tasks_replaced": payload.tasks is not None})
    db.commit()
    return template_detail(db, org_id, template.id)


def delete_template(
    db: Session,
    org_id: uuid.UUID,
    template_id: uuid.UUID,
    *,
    actor: User,
    request: Request | None = None,
) -> None:
    """Delete outright, even with instances cut from it.

    ``onboarding_instances.template_id`` is ``SET NULL`` and the instance
    snapshotted ``template_name`` at creation, so "which checklist did this
    person get" still answers after the blueprint is gone. Refusing the delete
    instead would leave an admin unable to clear out a template built by
    mistake for the rest of the tenancy's life.
    """
    template = get_template(db, org_id, template_id)
    name = template.name
    db.delete(template)
    audit(db, org_id=org_id, actor=actor, action="onboarding.template.deleted",
          request=request, target_type="onboarding_template", target_id=str(template_id),
          detail={"name": name})
    db.commit()


# --------------------------------------------------------------------------- #
# Choosing a template, and finding a live checklist
# --------------------------------------------------------------------------- #


def pick_template(
    db: Session, org_id: uuid.UUID, department_id: uuid.UUID | None
) -> OnboardingTemplate | None:
    """The department's active template, else the org-wide one, else nothing.

    ``department_id IS NULL`` on a template means "every department" — the
    fallback, not "unassigned" — so this two-step search is the whole selection
    rule. Inactive templates are skipped rather than deleted, which is what
    makes retiring one safe.
    """
    if department_id is not None:
        specific = db.scalar(
            select(OnboardingTemplate)
            .where(
                OnboardingTemplate.org_id == org_id,
                OnboardingTemplate.department_id == department_id,
                OnboardingTemplate.is_active.is_(True),
            )
            .order_by(OnboardingTemplate.created_at)
        )
        if specific is not None:
            return specific
    return db.scalar(
        select(OnboardingTemplate)
        .where(
            OnboardingTemplate.org_id == org_id,
            OnboardingTemplate.department_id.is_(None),
            OnboardingTemplate.is_active.is_(True),
        )
        .order_by(OnboardingTemplate.created_at)
    )


def open_instance_for(
    db: Session, org_id: uuid.UUID, user_id: uuid.UUID
) -> OnboardingInstance | None:
    """The hire's live checklist, if they have one.

    "At most one open instance per person" is service discipline, not a
    constraint: a rehire is a legitimate second instance, so the schema cannot
    forbid a second row, and a partial unique index on status is not portable
    to the SQLite deployments this product also runs on.
    """
    return db.scalar(
        select(OnboardingInstance)
        .where(
            OnboardingInstance.org_id == org_id,
            OnboardingInstance.user_id == user_id,
            OnboardingInstance.status.in_(
                [
                    OnboardingInstanceStatus.PENDING_SETUP.value,
                    OnboardingInstanceStatus.IN_PROGRESS.value,
                ]
            ),
        )
        .order_by(OnboardingInstance.created_at.desc())
    )


# --------------------------------------------------------------------------- #
# Instantiation — the centre of the module
# --------------------------------------------------------------------------- #


def _is_pre_login(user: User) -> bool:
    """True when this hire cannot authenticate yet.

    Reads ``password_hash`` and ``is_active`` — the things that actually decide
    a login — and treats ``users.status`` as a corroborating hint only, never
    the other way round. Per D-016 ``is_active`` is the sole authentication
    gate and ``status`` is descriptive workflow state; a module that inferred
    "may log in" from ``status`` would be the second switch that decision says
    must not exist. Nothing here is ever consulted by the login path — this
    only decides which *label* a fresh checklist is born with.
    """
    return (
        not user.is_active
        or user.password_hash is None
        or user.status == UserStatus.PENDING_SETUP.value
    )


def instantiate(
    db: Session,
    org_id: uuid.UUID,
    *,
    user: User,
    template: OnboardingTemplate | None,
    joining_date: date,
    notes: str | None = None,
    actor: User | None = None,
    request: Request | None = None,
) -> OnboardingInstance:
    """Cut a checklist from a template. Copies, never references.

    Every field the instance task needs is read off the template row and
    written onto a new row, and ``due_offset_days`` is resolved here — once —
    against this instance's ``joining_date``. After this function returns the
    template could be deleted and the checklist would be unaffected.

    Flushes but does not commit: the caller owns the transaction, because the
    hook path wants the checklist and the user row to land together or not at
    all.
    """
    instance = OnboardingInstance(
        org_id=org_id,
        user_id=user.id,
        template_id=template.id if template else None,
        # Snapshotted, so "which checklist did this person get" survives a
        # rename or a delete of the blueprint.
        template_name=template.name if template else None,
        joining_date=joining_date,
        status=(
            OnboardingInstanceStatus.PENDING_SETUP.value
            if _is_pre_login(user)
            else OnboardingInstanceStatus.IN_PROGRESS.value
        ),
        notes=notes,
    )
    db.add(instance)
    db.flush()

    if template is not None:
        for src in _template_tasks(db, org_id, template.id):
            db.add(
                OnboardingTask(
                    org_id=org_id,
                    instance_id=instance.id,
                    # Provenance for template-effectiveness reporting. Nothing
                    # user-visible is resolved through it.
                    source_template_task_id=src.id,
                    title=src.title,
                    description=src.description,
                    category=src.category,
                    owner_role=src.owner_role,
                    sort_order=src.sort_order,
                    requires_document=src.requires_document,
                    doc_type=src.doc_type,
                    # The offset becomes a date here and never again. Editing
                    # the template's offset afterwards cannot move it.
                    due_date=joining_date + timedelta(days=src.due_offset_days),
                    status=OnboardingTaskStatus.PENDING.value,
                )
            )
        db.flush()

    audit(db, org_id=org_id, actor=actor, action="onboarding.instance.created",
          request=request, target_type="onboarding_instance", target_id=str(instance.id),
          detail={
              "user_id": str(user.id),
              "template_id": str(template.id) if template else None,
              "joining_date": joining_date,
          })
    return instance


def create_instance(
    db: Session,
    org_id: uuid.UUID,
    payload: OnboardingInstanceIn,
    *,
    actor: User,
    request: Request | None = None,
) -> OnboardingInstanceDetailOut:
    """The direct call: start a checklist by hand, whatever the joining date.

    Deliberately unguarded on the date. HR imported somebody a fortnight ago
    and now wants their checklist — refusing that is how a "safe" auto-spawn
    rule ends up blocking the manual path it was never meant to touch. The
    date guard lives in ``maybe_start_for_new_hire``, and only there.
    """
    user = _get_user(db, org_id, payload.user_id)

    existing = open_instance_for(db, org_id, user.id)
    if existing is not None:
        raise HTTPException(
            http_status.HTTP_409_CONFLICT,
            detail={
                "reason": "onboarding_already_open",
                "message": (
                    f"{user.full_name} already has an onboarding checklist in progress."
                ),
                "instance_id": str(existing.id),
            },
        )

    if payload.template_id is not None:
        template: OnboardingTemplate | None = get_template(db, org_id, payload.template_id)
    else:
        template = pick_template(db, org_id, user.department_id)

    # The instance's own anchor from here on. Copied rather than read through
    # users.joined_on, so moving a hire's start date is an explicit reschedule
    # of the checklist rather than a silent re-dating of tasks people already
    # completed.
    joining_date = payload.joining_date or user.joined_on or leave_svc.org_today(db, org_id)
    instance = instantiate(
        db,
        org_id,
        user=user,
        template=template,
        joining_date=joining_date,
        notes=payload.notes,
        actor=actor,
        request=request,
    )
    db.commit()
    return instance_detail(db, org_id, instance.id)


def maybe_start_for_new_hire(
    db: Session,
    user: User,
    *,
    actor: User | None = None,
    request: Request | None = None,
) -> OnboardingInstance | None:
    """The conditional hook. Returns ``None`` far more often than it fires.

    Safe to call from a user-creation path *because* it declines: it fires only
    for a hire joining today or later, with no open checklist already, and only
    when a template actually matches them. A bulk import of two hundred
    existing staff carries two hundred historical joining dates and produces
    zero checklists.

    It does not commit — it is meant to run inside the caller's transaction so
    the hire and their checklist land together or not at all.
    """
    if user.joined_on is None:
        # No joining date is the bulk-import signature, and there would be
        # nothing to resolve the due dates against anyway.
        return None
    if user.joined_on < leave_svc.org_today(db, user.org_id):
        return None
    if open_instance_for(db, user.org_id, user.id) is not None:
        return None
    template = pick_template(db, user.org_id, user.department_id)
    if template is None:
        # No blueprint means an empty checklist, which is worse than no
        # checklist: it shows up in the HR pipeline as a hire with nothing to
        # do and no way to tell that apart from a finished one.
        return None
    return instantiate(
        db,
        user.org_id,
        user=user,
        template=template,
        joining_date=user.joined_on,
        actor=actor,
        request=request,
    )


# --------------------------------------------------------------------------- #
# Instances — pipeline and detail
# --------------------------------------------------------------------------- #


def _instance_tasks(
    db: Session, org_id: uuid.UUID, instance_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[OnboardingTask]]:
    if not instance_ids:
        return {}
    rows = db.scalars(
        select(OnboardingTask)
        .where(OnboardingTask.org_id == org_id, OnboardingTask.instance_id.in_(instance_ids))
        .order_by(OnboardingTask.sort_order, OnboardingTask.created_at)
    ).all()
    out: dict[uuid.UUID, list[OnboardingTask]] = {i: [] for i in instance_ids}
    for row in rows:
        out.setdefault(row.instance_id, []).append(row)
    return out


def list_instances(
    db: Session,
    org_id: uuid.UUID,
    *,
    status_filter: str | None = None,
    user_id: uuid.UUID | None = None,
    include_closed: bool = False,
) -> list[OnboardingInstanceOut]:
    """The HR pipeline: open checklists, soonest joiners first.

    Counts are gathered for the whole page in three queries rather than per
    row. This is the view HR leaves open all day.
    """
    stmt = select(OnboardingInstance).where(OnboardingInstance.org_id == org_id)
    if status_filter:
        stmt = stmt.where(OnboardingInstance.status == status_filter)
    elif not include_closed:
        stmt = stmt.where(
            OnboardingInstance.status.in_(
                [
                    OnboardingInstanceStatus.PENDING_SETUP.value,
                    OnboardingInstanceStatus.IN_PROGRESS.value,
                ]
            )
        )
    if user_id is not None:
        stmt = stmt.where(OnboardingInstance.user_id == user_id)

    rows = list(
        db.scalars(
            stmt.options(
                selectinload(OnboardingInstance.user).selectinload(User.department),
                selectinload(OnboardingInstance.user).selectinload(User.designation),
            ).order_by(OnboardingInstance.joining_date, OnboardingInstance.created_at)
        ).all()
    )
    if not rows:
        return []

    today = leave_svc.org_today(db, org_id)
    ids = [r.id for r in rows]
    tasks_by_instance = _instance_tasks(db, org_id, ids)
    pending_docs = dict(
        db.execute(
            select(OnboardingDocument.instance_id, func.count())
            .where(
                OnboardingDocument.org_id == org_id,
                OnboardingDocument.instance_id.in_(ids),
                OnboardingDocument.verified_at.is_(None),
            )
            .group_by(OnboardingDocument.instance_id)
        ).all()
    )
    manager_names = _names(db, org_id, [r.user.manager_id for r in rows if r.user is not None])

    return [
        _instance_out(
            r,
            today=today,
            user=r.user,
            manager_name=(
                manager_names.get(r.user.manager_id)
                if r.user is not None and r.user.manager_id
                else None
            ),
            tasks=tasks_by_instance.get(r.id, []),
            docs_pending=int(pending_docs.get(r.id, 0)),
        )
        for r in rows
    ]


def instance_detail(
    db: Session, org_id: uuid.UUID, instance_id: uuid.UUID
) -> OnboardingInstanceDetailOut:
    """One hire's whole checklist in a single response — tasks and documents.

    Everything the per-hire page needs, because anything less is an N+1 against
    a page that is always opened straight from the pipeline.
    """
    instance = get_instance(db, org_id, instance_id)
    today = leave_svc.org_today(db, org_id)
    tasks = _instance_tasks(db, org_id, [instance.id]).get(instance.id, [])
    documents = list(
        db.scalars(
            select(OnboardingDocument)
            .where(
                OnboardingDocument.org_id == org_id,
                OnboardingDocument.instance_id == instance.id,
            )
            .order_by(OnboardingDocument.created_at)
        ).all()
    )

    doc_counts: dict[uuid.UUID, int] = {}
    for doc in documents:
        if doc.task_id is not None:
            doc_counts[doc.task_id] = doc_counts.get(doc.task_id, 0) + 1

    user = db.get(User, instance.user_id)
    names = _names(
        db,
        org_id,
        [t.assignee_user_id for t in tasks]
        + [t.completed_by for t in tasks]
        + [d.uploaded_by for d in documents]
        + [d.verified_by for d in documents]
        + [user.manager_id if user else None],
    )

    summary = _instance_out(
        instance,
        today=today,
        user=user,
        manager_name=names.get(user.manager_id) if user and user.manager_id else None,
        tasks=tasks,
        docs_pending=sum(1 for d in documents if d.verified_at is None),
    )
    return OnboardingInstanceDetailOut(
        **summary.model_dump(),
        groups=_grouped(tasks, today, names, doc_counts),
        documents=[_document_out(d, names=names) for d in documents],
    )


def update_instance(
    db: Session,
    org_id: uuid.UUID,
    instance_id: uuid.UUID,
    payload: OnboardingInstanceUpdateIn,
    *,
    actor: User,
    request: Request | None = None,
) -> OnboardingInstanceDetailOut:
    """Reschedule, annotate, or move the checklist's own status.

    Moving ``joining_date`` shifts every **open** task by the same delta.
    Closed tasks keep their dates on purpose: a completed task's due date is
    part of the record of what happened, and re-dating it would rewrite history
    to match a plan that changed afterwards.
    """
    instance = get_instance(db, org_id, instance_id)
    detail: dict = {}

    if payload.joining_date is not None and payload.joining_date != instance.joining_date:
        delta = payload.joining_date - instance.joining_date
        detail["joining_date"] = {"from": instance.joining_date, "to": payload.joining_date}
        instance.joining_date = payload.joining_date
        for task in _instance_tasks(db, org_id, [instance.id]).get(instance.id, []):
            if task.due_date is not None and not task.status_enum.is_closed:
                task.due_date = task.due_date + delta

    if payload.notes is not None:
        instance.notes = payload.notes

    if payload.status is not None and payload.status != instance.status:
        detail["status"] = {"from": instance.status, "to": payload.status}
        instance.status = payload.status
        if payload.status == OnboardingInstanceStatus.COMPLETED.value:
            instance.completed_at = instance.completed_at or _now()
            _on_completed(db, instance, actor=actor)
        else:
            # Re-opening or cancelling a checklist must clear the completion
            # stamp, or "time to onboard" reporting reads a finish that was
            # undone.
            instance.completed_at = None

    audit(db, org_id=org_id, actor=actor, action="onboarding.instance.updated",
          request=request, target_type="onboarding_instance", target_id=str(instance.id),
          detail=detail)
    db.commit()
    return instance_detail(db, org_id, instance.id)


# --------------------------------------------------------------------------- #
# Tasks
# --------------------------------------------------------------------------- #


def _on_completed(db: Session, instance: OnboardingInstance, *, actor: User | None = None) -> None:
    """Everything that happens *because* a checklist finished.

    One function, called from both places a checklist can reach COMPLETED — the
    explicit status update and the roll-up in ``_resync_instance`` when the last
    task closes. Two copies would mean the common path (ticking the final task)
    behaved differently from the rare one (an administrator setting the status
    by hand), and it would be the common path nobody thought to test.

    Guarded by the caller on the *transition*, not the state, so re-saving a
    checklist that was already complete does not fire it again.

    ``actor`` is optional because ``_resync_instance`` is called from task
    mutations that do not thread one through; the instance's own user stands in
    so the audit row still names somebody. The alternative — no audit row at all
    on the common path — is worse.
    """
    subject = db.get(User, instance.user_id)
    if subject is None:  # pragma: no cover - FK makes this all but impossible
        return
    corehr.start_probation(
        db,
        subject=subject,
        actor=actor or subject,
        joined_on=instance.joining_date,
    )


def _resync_instance(db: Session, instance: OnboardingInstance) -> None:
    """Roll the checklist's own status up from its tasks.

    Called after every task mutation. ``CANCELLED`` is terminal and is left
    alone: an administrator who abandoned a checklist must not have it silently
    resurrected because somebody ticked a leftover task.
    """
    if instance.status_enum is OnboardingInstanceStatus.CANCELLED:
        return
    tasks = _instance_tasks(db, instance.org_id, [instance.id]).get(instance.id, [])
    if not tasks:
        return

    any_started = any(t.status_enum is not OnboardingTaskStatus.PENDING for t in tasks)
    all_closed = all(t.status_enum.is_closed for t in tasks)

    if any_started and instance.started_at is None:
        instance.started_at = _now()
    if all_closed:
        was_complete = instance.status == OnboardingInstanceStatus.COMPLETED.value
        instance.status = OnboardingInstanceStatus.COMPLETED.value
        instance.completed_at = instance.completed_at or _now()
        if not was_complete:
            _on_completed(db, instance)
    else:
        instance.completed_at = None
        if any_started or instance.status == OnboardingInstanceStatus.COMPLETED.value:
            # A checklist that was completed and then reopened falls back to
            # in_progress rather than pending_setup: work demonstrably began.
            instance.status = OnboardingInstanceStatus.IN_PROGRESS.value


def add_task(
    db: Session,
    org_id: uuid.UUID,
    instance_id: uuid.UUID,
    payload: OnboardingTaskIn,
    *,
    actor: User,
    request: Request | None = None,
) -> OnboardingTaskOut:
    """Add an ad-hoc item to one live checklist.

    No ``source_template_task_id``: this row came from a person, not a
    blueprint. It carries a concrete ``due_date`` because by now the joining
    date is known, and there is deliberately no way to send an offset here.
    """
    instance = get_instance(db, org_id, instance_id)
    if payload.assignee_user_id is not None:
        _get_user(db, org_id, payload.assignee_user_id)

    task = OnboardingTask(
        org_id=org_id,
        instance_id=instance.id,
        title=payload.title.strip(),
        description=payload.description,
        category=payload.category,
        owner_role=payload.owner_role,
        sort_order=payload.sort_order,
        due_date=payload.due_date,
        assignee_user_id=payload.assignee_user_id,
        requires_document=payload.requires_document,
        doc_type=(payload.doc_type or None),
        status=OnboardingTaskStatus.PENDING.value,
    )
    db.add(task)
    db.flush()
    _resync_instance(db, instance)
    audit(db, org_id=org_id, actor=actor, action="onboarding.task.added", request=request,
          target_type="onboarding_task", target_id=str(task.id),
          detail={"instance_id": str(instance.id), "title": task.title})
    db.commit()
    db.refresh(task)
    return _task_out(
        task,
        today=leave_svc.org_today(db, org_id),
        names=_names(db, org_id, [task.assignee_user_id, task.completed_by]),
    )


def update_task(
    db: Session,
    org_id: uuid.UUID,
    task_id: uuid.UUID,
    payload: OnboardingTaskIn,
    *,
    actor: User,
    request: Request | None = None,
) -> OnboardingTaskOut:
    """Rewrite one live task.

    Editing the wording or the deadline of a task somebody is being measured
    against is a different authority from ticking it off, which is why the
    status change has its own payload and its own permission path — see
    ``authorize_task_action``.
    """
    task = get_task(db, org_id, task_id)
    if payload.assignee_user_id is not None:
        _get_user(db, org_id, payload.assignee_user_id)

    task.title = payload.title.strip()
    task.description = payload.description
    task.category = payload.category
    task.owner_role = payload.owner_role
    task.sort_order = payload.sort_order
    task.due_date = payload.due_date
    task.assignee_user_id = payload.assignee_user_id
    task.requires_document = payload.requires_document
    task.doc_type = payload.doc_type or None

    audit(db, org_id=org_id, actor=actor, action="onboarding.task.updated", request=request,
          target_type="onboarding_task", target_id=str(task.id),
          detail={"title": task.title, "due_date": task.due_date})
    db.commit()
    db.refresh(task)
    return _task_out(
        task,
        today=leave_svc.org_today(db, org_id),
        names=_names(db, org_id, [task.assignee_user_id, task.completed_by]),
    )


def set_task_status(
    db: Session,
    org_id: uuid.UUID,
    task_id: uuid.UUID,
    payload: OnboardingTaskStatusIn,
    *,
    actor: User,
    request: Request | None = None,
) -> OnboardingTaskOut:
    """Tick a task off, or mark it not applicable.

    ``completed_by`` / ``completed_at`` are stamped for **both** closing
    statuses. A skip is a decision somebody made and has to be attributable in
    exactly the way a completion is; ``status`` is the sole discriminator
    between "we did it" and "we decided not to", and no report may infer one
    from the presence of a timestamp.
    """
    task = get_task(db, org_id, task_id)
    new = OnboardingTaskStatus(payload.status)

    if new is OnboardingTaskStatus.SKIPPED and not (payload.notes or "").strip():
        # A skip with no reason is worthless to whoever audits the checklist a
        # year later, which is the only time anybody reads it.
        raise HTTPException(
            http_status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "reason": "skip_reason_required",
                "message": "Say why this task is being skipped.",
            },
        )
    if (
        new is OnboardingTaskStatus.DONE
        and task.requires_document
        and not db.scalar(
            select(func.count())
            .select_from(OnboardingDocument)
            .where(OnboardingDocument.org_id == org_id, OnboardingDocument.task_id == task.id)
        )
    ):
        # The task exists to collect a file. Letting it close with nothing
        # attached turns the document checklist into a set of ticks that
        # assert nothing.
        raise HTTPException(
            http_status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "reason": "document_required",
                "message": f"Upload the {task.doc_type or 'required'} document first.",
            },
        )

    task.status = new.value
    if payload.notes is not None:
        task.notes = payload.notes
    if new.is_closed:
        task.completed_by = actor.id
        task.completed_at = _now()
    else:
        # Reopening clears the attribution rather than leaving a stale name on
        # a task that is demonstrably not finished.
        task.completed_by = None
        task.completed_at = None
    db.flush()

    _resync_instance(db, get_instance(db, org_id, task.instance_id))

    audit(db, org_id=org_id, actor=actor, action="onboarding.task.status", request=request,
          target_type="onboarding_task", target_id=str(task.id),
          detail={"instance_id": str(task.instance_id), "status": new.value})
    db.commit()
    db.refresh(task)
    return _task_out(
        task,
        today=leave_svc.org_today(db, org_id),
        names=_names(db, org_id, [task.assignee_user_id, task.completed_by]),
    )


def delete_task(
    db: Session,
    org_id: uuid.UUID,
    task_id: uuid.UUID,
    *,
    actor: User,
    request: Request | None = None,
) -> None:
    task = get_task(db, org_id, task_id)
    instance_id = task.instance_id
    title = task.title
    db.delete(task)
    db.flush()
    # Removing the last open item can complete the checklist, so the roll-up
    # runs on delete exactly as it does on a status change.
    _resync_instance(db, get_instance(db, org_id, instance_id))
    audit(db, org_id=org_id, actor=actor, action="onboarding.task.deleted", request=request,
          target_type="onboarding_task", target_id=str(task_id),
          detail={"instance_id": str(instance_id), "title": title})
    db.commit()


# --------------------------------------------------------------------------- #
# Authorisation for the paths an employee also reaches
#
# The HR-only endpoints are gated in the router with `deny_unless`, the same as
# every other module. These two exist for the endpoints a new hire also uses,
# where "administrator with the flag" is one of several legitimate routes in
# and the narrow ones must not be asked for a module-wide permission.
# --------------------------------------------------------------------------- #


def authorize_instance_read(db: Session, instance: OnboardingInstance, viewer: User) -> None:
    """Who may look at one hire's checklist.

    The hire themselves, always — being onboarded and not being allowed to see
    what you are being asked to do is not a position this product takes.
    Anybody else has to be an administrator, and then the flag decides.
    """
    if instance.user_id == viewer.id:
        return
    if viewer.role_enum.can_administer:
        deny_unless(viewer, "can_manage_onboarding", MANAGE)
        return
    raise HTTPException(http_status.HTTP_403_FORBIDDEN, "Not your onboarding checklist")


def authorize_task_action(db: Session, task: OnboardingTask, viewer: User) -> None:
    """Who may move one task's status.

    Three routes in, and the order matters: the two narrow ones are checked
    first so a named assignee or the hire is never asked for a flag that
    governs the whole module.
    """
    if task.assignee_user_id is not None and task.assignee_user_id == viewer.id:
        return
    instance = get_instance(db, viewer.org_id, task.instance_id)
    if instance.user_id == viewer.id:
        # The hire may close their own items only. A task owned by HR or IT is
        # somebody else's sign-off and stays that way even on their checklist.
        if task.owner_role == "employee":
            return
        raise HTTPException(http_status.HTTP_403_FORBIDDEN, "That task belongs to another owner")
    if viewer.role_enum.can_administer:
        deny_unless(viewer, "can_manage_onboarding", MANAGE)
        return
    raise HTTPException(http_status.HTTP_403_FORBIDDEN, "Not your onboarding task")


# --------------------------------------------------------------------------- #
# Documents
# --------------------------------------------------------------------------- #


def _suffix_for(file_name: str) -> str:
    suffix = PurePosixPath((file_name or "").replace("\\", "/")).suffix
    return suffix if _SAFE_SUFFIX.match(suffix) else ".bin"


def upload_document(
    db: Session,
    org_id: uuid.UUID,
    instance_id: uuid.UUID,
    *,
    doc_type: str,
    task_id: uuid.UUID | None,
    file_name: str,
    content_type: str,
    raw: bytes,
    actor: User,
    request: Request | None = None,
) -> OnboardingDocumentOut:
    """Store a collected file and record it against the checklist.

    The bytes go to ``services/storage.py`` under the same
    ``<org>/<user>/<day>/<id>`` key convention screenshots use, minted by
    ``storage.build_key`` rather than assembled here — nothing outside that
    module builds a path. The row keeps the key; no response ever does.
    """
    instance = get_instance(db, org_id, instance_id)
    if not raw:
        raise HTTPException(http_status.HTTP_422_UNPROCESSABLE_ENTITY, "Empty upload")
    if len(raw) > MAX_DOCUMENT_BYTES:
        raise HTTPException(http_status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Document too large")
    if task_id is not None:
        task = get_task(db, org_id, task_id)
        if task.instance_id != instance.id:
            # Filing somebody's ID proof against a different person's checklist
            # is a data-protection incident, not a validation nicety.
            raise HTTPException(
                http_status.HTTP_422_UNPROCESSABLE_ENTITY,
                "That task belongs to a different checklist",
            )

    doc_id = uuid.uuid4()
    key = storage.build_key(
        org_id, instance.user_id, _now(), doc_id, suffix=_suffix_for(file_name)
    )
    try:
        size = storage.backend().put(key, raw, content_type or "application/octet-stream")
    except storage.StorageError as exc:
        # The row is not written when the object is not stored: a document row
        # pointing at nothing reads as "collected" on the HR pipeline.
        raise HTTPException(
            http_status.HTTP_503_SERVICE_UNAVAILABLE, f"Could not store the document: {exc}"
        ) from exc

    doc = OnboardingDocument(
        id=doc_id,
        org_id=org_id,
        instance_id=instance.id,
        task_id=task_id,
        doc_type=doc_type.strip(),
        storage_key=key,
        file_name=(file_name or "")[:255],
        content_type=(content_type or "")[:120],
        file_size=size,
        uploaded_by=actor.id,
    )
    db.add(doc)
    audit(db, org_id=org_id, actor=actor, action="onboarding.document.uploaded",
          request=request, target_type="onboarding_document", target_id=str(doc.id),
          detail={"instance_id": str(instance.id), "doc_type": doc.doc_type})
    db.commit()
    db.refresh(doc)
    return _document_out(doc, names=_names(db, org_id, [doc.uploaded_by, doc.verified_by]))


def serve_document(db: Session, org_id: uuid.UUID, document_id: uuid.UUID):
    """``(document_row, Served)`` — the caller has already been authorised.

    Returns the storage module's own ``Served``, so an object-storage
    deployment redirects to a short-lived presigned URL and a local one streams
    the file, exactly as the screenshot endpoint does. The permission check
    happens before this on every single request, which is precisely why a
    client is never handed the key instead.
    """
    doc = get_document(db, org_id, document_id)
    try:
        return doc, storage.serve(doc.storage_key)
    except (FileNotFoundError, storage.StorageError):
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Document data missing") from None


def verify_document(
    db: Session,
    org_id: uuid.UUID,
    document_id: uuid.UUID,
    payload: OnboardingDocumentVerifyIn,
    *,
    actor: User,
    request: Request | None = None,
) -> OnboardingDocumentOut:
    """Mark a collected file checked, or un-check it.

    A null ``verified_at`` is the only signal of "not checked yet" — there is
    no separate boolean to fall out of sync with it — so un-verifying clears
    the verifier too, rather than leaving a name against a document nobody
    currently vouches for.
    """
    doc = get_document(db, org_id, document_id)
    if payload.verified:
        doc.verified_by = actor.id
        doc.verified_at = _now()
    else:
        doc.verified_by = None
        doc.verified_at = None
    doc.verification_note = payload.verification_note

    audit(db, org_id=org_id, actor=actor, action="onboarding.document.verified",
          request=request, target_type="onboarding_document", target_id=str(doc.id),
          detail={"verified": payload.verified, "instance_id": str(doc.instance_id)})

    # Verification is the moment a collected file becomes part of the permanent
    # record: somebody has looked at the original and vouched for it. Copy it
    # into the employee's own document file, because *this* row dies with the
    # checklist — `delete_document` above removes the bytes as well — and the
    # company would otherwise lose an ID proof it had actually verified.
    #
    # Not on upload: an unverified upload can be the wrong file, and promoting
    # it would fill the permanent record with things nobody checked.
    #
    # Un-verifying deliberately does NOT remove the promoted copy. The document
    # was collected and it is the person's; only the *claim that HR checked it*
    # is being withdrawn, and deleting an employee document is an administrator
    # action with its own audit row, not a side effect of a toggle.
    if payload.verified:
        instance = get_instance(db, org_id, doc.instance_id)
        corehr.promote_document(
            db,
            org_id=org_id,
            user_id=instance.user_id,
            doc_type=doc.doc_type or "other",
            title=doc.file_name,
            source_key=doc.storage_key,
            file_name=doc.file_name,
            content_type=doc.content_type,
            actor=actor,
            source_kind="onboarding_document",
            source_id=doc.id,
        )

    db.commit()
    db.refresh(doc)
    return _document_out(doc, names=_names(db, org_id, [doc.uploaded_by, doc.verified_by]))


def delete_document(
    db: Session,
    org_id: uuid.UUID,
    document_id: uuid.UUID,
    *,
    actor: User,
    request: Request | None = None,
) -> None:
    """Delete the row and the bytes together.

    Storage first, then the row: a row deleted while the object survives is a
    personal document nobody can find and nobody can erase, which is the worse
    half of the two possible failures.
    """
    doc = get_document(db, org_id, document_id)
    instance_id, doc_type = doc.instance_id, doc.doc_type
    storage.delete(doc.storage_key)
    db.delete(doc)
    audit(db, org_id=org_id, actor=actor, action="onboarding.document.deleted",
          request=request, target_type="onboarding_document", target_id=str(document_id),
          detail={"instance_id": str(instance_id), "doc_type": doc_type})
    db.commit()


# --------------------------------------------------------------------------- #
# Employee-facing
# --------------------------------------------------------------------------- #


def my_instance(
    db: Session, org_id: uuid.UUID, user_id: uuid.UUID
) -> OnboardingInstanceDetailOut | None:
    """The caller's own live checklist, or ``None``.

    Always the caller's id, never a query parameter — reading somebody else's
    checklist is the HR endpoint, and that one is gated.
    """
    instance = open_instance_for(db, org_id, user_id)
    if instance is None:
        return None
    return instance_detail(db, org_id, instance.id)
