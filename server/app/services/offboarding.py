"""Employee exit: request lifecycle, clearance checklist, F&F stub, completion.

Everything ``api/v1/offboarding.py`` is not allowed to know lives here — who may
be offboarded, what a fresh checklist looks like, when a due date moves, what
"settled" means, and the irreversible things completion does.

**The one decision a reader must not get wrong: there is exactly one revoke
path, and this module does not own it.** Completing an exit flips
``devices.is_active = False`` with the same statement ``api/v1/admin.py`` runs
when an employee is deactivated — the flag ``deps.get_current_device`` turns
into a 403 and the agent raises ``DeviceRevoked`` for. There is no
offboarding-specific revoke and there must never be one; a second way to kill a
device is a second thing to forget to check, and the two would eventually
disagree about whether a machine may still collect. For the same reason
``OffboardingRequest.devices_revoked_at`` and ``user_deactivated_at`` are
written here and **never read** to decide anything. They record *that* the
revoke ran, for an auditor; whether a device may still collect is
``devices.is_active`` and whether a person may still log in is
``users.is_active`` (D-016), and nothing in this file may add a third opinion.

**Completion is refused while any mandatory clearance item is unsettled.**
``OffboardingRequest.blocking_tasks`` is the gate, and it is deliberately
generous about what counts as settled and strict about what does not:
``skipped`` settles an item, because something a desk consciously waived must
not hold an exit open forever, while an *unrecognised* status value reads as
unsettled, so a bad string keeps the gate closed rather than quietly opening
it. A laptop that never came back is exactly the case where "mark complete"
must not be one click.

**Moving the last working day recomputes every due date (D-023).** Offboarding
has no template table — the default checklist is a module constant in
``app.models.offboarding`` that this service copies into rows — so
``due_offset_days`` lives on the task row itself, and it exists for precisely
this: notice periods get extended and brought forward constantly, and a
checklist whose dates do not follow is a checklist HR silently stops trusting.

**The F&F table is manual entry, and this service does not do arithmetic on
it.** ``net_payable_paise`` is stored exactly as typed and is never recomputed
from gross minus deductions: ex-gratia, notice-period buyouts and negotiated
write-offs make those numbers disagree legitimately, and recomputing would
overwrite what HR actually decided to pay with what we think they meant.
``is_consistent`` is reported so a console can warn; nothing here rejects a row
for failing it.

**What has changed since that was written:** ``app.services.settlement`` now
computes an itemised proposal from live payroll, leave, loan and expense data,
and writes it onto this same record with ``computed_at`` stamped. The paragraph
above still holds for everything this module does — it stores what it is given
and does no arithmetic — and a settlement may still be typed in from a
spreadsheet, which is what every row written before payroll existed is.

**Assets flow one way.** This module imports ``app.services.assets``; assets
imports nothing from here, so the register stays usable in an org that never
runs an exit checklist. The ``it_asset_return`` clearance task calls
``assets.return_asset`` — the same function the Assets page calls — rather than
touching ``asset_assignments`` itself, so the custody invariant that service
owns can never be bypassed through this door.
"""

from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import HTTPException, Request
from fastapi import status as http_status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.api.deps import audit
from app.models import (
    ClearanceCategory,
    ClearanceTaskStatus,
    Department,
    Designation,
    Device,
    FnfStatus,
    OffboardingFnf,
    OffboardingRequest,
    OffboardingStatus,
    OffboardingTask,
    Role,
    User,
    UserStatus,
)
from app.models.offboarding import DEFAULT_CLEARANCE_CHECKLIST
from app.schemas.assets import AssetOut, AssetReturnIn
from app.schemas.settlement import FnfLineOut
from app.schemas.offboarding import (
    ClearanceGroupOut,
    OffboardingCancelIn,
    OffboardingDetailOut,
    OffboardingFnfIn,
    OffboardingFnfOut,
    OffboardingFnfUpdate,
    OffboardingRequestIn,
    OffboardingRequestOut,
    OffboardingRequestUpdate,
    OffboardingTaskIn,
    OffboardingTaskOut,
    OffboardingTaskUpdate,
)
from app.services import corehr
from app.services import assets as assets_svc
from app.services import notifications as notif

log = logging.getLogger(__name__)

#: The category whose tasks are settled by handing hardware back. A string
#: literal on purpose: it is offboarding's word for a step in offboarding's
#: checklist, and the assets module must never learn it (see the module
#: docstring on which way this dependency runs).
ASSET_RETURN_CATEGORY = ClearanceCategory.IT_ASSET_RETURN.value


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------- #
# Lookups
# --------------------------------------------------------------------------- #


def get_request(db: Session, org_id: uuid.UUID, request_id: uuid.UUID) -> OffboardingRequest:
    """The exit, or 404 — never another tenant's exit.

    404 rather than 403 on the cross-tenant miss, matching ``assets.get_asset``
    and ``projects._get_project``: a 403 would confirm the id exists somewhere,
    which is itself a leak across the boundary it is meant to defend.
    """
    row = db.get(OffboardingRequest, request_id)
    if row is None or row.org_id != org_id:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Offboarding request not found")
    return row


def _get_task(db: Session, req: OffboardingRequest, task_id: uuid.UUID) -> OffboardingTask:
    """A task, checked against *its exit* rather than only against the org.

    Both halves matter: the org check stops a cross-tenant read, and the
    request check stops one exit's URL being used to edit another exit's
    checklist inside the same company.
    """
    task = db.get(OffboardingTask, task_id)
    if task is None or task.org_id != req.org_id or task.request_id != req.id:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Clearance task not found")
    return task


def open_request_for(
    db: Session, org_id: uuid.UUID, user_id: uuid.UUID
) -> OffboardingRequest | None:
    """The employee's in-flight exit, if they have one.

    Queried rather than derived from a list, because the partial unique index
    ``uq_offboarding_requests_open_per_user`` guarantees at most one and this is
    the read that gives a duplicate initiation a message instead of a 500.
    """
    return db.scalar(
        select(OffboardingRequest).where(
            OffboardingRequest.org_id == org_id,
            OffboardingRequest.user_id == user_id,
            OffboardingRequest.status.in_(
                [OffboardingStatus.INITIATED.value, OffboardingStatus.IN_PROGRESS.value]
            ),
        )
    )


def _require_open(req: OffboardingRequest) -> None:
    """Refuse an edit to an exit that has already finished.

    A completed exit revoked devices and deactivated a person; a cancelled one
    is the record of a withdrawal. Editing either after the fact would rewrite
    what happened rather than record what is happening, and neither has any
    remaining effect to apply.
    """
    if not req.status_enum.is_open:
        raise HTTPException(
            http_status.HTTP_409_CONFLICT,
            detail={
                "reason": "exit_not_open",
                "message": f"This exit is {req.status} and can no longer be edited.",
            },
        )


# --------------------------------------------------------------------------- #
# Due dates — D-023
# --------------------------------------------------------------------------- #


def _due_for(last_working_day: date | None, offset_days: int) -> date | None:
    """A clearance due date, or ``None`` while the last day is unknown.

    ``None`` and not a guess. An exit is routinely raised before the leaving
    date is agreed, and inventing one here would put a fictional deadline on
    every checklist row and, worse, on the relieving paperwork that reads them.
    """
    if last_working_day is None:
        return None
    return last_working_day + timedelta(days=offset_days)


def recompute_due_dates(req: OffboardingRequest) -> int:
    """Re-derive every task's ``due_on`` from its offset. Returns rows touched.

    This is the whole reason ``due_offset_days`` sits on the task row rather
    than on a template (D-023): offboarding has no template table, so without
    the offset here a moved last working day would leave a checklist full of
    dates nobody can recompute, and HR would fix them by hand or stop reading
    them.

    The cost, stated plainly because it is a real one: a due date an admin
    overrode by hand is overwritten the next time the last working day moves.
    That is the correct trade — a stale deadline that silently survives a
    four-week extension is worse than a lost manual tweak, and the tweak is one
    edit away — but it is a trade, not a free win.
    """
    touched = 0
    for task in req.tasks:
        due = _due_for(req.last_working_day, task.due_offset_days)
        if task.due_on != due:
            task.due_on = due
            touched += 1
    return touched


# --------------------------------------------------------------------------- #
# Serialisation
# --------------------------------------------------------------------------- #


def _names_for(db: Session, org_id: uuid.UUID) -> dict[uuid.UUID, str]:
    """Every name in the org, once.

    The exits list resolves five different people per row (leaver, manager,
    initiator, and per task an assignee and a completer). Looking each up
    individually is the N+1 that makes a twenty-row pipeline view issue a
    hundred queries.
    """
    return {
        row[0]: row[1]
        for row in db.execute(select(User.id, User.full_name).where(User.org_id == org_id))
    }


def _task_out(task: OffboardingTask, names: dict[uuid.UUID, str]) -> OffboardingTaskOut:
    return OffboardingTaskOut(
        id=task.id,
        request_id=task.request_id,
        title=task.title,
        description=task.description,
        category=task.category,
        owner_role=task.owner_role,
        assignee_user_id=task.assignee_user_id,
        status=task.status,
        is_mandatory=task.is_mandatory,
        due_offset_days=task.due_offset_days,
        due_on=task.due_on,
        sort_order=task.sort_order,
        completed_by=task.completed_by,
        completed_at=task.completed_at,
        notes=task.notes,
        created_at=task.created_at,
        assignee_name=names.get(task.assignee_user_id) if task.assignee_user_id else None,
        completed_by_name=names.get(task.completed_by) if task.completed_by else None,
        # Sent, never inferred client-side: "settled" is the completion gate's
        # own word and the console must not be able to hold a second opinion
        # about it.
        is_settled=task.is_settled,
    )


def _fnf_out(fnf: OffboardingFnf, names: dict[uuid.UUID, str]) -> OffboardingFnfOut:
    return OffboardingFnfOut(
        id=fnf.id,
        request_id=fnf.request_id,
        gross_dues_paise=fnf.gross_dues_paise,
        deductions_paise=fnf.deductions_paise,
        net_payable_paise=fnf.net_payable_paise,
        currency=fnf.currency,
        status=fnf.status,
        notes=fnf.notes,
        prepared_by=fnf.prepared_by,
        approved_by=fnf.approved_by,
        approved_at=fnf.approved_at,
        paid_on=fnf.paid_on,
        payment_reference=fnf.payment_reference,
        paid_by=fnf.paid_by,
        created_at=fnf.created_at,
        prepared_by_name=names.get(fnf.prepared_by) if fnf.prepared_by else None,
        approved_by_name=names.get(fnf.approved_by) if fnf.approved_by else None,
        paid_by_name=names.get(fnf.paid_by) if fnf.paid_by else None,
        # Reported, not enforced. See the module docstring.
        is_consistent=fnf.is_consistent,
        computed_at=fnf.computed_at,
        lines=[FnfLineOut.model_validate(line) for line in fnf.lines],
        # No longer hard-coded true: a settlement computed from a proposal is
        # not manually entered, and saying it was would misdescribe the one
        # thing this flag exists to tell a reader.
        is_manually_entered=fnf.computed_at is None,
    )


def fnf_out(db: Session, org_id: uuid.UUID, fnf: OffboardingFnf) -> OffboardingFnfOut:
    """Render a settlement for a caller outside this module.

    ``_fnf_out`` needs a name map every caller in here already has; this looks
    one up so the settlement service's routes do not have to know that.
    """
    return _fnf_out(fnf, _names_for(db, org_id))


def _request_out(
    req: OffboardingRequest,
    *,
    names: dict[uuid.UUID, str],
    leaver: User | None,
    department_name: str | None,
    designation_name: str | None,
) -> OffboardingRequestOut:
    tasks = list(req.tasks)
    return OffboardingRequestOut(
        id=req.id,
        org_id=req.org_id,
        user_id=req.user_id,
        initiated_by=req.initiated_by,
        reason=req.reason,
        reason_note=req.reason_note,
        notice_date=req.notice_date,
        last_working_day=req.last_working_day,
        status=req.status,
        completed_at=req.completed_at,
        completed_by=req.completed_by,
        cancelled_at=req.cancelled_at,
        cancellation_reason=req.cancellation_reason,
        devices_revoked_at=req.devices_revoked_at,
        user_deactivated_at=req.user_deactivated_at,
        created_at=req.created_at,
        user_name=leaver.full_name if leaver else None,
        user_email=leaver.email if leaver else None,
        employee_code=leaver.employee_code if leaver else None,
        department_name=department_name,
        designation_name=designation_name,
        manager_name=(
            names.get(leaver.manager_id) if leaver and leaver.manager_id else None
        ),
        initiated_by_name=names.get(req.initiated_by) if req.initiated_by else None,
        task_total=len(tasks),
        task_settled=sum(1 for t in tasks if t.is_settled),
        blocking_task_count=len(req.blocking_tasks),
        fnf_status=req.fnf.status if req.fnf else None,
    )


def _clearance_groups(
    tasks: list[OffboardingTask], names: dict[uuid.UUID, str]
) -> list[ClearanceGroupOut]:
    """All four desks, in a fixed order, including the empty ones.

    An empty Finance clearance section is information — nobody has raised
    anything — while a *missing* one reads as a bug and sends someone looking
    for the query that dropped it. The enum's declaration order is the order,
    so the console never has to hold its own copy of the list.
    """
    groups: list[ClearanceGroupOut] = []
    for category in ClearanceCategory:
        rows = sorted(
            (t for t in tasks if t.category == category.value),
            key=lambda t: (t.sort_order, t.created_at),
        )
        groups.append(
            ClearanceGroupOut(
                category=category.value,
                task_total=len(rows),
                task_settled=sum(1 for t in rows if t.is_settled),
                blocking_task_count=sum(1 for t in rows if t.is_mandatory and not t.is_settled),
                tasks=[_task_out(t, names) for t in rows],
            )
        )
    return groups


def _detail_out(db: Session, req: OffboardingRequest) -> OffboardingDetailOut:
    names = _names_for(db, req.org_id)
    leaver = db.get(User, req.user_id)
    department_name = None
    designation_name = None
    if leaver is not None:
        if leaver.department_id:
            dept = db.get(Department, leaver.department_id)
            department_name = dept.name if dept else None
        if leaver.designation_id:
            desig = db.get(Designation, leaver.designation_id)
            designation_name = desig.name if desig else None

    base = _request_out(
        req,
        names=names,
        leaver=leaver,
        department_name=department_name,
        designation_name=designation_name,
    )
    return OffboardingDetailOut(
        **base.model_dump(),
        clearance=_clearance_groups(list(req.tasks), names),
        fnf=_fnf_out(req.fnf, names) if req.fnf else None,
    )


# --------------------------------------------------------------------------- #
# Request lifecycle
# --------------------------------------------------------------------------- #


def list_requests(
    db: Session,
    org_id: uuid.UUID,
    *,
    status_filter: str | None = None,
    user_id: uuid.UUID | None = None,
    open_only: bool = False,
) -> list[OffboardingRequestOut]:
    """The exits pipeline, newest notice first.

    ``selectinload`` on both children because every row reports checklist
    progress and an F&F status: without it the pipeline view is two extra
    queries per exit, and the counts are the reason anybody opens this page.
    """
    stmt = (
        select(OffboardingRequest)
        .options(selectinload(OffboardingRequest.tasks), selectinload(OffboardingRequest.fnf))
        .where(OffboardingRequest.org_id == org_id)
        .order_by(OffboardingRequest.notice_date.desc(), OffboardingRequest.created_at.desc())
    )
    if status_filter:
        stmt = stmt.where(OffboardingRequest.status == status_filter)
    if open_only:
        stmt = stmt.where(
            OffboardingRequest.status.in_(
                [OffboardingStatus.INITIATED.value, OffboardingStatus.IN_PROGRESS.value]
            )
        )
    if user_id is not None:
        stmt = stmt.where(OffboardingRequest.user_id == user_id)

    rows = list(db.scalars(stmt).all())
    names = _names_for(db, org_id)
    leavers = {
        u.id: u
        for u in db.scalars(
            select(User).where(User.id.in_([r.user_id for r in rows]))
        ).all()
    } if rows else {}
    departments = {
        row[0]: row[1]
        for row in db.execute(select(Department.id, Department.name).where(
            Department.org_id == org_id
        ))
    }
    designations = {
        row[0]: row[1]
        for row in db.execute(select(Designation.id, Designation.name).where(
            Designation.org_id == org_id
        ))
    }
    out = []
    for req in rows:
        leaver = leavers.get(req.user_id)
        out.append(
            _request_out(
                req,
                names=names,
                leaver=leaver,
                department_name=(
                    departments.get(leaver.department_id) if leaver else None
                ),
                designation_name=(
                    designations.get(leaver.designation_id) if leaver else None
                ),
            )
        )
    return out


def detail(db: Session, org_id: uuid.UUID, request_id: uuid.UUID) -> OffboardingDetailOut:
    return _detail_out(db, get_request(db, org_id, request_id))


def initiate(
    db: Session,
    org_id: uuid.UUID,
    payload: OffboardingRequestIn,
    *,
    actor: User,
    request: Request | None = None,
) -> OffboardingDetailOut:
    """Open an exit and lay out its clearance checklist.

    Two guards on the duplicate, deliberately not one: the ``open_request_for``
    read gives an administrator a message they can act on, and the partial
    unique index *decides* — two HR admins filing the same resignation in the
    same second both pass the read, and the loser surfaces as an
    ``IntegrityError`` translated to the same 409 rather than a 500. The index
    is partial rather than a plain unique constraint because somebody can be
    rehired and leave again, and the first exit has to stay on file when they
    are (D-027).
    """
    leaver = db.get(User, payload.user_id)
    if leaver is None or leaver.org_id != org_id:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Employee not found")

    existing = open_request_for(db, org_id, leaver.id)
    if existing is not None:
        raise HTTPException(
            http_status.HTTP_409_CONFLICT,
            detail={
                "reason": "exit_already_open",
                "message": f"{leaver.full_name} already has an exit in progress.",
                "request_id": str(existing.id),
            },
        )
    if payload.last_working_day and payload.last_working_day < payload.notice_date:
        # Not a validation nicety: every clearance due date is derived from the
        # last working day, so a notice dated after it schedules the whole
        # checklist before the resignation was received.
        raise HTTPException(
            http_status.HTTP_400_BAD_REQUEST,
            "The last working day cannot fall before the notice date",
        )

    req = OffboardingRequest(
        org_id=org_id,
        user_id=leaver.id,
        initiated_by=actor.id,
        reason=payload.reason,
        reason_note=payload.reason_note or None,
        notice_date=payload.notice_date,
        last_working_day=payload.last_working_day,
        status=OffboardingStatus.INITIATED.value,
    )
    db.add(req)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            http_status.HTTP_409_CONFLICT,
            detail={
                "reason": "exit_already_open",
                "message": f"{leaver.full_name} already has an exit in progress.",
            },
        ) from None

    _instantiate_checklist(db, req)
    audit(db, org_id=org_id, actor=actor, action="offboarding.initiated", request=request,
          target_type="offboarding_request", target_id=str(req.id),
          detail={"user_id": str(leaver.id), "reason": req.reason,
                  "notice_date": req.notice_date, "last_working_day": req.last_working_day,
                  "task_count": len(req.tasks)})
    db.commit()
    db.refresh(req)
    return _detail_out(db, req)


def _instantiate_checklist(db: Session, req: OffboardingRequest) -> None:
    """Copy ``DEFAULT_CLEARANCE_CHECKLIST`` into rows on this exit.

    Copied rather than referenced, which is the point of having no template
    table (D-017): from here on the checklist belongs to this exit alone, so HR
    can add "return the office key" or waive the exit interview without editing
    a shared list that would rewrite what every other in-flight exit meant.

    ``sort_order`` comes from the constant's own order. It is the sequence the
    steps are meant to happen in, and re-deriving it from the title would sort
    the handover after the sign-off on it.
    """
    for index, spec in enumerate(DEFAULT_CLEARANCE_CHECKLIST):
        offset = int(spec["due_offset_days"])
        db.add(
            OffboardingTask(
                org_id=req.org_id,
                request_id=req.id,
                title=str(spec["title"]),
                category=str(spec["category"]),
                owner_role=str(spec["owner_role"]),
                is_mandatory=bool(spec["is_mandatory"]),
                due_offset_days=offset,
                due_on=_due_for(req.last_working_day, offset),
                sort_order=index,
                status=ClearanceTaskStatus.PENDING.value,
            )
        )
    db.flush()


def update_request(
    db: Session,
    org_id: uuid.UUID,
    request_id: uuid.UUID,
    payload: OffboardingRequestUpdate,
    *,
    actor: User,
    request: Request | None = None,
) -> OffboardingDetailOut:
    """Edit an in-flight exit. Moving the last working day moves the checklist.

    ``status`` is deliberately absent from ``OffboardingRequestUpdate``:
    completing an exit revokes devices and deactivates a person, which is a
    service action behind its own endpoint and not something a PATCH body
    should be able to do by accident.
    """
    req = get_request(db, org_id, request_id)
    _require_open(req)

    data = payload.model_dump(exclude_unset=True)
    lwd_moved = "last_working_day" in data and data["last_working_day"] != req.last_working_day

    # Validated against the *merged* values before anything is assigned. Doing
    # it afterwards would leave a rejected edit sitting dirty in the session,
    # where the next thing to call commit() — an alert, a nested service —
    # would persist the change this branch just refused.
    merged_lwd = data.get("last_working_day", req.last_working_day)
    merged_notice = data.get("notice_date", req.notice_date)
    if merged_lwd and merged_lwd < merged_notice:
        raise HTTPException(
            http_status.HTTP_400_BAD_REQUEST,
            "The last working day cannot fall before the notice date",
        )

    for field, value in data.items():
        setattr(req, field, value)
    recomputed = recompute_due_dates(req) if lwd_moved else 0
    audit(db, org_id=org_id, actor=actor, action="offboarding.updated", request=request,
          target_type="offboarding_request", target_id=str(req.id),
          detail={**data, "due_dates_recomputed": recomputed})
    db.commit()
    db.refresh(req)
    return _detail_out(db, req)


def cancel_request(
    db: Session,
    org_id: uuid.UUID,
    request_id: uuid.UUID,
    payload: OffboardingCancelIn,
    *,
    actor: User,
    request: Request | None = None,
) -> OffboardingDetailOut:
    """Withdraw an exit. Cancellation is not deletion.

    A withdrawn resignation is itself a fact somebody may need six months
    later, and deleting the row would also free the partial unique index in a
    way that hides that the exit was ever raised. The reason is mandatory for
    the same reason.
    """
    req = get_request(db, org_id, request_id)
    _require_open(req)

    req.status = OffboardingStatus.CANCELLED.value
    req.cancelled_at = _now()
    req.cancellation_reason = payload.cancellation_reason
    audit(db, org_id=org_id, actor=actor, action="offboarding.cancelled", request=request,
          target_type="offboarding_request", target_id=str(req.id),
          detail={"cancellation_reason": payload.cancellation_reason})
    db.commit()
    db.refresh(req)
    return _detail_out(db, req)


# --------------------------------------------------------------------------- #
# Clearance tasks
# --------------------------------------------------------------------------- #


def add_task(
    db: Session,
    org_id: uuid.UUID,
    request_id: uuid.UUID,
    payload: OffboardingTaskIn,
    *,
    actor: User,
    request: Request | None = None,
) -> OffboardingTaskOut:
    """Add a clearance item the default checklist did not anticipate."""
    req = get_request(db, org_id, request_id)
    _require_open(req)

    task = OffboardingTask(
        org_id=org_id,
        request_id=req.id,
        title=payload.title.strip(),
        description=payload.description or None,
        category=payload.category,
        owner_role=payload.owner_role,
        assignee_user_id=_checked_assignee(db, org_id, payload.assignee_user_id),
        is_mandatory=payload.is_mandatory,
        due_offset_days=payload.due_offset_days,
        due_on=_due_for(req.last_working_day, payload.due_offset_days),
        sort_order=payload.sort_order,
        status=ClearanceTaskStatus.PENDING.value,
    )
    db.add(task)
    db.flush()
    audit(db, org_id=org_id, actor=actor, action="offboarding.task.created", request=request,
          target_type="offboarding_task", target_id=str(task.id),
          detail={"request_id": str(req.id), "title": task.title,
                  "category": task.category, "is_mandatory": task.is_mandatory})
    db.commit()
    db.refresh(task)
    return _task_out(task, _names_for(db, org_id))


def _checked_assignee(
    db: Session, org_id: uuid.UUID, assignee_user_id: uuid.UUID | None
) -> uuid.UUID | None:
    """Refuse an assignee from another company.

    The column is a plain FK with no org in it, so nothing in the schema stops
    a clearance item on Acme's exit being assigned to somebody at Globex — and
    the resolved ``assignee_name`` would then render their name on Acme's
    screen.
    """
    if assignee_user_id is None:
        return None
    user = db.get(User, assignee_user_id)
    if user is None or user.org_id != org_id:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Assignee not found")
    return user.id


def update_task(
    db: Session,
    org_id: uuid.UUID,
    request_id: uuid.UUID,
    task_id: uuid.UUID,
    payload: OffboardingTaskUpdate,
    *,
    actor: User,
    request: Request | None = None,
) -> OffboardingTaskOut:
    """Tick an item off, reassign it, or record why it was waived.

    **Every status change writes an ``AuditLog`` row (D-018).** These tables
    have no ``updated_at`` — ``TimestampMixin`` provides ``created_at`` alone,
    and adding one would silently alter every table in the repo — so the audit
    row is the only record that an item was marked done, by whom, and when it
    stopped being open. ``completed_by``/``completed_at`` say who settled it
    *last*; the audit log is what says it was settled, un-settled and settled
    again by two different people.

    Skipping requires a note. ``skipped`` counts as settled by the completion
    gate, so it is the one status that can let an exit finish with a mandatory
    item never actually done; "waived, employee absconded" is the difference
    between an audited decision and a checklist somebody clicked through.
    """
    req = get_request(db, org_id, request_id)
    _require_open(req)
    task = _get_task(db, req, task_id)

    data = payload.model_dump(exclude_unset=True)
    if "assignee_user_id" in data:
        data["assignee_user_id"] = _checked_assignee(db, org_id, data["assignee_user_id"])
    if "title" in data and data["title"]:
        data["title"] = data["title"].strip()

    previous_status = task.status
    new_status = data.get("status", previous_status)
    if new_status == ClearanceTaskStatus.SKIPPED.value:
        note = data.get("notes", task.notes)
        if not (note or "").strip():
            raise HTTPException(
                http_status.HTTP_400_BAD_REQUEST,
                detail={
                    "reason": "skip_reason_required",
                    "message": "Say why this clearance item is being waived.",
                },
            )

    for field, value in data.items():
        setattr(task, field, value)

    if "status" in data and new_status != previous_status:
        if ClearanceTaskStatus(new_status).is_settled:
            task.completed_by = actor.id
            task.completed_at = _now()
        else:
            # Reopening clears the stamp rather than leaving it: a pending item
            # carrying a completion timestamp is how a half-finished clearance
            # reads as done to every report that checks the column instead of
            # the status.
            task.completed_by = None
            task.completed_at = None
        audit(db, org_id=org_id, actor=actor, action="offboarding.task.status_changed",
              request=request, target_type="offboarding_task", target_id=str(task.id),
              detail={"request_id": str(req.id), "title": task.title,
                      "from": previous_status, "to": new_status,
                      "is_mandatory": task.is_mandatory})

    # A second row for the non-status edits, keyed differently, because
    # "somebody moved the due date" and "somebody marked it done" are separate
    # questions an auditor asks and one merged row answers neither well.
    other = {k: v for k, v in data.items() if k != "status"}
    if other:
        if "due_offset_days" in other and "due_on" not in other:
            # Changing the offset re-derives the date, unless the same request
            # also named one. Both arriving together means the caller has a
            # date in mind and an offset for the next time the last working day
            # moves; recomputing over their date would discard the half they
            # were more specific about.
            task.due_on = _due_for(req.last_working_day, task.due_offset_days)
        audit(db, org_id=org_id, actor=actor, action="offboarding.task.updated",
              request=request, target_type="offboarding_task", target_id=str(task.id),
              detail={"request_id": str(req.id), **other})

    db.commit()
    db.refresh(task)
    return _task_out(task, _names_for(db, org_id))


def delete_task(
    db: Session,
    org_id: uuid.UUID,
    request_id: uuid.UUID,
    task_id: uuid.UUID,
    *,
    actor: User,
    request: Request | None = None,
) -> None:
    """Remove a clearance item that does not apply to this exit.

    Deleting rather than skipping, and both exist on purpose: skipping records
    that a real obligation was waived and by whom, deleting removes a line that
    was never an obligation here — a laptop return on a contractor who was
    never issued one. Skipping that would leave a permanent waiver on file for
    something nobody owed.
    """
    req = get_request(db, org_id, request_id)
    _require_open(req)
    task = _get_task(db, req, task_id)
    title = task.title
    db.delete(task)
    audit(db, org_id=org_id, actor=actor, action="offboarding.task.deleted", request=request,
          target_type="offboarding_task", target_id=str(task_id),
          detail={"request_id": str(req.id), "title": title, "status": task.status})
    db.commit()


# --------------------------------------------------------------------------- #
# The it_asset_return hook — offboarding calls assets, never the reverse
# --------------------------------------------------------------------------- #


def outstanding_assets(
    db: Session, org_id: uuid.UUID, request_id: uuid.UUID
) -> list[AssetOut]:
    """What the leaver is still holding, straight from the register.

    ``assets.list_assets`` rather than a query of our own. The register is the
    answer to "who has this machine" and duplicating its holder resolution here
    would give the exit screen a second, slowly diverging opinion about custody
    — which is exactly the drift that service exists to prevent.
    """
    req = get_request(db, org_id, request_id)
    return assets_svc.list_assets(db, org_id, holder_user_id=req.user_id)


def return_asset_for_task(
    db: Session,
    org_id: uuid.UUID,
    request_id: uuid.UUID,
    task_id: uuid.UUID,
    asset_id: uuid.UUID,
    payload: AssetReturnIn,
    *,
    actor: User,
    request: Request | None = None,
) -> OffboardingTaskOut:
    """Take a leaver's asset back from inside the clearance checklist.

    The custody write is ``assets.return_asset`` — the same public function the
    Assets page calls — and not a hand-rolled update of ``asset_assignments``.
    That service owns an invariant no constraint can express (``assets.status``
    agreeing with the open ledger row), it holds both halves in one
    transaction, and a second writer here would be a second place for the
    register to start lying about who holds what.

    **Ordering, which is load-bearing.** ``return_asset`` commits — deliberately,
    so its invariant does not depend on a caller remembering to — so every
    check this function makes happens *before* the call, and nothing of ours
    may be sitting uncommitted in the session when it runs. The task is settled
    afterwards in its own commit. The window between them is real: a crash
    there leaves the asset genuinely returned and the checklist item still
    open, which is the safe direction to fail — the item is re-tickable and the
    completion gate stays closed, whereas the reverse would mark clearance done
    on hardware still in somebody's house.
    """
    req = get_request(db, org_id, request_id)
    _require_open(req)
    task = _get_task(db, req, task_id)
    if task.category != ASSET_RETURN_CATEGORY:
        raise HTTPException(
            http_status.HTTP_400_BAD_REQUEST,
            detail={
                "reason": "wrong_task_category",
                "message": "Only an IT asset return item can take an asset back.",
            },
        )

    held = assets_svc.open_assignment(db, org_id, asset_id)
    if held is None or held.user_id != req.user_id:
        # Checked here rather than left to the asset service: it would happily
        # close somebody else's custody row, and doing that from a leaver's
        # checklist would silently take a machine off a colleague who still has
        # it on their desk.
        raise HTTPException(
            http_status.HTTP_409_CONFLICT,
            detail={
                "reason": "not_held_by_leaver",
                "message": "That asset is not currently issued to this employee.",
            },
        )

    returned = assets_svc.return_asset(
        db, org_id, asset_id, payload, actor=actor, request=request
    )

    task.status = ClearanceTaskStatus.DONE.value
    task.completed_by = actor.id
    task.completed_at = _now()
    audit(db, org_id=org_id, actor=actor, action="offboarding.task.status_changed",
          request=request, target_type="offboarding_task", target_id=str(task.id),
          detail={"request_id": str(req.id), "title": task.title,
                  "from": ClearanceTaskStatus.PENDING.value,
                  "to": ClearanceTaskStatus.DONE.value,
                  "via": "asset_return", "assignment_id": str(returned.id),
                  "asset_id": str(asset_id)})
    db.commit()
    db.refresh(task)
    return _task_out(task, _names_for(db, org_id))


# --------------------------------------------------------------------------- #
# Full-and-final settlement — manual entry, no arithmetic
# --------------------------------------------------------------------------- #


def create_fnf(
    db: Session,
    org_id: uuid.UUID,
    request_id: uuid.UUID,
    payload: OffboardingFnfIn,
    *,
    actor: User,
    request: Request | None = None,
) -> OffboardingFnfOut:
    """Record the settlement HR worked out somewhere else.

    The three numbers are stored exactly as typed. ``net_payable_paise`` is
    **not** derived from the other two and not checked against them: see the
    module docstring, and note that the mismatch is reported back as
    ``is_consistent=False`` rather than refused.
    """
    req = get_request(db, org_id, request_id)
    if req.fnf is not None:
        raise HTTPException(
            http_status.HTTP_409_CONFLICT,
            detail={
                "reason": "fnf_exists",
                "message": "This exit already has a settlement record. Edit it instead.",
            },
        )

    fnf = OffboardingFnf(
        org_id=org_id,
        request_id=req.id,
        gross_dues_paise=payload.gross_dues_paise,
        deductions_paise=payload.deductions_paise,
        net_payable_paise=payload.net_payable_paise,
        currency=payload.currency,
        status=FnfStatus.DRAFT.value,
        notes=payload.notes or None,
        prepared_by=actor.id,
    )
    db.add(fnf)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            http_status.HTTP_409_CONFLICT,
            detail={
                "reason": "fnf_exists",
                "message": "This exit already has a settlement record. Edit it instead.",
            },
        ) from None

    _audit_fnf(db, fnf, actor=actor, request=request, action="offboarding.fnf.created",
               detail={"gross_dues_paise": fnf.gross_dues_paise,
                       "deductions_paise": fnf.deductions_paise,
                       "net_payable_paise": fnf.net_payable_paise,
                       "currency": fnf.currency})
    db.commit()
    db.refresh(fnf)
    return _fnf_out(fnf, _names_for(db, org_id))


def update_fnf(
    db: Session,
    org_id: uuid.UUID,
    request_id: uuid.UUID,
    payload: OffboardingFnfUpdate,
    *,
    actor: User,
    request: Request | None = None,
) -> OffboardingFnfOut:
    """Amend the settlement, and leave a trail that it changed.

    **Every edit writes an ``AuditLog`` row (D-018), including edits after
    payment.** There is no ``updated_at`` on this table and there is not going
    to be one, so without the audit row a settlement that was quietly retyped
    from 40,000 to 4,000 after it was approved is indistinguishable from one
    that always said 4,000. That is the single most consequential silent
    mutation in this module, which is why an amendment to a paid row gets its
    own action name rather than being folded into the ordinary one — an
    auditor scanning for it should not have to read timestamps to find it.

    ``paid`` needs both a date and a reference. A settlement with neither
    cannot be evidenced later, and being able to evidence it is the only reason
    this table exists.
    """
    req = get_request(db, org_id, request_id)
    fnf = req.fnf
    if fnf is None:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "No settlement recorded yet")

    data = payload.model_dump(exclude_unset=True)
    was_paid = fnf.status_enum is FnfStatus.PAID
    previous_status = fnf.status
    new_status = data.get("status", previous_status)

    if new_status == FnfStatus.PAID.value:
        paid_on = data.get("paid_on", fnf.paid_on)
        reference = data.get("payment_reference", fnf.payment_reference)
        if paid_on is None or not (reference or "").strip():
            raise HTTPException(
                http_status.HTTP_400_BAD_REQUEST,
                detail={
                    "reason": "payment_evidence_required",
                    "message": "Marking a settlement paid needs the date and the "
                               "NEFT/UTR or cheque reference.",
                },
            )

    for field, value in data.items():
        setattr(fnf, field, value)

    if new_status != previous_status:
        if new_status == FnfStatus.APPROVED.value:
            fnf.approved_by = actor.id
            fnf.approved_at = _now()
        elif new_status == FnfStatus.PAID.value:
            fnf.paid_by = actor.id
            # Approval is stamped here too when a settlement went straight to
            # paid: money left the company, so somebody approved it, and an
            # empty approver on a paid row is a gap in exactly the trail this
            # record exists to keep.
            if fnf.approved_at is None:
                fnf.approved_by = actor.id
                fnf.approved_at = _now()

    action = (
        "offboarding.fnf.amended_after_payment" if was_paid else "offboarding.fnf.updated"
    )
    _audit_fnf(db, fnf, actor=actor, request=request, action=action,
               detail={**data, "status_from": previous_status,
                       "is_consistent": fnf.is_consistent})
    db.commit()
    db.refresh(fnf)
    return _fnf_out(fnf, _names_for(db, org_id))


def _audit_fnf(
    db: Session,
    fnf: OffboardingFnf,
    *,
    actor: User,
    request: Request | None,
    action: str,
    detail: dict,
) -> None:
    """Every F&F write goes through here, so none can be added without a row.

    The resulting three numbers are always in the detail, not only the fields
    that changed: an auditor reading one row should see what the settlement
    became, without replaying every earlier row to find out.
    """
    audit(db, org_id=fnf.org_id, actor=actor, action=action, request=request,
          target_type="offboarding_fnf", target_id=str(fnf.id),
          detail={"request_id": str(fnf.request_id), **detail,
                  "resulting_gross_dues_paise": fnf.gross_dues_paise,
                  "resulting_deductions_paise": fnf.deductions_paise,
                  "resulting_net_payable_paise": fnf.net_payable_paise,
                  "resulting_status": fnf.status})


# --------------------------------------------------------------------------- #
# Completion — the gate, and the two irreversible things
# --------------------------------------------------------------------------- #


def complete(
    db: Session,
    org_id: uuid.UUID,
    request_id: uuid.UUID,
    *,
    actor: User,
    request: Request | None = None,
) -> OffboardingDetailOut:
    """Close the exit: revoke devices, deactivate the person, stamp the record.

    **The gate.** ``blocking_tasks`` — mandatory and unsettled — must be empty.
    ``skipped`` settles an item, so a consciously waived step does not hold an
    exit open forever, and an unrecognised status value reads as *unsettled*,
    so a bad string keeps the gate closed rather than opening it. Both halves
    are in ``OffboardingTask.is_settled``; nothing here re-decides them.

    **The revoke is the existing one.** The ``Device`` update below is the same
    statement ``admin.update_employee`` runs when an administrator deactivates
    somebody: ``deps.get_current_device`` reads ``is_active`` and answers 403,
    and the agent raises ``DeviceRevoked``. It is deliberately not org-scoped
    beyond the leaver, exactly as that one is not — ``user`` has already been
    checked against ``org_id`` and every device carries the user's id, so a
    second filter here would be a cosmetically different statement doing the
    identical thing, which is how two revoke paths start.

    **The stamps are evidence, not state.** ``devices_revoked_at`` and
    ``user_deactivated_at`` are written here and read by nothing: whether a
    machine may still collect is ``devices.is_active``, and whether a person
    may still log in is ``users.is_active`` (D-016). ``users.status`` moves to
    ``inactive`` as well because the spec asks for it and reports group by it,
    but it is descriptive only — if login ever consults it there are two
    switches that can disagree about whether someone may log in, which is the
    precise failure the single-revoke-path rule exists to avoid.

    All of it commits once. A revoke that landed while the request stayed
    ``in_progress`` would leave an employee locked out of a company that
    believes they still work there.
    """
    req = get_request(db, org_id, request_id)
    _require_open(req)

    blocking = req.blocking_tasks
    if blocking:
        raise HTTPException(
            http_status.HTTP_409_CONFLICT,
            detail={
                "reason": "clearance_incomplete",
                "message": (
                    f"{len(blocking)} mandatory clearance item(s) are still open. "
                    "Complete or waive them before closing this exit."
                ),
                "blocking_tasks": [
                    {"id": str(t.id), "title": t.title, "category": t.category,
                     "status": t.status}
                    for t in blocking
                ],
            },
        )
    if req.last_working_day is None:
        # Refused rather than defaulted to today. A completed exit with no
        # leaving date cannot produce a relieving letter, and a guessed one on
        # that letter is worse than no letter at all.
        raise HTTPException(
            http_status.HTTP_409_CONFLICT,
            detail={
                "reason": "last_working_day_missing",
                "message": "Set the last working day before completing this exit.",
            },
        )

    leaver = db.get(User, req.user_id)
    if leaver is None or leaver.org_id != org_id:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Employee not found")
    _refuse_administrator_lockout(db, org_id, leaver)

    now = _now()
    # The one revoke path. See the docstring; do not add a second.
    revoked = db.execute(
        Device.__table__.update().where(Device.user_id == leaver.id).values(is_active=False)
    ).rowcount

    # is_active is the sole authentication gate (D-016); status is descriptive.
    leaver.is_active = False
    leaver.status = UserStatus.INACTIVE.value
    # The master record has to be closed out too, or a departed employee's
    # profile still reads "Confirmed" — true of the day they left, misleading on
    # every screen after it. Core HR owns that table, so this asks rather than
    # writing into it.
    corehr.mark_exited(db, subject=leaver, actor=actor)

    req.status = OffboardingStatus.COMPLETED.value
    req.completed_at = now
    req.completed_by = actor.id
    req.devices_revoked_at = now
    req.user_deactivated_at = now

    audit(db, org_id=org_id, actor=actor, action="offboarding.completed", request=request,
          target_type="offboarding_request", target_id=str(req.id),
          detail={"user_id": str(leaver.id), "last_working_day": req.last_working_day,
                  "devices_revoked": revoked, "task_total": len(req.tasks),
                  "task_settled": sum(1 for t in req.tasks if t.is_settled)})
    db.commit()
    db.refresh(req)

    _notify_completion(db, req, leaver, actor=actor)
    return _detail_out(db, req)


def _refuse_administrator_lockout(db: Session, org_id: uuid.UUID, leaver: User) -> None:
    """Refuse a completion that would leave the company with no administrator.

    Same shape of failure as D-014's geofence lockout, arriving from a
    different door: completing an exit deactivates an account, and deactivating
    the last active owner or admin locks the whole tenant out of its own
    console with no way back except a platform operator. A founder leaving is a
    real and legitimate exit, so this is deliberately **not** "the owner cannot
    be offboarded" — it is "promote somebody first", which is one edit away and
    is what the company meant to do anyway.

    Checked at completion rather than at initiation on purpose: raising the
    exit is how the handover gets planned, and refusing to even record a
    departing founder's notice would be refusing the paperwork rather than the
    lockout. The typed body lets the console explain that before submit, the
    way the geofence guard does.
    """
    if not leaver.role_enum.can_administer:
        return
    remaining = db.scalar(
        select(func.count(User.id)).where(
            User.org_id == org_id,
            User.id != leaver.id,
            User.is_active.is_(True),
            User.role.in_([Role.OWNER.value, Role.ADMIN.value]),
        )
    )
    if remaining:
        return
    raise HTTPException(
        http_status.HTTP_409_CONFLICT,
        detail={
            "reason": "last_administrator",
            "message": (
                f"{leaver.full_name} is the only active administrator. Promote "
                "somebody else before completing this exit."
            ),
        },
    )


# --------------------------------------------------------------------------- #
# Notifications
# --------------------------------------------------------------------------- #


def _notify_completion(
    db: Session, req: OffboardingRequest, leaver: User, *, actor: User
) -> None:
    """Tell the leaver's manager and the administrators that the exit closed.

    **This is a wired seam, not a wired feature.** Spec §4.2 requires the alert,
    but ``notifications.Kind`` has no offboarding member and
    ``services/notifications.py`` is lead-only, so the kind is looked up rather
    than imported: the moment the lead adds ``OFFBOARDING_COMPLETED`` to the
    catalogue (the exact lines are in the Phase 7 integration request) this
    starts sending, and until then it is a debug log rather than an
    ``AttributeError`` at the end of a completion that already revoked
    somebody's devices. It is deliberately not a hand-rolled ``email.send``:
    ``dispatch`` is the one door every alert goes through, and going around it
    would cost the opt-out, the de-duplication and the delivery log.

    Called after the commit, never before. ``dispatch`` writes and commits its
    own claim row and rolls the session back when another runner won the same
    key — which would discard an uncommitted completion sitting in the same
    session. Commit first, alert second, and swallow anything that goes wrong:
    an exit that completed and then 500'd on a mail server is worse than an
    alert nobody received.
    """
    kind = getattr(notif.Kind, "OFFBOARDING_COMPLETED", None)
    if kind is None:
        log.debug(
            "offboarding %s completed; no OFFBOARDING_COMPLETED alert kind registered",
            req.id,
        )
        return

    recipients: dict[uuid.UUID, User] = {}
    if leaver.manager_id:
        manager = db.get(User, leaver.manager_id)
        if manager is not None and manager.org_id == req.org_id and manager.is_active:
            recipients[manager.id] = manager
    # Administrators stand in for "IT" until the product has an IT desk:
    # ClearanceOwnerRole.IT is a workflow fact, not a role anybody holds here,
    # so there is nobody else to address.
    for admin in notif.recipients_for(db, req.org_id, notif.Audience.ADMIN):
        recipients.setdefault(admin.id, admin)
    recipients.pop(actor.id, None)

    subject = f"Exit completed: {leaver.full_name}"
    body = (
        f"{leaver.full_name} was offboarded with a last working day of "
        f"{req.last_working_day}. Their account is deactivated and their devices "
        "are revoked.\n"
    )
    for recipient in recipients.values():
        try:
            notif.dispatch(db, recipient, kind, f"offboarding-completed:{req.id}",
                           subject, body)
        except Exception:  # noqa: BLE001 - a mail failure must not fail the exit
            db.rollback()
