"""Punch validation, geofence policy, worked minutes, and the nightly stamp job.

Owns every write to ``attendance_records`` that is *not* a regularisation —
Phase 2's approval path owns that one, and the two must not both claim a row.
The rule that keeps them apart is D-007, enforced in :func:`stamp_org_day`: a
row whose ``check_in_source`` or ``check_out_source`` is ``regularized`` is
never touched by anything derived. A human decision outranks a computed one, the
same way ``services/attribution.py`` already refuses to let the rule engine
overwrite a manual project assignment.

Three things a reader would otherwise get wrong:

**A punch outside every geofence is a success.** §2.2 is explicit and this
module implements it literally: the row is written, ``is_geo_verified_*`` is
``False``, ``check_in_distance_m`` records how far. The single exception is
``geofence_enforcement = 'required'``, which is also the only mode that can lock
a tenant out — see :func:`update_settings` and D-014. Denied geolocation is the
normal path, not the error path.

**A missing ``attendance_settings`` row means defaults, and stays missing.**
D-009. Reading policy never inserts, because a lazy insert turns every GET into
a write, races itself under two concurrent punches, and quietly un-does the
additive-only property of the migration for tenants that already existed.

**The stored ``status`` is a day classification, never a verdict about
punctuality.** D-010: the six-value enum is written nightly so a month-end
report for a whole company is one indexed scan; late/early/half-day *verdicts*
are computed in :func:`day_out` at read time against the shift in force that
day, and are never persisted.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import HTTPException, status as http_status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings as app_settings
from app.db.session import SessionLocal
from app.models import (
    AttendanceRecord,
    AttendanceSettings,
    AttendanceStatus,
    GeofenceEnforcement,
    Holiday,
    LeaveApplication,
    LeaveStatus,
    OfficeLocation,
    OptionalHolidayOptIn,
    Organization,
    PunchSource,
    RegularizationRequest,
    RegularizationStatus,
    Shift,
    ShiftAssignment,
    User,
    WorkSchedule,
)
from app.models.attendance import MAX_WORKED_MINUTES_PER_DAY
from app.schemas.attendance import AttendanceDayOut
from app.services import geofence

log = logging.getLogger(__name__)

#: How far back a punch-out is allowed to reach for an open check-in, in days.
#: One, not zero, because a night shift that starts at 22:00 clocks out on the
#: following local date and its attendance day is the date it *started* — see
#: ``Shift.is_night_shift``. Not two: past that, the honest answer is that
#: somebody forgot to punch out and the fix is a regularisation, not a
#: check-out stamped a day and a half late onto a row payroll already read.
PUNCH_OUT_LOOKBACK_DAYS = 1

#: Ceiling on the client-reported GPS accuracy the geofence will widen itself by.
#:
#: ``PunchIn.accuracy_m`` accepts up to 100 km, and widening the fence by the
#: device's own error estimate is deliberate — a ±500 m fix makes a hard fail
#: against a 200 m circle meaningless (§2.2). But the figure is supplied by the
#: client, and ``required`` is the one mode that actually blocks: uncapped, any
#: caller can send ``accuracy_m: 100000`` and walk through the only enforcement
#: this module has, from anywhere on earth. A kilometre is well past any honest
#: consumer GPS error and well short of "the geofence is decorative".
#:
#: Clamped here rather than in ``geofence.py`` on purpose: how far to trust a
#: client is policy, and that module is deliberately policy-free geometry.
MAX_ACCURACY_WIDENING_M = 1000

#: Ceiling on how much history one shift-assignment edit may re-stamp (D-010).
#: A backdated rota has to re-trigger the nightly job for the affected range or
#: it leaves stale ``half_day`` rows behind it, but an admin who types 1970 into
#: ``effective_from`` must not start a fifty-year recompute inside a request.
MAX_RESTAMP_DAYS = 400


# --------------------------------------------------------------------------- #
# Typed errors
#
# HTTPException with a ``{reason, message}`` detail, following
# ``services/subscriptions.py``. Spec §2.2 requires the refusal in ``required``
# mode to be "a clear, agent-style typed error the frontend can render, not a
# raw 4xx", and D-014 requires the same of the settings guard. Raising from the
# service rather than the router is what keeps the handlers thin: the rule and
# its wording live in one place, and no future endpoint can reintroduce a bare
# 400 by calling the service and inventing its own message.
# --------------------------------------------------------------------------- #


def _refuse(code: int, reason: str, message: str, **extra: object) -> HTTPException:
    return HTTPException(code, detail={"reason": reason, "message": message, **extra})


# --------------------------------------------------------------------------- #
# Time in the organisation's own calendar
# --------------------------------------------------------------------------- #


def tz_for(name: str | None) -> ZoneInfo:
    """The org's timezone, falling back to UTC on an unknown name.

    Duplicated in spirit from ``services/reports.py`` and deliberately not
    imported from it: ``reports`` pulls in the whole reporting stack, and the
    nightly job must be importable by the scheduler without it.
    """
    try:
        return ZoneInfo(name or "UTC")
    except Exception:
        return ZoneInfo("UTC")


def as_utc(value: datetime | None) -> datetime | None:
    """Attach UTC to a naive timestamp read back from the database.

    SQLite has no timezone type, so ``DateTime(timezone=True)`` round-trips as a
    naive datetime there while Postgres returns an aware one. Every arithmetic
    site below would otherwise be one dialect away from a
    ``TypeError: can't subtract offset-naive and offset-aware datetimes`` that
    only shows up in production.
    """
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def local_day(org: Organization, at: datetime | None = None) -> date:
    """The attendance day, in the organisation's timezone — never UTC midnight."""
    moment = as_utc(at) or datetime.now(timezone.utc)
    return moment.astimezone(tz_for(org.timezone)).date()


def _local_dt(day: date, hhmm: str, tz: ZoneInfo) -> datetime:
    hour, minute = (int(part) for part in hhmm.split(":"))
    return datetime.combine(day, time(hour=hour, minute=minute), tzinfo=tz)


# --------------------------------------------------------------------------- #
# Policy (D-009, D-014)
# --------------------------------------------------------------------------- #


def enforcement_for(
    db: Session,
    org_id: uuid.UUID,
    *,
    work_mode: str | None = None,
    user: User | None = None,
) -> str:
    """The geofence mode that applies to one punch.

    Three things decide it, in order of authority:

    1. **The employee.** ``can_punch_anywhere`` is an exemption, not a
       preference — a field engineer is at a different site every day and the
       fence has nothing true to say about them. It wins over any policy.
    2. **The declared work mode.** Fencing somebody who has just told you they
       are at a client's office asks a question whose answer you already have.
    3. **The org policy**, which is what every punch got before work modes
       existed and what the desktop agent still gets, since it observes a
       session starting without knowing whose desk it is on.

    **Never inserts.** D-009: a missing ``attendance_settings`` row is a legal,
    permanent state meaning "this tenant has not decided", and lazily writing
    one here would make a GET a write, race itself under two simultaneous
    punches, and hand every existing tenant a row the additive migration
    deliberately did not create for them.
    """
    if user is not None and user.can_punch_anywhere:
        return GeofenceEnforcement.OFF.value
    row = db.get(AttendanceSettings, org_id)
    if row is not None:
        return row.geofence_for(work_mode)
    return app_settings.geofence_enforcement_default


def active_locations(db: Session, org_id: uuid.UUID) -> list[OfficeLocation]:
    return list(
        db.scalars(
            select(OfficeLocation)
            .where(
                OfficeLocation.org_id == org_id,
                OfficeLocation.is_active.is_(True),
            )
            .order_by(OfficeLocation.name)
        ).all()
    )


def fences_for(db: Session, org_id: uuid.UUID) -> list[geofence.Fence]:
    """Office rows flattened into the DB-free shape ``geofence`` works in.

    This one comprehension is the entire reason ``services/geofence.py`` can
    stay import-clean and unit-testable without a session.
    """
    return [
        geofence.Fence(
            id=row.id,
            name=row.name,
            lat=row.lat,
            lng=row.lng,
            # A location row always carries a radius, but the config fallback is
            # what spec §11 promises ``DEFAULT_GEOFENCE_RADIUS_M`` is for, and a
            # zero left by a bad import must not silently become a fence nobody
            # can stand inside.
            radius_m=row.radius_m or app_settings.default_geofence_radius_m,
        )
        for row in active_locations(db, org_id)
    ]


def update_settings(
    db: Session,
    org_id: uuid.UUID,
    enforcement: str | None,
    *,
    per_mode: dict[str, str | None] | None = None,
) -> AttendanceSettings:
    """Write the org's attendance policy, refusing the one setting that bricks it.

    **D-014.** Switching to ``required`` with zero active office locations locks
    every employee in the tenant out of punching, permanently and silently, from
    an admin screen that gives no hint that is what just happened. The refusal is
    a typed error rather than a bare 422 precisely so the console can render the
    fix ("add an office location first") instead of the failure.

    This is also the only place that *creates* the settings row — an explicit
    write by an administrator, which is exactly the event D-009 says a row may
    come into existence for.
    """
    row = db.get(AttendanceSettings, org_id)
    target = enforcement if enforcement is not None else (
        row.geofence_enforcement if row else app_settings.geofence_enforcement_default
    )

    if target == GeofenceEnforcement.REQUIRED.value:
        count = len(active_locations(db, org_id))
        if count == 0:
            raise _refuse(
                http_status.HTTP_409_CONFLICT,
                "geofence_required_without_locations",
                "Add at least one active office location before requiring geofenced "
                "punches — otherwise nobody in this organisation can punch in at all.",
                active_location_count=0,
            )

    if row is None:
        row = AttendanceSettings(org_id=org_id, geofence_enforcement=target)
        db.add(row)
    else:
        row.geofence_enforcement = target

    # Per-mode overrides. "inherit" is how the API says NULL — see
    # _MODE_POLICY_PATTERN — and a key absent from the dict means "leave it".
    #
    # D-014 is deliberately NOT re-checked per mode: `required` on Office with
    # no offices is caught by the same guard above only when the org policy is
    # also required, so it is checked explicitly here instead. Without it an
    # administrator could lock the tenant out through the back door.
    for field, value in (per_mode or {}).items():
        if value is None:
            continue
        resolved = None if value == "inherit" else value
        if resolved == GeofenceEnforcement.REQUIRED.value and not active_locations(db, org_id):
            raise _refuse(
                http_status.HTTP_409_CONFLICT,
                "geofence_required_without_locations",
                "Add at least one active office location before requiring geofenced "
                "punches for a work mode — otherwise nobody using that mode can "
                "punch in at all.",
                active_location_count=0,
            )
        setattr(row, field, resolved)

    db.flush()
    return row


# --------------------------------------------------------------------------- #
# Shifts (D-011)
# --------------------------------------------------------------------------- #


def shift_on(db: Session, org_id: uuid.UUID, user_id: uuid.UUID, day: date) -> Shift | None:
    """The shift in force for one person on one date, or None if unassigned.

    Effective-dated lookup rather than a current-value pointer, because the
    nightly job recomputes past dates and "which shift were they on on 14 March"
    is a question a ``users.shift_id`` column answers with today's answer.
    """
    assignment = db.scalars(
        select(ShiftAssignment)
        .where(
            ShiftAssignment.org_id == org_id,
            ShiftAssignment.user_id == user_id,
            ShiftAssignment.effective_from <= day,
            (ShiftAssignment.effective_to.is_(None)) | (ShiftAssignment.effective_to >= day),
        )
        .order_by(ShiftAssignment.effective_from.desc())
        .limit(1)
    ).first()
    if assignment is None:
        return None
    shift = db.get(Shift, assignment.shift_id)
    # Defensive on org: shift_id has a RESTRICT FK so it cannot dangle, but a
    # cross-tenant read here would be a data leak rather than a missing row.
    if shift is None or shift.org_id != org_id:
        return None
    return shift


def assign_shift(
    db: Session,
    org: Organization,
    user_id: uuid.UUID,
    shift_id: uuid.UUID,
    effective_from: date,
    effective_to: date | None = None,
) -> ShiftAssignment:
    """Put someone on a shift from a date, closing whatever they were on.

    The previous open row is closed at ``effective_from - 1`` rather than left
    to overlap. SQLite cannot express the Postgres EXCLUDE constraint that would
    forbid overlap outright (see the model), so the service is what keeps the
    history a partition; the unique constraint on
    ``(user_id, effective_from)`` catches the double-submit that would slip past
    a read-then-write.

    Backdating re-stamps the affected range, per **D-010**: ``half_day`` is a
    *stored* decision made against the shift in force, so a corrected rota that
    does not re-trigger the job leaves stale half-days behind it — the exact
    consequence the ruling says Phase 1 owes.
    """
    if effective_to is not None and effective_to < effective_from:
        raise _refuse(
            http_status.HTTP_422_UNPROCESSABLE_ENTITY,
            "invalid_effective_range",
            "A shift assignment cannot end before it starts.",
        )

    shift = db.get(Shift, shift_id)
    if shift is None or shift.org_id != org.id:
        raise _refuse(http_status.HTTP_404_NOT_FOUND, "shift_not_found", "Shift not found.")
    person = db.get(User, user_id)
    if person is None or person.org_id != org.id:
        raise _refuse(
            http_status.HTTP_404_NOT_FOUND, "employee_not_found", "Employee not found."
        )

    open_rows = db.scalars(
        select(ShiftAssignment).where(
            ShiftAssignment.org_id == org.id,
            ShiftAssignment.user_id == user_id,
            ShiftAssignment.effective_from < effective_from,
            (ShiftAssignment.effective_to.is_(None))
            | (ShiftAssignment.effective_to >= effective_from),
        )
    ).all()
    for row in open_rows:
        row.effective_to = effective_from - timedelta(days=1)

    assignment = ShiftAssignment(
        org_id=org.id,
        user_id=user_id,
        shift_id=shift_id,
        effective_from=effective_from,
        effective_to=effective_to,
    )
    db.add(assignment)
    db.flush()

    today = local_day(org)
    if effective_from < today:
        end = min(effective_to or today - timedelta(days=1), today - timedelta(days=1))
        # only_existing: fix the days this person already has, and do not invent
        # a week of absences for a rota correction.
        restamp_range(
            db, org, effective_from, end, user_ids=[user_id], only_existing=True
        )

    return assignment


# --------------------------------------------------------------------------- #
# Worked minutes (D-012)
# --------------------------------------------------------------------------- #


def worked_minutes_between(check_in: datetime | None, check_out: datetime | None) -> int:
    """Minutes between two punches, clamped to ``MAX_WORKED_MINUTES_PER_DAY``.

    Zero, not None, when the day is still open: the column feeds ``SUM()`` over
    a month and a NULL would make every aggregate in the module coalesce.

    The cap is the point. A forgotten check-out that a regularisation later
    stamps at 23:59 would otherwise book sixteen-plus hours of overtime for
    somebody who went home at six, and payroll reads this column. Negative spans
    — a check-out before the check-in, which only a bad correction can produce —
    clamp to zero rather than subtracting from the month.
    """
    start, end = as_utc(check_in), as_utc(check_out)
    if start is None or end is None:
        return 0
    minutes = int((end - start).total_seconds() // 60)
    return max(0, min(minutes, MAX_WORKED_MINUTES_PER_DAY))


# --------------------------------------------------------------------------- #
# Punching (§2.2)
# --------------------------------------------------------------------------- #


@dataclass
class PunchOutcome:
    """What a punch produced: the row, the geofence verdict, the policy applied."""

    record: AttendanceRecord
    verdict: geofence.GeoVerdict
    enforcement: str


def _geo_for_punch(
    db: Session,
    org_id: uuid.UUID,
    lat: float | None,
    lng: float | None,
    accuracy_m: int | None,
    enforcement: str,
) -> geofence.GeoVerdict:
    """Resolve the geofence, refusing only in ``required`` mode.

    ``off`` skips the distance computation entirely rather than computing it and
    ignoring the answer: a fully remote tenant would otherwise accumulate a
    ``check_in_distance_m`` on every row measured against offices whose whole
    point is that they do not apply.
    """
    if enforcement == GeofenceEnforcement.OFF.value:
        return geofence.GeoVerdict(is_verified=False)

    margin = min(max(0, accuracy_m or 0), MAX_ACCURACY_WIDENING_M)
    verdict = geofence.resolve(lat, lng, fences_for(db, org_id), margin)

    if enforcement != GeofenceEnforcement.REQUIRED.value:
        return verdict

    if lat is None or lng is None:
        raise _refuse(
            http_status.HTTP_403_FORBIDDEN,
            "location_required",
            "This organisation requires a location to punch. Allow location access "
            "in your browser and try again.",
            enforcement=enforcement,
        )
    if not verdict.is_verified:
        raise _refuse(
            http_status.HTTP_403_FORBIDDEN,
            "outside_geofence",
            (
                f"You appear to be {verdict.distance_m} m from "
                f"{verdict.office_name}. Punch from an office location, or ask "
                f"your manager to regularise this day."
                if verdict.distance_m is not None
                else "No office location is configured to verify this punch against."
            ),
            distance_m=verdict.distance_m,
            nearest_office_name=verdict.office_name,
            enforcement=enforcement,
        )
    return verdict


def record_for(
    db: Session, org_id: uuid.UUID, user_id: uuid.UUID, day: date
) -> AttendanceRecord | None:
    return db.scalar(
        select(AttendanceRecord).where(
            AttendanceRecord.org_id == org_id,
            AttendanceRecord.user_id == user_id,
            AttendanceRecord.date == day,
        )
    )


def punch_in(
    db: Session,
    org: Organization,
    user: User,
    *,
    lat: float | None = None,
    lng: float | None = None,
    accuracy_m: int | None = None,
    source: str = PunchSource.WEB.value,
    note: str | None = None,
    work_mode: str | None = None,
    ip: str | None = None,
    at: datetime | None = None,
) -> PunchOutcome:
    """Record a check-in for today, in the organisation's local calendar."""
    now = as_utc(at) or datetime.now(timezone.utc)
    day = local_day(org, now)
    enforcement = enforcement_for(db, org.id, work_mode=work_mode, user=user)
    verdict = _geo_for_punch(db, org.id, lat, lng, accuracy_m, enforcement)

    record = record_for(db, org.id, user.id, day)
    if record is not None:
        if record.check_in_source == PunchSource.REGULARIZED.value:
            # D-007 in the other direction: an approved correction is a human
            # decision about this day, and a later punch must not silently
            # overwrite it either.
            raise _refuse(
                http_status.HTTP_409_CONFLICT,
                "day_regularized",
                "This day has an approved regularisation. Ask your manager to "
                "correct it again rather than punching over it.",
            )
        if record.check_in_at is not None:
            raise _refuse(
                http_status.HTTP_409_CONFLICT,
                "already_punched_in",
                "You have already punched in today.",
                check_in_at=as_utc(record.check_in_at).isoformat(),
            )
    else:
        record = AttendanceRecord(
            org_id=org.id,
            user_id=user.id,
            date=day,
            # D-020: set explicitly even though the column defaults to the same
            # value. The default is right *here* — a row exists because somebody
            # punched — and a trap everywhere else, so every row this module
            # creates states its status rather than inheriting one.
            status=AttendanceStatus.PRESENT.value,
            worked_minutes=0,
        )
        db.add(record)

    record.check_in_at = now
    record.check_in_lat = lat
    record.check_in_lng = lng
    record.is_geo_verified_in = verdict.is_verified
    record.check_in_distance_m = verdict.distance_m
    record.check_in_ip = ip
    record.check_in_source = source
    if note:
        record.note = note
    # The declaration stands even when the fence is off for it — a manager
    # reading the day back needs to know the person said "client site", not
    # merely that nothing was measured.
    if work_mode:
        record.work_mode = work_mode
    # Re-stated rather than assumed: a row created by a previous nightly run as
    # `absent` and punched into afterwards (a late-running job, a backfilled
    # day) must not keep the absence.
    record.status = AttendanceStatus.PRESENT.value
    db.flush()
    return PunchOutcome(record=record, verdict=verdict, enforcement=enforcement)


def punch_out(
    db: Session,
    org: Organization,
    user: User,
    *,
    lat: float | None = None,
    lng: float | None = None,
    accuracy_m: int | None = None,
    source: str = PunchSource.WEB.value,
    note: str | None = None,
    ip: str | None = None,
    at: datetime | None = None,
) -> PunchOutcome:
    """Close today's open check-in, or yesterday's if a night shift is running."""
    now = as_utc(at) or datetime.now(timezone.utc)
    day = local_day(org, now)

    record = record_for(db, org.id, user.id, day)
    if record is None or record.check_in_at is None:
        # A night shift's attendance day is the date it started, so an 06:00
        # check-out belongs to yesterday's row. Only an *open* one: a closed
        # yesterday must not be reopened by today's stray tap.
        for back in range(1, PUNCH_OUT_LOOKBACK_DAYS + 1):
            candidate = record_for(db, org.id, user.id, day - timedelta(days=back))
            if (
                candidate is not None
                and candidate.check_in_at is not None
                and candidate.check_out_at is None
            ):
                record = candidate
                break

    if record is None or record.check_in_at is None:
        raise _refuse(
            http_status.HTTP_409_CONFLICT,
            "not_punched_in",
            "You have not punched in, so there is nothing to punch out of. "
            "Ask your manager to regularise the day if you forgot.",
        )
    # Only the check-*out* half is guarded, deliberately. A regularised check-in
    # with the day still open is the ordinary "I forgot to punch in this morning
    # and my manager fixed it" case, and refusing the evening punch would force a
    # second regularisation for a punch nobody has decided anything about. An
    # already-regularised check-out is different: a human has ruled on when this
    # person left, and a later tap must not overwrite that ruling.
    if record.check_out_source == PunchSource.REGULARIZED.value:
        raise _refuse(
            http_status.HTTP_409_CONFLICT,
            "day_regularized",
            "This day has an approved regularisation. Ask your manager to "
            "correct it again rather than punching over it.",
        )
    if record.check_out_at is not None:
        raise _refuse(
            http_status.HTTP_409_CONFLICT,
            "already_punched_out",
            "You have already punched out for this day.",
            check_out_at=as_utc(record.check_out_at).isoformat(),
        )

    # Resolved here rather than at the top of the function, because the rule
    # depends on what this person declared *this morning* — punching out of a
    # work-from-home day must not be fenced against the office just because the
    # check-out body carries no mode of its own. That means the record has to be
    # found first, so the geofence check moved below the lookup.
    enforcement = enforcement_for(db, org.id, work_mode=record.work_mode, user=user)
    verdict = _geo_for_punch(db, org.id, lat, lng, accuracy_m, enforcement)

    record.check_out_at = now
    record.check_out_lat = lat
    record.check_out_lng = lng
    record.is_geo_verified_out = verdict.is_verified
    record.check_out_distance_m = verdict.distance_m
    record.check_out_ip = ip
    record.check_out_source = source
    if note:
        record.note = note
    record.worked_minutes = worked_minutes_between(record.check_in_at, record.check_out_at)
    # Status is deliberately NOT refined here. D-010 puts the day classification
    # in the nightly job's hands so that half-day is decided once, against the
    # shift in force, rather than by whichever punch happened to be last.
    db.flush()
    return PunchOutcome(record=record, verdict=verdict, enforcement=enforcement)


# --------------------------------------------------------------------------- #
# Read models — the verdicts D-010 says are never stored
# --------------------------------------------------------------------------- #


def day_out(
    record: AttendanceRecord,
    org: Organization,
    shift: Shift | None = None,
    *,
    user_name: str | None = None,
    include_user: bool = False,
    has_pending_regularization: bool = False,
) -> AttendanceDayOut:
    """One calendar cell: the stored row plus the punctuality verdicts.

    Late and early-out are computed here, on every read, against the shift that
    was in force on ``record.date`` — never read from a column. A stored copy
    goes stale the moment a rota is backdated, and backdating a rota is routine.
    """
    tz = tz_for(org.timezone)
    check_in = as_utc(record.check_in_at)
    check_out = as_utc(record.check_out_at)

    is_late = False
    late_minutes = 0
    is_early_out = False
    early_out_minutes = 0

    if shift is not None:
        shift_start = _local_dt(record.date, shift.start_time, tz)
        shift_end = _local_dt(record.date, shift.end_time, tz)
        # A night shift ends on the following local date. ``<=`` rather than
        # ``<`` so a 22:00-22:00 shift is a full day rather than an instant —
        # the tie the model's ``is_night_shift`` column exists to break.
        if shift.is_night_shift or shift_end <= shift_start:
            shift_end += timedelta(days=1)

        if check_in is not None:
            local_in = check_in.astimezone(tz)
            if local_in > shift_start + timedelta(minutes=shift.grace_minutes):
                is_late = True
                # Counted from the shift start, not from the end of grace: grace
                # decides *whether* somebody is late, not how late they were,
                # and a payroll report that says "5 minutes late" for a 20-minute
                # arrival under a 15-minute grace is simply wrong.
                late_minutes = int((local_in - shift_start).total_seconds() // 60)

        if check_out is not None:
            local_out = check_out.astimezone(tz)
            if local_out < shift_end:
                is_early_out = True
                early_out_minutes = int((shift_end - local_out).total_seconds() // 60)

    return AttendanceDayOut(
        date=record.date,
        status=record.status,
        check_in_at=check_in,
        check_out_at=check_out,
        check_in_source=record.check_in_source,
        check_out_source=record.check_out_source,
        worked_minutes=record.worked_minutes,
        is_geo_verified_in=record.is_geo_verified_in,
        is_geo_verified_out=record.is_geo_verified_out,
        check_in_distance_m=record.check_in_distance_m,
        check_out_distance_m=record.check_out_distance_m,
        work_mode=record.work_mode,
        note=record.note,
        shift_id=shift.id if shift else None,
        shift_name=shift.name if shift else None,
        shift_start_time=shift.start_time if shift else None,
        shift_end_time=shift.end_time if shift else None,
        is_late=is_late,
        late_minutes=late_minutes,
        is_early_out=is_early_out,
        early_out_minutes=early_out_minutes,
        is_missing_punch=check_in is not None and check_out is None,
        is_regularized=(
            record.regularization_id is not None
            or PunchSource.REGULARIZED.value
            in (record.check_in_source, record.check_out_source)
        ),
        has_pending_regularization=has_pending_regularization,
        user_id=record.user_id if include_user else None,
        user_name=user_name if include_user else None,
    )


def history(
    db: Session,
    org: Organization,
    user_ids: list[uuid.UUID],
    start: date,
    end: date,
    *,
    include_user: bool = False,
) -> list[AttendanceDayOut]:
    """Attendance days for a set of people over an inclusive date range.

    Every lookup the per-day view needs — shift assignments, names, pending
    regularisations — is fetched once for the whole range rather than per row.
    A month view for a fifty-person team is otherwise fifteen hundred round
    trips, which is the shape of slow that only shows up on a real tenant.
    """
    if not user_ids or end < start:
        return []

    records = list(
        db.scalars(
            select(AttendanceRecord)
            .where(
                AttendanceRecord.org_id == org.id,
                AttendanceRecord.user_id.in_(user_ids),
                AttendanceRecord.date >= start,
                AttendanceRecord.date <= end,
            )
            .order_by(AttendanceRecord.date, AttendanceRecord.user_id)
        ).all()
    )
    if not records:
        return []

    names = {
        row[0]: row[1]
        for row in db.execute(
            select(User.id, User.full_name).where(
                User.org_id == org.id, User.id.in_(user_ids)
            )
        )
    }
    resolver = ShiftResolver(db, org.id, user_ids)
    pending = {
        (row[0], row[1])
        for row in db.execute(
            select(RegularizationRequest.user_id, RegularizationRequest.date).where(
                RegularizationRequest.org_id == org.id,
                RegularizationRequest.user_id.in_(user_ids),
                RegularizationRequest.date >= start,
                RegularizationRequest.date <= end,
                RegularizationRequest.status == RegularizationStatus.PENDING.value,
            )
        )
    }

    return [
        day_out(
            record,
            org,
            resolver.shift_for(record.user_id, record.date),
            user_name=names.get(record.user_id),
            include_user=include_user,
            has_pending_regularization=(record.user_id, record.date) in pending,
        )
        for record in records
    ]


class ShiftResolver:
    """Answers "which shift was this person on that day" without a query per day.

    The effective-dated table is the right shape for the question and the wrong
    shape for asking it thirty times per employee, so the assignments and shifts
    are loaded once and the range scan happens in Python. Same reasoning as
    ``services/hierarchy.py`` traversing the reporting tree in memory: one
    organisation's rota is hundreds of rows, not millions.
    """

    def __init__(self, db: Session, org_id: uuid.UUID, user_ids: list[uuid.UUID]) -> None:
        self._shifts = {
            shift.id: shift
            for shift in db.scalars(select(Shift).where(Shift.org_id == org_id)).all()
        }
        self._by_user: dict[uuid.UUID, list[ShiftAssignment]] = {}
        if user_ids:
            rows = db.scalars(
                select(ShiftAssignment)
                .where(
                    ShiftAssignment.org_id == org_id,
                    ShiftAssignment.user_id.in_(user_ids),
                )
                .order_by(ShiftAssignment.effective_from.desc())
            ).all()
            for row in rows:
                self._by_user.setdefault(row.user_id, []).append(row)

    def shift_for(self, user_id: uuid.UUID, day: date) -> Shift | None:
        for assignment in self._by_user.get(user_id, []):
            if assignment.effective_from <= day and (
                assignment.effective_to is None or assignment.effective_to >= day
            ):
                return self._shifts.get(assignment.shift_id)
        return None


# --------------------------------------------------------------------------- #
# The nightly status job (D-003, D-007, D-010, D-020)
# --------------------------------------------------------------------------- #


class DayContext:
    """Everything one org-day needs, fetched once instead of per employee."""

    def __init__(
        self,
        db: Session,
        org: Organization,
        day: date,
        user_ids: list[uuid.UUID] | None = None,
    ) -> None:
        self.day = day
        stmt = select(User).where(User.org_id == org.id, User.is_active.is_(True))
        if user_ids is not None:
            stmt = stmt.where(User.id.in_(user_ids))
        users = list(db.scalars(stmt).all())
        self.users = users
        user_ids = [u.id for u in users]

        self.records = {
            record.user_id: record
            for record in db.scalars(
                select(AttendanceRecord).where(
                    AttendanceRecord.org_id == org.id, AttendanceRecord.date == day
                )
            ).all()
        }

        holidays = list(
            db.scalars(
                select(Holiday).where(
                    Holiday.org_id == org.id,
                    Holiday.holiday_date == day,
                    Holiday.is_active.is_(True),
                )
            ).all()
        )
        self.company_holiday = any(not h.is_optional for h in holidays)
        optional_ids = [h.id for h in holidays if h.is_optional]
        self.opted_in: set[uuid.UUID] = set()
        if optional_ids and user_ids:
            self.opted_in = {
                row[0]
                for row in db.execute(
                    select(OptionalHolidayOptIn.user_id).where(
                        OptionalHolidayOptIn.org_id == org.id,
                        OptionalHolidayOptIn.holiday_id.in_(optional_ids),
                        OptionalHolidayOptIn.user_id.in_(user_ids),
                    )
                )
            }

        self.leave: dict[uuid.UUID, LeaveApplication] = {}
        if user_ids:
            for application in db.scalars(
                select(LeaveApplication).where(
                    LeaveApplication.org_id == org.id,
                    LeaveApplication.user_id.in_(user_ids),
                    LeaveApplication.start_date <= day,
                    LeaveApplication.end_date >= day,
                    LeaveApplication.status == LeaveStatus.APPROVED.value,
                )
            ).all():
                self.leave[application.user_id] = application

        self.schedules = {
            schedule.id: schedule
            for schedule in db.scalars(
                select(WorkSchedule).where(WorkSchedule.org_id == org.id)
            ).all()
        }
        self.default_schedule = next(
            (s for s in self.schedules.values() if s.is_default), None
        )
        self.shifts = ShiftResolver(db, org.id, user_ids)

    def schedule_for(self, user: User) -> WorkSchedule | None:
        if user.schedule_id and user.schedule_id in self.schedules:
            return self.schedules[user.schedule_id]
        return self.default_schedule

    def is_weekly_off(self, user: User) -> bool:
        schedule = self.schedule_for(user)
        if schedule is None:
            # No schedule anywhere in the org is a real state for a tenant that
            # never configured one. Saturday and Sunday off is the assumption
            # that is wrong least often, and it is strictly better than marking
            # every weekend absent for the whole company.
            return self.day.weekday() >= 5
        return not schedule.works_on(self.day.weekday())

    def is_holiday(self, user: User) -> bool:
        return self.company_holiday or user.id in self.opted_in


def classify(context: DayContext, user: User, record: AttendanceRecord | None) -> str:
    """The day-status precedence, and the only place it is decided.

    Public, not private, because regularization approval must classify a day
    it has just corrected and has to get the same answer as the nightly job —
    holiday and weekly-off outranking a worked day, in the same order. A
    second classifier in that module would drift the first time either side
    changed, and the failure would be a regularised Sunday quietly reading
    ``present``.
    """
    """The stored six-value day classification, in a fixed precedence.

    Order, and why it is this order:

    1. **Holiday** and 2. **weekly off** outrank a punch. Somebody who came in on
       a public holiday did work — and ``worked_minutes`` still says so — but the
       day is not a working day, and payroll counts working days. Keeping the
       calendar classification is also what makes Phase 4's comp-off credit
       expressible at all: "status is holiday or weekly_off *and*
       worked_minutes > 0" is the whole rule, and it is unavailable if a punch
       has already rewritten the day to ``present``.
    3. **Approved full-day leave** outranks a punch for the same reason: the
       leave ledger has already been debited for that day, and a stray punch
       must not silently make the day both taken and worked.
    4. **The punches themselves**, judged against the shift's half-day threshold.
    5. **Approved half-day leave with no punch at all** — half the day is
       accounted for and the other half was not worked.
    6. **Absent**, which is what is left.
    """
    if context.is_holiday(user):
        return AttendanceStatus.HOLIDAY.value
    if context.is_weekly_off(user):
        return AttendanceStatus.WEEKLY_OFF.value

    application = context.leave.get(user.id)
    if application is not None and not application.is_half_day:
        return AttendanceStatus.ON_LEAVE.value

    if record is not None and record.check_in_at is not None:
        if record.check_out_at is None:
            # An open check-in is not a half day. Worked minutes are unknown, not
            # zero, and classifying "forgot to punch out" as half a day docks
            # somebody's pay for a clerical error the regularisation flow exists
            # to fix. ``is_missing_punch`` is what surfaces it in the console.
            return AttendanceStatus.PRESENT.value
        shift = context.shifts.shift_for(user.id, context.day)
        threshold = shift.half_day_threshold_minutes if shift else 240
        worked = worked_minutes_between(record.check_in_at, record.check_out_at)
        if worked >= threshold:
            return AttendanceStatus.PRESENT.value
        if worked > 0:
            return AttendanceStatus.HALF_DAY.value
        # Punched in and out inside the same minute. Not present, not absent —
        # half_day is the only honest cell in a six-value enum, and it is the one
        # a manager will actually look at.
        return AttendanceStatus.HALF_DAY.value

    if application is not None and application.is_half_day:
        return AttendanceStatus.HALF_DAY.value

    return AttendanceStatus.ABSENT.value


def stamp_org_day(
    db: Session,
    org: Organization,
    day: date,
    user_ids: list[uuid.UUID] | None = None,
    only_existing: bool = False,
) -> dict:
    """Write the stored ``status`` for every active employee for one local date.

    ``user_ids`` and ``only_existing`` exist for the re-trigger paths, not for the
    nightly run, which passes neither. ``only_existing`` re-derives rows that are
    already there without creating any: a corrected rota must not, as a side
    effect, backfill an ``absent`` row for every employee for every day since the
    company installed the product — days the nightly job had not reached yet and
    that nobody asked to have decided.

    **D-007 is enforced here and nowhere else matters.** A row whose
    ``check_in_source`` or ``check_out_source`` is ``regularized`` is skipped
    entirely — not merely left at its current status, but not written to at all,
    including ``worked_minutes``. An approved regularisation is a human decision
    about that day, and a derived job that can overwrite one produces exactly the
    failure the regularisation flow exists to prevent: an unattributable
    attendance edit. Same rule ``services/attribution.py`` applies to manually
    attributed segments.

    **D-020**: every row created here states its ``status`` explicitly. The
    column's ``present`` default is correct on the punch path and a trap on this
    one — a created-then-defaulted row would be a fabricated attendance record
    for somebody who never came in.
    """
    context = DayContext(db, org, day, user_ids)
    result = {"created": 0, "updated": 0, "unchanged": 0, "skipped_regularized": 0}

    for user in context.users:
        # Somebody who had not joined yet was not absent. Without this the job
        # back-fills an absence for every day since the epoch the first time it
        # runs over a historical range.
        if user.joined_on and day < user.joined_on:
            continue

        record = context.records.get(user.id)
        if record is not None and PunchSource.REGULARIZED.value in (
            record.check_in_source,
            record.check_out_source,
        ):
            result["skipped_regularized"] += 1
            continue

        new_status = classify(context, user, record)
        worked = (
            worked_minutes_between(record.check_in_at, record.check_out_at)
            if record is not None
            else 0
        )

        if record is None:
            if only_existing:
                continue
            db.add(
                AttendanceRecord(
                    org_id=org.id,
                    user_id=user.id,
                    date=day,
                    status=new_status,  # D-020: explicit, never the default.
                    worked_minutes=0,
                )
            )
            result["created"] += 1
            continue

        if record.status == new_status and record.worked_minutes == worked:
            result["unchanged"] += 1
            continue
        record.status = new_status
        record.worked_minutes = worked
        result["updated"] += 1

    db.flush()
    return result


def restamp_range(
    db: Session,
    org: Organization,
    start: date,
    end: date,
    user_ids: list[uuid.UUID] | None = None,
    only_existing: bool = False,
) -> dict:
    """Re-run the nightly classification over a past range. See D-010.

    ``user_ids`` narrows it to the people a rota edit actually affected;
    ``None`` means the whole organisation. The range is capped at
    :data:`MAX_RESTAMP_DAYS` so a mistyped ``effective_from`` cannot turn one
    admin click into a decade of writes inside a request.
    """
    totals = {"days": 0, "created": 0, "updated": 0, "unchanged": 0, "skipped_regularized": 0}
    if end < start:
        return totals
    if (end - start).days + 1 > MAX_RESTAMP_DAYS:
        start = end - timedelta(days=MAX_RESTAMP_DAYS - 1)

    day = start
    while day <= end:
        outcome = stamp_org_day(db, org, day, user_ids, only_existing)
        totals["days"] += 1
        for key in ("created", "updated", "unchanged", "skipped_regularized"):
            totals[key] += outcome[key]
        day += timedelta(days=1)
    return totals


def stamp_statuses_for_local_hour(now: datetime | None = None) -> dict:
    """The nightly ``attendance_status`` job. Wakes hourly; acts on org-local time.

    **D-003, and this docstring is where the spec (§8) asks the choice to be
    recorded.** Two approaches were offered: (a) run hourly and act only on
    organisations whose *local* time is currently in the target window, or (b)
    run once at a fixed UTC hour and accept that attendance finalises at a
    different local hour for every tenant. **(a) is implemented.**

    Why: ``organizations.timezone`` already exists, so selecting the orgs whose
    local hour matches ``ATTENDANCE_STATUS_JOB_HOUR_LOCAL`` costs one comparison
    per org — the job is barely longer than the fixed-UTC version. What it buys
    is that a day is finalised after it has actually ended everywhere the company
    is. Under (b), a UTC-midnight run stamps an ``absent`` for an IST tenant at
    05:30 local — half an hour before the employee it just marked absent walks
    in — and every one of those rows is wrong until somebody regularises it.

    The job therefore stamps the *previous* local day, and is idempotent: a
    re-run over a day it already stamped rewrites the same values, skips
    regularised rows (D-007), and reports them separately so a re-run that starts
    skipping thousands of rows is visible rather than silent.

    Registered by the lead in ``app/scheduler.py`` — this module deliberately
    does not import the scheduler, so the job body stays callable from a test,
    from ``--once``, and from a shell without a running loop.
    """
    moment = as_utc(now) or datetime.now(timezone.utc)
    target_hour = app_settings.attendance_status_job_hour_local
    totals = {
        "orgs_considered": 0,
        "orgs_stamped": 0,
        "created": 0,
        "updated": 0,
        "unchanged": 0,
        "skipped_regularized": 0,
    }

    with SessionLocal() as db:
        for org in db.scalars(select(Organization)).all():
            totals["orgs_considered"] += 1
            local_now = moment.astimezone(tz_for(org.timezone))
            if local_now.hour != target_hour:
                continue

            day = local_now.date() - timedelta(days=1)
            try:
                outcome = stamp_org_day(db, org, day)
                db.commit()
            except Exception:
                # One tenant's bad data must not stop the other tenants' days
                # being finalised — the same isolation the scheduler already
                # gives the two existing jobs.
                db.rollback()
                log.exception("attendance status stamp failed for org %s on %s", org.id, day)
                continue

            totals["orgs_stamped"] += 1
            for key in ("created", "updated", "unchanged", "skipped_regularized"):
                totals[key] += outcome[key]

    return totals
