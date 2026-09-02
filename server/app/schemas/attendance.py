"""Request/response shapes for attendance, geofences and shifts.

Two things here are worth reading before using them.

``PunchIn.lat``/``lng`` are optional, and that is the *normal* path, not the
error path: the browser Geolocation API is a permission prompt, and a
meaningful share of users will deny it, be on a desktop with no GPS, or be
indoors behind a captive portal. A punch with no coordinates is a valid punch
that lands unverified — so these fields are not ``Field(...)`` required, and no
validator may make them so.

``AttendanceDayOut`` carries the late/early/half-day flags as *derived* fields
rather than columns. Per spec §2.3 they are computed at read time from the
record plus the shift in force that day; a stored copy goes stale the moment a
shift assignment is backdated, and backdating a rota is routine.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, Field

from app.schemas.common import ORMModel

# Shared so the enum-ish request fields cannot drift from the values the model's
# enum classes define. Bounds on lat/lng are written out at each field rather
# than shared, because a Pydantic FieldInfo is not safe to reuse across fields.
_SOURCE_PATTERN = r"^(web|mobile_web|agent_session|regularized)$"
_STATUS_PATTERN = r"^(present|absent|half_day|on_leave|holiday|weekly_off)$"
_TIME_PATTERN = r"^\d{2}:\d{2}$"


# --- office locations --------------------------------------------------------


class OfficeLocationIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    address: str | None = Field(default=None, max_length=500)
    # Bounded, so a transposed lat/lng pair — a classic and otherwise silent geo
    # bug — is caught by the 90-degree ceiling rather than by a manager
    # wondering why the Bengaluru office is in the sea.
    lat: float = Field(ge=-90.0, le=90.0)
    lng: float = Field(ge=-180.0, le=180.0)
    # Floor of 25 m: anything tighter is smaller than consumer GPS error and
    # would flag every genuine punch. Ceiling of 20 km keeps a fat-fingered
    # radius from silently verifying an entire city.
    radius_m: int = Field(default=200, ge=25, le=20000)
    is_active: bool = True


class OfficeLocationOut(ORMModel):
    id: uuid.UUID
    name: str
    address: str | None = None
    lat: float
    lng: float
    radius_m: int
    is_active: bool
    created_at: datetime


# --- per-org policy ----------------------------------------------------------


#: Per-mode overrides accept the three enforcement levels plus ``inherit``.
#:
#: ``inherit`` rather than ``null`` because this is a PATCH body where ``None``
#: already means "leave this field alone". Without a distinct token there would
#: be no way to say "stop overriding Office and follow the org policy again" —
#: the field would be write-once, which is exactly the kind of setting people
#: change their mind about.
_MODE_POLICY_PATTERN = r"^(inherit|off|flag_only|required)$"


class AttendanceSettingsIn(BaseModel):
    """PATCH semantics — None means "leave unchanged", as in OrgSettingsUpdate."""

    geofence_enforcement: str | None = Field(default=None, pattern=r"^(off|flag_only|required)$")

    # Per-work-mode overrides of the policy above. See _MODE_POLICY_PATTERN for
    # why "inherit" is a value rather than null.
    geofence_office: str | None = Field(default=None, pattern=_MODE_POLICY_PATTERN)
    geofence_work_from_home: str | None = Field(default=None, pattern=_MODE_POLICY_PATTERN)
    geofence_on_duty: str | None = Field(default=None, pattern=_MODE_POLICY_PATTERN)


class AttendanceSettingsOut(ORMModel):
    geofence_enforcement: str
    # Derived: 'required' is meaningless with no active geofence, and a tenant
    # that switches it on before adding an office would lock every employee out
    # of punching. The console needs this to warn them, in the same payload.
    active_location_count: int = 0

    # None on the wire means "following geofence_enforcement". The console
    # renders that as a real choice rather than a blank, so an administrator can
    # see which modes have been decided and which are riding the default.
    geofence_office: str | None = None
    geofence_work_from_home: str | None = None
    geofence_on_duty: str | None = None


# --- shifts ------------------------------------------------------------------


class ShiftIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    start_time: str = Field(default="09:00", pattern=_TIME_PATTERN)
    end_time: str = Field(default="18:00", pattern=_TIME_PATTERN)
    grace_minutes: int = Field(default=15, ge=0, le=240)
    # Minutes, matching the column and WorkSchedule's other durations. The
    # spec's hours figure is served back on ShiftOut as a derived field.
    half_day_threshold_minutes: int = Field(default=240, ge=30, le=720)
    is_night_shift: bool = False
    is_active: bool = True


class ShiftOut(ORMModel):
    id: uuid.UUID
    name: str
    start_time: str
    end_time: str
    grace_minutes: int
    half_day_threshold_minutes: int
    #: The spec's ``half_day_threshold_hours``, from the model property.
    half_day_threshold_hours: float
    is_night_shift: bool
    is_active: bool
    #: Clock span, wrapping midnight. From the model property.
    expected_minutes: int
    #: Derived, so the shift list needs no client-side join.
    assigned_count: int = 0


# --- shift assignments -------------------------------------------------------


class ShiftAssignmentIn(BaseModel):
    user_id: uuid.UUID
    shift_id: uuid.UUID
    effective_from: date
    #: None = current, open-ended. The service closes any previous open row at
    #: effective_from - 1 rather than letting two rows overlap.
    effective_to: date | None = None


class ShiftAssignmentOut(ORMModel):
    id: uuid.UUID
    user_id: uuid.UUID
    shift_id: uuid.UUID
    effective_from: date
    effective_to: date | None = None
    # Derived, so the rota table needs no client-side joins.
    user_name: str | None = None
    shift_name: str | None = None
    shift_start_time: str | None = None
    shift_end_time: str | None = None
    #: effective_to IS NULL — spelled out so the console does not re-derive it.
    is_current: bool = False


# --- punching ----------------------------------------------------------------


class PunchIn(BaseModel):
    """Body of a check-in or check-out from the web console or the PWA.

    Every field is optional. Geolocation may be denied, unavailable or simply
    slow, and the punch must still succeed — the server records what it was
    given and flags what it could not verify. See the module docstring.
    """

    lat: float | None = Field(default=None, ge=-90.0, le=90.0)
    lng: float | None = Field(default=None, ge=-180.0, le=180.0)
    # The browser's own ±metres estimate (``coords.accuracy``). Not stored, but
    # the geofence check should widen its tolerance by it: a device reporting
    # ±500 m has told you outright that a hard fail is meaningless, and flagging
    # it anyway is the drift problem spec §2.2 is trying to avoid.
    accuracy_m: int | None = Field(default=None, ge=0, le=100000)
    source: str = Field(default="web", pattern=r"^(web|mobile_web)$")
    # Why this punch looks odd, typed by the employee at the time — "at the
    # client's office today". Cheaper for everyone than a regularisation.
    note: str | None = Field(default=None, max_length=500)
    # Where they say they are working. Optional, and absent is not an error: the
    # desktop agent fills attendance from a work session and has no idea whether
    # the desk is at home, and a punch from an older client predates the field.
    # Both fall back to the org-wide geofence policy, which is what they got
    # before this existed.
    work_mode: str | None = Field(
        default=None, pattern=r"^(office|work_from_home|on_duty)$"
    )


class PunchResultOut(ORMModel):
    """What a punch returns: the day's row plus the geofence verdict.

    The verdict is separate from the record because it is about *this* punch,
    and because the console has to say something specific — "recorded, but we
    could not confirm you were at an office" reads very differently from
    "recorded at Whitefield".
    """

    record: AttendanceDayOut
    is_geo_verified: bool
    distance_m: int | None = None
    nearest_office_name: str | None = None
    #: The policy that was applied — off / flag_only / required.
    enforcement: str


# --- attendance records ------------------------------------------------------


class AttendanceRecordIn(BaseModel):
    """Admin-side write. **Not** an employee-facing shape.

    Employees never edit their own attendance — spec §2.5, the same rule as
    timesheets. This exists for HR correcting a day and for bulk import of
    history at go-live; the regularisation path writes through Dev 3's service,
    not through here.
    """

    user_id: uuid.UUID
    date: date
    check_in_at: datetime | None = None
    check_out_at: datetime | None = None
    check_in_source: str | None = Field(default=None, pattern=_SOURCE_PATTERN)
    check_out_source: str | None = Field(default=None, pattern=_SOURCE_PATTERN)
    status: str | None = Field(default=None, pattern=_STATUS_PATTERN)
    note: str | None = Field(default=None, max_length=500)


class AttendanceRecordOut(ORMModel):
    """The stored row, verbatim. Used by exports and the audit view.

    The console's calendar and day views want ``AttendanceDayOut`` instead —
    this one is deliberately raw, with nothing derived, so an export matches
    what is actually in the table.
    """

    id: uuid.UUID
    user_id: uuid.UUID
    date: date
    check_in_at: datetime | None = None
    check_out_at: datetime | None = None
    check_in_lat: float | None = None
    check_in_lng: float | None = None
    check_out_lat: float | None = None
    check_out_lng: float | None = None
    is_geo_verified_in: bool
    is_geo_verified_out: bool
    check_in_distance_m: int | None = None
    check_out_distance_m: int | None = None
    check_in_ip: str | None = None
    check_out_ip: str | None = None
    check_in_source: str | None = None
    check_out_source: str | None = None
    status: str
    worked_minutes: int
    regularization_id: uuid.UUID | None = None
    note: str | None = None
    created_at: datetime


class AttendanceDayOut(ORMModel):
    """One cell of the attendance calendar, and one row of the daily muster.

    Shaped so the console renders a month without a second request and without
    a single client-side join: the shift that applied, the punches, and the
    late/early verdicts already computed against that shift.

    Every ``*_minutes`` verdict is 0 rather than None when it does not apply, so
    the frontend styles on a truthy check instead of a three-way one. The
    booleans are the ones it actually branches on.
    """

    date: date
    status: str

    check_in_at: datetime | None = None
    check_out_at: datetime | None = None
    check_in_source: str | None = None
    check_out_source: str | None = None
    worked_minutes: int = 0

    is_geo_verified_in: bool = False
    is_geo_verified_out: bool = False
    check_in_distance_m: int | None = None
    check_out_distance_m: int | None = None

    #: What the employee declared at check-in — office / work_from_home /
    #: on_duty. Served alongside the geofence verdict rather than instead of it:
    #: "work from home" on a row measured 400 m from the office is a
    #: contradiction a manager should be able to see.
    work_mode: str | None = None
    #: Typed by the employee at the punch. Often the only record of *which*
    #: client site an on-duty day was at.
    note: str | None = None

    # --- the shift this day was judged against -------------------------------
    # Carried per-day, not per-response: a month can legitimately span a shift
    # change, and a single "current shift" at the top of the payload would
    # mislabel every day before the switch.
    shift_id: uuid.UUID | None = None
    shift_name: str | None = None
    shift_start_time: str | None = None
    shift_end_time: str | None = None

    # --- computed at read time, never stored (spec §2.3) ---------------------
    is_late: bool = False
    late_minutes: int = 0
    is_early_out: bool = False
    early_out_minutes: int = 0
    #: No check-out on a day that has a check-in. Its own flag because it is the
    #: single most common thing an employee needs to fix, and the calendar has
    #: to surface it without the reader inferring it from two nulls.
    is_missing_punch: bool = False

    # --- regularisation state -------------------------------------------------
    #: True when this row was written or corrected by an approved request.
    is_regularized: bool = False
    #: A request already exists for this date, so the console offers "view"
    #: rather than a second "request regularisation" the server would reject.
    has_pending_regularization: bool = False

    # Present on the org-wide muster, absent (None) on an employee's own
    # calendar, where the identity is the page.
    user_id: uuid.UUID | None = None
    user_name: str | None = None


# PunchResultOut references AttendanceDayOut, which is defined after it.
PunchResultOut.model_rebuild()
