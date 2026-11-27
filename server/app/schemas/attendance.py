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

import re
import uuid
from datetime import date, datetime

from pydantic import BaseModel, Field, field_validator, model_validator

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
    lat: float | None = Field(default=None, ge=-90.0, le=90.0)
    lng: float | None = Field(default=None, ge=-180.0, le=180.0)
    # Floor of 25 m: anything tighter is smaller than consumer GPS error and
    # would flag every genuine punch. Ceiling of 20 km keeps a fat-fingered
    # radius from silently verifying an entire city.
    radius_m: int = Field(default=200, ge=25, le=20000)
    is_active: bool = True
    branch_id: uuid.UUID | None = None
    state: str | None = Field(default=None, max_length=120)
    district: str | None = Field(default=None, max_length=120)
    city: str | None = Field(default=None, max_length=120)

    @model_validator(mode="after")
    def _both_or_neither(self):
        """A latitude without a longitude is a half-entered point, not a place."""
        if (self.lat is None) != (self.lng is None):
            raise ValueError("Give both latitude and longitude, or neither")
        return self


class OfficeLocationOut(ORMModel):
    id: uuid.UUID
    name: str
    address: str | None = None
    branch_id: uuid.UUID | None = None
    branch_name: str | None = None
    state: str | None = None
    district: str | None = None
    city: str | None = None
    lat: float | None = None
    lng: float | None = None
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

    # Overtime policy. None leaves it as it is.
    overtime_enabled: bool | None = None
    overtime_min_minutes: int | None = Field(default=None, ge=0, le=480)
    overtime_on_off_days: bool | None = None
    overtime_rate_mode: str | None = Field(default=None, pattern=r"^(salary|flat)$")
    overtime_derived_from: str | None = Field(default=None, pattern=r"^(basic|ctc)$")
    overtime_flat_rate_paise: int | None = Field(default=None, ge=0, le=100_000_000)
    overtime_mult_working_x100: int | None = Field(default=None, ge=0, le=1000)
    overtime_mult_off_x100: int | None = Field(default=None, ge=0, le=1000)
    overtime_mult_holiday_x100: int | None = Field(default=None, ge=0, le=1000)
    overtime_round_minutes: int | None = Field(default=None, ge=0, le=120)
    overtime_max_hours_month: int | None = Field(default=None, ge=0, le=744)
    overtime_requires_approval: bool | None = None
    overtime_pay_through_payroll: bool | None = None

    # Punch methods. None leaves them as they are.
    gps_tracking_enabled: bool | None = None
    manual_enabled: bool | None = None
    manual_web_enabled: bool | None = None
    manual_mobile_enabled: bool | None = None
    face_enabled: bool | None = None
    biometric_enabled: bool | None = None


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

    gps_tracking_enabled: bool = True
    overtime_enabled: bool = True
    overtime_min_minutes: int = 0
    overtime_on_off_days: bool = True
    overtime_rate_mode: str = "salary"
    overtime_derived_from: str = "basic"
    overtime_flat_rate_paise: int = 0
    overtime_mult_working_x100: int = 100
    overtime_mult_off_x100: int = 200
    overtime_mult_holiday_x100: int = 200
    overtime_round_minutes: int = 0
    overtime_max_hours_month: int = 0
    overtime_requires_approval: bool = True
    overtime_pay_through_payroll: bool = False

    manual_enabled: bool = True
    manual_web_enabled: bool = True
    manual_mobile_enabled: bool = True
    face_enabled: bool = False
    biometric_enabled: bool = False


# --- devices -----------------------------------------------------------------


_IP_WILDCARD = re.compile(r"^(\d{1,3}|\*)(\.(\d{1,3}|\*)){3}$")


def _valid_ip_rule(rule: str) -> bool:
    """An address, a CIDR range, or a wildcard such as 192.168.1.*"""
    import ipaddress

    try:
        ipaddress.ip_network(rule, strict=False)
        return True
    except ValueError:
        pass
    return bool(_IP_WILDCARD.match(rule)) and "*" in rule and all(p == "*" or int(p) <= 255 for p in rule.split("."))


class DeviceIn(BaseModel):
    kind: str = Field(pattern=r"^(face|biometric)$")
    name: str = Field(min_length=1, max_length=120)
    device_code: str | None = Field(default=None, max_length=80)
    location_id: uuid.UUID | None = None
    branch_id: uuid.UUID | None = None
    is_active: bool = True

    location_required: bool = False
    lat: float | None = Field(default=None, ge=-90.0, le=90.0)
    lng: float | None = Field(default=None, ge=-180.0, le=180.0)
    radius_m: int | None = Field(default=None, ge=25, le=20000)
    ip_required: bool = False
    allowed_ips: str | None = Field(default=None, max_length=4000)
    protocol: str = Field(default="generic", pattern=r"^(generic|zkteco|essl|realtime)$")
    cooldown_s: int = Field(default=120, ge=0, le=3600)
    allowed_from_min: int = Field(default=120, ge=0, le=1440)
    allowed_until_min: int = Field(default=240, ge=0, le=1440)

    @field_validator("device_code")
    @classmethod
    def _tidy(cls, value: str | None) -> str | None:
        value = (value or "").strip()
        return value or None

    @field_validator("allowed_ips")
    @classmethod
    def _tidy_ips(cls, value: str | None) -> str | None:
        lines = [line.strip() for line in (value or "").replace(",", "\n").splitlines() if line.strip()]
        bad = [line for line in lines if not _valid_ip_rule(line)]
        if bad:
            raise ValueError(f"Not an IP address, range or wildcard: {bad[0]}")
        return "\n".join(lines) or None

    @model_validator(mode="after")
    def _what_each_switch_needs(self):
        if self.location_required and (self.lat is None or self.lng is None or self.radius_m is None):
            raise ValueError("Location required needs a latitude, a longitude and a radius")
        if self.ip_required and not self.allowed_ips:
            raise ValueError("IP address required needs at least one allowed address")
        return self


class DeviceOut(ORMModel):
    id: uuid.UUID
    kind: str
    name: str
    device_code: str | None = None
    location_id: uuid.UUID | None = None
    location_name: str | None = None
    branch_id: uuid.UUID | None = None
    branch_name: str | None = None
    is_active: bool
    location_required: bool = False
    lat: float | None = None
    lng: float | None = None
    radius_m: int | None = None
    ip_required: bool = False
    allowed_ips: str | None = None
    protocol: str = "generic"
    cooldown_s: int = 120
    allowed_from_min: int = 120
    allowed_until_min: int = 240


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
    # Left out by older clients: then the stored value is kept.
    full_day_minutes: int = Field(default=480, ge=60, le=1440)
    break_minutes: int = Field(default=60, ge=0, le=480)
    #: {"sun": "all", "sat": "2,4"} — weekday: "all" or the occurrences (1-5, last).
    week_offs: dict[str, str] | None = None
    color: str = Field(default="#2563eb", pattern=r"^#[0-9a-fA-F]{6}$")
    is_default: bool = False

    @field_validator("week_offs")
    @classmethod
    def _a_real_pattern(cls, value):
        if not value:
            return None
        days = {"mon", "tue", "wed", "thu", "fri", "sat", "sun"}
        out: dict[str, str] = {}
        for day, rule in value.items():
            if day not in days:
                raise ValueError(f"Not a weekday: {day}")
            parts = [p.strip() for p in str(rule).split(",") if p.strip()]
            if rule != "all" and (not parts or any(p not in {"1", "2", "3", "4", "5", "last"} for p in parts)):
                raise ValueError(f"{day}: use all, or any of 1, 2, 3, 4, 5, last")
            out[day] = "all" if rule == "all" else ",".join(parts)
        return out


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
    full_day_minutes: int = 480
    full_day_hours: float = 8
    break_minutes: int = 60
    week_offs: dict[str, str] | None = None
    color: str = "#2563eb"
    is_default: bool = False
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
