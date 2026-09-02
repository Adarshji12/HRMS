"""Punching, attendance history, office geofences, shifts and the rota.

Thin handlers throughout: every rule — the geofence policy, the duplicate-punch
refusal, the D-014 lockout guard, the worked-minutes cap — lives in
``app.services.attendance``. A router function here decides who may call it and
what shape comes back, and nothing else.

The one piece of routing that is genuinely this file's business is the punch
credential. Spec §7 requires ``POST /attendance/punch/in`` and ``/punch/out`` to
accept **a device token or a user JWT**, using the dependency-composition style
``deps.py`` already uses for "either of these" — a phone or browser punch
carries the user's JWT, and a desk employee's agent could eventually punch with
the device token it already holds. Hard-coding either one would mean shipping
half the product. See :func:`punch_actor`.
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from sqlalchemy import func, select

from app.api.deps import (
    AdminUser,
    CurrentUser,
    DbSession,
    TeamViewer,
    audit,
    visible_user_ids,
)
from app.api.tenancy import OptionalTenant
from app.core.security import decode_access_token, token_digest
from app.models import (
    AttendanceRecord,
    AttendanceSettings,
    Device,
    GeofenceEnforcement,
    OfficeLocation,
    Organization,
    PunchSource,
    Shift,
    ShiftAssignment,
    User,
)
from app.schemas.attendance import (
    AttendanceDayOut,
    AttendanceSettingsIn,
    AttendanceSettingsOut,
    OfficeLocationIn,
    OfficeLocationOut,
    PunchIn,
    PunchResultOut,
    ShiftAssignmentIn,
    ShiftAssignmentOut,
    ShiftIn,
    ShiftOut,
)
from app.services import attendance as svc

router = APIRouter(prefix="/attendance", tags=["attendance"])

#: How far a history request may reach in one call. A year plus a little, so a
#: financial-year export is one request while a client looping from 1970 is not.
MAX_HISTORY_DAYS = 400


# --------------------------------------------------------------------------- #
# "Device token OR user JWT" — composed, not hard-coded (§7)
# --------------------------------------------------------------------------- #


class PunchActor:
    """Who is punching, and how they proved it.

    ``source`` is derived from the credential rather than trusted from the body:
    a punch authenticated by a device token is an ``agent_session`` punch by
    definition, and letting the client name itself ``web`` would make
    ``check_in_source`` — the column that has to stay able to tell a measured
    punch from an approved correction — client-controlled.
    """

    def __init__(self, user: User, org: Organization, via_device: bool) -> None:
        self.user = user
        self.org = org
        self.via_device = via_device

    def source(self, requested: str) -> str:
        return PunchSource.AGENT_SESSION.value if self.via_device else requested


def _bearer_token(authorization: str | None) -> str | None:
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    return authorization.split(" ", 1)[1].strip() or None


def optional_user(
    db: DbSession,
    tenant: OptionalTenant,
    authorization: Annotated[str | None, Header()] = None,
) -> User | None:
    """The signed-in employee, or ``None`` if this is not a user JWT.

    Returns rather than raises, because it is one half of a composition: a
    device token arriving here is not an authentication failure, it is the other
    branch. The 401 is raised once, by :func:`punch_actor`, when *neither*
    branch matched — otherwise an agent punch would be refused by the user
    branch before the device branch ever ran.

    Unlike ``deps.get_current_user`` the tenant is optional here, for the same
    reason ``deps.get_current_device`` makes it optional: the PWA punch screen
    is reached on the tenant subdomain and will carry one, while the agent
    carries a credential that already names its organisation. When a tenant *is*
    present it must still match — a token minted for one company must not work
    on another's host, which is the check that stops a punch being recorded
    against the wrong tenant's muster.
    """
    token = _bearer_token(authorization)
    if not token:
        return None
    payload = decode_access_token(token)
    if not payload or payload.get("typ") != "user":
        return None
    try:
        user_id = uuid.UUID(payload["sub"])
    except (KeyError, ValueError, TypeError):
        return None
    user = db.get(User, user_id)
    if user is None or not user.is_active:
        return None
    if tenant is not None and user.org_id != tenant.id:
        return None
    return user


def optional_device(
    db: DbSession,
    tenant: OptionalTenant,
    authorization: Annotated[str | None, Header()] = None,
) -> Device | None:
    """The enrolled machine, or ``None`` if this is not a device token."""
    token = _bearer_token(authorization)
    if not token:
        return None
    device = db.scalar(select(Device).where(Device.token_hash == token_digest(token)))
    if device is None or not device.is_active:
        return None
    if tenant is not None and device.org_id != tenant.id:
        return None
    return device


def punch_actor(
    db: DbSession,
    user: Annotated[User | None, Depends(optional_user)] = None,
    device: Annotated[Device | None, Depends(optional_device)] = None,
) -> PunchActor:
    """Resolve either credential into the employee whose day is being punched."""
    resolved: User | None = user
    via_device = False
    if resolved is None and device is not None:
        resolved = db.get(User, device.user_id)
        via_device = True
        # A revoked employee whose machine is still enrolled must not keep
        # punching. Offboarding revokes the device, but the user row is the
        # authority on whether the person still works here.
        if resolved is not None and not resolved.is_active:
            resolved = None

    if resolved is None:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    org = db.get(Organization, resolved.org_id)
    if org is None:  # pragma: no cover - FK guarantees it
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    return PunchActor(resolved, org, via_device)


Puncher = Annotated[PunchActor, Depends(punch_actor)]


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _client_ip(request: Request) -> str | None:
    return request.client.host if request.client else None


def _punch_result(db, actor: PunchActor, outcome: svc.PunchOutcome) -> PunchResultOut:
    shift = svc.shift_on(db, actor.org.id, actor.user.id, outcome.record.date)
    return PunchResultOut(
        record=svc.day_out(outcome.record, actor.org, shift),
        is_geo_verified=outcome.verdict.is_verified,
        distance_m=outcome.verdict.distance_m,
        nearest_office_name=outcome.verdict.office_name,
        enforcement=outcome.enforcement,
    )


def _range(start: date | None, end: date | None, org: Organization) -> tuple[date, date]:
    end = end or svc.local_day(org)
    start = start or end - timedelta(days=29)
    if end < start:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"reason": "invalid_range", "message": "end is before start"},
        )
    if (end - start).days + 1 > MAX_HISTORY_DAYS:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "reason": "range_too_wide",
                "message": f"Ask for at most {MAX_HISTORY_DAYS} days at a time.",
            },
        )
    return start, end


def _office(db, org_id: uuid.UUID, location_id: uuid.UUID) -> OfficeLocation:
    row = db.get(OfficeLocation, location_id)
    if row is None or row.org_id != org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Office location not found")
    return row


def _shift(db, org_id: uuid.UUID, shift_id: uuid.UUID) -> Shift:
    row = db.get(Shift, shift_id)
    if row is None or row.org_id != org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Shift not found")
    return row


def _guard_last_active_location(db, org_id: uuid.UUID, removing_id: uuid.UUID) -> None:
    """Refuse to remove the last office while ``required`` is switched on.

    The other half of **D-014**. Blocking the settings change but not the office
    removal leaves the identical lockout one click further away: a tenant on
    ``required`` who deletes or deactivates their only site has locked every
    employee out of punching, from a screen about addresses.
    """
    if svc.enforcement_for(db, org_id) != GeofenceEnforcement.REQUIRED.value:
        return
    remaining = [loc for loc in svc.active_locations(db, org_id) if loc.id != removing_id]
    if remaining:
        return
    raise HTTPException(
        status.HTTP_409_CONFLICT,
        detail={
            "reason": "last_active_location",
            "message": (
                "Geofenced punching is set to 'required', so removing the last "
                "active office location would stop everyone punching in. Change "
                "the enforcement mode first, or add another location."
            ),
        },
    )


# --------------------------------------------------------------------------- #
# Punching
# --------------------------------------------------------------------------- #


@router.post("/punch/in", response_model=PunchResultOut, status_code=status.HTTP_201_CREATED)
def punch_in(
    payload: PunchIn, actor: Puncher, request: Request, db: DbSession
) -> PunchResultOut:
    """Check in. Accepts a user JWT or a device token — see :func:`punch_actor`.

    A punch with no coordinates is the *normal* denied-geolocation path and
    succeeds unverified; only ``geofence_enforcement = 'required'`` refuses, and
    then with a typed error the console can render (§2.2).
    """
    outcome = svc.punch_in(
        db,
        actor.org,
        actor.user,
        lat=payload.lat,
        lng=payload.lng,
        accuracy_m=payload.accuracy_m,
        source=actor.source(payload.source),
        note=payload.note,
        work_mode=payload.work_mode,
        ip=_client_ip(request),
    )
    audit(
        db,
        org_id=actor.org.id,
        actor=actor.user,
        action="attendance.punch_in",
        request=request,
        target_type="attendance_record",
        target_id=str(outcome.record.id),
        detail={
            "date": outcome.record.date,
            "is_geo_verified": outcome.verdict.is_verified,
            "distance_m": outcome.verdict.distance_m,
            "source": outcome.record.check_in_source,
            # In the audit trail because it is a claim the employee made, and
            # the claim is what a later dispute turns on — not the fact that
            # the fence was skipped, which is merely its consequence.
            "work_mode": outcome.record.work_mode,
        },
    )
    result = _punch_result(db, actor, outcome)
    db.commit()
    return result


@router.post("/punch/out", response_model=PunchResultOut)
def punch_out(
    payload: PunchIn, actor: Puncher, request: Request, db: DbSession
) -> PunchResultOut:
    """Check out, closing today's open row — or yesterday's on a night shift."""
    outcome = svc.punch_out(
        db,
        actor.org,
        actor.user,
        lat=payload.lat,
        lng=payload.lng,
        accuracy_m=payload.accuracy_m,
        source=actor.source(payload.source),
        note=payload.note,
        ip=_client_ip(request),
    )
    audit(
        db,
        org_id=actor.org.id,
        actor=actor.user,
        action="attendance.punch_out",
        request=request,
        target_type="attendance_record",
        target_id=str(outcome.record.id),
        detail={
            "date": outcome.record.date,
            "worked_minutes": outcome.record.worked_minutes,
            "is_geo_verified": outcome.verdict.is_verified,
            "distance_m": outcome.verdict.distance_m,
        },
    )
    result = _punch_result(db, actor, outcome)
    db.commit()
    return result


# --------------------------------------------------------------------------- #
# History
# --------------------------------------------------------------------------- #


@router.get("/me", response_model=list[AttendanceDayOut])
def my_attendance(
    viewer: CurrentUser,
    db: DbSession,
    start: date | None = None,
    end: date | None = None,
) -> list[AttendanceDayOut]:
    """The signed-in employee's own calendar. Defaults to the last 30 days."""
    org = db.get(Organization, viewer.org_id)
    window = _range(start, end, org)
    return svc.history(db, org, [viewer.id], *window)


@router.get("/me/today", response_model=AttendanceDayOut | None)
def my_today(viewer: CurrentUser, db: DbSession) -> AttendanceDayOut | None:
    """Today's row, or ``null`` before the first punch.

    ``null`` rather than a synthesised empty day: the punch screen's only
    question is "have I punched in yet", and inventing a row here would make the
    answer indistinguishable from an ``absent`` the nightly job wrote.
    """
    org = db.get(Organization, viewer.org_id)
    today = svc.local_day(org)
    days = svc.history(db, org, [viewer.id], today, today)
    return days[0] if days else None


@router.get("/team", response_model=list[AttendanceDayOut])
def team_attendance(
    viewer: TeamViewer,
    db: DbSession,
    start: date | None = None,
    end: date | None = None,
    user_id: uuid.UUID | None = None,
) -> list[AttendanceDayOut]:
    """The daily muster for the viewer's reporting subtree.

    Scope comes from ``visible_user_ids`` — the hierarchy service — exactly as
    timesheet approval does. Subtree logic is not reimplemented here; §2.5 is
    explicit that it must not be, and a second copy is a second thing to get
    wrong when somebody's manager changes.
    """
    org = db.get(Organization, viewer.org_id)
    window = _range(start, end, org)

    allowed = visible_user_ids(db, viewer)
    if allowed is None:
        allowed = list(
            db.scalars(select(User.id).where(User.org_id == viewer.org_id)).all()
        )
    if user_id is not None:
        # Filtering to one person still runs through the scope list, so asking
        # for somebody outside the subtree returns nothing rather than their day.
        allowed = [uid for uid in allowed if uid == user_id]

    return svc.history(db, org, allowed, *window, include_user=True)


# --------------------------------------------------------------------------- #
# Office locations
# --------------------------------------------------------------------------- #


@router.get("/locations", response_model=list[OfficeLocationOut])
def list_locations(viewer: CurrentUser, db: DbSession) -> list[OfficeLocationOut]:
    """Readable by any employee: the punch screen tells people where to stand."""
    return list(
        db.scalars(
            select(OfficeLocation)
            .where(OfficeLocation.org_id == viewer.org_id)
            .order_by(OfficeLocation.name)
        ).all()
    )


@router.post("/locations", response_model=OfficeLocationOut, status_code=status.HTTP_201_CREATED)
def create_location(
    payload: OfficeLocationIn, admin: AdminUser, request: Request, db: DbSession
) -> OfficeLocationOut:
    name = payload.name.strip()
    clash = db.scalar(
        select(OfficeLocation.id).where(
            OfficeLocation.org_id == admin.org_id, OfficeLocation.name == name
        )
    )
    if clash:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "reason": "duplicate_location",
                "message": "An office location with that name already exists.",
            },
        )
    location = OfficeLocation(
        org_id=admin.org_id, **payload.model_dump(exclude={"name"}), name=name
    )
    db.add(location)
    db.flush()
    audit(db, org_id=admin.org_id, actor=admin, action="attendance.location_created",
          request=request, target_type="office_location", target_id=str(location.id),
          detail={"name": location.name, "radius_m": location.radius_m})
    db.commit()
    return location


@router.patch("/locations/{location_id}", response_model=OfficeLocationOut)
def update_location(
    location_id: uuid.UUID,
    payload: OfficeLocationIn,
    admin: AdminUser,
    request: Request,
    db: DbSession,
) -> OfficeLocationOut:
    location = _office(db, admin.org_id, location_id)
    if location.is_active and not payload.is_active:
        _guard_last_active_location(db, admin.org_id, location_id)
    for field, value in payload.model_dump().items():
        setattr(location, field, value)
    location.name = payload.name.strip()
    audit(db, org_id=admin.org_id, actor=admin, action="attendance.location_updated",
          request=request, target_type="office_location", target_id=str(location.id))
    db.commit()
    return location


@router.delete("/locations/{location_id}", status_code=status.HTTP_204_NO_CONTENT,
               response_model=None)
def delete_location(
    location_id: uuid.UUID, admin: AdminUser, request: Request, db: DbSession
) -> None:
    """Hard delete. Nothing points at an office location by foreign key.

    Attendance rows store the *measured distance*, not the site that matched, so
    removing a closed office cannot orphan or silently rewrite a past day.
    Deactivating instead is still the better habit — the model says so — but
    forcing it would leave a tenant unable to clear a location typed in error.
    """
    location = _office(db, admin.org_id, location_id)
    if location.is_active:
        _guard_last_active_location(db, admin.org_id, location_id)
    db.delete(location)
    audit(db, org_id=admin.org_id, actor=admin, action="attendance.location_deleted",
          request=request, target_type="office_location", target_id=str(location_id),
          detail={"name": location.name})
    db.commit()


# --------------------------------------------------------------------------- #
# Policy
# --------------------------------------------------------------------------- #


@router.get("/settings", response_model=AttendanceSettingsOut)
def get_settings(viewer: CurrentUser, db: DbSession) -> AttendanceSettingsOut:
    """Current policy, resolving a missing row to the configured default.

    **D-009**: this is a pure read. No row is created — the tenant that never
    configured attendance stays row-less, which is what keeps the Phase 0
    migration additive for every organisation that existed before it.
    """
    row = db.get(AttendanceSettings, viewer.org_id)
    return AttendanceSettingsOut(
        geofence_enforcement=svc.enforcement_for(db, viewer.org_id),
        active_location_count=len(svc.active_locations(db, viewer.org_id)),
        geofence_office=row.geofence_office if row else None,
        geofence_work_from_home=row.geofence_work_from_home if row else None,
        geofence_on_duty=row.geofence_on_duty if row else None,
    )


@router.put("/settings", response_model=AttendanceSettingsOut)
def put_settings(
    payload: AttendanceSettingsIn, admin: AdminUser, request: Request, db: DbSession
) -> AttendanceSettingsOut:
    """Set the geofence policy. Refuses ``required`` with no offices (D-014)."""
    row = svc.update_settings(
        db,
        admin.org_id,
        payload.geofence_enforcement,
        per_mode={
            "geofence_office": payload.geofence_office,
            "geofence_work_from_home": payload.geofence_work_from_home,
            "geofence_on_duty": payload.geofence_on_duty,
        },
    )
    audit(db, org_id=admin.org_id, actor=admin, action="attendance.settings_updated",
          request=request, target_type="attendance_settings", target_id=str(admin.org_id),
          detail={
              "geofence_enforcement": row.geofence_enforcement,
              "geofence_office": row.geofence_office,
              "geofence_work_from_home": row.geofence_work_from_home,
              "geofence_on_duty": row.geofence_on_duty,
          })
    db.commit()
    return AttendanceSettingsOut(
        geofence_enforcement=row.geofence_enforcement,
        active_location_count=len(svc.active_locations(db, admin.org_id)),
        geofence_office=row.geofence_office,
        geofence_work_from_home=row.geofence_work_from_home,
        geofence_on_duty=row.geofence_on_duty,
    )


# --------------------------------------------------------------------------- #
# Shifts
# --------------------------------------------------------------------------- #


def _shift_out(shift: Shift, assigned: dict[uuid.UUID, int]) -> ShiftOut:
    return ShiftOut(
        id=shift.id,
        name=shift.name,
        start_time=shift.start_time,
        end_time=shift.end_time,
        grace_minutes=shift.grace_minutes,
        half_day_threshold_minutes=shift.half_day_threshold_minutes,
        half_day_threshold_hours=shift.half_day_threshold_hours,
        is_night_shift=shift.is_night_shift,
        is_active=shift.is_active,
        expected_minutes=shift.expected_minutes,
        assigned_count=assigned.get(shift.id, 0),
    )


def _assigned_counts(db, org_id: uuid.UUID) -> dict[uuid.UUID, int]:
    """Currently-open assignments per shift — the rota as it stands today."""
    return {
        row[0]: int(row[1])
        for row in db.execute(
            select(ShiftAssignment.shift_id, func.count(ShiftAssignment.id))
            .where(
                ShiftAssignment.org_id == org_id,
                ShiftAssignment.effective_to.is_(None),
            )
            .group_by(ShiftAssignment.shift_id)
        )
    }


@router.get("/shifts", response_model=list[ShiftOut])
def list_shifts(viewer: CurrentUser, db: DbSession) -> list[ShiftOut]:
    shifts = db.scalars(
        select(Shift).where(Shift.org_id == viewer.org_id).order_by(Shift.start_time, Shift.name)
    ).all()
    counts = _assigned_counts(db, viewer.org_id)
    return [_shift_out(shift, counts) for shift in shifts]


@router.post("/shifts", response_model=ShiftOut, status_code=status.HTTP_201_CREATED)
def create_shift(
    payload: ShiftIn, admin: AdminUser, request: Request, db: DbSession
) -> ShiftOut:
    name = payload.name.strip()
    clash = db.scalar(
        select(Shift.id).where(Shift.org_id == admin.org_id, Shift.name == name)
    )
    if clash:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"reason": "duplicate_shift", "message": "A shift with that name exists."},
        )
    shift = Shift(org_id=admin.org_id, **payload.model_dump(exclude={"name"}), name=name)
    db.add(shift)
    db.flush()
    audit(db, org_id=admin.org_id, actor=admin, action="attendance.shift_created",
          request=request, target_type="shift", target_id=str(shift.id),
          detail={"name": shift.name})
    db.commit()
    return _shift_out(shift, {})


@router.patch("/shifts/{shift_id}", response_model=ShiftOut)
def update_shift(
    shift_id: uuid.UUID, payload: ShiftIn, admin: AdminUser, request: Request, db: DbSession
) -> ShiftOut:
    shift = _shift(db, admin.org_id, shift_id)
    for field, value in payload.model_dump().items():
        setattr(shift, field, value)
    shift.name = payload.name.strip()
    audit(db, org_id=admin.org_id, actor=admin, action="attendance.shift_updated",
          request=request, target_type="shift", target_id=str(shift.id))
    db.commit()
    return _shift_out(shift, _assigned_counts(db, admin.org_id))


@router.delete("/shifts/{shift_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_shift(
    shift_id: uuid.UUID, admin: AdminUser, request: Request, db: DbSession
) -> None:
    """Only an unused shift can be deleted; an assigned one is deactivated.

    ``shift_assignments.shift_id`` is ``ON DELETE RESTRICT`` on purpose — the
    history is what the nightly job re-reads — so this refusal is the database's
    answer rendered as something a person can act on, instead of an IntegrityError
    surfacing as a 500.
    """
    shift = _shift(db, admin.org_id, shift_id)
    used = db.scalar(
        select(func.count(ShiftAssignment.id)).where(
            ShiftAssignment.org_id == admin.org_id, ShiftAssignment.shift_id == shift_id
        )
    )
    if used:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "reason": "shift_in_use",
                "message": (
                    f"{used} rota entries reference this shift. Deactivate it "
                    f"instead so past attendance keeps its meaning."
                ),
            },
        )
    db.delete(shift)
    audit(db, org_id=admin.org_id, actor=admin, action="attendance.shift_deleted",
          request=request, target_type="shift", target_id=str(shift_id),
          detail={"name": shift.name})
    db.commit()


# --------------------------------------------------------------------------- #
# Rota
# --------------------------------------------------------------------------- #


def _assignment_out(
    assignment: ShiftAssignment, names: dict, shifts: dict[uuid.UUID, Shift]
) -> ShiftAssignmentOut:
    shift = shifts.get(assignment.shift_id)
    return ShiftAssignmentOut(
        id=assignment.id,
        user_id=assignment.user_id,
        shift_id=assignment.shift_id,
        effective_from=assignment.effective_from,
        effective_to=assignment.effective_to,
        user_name=names.get(assignment.user_id),
        shift_name=shift.name if shift else None,
        shift_start_time=shift.start_time if shift else None,
        shift_end_time=shift.end_time if shift else None,
        is_current=assignment.effective_to is None,
    )


@router.get("/shift-assignments", response_model=list[ShiftAssignmentOut])
def list_assignments(
    viewer: TeamViewer,
    db: DbSession,
    user_id: uuid.UUID | None = None,
    current_only: bool = Query(default=False),
) -> list[ShiftAssignmentOut]:
    """The rota, scoped to whoever the viewer may see."""
    allowed = visible_user_ids(db, viewer)
    stmt = select(ShiftAssignment).where(ShiftAssignment.org_id == viewer.org_id)
    if allowed is not None:
        stmt = stmt.where(ShiftAssignment.user_id.in_(allowed))
    if user_id is not None:
        stmt = stmt.where(ShiftAssignment.user_id == user_id)
    if current_only:
        stmt = stmt.where(ShiftAssignment.effective_to.is_(None))
    rows = db.scalars(stmt.order_by(ShiftAssignment.effective_from.desc())).all()

    names = {
        row[0]: row[1]
        for row in db.execute(select(User.id, User.full_name).where(User.org_id == viewer.org_id))
    }
    shifts = {
        shift.id: shift
        for shift in db.scalars(select(Shift).where(Shift.org_id == viewer.org_id)).all()
    }
    return [_assignment_out(row, names, shifts) for row in rows]


@router.post("/shift-assignments", response_model=ShiftAssignmentOut,
             status_code=status.HTTP_201_CREATED)
def create_assignment(
    payload: ShiftAssignmentIn, admin: AdminUser, request: Request, db: DbSession
) -> ShiftAssignmentOut:
    """Put someone on a shift, closing the row they were on.

    Backdating re-stamps the affected days — see D-010 and
    ``services.attendance.assign_shift``. That happens in the service, not here.
    """
    org = db.get(Organization, admin.org_id)
    assignment = svc.assign_shift(
        db,
        org,
        payload.user_id,
        payload.shift_id,
        payload.effective_from,
        payload.effective_to,
    )
    audit(db, org_id=admin.org_id, actor=admin, action="attendance.shift_assigned",
          request=request, target_type="shift_assignment", target_id=str(assignment.id),
          detail={
              "user_id": assignment.user_id,
              "shift_id": assignment.shift_id,
              "effective_from": assignment.effective_from,
          })
    names = {
        row[0]: row[1]
        for row in db.execute(select(User.id, User.full_name).where(User.org_id == admin.org_id))
    }
    shifts = {
        shift.id: shift
        for shift in db.scalars(select(Shift).where(Shift.org_id == admin.org_id)).all()
    }
    result = _assignment_out(assignment, names, shifts)
    db.commit()
    return result


# --------------------------------------------------------------------------- #
# Operations
# --------------------------------------------------------------------------- #


@router.post("/recompute")
def recompute(
    admin: AdminUser,
    request: Request,
    db: DbSession,
    start: date,
    end: date,
) -> dict:
    """Re-run the nightly classification over a past range, for this org only.

    Exists because the job is idempotent and because HR importing history, or a
    corrected holiday calendar, needs the days re-derived without waiting for
    midnight. Regularised rows are skipped here exactly as they are in the job
    (D-007) — this endpoint is not a way around that rule.
    """
    org = db.get(Organization, admin.org_id)
    if end >= svc.local_day(org):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "reason": "future_range",
                "message": "Only days that have already ended can be recomputed.",
            },
        )
    totals = svc.restamp_range(db, org, start, end)
    audit(db, org_id=admin.org_id, actor=admin, action="attendance.recomputed",
          request=request, detail={"start": start, "end": end, **totals})
    db.commit()
    return totals


@router.get("/records/{record_id}", response_model=AttendanceDayOut)
def get_record(record_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> AttendanceDayOut:
    """One day, for the employee themselves or anyone who may see them."""
    record = db.get(AttendanceRecord, record_id)
    if record is None or record.org_id != viewer.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Attendance record not found")
    if record.user_id != viewer.id:
        allowed = visible_user_ids(db, viewer)
        if allowed is not None and record.user_id not in allowed:
            # 404, not 403: confirming the row exists would leak that a person
            # outside the viewer's subtree worked that day.
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Attendance record not found")
    org = db.get(Organization, viewer.org_id)
    days = svc.history(db, org, [record.user_id], record.date, record.date, include_user=True)
    if not days:  # pragma: no cover - the row was just read
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Attendance record not found")
    return days[0]
