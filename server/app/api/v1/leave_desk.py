"""The HR leave desk: every request, every balance, and who is off when, in one place.

Scope is always ``visible_user_ids``: an administrator sees the whole company, a manager their
reporting line. Nothing here defines its own idea of "the team".
"""

from __future__ import annotations

import calendar
import uuid
from datetime import date, timedelta

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import AdminUser, DbSession, TeamViewer, audit, visible_user_ids
from app.models import LeaveApplication, LeaveBalance, LeaveType, User
from app.models.leave import LeaveStatus
from app.services import chains, leave as svc

router = APIRouter(prefix="/leave", tags=["leave"])

MILLI = 1000


def _scope(db, viewer: User) -> list[User]:
    allowed = visible_user_ids(db, viewer)
    stmt = select(User).where(User.org_id == viewer.org_id, User.is_active.is_(True))
    if allowed is not None:
        stmt = stmt.where((User.id.in_(allowed)) | (User.id == viewer.id))
    return list(db.scalars(stmt.order_by(User.full_name)))


def _year_label(year: int, start_month: int) -> str:
    return str(year) if start_month == 1 else f"{year}–{str(year + 1)[-2:]}"


@router.get("/people")
def people(viewer: TeamViewer, db: DbSession) -> list[dict]:
    """Who the viewer may file leave for: themselves and the people they see."""
    return [{"id": str(u.id), "name": u.full_name, "code": u.employee_code} for u in _scope(db, viewer)]


@router.get("/requests")
def requests(
    viewer: TeamViewer, db: DbSession, status_filter: str = Query(default="all", alias="status"),
) -> dict:
    users = {u.id: u for u in _scope(db, viewer)}
    rows = list(db.scalars(
        select(LeaveApplication).where(LeaveApplication.org_id == viewer.org_id, LeaveApplication.user_id.in_(list(users)))
        .order_by(LeaveApplication.applied_at.desc())))
    counts = {s.value: 0 for s in LeaveStatus}
    for r in rows:
        counts[r.status] = counts.get(r.status, 0) + 1
    items = []
    for r in rows:
        if status_filter != "all" and r.status != status_filter:
            continue
        person = users.get(r.user_id)
        waiting = False
        if r.status == LeaveStatus.PENDING.value and r.user_id != viewer.id:
            waiting = bool(
                viewer.role_enum.can_administer
                or (person is not None and person.manager_id == viewer.id)
                or chains.is_current_reviewer(db, r.id, viewer)
            )
        items.append({
            "id": str(r.id), "user_id": str(r.user_id), "name": person.full_name if person else "",
            "code": person.employee_code if person else None,
            "leave_type": r.leave_type.name if r.leave_type else "Leave", "color": r.leave_type.color if r.leave_type else None,
            "start_date": r.start_date.isoformat(), "end_date": r.end_date.isoformat(),
            "is_half_day": r.is_half_day, "half_day_session": r.half_day_session,
            "duration_milli_days": r.duration_milli_days, "reason": r.reason, "contact_phone": r.contact_phone,
            "status": r.status, "applied_at": r.applied_at.isoformat(), "review_note": r.review_note,
            "waiting_on_me": waiting,
        })
    return {"counts": counts, "waiting_on_me": sum(1 for i in items if i["waiting_on_me"]), "items": items}


@router.get("/preview")
def preview(
    viewer: TeamViewer, db: DbSession, user_id: uuid.UUID, leave_type_id: uuid.UUID,
    start: date, end: date, half: bool = False,
) -> dict:
    """What a range would cost this person, and what they have to spend it from."""
    person = next((u for u in _scope(db, viewer) if u.id == user_id), None)
    leave_type = db.get(LeaveType, leave_type_id)
    if person is None or leave_type is None or leave_type.org_id != viewer.org_id:
        raise HTTPException(404, "Not found")
    if end < start:
        end = start
    resolved = svc.resolve_settings(db, viewer.org_id)
    view = svc.balance_view(db, user=person, leave_type=leave_type, on=start, resolved=resolved)
    used = view.balance.used_milli_days if view.balance else 0
    return {
        "duration_milli_days": svc.compute_duration_milli_days(db, person, start, end, half),
        "available_milli_days": view.available_milli_days,
        "pending_milli_days": view.pending_milli_days,
        "used_milli_days": used,
        "allow_half_day": leave_type.allow_half_day,
    }


@router.get("/balances/matrix")
def matrix(viewer: TeamViewer, db: DbSession, year: int | None = None) -> dict:
    resolved = svc.resolve_settings(db, viewer.org_id)
    today = svc.org_today(db, viewer.org_id)
    current = svc.policy_year_for(today, resolved.leave_year_start_month)
    chosen = year or current
    types = list(db.scalars(select(LeaveType).where(LeaveType.org_id == viewer.org_id, LeaveType.is_active.is_(True)).order_by(LeaveType.name)))
    users = _scope(db, viewer)
    by_key = {
        (b.user_id, b.leave_type_id): b
        for b in db.scalars(select(LeaveBalance).where(
            LeaveBalance.org_id == viewer.org_id, LeaveBalance.user_id.in_([u.id for u in users]),
            LeaveBalance.year.in_([chosen, svc.COMP_OFF_BALANCE_YEAR])))
        if b.year == (svc.COMP_OFF_BALANCE_YEAR if next((t for t in types if t.id == b.leave_type_id and t.is_comp_off), None) else chosen)
    }
    rows = []
    for u in users:
        cells = {}
        for t in types:
            b = by_key.get((u.id, t.id))
            cells[str(t.id)] = {"balance": (b.balance_milli_days if b else 0), "entitled": (b.entitled_milli_days if b else 0)}
        rows.append({"user_id": str(u.id), "name": u.full_name, "code": u.employee_code,
                     "department": u.department_name, "cells": cells})
    return {
        "year": chosen,
        "years": [{"year": y, "label": _year_label(y, resolved.leave_year_start_month)} for y in (current - 1, current, current + 1)],
        "types": [{"id": str(t.id), "code": t.code or t.name[:3].upper(), "name": t.name, "color": t.color} for t in types],
        "rows": rows,
    }


class CarryIn(BaseModel):
    from_year: int = Field(ge=2000, le=2100)
    into_year: int = Field(ge=2000, le=2100)


@router.post("/carry-forward")
def carry_forward(payload: CarryIn, admin: AdminUser, db: DbSession, request: Request) -> dict:
    """Move what is left of each type into the next year's opening, up to the type's cap.

    Idempotent: the opening is *set* to the carried figure, so running it again changes nothing.
    """
    if payload.into_year != payload.from_year + 1:
        raise HTTPException(422, "Carry forward moves one year into the next.")
    resolved = svc.resolve_settings(db, admin.org_id)
    types = list(db.scalars(select(LeaveType).where(
        LeaveType.org_id == admin.org_id, LeaveType.is_active.is_(True), LeaveType.is_comp_off.is_(False))))
    carried_total = lapsed_total = people = 0
    for person in db.scalars(select(User).where(User.org_id == admin.org_id, User.is_active.is_(True))):
        touched = False
        for t in types:
            prev = svc.get_balance(db, user_id=person.id, leave_type_id=t.id, year=payload.from_year)
            if prev is None:
                continue
            left = max(0, prev.balance_milli_days)
            if not resolved.carry_forward_enabled:
                cap = 0
            elif t.carry_forward_all:
                cap = left
            else:
                cap = t.carry_forward_limit_milli_days
            carry = min(left, cap)
            svc.ensure_balance_row(db, org_id=admin.org_id, user_id=person.id, leave_type_id=t.id, year=payload.into_year)
            target = svc.get_balance(db, user_id=person.id, leave_type_id=t.id, year=payload.into_year)
            if target is not None and target.opening_milli_days != carry:
                target.opening_milli_days = carry
            carried_total += carry
            lapsed_total += left - carry
            touched = touched or carry > 0
        people += touched
    audit(db, org_id=admin.org_id, actor=admin, action="leave.carry_forward", request=request,
          target_type="leave_balance", target_id=f"{payload.from_year}->{payload.into_year}",
          detail={"carried_milli_days": carried_total, "lapsed_milli_days": lapsed_total})
    db.commit()
    return {"people": people, "carried_milli_days": carried_total, "lapsed_milli_days": lapsed_total}


@router.get("/calendar")
def leave_calendar(viewer: TeamViewer, db: DbSession, year: int = Query(ge=2000, le=2100), month: int = Query(ge=1, le=12)) -> dict:
    first = date(year, month, 1)
    last = date(year, month, calendar.monthrange(year, month)[1])
    users = {u.id: u for u in _scope(db, viewer)}
    rows = db.scalars(select(LeaveApplication).where(
        LeaveApplication.org_id == viewer.org_id, LeaveApplication.user_id.in_(list(users)),
        LeaveApplication.status.in_([LeaveStatus.APPROVED.value, LeaveStatus.PENDING.value]),
        LeaveApplication.start_date <= last, LeaveApplication.end_date >= first))
    return {"items": [{
        "id": str(r.id), "user_id": str(r.user_id), "name": users[r.user_id].full_name,
        "department": users[r.user_id].department_name,
        "leave_type": r.leave_type.name if r.leave_type else "Leave", "color": r.leave_type.color if r.leave_type else "#0ea5e9",
        "start_date": r.start_date.isoformat(), "end_date": r.end_date.isoformat(),
        "status": r.status, "is_half_day": r.is_half_day,
    } for r in rows]}
