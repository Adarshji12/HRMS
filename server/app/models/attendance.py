"""Attendance: office geofences, shifts, shift history and the daily record.

Owns four tables — ``office_locations``, ``shifts``, ``shift_assignments`` and
``attendance_records`` — plus the per-org ``attendance_settings`` row that holds
the geofence policy.

The one decision a reader would otherwise get wrong: **an attendance row is not
a verdict, it is a set of observations.** ``check_in_at`` and ``check_out_at``
are nullable independently because a missed punch is a real, visible state that
a manager has to see and a regularisation has to fix — it is not a validation
error, and it is not a reason to refuse the row. Likewise a punch from outside
every geofence is stored with ``is_geo_verified_in = False`` and the measured
distance rather than rejected: GPS drifts 50 m indoors, and a product that hard-
blocks on that stops being used on day one. The only derived value stored here
is ``status``, and only because the nightly job writes it so month-end reports
are one indexed scan instead of a per-day recomputation. Late / early / half-day
are deliberately *not* stored — they depend on the shift in force that day, and
a stored copy goes stale the moment someone's shift assignment is corrected.
"""

from __future__ import annotations

import enum
import uuid
from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Uuid,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDMixin

#: Hard ceiling the punch and nightly-attendance services clamp ``worked_minutes``
#: to. Lives here, next to the column, so the service that computes it and the
#: job that recomputes it cannot drift apart on the number. 16h, not 24h: a
#: forgotten check-out that ran to midnight would otherwise book a full day of
#: overtime for someone who went home at six, and payroll reads this column.
MAX_WORKED_MINUTES_PER_DAY = 16 * 60


class AttendanceStatus(str, enum.Enum):
    """What a day *was*, decided by the nightly job — never live.

    Computing this on read would mean every month view re-derives 30 days per
    employee against shifts, holidays and the leave ledger. Reports are the
    thing tenants run on the 1st of the month for the whole company at once, so
    the cost lands exactly where it hurts most. The job writes it once.
    """

    PRESENT = "present"
    ABSENT = "absent"
    HALF_DAY = "half_day"
    ON_LEAVE = "on_leave"
    HOLIDAY = "holiday"
    WEEKLY_OFF = "weekly_off"


class PunchSource(str, enum.Enum):
    """How a timestamp got onto the row.

    ``AGENT_SESSION`` is the seam to module 1: for a desk employee who already
    runs the agent, the attendance service fills check-in/check-out from
    ``work_sessions.started_at``/``ended_at`` and never asks them to punch (see
    spec §1.1). Field staff punch from ``WEB``/``MOBILE_WEB``. Neither is a
    special case in the schema — only in which service writes the row — which is
    exactly why this is one column and not an ``is_agent`` boolean.

    ``REGULARIZED`` means a human decision replaced the observation. It must
    stay distinguishable forever: a report that cannot tell a measured punch
    from an approved correction is not an audit trail.
    """

    WEB = "web"
    MOBILE_WEB = "mobile_web"
    AGENT_SESSION = "agent_session"
    REGULARIZED = "regularized"


class GeofenceEnforcement(str, enum.Enum):
    """Per-org geofence policy.

    ``FLAG_ONLY`` is the default and the only sane one for most tenants: the
    punch is accepted, ``is_geo_verified_*`` records the truth, and a manager
    decides. ``REQUIRED`` is the sole mode that refuses a punch, and even then
    the API must answer with a typed, renderable error rather than a bare 4xx.
    ``OFF`` skips the distance computation entirely, for tenants with no offices
    (fully remote) where every punch would otherwise be flagged forever.
    """

    OFF = "off"
    FLAG_ONLY = "flag_only"
    REQUIRED = "required"


class OfficeLocation(UUIDMixin, TimestampMixin, Base):
    """One geofenced site: a centre point and a radius, in metres.

    A punch is verified if it falls inside *any* active location for the org.
    Multi-office tenants are the normal case, not an edge case, so the check is
    a min-distance over the set rather than a single "the office" on the org.
    """

    __tablename__ = "office_locations"
    __table_args__ = (
        UniqueConstraint("org_id", "name", name="uq_office_locations_org_name"),
        # The punch path fetches every active location for one org on every
        # punch; this is the index that keeps that a two-column lookup.
        Index("ix_office_locations_org_active", "org_id", "is_active"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    address: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # Float, not Integer-scaled or Numeric, and this is not a violation of the
    # money-is-paise rule: a coordinate is a measurement, not a quantity that
    # has to add up exactly. Float here is double precision on both Postgres and
    # SQLite — roughly 0.1 mm of latitude — against a geofence measured in
    # hundreds of metres. Numeric would only force a Decimal-to-float conversion
    # inside every Haversine call for no accuracy anyone can stand in.
    lat: Mapped[float] = mapped_column(Float, nullable=False)
    lng: Mapped[float] = mapped_column(Float, nullable=False)

    # Metres. 200 m is deliberately loose: consumer GPS indoors is routinely off
    # by 50-100 m, and the cost of a false flag (a manager chasing a present
    # employee) is higher than the cost of a false pass.
    radius_m: Mapped[int] = mapped_column(Integer, default=200, nullable=False)

    # Deactivated rather than deleted: attendance rows already flagged against
    # this site keep their meaning, and a closed office can be reopened.
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class AttendanceSettings(TimestampMixin, Base):
    """Per-tenant attendance policy. One row per organisation.

    Deliberately a separate table rather than more columns on ``org_settings``.
    ``org_settings`` is the payload the desktop agent pulls on *every* heartbeat
    and the shape ``OrgSettingsOut``/``OrgSettingsUpdate`` promise to the
    console; widening it with policy the agent will never read makes a hot,
    already-public contract bigger for no gain. Keeping attendance policy on its
    own row also means the attendance module's future knobs land here instead of
    in a table three other modules already share.

    Same primary-key shape as ``OrgSettings``: ``org_id`` *is* the key, so the
    1:1 with the organisation is enforced by the database rather than by a
    service remembering to check.
    """

    __tablename__ = "attendance_settings"

    # PK, so it is indexed and unique by definition — no separate index=True,
    # which would only add a redundant second index. Follows OrgSettings.
    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), primary_key=True
    )

    geofence_enforcement: Mapped[str] = mapped_column(
        String(16), default=GeofenceEnforcement.FLAG_ONLY.value, nullable=False
    )


class Shift(UUIDMixin, TimestampMixin, Base):
    """A named working window: when the day starts, ends, and how much slack.

    Distinct from ``WorkSchedule`` (org_structure.py) on purpose. A schedule
    answers "how many hours is this person expected to bill" for timesheets and
    overtime; a shift answers "at what clock time were they supposed to be at
    the door" for attendance. They diverge constantly — a 9h schedule can be
    served by a 06:00 shift or a 14:00 one — and merging them would force every
    tenant running rotations to pick which of the two questions to answer wrong.
    """

    __tablename__ = "shifts"
    __table_args__ = (UniqueConstraint("org_id", "name", name="uq_shifts_org_name"),)

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)

    # "HH:MM" wall-clock in the org's timezone, matching WorkSchedule exactly.
    # Not a Time column: these are compared against a Date plus a tz to make a
    # real instant anyway, and String sidesteps SQLite's Time adapter, which
    # round-trips differently from Postgres.
    start_time: Mapped[str] = mapped_column(String(5), default="09:00", nullable=False)
    end_time: Mapped[str] = mapped_column(String(5), default="18:00", nullable=False)

    # Minutes after start_time that still count as on time. Not "is late" logic
    # — that is computed at read time from this plus the record.
    grace_minutes: Mapped[int] = mapped_column(Integer, default=15, nullable=False)

    # Minutes, not the hours the spec names, for two reasons: every other
    # duration in this codebase is integer minutes (WorkSchedule.break_minutes,
    # overtime_after_minutes), and a 4.5-hour threshold is completely normal, so
    # an hours column would have to be a float. ``half_day_threshold_hours`` is
    # still what the API exposes — see the property below and ShiftOut.
    half_day_threshold_minutes: Mapped[int] = mapped_column(
        Integer, default=240, nullable=False
    )

    # Stored, not derived from end_time < start_time. A night shift's attendance
    # day belongs to the date it *started*, so the nightly job needs the answer
    # without re-parsing two strings, and a 22:00-06:00 shift and a hypothetical
    # 22:00-22:00 one must not be told apart by a comparison that ties.
    is_night_shift: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    @property
    def half_day_threshold_hours(self) -> float:
        """The spec's ``half_day_threshold_hours``, served from the minutes column."""
        return self.half_day_threshold_minutes / 60.0

    @property
    def expected_minutes(self) -> int:
        """Clock span of the shift, wrapping past midnight for night shifts.

        Mirrors ``WorkSchedule.expected_minutes`` so the two never disagree
        about what "overnight" means. No break subtraction: breaks belong to the
        schedule, which is what timesheets bill against.
        """
        start_h, start_m = (int(p) for p in self.start_time.split(":"))
        end_h, end_m = (int(p) for p in self.end_time.split(":"))
        span = (end_h * 60 + end_m) - (start_h * 60 + start_m)
        if span <= 0:
            span += 24 * 60
        return span


class ShiftAssignment(UUIDMixin, TimestampMixin, Base):
    """Which shift a person was on, over a half-open date range.

    Effective-dated rather than a ``users.shift_id`` column — and note this is a
    genuine departure from the ``users.schedule_id`` precedent, not an accident.
    A schedule can be a current-value pointer because timesheets are approved
    and frozen at the moment of sign-off, so rewriting the pointer cannot change
    a number anyone already agreed to. Attendance has no such snapshot: the
    nightly job recomputes ``status`` for a date, so it must be able to ask
    "which shift was this person on *on 14 March*", months later. A single
    current-value column answers that question with today's shift and silently
    marks a whole rota's worth of night-shift days late.

    ``effective_to IS NULL`` means "still current". Ranges are half-open at the
    end in intent — ``effective_to`` is the last day the assignment applies, and
    the next assignment starts the day after — because HR data is quoted to
    people in inclusive dates ("you're on nights until the 30th").
    """

    __tablename__ = "shift_assignments"
    __table_args__ = (
        # The portable half of "no overlapping assignments per user": two rows
        # cannot start on the same day. Full overlap prevention needs a Postgres
        # EXCLUDE on a daterange, which SQLite cannot express and this codebase
        # has to run on both — so the service closes the previous row before
        # opening a new one, and this constraint catches the double-submit.
        UniqueConstraint(
            "user_id", "effective_from", name="uq_shift_assignments_user_effective_from"
        ),
        # The lookup this table exists for: "the shift in force for this user on
        # this date" — an equality on user_id and a descending range scan on
        # effective_from, stopped at the first row.
        Index("ix_shift_assignments_user_effective", "user_id", "effective_from"),
        # Rota admin: "everyone on the night shift right now".
        Index("ix_shift_assignments_org_shift", "org_id", "shift_id"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # RESTRICT, not SET NULL or CASCADE: an assignment with no shift is
    # meaningless, and deleting the assignments would erase the history the
    # nightly job re-reads. Deactivate the shift (``is_active``) instead — the
    # database says no to the delete, which is the correct answer.
    shift_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("shifts.id", ondelete="RESTRICT"), nullable=False, index=True
    )

    effective_from: Mapped[date] = mapped_column(Date, nullable=False)
    #: NULL = current, with no end date yet.
    effective_to: Mapped[date | None] = mapped_column(Date, nullable=True)


class AttendanceRecord(UUIDMixin, TimestampMixin, Base):
    """One row per employee per calendar day. The central attendance table.

    The unique constraint on ``(org_id, user_id, date)`` is the same dedup
    discipline as ``client_uid`` on ``activity_segments``: the punch endpoint is
    retried by flaky mobile networks and the nightly job re-runs over dates it
    has already touched, so both write through an upsert that collides here
    instead of double-booking a day. Correctness lives in the constraint, not in
    a service remembering to SELECT first.
    """

    __tablename__ = "attendance_records"
    __table_args__ = (
        UniqueConstraint(
            "org_id", "user_id", "date", name="uq_attendance_records_org_user_date"
        ),
        # Employee calendar and payroll export: one user, a month or a year of
        # dates. The unique constraint above cannot serve this — it leads with
        # org_id, so a user-scoped range would scan every employee in the
        # tenant. Same reasoning as ix_segments_user_started on activity.
        Index("ix_attendance_records_user_date", "user_id", "date"),
        # The daily muster — "who is in today", the console's landing view, and
        # the nightly job's own working set: one org, one date, every user. The
        # unique constraint's (org_id, user_id, date) prefix cannot answer it
        # without walking every user's whole history.
        Index("ix_attendance_records_org_date", "org_id", "date"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )

    # Date, not DateTime, and it means the attendance day in the *organisation's*
    # timezone — never UTC midnight. An IST tenant punching in at 09:00 local is
    # 03:30 UTC, so a UTC-derived day boundary would be right; but the same
    # tenant's 22:00 night-shift punch is 16:30 UTC the same day while their
    # 01:00 punch is 19:30 UTC the *previous* one, and a UTC day would split one
    # human shift across two rows and break the unique constraint's whole point.
    # Storing the resolved local day makes a month view an equality range
    # instead of a timezone-shifted timestamp window on every query — the same
    # call TimeEntry.entry_date already made.
    date: Mapped[date] = mapped_column(Date, nullable=False)

    # --- observations --------------------------------------------------------
    #
    # Nullable *independently*. Check-in without check-out is the single most
    # common real state in any attendance system — it is what every employee
    # currently at their desk looks like, and it is what a forgotten evening
    # punch looks like. Requiring both would mean either refusing the morning
    # punch or inventing a fake check-out, and both are worse than a NULL.
    check_in_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    check_out_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    check_in_lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    check_in_lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    check_out_lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    check_out_lng: Mapped[float | None] = mapped_column(Float, nullable=True)

    # False, not NULL, when unverified — including when the browser denied
    # geolocation. "We could not confirm you were at an office" and "you were
    # not at an office" are the same fact from the manager's chair, and a
    # nullable tri-state would make every filter in the console write IS NOT
    # TRUE instead of = false.
    is_geo_verified_in: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_geo_verified_out: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # Metres to the nearest active office at punch time, NULL when no coordinate
    # was supplied or the org has no active offices. Two columns, not the one
    # the spec's §2.2 prose names: §2.4 verifies check-in and check-out
    # separately, so a single distance could only ever describe one of them.
    check_in_distance_m: Mapped[int | None] = mapped_column(Integer, nullable=True)
    check_out_distance_m: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Secondary signal only — never blocks a punch. Useful precisely when
    # geolocation is absent: an office-LAN egress IP is weak evidence, but it is
    # the only evidence left when someone denies the browser prompt. 45 chars
    # fits a full IPv6 literal with an embedded IPv4 tail.
    check_in_ip: Mapped[str | None] = mapped_column(String(45), nullable=True)
    check_out_ip: Mapped[str | None] = mapped_column(String(45), nullable=True)

    check_in_source: Mapped[str | None] = mapped_column(String(20), nullable=True)
    check_out_source: Mapped[str | None] = mapped_column(String(20), nullable=True)

    # --- derived, written by the nightly job ---------------------------------
    #
    # Defaults to "present" rather than being nullable: a row that exists
    # because somebody punched is present until the job refines it, and every
    # absent/holiday/weekly-off row is created by the job in the first place.
    # A nullable status would push a "what does NULL mean here" branch into
    # every report, dashboard tile and export in the module.
    # No index of its own: six values over the whole table is too low a
    # cardinality for a planner to ever prefer it, and every real query for a
    # status ("who was absent in March") is already scoped by org and a date
    # range, which ix_attendance_records_org_date answers.
    status: Mapped[str] = mapped_column(
        String(16), default=AttendanceStatus.PRESENT.value, nullable=False
    )
    # Clamped to MAX_WORKED_MINUTES_PER_DAY. 0 rather than NULL for a day with
    # no check-out, so SUM() over a month is a plain aggregate.
    worked_minutes: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    # --- provenance ----------------------------------------------------------
    #
    # Set when this row was created or edited by an approved regularisation.
    # Referenced by table name so this module needs no import of Dev 3's
    # module — and there is no cycle to break: regularization_requests does not
    # point back here. SET NULL, not CASCADE: purging an old request must not
    # delete the attendance day it corrected, which is the record payroll ran
    # against.
    regularization_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey("regularization_requests.id", ondelete="SET NULL"),
        nullable=True,
    )

    # Free-text, shown next to the day in the console. Carries the "why" a punch
    # looks odd — "client site visit", or the approver's note on a
    # regularisation — so a flagged row is explainable without opening it.
    note: Mapped[str | None] = mapped_column(String(500), nullable=True)
