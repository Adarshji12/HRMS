"""Leave management: settings, policy, balances, applications, holidays, comp-off.

**The one thing to get right here is that a leave balance is never a stored
number.** ``LeaveBalance`` holds four components — ``opening``, ``accrued``,
``used``, ``adjusted`` — and the balance is their sum, computed at read time by
the :attr:`LeaveBalance.balance_milli_days` property. There is deliberately no
``balance`` column, and adding one later would be a regression.

Why it matters enough to shape the schema:

* A single running number can only be corrected by overwriting it. The moment
  HR fixes someone's balance by hand, the reason and the size of the correction
  are gone, and the only record that the number ever moved is a log line nobody
  reads. With components, "opening 12, accrued 6, used 4, adjusted +2" *shows*
  that somebody granted two extra days, forever, on the row itself.
* Every component has exactly one writer, so a bug is attributable rather than
  merely visible: the ``leave_accrual`` job writes ``accrued``, leave approval
  writes ``used``, the year rollover writes ``opening``, and only a human with
  ``can_approve_leave`` writes ``adjusted``. A single ``balance`` column would
  have four writers racing on one integer.
* Recomputation stays possible. If accrual is ever found to have been wrong,
  the fix is to recompute ``accrued`` from policy; a running total cannot be
  recomputed without also destroying the manual corrections mixed into it.

**Units.** Every leave quantity in this module is an integer count of
**milli-days** (1/1000 of one working day), following the same fixed-minor-unit
discipline the billing tables already use for money in paise, and for the same
reason: a leave balance is arithmetic somebody eventually gets paid or not paid
for, and binary floats cannot hold 0.1 of anything exactly. Two rejected
alternatives, so nobody re-litigates this in Phase 4:

* *Integer days* cannot represent the half-day leave the spec explicitly
  requires (``leave_applications.is_half_day``).
* *Minutes* look tempting next to ``TimeEntry.minutes``, but a leave "day" is a
  policy unit, not a duration. "18 days of casual leave" does not become 19.2
  days because somebody moved from an 8-hour to a 7.5-hour ``WorkSchedule``.
  Pegging the balance to minutes silently re-values everyone's accrued leave
  every time a schedule changes. The day is the stable unit; only its
  subdivision needs precision.

1/1000 of a day is finer than any policy anyone books against (half-days and
quarter-days are the real granularities), which leaves headroom for accrual
rates that do not divide evenly — 25 days a year, monthly, is 2.083 days a
month. The accrual job must still carry the rounding remainder forward rather
than truncating each month; at this scale the annual drift from truncation is
about three minutes, but "about three minutes" is not a thing to defend in a
tribunal.

**Row locking (Phase 4, not here).** The spec calls balance debit the one place
in the HRMS addition where a race has a financial-adjacent consequence.
``LeaveBalance`` is shaped so a lock is possible: exactly one row per
``(user_id, leave_type_id, year)``, enforced by
``uq_leave_balances_user_type_year``, with the debited quantity frozen on the
application row. See :class:`LeaveBalance` for what the service must do.
"""

from __future__ import annotations

import enum
import uuid
from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    Uuid,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDMixin

# The fixed minor unit. Named constants rather than bare 1000s scattered through
# the service, so a future change of granularity is one edit and one migration
# instead of a hunt.
MILLI_DAYS_PER_DAY = 1000
HALF_DAY_MILLI_DAYS = MILLI_DAYS_PER_DAY // 2

# Resolved policy for an org with no ``leave_settings`` row. Named constants
# because two places need them — the column defaults below, and the service
# resolving a missing row — and those two must never be allowed to disagree.
DEFAULT_LEAVE_YEAR_START_MONTH = 1
# 0 is the "no limit" sentinel for the opt-in quota, not "none". See the column.
OPTIONAL_HOLIDAY_QUOTA_UNLIMITED = 0


class AccrualType(str, enum.Enum):
    """How the ``leave_accrual`` job credits this type.

    ``NONE`` is not "no leave" — it is leave granted as a lump by an admin
    (maternity, bereavement, loss-of-pay), where the whole entitlement arrives
    through ``adjusted`` or ``opening`` and the monthly job must skip the type
    entirely rather than credit it zero.
    """

    MONTHLY = "monthly"
    YEARLY = "yearly"
    NONE = "none"


class LeaveStatus(str, enum.Enum):
    """Lifecycle of one leave application.

    Deliberately *not* ``timesheet.ApprovalStatus``, though the overlapping
    values are spelled identically on purpose so §9.4's merged approvals inbox
    can sort timesheet, regularization and leave rows on one status string
    without a translation table. Two reasons it is a separate enum:

    * A leave application has no ``draft``. It exists because somebody applied;
      there is no state in which it is saved but not submitted, and modelling
      one would mean every balance query has to remember to exclude it.
    * It needs ``cancelled``, which timesheets have no analogue for. Withdrawing
      an approved future leave is routine, and it is the case that credits a
      balance back — it cannot be smuggled in as ``rejected``, because rejected
      leave was never debited and cancelled leave was.

    Adding ``CANCELLED`` to ``ApprovalStatus`` instead would repurpose an enum
    the timesheet module already stores in ``timesheet_approvals.status``, which
    the brief forbids and which would widen every timesheet status check.
    """

    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    CANCELLED = "cancelled"

    @property
    def holds_balance(self) -> bool:
        """Whether this application still lays claim to balance.

        ``PENDING`` counts: an employee with 2 days left and 2 days pending has
        nothing left to apply for, and letting them apply again because the
        debit has not landed yet is how balances go negative.
        """
        return self in (LeaveStatus.PENDING, LeaveStatus.APPROVED)

    @property
    def is_final(self) -> bool:
        return self in (LeaveStatus.REJECTED, LeaveStatus.CANCELLED)


class HalfDaySession(str, enum.Enum):
    """Which half of the day a half-day application covers.

    Not named in the spec; see :attr:`LeaveApplication.half_day_session` for why
    a bare ``is_half_day`` boolean is not enough.
    """

    FIRST_HALF = "first_half"
    SECOND_HALF = "second_half"


class LeaveSettings(TimestampMixin, Base):
    """Per-tenant leave policy that is not per leave type. One row per org.

    Deliberately a separate table rather than more columns on ``org_settings``,
    for the same reason ``attendance_settings`` is: ``org_settings`` is the
    payload the desktop agent pulls on *every* heartbeat and the shape
    ``OrgSettingsOut``/``OrgSettingsUpdate`` promise the console. Widening a hot,
    already-public contract with policy no agent will ever read costs every
    agent, forever, for nothing.

    Same primary-key shape as ``OrgSettings`` and ``AttendanceSettings``:
    ``org_id`` *is* the key, so the 1:1 with the organisation is enforced by the
    database rather than by a service remembering to check.

    **A missing row is legal and means the defaults below.** No backfill
    migration, no "settings not configured" error path: an org that never opens
    the Leave Settings page gets a January policy year and unlimited optional-
    holiday opt-ins, which is the behaviour it would have had if this table did
    not exist. The service must resolve a missing row through
    :data:`DEFAULT_LEAVE_YEAR_START_MONTH` and
    :data:`OPTIONAL_HOLIDAY_QUOTA_UNLIMITED` rather than inserting a row on
    read — a lazy insert on a GET turns a report query into a write and races
    itself under concurrent dashboard loads.
    """

    __tablename__ = "leave_settings"

    # PK, so it is unique and indexed by definition — no index=True, which would
    # only add a redundant second index. Follows OrgSettings/AttendanceSettings.
    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), primary_key=True
    )

    # Calendar month the policy year opens in. 1 = January, 4 = the April-March
    # year most Indian orgs run.
    #
    # This is the multiplier on ``LeaveBalance.year``, which stores the year the
    # policy year *starts* in: with a value of 4, balance year 2026 covers
    # April 2026 through March 2027. Reading it as the year the policy year
    # *ends* in is an off-by-one worth a whole year of somebody's balance — it
    # would file a March 2027 application against a balance that does not exist
    # yet and show the employee an empty entitlement.
    leave_year_start_month: Mapped[int] = mapped_column(
        Integer, default=DEFAULT_LEAVE_YEAR_START_MONTH, nullable=False
    )

    # How many optional holidays one employee may opt into per policy year.
    #
    # 0 means **unlimited**, not "none". That reading is the obvious wrong one,
    # which is exactly why it is spelled out here and given a named constant:
    # the natural default for an org that has not configured a quota is "we do
    # not police this", and silently interpreting the default as zero would
    # reject every opt-in on a feature the admin never knew they had to enable.
    # Same trap, same resolution, as ``leave_types.carry_forward_limit``.
    optional_holiday_quota: Mapped[int] = mapped_column(
        Integer, default=OPTIONAL_HOLIDAY_QUOTA_UNLIMITED, nullable=False
    )

    @property
    def optional_holidays_are_unlimited(self) -> bool:
        return self.optional_holiday_quota == OPTIONAL_HOLIDAY_QUOTA_UNLIMITED


class LeaveType(UUIDMixin, TimestampMixin, Base):
    """One org's policy for one kind of leave.

    Rows are configuration an admin edits, not history — a type is deactivated,
    never deleted, which is why every reference to it is ``RESTRICT``.
    """

    __tablename__ = "leave_types"
    __table_args__ = (
        UniqueConstraint("org_id", "name", name="uq_leave_types_org_name"),
        UniqueConstraint("org_id", "code", name="uq_leave_types_org_code"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    # Short stable handle ("CL", "SL", "EL"). Payslips, reports and imported
    # policy spreadsheets all key on the code, while admins rename the display
    # name freely; without a code, every downstream reference is a string match
    # on a mutable label.
    code: Mapped[str | None] = mapped_column(String(16), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Whether the day is paid. Unpaid leave still consumes a balance and still
    # needs an approval trail, so it is a flag on a normal type rather than the
    # absence of one.
    is_paid: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    accrual_type: Mapped[str] = mapped_column(
        String(16), default=AccrualType.MONTHLY.value, nullable=False
    )
    # Credited per accrual period (per month for MONTHLY, per year for YEARLY),
    # ignored entirely for NONE. 1.75 days/month is 1750.
    accrual_rate_milli_days: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # Ceiling on the summed balance. 0 = uncapped; a cap of "zero days" is not a
    # policy anyone writes, whereas "no cap" is extremely common, so 0 is the
    # more useful sentinel than NULL and needs no three-state handling.
    max_balance_milli_days: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # How much unused balance survives the year rollover into next year's
    # ``opening``. 0 = use-it-or-lose-it, which is a real and common policy, so
    # this one is NOT a sentinel for "unlimited" — see carry_forward_all.
    carry_forward_limit_milli_days: Mapped[int] = mapped_column(
        Integer, default=0, nullable=False
    )
    # Explicit, because 0 above genuinely means zero. Without this flag an
    # unlimited-carry-forward policy would have to be encoded as an absurdly
    # large limit, and somebody would eventually pick a number too small.
    carry_forward_all: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # Calendar days of notice required before start_date. Enforced in the
    # service, not here, because a manager must be able to override it.
    min_notice_days: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # False for types an employee simply declares (some orgs run sick leave this
    # way). The application is still recorded and still debits the balance; it
    # just never sits in the pending state.
    requires_approval: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    # Not in the spec. Half-days are meaningful for casual/sick leave and
    # meaningless for maternity; without the flag the UI has to hard-code which
    # types may be halved, which is policy living in the frontend.
    allow_half_day: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    # Not in the spec, but comp-off has to land somewhere. A CompOffCredit
    # eventually becomes balance, and balance is always per leave type; this
    # marks the type comp-off credits feed. At most one per org, enforced in the
    # service rather than by a partial index — it is admin-set and rare enough
    # not to warrant one.
    is_comp_off: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # Whether an unused balance is paid out when somebody leaves. Policy, and it
    # varies by type within one company: earned leave is normally encashable,
    # casual and sick leave normally are not. Default False, because paying out
    # a balance nobody meant to pay out is the expensive mistake — a settlement
    # that under-pays gets queried, one that over-pays gets banked.
    is_encashable: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    @property
    def accrual_type_enum(self) -> AccrualType:
        try:
            return AccrualType(self.accrual_type)
        except ValueError:
            return AccrualType.NONE


class LeaveBalance(UUIDMixin, TimestampMixin, Base):
    """One employee's entitlement for one leave type in one policy year.

    **There is no balance column and there must never be one.** See the module
    docstring. :attr:`balance_milli_days` sums the four components at read time.

    **What Phase 4 must do with this row.** The unique constraint guarantees at
    most one row per ``(user_id, leave_type_id, year)``, which is what makes
    ``SELECT ... FOR UPDATE`` a meaningful lock here. Two things that lock does
    *not* give you for free:

    1. ``FOR UPDATE`` on a row that does not exist locks nothing, and two
       concurrent approvals for an employee's first-ever leave of the year will
       both find no row and both insert one. The debit path must upsert the row
       (``INSERT ... ON CONFLICT DO NOTHING`` against
       ``uq_leave_balances_user_type_year``) and only then lock and re-read it.
    2. The lock must be held across the read *and* the write of ``used``, in one
       transaction that also stamps :attr:`LeaveApplication.debited_at`. Reading
       the balance, releasing, then updating is the same race with extra steps.

    SQLite ignores ``FOR UPDATE`` entirely; its whole-database write lock happens
    to make the sequence safe there, but the correctness argument only holds on
    Postgres, and so does the concurrency test Phase 4 owes.
    """

    __tablename__ = "leave_balances"
    __table_args__ = (
        # The lockable-row guarantee. Named, because SQLite batch ALTER needs it
        # and because the upsert above has to name the conflict target.
        UniqueConstraint(
            "user_id", "leave_type_id", "year", name="uq_leave_balances_user_type_year"
        ),
        Index("ix_leave_balances_org_year", "org_id", "year"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # RESTRICT, not CASCADE: deleting a leave type must not silently delete the
    # record of how much of it people were owed and took. Types are deactivated.
    leave_type_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("leave_types.id", ondelete="RESTRICT"), nullable=False, index=True
    )

    # The year the *policy* year starts in, not necessarily a calendar year. An
    # Indian org on an April-March policy year books April 2026 - March 2027 as
    # year 2026. Storing the start year keeps it one integer and keeps the
    # unique constraint simple; where the policy year starts is org config, not
    # a per-balance fact.
    year: Mapped[int] = mapped_column(Integer, nullable=False)

    # --- the four components; each has exactly one writer --------------------
    # Carried in by the year rollover, capped by carry_forward_limit.
    opening_milli_days: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # Written only by the monthly ``leave_accrual`` job.
    accrued_milli_days: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # Written only by leave approval (debit) and cancellation (credit back).
    used_milli_days: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # Signed, and the only component a human writes directly. Negative is a
    # legitimate correction (leave taken before the system existed, an accrual
    # bug being clawed back) and must not be blocked.
    adjusted_milli_days: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    # Attribution for the last manual correction. This is the minimum that makes
    # ``adjusted`` auditable on the row itself; it is deliberately *not* a full
    # ledger, because one already exists — every adjustment must also write an
    # ``AuditLog`` row (action ``leave_balance_adjusted``, target the balance id,
    # detail carrying the delta and the reason). These three columns answer "who
    # last touched this and why" without a join; AuditLog answers "show me every
    # correction ever made to it".
    adjusted_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    adjusted_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    adjusted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    leave_type: Mapped["LeaveType"] = relationship(lazy="joined")

    @property
    def balance_milli_days(self) -> int:
        """The balance, summed. The only correct way to ask for it."""
        return (
            self.opening_milli_days
            + self.accrued_milli_days
            - self.used_milli_days
            + self.adjusted_milli_days
        )

    @property
    def balance_days(self) -> float:
        """Display only.

        A float is fine on the way out of the system for the same reason rupees
        are: nothing is computed from this, it is rendered. Never write a float
        back into a component.
        """
        return self.balance_milli_days / MILLI_DAYS_PER_DAY

    @property
    def entitled_milli_days(self) -> int:
        """Everything granted this year, before anything was taken.

        Separated out because "you were given 24 and have used 9" is the
        sentence the employee actually wants, and computing it in three places
        in the console is how the three places disagree.
        """
        return self.opening_milli_days + self.accrued_milli_days + self.adjusted_milli_days


class LeaveApplication(UUIDMixin, TimestampMixin, Base):
    """One request for leave, and the decision on it."""

    __tablename__ = "leave_applications"
    __table_args__ = (
        # Overlap detection (§3.2) scans one employee's applications around a
        # date range; this is the index that query lands on.
        Index("ix_leave_applications_user_start", "user_id", "start_date"),
        # The manager approvals queue: one org, pending first, oldest first.
        Index("ix_leave_applications_org_status", "org_id", "status", "start_date"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    leave_type_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("leave_types.id", ondelete="RESTRICT"), nullable=False, index=True
    )

    # Attendance days in the org's local calendar, never UTC timestamps: leave
    # "on the 3rd" is the 3rd wherever the employee is, and a timezone-shifted
    # range query is how a one-day leave becomes two.
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)

    is_half_day: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # Not in the spec, and the spec is thin here. ``is_half_day`` alone cannot
    # answer the question attendance actually needs answered — whether the
    # employee is in this morning or this afternoon — so the punch/shift module
    # would have to guess and the employee would have to explain it in the
    # reason field. NULL whenever is_half_day is false.
    half_day_session: Mapped[str | None] = mapped_column(String(16), nullable=True)

    # Not in the spec, and load-bearing. This is how much balance the
    # application consumes, computed once at apply time by walking the date
    # range and skipping holidays and weekly-offs, then frozen. It must be
    # stored rather than recomputed at approval or cancellation, because the
    # holiday calendar can change in between: recomputing would debit a
    # different number than it later credits back, and the balance would drift
    # by exactly the days somebody added to the holiday list.
    duration_milli_days: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    # No standalone index on status: ix_leave_applications_org_status above
    # already leads with org_id and status, and a bare status index on a
    # four-value column is a scan with extra bookkeeping.
    status: Mapped[str] = mapped_column(
        String(16), default=LeaveStatus.PENDING.value, nullable=False
    )

    # Distinct from created_at on purpose: created_at is when the row appeared,
    # applied_at is when the employee submitted. They coincide today and stop
    # coinciding the first time HR back-fills historical leave from a
    # spreadsheet, at which point min_notice_days must not be evaluated against
    # the import timestamp.
    applied_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # House style is ``reviewed_by_user_id`` (see TimesheetApproval); the spec
    # writes ``reviewed_by``. Same column, existing name kept.
    reviewed_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    review_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Not in the spec. The idempotency latch for the balance debit, stamped in
    # the same locked transaction that moves ``used_milli_days``. A retried or
    # double-clicked approval finds it already set and does nothing, which turns
    # "never drop the lock between read and write" from a rule somebody has to
    # remember into something the data enforces. Cleared when a cancellation
    # credits the balance back.
    debited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    leave_type: Mapped["LeaveType"] = relationship(lazy="joined")

    @property
    def status_enum(self) -> LeaveStatus:
        try:
            return LeaveStatus(self.status)
        except ValueError:
            return LeaveStatus.PENDING

    @property
    def duration_days(self) -> float:
        """Display only — see LeaveBalance.balance_days."""
        return self.duration_milli_days / MILLI_DAYS_PER_DAY


class Holiday(UUIDMixin, TimestampMixin, Base):
    """One entry in an org's holiday calendar.

    ``is_optional`` is the GreytHR pattern: the org publishes a list of, say,
    eight optional holidays and each employee opts into two of them. An optional
    holiday is therefore *not* a holiday for anyone who did not opt in — they
    are expected at work — which is why the opt-in has to be recorded per
    employee. See :class:`OptionalHolidayOptIn`.
    """

    __tablename__ = "holidays"
    __table_args__ = (
        # Two festivals can genuinely fall on one date, so the date alone is not
        # unique; the pair is, and this is what stops a double-imported calendar
        # from stamping the same day twice.
        # This also serves the calendar's "holidays between two dates for this
        # org" query as a leading-column prefix, which is why there is no
        # separate (org_id, holiday_date) index.
        UniqueConstraint("org_id", "holiday_date", "name", name="uq_holidays_org_date_name"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # The spec calls this column ``date``. Named ``holiday_date`` to match
    # ``TimeEntry.entry_date`` and ``CompOffCredit.earned_date``, and because a
    # column literally named ``date`` shadows the imported type in the one
    # module where the mapping is resolved.
    holiday_date: Mapped[date] = mapped_column(Date, nullable=False)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_optional: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # Next year's calendar is drafted while this year's is still stamping
    # attendance, so a holiday needs to exist without being in force.
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class OptionalHolidayOptIn(UUIDMixin, TimestampMixin, Base):
    """Which optional holidays a given employee chose. **Spec gap, filled.**

    §3.1 defines ``holidays.is_optional`` and describes the opt-in behaviour but
    names no table to hold the choice, which leaves the feature unimplementable:
    with only ``is_optional`` on the holiday, the daily holiday-stamping job has
    no way to decide whether a given employee is off that day, and would have to
    treat an optional holiday as either a holiday for everyone (defeating the
    point) or for no one (making the flag decorative).

    One row = one employee opting into one optional holiday. Absence of a row is
    the answer for everyone else, so nothing is written for the majority who opt
    into nothing.
    """

    __tablename__ = "optional_holiday_opt_ins"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "holiday_id", name="uq_optional_holiday_opt_ins_user_holiday"
        ),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # CASCADE: if the org drops the holiday from the calendar, nobody is opted
    # into it any more. Nothing is lost — an attendance day already past was
    # stamped at the time and stands on its own.
    holiday_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("holidays.id", ondelete="CASCADE"), nullable=False, index=True
    )

    holiday: Mapped["Holiday"] = relationship(lazy="joined")


class CompOffCredit(UUIDMixin, TimestampMixin, Base):
    """A day off earned by working a holiday or weekly-off, and its expiry.

    Modelled as individual credits rather than as a number added to a balance
    because each credit expires on its own date. Summing them into
    ``LeaveBalance.accrued`` would make it impossible to expire one without
    reverse-engineering which part of the total it was — the same
    lose-the-components mistake the balance table exists to avoid, one level
    down.
    """

    __tablename__ = "comp_off_credits"
    __table_args__ = (
        Index("ix_comp_off_credits_user_earned", "user_id", "earned_date"),
        # The daily ``comp_off_expiry`` job's query: credits past their date
        # that have not been stamped yet, per org.
        Index("ix_comp_off_credits_org_expiry", "org_id", "expires_at"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )

    earned_date: Mapped[date] = mapped_column(Date, nullable=False)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Usually a full or half day; stored in the same unit as everything else so
    # spending it against a balance is addition, not a conversion.
    credit_milli_days: Mapped[int] = mapped_column(
        Integer, default=MILLI_DAYS_PER_DAY, nullable=False
    )

    # A calendar day, not an instant, despite the ``_at`` name the spec uses: a
    # comp-off expires at the end of a day in the org's timezone, and typing it
    # as DateTime would make "expires today" depend on the hour.
    expires_at: Mapped[date] = mapped_column(Date, nullable=False)
    # Stamped by the daily ``comp_off_expiry`` job. Read-side code must still
    # treat ``expires_at < today`` as expired regardless of this column — a job
    # that failed to run last night must not hand anybody a free day. This
    # exists so expiry is visible and reportable, not so it is authoritative.
    expired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # SET NULL rather than CASCADE: if the application is ever hard-deleted the
    # credit returns to being unused, which is the safe direction. In practice
    # applications are cancelled, not deleted, and cancellation clears this
    # explicitly as part of crediting back.
    used_in_application_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("leave_applications.id", ondelete="SET NULL"), nullable=True, index=True
    )

    granted_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    def is_usable_on(self, on: date) -> bool:
        """Whether this credit can still be spent on ``on``.

        Deliberately does not consult ``expired_at`` — see the note there.
        """
        return self.used_in_application_id is None and on <= self.expires_at
