"""Leave: policy resolution, the calendar, balance arithmetic, and the job bodies.

This module owns every rule §3.2 says belongs in the service rather than the
frontend, plus the two scheduler job bodies (:func:`accrue_monthly`,
:func:`expire_comp_offs`) as plain callables the runner registers.

Three decisions shape everything below. Read them before changing anything here.

**1. The debit is the only place a race costs money, so it is the only place
with a lock.** :func:`debit_for_application` is the whole of it, and it does
three things in one transaction, in this order and no other:

* ``INSERT ... ON CONFLICT DO NOTHING`` so the balance row exists. ``SELECT ...
  FOR UPDATE`` on a row that is not there locks nothing, and two concurrent
  approvals of an employee's first leave of the year would both find nothing and
  both insert.
* ``SELECT ... FOR UPDATE`` and re-read — including re-reading
  ``leave_applications.debited_at`` straight from the database rather than from
  the possibly-stale ORM object, because the double-clicked approval is exactly
  the case this defends.
* Write ``used_milli_days`` and stamp ``debited_at`` while still holding the
  lock. Reading the balance, releasing, then updating is the same race with
  extra steps.

SQLite ignores ``FOR UPDATE``; its whole-database write lock happens to make the
sequence safe there, so the correctness argument — and the concurrency test —
only mean anything on Postgres.

**2. D-013: ``duration_milli_days`` is computed once, at apply time, and
frozen.** Approval debits the stored number and cancellation credits the same
stored number back. Nothing on the decision path may recompute it: the holiday
calendar is editable, and a recomputation between debit and credit-back would
leave the balance short by exactly the days somebody added to the calendar.

**3. D-022: comp-off has one source of truth — the credit ledger.**

``comp_off_credits`` is the ledger. The comp-off ``leave_balances`` row is a
**projection of that ledger**, and only the credit lifecycle writes it:
granting a credit adds to ``accrued_milli_days``, expiring one subtracts, and
both happen inside the same locked transaction as any other write to that row.
Nothing else may touch it — :func:`adjust_balance` refuses a comp-off type
outright and points the caller at the credit endpoints, so there is exactly one
way the number can move.

The rejected alternative was "derive the comp-off balance and never store it".
It fails on two counts. ``LeaveBalance.balance_milli_days`` is a model property
with a fixed formula that every schema and report already reads; making it lie
for one leave type is worse than storing a projection. And the debit path would
then need two shapes — a locked-row debit for ordinary types and a ledger scan
for comp-off — which is a branch in the one function that must not have one.

The cost of a projection is drift, so drift is made a test failure rather than a
production discovery: :func:`reconcile_comp_off` recomputes the projection from
the ledger and returns the difference, and the invariant it checks is

    accrued_milli_days == sum(credit_milli_days WHERE expired_at IS NULL)

**The comp-off balance row carries the sentinel year**
:data:`COMP_OFF_BALANCE_YEAR` **(0), not a policy year.** Comp-off is not
year-scoped — a credit's life is governed by its own ``expires_at`` — and
bucketing it by policy year would strand a December credit outside the January
row it is spent from. One row per employee per comp-off type, for all time,
which is also still exactly one lockable row.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from fractions import Fraction

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session, noload

from app.core.dates import add_months
from app.core.config import settings as app_settings
from fastapi import Request

from app.db.base import utcnow
from app.db.session import SessionLocal
from app.models import (
    AttendanceRecord,
    AttendanceStatus,
    AuditLog,
    CompOffCredit,
    Holiday,
    LeaveApplication,
    LeaveBalance,
    LeaveSettings,
    LeaveStatus,
    LeaveType,
    OptionalHolidayOptIn,
    Organization,
    PunchSource,
    User,
)
from app.models.leave import (
    DEFAULT_LEAVE_YEAR_START_MONTH,
    HALF_DAY_MILLI_DAYS,
    MILLI_DAYS_PER_DAY,
    OPTIONAL_HOLIDAY_QUOTA_UNLIMITED,
    AccrualType,
)
from app.services import notifications as notif
from app.services import reports, timesheets as ts
from app.services import chains, workflow

log = logging.getLogger(__name__)

#: The comp-off balance row's ``year``. See the module docstring: comp-off is not
#: year-scoped, so bucketing it by policy year would strand a December credit
#: outside the January row somebody spends it from.
COMP_OFF_BALANCE_YEAR = 0

#: Remaining balance at or below which the employee is told they are running out.
#: One working day: below that, the next application is the one that fails.
LOW_BALANCE_THRESHOLD_MILLI_DAYS = MILLI_DAYS_PER_DAY

#: The columns ``uq_leave_balances_user_type_year`` is built from. The upsert has
#: to name its conflict target, and naming it once here is what stops a future
#: edit from adding a column to the constraint and not to the upsert — which
#: would silently turn every ON CONFLICT DO NOTHING into a duplicate row.
_BALANCE_CONFLICT_TARGET = ("user_id", "leave_type_id", "year")


class LeaveError(Exception):
    """A rule in §3.2 said no.

    Carries a machine-readable ``code`` next to the sentence, because the console
    renders a different form for "you have no balance left" than for "that
    overlaps leave you already have", and matching on prose is how that breaks
    the first time somebody improves the wording. The router maps this to HTTP;
    the service stays importable by the scheduler, which has no HTTP to raise.
    """

    def __init__(self, code: str, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _audit(
    db: Session,
    *,
    org_id: uuid.UUID,
    actor_id: uuid.UUID | None,
    action: str,
    target_type: str,
    target_id: uuid.UUID | str,
    detail: dict,
) -> None:
    """Write the audit row directly rather than through ``api.deps.audit``.

    Deliberate: no service in this codebase imports from ``app.api``, and the
    scheduler jobs below run with no request at all. Details are assembled from
    primitives at every call site, so the generic coercion ``deps.jsonable``
    exists for is not needed here.
    """
    db.add(
        AuditLog(
            org_id=org_id,
            actor_user_id=actor_id,
            action=action,
            target_type=target_type,
            target_id=str(target_id),
            detail=detail,
        )
    )


# --------------------------------------------------------------------------- #
# Settings and the policy year
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ResolvedLeaveSettings:
    """Policy for one org, resolved whether or not a row exists.

    D-009: **a missing ``leave_settings`` row is legal and means the defaults.**
    Nothing here lazy-inserts one. A GET that writes turns every dashboard load
    into a write and races itself the moment two of them land together.
    """

    org_id: uuid.UUID
    leave_year_start_month: int
    optional_holiday_quota: int
    is_configured: bool

    @property
    def optional_holidays_are_unlimited(self) -> bool:
        return self.optional_holiday_quota == OPTIONAL_HOLIDAY_QUOTA_UNLIMITED


def resolve_settings(db: Session, org_id: uuid.UUID) -> ResolvedLeaveSettings:
    row = db.get(LeaveSettings, org_id)
    if row is None:
        return ResolvedLeaveSettings(
            org_id=org_id,
            leave_year_start_month=DEFAULT_LEAVE_YEAR_START_MONTH,
            optional_holiday_quota=OPTIONAL_HOLIDAY_QUOTA_UNLIMITED,
            is_configured=False,
        )
    return ResolvedLeaveSettings(
        org_id=org_id,
        leave_year_start_month=row.leave_year_start_month,
        optional_holiday_quota=row.optional_holiday_quota,
        is_configured=True,
    )


def policy_year_for(day: date, start_month: int) -> int:
    """The year the policy year containing ``day`` *starts* in.

    An org on April-March books March 2027 as year 2026. Reading it as the year
    the policy year ends in is an off-by-one worth somebody's whole balance.
    """
    return day.year if day.month >= start_month else day.year - 1


def policy_year_bounds(year: int, start_month: int) -> tuple[date, date]:
    start = date(year, start_month, 1)
    return start, _add_months(start, 12) - timedelta(days=1)


#: Kept as a module-private alias because this file's callers already use the
#: name; the implementation moved to ``core.dates`` when Core HR's probation end
#: date needed the same clamping and grew a second copy of it.
_add_months = add_months


def org_today(db: Session, org_id: uuid.UUID) -> date:
    """Today in the organisation's own timezone.

    Never ``date.today()``: an IST tenant's "today" turns over five and a half
    hours before a UTC server agrees, and a leave application filed at 09:00 IST
    on the 1st would otherwise be judged against the 31st.
    """
    org = db.get(Organization, org_id)
    return datetime.now(reports.tz_for(org.timezone if org else "UTC")).date()


# --------------------------------------------------------------------------- #
# The calendar: holidays, weekly-offs, and what a date range is worth
# --------------------------------------------------------------------------- #


def holiday_dates_for(
    db: Session, org_id: uuid.UUID, user_id: uuid.UUID, start: date, end: date
) -> set[date]:
    """Dates in ``[start, end]`` this employee is off for as a holiday.

    An optional holiday is **not** a holiday for anyone who did not opt into it
    — they are expected at work — so the opt-in table decides, per employee.
    Treating the flag any other way makes it either a holiday for everybody
    (defeating the point) or for nobody (making it decorative).
    """
    rows = db.execute(
        select(Holiday.id, Holiday.holiday_date, Holiday.is_optional).where(
            Holiday.org_id == org_id,
            Holiday.is_active.is_(True),
            Holiday.holiday_date >= start,
            Holiday.holiday_date <= end,
        )
    ).all()
    if not rows:
        return set()

    opted_in = set(
        db.scalars(
            select(OptionalHolidayOptIn.holiday_id).where(
                OptionalHolidayOptIn.user_id == user_id
            )
        ).all()
    )
    return {
        holiday_date
        for holiday_id, holiday_date, is_optional in rows
        if not is_optional or holiday_id in opted_in
    }


def _works_on(schedule, day: date) -> bool:
    # No schedule at all falls back to Mon-Fri, matching services.timesheets.build
    # so a person's leave days and their expected hours never disagree about
    # which days are working days.
    return schedule.works_on(day.weekday()) if schedule else day.weekday() < 5


def leave_days_in_range(
    db: Session, user: User, start: date, end: date
) -> list[date]:
    """The dates in the range that actually consume balance.

    Weekly-offs and holidays are skipped — an employee who takes Friday to Monday
    over a two-day weekend spends two days, not four.
    """
    # Reuses the timesheet service's schedule resolution rather than answering
    # "which schedule applies to this person" a second time; two answers to that
    # question is how leave and hours drift apart on the same employee.
    schedule = ts._schedule_for(db, user)
    holidays = holiday_dates_for(db, user.org_id, user.id, start, end)
    days: list[date] = []
    current = start
    while current <= end:
        if _works_on(schedule, current) and current not in holidays:
            days.append(current)
        current += timedelta(days=1)
    return days


def compute_duration_milli_days(
    db: Session, user: User, start: date, end: date, is_half_day: bool
) -> int:
    """What this range costs, in milli-days. **Computed once, at apply time.**

    D-013: the caller freezes the result onto ``duration_milli_days`` and every
    later step reads the stored number. Never call this from approval or
    cancellation.
    """
    days = leave_days_in_range(db, user, start, end)
    if is_half_day:
        # The schema already refuses a half-day spanning more than one date, so
        # this is a single working day or none at all.
        return HALF_DAY_MILLI_DAYS if days else 0
    return len(days) * MILLI_DAYS_PER_DAY


# --------------------------------------------------------------------------- #
# Balances — the locked path
# --------------------------------------------------------------------------- #


def balance_year_for(
    leave_type: LeaveType, day: date, resolved: ResolvedLeaveSettings
) -> int:
    if leave_type.is_comp_off:
        return COMP_OFF_BALANCE_YEAR
    return policy_year_for(day, resolved.leave_year_start_month)


def ensure_balance_row(
    db: Session,
    *,
    org_id: uuid.UUID,
    user_id: uuid.UUID,
    leave_type_id: uuid.UUID,
    year: int,
) -> None:
    """Make the row exist, without caring whether it already did.

    ``INSERT ... ON CONFLICT DO NOTHING`` against
    ``uq_leave_balances_user_type_year``, and it must run **before** the lock:
    ``SELECT ... FOR UPDATE`` on a row that does not exist locks nothing, so two
    concurrent approvals of somebody's first leave of the year would both see no
    row, both insert, and the unique constraint would turn one of them into a
    500 at commit — or, without the constraint, into two balances.

    A read-then-insert would be the same race written out longhand. The database
    is the only thing that can make "exists or is created" atomic.
    """
    table = LeaveBalance.__table__
    values = {
        "id": uuid.uuid4(),
        "org_id": org_id,
        "user_id": user_id,
        "leave_type_id": leave_type_id,
        "year": year,
        "created_at": utcnow(),
    }
    dialect = db.get_bind().dialect.name
    if dialect == "postgresql":
        stmt = pg_insert(table).values(**values)
    elif dialect == "sqlite":
        stmt = sqlite_insert(table).values(**values)
    else:
        # Deliberately loud. A silent fallback to SELECT-then-INSERT here would
        # reintroduce exactly the race this function exists to close, on a
        # database nobody tested it on.
        raise RuntimeError(
            f"leave balance upsert is not implemented for dialect {dialect!r}"
        )
    db.execute(stmt.on_conflict_do_nothing(index_elements=list(_BALANCE_CONFLICT_TARGET)))


def lock_statement(*, user_id: uuid.UUID, leave_type_id: uuid.UUID, year: int):
    """The locking SELECT, built separately so a test can compile it.

    SQLite renders no ``FOR UPDATE`` at all, so on the database the suite runs
    against there is nothing to observe at runtime. Handing the statement back
    lets the test compile it for the Postgres dialect and assert the lock is
    actually in the SQL — which is the only way to catch, on SQLite, an edit
    that drops it.
    """
    return (
        select(LeaveBalance)
        .options(noload(LeaveBalance.leave_type))
        .where(
            LeaveBalance.user_id == user_id,
            LeaveBalance.leave_type_id == leave_type_id,
            LeaveBalance.year == year,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )


def lock_balance(
    db: Session, *, user_id: uuid.UUID, leave_type_id: uuid.UUID, year: int
) -> LeaveBalance:
    """Lock the one balance row and return its current values.

    Two details that look like noise and are not:

    * ``noload`` on ``leave_type``. The relationship is ``lazy="joined"``, and a
      joined eager load renders a LEFT OUTER JOIN, which Postgres refuses to
      apply ``FOR UPDATE`` to ("cannot be applied to the nullable side of an
      outer join"). The lock would fail on the only database where it does
      anything.
    * ``populate_existing``. Without it the ORM hands back whatever instance is
      already in the identity map, attributes and all — so a balance read
      earlier in the same request comes back stale *from a locked select*,
      which is a read-before-lock wearing the lock's clothes.
    """
    balance = db.scalars(
        lock_statement(user_id=user_id, leave_type_id=leave_type_id, year=year)
    ).one_or_none()
    if balance is None:  # pragma: no cover - ensure_balance_row ran first
        raise LeaveError("balance_missing", "The balance row vanished mid-transaction", 500)
    return balance


def get_balance(
    db: Session, *, user_id: uuid.UUID, leave_type_id: uuid.UUID, year: int
) -> LeaveBalance | None:
    """Read without creating. A read must never write."""
    return db.scalars(
        select(LeaveBalance).where(
            LeaveBalance.user_id == user_id,
            LeaveBalance.leave_type_id == leave_type_id,
            LeaveBalance.year == year,
        )
    ).one_or_none()


def pending_milli_days(
    db: Session, *, user_id: uuid.UUID, leave_type_id: uuid.UUID, year: int,
    resolved: ResolvedLeaveSettings,
) -> int:
    """Balance already claimed by applications nobody has decided yet.

    Counted because ``LeaveStatus.PENDING.holds_balance`` is true: an employee
    with two days left and two days pending has nothing left to apply for, and
    letting them apply again because the debit has not landed is how a balance
    goes negative.
    """
    stmt = select(LeaveApplication.duration_milli_days, LeaveApplication.start_date).where(
        LeaveApplication.user_id == user_id,
        LeaveApplication.leave_type_id == leave_type_id,
        LeaveApplication.status == LeaveStatus.PENDING.value,
    )
    total = 0
    for duration, start_date in db.execute(stmt).all():
        if year == COMP_OFF_BALANCE_YEAR:
            total += duration
        elif policy_year_for(start_date, resolved.leave_year_start_month) == year:
            total += duration
    return total


def usable_comp_off_milli_days(db: Session, user_id: uuid.UUID, on: date) -> int:
    """What the ledger says is spendable on ``on``.

    Computed against the date rather than read from ``expired_at``, because a
    night the expiry job did not run must not hand anybody a free day. This is
    the number the apply path checks comp-off against; the projected balance row
    is what the console renders, and the two disagreeing is a visible symptom
    rather than a silent overdraft.
    """
    rows = db.scalars(
        select(CompOffCredit).where(
            CompOffCredit.user_id == user_id,
            CompOffCredit.used_in_application_id.is_(None),
            CompOffCredit.expires_at >= on,
            CompOffCredit.expired_at.is_(None),
        )
    ).all()
    return sum(row.credit_milli_days for row in rows)


@dataclass(frozen=True)
class BalanceView:
    """What the employee and the apply form need, in one object."""

    leave_type: LeaveType
    year: int
    balance: LeaveBalance | None
    pending_milli_days: int
    available_milli_days: int

    @property
    def balance_milli_days(self) -> int:
        return self.balance.balance_milli_days if self.balance else 0


def balance_view(
    db: Session,
    *,
    user: User,
    leave_type: LeaveType,
    on: date,
    resolved: ResolvedLeaveSettings,
) -> BalanceView:
    year = balance_year_for(leave_type, on, resolved)
    balance = get_balance(
        db, user_id=user.id, leave_type_id=leave_type.id, year=year
    )
    pending = pending_milli_days(
        db, user_id=user.id, leave_type_id=leave_type.id, year=year, resolved=resolved
    )
    stored = balance.balance_milli_days if balance else 0
    # Comp-off's spendable figure comes from the ledger, not the projection —
    # see usable_comp_off_milli_days.
    gross = usable_comp_off_milli_days(db, user.id, on) if leave_type.is_comp_off else stored
    return BalanceView(
        leave_type=leave_type,
        year=year,
        balance=balance,
        pending_milli_days=pending,
        available_milli_days=gross - pending,
    )


# --------------------------------------------------------------------------- #
# The debit. This is the code the whole module exists for.
# --------------------------------------------------------------------------- #


def debit_for_application(
    db: Session, application: LeaveApplication, *, actor_id: uuid.UUID | None
) -> LeaveBalance:
    """Move ``used_milli_days`` by the frozen duration, exactly once.

    Caller must not have flushed a status change onto ``application`` yet: this
    re-reads ``status`` and ``debited_at`` from the database under the lock to
    decide whether the work has already been done, and an unflushed in-memory
    ``approved`` would be invisible to that read while a flushed one would make
    the second approver think it was their own.

    Does not commit. The caller commits, so the debit, the ``debited_at`` stamp
    and the attendance write-back land or fail together.
    """
    leave_type = db.get(LeaveType, application.leave_type_id)
    if leave_type is None:  # pragma: no cover - RESTRICT makes this unreachable
        raise LeaveError("leave_type_missing", "That leave type no longer exists")
    resolved = resolve_settings(db, application.org_id)
    year = balance_year_for(leave_type, application.start_date, resolved)

    ensure_balance_row(
        db,
        org_id=application.org_id,
        user_id=application.user_id,
        leave_type_id=leave_type.id,
        year=year,
    )
    balance = lock_balance(
        db, user_id=application.user_id, leave_type_id=leave_type.id, year=year
    )

    # Under the lock, straight from the database. Not db.refresh(application):
    # this session has autoflush off, so a refresh would quietly discard the
    # caller's pending attribute changes instead of reading around them.
    stored_status, debited_at = db.execute(
        select(LeaveApplication.status, LeaveApplication.debited_at).where(
            LeaveApplication.id == application.id
        )
    ).one()
    if debited_at is not None:
        # The idempotency latch (D-013). A retried or double-clicked approval
        # arrives here, finds the work done, and changes nothing.
        raise LeaveError(
            "already_debited", "That application has already been approved", 409
        )
    if stored_status != LeaveStatus.PENDING.value:
        raise LeaveError(
            "already_decided", "That application has already been decided", 409
        )

    if leave_type.is_comp_off:
        _consume_comp_off_credits(db, application)

    balance.used_milli_days += application.duration_milli_days
    application.debited_at = utcnow()
    db.flush()  # while the lock is still held; the caller's commit releases it.

    _audit(
        db,
        org_id=application.org_id,
        actor_id=actor_id,
        action="leave_balance_debited",
        target_type="leave_balance",
        target_id=balance.id,
        detail={
            "application_id": str(application.id),
            "leave_type": leave_type.name,
            "year": year,
            "delta_milli_days": application.duration_milli_days,
            "used_milli_days": balance.used_milli_days,
            "balance_milli_days": balance.balance_milli_days,
        },
    )
    return balance


def credit_back_for_application(
    db: Session, application: LeaveApplication, *, actor_id: uuid.UUID | None
) -> LeaveBalance | None:
    """Undo a debit on cancellation, using the frozen duration.

    ``duration_milli_days`` is read, never recomputed (D-013). If the holiday
    calendar gained a day inside the leave range while the leave was approved, a
    recomputed credit-back would return less than was taken and the balance
    would drift by exactly that day.
    """
    if application.debited_at is None:
        return None

    leave_type = db.get(LeaveType, application.leave_type_id)
    if leave_type is None:  # pragma: no cover - RESTRICT makes this unreachable
        raise LeaveError("leave_type_missing", "That leave type no longer exists")
    resolved = resolve_settings(db, application.org_id)
    year = balance_year_for(leave_type, application.start_date, resolved)
    ensure_balance_row(
        db,
        org_id=application.org_id,
        user_id=application.user_id,
        leave_type_id=leave_type.id,
        year=year,
    )
    balance = lock_balance(
        db, user_id=application.user_id, leave_type_id=leave_type.id, year=year
    )

    debited_at = db.scalar(
        select(LeaveApplication.debited_at).where(LeaveApplication.id == application.id)
    )
    if debited_at is None:
        # Someone else credited it back while we waited for the lock.
        return balance

    balance.used_milli_days -= application.duration_milli_days
    application.debited_at = None
    if leave_type.is_comp_off:
        _release_comp_off_credits(db, application, balance)
    db.flush()

    _audit(
        db,
        org_id=application.org_id,
        actor_id=actor_id,
        action="leave_balance_credited",
        target_type="leave_balance",
        target_id=balance.id,
        detail={
            "application_id": str(application.id),
            "leave_type": leave_type.name if leave_type else None,
            "year": year,
            "delta_milli_days": -application.duration_milli_days,
            "used_milli_days": balance.used_milli_days,
            "balance_milli_days": balance.balance_milli_days,
        },
    )
    return balance


def adjust_balance(
    db: Session,
    *,
    org_id: uuid.UUID,
    user_id: uuid.UUID,
    leave_type: LeaveType,
    year: int,
    delta_milli_days: int,
    reason: str,
    actor: User,
) -> LeaveBalance:
    """A human correction to one balance. Always audited (D-018 / D-021).

    There is no ``updated_at`` anywhere in this codebase and one is not being
    added, so ``AuditLog`` is the record that this number moved. The three
    ``adjusted_*`` columns answer "who last touched this and why" without a
    join; the audit row answers "show me every correction ever made".

    Refuses a comp-off type. D-022 gives the comp-off balance exactly one
    writer — the credit ledger — and an adjustment endpoint that could also
    move it would put the second source of truth straight back.
    """
    if leave_type.is_comp_off:
        raise LeaveError(
            "comp_off_not_adjustable",
            "Comp-off balance follows the credit ledger. Grant or revoke a "
            "comp-off credit instead of adjusting the balance.",
        )

    ensure_balance_row(
        db, org_id=org_id, user_id=user_id, leave_type_id=leave_type.id, year=year
    )
    balance = lock_balance(db, user_id=user_id, leave_type_id=leave_type.id, year=year)
    before = balance.balance_milli_days
    balance.adjusted_milli_days += delta_milli_days
    balance.adjusted_reason = reason
    balance.adjusted_by_user_id = actor.id
    balance.adjusted_at = utcnow()
    db.flush()

    _audit(
        db,
        org_id=org_id,
        actor_id=actor.id,
        action="leave_balance_adjusted",
        target_type="leave_balance",
        target_id=balance.id,
        detail={
            "user_id": str(user_id),
            "leave_type": leave_type.name,
            "year": year,
            "delta_milli_days": delta_milli_days,
            "reason": reason,
            "balance_before_milli_days": before,
            "balance_after_milli_days": balance.balance_milli_days,
        },
    )
    return balance


# --------------------------------------------------------------------------- #
# Comp-off: the ledger, and the projection it owns
# --------------------------------------------------------------------------- #


def comp_off_type_for(db: Session, org_id: uuid.UUID) -> LeaveType | None:
    return db.scalars(
        select(LeaveType).where(
            LeaveType.org_id == org_id,
            LeaveType.is_comp_off.is_(True),
            LeaveType.is_active.is_(True),
        )
    ).first()


def _project_comp_off(
    db: Session,
    *,
    org_id: uuid.UUID,
    user_id: uuid.UUID,
    comp_off_type_id: uuid.UUID,
    delta_milli_days: int,
) -> LeaveBalance:
    """Move the comp-off projection under the same lock every debit uses.

    ``accrued_milli_days`` is the projection column: the monthly accrual job
    never touches a comp-off type (they are forced to ``accrual_type='none'``
    when the type is created), so the credit ledger is its only writer and the
    "one writer per component" property in the model docstring still holds.
    """
    ensure_balance_row(
        db,
        org_id=org_id,
        user_id=user_id,
        leave_type_id=comp_off_type_id,
        year=COMP_OFF_BALANCE_YEAR,
    )
    balance = lock_balance(
        db,
        user_id=user_id,
        leave_type_id=comp_off_type_id,
        year=COMP_OFF_BALANCE_YEAR,
    )
    balance.accrued_milli_days += delta_milli_days
    db.flush()
    return balance


def grant_comp_off(
    db: Session,
    *,
    org_id: uuid.UUID,
    employee: User,
    earned_date: date,
    credit_milli_days: int,
    reason: str | None,
    expires_at: date | None,
    actor: User,
) -> CompOffCredit:
    """Record one earned day off and project it into the balance, atomically."""
    comp_off_type = comp_off_type_for(db, org_id)
    if comp_off_type is None:
        raise LeaveError(
            "no_comp_off_type",
            "This organisation has no active comp-off leave type. Create one "
            "with is_comp_off set before granting credits.",
        )
    expiry = expires_at or (
        earned_date + timedelta(days=app_settings.comp_off_default_expiry_days)
    )
    if expiry <= earned_date:
        raise LeaveError("bad_expiry", "expires_at must be after earned_date")

    credit = CompOffCredit(
        org_id=org_id,
        user_id=employee.id,
        earned_date=earned_date,
        reason=reason,
        credit_milli_days=credit_milli_days,
        expires_at=expiry,
        granted_by_user_id=actor.id,
    )
    db.add(credit)
    db.flush()

    balance = _project_comp_off(
        db,
        org_id=org_id,
        user_id=employee.id,
        comp_off_type_id=comp_off_type.id,
        delta_milli_days=credit_milli_days,
    )
    _audit(
        db,
        org_id=org_id,
        actor_id=actor.id,
        action="comp_off_granted",
        target_type="comp_off_credit",
        target_id=credit.id,
        detail={
            "user_id": str(employee.id),
            "credit_milli_days": credit_milli_days,
            "earned_date": earned_date.isoformat(),
            "expires_at": expiry.isoformat(),
            "balance_milli_days": balance.balance_milli_days,
        },
    )
    return credit


def _consume_comp_off_credits(db: Session, application: LeaveApplication) -> None:
    """Attach credits to the application being approved, soonest expiry first.

    FIFO by expiry, because spending the credit that dies first is the only
    order that does not throw entitlement away. Runs inside the debit's locked
    transaction so the ledger and the projection can never disagree about
    whether this leave was paid for.
    """
    needed = application.duration_milli_days
    if needed <= 0:
        return
    credits = db.scalars(
        select(CompOffCredit)
        .where(
            CompOffCredit.user_id == application.user_id,
            CompOffCredit.used_in_application_id.is_(None),
            CompOffCredit.expired_at.is_(None),
            CompOffCredit.expires_at >= application.start_date,
        )
        .order_by(CompOffCredit.expires_at, CompOffCredit.earned_date)
    ).all()

    covered = 0
    for credit in credits:
        if covered >= needed:
            break
        remaining = needed - covered
        if credit.credit_milli_days > remaining:
            # Split rather than swallow the whole credit. A half-day taken
            # against a full-day credit would otherwise consume the whole day
            # while debiting half of it: the balance row would still read half a
            # day while the ledger had nothing left to spend, and the two
            # readings of one entitlement would disagree — which is precisely
            # what D-022 exists to stop. The split leaves the ledger's total
            # untouched, so the projection needs no adjustment.
            leftover = credit.credit_milli_days - remaining
            credit.credit_milli_days = remaining
            db.add(
                CompOffCredit(
                    org_id=credit.org_id,
                    user_id=credit.user_id,
                    earned_date=credit.earned_date,
                    reason=credit.reason,
                    credit_milli_days=leftover,
                    expires_at=credit.expires_at,
                    granted_by_user_id=credit.granted_by_user_id,
                )
            )
        credit.used_in_application_id = application.id
        covered += credit.credit_milli_days
    if covered < needed:
        raise LeaveError(
            "comp_off_insufficient",
            "There are not enough unexpired comp-off credits to cover this leave",
        )
    db.flush()


def _release_comp_off_credits(
    db: Session, application: LeaveApplication, balance: LeaveBalance
) -> None:
    """Hand credits back on cancellation — and expire the ones that died meanwhile.

    Without the second half, cancelling a leave taken against a credit that has
    since passed its ``expires_at`` would return a dead day to the balance as a
    live one. The credit is released and immediately expired in the same locked
    transaction, so the projection lands on the truth in one step.
    """
    today = org_today(db, application.org_id)
    credits = db.scalars(
        select(CompOffCredit).where(
            CompOffCredit.used_in_application_id == application.id
        )
    ).all()
    for credit in credits:
        credit.used_in_application_id = None
        if credit.expires_at < today and credit.expired_at is None:
            credit.expired_at = utcnow()
            balance.accrued_milli_days -= credit.credit_milli_days


def reconcile_comp_off(db: Session, org_id: uuid.UUID) -> list[dict]:
    """Recompute the projection from the ledger and report the difference.

    D-022's cost, made visible. The invariant is

        accrued_milli_days == sum(credit_milli_days WHERE expired_at IS NULL)

    A non-empty return means a writer bypassed the ledger. Called by the tests;
    worth calling from a support endpoint or a report later, which is why it
    returns rows rather than logging and swallowing them.
    """
    comp_off_type = comp_off_type_for(db, org_id)
    if comp_off_type is None:
        return []

    ledger: dict[uuid.UUID, int] = {}
    for credit in db.scalars(
        select(CompOffCredit).where(
            CompOffCredit.org_id == org_id, CompOffCredit.expired_at.is_(None)
        )
    ).all():
        ledger[credit.user_id] = ledger.get(credit.user_id, 0) + credit.credit_milli_days

    drift: list[dict] = []
    balances = db.scalars(
        select(LeaveBalance).where(
            LeaveBalance.org_id == org_id,
            LeaveBalance.leave_type_id == comp_off_type.id,
        )
    ).all()
    seen: set[uuid.UUID] = set()
    for balance in balances:
        seen.add(balance.user_id)
        expected = ledger.get(balance.user_id, 0)
        if balance.accrued_milli_days != expected:
            drift.append(
                {
                    "user_id": balance.user_id,
                    "projected_milli_days": balance.accrued_milli_days,
                    "ledger_milli_days": expected,
                }
            )
    for user_id, expected in ledger.items():
        if user_id not in seen and expected:
            drift.append(
                {
                    "user_id": user_id,
                    "projected_milli_days": 0,
                    "ledger_milli_days": expected,
                }
            )
    return drift


# --------------------------------------------------------------------------- #
# Applications
# --------------------------------------------------------------------------- #


def find_overlapping(
    db: Session, *, user_id: uuid.UUID, start: date, end: date,
    exclude_id: uuid.UUID | None = None,
) -> LeaveApplication | None:
    """An application that still lays claim to any date in this range.

    Pending counts as well as approved: two overlapping pending applications are
    a manager approving the same days twice, one screen apart.
    """
    stmt = select(LeaveApplication).where(
        LeaveApplication.user_id == user_id,
        LeaveApplication.status.in_(
            [LeaveStatus.PENDING.value, LeaveStatus.APPROVED.value]
        ),
        LeaveApplication.start_date <= end,
        LeaveApplication.end_date >= start,
    )
    if exclude_id is not None:
        stmt = stmt.where(LeaveApplication.id != exclude_id)
    return db.scalars(stmt).first()


def present_days_in_range(
    db: Session, *, user_id: uuid.UUID, start: date, end: date
) -> list[date]:
    """Days already marked present. §3.2 makes applying over one an error."""
    return list(
        db.scalars(
            select(AttendanceRecord.date)
            .where(
                AttendanceRecord.user_id == user_id,
                AttendanceRecord.date >= start,
                AttendanceRecord.date <= end,
                AttendanceRecord.status == AttendanceStatus.PRESENT.value,
            )
            .order_by(AttendanceRecord.date)
        ).all()
    )


def apply_for_leave(
    db: Session,
    *,
    actor: User,
    employee: User,
    leave_type: LeaveType,
    start_date: date,
    end_date: date,
    is_half_day: bool,
    half_day_session: str | None,
    reason: str | None,
) -> LeaveApplication:
    """Create one application, with the duration frozen onto it.

    Does not commit; the router does, after it has queued the alert.
    """
    if not leave_type.is_active:
        raise LeaveError("leave_type_inactive", "That leave type is no longer available")
    if is_half_day and not leave_type.allow_half_day:
        raise LeaveError(
            "half_day_not_allowed", f"{leave_type.name} cannot be taken as a half day"
        )

    resolved = resolve_settings(db, employee.org_id)
    today = org_today(db, employee.org_id)

    # §3.2, first rule. Both halves are a validation error, never a silent
    # overwrite: leave that quietly replaced a day somebody was recorded present
    # for would be an unattributable attendance edit.
    clash = find_overlapping(db, user_id=employee.id, start=start_date, end=end_date)
    if clash is not None:
        raise LeaveError(
            "overlapping_leave",
            f"That range overlaps leave you already have from "
            f"{clash.start_date.isoformat()} to {clash.end_date.isoformat()}",
            409,
        )
    present = present_days_in_range(
        db, user_id=employee.id, start=start_date, end=end_date
    )
    if present:
        raise LeaveError(
            "attendance_present",
            "You are already marked present on "
            + ", ".join(day.isoformat() for day in present[:5]),
            409,
        )

    # min_notice_days is enforced for the employee and waived for anyone filing
    # on their behalf — the column comment says a manager must be able to
    # override it, and HR back-filling last month's leave from a spreadsheet is
    # the case that makes it mandatory rather than merely convenient.
    if actor.id == employee.id and leave_type.min_notice_days > 0:
        earliest = today + timedelta(days=leave_type.min_notice_days)
        if start_date < earliest:
            raise LeaveError(
                "insufficient_notice",
                f"{leave_type.name} needs {leave_type.min_notice_days} days' notice; "
                f"the earliest you can start is {earliest.isoformat()}",
            )

    duration = compute_duration_milli_days(
        db, employee, start_date, end_date, is_half_day
    )
    if duration <= 0:
        raise LeaveError(
            "no_working_days",
            "That range is entirely holidays and weekly-offs, so there is "
            "nothing to apply for",
        )

    view = balance_view(
        db, user=employee, leave_type=leave_type, on=start_date, resolved=resolved
    )
    if duration > view.available_milli_days:
        raise LeaveError(
            "insufficient_balance",
            f"{leave_type.name}: {_days(duration)} requested, "
            f"{_days(view.available_milli_days)} available",
        )

    application = LeaveApplication(
        org_id=employee.org_id,
        user_id=employee.id,
        leave_type_id=leave_type.id,
        start_date=start_date,
        end_date=end_date,
        is_half_day=is_half_day,
        half_day_session=half_day_session,
        duration_milli_days=duration,
        reason=reason,
        status=LeaveStatus.PENDING.value,
        applied_at=utcnow(),
    )
    db.add(application)
    db.flush()

    if not leave_type.requires_approval:
        # Some orgs run sick leave as a declaration. The application is still
        # recorded and still debits; it just never sits in the pending state.
        _auto_approve(db, application, actor=actor)
    else:
        # A chain begins when the request does. Does nothing when leave has no
        # chain configured, which is most companies.
        chains.start_for(db, kind="leave", record_id=application.id, subject=employee)
    return application


def _auto_approve(db: Session, application: LeaveApplication, *, actor: User) -> None:
    """Approve on submission, for a type that requires no decision.

    Deliberately **not** through ``services.workflow``. The kernel's guards are
    about a person deciding — not your own, not twice, say why if you refuse —
    and none of them mean anything when nobody decided: this is the leave type
    saying it needs no approval, not a manager agreeing. Routing it through
    ``decide`` would also walk an approval chain, which for a declaration is a
    chain with nobody in it.

    The debit still happens, in the same order the decided path uses: spend the
    balance first, stamp second, write attendance last.
    """
    debit_for_application(db, application, actor_id=actor.id)
    application.status = LeaveStatus.APPROVED.value
    application.reviewed_at = utcnow()
    application.reviewed_by_user_id = actor.id
    application.review_note = (
        "Auto-approved: this leave type does not require approval"
    )
    db.flush()
    stamp_on_leave(db, application)


def decide(
    db: Session,
    *,
    application: LeaveApplication,
    reviewer: User,
    approve: bool,
    note: str | None,
    request: Request | None = None,
) -> LeaveApplication:
    """Approve or reject. Does not commit.

    Already-decided and self-review are ``services.workflow``'s, declared in
    ``workflow.LEAVE``. **Self-review used to be checked in the router** — one
    of the two flows that did — which meant any second caller of this function
    did not get the rule. It does now.

    What is still leave's own: the debit, and the attendance write-back.
    """
    def debit() -> None:
        # Debit first, decide second. debit_for_application re-reads status from
        # the database to detect a concurrent approval, and a flushed "approved"
        # would make the loser of that race think it had won. The kernel runs
        # this before it stamps, which is why that ordering is its contract.
        debit_for_application(db, application, actor_id=reviewer.id)

    workflow.decide(
        db, policy=workflow.LEAVE, record=application, reviewer=reviewer,
        approve=approve, note=note, request=request, on_approve=debit,
        detail={"duration_milli_days": application.duration_milli_days},
        what="application",
    )
    if approve:
        # After the stamp, unlike the debit: this fabricates attendance rows for
        # days the approval has already been recorded for, and a failure here
        # must not leave the balance debited against an undecided application.
        stamp_on_leave(db, application)
    # Nothing is debited on a rejection, so there is nothing to give back —
    # which is the whole reason rejection and cancellation are different states.
    return application


# --------------------------------------------------------------------------- #
# Attendance write-back (§3.2, D-007, D-020)
# --------------------------------------------------------------------------- #


def stamp_on_leave(db: Session, application: LeaveApplication) -> int:
    """Mark the approved days ``on_leave``.

    Three rules, each of which has a way to go wrong that is silent:

    * ``status`` is set **explicitly** on any row this creates. The column
      defaults to ``present``, which is right for the punch path and a
      fabricated attendance record here (D-020).
    * A row a human decided — an approved regularization — is left alone. A
      human decision outranks a derived one (D-007), the same rule attribution
      already enforces.
    * A half-day leave writes nothing. ``on_leave`` on a day the employee works
      the other half is a lie the nightly job would then have to unpick, and
      the six-value status enum has no half-of-a-half to express it.
    """
    if application.is_half_day:
        return 0

    user = db.get(User, application.user_id)
    days = leave_days_in_range(db, user, application.start_date, application.end_date)
    stamped = 0
    for day in days:
        record = db.scalars(
            select(AttendanceRecord).where(
                AttendanceRecord.org_id == application.org_id,
                AttendanceRecord.user_id == application.user_id,
                AttendanceRecord.date == day,
            )
        ).one_or_none()
        if record is None:
            db.add(
                AttendanceRecord(
                    org_id=application.org_id,
                    user_id=application.user_id,
                    date=day,
                    status=AttendanceStatus.ON_LEAVE.value,
                    worked_minutes=0,
                    note="Approved leave",
                )
            )
            stamped += 1
            continue
        if (
            record.regularization_id is not None
            or record.check_in_source == PunchSource.REGULARIZED.value
        ):
            continue
        record.status = AttendanceStatus.ON_LEAVE.value
        stamped += 1
    db.flush()
    return stamped


def unstamp_on_leave(db: Session, application: LeaveApplication) -> int:
    """Undo the write-back when approved leave is cancelled.

    Scans the whole date range for rows that are currently ``on_leave`` rather
    than recomputing which days were leave days. The asymmetry with
    :func:`stamp_on_leave` is deliberate: recomputing would consult a holiday
    calendar that may have changed since approval and would then leave an
    ``on_leave`` row standing on a day nobody is on leave — the same class of
    bug D-013 freezes the duration to avoid.
    """
    records = db.scalars(
        select(AttendanceRecord).where(
            AttendanceRecord.org_id == application.org_id,
            AttendanceRecord.user_id == application.user_id,
            AttendanceRecord.date >= application.start_date,
            AttendanceRecord.date <= application.end_date,
            AttendanceRecord.status == AttendanceStatus.ON_LEAVE.value,
        )
    ).all()
    cleared = 0
    for record in records:
        if (
            record.check_in_at is None
            and record.check_out_at is None
            and record.regularization_id is None
        ):
            # Nothing was ever observed on this day; the row exists only because
            # the approval created it. Delete rather than invent a status, and
            # let the nightly job decide the day on its own terms.
            db.delete(record)
        else:
            # There are real punches on it. present is what the punch path means
            # by a row that exists, and the nightly job refines it from there.
            record.status = AttendanceStatus.PRESENT.value
        cleared += 1
    db.flush()
    return cleared


def cancel(
    db: Session, *, application: LeaveApplication, actor: User, reason: str | None
) -> LeaveApplication:
    """Withdraw an application, crediting back if it had been debited."""
    if application.status not in (
        LeaveStatus.PENDING.value,
        LeaveStatus.APPROVED.value,
    ):
        raise LeaveError(
            "not_cancellable", f"That application is already {application.status}", 409
        )

    today = org_today(db, application.org_id)
    is_self = actor.id == application.user_id
    if is_self and application.end_date < today:
        # Cancelling leave already taken would credit back days somebody was
        # genuinely absent for. An administrator can still do it, because a
        # mis-filed application does have to be fixable.
        if not actor.role_enum.can_administer:
            raise LeaveError(
                "already_taken",
                "That leave has already finished. Ask an administrator to correct it.",
                409,
            )

    if application.debited_at is not None:
        credit_back_for_application(db, application, actor_id=actor.id)
        unstamp_on_leave(db, application)

    application.status = LeaveStatus.CANCELLED.value
    application.cancelled_at = utcnow()
    if reason:
        # Appended rather than overwriting the reviewer's note: why it was
        # approved and why it was withdrawn are two different facts.
        existing = (application.review_note or "").strip()
        application.review_note = (
            f"{existing}\nCancelled: {reason}" if existing else f"Cancelled: {reason}"
        )
    db.flush()

    _audit(
        db,
        org_id=application.org_id,
        actor_id=actor.id,
        action="leave_cancelled",
        target_type="leave_application",
        target_id=application.id,
        detail={
            "user_id": str(application.user_id),
            "duration_milli_days": application.duration_milli_days,
            "reason": reason,
        },
    )
    return application


# --------------------------------------------------------------------------- #
# Alerts — everything goes through notifications.dispatch(), the one door
# --------------------------------------------------------------------------- #

def notify(
    db: Session,
    user: User,
    kind: notif.Kind,
    *,
    dedupe_key: str,
    subject: str,
    body: str,
) -> bool:
    """Send one leave alert through the one door.

    No direct ``email.send`` anywhere in this module: ``dispatch`` owns the
    opt-out check, the de-duplication claim and the outcome row, and a second
    sender is a second place a preference gets forgotten.

    The four leave kinds live in ``services/notifications.py``, which is a shared
    file — this module only reads the catalogue. A kind that is somehow missing
    its spec is logged and skipped rather than raised: a mail catalogue gap must
    not take down a leave approval that has already debited a balance.
    """
    if kind not in notif.SPECS:  # pragma: no cover - the catalogue defines all four
        log.warning("notification kind %s has no spec; leave alert skipped", kind)
        return False
    return notif.dispatch(
        db, user, kind, dedupe_key=dedupe_key, subject=subject, body=body
    )


def _days(milli_days: int) -> str:
    """Milli-days as a sentence fragment. Display only, never arithmetic."""
    whole = milli_days / MILLI_DAYS_PER_DAY
    text = f"{whole:.3f}".rstrip("0").rstrip(".")
    return f"{text} day" if whole == 1 else f"{text} days"


def notify_applied(db: Session, application: LeaveApplication) -> bool:
    employee = db.get(User, application.user_id)
    if employee is None or employee.manager_id is None:
        return False
    manager = db.get(User, employee.manager_id)
    if manager is None:
        return False
    leave_type = db.get(LeaveType, application.leave_type_id)
    return notify(
        db,
        manager,
        notif.Kind.LEAVE_APPLIED,
        dedupe_key=str(application.id),
        subject=f"Leave request from {employee.full_name}",
        body=(
            f"{employee.full_name} has applied for {_days(application.duration_milli_days)} "
            f"of {leave_type.name if leave_type else 'leave'} from "
            f"{application.start_date.isoformat()} to {application.end_date.isoformat()}.\n\n"
            f"Reason: {application.reason or '-'}"
        ),
    )


def notify_decided(db: Session, application: LeaveApplication) -> bool:
    """Non-optional (§3.2). A decision about somebody's leave is not marketing."""
    employee = db.get(User, application.user_id)
    if employee is None:
        return False
    leave_type = db.get(LeaveType, application.leave_type_id)
    decision = application.status
    return notify(
        db,
        employee,
        notif.Kind.LEAVE_DECIDED,
        # The decision is in the key, so a rejection followed by a later
        # approval both send — two different pieces of news — while a
        # double-clicked Approve sends once.
        dedupe_key=f"{application.id}:{decision}",
        subject=f"Your leave request was {decision}",
        body=(
            f"Your request for {_days(application.duration_milli_days)} of "
            f"{leave_type.name if leave_type else 'leave'} from "
            f"{application.start_date.isoformat()} to {application.end_date.isoformat()} "
            f"was {decision}.\n\n"
            f"Note: {application.review_note or '-'}"
        ),
    )


def notify_cancelled(db: Session, application: LeaveApplication) -> bool:
    """D-013's addition to §3.2's alert list.

    A manager who approved leave and rearranged cover around it has to be told
    when the employee withdraws it. ``leave_decided`` does not cover this: the
    decision was already made and already announced.
    """
    employee = db.get(User, application.user_id)
    if employee is None:
        return False
    recipient_id = application.reviewed_by_user_id or employee.manager_id
    if recipient_id is None or recipient_id == employee.id:
        return False
    manager = db.get(User, recipient_id)
    if manager is None:
        return False
    return notify(
        db,
        manager,
        notif.Kind.LEAVE_CANCELLED,
        dedupe_key=str(application.id),
        subject=f"{employee.full_name} cancelled their leave",
        body=(
            f"{employee.full_name} has withdrawn their leave from "
            f"{application.start_date.isoformat()} to "
            f"{application.end_date.isoformat()}."
        ),
    )


def notify_balance_low(
    db: Session, employee: User, leave_type: LeaveType, view: BalanceView
) -> bool:
    if view.available_milli_days > LOW_BALANCE_THRESHOLD_MILLI_DAYS:
        return False
    return notify(
        db,
        employee,
        notif.Kind.LEAVE_BALANCE_LOW,
        # A condition, not an event, so the value that makes it true is in the
        # key: it fires once per type per policy year, not on every debit.
        dedupe_key=f"{leave_type.id}:{view.year}",
        subject=f"You are running low on {leave_type.name}",
        body=(
            f"You have {_days(max(0, view.available_milli_days))} of "
            f"{leave_type.name} left for this leave year."
        ),
    )


# --------------------------------------------------------------------------- #
# Job bodies. Plain callables — app/scheduler.py is the lead's file.
# --------------------------------------------------------------------------- #


def accrual_target_milli_days(
    annual_milli_days: int,
    year_start: date,
    year_end: date,
    as_of: date,
    joined_on: date | None,
) -> int:
    """Entitlement earned by the start of ``as_of``, floored **exactly once**.

    This is the accrual rule, and it is a *target* rather than an increment for
    three reasons that all matter more than they look:

    * **The remainder carries.** 25 days a year is 2.083 days a month. Crediting
      a floored 2083 twelve times pays out 24.996 days and quietly keeps the
      difference; flooring the running total instead pays 25.000 exactly, with
      the fraction carried from each period into the next. The annual drift from
      truncating is about three minutes of leave, and "about three minutes" is
      not a thing anybody wants to explain to a tribunal.
    * **It is idempotent.** Running the job twice in one month credits nothing
      the second time. A job that only works when it fires exactly twelve times
      a year shortchanges people the first time a deployment overlaps the 1st.
    * **It is self-healing.** A month the scheduler was down is caught up on the
      next run rather than lost forever.

    Pro-rating is by elapsed *days*, so a mid-year joiner earns from their
    joining date rather than from whichever month they happened to start in. The
    visible consequence, and it is deliberate: the figure tracks elapsed time
    rather than completed months, so after a 31-day January an employee on
    25 days a year reads 2.123 rather than 2.083. It converges to exactly the
    annual entitlement at the year end, which is the number anyone checks.

    ``as_of`` is exclusive — on 1 May, April has been earned and May has not.
    """
    days_in_year = (year_end - year_start).days + 1
    earned_from = max(year_start, joined_on) if joined_on else year_start
    last_earned_day = min(as_of - timedelta(days=1), year_end)
    if last_earned_day < earned_from:
        return 0
    elapsed_days = (last_earned_day - earned_from).days + 1
    share = Fraction(annual_milli_days * elapsed_days, days_in_year)
    return share.numerator // share.denominator


def _yearly_target(
    rate_milli_days: int, year_start: date, year_end: date, joined_on: date | None
) -> int:
    """A yearly type's entitlement, pro-rated for somebody who joined mid-year."""
    days_in_year = (year_end - year_start).days + 1
    if joined_on is None or joined_on <= year_start:
        eligible_days = days_in_year
    elif joined_on > year_end:
        eligible_days = 0
    else:
        eligible_days = (year_end - joined_on).days + 1
    share = Fraction(rate_milli_days * eligible_days, days_in_year)
    return share.numerator // share.denominator


def accrue_org(db: Session, org: Organization, today: date) -> dict:
    """Credit one org's accruals up to the day before ``today``.

    Commits. Each org is independent, so one tenant with a broken leave type
    must not roll back the eleven that worked.
    """
    resolved = resolve_settings(db, org.id)
    year = policy_year_for(today, resolved.leave_year_start_month)
    year_start, year_end = policy_year_bounds(year, resolved.leave_year_start_month)

    types = db.scalars(
        select(LeaveType).where(
            LeaveType.org_id == org.id,
            LeaveType.is_active.is_(True),
            LeaveType.is_comp_off.is_(False),
        )
    ).all()
    users = db.scalars(
        select(User).where(User.org_id == org.id, User.is_active.is_(True))
    ).all()

    result = {"credited_milli_days": 0, "balances": 0}
    for leave_type in types:
        accrual = leave_type.accrual_type_enum
        if accrual is AccrualType.NONE or leave_type.accrual_rate_milli_days <= 0:
            # NONE is not "no leave": it is leave granted as a lump through
            # opening or adjusted, and crediting it zero here would look like a
            # working job to anybody reading the balance.
            continue
        for user in users:
            if user.joined_on is not None and user.joined_on > year_end:
                continue
            if accrual is AccrualType.MONTHLY:
                # The column is a per-month rate, so the year is twelve of them.
                # Going through the annual figure is what lets the target carry
                # its remainder instead of flooring twelve times.
                target = accrual_target_milli_days(
                    leave_type.accrual_rate_milli_days * 12,
                    year_start,
                    year_end,
                    today,
                    user.joined_on,
                )
            else:
                # A yearly type is credited as a lump at the start of the policy
                # year rather than earned across it — that is what "yearly"
                # means to the admin who chose it — pro-rated only for somebody
                # who was not there when the year opened.
                target = _yearly_target(
                    leave_type.accrual_rate_milli_days, year_start, year_end, user.joined_on
                )
            if target <= 0:
                continue

            ensure_balance_row(
                db,
                org_id=org.id,
                user_id=user.id,
                leave_type_id=leave_type.id,
                year=year,
            )
            # Locked like every other write to this row: the accrual job and a
            # manager approving leave are two writers on one integer, and the
            # job is not exempt from the rule the debit path follows.
            balance = lock_balance(
                db, user_id=user.id, leave_type_id=leave_type.id, year=year
            )
            credit = target - balance.accrued_milli_days
            if credit <= 0:
                continue
            cap = leave_type.max_balance_milli_days
            if cap > 0:
                # A cap is a real loss, not a deferral: the target stays where it
                # is and the next run clips again, so the balance sits at the cap
                # instead of quietly banking the overflow.
                credit = min(credit, max(0, cap - balance.balance_milli_days))
            if credit <= 0:
                continue
            balance.accrued_milli_days += credit
            result["credited_milli_days"] += credit
            result["balances"] += 1
            _audit(
                db,
                org_id=org.id,
                actor_id=None,
                action="leave_accrued",
                target_type="leave_balance",
                target_id=balance.id,
                detail={
                    "user_id": str(user.id),
                    "leave_type": leave_type.name,
                    "year": year,
                    "as_of": today.isoformat(),
                    "delta_milli_days": credit,
                    "accrued_milli_days": balance.accrued_milli_days,
                },
            )
    db.commit()
    return result


def accrue_monthly(now: datetime | None = None) -> dict:
    """Body of the ``leave_accrual`` job. Registered in scheduler.py by the lead.

    Safe to run more often than monthly — it credits a cumulative target, so an
    extra run is a no-op and a missed month is caught up rather than lost. That
    is deliberate: a job that only works if it fires exactly twelve times a year
    is a job that silently shortchanges people the first time a deployment
    overlaps the 1st.
    """
    totals = {"orgs": 0, "credited_milli_days": 0, "balances": 0}
    with SessionLocal() as db:
        for org in db.scalars(select(Organization)).all():
            today = (
                now.astimezone(reports.tz_for(org.timezone)).date()
                if now is not None
                else org_today(db, org.id)
            )
            try:
                result = accrue_org(db, org, today)
            except Exception:
                # One tenant's bad policy row must not stop the other tenants
                # accruing, and the scheduler only logs whatever escapes here.
                db.rollback()
                log.exception("leave accrual failed for org %s", org.slug)
                continue
            totals["orgs"] += 1
            totals["credited_milli_days"] += result["credited_milli_days"]
            totals["balances"] += result["balances"]
    return totals


def expire_comp_offs(today: date | None = None) -> dict:
    """Body of the ``comp_off_expiry`` job. Registered in scheduler.py by the lead.

    Only unused, unexpired credits past their date. A credit already attached to
    an application was spent — the matching debit is already in
    ``used_milli_days`` — so expiring it would take the day away twice.

    ``today`` is resolved per organisation from its own timezone: a credit
    expiring "on the 31st" expires at the end of the 31st where the employee
    is, not wherever the container happens to run.
    """
    totals = {"orgs": 0, "expired": 0, "expired_milli_days": 0}
    with SessionLocal() as db:
        for org in db.scalars(select(Organization)).all():
            local_today = today or org_today(db, org.id)
            comp_off_type = comp_off_type_for(db, org.id)
            credits = db.scalars(
                select(CompOffCredit).where(
                    CompOffCredit.org_id == org.id,
                    CompOffCredit.expires_at < local_today,
                    CompOffCredit.expired_at.is_(None),
                    CompOffCredit.used_in_application_id.is_(None),
                )
            ).all()
            if not credits:
                totals["orgs"] += 1
                continue
            try:
                for credit in credits:
                    credit.expired_at = utcnow()
                    if comp_off_type is not None:
                        # Same locked row every debit uses, so the ledger and its
                        # projection move together or not at all (D-022).
                        _project_comp_off(
                            db,
                            org_id=org.id,
                            user_id=credit.user_id,
                            comp_off_type_id=comp_off_type.id,
                            delta_milli_days=-credit.credit_milli_days,
                        )
                    _audit(
                        db,
                        org_id=org.id,
                        actor_id=None,
                        action="comp_off_expired",
                        target_type="comp_off_credit",
                        target_id=credit.id,
                        detail={
                            "user_id": str(credit.user_id),
                            "credit_milli_days": credit.credit_milli_days,
                            "expires_at": credit.expires_at.isoformat(),
                        },
                    )
                    totals["expired"] += 1
                    totals["expired_milli_days"] += credit.credit_milli_days
                db.commit()
            except Exception:
                db.rollback()
                log.exception("comp-off expiry failed for org %s", org.slug)
                continue
            totals["orgs"] += 1
    return totals
