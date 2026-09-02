"""Leave: types, holiday calendar, balances, applications and approvals.

Written as a sibling of ``timesheets.py`` on purpose — the merged approvals
inbox (§9.4) renders leave rows next to timesheet rows, and two approval flows
that read differently become two approval flows that behave differently. Same
``_target_user`` scoping, same "decide, commit, then queue the mail" ordering,
same background-task pattern for anything that talks to SMTP.

Every rule lives in ``app.services.leave``. This file resolves who is asking,
who they are asking about, and turns a :class:`~app.services.leave.LeaveError`
into a typed HTTP response. A handler here that contains a leave rule is a bug.

**The approver dependency is defined here, not in ``deps.py``.** ``deps.py`` is
the lead's file; ``require_leave_approver`` is three lines composed from the
primitives it already exports, so it lives with its only caller until the lead
decides to promote it. It is deliberately built on ``can_approve_leave`` rather
than ``can_approve_timesheets``: D-002 made them separate flags because the team
lead who signs off "you were in the office at 09:15" is routinely not the person
who signs off "you may take nine days off" — only one of those spends a balance.
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Annotated, NoReturn

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, status
from sqlalchemy import func, select

from app.api.deps import (
    AdminUser,
    CurrentUser,
    DbSession,
    TeamViewer,
    audit,
    deny_page,
    deny_unless,
    visible_user_ids,
)
from app.db.session import SessionLocal
from app.models import (
    CompOffCredit,
    Holiday,
    LeaveApplication,
    LeaveSettings,
    LeaveStatus,
    LeaveType,
    OptionalHolidayOptIn,
    Role,
    User,
)
from app.models.leave import MILLI_DAYS_PER_DAY
from app.schemas.leave import (
    CompOffCreditIn,
    CompOffCreditOut,
    HolidayIn,
    HolidayOut,
    HolidayUptakeOut,
    LeaveApplicationOut,
    LeaveApplyIn,
    LeaveBalanceAdjustIn,
    LeaveBalanceOut,
    LeaveCancelIn,
    LeaveDecisionIn,
    LeaveOverviewOut,
    LeaveSettingsIn,
    LeaveSettingsOut,
    LeaveTypeIn,
    LeaveTypeOut,
    LeaveTypeTallyOut,
    MonthTallyOut,
    OnLeaveOut,
    OptionalHolidayOptInIn,
    OptionalHolidayOptInOut,
)
from app.services import leave as svc

router = APIRouter(prefix="/leave", tags=["leave"])


# --------------------------------------------------------------------------- #
# Dependencies and small shared resolvers
# --------------------------------------------------------------------------- #


def require_leave_approver(user: TeamViewer) -> User:
    """Sees the team AND may spend their balances. See the module docstring."""
    deny_unless(user, "can_approve_leave", "approve leave")
    return user


LeaveApprover = Annotated[User, Depends(require_leave_approver)]


def _fail(error: svc.LeaveError) -> NoReturn:
    """Turn a service refusal into a response the console can branch on.

    The ``reason`` code, not the sentence: the UI shows a different form for
    "no balance left" than for "that overlaps existing leave", and matching on
    prose breaks the first time somebody improves the wording.
    """
    raise HTTPException(
        error.status_code, detail={"reason": error.code, "message": error.message}
    )


def _target_user(db, viewer: User, user_id: uuid.UUID | None) -> User:
    """Resolve whose leave this is, and refuse if out of scope.

    Identical in shape to ``timesheets._target_user``. Duplicated rather than
    shared because that one lives in another engineer's router; if a third
    module needs it, it belongs in ``deps.py`` and the lead should move it.
    """
    if user_id is None or user_id == viewer.id:
        return viewer
    target = db.get(User, user_id)
    if target is None or target.org_id != viewer.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Employee not found")
    allowed = visible_user_ids(db, viewer)
    if allowed is not None and user_id not in allowed:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not permitted for this employee")
    return target


def _leave_type(db, org_id: uuid.UUID, leave_type_id: uuid.UUID) -> LeaveType:
    leave_type = db.get(LeaveType, leave_type_id)
    if leave_type is None or leave_type.org_id != org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Leave type not found")
    return leave_type


def _application(db, org_id: uuid.UUID, application_id: uuid.UUID) -> LeaveApplication:
    application = db.get(LeaveApplication, application_id)
    if application is None or application.org_id != org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Leave application not found")
    return application


def _names(db, org_id: uuid.UUID) -> dict[uuid.UUID, str]:
    return {
        u.id: u.full_name
        for u in db.scalars(select(User).where(User.org_id == org_id)).all()
    }


# --------------------------------------------------------------------------- #
# Settings (D-009: a missing row is legal and means the defaults)
# --------------------------------------------------------------------------- #


@router.get("/settings", response_model=LeaveSettingsOut)
def read_settings(viewer: CurrentUser, db: DbSession) -> LeaveSettingsOut:
    resolved = svc.resolve_settings(db, viewer.org_id)
    return LeaveSettingsOut(
        org_id=resolved.org_id,
        leave_year_start_month=resolved.leave_year_start_month,
        optional_holiday_quota=resolved.optional_holiday_quota,
        is_configured=resolved.is_configured,
        optional_holidays_are_unlimited=resolved.optional_holidays_are_unlimited,
    )


@router.put("/settings", response_model=LeaveSettingsOut)
def write_settings(
    payload: LeaveSettingsIn, viewer: AdminUser, request: Request, db: DbSession
) -> LeaveSettingsOut:
    """The only place a ``leave_settings`` row is created. Never on a read."""
    row = db.get(LeaveSettings, viewer.org_id)
    if row is None:
        row = LeaveSettings(org_id=viewer.org_id)
        db.add(row)
    row.leave_year_start_month = payload.leave_year_start_month
    row.optional_holiday_quota = payload.optional_holiday_quota
    audit(
        db, org_id=viewer.org_id, actor=viewer, action="leave.settings_updated",
        request=request, target_type="leave_settings", target_id=str(viewer.org_id),
        detail=payload.model_dump(),
    )
    db.commit()
    return read_settings(viewer, db)


# --------------------------------------------------------------------------- #
# Leave types
# --------------------------------------------------------------------------- #


def _type_out(leave_type: LeaveType) -> LeaveTypeOut:
    out = LeaveTypeOut.model_validate(leave_type)
    out.accrual_rate_days = leave_type.accrual_rate_milli_days / MILLI_DAYS_PER_DAY
    return out


def _guard_comp_off_type(db, org_id: uuid.UUID, payload: LeaveTypeIn, current_id=None) -> None:
    """At most one comp-off type per org, and it never accrues on a schedule.

    Both halves close D-022. A second comp-off type would give the credit ledger
    two projections to keep in step, and a comp-off type with a monthly accrual
    would hand ``accrued_milli_days`` a second writer — the very thing the
    ruling exists to prevent, arriving through the type editor rather than
    through the balance.
    """
    if not payload.is_comp_off:
        return
    if payload.accrual_type != "none":
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "reason": "comp_off_accrual",
                "message": (
                    "A comp-off type must have accrual_type 'none'. Its balance "
                    "comes from comp-off credits, which are its only writer."
                ),
            },
        )
    stmt = select(LeaveType).where(
        LeaveType.org_id == org_id, LeaveType.is_comp_off.is_(True)
    )
    if current_id is not None:
        stmt = stmt.where(LeaveType.id != current_id)
    existing = db.scalars(stmt).first()
    if existing is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "reason": "comp_off_exists",
                "message": f"{existing.name} is already this organisation's comp-off type",
            },
        )


@router.get("/types", response_model=list[LeaveTypeOut])
def list_types(
    viewer: CurrentUser, db: DbSession, include_inactive: bool = False
) -> list[LeaveTypeOut]:
    deny_page(viewer, "leave")
    stmt = select(LeaveType).where(LeaveType.org_id == viewer.org_id)
    if not include_inactive:
        stmt = stmt.where(LeaveType.is_active.is_(True))
    rows = db.scalars(stmt.order_by(LeaveType.name)).all()
    return [_type_out(row) for row in rows]


@router.post("/types", response_model=LeaveTypeOut, status_code=status.HTTP_201_CREATED)
def create_type(
    payload: LeaveTypeIn, viewer: AdminUser, request: Request, db: DbSession
) -> LeaveTypeOut:
    _guard_comp_off_type(db, viewer.org_id, payload)
    leave_type = LeaveType(org_id=viewer.org_id, **payload.model_dump())
    db.add(leave_type)
    db.flush()
    audit(
        db, org_id=viewer.org_id, actor=viewer, action="leave.type_created",
        request=request, target_type="leave_type", target_id=str(leave_type.id),
        detail={"name": payload.name, "code": payload.code},
    )
    db.commit()
    return _type_out(leave_type)


@router.put("/types/{leave_type_id}", response_model=LeaveTypeOut)
def update_type(
    leave_type_id: uuid.UUID,
    payload: LeaveTypeIn,
    viewer: AdminUser,
    request: Request,
    db: DbSession,
) -> LeaveTypeOut:
    leave_type = _leave_type(db, viewer.org_id, leave_type_id)
    _guard_comp_off_type(db, viewer.org_id, payload, current_id=leave_type.id)
    for field, value in payload.model_dump().items():
        setattr(leave_type, field, value)
    audit(
        db, org_id=viewer.org_id, actor=viewer, action="leave.type_updated",
        request=request, target_type="leave_type", target_id=str(leave_type.id),
        detail=payload.model_dump(),
    )
    db.commit()
    return _type_out(leave_type)


# --------------------------------------------------------------------------- #
# Holiday calendar and optional-holiday opt-ins
# --------------------------------------------------------------------------- #


@router.get("/holidays", response_model=list[HolidayOut])
def list_holidays(
    viewer: CurrentUser,
    db: DbSession,
    year: int | None = Query(default=None, ge=2000, le=2200),
    include_inactive: bool = False,
) -> list[HolidayOut]:
    """The calendar, annotated with this employee's own optional-holiday choices.

    ``opted_in`` is answered for the person asking. An optional holiday is not a
    holiday for anyone who did not choose it, so a calendar that cannot say
    which ones *this* employee is off for is a calendar nobody can plan against.

    **Deliberately not behind ``deny_page("leave")``**, unlike every other read
    in this module. When the office is shut is company-wide information, not
    leave-balance data: an employee switched out of the Leave page still needs to
    know the building is closed on Friday, and the home screen's next-holiday
    card is for exactly that. Hiding a page must not hide a public fact.

    Nothing here is scoped to the viewer's balances, so there is no leave data to
    leak — only the org's calendar and this person's own opt-ins.
    """
    resolved = svc.resolve_settings(db, viewer.org_id)
    stmt = select(Holiday).where(Holiday.org_id == viewer.org_id)
    if not include_inactive:
        stmt = stmt.where(Holiday.is_active.is_(True))
    if year is not None:
        start, end = svc.policy_year_bounds(year, resolved.leave_year_start_month)
        stmt = stmt.where(Holiday.holiday_date >= start, Holiday.holiday_date <= end)
    rows = db.scalars(stmt.order_by(Holiday.holiday_date, Holiday.name)).all()

    opted_in = set(
        db.scalars(
            select(OptionalHolidayOptIn.holiday_id).where(
                OptionalHolidayOptIn.user_id == viewer.id
            )
        ).all()
    )
    counts: dict[uuid.UUID, int] = {}
    if viewer.role_enum.can_administer:
        for holiday_id in db.scalars(
            select(OptionalHolidayOptIn.holiday_id).where(
                OptionalHolidayOptIn.org_id == viewer.org_id
            )
        ).all():
            counts[holiday_id] = counts.get(holiday_id, 0) + 1

    out = []
    for row in rows:
        item = HolidayOut.model_validate(row)
        item.opted_in = row.is_optional and row.id in opted_in
        # Only for the admin calendar view: computing an aggregate on every
        # employee's calendar load buys nothing anybody reads.
        item.opt_in_count = counts.get(row.id, 0) if viewer.role_enum.can_administer else None
        out.append(item)
    return out


@router.post("/holidays", response_model=HolidayOut, status_code=status.HTTP_201_CREATED)
def create_holiday(
    payload: HolidayIn, viewer: AdminUser, request: Request, db: DbSession
) -> HolidayOut:
    holiday = Holiday(org_id=viewer.org_id, **payload.model_dump())
    db.add(holiday)
    db.flush()
    audit(
        db, org_id=viewer.org_id, actor=viewer, action="leave.holiday_created",
        request=request, target_type="holiday", target_id=str(holiday.id),
        detail={"date": payload.holiday_date.isoformat(), "name": payload.name},
    )
    db.commit()
    return HolidayOut.model_validate(holiday)


# Declared before the ``/holidays/{holiday_id}`` routes on purpose: FastAPI
# matches in declaration order, so a path parameter above these would swallow
# "opt-ins" and answer an employee's own opt-in call with an admin guard.
@router.get("/holidays/opt-ins", response_model=list[OptionalHolidayOptInOut])
def list_opt_ins(
    viewer: CurrentUser, db: DbSession, user_id: uuid.UUID | None = None
) -> list[OptionalHolidayOptInOut]:
    target = _target_user(db, viewer, user_id)
    rows = db.scalars(
        select(OptionalHolidayOptIn).where(OptionalHolidayOptIn.user_id == target.id)
    ).all()
    out = []
    for row in rows:
        item = OptionalHolidayOptInOut.model_validate(row)
        item.holiday_date = row.holiday.holiday_date if row.holiday else None
        item.holiday_name = row.holiday.name if row.holiday else None
        out.append(item)
    return out


@router.put("/holidays/opt-ins", response_model=list[OptionalHolidayOptInOut])
def replace_opt_ins(
    payload: OptionalHolidayOptInIn, viewer: CurrentUser, request: Request, db: DbSession
) -> list[OptionalHolidayOptInOut]:
    """Replace the whole set, because the policy is "pick N of these".

    Add/remove endpoints would mean validating N against a set the client sends
    piecemeal, so every partial state on the way to a legal one has to be legal
    too — and the quota check would have to pass on a set that is momentarily
    over it.
    """
    resolved = svc.resolve_settings(db, viewer.org_id)
    wanted = set(payload.holiday_ids)
    if wanted:
        valid = set(
            db.scalars(
                select(Holiday.id).where(
                    Holiday.id.in_(wanted),
                    Holiday.org_id == viewer.org_id,
                    Holiday.is_optional.is_(True),
                    Holiday.is_active.is_(True),
                )
            ).all()
        )
        missing = wanted - valid
        if missing:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={
                    "reason": "not_optional_holiday",
                    "message": "One or more of those holidays is not an active "
                               "optional holiday in this organisation",
                },
            )
    if (
        not resolved.optional_holidays_are_unlimited
        and len(wanted) > resolved.optional_holiday_quota
    ):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "reason": "quota_exceeded",
                "message": (
                    f"You may opt into {resolved.optional_holiday_quota} optional "
                    f"holidays; you chose {len(wanted)}"
                ),
            },
        )

    existing = {
        row.holiday_id: row
        for row in db.scalars(
            select(OptionalHolidayOptIn).where(OptionalHolidayOptIn.user_id == viewer.id)
        ).all()
    }
    for holiday_id, row in existing.items():
        if holiday_id not in wanted:
            db.delete(row)
    for holiday_id in wanted - set(existing):
        db.add(
            OptionalHolidayOptIn(
                org_id=viewer.org_id, user_id=viewer.id, holiday_id=holiday_id
            )
        )
    audit(
        db, org_id=viewer.org_id, actor=viewer, action="leave.opt_ins_replaced",
        request=request, target_type="user", target_id=str(viewer.id),
        detail={"holiday_ids": [str(h) for h in sorted(wanted, key=str)]},
    )
    db.commit()
    return list_opt_ins(viewer, db, None)


@router.put("/holidays/{holiday_id}", response_model=HolidayOut)
def update_holiday(
    holiday_id: uuid.UUID,
    payload: HolidayIn,
    viewer: AdminUser,
    request: Request,
    db: DbSession,
) -> HolidayOut:
    """Editing the calendar never re-prices leave that has already been applied for.

    ``leave_applications.duration_milli_days`` was frozen at apply time (D-013),
    so adding a holiday inside an approved range changes what future
    applications cost and nothing else. That is the point of freezing it: the
    debit and the eventual credit-back are the same number even though the
    calendar underneath them moved.
    """
    holiday = db.get(Holiday, holiday_id)
    if holiday is None or holiday.org_id != viewer.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Holiday not found")
    for field, value in payload.model_dump().items():
        setattr(holiday, field, value)
    audit(
        db, org_id=viewer.org_id, actor=viewer, action="leave.holiday_updated",
        request=request, target_type="holiday", target_id=str(holiday.id),
        detail=payload.model_dump(),
    )
    db.commit()
    return HolidayOut.model_validate(holiday)


@router.delete(
    "/holidays/{holiday_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None
)
def delete_holiday(
    holiday_id: uuid.UUID, viewer: AdminUser, request: Request, db: DbSession
) -> None:
    holiday = db.get(Holiday, holiday_id)
    if holiday is None or holiday.org_id != viewer.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Holiday not found")
    audit(
        db, org_id=viewer.org_id, actor=viewer, action="leave.holiday_deleted",
        request=request, target_type="holiday", target_id=str(holiday.id),
        detail={"date": holiday.holiday_date.isoformat(), "name": holiday.name},
    )
    db.delete(holiday)
    db.commit()


# --------------------------------------------------------------------------- #
# Balances
# --------------------------------------------------------------------------- #


def _balance_out(
    *, user: User, leave_type: LeaveType, view: svc.BalanceView, user_name: str
) -> LeaveBalanceOut:
    """One row per type, present or not.

    A type with no ``leave_balances`` row yet is rendered as a zeroed balance
    rather than omitted: the employee needs to see that Sick Leave exists and
    stands at zero, and a read that created the row to say so would be a GET
    that writes.
    """
    balance = view.balance
    out = LeaveBalanceOut(
        id=balance.id if balance else uuid.UUID(int=0),
        user_id=user.id,
        leave_type_id=leave_type.id,
        year=view.year,
        opening_milli_days=balance.opening_milli_days if balance else 0,
        accrued_milli_days=balance.accrued_milli_days if balance else 0,
        used_milli_days=balance.used_milli_days if balance else 0,
        adjusted_milli_days=balance.adjusted_milli_days if balance else 0,
        balance_milli_days=view.balance_milli_days,
        entitled_milli_days=balance.entitled_milli_days if balance else 0,
        pending_milli_days=view.pending_milli_days,
        available_milli_days=view.available_milli_days,
        balance_days=view.balance_milli_days / MILLI_DAYS_PER_DAY,
        available_days=view.available_milli_days / MILLI_DAYS_PER_DAY,
        user_name=user_name,
        leave_type_name=leave_type.name,
        leave_type_code=leave_type.code,
        is_paid=leave_type.is_paid,
        adjusted_reason=balance.adjusted_reason if balance else None,
        adjusted_by_user_id=balance.adjusted_by_user_id if balance else None,
        adjusted_at=balance.adjusted_at if balance else None,
    )
    return out


@router.get("/balances", response_model=list[LeaveBalanceOut])
def list_balances(
    viewer: CurrentUser,
    db: DbSession,
    user_id: uuid.UUID | None = None,
    on: date | None = None,
) -> list[LeaveBalanceOut]:
    """One employee's balances for the policy year containing ``on`` (default today)."""
    deny_page(viewer, "leave")
    target = _target_user(db, viewer, user_id)
    resolved = svc.resolve_settings(db, viewer.org_id)
    day = on or svc.org_today(db, viewer.org_id)
    types = db.scalars(
        select(LeaveType)
        .where(LeaveType.org_id == viewer.org_id, LeaveType.is_active.is_(True))
        .order_by(LeaveType.name)
    ).all()
    return [
        _balance_out(
            user=target,
            leave_type=leave_type,
            view=svc.balance_view(
                db, user=target, leave_type=leave_type, on=day, resolved=resolved
            ),
            user_name=target.full_name,
        )
        for leave_type in types
    ]


@router.post("/balances/adjust", response_model=LeaveBalanceOut)
def adjust_balance(
    payload: LeaveBalanceAdjustIn,
    viewer: LeaveApprover,
    request: Request,
    db: DbSession,
) -> LeaveBalanceOut:
    """A signed, reasoned correction. Always writes an ``AuditLog`` row.

    Admin plus ``can_approve_leave``: an adjustment is the one write that can
    conjure entitlement out of nothing, so it is held to the stricter of the two
    gates rather than either alone.
    """
    if not viewer.role_enum.can_administer:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Administrator role required to adjust a balance"
        )
    target = _target_user(db, viewer, payload.user_id)
    leave_type = _leave_type(db, viewer.org_id, payload.leave_type_id)
    try:
        svc.adjust_balance(
            db,
            org_id=viewer.org_id,
            user_id=target.id,
            leave_type=leave_type,
            year=payload.year,
            delta_milli_days=payload.delta_milli_days,
            reason=payload.reason,
            actor=viewer,
        )
    except svc.LeaveError as error:
        db.rollback()
        _fail(error)
    db.commit()

    resolved = svc.resolve_settings(db, viewer.org_id)
    start, _ = svc.policy_year_bounds(payload.year, resolved.leave_year_start_month)
    return _balance_out(
        user=target,
        leave_type=leave_type,
        view=svc.balance_view(
            db, user=target, leave_type=leave_type, on=start, resolved=resolved
        ),
        user_name=target.full_name,
    )


# --------------------------------------------------------------------------- #
# Applications
# --------------------------------------------------------------------------- #


def _application_out(
    application: LeaveApplication,
    *,
    names: dict[uuid.UUID, str],
    leave_type_name: str | None = None,
    balance_after: int | None = None,
) -> LeaveApplicationOut:
    out = LeaveApplicationOut.model_validate(application)
    out.duration_days = application.duration_milli_days / MILLI_DAYS_PER_DAY
    out.user_name = names.get(application.user_id)
    out.leave_type_name = leave_type_name or (
        application.leave_type.name if application.leave_type else None
    )
    out.reviewed_by_name = names.get(application.reviewed_by_user_id)
    out.balance_after_milli_days = balance_after
    return out


@router.get("/applications", response_model=list[LeaveApplicationOut])
def list_applications(
    viewer: CurrentUser,
    db: DbSession,
    user_id: uuid.UUID | None = None,
    status_filter: str | None = Query(default=None, alias="status"),
    start: date | None = None,
    end: date | None = None,
) -> list[LeaveApplicationOut]:
    deny_page(viewer, "leave")
    target = _target_user(db, viewer, user_id)
    stmt = select(LeaveApplication).where(
        LeaveApplication.org_id == viewer.org_id,
        LeaveApplication.user_id == target.id,
    )
    if status_filter:
        stmt = stmt.where(LeaveApplication.status == status_filter)
    if start:
        stmt = stmt.where(LeaveApplication.end_date >= start)
    if end:
        stmt = stmt.where(LeaveApplication.start_date <= end)
    rows = db.scalars(stmt.order_by(LeaveApplication.start_date.desc())).all()
    names = _names(db, viewer.org_id)
    return [_application_out(row, names=names) for row in rows]


@router.get("/applications/review", response_model=list[LeaveApplicationOut])
def review_queue(
    viewer: LeaveApprover,
    db: DbSession,
    status_filter: str = Query(default=LeaveStatus.PENDING.value, alias="status"),
) -> list[LeaveApplicationOut]:
    """Everything in this approver's scope awaiting a decision.

    Scope comes from ``hierarchy.visible_user_ids`` — the reporting subtree plus
    any team or department this person heads — rather than from a second rule
    written here. There is exactly one answer in this codebase to "whose data
    may this manager see", and it is not this file's to redefine.
    """
    scope = visible_user_ids(db, viewer)
    stmt = select(LeaveApplication).where(
        LeaveApplication.org_id == viewer.org_id,
        LeaveApplication.status == status_filter,
    )
    if scope is not None:
        stmt = stmt.where(LeaveApplication.user_id.in_(scope))
    rows = db.scalars(stmt.order_by(LeaveApplication.start_date)).all()

    names = _names(db, viewer.org_id)
    resolved = svc.resolve_settings(db, viewer.org_id)
    out = []
    for row in rows:
        employee = db.get(User, row.user_id)
        leave_type = db.get(LeaveType, row.leave_type_id)
        view = svc.balance_view(
            db, user=employee, leave_type=leave_type, on=row.start_date, resolved=resolved
        )
        # The manager sees what saying yes costs. A queue that shows the request
        # but not the balance behind it is a queue that approves people into
        # arrears.
        out.append(
            _application_out(
                row,
                names=names,
                leave_type_name=leave_type.name if leave_type else None,
                balance_after=view.balance_milli_days - row.duration_milli_days,
            )
        )
    return out


@router.post(
    "/applications", response_model=LeaveApplicationOut, status_code=status.HTTP_201_CREATED
)
def apply(
    payload: LeaveApplyIn,
    viewer: CurrentUser,
    request: Request,
    background: BackgroundTasks,
    db: DbSession,
    user_id: uuid.UUID | None = None,
) -> LeaveApplicationOut:
    """Apply for leave. ``user_id`` lets HR or a manager file on someone's behalf."""
    deny_page(viewer, "leave")
    target = _target_user(db, viewer, user_id)
    leave_type = _leave_type(db, viewer.org_id, payload.leave_type_id)
    try:
        application = svc.apply_for_leave(
            db,
            actor=viewer,
            employee=target,
            leave_type=leave_type,
            start_date=payload.start_date,
            end_date=payload.end_date,
            is_half_day=payload.is_half_day,
            half_day_session=payload.half_day_session,
            reason=payload.reason,
        )
    except svc.LeaveError as error:
        db.rollback()
        _fail(error)

    audit(
        db, org_id=viewer.org_id, actor=viewer, action="leave.applied",
        request=request, target_type="leave_application", target_id=str(application.id),
        detail={
            "for": str(target.id),
            "leave_type": leave_type.name,
            "range": f"{payload.start_date}..{payload.end_date}",
            "duration_milli_days": application.duration_milli_days,
        },
    )
    db.commit()

    application_id = application.id
    auto_approved = application.status == LeaveStatus.APPROVED.value
    _queue(background, application_id, applied=True, decided=auto_approved)
    return _application_out(application, names=_names(db, viewer.org_id))


@router.post("/applications/{application_id}/decision", response_model=LeaveApplicationOut)
def decide(
    application_id: uuid.UUID,
    payload: LeaveDecisionIn,
    viewer: LeaveApprover,
    request: Request,
    background: BackgroundTasks,
    db: DbSession,
) -> LeaveApplicationOut:
    """Approve or reject. Approval is the atomic balance debit (§3.2)."""
    application = _application(db, viewer.org_id, application_id)
    _target_user(db, viewer, application.user_id)

    # Self-review, already-decided and the audit row are the service's now, via
    # ``services.workflow``. This handler used to hold the self-review check
    # itself, which meant it applied to this route and to nothing else that
    # decided a leave application.
    try:
        svc.decide(
            db,
            application=application,
            reviewer=viewer,
            approve=payload.approve,
            note=payload.note,
            request=request,
        )
    except svc.LeaveError as error:
        db.rollback()
        _fail(error)

    db.commit()
    _queue(background, application.id, decided=True)
    return _application_out(application, names=_names(db, viewer.org_id))


@router.post("/applications/{application_id}/cancel", response_model=LeaveApplicationOut)
def cancel(
    application_id: uuid.UUID,
    payload: LeaveCancelIn,
    viewer: CurrentUser,
    request: Request,
    background: BackgroundTasks,
    db: DbSession,
) -> LeaveApplicationOut:
    """Withdraw an application. Credits the balance back if it was debited."""
    application = _application(db, viewer.org_id, application_id)
    if application.user_id != viewer.id and not viewer.role_enum.can_administer:
        # A manager can reject, not withdraw. Withdrawal is the employee's own
        # act, and an administrator's only because a mis-filed application has
        # to be fixable by somebody.
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Only the employee or an administrator can cancel"
        )
    try:
        svc.cancel(db, application=application, actor=viewer, reason=payload.reason)
    except svc.LeaveError as error:
        db.rollback()
        _fail(error)

    audit(
        db, org_id=viewer.org_id, actor=viewer, action="leave.cancelled",
        request=request, target_type="leave_application", target_id=str(application.id),
        detail={"for": str(application.user_id), "reason": payload.reason},
    )
    db.commit()
    _queue(background, application.id, cancelled=True)
    return _application_out(application, names=_names(db, viewer.org_id))


# --------------------------------------------------------------------------- #
# Comp-off credits
# --------------------------------------------------------------------------- #


def _credit_out(
    credit: CompOffCredit, *, names: dict[uuid.UUID, str], today: date
) -> CompOffCreditOut:
    out = CompOffCreditOut.model_validate(credit)
    out.credit_days = credit.credit_milli_days / MILLI_DAYS_PER_DAY
    out.user_name = names.get(credit.user_id)
    out.granted_by_name = names.get(credit.granted_by_user_id)
    # Computed against today rather than read from expired_at: a night the job
    # did not run must not present a dead credit as spendable.
    out.is_expired = credit.expires_at < today
    out.is_used = credit.used_in_application_id is not None
    return out


@router.get("/comp-offs", response_model=list[CompOffCreditOut])
def list_comp_offs(
    viewer: CurrentUser, db: DbSession, user_id: uuid.UUID | None = None
) -> list[CompOffCreditOut]:
    deny_page(viewer, "leave")
    target = _target_user(db, viewer, user_id)
    rows = db.scalars(
        select(CompOffCredit)
        .where(CompOffCredit.user_id == target.id)
        .order_by(CompOffCredit.expires_at)
    ).all()
    names = _names(db, viewer.org_id)
    today = svc.org_today(db, viewer.org_id)
    return [_credit_out(row, names=names, today=today) for row in rows]


@router.post(
    "/comp-offs", response_model=CompOffCreditOut, status_code=status.HTTP_201_CREATED
)
def grant_comp_off(
    payload: CompOffCreditIn,
    viewer: LeaveApprover,
    request: Request,
    db: DbSession,
) -> CompOffCreditOut:
    """Grant one comp-off credit. Never self-service.

    The credit and the projection into the comp-off balance land in one
    transaction — D-022: the ledger is the source of truth and the balance row
    follows it, always, in the same commit.
    """
    target = _target_user(db, viewer, payload.user_id)
    if target.id == viewer.id and viewer.role_enum is not Role.OWNER:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "You cannot grant yourself a comp-off"
        )
    try:
        credit = svc.grant_comp_off(
            db,
            org_id=viewer.org_id,
            employee=target,
            earned_date=payload.earned_date,
            credit_milli_days=payload.credit_milli_days,
            reason=payload.reason,
            expires_at=payload.expires_at,
            actor=viewer,
        )
    except svc.LeaveError as error:
        db.rollback()
        _fail(error)

    audit(
        db, org_id=viewer.org_id, actor=viewer, action="leave.comp_off_granted",
        request=request, target_type="comp_off_credit", target_id=str(credit.id),
        detail={"for": str(target.id), "credit_milli_days": payload.credit_milli_days},
    )
    db.commit()
    return _credit_out(
        credit, names=_names(db, viewer.org_id), today=svc.org_today(db, viewer.org_id)
    )


# --------------------------------------------------------------------------- #
# Alerts, queued after the commit
# --------------------------------------------------------------------------- #


def _queue(
    background: BackgroundTasks,
    application_id: uuid.UUID,
    *,
    applied: bool = False,
    decided: bool = False,
    cancelled: bool = False,
) -> None:
    """Send the leave alerts after the transaction that caused them committed.

    Queued rather than awaited for the reason ``timesheets._notify_decision``
    already gives: ``app.services.email`` is synchronous SMTP, and an approval
    must not crawl because the mail provider is having a bad afternoon. It also
    has to run outside the request's session — ``notifications.dispatch``
    commits, and a commit in the middle of the debit's transaction would release
    the balance lock early, which is the one thing this module must never do.
    """

    def _send() -> None:
        with SessionLocal() as fresh:
            application = fresh.get(LeaveApplication, application_id)
            if application is None:
                return
            if applied and application.status == LeaveStatus.PENDING.value:
                svc.notify_applied(fresh, application)
            if decided:
                svc.notify_decided(fresh, application)
                _maybe_low_balance(fresh, application)
            if cancelled:
                svc.notify_cancelled(fresh, application)

    background.add_task(_send)


def _maybe_low_balance(db, application: LeaveApplication) -> None:
    if application.status != LeaveStatus.APPROVED.value:
        return
    employee = db.get(User, application.user_id)
    leave_type = db.get(LeaveType, application.leave_type_id)
    if employee is None or leave_type is None:
        return
    resolved = svc.resolve_settings(db, application.org_id)
    view = svc.balance_view(
        db, user=employee, leave_type=leave_type, on=application.start_date, resolved=resolved
    )
    svc.notify_balance_low(db, employee, leave_type, view)


# --------------------------------------------------------------------------- #
# Workforce overview
# --------------------------------------------------------------------------- #


def _month_bounds(year: int, month: int) -> tuple[date, date]:
    start = date(year, month, 1)
    end = (date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)) - timedelta(days=1)
    return start, end


def _overlap_milli_days(
    application: LeaveApplication, window_start: date, window_end: date
) -> int:
    """The part of an application that falls inside a window.

    Applications straddle month boundaries — a five-day leave from the 30th runs
    into the next month — and attributing the whole of one to whichever month it
    started in would move days between months and leave the twelve monthly
    totals disagreeing with the year's.

    Split by *calendar* days rather than by working days. The stored
    ``duration_milli_days`` already excludes holidays and weekly offs and is
    frozen at apply time (see the note on that column), so it cannot be
    recomputed here without risking a different answer than the one the balance
    was actually debited by. Spreading it evenly across the span it covers keeps
    the months summing to exactly that frozen figure, which is the property a
    summary needs.
    """
    first = max(application.start_date, window_start)
    last = min(application.end_date, window_end)
    if first > last:
        return 0
    span = (application.end_date - application.start_date).days + 1
    if span <= 1:
        return application.duration_milli_days
    inside = (last - first).days + 1
    # Integer arithmetic throughout (D-012): milli-days never become floats.
    return application.duration_milli_days * inside // span


@router.get("/overview", response_model=LeaveOverviewOut)
def overview(
    viewer: TeamViewer,
    db: DbSession,
    year: int = Query(default=0, ge=0, le=2999),
    month: int = Query(default=0, ge=0, le=12),
    window_start: date | None = None,
    window_end: date | None = None,
) -> LeaveOverviewOut:
    """Leave across the people this viewer can see, for one year and month.

    One request for one page. The four blocks it returns — the month's usage by
    type, the year by month, optional-holiday uptake, and who is away in a given
    window — are four readings of the same rows, and four endpoints would mean
    four scope resolutions that could drift apart.

    Scope is ``visible_user_ids``: the reporting subtree plus any team or
    department this person heads — the same function the approvals queue and the
    org chart use. There is one answer in this codebase to "whose data may this
    manager see", and this is not the file that gets to redefine it.

    Approved applications only. A pending request is not leave that was taken,
    and counting it would make every chart on the page move when somebody
    applies and move back when they are refused.
    """
    deny_page(viewer, "leave")

    today = date.today()
    year = year or today.year
    month = month or today.month

    scope = visible_user_ids(db, viewer)
    people = select(User.id).where(User.org_id == viewer.org_id, User.is_active.is_(True))
    if scope is not None:
        people = people.where(User.id.in_(scope))
    scope_ids = list(db.scalars(people))

    if window_start is None or window_end is None:
        # This week, Monday to Sunday, when the caller does not say otherwise.
        window_start = today - timedelta(days=today.weekday())
        window_end = window_start + timedelta(days=6)
    if window_end < window_start:
        window_start, window_end = window_end, window_start

    blank_months = [MonthTallyOut(month=m, milli_days=0) for m in range(1, 13)]
    if not scope_ids:
        return LeaveOverviewOut(
            year=year, month=month, headcount=0, by_type=[], by_month=blank_months,
            optional_holidays=[], on_leave=[],
            window_start=window_start, window_end=window_end,
        )

    year_start = date(year, 1, 1)
    year_end = date(year, 12, 31)
    rows = db.scalars(
        select(LeaveApplication).where(
            LeaveApplication.org_id == viewer.org_id,
            LeaveApplication.user_id.in_(scope_ids),
            LeaveApplication.status == LeaveStatus.APPROVED.value,
            # Anything overlapping the year at all, so a leave that starts in
            # December and ends in January contributes its December half here.
            LeaveApplication.start_date <= year_end,
            LeaveApplication.end_date >= year_start,
        )
    ).all()

    types = {
        row.id: row
        for row in db.scalars(select(LeaveType).where(LeaveType.org_id == viewer.org_id))
    }
    names = _names(db, viewer.org_id)
    codes = {
        row[0]: row[1]
        for row in db.execute(
            select(User.id, User.employee_code).where(User.org_id == viewer.org_id)
        )
    }

    by_month = [0] * 12
    by_type: dict[uuid.UUID, int] = {}
    for index in range(12):
        start, end = _month_bounds(year, index + 1)
        for application in rows:
            share = _overlap_milli_days(application, start, end)
            if not share:
                continue
            by_month[index] += share
            if index + 1 == month:
                by_type[application.leave_type_id] = (
                    by_type.get(application.leave_type_id, 0) + share
                )

    # Every type the org has, including ones nobody used. A summary that
    # silently omits "sick leave: none this month" cannot be read as a summary
    # of sick leave. Ordered by usage then name, so what was used leads.
    tallies = [
        LeaveTypeTallyOut(
            leave_type_id=type_id,
            code=leave_type.code,
            name=leave_type.name,
            milli_days=by_type.get(type_id, 0),
        )
        for type_id, leave_type in types.items()
    ]
    tallies.sort(key=lambda tally: (-tally.milli_days, tally.name.lower()))

    holidays = db.scalars(
        select(Holiday)
        .where(
            Holiday.org_id == viewer.org_id,
            Holiday.is_optional.is_(True),
            Holiday.holiday_date >= year_start,
            Holiday.holiday_date <= year_end,
        )
        .order_by(Holiday.holiday_date)
    ).all()
    uptake: dict[uuid.UUID, int] = {}
    if holidays:
        uptake = {
            row[0]: int(row[1])
            for row in db.execute(
                select(
                    OptionalHolidayOptIn.holiday_id,
                    func.count(OptionalHolidayOptIn.user_id),
                )
                .where(
                    OptionalHolidayOptIn.holiday_id.in_([h.id for h in holidays]),
                    OptionalHolidayOptIn.user_id.in_(scope_ids),
                )
                .group_by(OptionalHolidayOptIn.holiday_id)
            )
        }

    on_leave = [
        OnLeaveOut(
            user_id=application.user_id,
            user_name=names.get(application.user_id, "—"),
            employee_code=codes.get(application.user_id),
            leave_type_name=(
                types[application.leave_type_id].name
                if application.leave_type_id in types
                else "Leave"
            ),
            start_date=application.start_date,
            end_date=application.end_date,
            milli_days=application.duration_milli_days,
            is_half_day=application.is_half_day,
        )
        for application in rows
        if application.start_date <= window_end and application.end_date >= window_start
    ]
    on_leave.sort(key=lambda row: (row.start_date, row.user_name.lower()))

    return LeaveOverviewOut(
        year=year,
        month=month,
        headcount=len(scope_ids),
        by_type=tallies,
        by_month=[
            MonthTallyOut(month=index + 1, milli_days=value)
            for index, value in enumerate(by_month)
        ],
        optional_holidays=[
            HolidayUptakeOut(
                holiday_id=holiday.id,
                name=holiday.name,
                holiday_date=holiday.holiday_date,
                employees=uptake.get(holiday.id, 0),
            )
            for holiday in holidays
        ],
        on_leave=on_leave,
        window_start=window_start,
        window_end=window_end,
    )
