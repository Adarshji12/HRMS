"""Leave: balances that add up, and a debit that cannot be raced.

The property this file exists to protect is that ``leave_balances`` is
arithmetic somebody eventually gets paid or not paid for. Everything else here
— the overlap rules, the frozen duration, the accrual remainder — is in service
of that number being right, and each test names the specific way it goes wrong.

**A warning about the concurrency test, up front.** The suite runs on SQLite,
and SQLite takes a whole-database write lock, so the debit sequence is safe
there whether or not it holds a row lock. ``test_concurrent_approvals_never_
double_spend`` therefore cannot fail for the reason it exists, and passing it is
not evidence the lock works. It is paired with
``test_the_debit_takes_a_row_lock_on_postgres``, which compiles the statement
for the Postgres dialect and asserts the ``FOR UPDATE`` is in the SQL — that one
*can* fail on SQLite, and it is what actually guards the invariant here. Read
both docstrings before trusting either.
"""

from __future__ import annotations

import threading
import uuid
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import event, select
from sqlalchemy.dialects import postgresql

from app.db.session import SessionLocal, engine
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
    NotificationLog,
    NotificationPreference,
    Organization,
    PunchSource,
    User,
)
from app.services import leave as svc
from app.services import notifications as notif


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


@pytest.fixture(scope="session", autouse=True)
def _leave_router_mounted():
    """Mount the leave router if the lead has not registered it yet.

    Phase 4 ships the router before ``api/v1/router.py`` — a lead-only file —
    includes it, so without this every HTTP test below would 404 for a reason
    that has nothing to do with what it is testing. This registers the real
    router on the real app, and it is a no-op the moment the include line lands.
    ``test_router_is_registered_for_integration`` asserts the registration
    separately, against the router module rather than the app, so the shim can
    never hide a missing one.
    """
    from app.api.v1 import leave as leave_router
    from app.main import app

    mounted = any(
        getattr(route, "path", "").startswith("/api/v1/leave") for route in app.routes
    )
    if not mounted:
        app.include_router(leave_router.router, prefix="/api/v1")
        app.openapi_schema = None
    yield


def test_router_is_registered_for_integration():
    """Fails until the lead adds leave to ``api/v1/router.py``. Deliberate.

    Checked against the router module rather than the app, so the fixture above
    cannot satisfy it.
    """
    from app.api.v1.router import api_router

    paths = {getattr(route, "path", "") for route in api_router.routes}
    assert any(path.startswith("/api/v1/leave") for path in paths), (
        "app/api/v1/router.py does not include leave.router - see the Phase 4 "
        "integration request"
    )


def test_the_job_bodies_are_registered_with_the_scheduler():
    """Fails until the lead adds the two jobs to ``app/scheduler.py``. Deliberate.

    An accrual job nobody runs is the failure mode the scheduler module's own
    docstring exists because of: both existing jobs shipped with no caller, so
    alerts never fired and retention never deleted anything while the console
    said otherwise. A balance that never accrues is the same bug with a payroll
    consequence.
    """
    from app.scheduler import build_jobs

    names = {job.name for job in build_jobs()}
    assert {"leave_accrual", "comp_off_expiry"} <= names, (
        "app/scheduler.py does not register leave_accrual and comp_off_expiry - "
        f"see the Phase 4 integration request; found {sorted(names)}"
    )


def _monday(year: int, month: int) -> date:
    """The first Monday on or after the 1st, so ranges land on working days."""
    first = date(year, month, 1)
    return first + timedelta(days=(0 - first.weekday()) % 7)


#: Far enough out that ``min_notice_days`` and "already taken" never bite, and
#: fixed rather than relative so a test that fails does so identically tomorrow.
BASE_MONDAY = _monday(2029, 3)


def _make_type(db, org_id: uuid.UUID, **overrides) -> LeaveType:
    values = {
        "name": "Casual Leave",
        "code": "CL",
        "is_paid": True,
        "accrual_type": "monthly",
        "accrual_rate_milli_days": 1000,
        "requires_approval": True,
        "allow_half_day": True,
    }
    values.update(overrides)
    leave_type = LeaveType(org_id=org_id, **values)
    db.add(leave_type)
    db.flush()
    return leave_type


def _seed_balance(db, org_id, user_id, leave_type_id, milli_days: int, year: int):
    balance = LeaveBalance(
        org_id=org_id,
        user_id=user_id,
        leave_type_id=leave_type_id,
        year=year,
        accrued_milli_days=milli_days,
    )
    db.add(balance)
    db.flush()
    return balance


@pytest.fixture
def leave_org(tenants):
    """Acme with a leave type, a stocked balance, and the staff member reporting
    to the owner so the ``leave_applied`` alert has somewhere to go."""
    acme, _ = tenants
    with SessionLocal() as db:
        staff = db.get(User, acme.employee.id)
        staff.manager_id = acme.owner.id
        leave_type = _make_type(db, acme.id)
        year = svc.policy_year_for(BASE_MONDAY, 1)
        _seed_balance(db, acme.id, staff.id, leave_type.id, 20_000, year)
        db.commit()
        return {
            "tenant": acme,
            "leave_type_id": leave_type.id,
            "year": year,
            "staff_id": staff.id,
            "owner_id": acme.owner.id,
        }


def _apply(client, tenant, leave_org, *, start, end, token=None, **extra) -> dict:
    body = {
        "leave_type_id": str(leave_org["leave_type_id"]),
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
    }
    body.update(extra)
    return client.post(
        "/api/v1/leave/applications",
        json=body,
        headers=tenant.headers(token or tenant.employee_token),
    )


def _decide(client, tenant, application_id, approve: bool, note: str | None = None):
    return client.post(
        f"/api/v1/leave/applications/{application_id}/decision",
        json={"approve": approve, "note": note},
        headers=tenant.headers(),
    )


def _balance(db, leave_org) -> LeaveBalance:
    return db.scalars(
        select(LeaveBalance).where(
            LeaveBalance.user_id == leave_org["staff_id"],
            LeaveBalance.leave_type_id == leave_org["leave_type_id"],
            LeaveBalance.year == leave_org["year"],
        )
    ).one()


# --------------------------------------------------------------------------- #
# The lifecycle: what each transition does to the balance
# --------------------------------------------------------------------------- #


def test_apply_then_approve_debits_exactly_the_frozen_duration(client, leave_org):
    tenant = leave_org["tenant"]
    end = BASE_MONDAY + timedelta(days=2)  # Mon-Wed, three working days

    created = _apply(client, tenant, leave_org, start=BASE_MONDAY, end=end)
    assert created.status_code == 201, created.text
    application = created.json()
    assert application["duration_milli_days"] == 3_000
    assert application["status"] == LeaveStatus.PENDING.value

    with SessionLocal() as db:
        # Pending does not debit — it reserves. The balance itself has not moved.
        assert _balance(db, leave_org).used_milli_days == 0

    decided = _decide(client, tenant, application["id"], True, "ok")
    assert decided.status_code == 200, decided.text
    assert decided.json()["status"] == LeaveStatus.APPROVED.value

    with SessionLocal() as db:
        balance = _balance(db, leave_org)
        assert balance.used_milli_days == 3_000
        assert balance.balance_milli_days == 17_000
        row = db.get(LeaveApplication, uuid.UUID(application["id"]))
        assert row.debited_at is not None, "the idempotency latch must be stamped"


def test_pending_leave_is_not_applicable_for_twice(client, leave_org):
    """An employee with two days left and two days pending has nothing left.

    ``LeaveStatus.PENDING.holds_balance`` is true precisely so that the second
    application cannot be filed against balance the first one has already
    claimed but not yet debited.
    """
    tenant = leave_org["tenant"]
    with SessionLocal() as db:
        balance = _balance(db, leave_org)
        balance.accrued_milli_days = 2_000
        db.commit()

    first = _apply(
        client, tenant, leave_org, start=BASE_MONDAY, end=BASE_MONDAY + timedelta(days=1)
    )
    assert first.status_code == 201
    second = _apply(
        client,
        tenant,
        leave_org,
        start=BASE_MONDAY + timedelta(days=7),
        end=BASE_MONDAY + timedelta(days=8),
    )
    assert second.status_code == 422
    assert second.json()["detail"]["reason"] == "insufficient_balance"


def test_rejection_never_touches_the_balance(client, leave_org):
    """Rejected leave was never debited, which is why it is not "cancelled"."""
    tenant = leave_org["tenant"]
    created = _apply(
        client, tenant, leave_org, start=BASE_MONDAY, end=BASE_MONDAY + timedelta(days=1)
    )
    application = created.json()

    rejected = _decide(client, tenant, application["id"], False, "cover is thin that week")
    assert rejected.status_code == 200
    assert rejected.json()["status"] == LeaveStatus.REJECTED.value

    with SessionLocal() as db:
        balance = _balance(db, leave_org)
        assert balance.used_milli_days == 0
        assert db.get(LeaveApplication, uuid.UUID(application["id"])).debited_at is None


def test_cancelling_approved_leave_credits_the_balance_back(client, leave_org):
    tenant = leave_org["tenant"]
    created = _apply(
        client, tenant, leave_org, start=BASE_MONDAY, end=BASE_MONDAY + timedelta(days=2)
    )
    application = created.json()
    _decide(client, tenant, application["id"], True)

    cancelled = client.post(
        f"/api/v1/leave/applications/{application['id']}/cancel",
        json={"reason": "trip fell through"},
        headers=tenant.headers(tenant.employee_token),
    )
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["status"] == LeaveStatus.CANCELLED.value

    with SessionLocal() as db:
        balance = _balance(db, leave_org)
        assert balance.used_milli_days == 0
        assert balance.balance_milli_days == 20_000
        row = db.get(LeaveApplication, uuid.UUID(application["id"]))
        assert row.debited_at is None, "the latch must reopen so a re-apply can debit"


def test_a_decided_application_cannot_be_decided_again(client, leave_org):
    """The second click of a double-clicked Approve must change nothing."""
    tenant = leave_org["tenant"]
    created = _apply(
        client, tenant, leave_org, start=BASE_MONDAY, end=BASE_MONDAY + timedelta(days=1)
    )
    application = created.json()
    assert _decide(client, tenant, application["id"], True).status_code == 200
    again = _decide(client, tenant, application["id"], True)
    assert again.status_code == 409

    with SessionLocal() as db:
        assert _balance(db, leave_org).used_milli_days == 2_000


# --------------------------------------------------------------------------- #
# §3.2's validation rules
# --------------------------------------------------------------------------- #


def test_overlapping_an_existing_application_is_refused(client, leave_org):
    """A validation error, not a silent second booking of the same days."""
    tenant = leave_org["tenant"]
    first = _apply(
        client, tenant, leave_org, start=BASE_MONDAY, end=BASE_MONDAY + timedelta(days=3)
    )
    assert first.status_code == 201
    _decide(client, tenant, first.json()["id"], True)

    clash = _apply(
        client,
        tenant,
        leave_org,
        start=BASE_MONDAY + timedelta(days=2),
        end=BASE_MONDAY + timedelta(days=4),
    )
    assert clash.status_code == 409
    assert clash.json()["detail"]["reason"] == "overlapping_leave"


def test_overlapping_a_present_attendance_day_is_refused(client, leave_org):
    """§3.2: leave over a day somebody is recorded present is an error.

    Allowing it would let leave silently overwrite an attendance record — an
    unattributable edit to the row payroll reads.
    """
    tenant = leave_org["tenant"]
    with SessionLocal() as db:
        db.add(
            AttendanceRecord(
                org_id=tenant.id,
                user_id=leave_org["staff_id"],
                date=BASE_MONDAY + timedelta(days=1),
                status=AttendanceStatus.PRESENT.value,
                check_in_at=datetime.now(timezone.utc),
            )
        )
        db.commit()

    refused = _apply(
        client, tenant, leave_org, start=BASE_MONDAY, end=BASE_MONDAY + timedelta(days=2)
    )
    assert refused.status_code == 409
    assert refused.json()["detail"]["reason"] == "attendance_present"


def test_weekly_offs_and_holidays_do_not_cost_balance(client, leave_org):
    """Friday to Monday over a weekend is two days of leave, not four."""
    tenant = leave_org["tenant"]
    friday = BASE_MONDAY + timedelta(days=4)
    with SessionLocal() as db:
        db.add(
            Holiday(
                org_id=tenant.id,
                holiday_date=BASE_MONDAY + timedelta(days=7),  # the Monday
                name="Founders Day",
            )
        )
        db.commit()

    created = _apply(
        client, tenant, leave_org, start=friday, end=BASE_MONDAY + timedelta(days=8)
    )
    assert created.status_code == 201, created.text
    # Fri + (Sat, Sun off) + (Mon holiday) + Tue = two working days.
    assert created.json()["duration_milli_days"] == 2_000


def test_an_optional_holiday_only_skips_for_whoever_opted_in(client, leave_org):
    """The flag is decorative unless the opt-in decides per employee."""
    tenant = leave_org["tenant"]
    wednesday = BASE_MONDAY + timedelta(days=2)
    with SessionLocal() as db:
        db.add(
            Holiday(
                org_id=tenant.id,
                holiday_date=wednesday,
                name="Optional Festival",
                is_optional=True,
            )
        )
        db.commit()

    # Nobody has opted in, so it is an ordinary working day and costs balance.
    created = _apply(
        client, tenant, leave_org, start=BASE_MONDAY, end=BASE_MONDAY + timedelta(days=2)
    )
    assert created.json()["duration_milli_days"] == 3_000

    with SessionLocal() as db:
        holiday = db.scalars(select(Holiday)).one()
        db.delete(db.get(LeaveApplication, uuid.UUID(created.json()["id"])))
        db.commit()
        holiday_id = holiday.id

    opted = client.put(
        "/api/v1/leave/holidays/opt-ins",
        json={"holiday_ids": [str(holiday_id)]},
        headers=tenant.headers(tenant.employee_token),
    )
    assert opted.status_code == 200, opted.text

    again = _apply(
        client, tenant, leave_org, start=BASE_MONDAY, end=BASE_MONDAY + timedelta(days=2)
    )
    assert again.json()["duration_milli_days"] == 2_000


def test_a_range_of_only_holidays_is_refused(client, leave_org):
    tenant = leave_org["tenant"]
    saturday = BASE_MONDAY + timedelta(days=5)
    refused = _apply(
        client, tenant, leave_org, start=saturday, end=saturday + timedelta(days=1)
    )
    assert refused.status_code == 422
    assert refused.json()["detail"]["reason"] == "no_working_days"


# --------------------------------------------------------------------------- #
# D-013: the frozen duration
# --------------------------------------------------------------------------- #


def test_duration_stays_frozen_when_the_holiday_calendar_moves(client, leave_org):
    """The one that keeps the balance from drifting.

    Apply for a five-day week, add a holiday in the middle of it, then approve
    and cancel. The debit and the credit-back are both the number that was
    frozen at apply time; recomputing either would leave the balance short by
    exactly the day somebody added to the calendar.
    """
    tenant = leave_org["tenant"]
    friday = BASE_MONDAY + timedelta(days=4)
    created = _apply(client, tenant, leave_org, start=BASE_MONDAY, end=friday)
    application = created.json()
    assert application["duration_milli_days"] == 5_000

    added = client.post(
        "/api/v1/leave/holidays",
        json={
            "holiday_date": (BASE_MONDAY + timedelta(days=2)).isoformat(),
            "name": "Newly declared holiday",
        },
        headers=tenant.headers(),
    )
    assert added.status_code == 201, added.text

    _decide(client, tenant, application["id"], True)
    with SessionLocal() as db:
        assert _balance(db, leave_org).used_milli_days == 5_000, (
            "approval recomputed the duration against the edited calendar"
        )

    client.post(
        f"/api/v1/leave/applications/{application['id']}/cancel",
        json={"reason": "withdrawn"},
        headers=tenant.headers(tenant.employee_token),
    )
    with SessionLocal() as db:
        balance = _balance(db, leave_org)
        assert balance.used_milli_days == 0, (
            "cancellation credited back a different number than it debited"
        )
        assert balance.balance_milli_days == 20_000


# --------------------------------------------------------------------------- #
# The attendance write-back (§3.2, D-007, D-020)
# --------------------------------------------------------------------------- #


def test_approval_writes_on_leave_and_cancellation_takes_it_back(client, leave_org):
    tenant = leave_org["tenant"]
    created = _apply(
        client, tenant, leave_org, start=BASE_MONDAY, end=BASE_MONDAY + timedelta(days=1)
    )
    application = created.json()
    _decide(client, tenant, application["id"], True)

    with SessionLocal() as db:
        rows = db.scalars(
            select(AttendanceRecord).where(
                AttendanceRecord.user_id == leave_org["staff_id"]
            )
        ).all()
        assert len(rows) == 2
        assert {row.status for row in rows} == {AttendanceStatus.ON_LEAVE.value}

    client.post(
        f"/api/v1/leave/applications/{application['id']}/cancel",
        json={},
        headers=tenant.headers(tenant.employee_token),
    )
    with SessionLocal() as db:
        remaining = db.scalars(
            select(AttendanceRecord).where(
                AttendanceRecord.user_id == leave_org["staff_id"]
            )
        ).all()
        assert remaining == [], (
            "rows the approval invented must go away again, not linger as on_leave"
        )


def test_a_regularized_attendance_row_is_never_clobbered(client, leave_org):
    """D-007/D-020: a human decision outranks a derived one.

    An approved regularization says a person was at work that day. Leave
    approval overwriting it would erase the correction the regularization module
    exists to record.
    """
    tenant = leave_org["tenant"]
    with SessionLocal() as db:
        db.add(
            AttendanceRecord(
                org_id=tenant.id,
                user_id=leave_org["staff_id"],
                date=BASE_MONDAY,
                status=AttendanceStatus.HALF_DAY.value,
                check_in_source=PunchSource.REGULARIZED.value,
                check_in_at=datetime.now(timezone.utc),
            )
        )
        db.commit()

    created = _apply(
        client, tenant, leave_org, start=BASE_MONDAY, end=BASE_MONDAY + timedelta(days=1)
    )
    assert created.status_code == 201
    _decide(client, tenant, created.json()["id"], True)

    with SessionLocal() as db:
        regularized = db.scalars(
            select(AttendanceRecord).where(AttendanceRecord.date == BASE_MONDAY)
        ).one()
        assert regularized.status == AttendanceStatus.HALF_DAY.value
        other = db.scalars(
            select(AttendanceRecord).where(
                AttendanceRecord.date == BASE_MONDAY + timedelta(days=1)
            )
        ).one()
        assert other.status == AttendanceStatus.ON_LEAVE.value


def test_a_row_the_approval_creates_never_defaults_to_present(client, leave_org):
    """D-020, as a test rather than a comment. Comments do not fail builds."""
    tenant = leave_org["tenant"]
    created = _apply(client, tenant, leave_org, start=BASE_MONDAY, end=BASE_MONDAY)
    _decide(client, tenant, created.json()["id"], True)
    with SessionLocal() as db:
        row = db.scalars(select(AttendanceRecord)).one()
        assert row.status != AttendanceStatus.PRESENT.value
        assert row.status == AttendanceStatus.ON_LEAVE.value


# --------------------------------------------------------------------------- #
# The debit under concurrency — read both of these together
# --------------------------------------------------------------------------- #


def test_the_debit_takes_a_row_lock_on_postgres(leave_org):
    """The only test here that can actually catch a dropped lock.

    SQLite renders no ``FOR UPDATE``, so nothing about the lock is observable at
    runtime in this suite. Compiling the statement for the Postgres dialect is
    the substitute, and it checks two separate things:

    * the ``FOR UPDATE`` is present at all, and
    * the query is not an outer join. ``LeaveBalance.leave_type`` is
      ``lazy="joined"``, and Postgres refuses ``FOR UPDATE`` on the nullable
      side of an outer join — so a future edit that drops the ``noload`` turns
      the lock into a runtime error on production and nothing at all here.
    """
    statement = svc.lock_statement(
        user_id=leave_org["staff_id"],
        leave_type_id=leave_org["leave_type_id"],
        year=leave_org["year"],
    )
    sql = str(statement.compile(dialect=postgresql.dialect())).upper()
    assert "FOR UPDATE" in sql, "the balance debit stopped locking its row"
    assert "OUTER JOIN" not in sql, (
        "a joined eager load crept back in; Postgres will refuse FOR UPDATE on it"
    )


def test_the_balance_row_is_upserted_before_it_is_locked(leave_org):
    """``FOR UPDATE`` on a row that does not exist locks nothing.

    Two concurrent approvals of somebody's first leave of the year would both
    find no row and both insert one, so the row has to be made to exist by the
    database rather than by a service that read first. Asserted on the SQL
    actually sent, because a read-then-insert would look identical from the
    outside until the day it does not.
    """
    statements: list[str] = []

    def _record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", _record)
    try:
        with SessionLocal() as db:
            svc.ensure_balance_row(
                db,
                org_id=leave_org["tenant"].id,
                user_id=leave_org["staff_id"],
                leave_type_id=leave_org["leave_type_id"],
                year=leave_org["year"],
            )
            db.commit()
    finally:
        event.remove(engine, "before_cursor_execute", _record)

    upserts = [s for s in statements if "leave_balances" in s and "INSERT" in s.upper()]
    assert upserts, "ensure_balance_row issued no insert at all"
    assert any(
        "ON CONFLICT" in s.upper() and "DO NOTHING" in s.upper() for s in upserts
    ), "the balance row is being created with a plain INSERT, which races"


def test_concurrent_approvals_never_double_spend(leave_org):
    """Two approvals racing on one balance row must leave it consistent.

    **This test cannot fail for the reason it exists, on this database.** SQLite
    takes a whole-database write lock, so the two threads below are serialised
    by the engine no matter what the service does — a read-release-update
    implementation would pass here just as happily as the locked one. It is kept
    because it is the shape of the test that *does* mean something once the
    suite runs against Postgres, and because it still catches the non-race bugs:
    a debit applied twice, a latch that does not latch, a balance that goes
    negative.

    The real guard on SQLite is
    ``test_the_debit_takes_a_row_lock_on_postgres``. Do not read a green tick
    here as evidence the lock works.
    """
    tenant = leave_org["tenant"]
    with SessionLocal() as db:
        applications = []
        for offset in (0, 7):
            application = LeaveApplication(
                org_id=tenant.id,
                user_id=leave_org["staff_id"],
                leave_type_id=leave_org["leave_type_id"],
                start_date=BASE_MONDAY + timedelta(days=offset),
                end_date=BASE_MONDAY + timedelta(days=offset + 1),
                duration_milli_days=2_000,
                status=LeaveStatus.PENDING.value,
                applied_at=datetime.now(timezone.utc),
            )
            db.add(application)
            applications.append(application)
        db.commit()
        ids = [application.id for application in applications]

    barrier = threading.Barrier(len(ids))
    errors: list[BaseException] = []

    def _approve(application_id):
        try:
            with SessionLocal() as db:
                application = db.get(LeaveApplication, application_id)
                reviewer = db.get(User, leave_org["owner_id"])
                # Both threads are inside their transaction before either
                # touches the balance, which is the interleaving a
                # read-release-update implementation loses money on.
                barrier.wait(timeout=10)
                svc.decide(
                    db,
                    application=application,
                    reviewer=reviewer,
                    approve=True,
                    note=None,
                )
                db.commit()
        except BaseException as exc:  # noqa: BLE001 - re-raised in the assertion
            errors.append(exc)

    threads = [threading.Thread(target=_approve, args=(i,)) for i in ids]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert not errors, f"an approval failed outright: {errors!r}"
    with SessionLocal() as db:
        balance = _balance(db, leave_org)
        assert balance.used_milli_days == 4_000, (
            "one of the two debits was lost — the classic read-modify-write race"
        )
        assert balance.balance_milli_days == 16_000
        assert all(
            db.get(LeaveApplication, i).debited_at is not None for i in ids
        )


# --------------------------------------------------------------------------- #
# Accrual
# --------------------------------------------------------------------------- #


def test_accrual_carries_the_rounding_remainder_forward():
    """25 days a year is 2.083 a month, and the third of a milli-day must survive.

    Flooring each month independently pays out less than the annual entitlement
    — every month, forever. Flooring the running total pays exactly the annual
    figure, which is the number in the employee's contract.
    """
    year_start, year_end = date(2029, 1, 1), date(2029, 12, 31)
    annual = 25_000

    credits = []
    previous = 0
    for month in range(1, 13):
        as_of = date(2029, month, 1) if month > 1 else year_start
        as_of = date(2029 + (month // 12), (month % 12) + 1, 1)
        target = svc.accrual_target_milli_days(annual, year_start, year_end, as_of, None)
        credits.append(target - previous)
        previous = target

    assert sum(credits) == annual, "the year did not add up to the entitlement"
    assert previous == annual

    naive = sum(
        annual * ((date(2029, m + 1, 1) if m < 12 else date(2030, 1, 1))
                  - date(2029, m, 1)).days // 365
        for m in range(1, 13)
    )
    assert naive < annual, "the comparison is meaningless if truncating loses nothing"


def test_accrual_is_idempotent_and_catches_up_a_missed_month(leave_org):
    """A cumulative target, so an extra run credits nothing and a gap is repaired."""
    tenant = leave_org["tenant"]
    with SessionLocal() as db:
        balance = _balance(db, leave_org)
        balance.accrued_milli_days = 0
        leave_type = db.get(LeaveType, leave_org["leave_type_id"])
        leave_type.accrual_rate_milli_days = 2_083  # 25 days a year
        db.commit()

    year_start = date(leave_org["year"], 1, 1)

    def _run(as_of: date) -> int:
        with SessionLocal() as db:
            org = db.get(Organization, tenant.id)
            svc.accrue_org(db, org, as_of)
        with SessionLocal() as db:
            return _balance(db, leave_org).accrued_milli_days

    after_march = _run(date(year_start.year, 4, 1))
    assert after_march > 0
    assert _run(date(year_start.year, 4, 1)) == after_march, "a second run credited again"

    # Three months skipped entirely; the next run must land on the right total,
    # not on one month's worth.
    after_july = _run(date(year_start.year, 8, 1))
    expected = svc.accrual_target_milli_days(
        2_083 * 12,
        year_start,
        date(year_start.year, 12, 31),
        date(year_start.year, 8, 1),
        None,
    )
    assert after_july == expected


def test_accrual_skips_types_that_do_not_accrue(leave_org):
    """``AccrualType.NONE`` is not "no leave" — it is granted as a lump.

    Crediting it zero would look, to somebody staring at a stuck balance, exactly
    like a broken accrual job.
    """
    tenant = leave_org["tenant"]
    with SessionLocal() as db:
        lump = _make_type(
            db,
            tenant.id,
            name="Maternity",
            code="ML",
            accrual_type="none",
            accrual_rate_milli_days=0,
        )
        db.commit()
        lump_id = lump.id

    with SessionLocal() as db:
        svc.accrue_org(db, db.get(Organization, tenant.id), date(leave_org["year"], 6, 1))
    with SessionLocal() as db:
        assert (
            db.scalars(
                select(LeaveBalance).where(LeaveBalance.leave_type_id == lump_id)
            ).all()
            == []
        )


# --------------------------------------------------------------------------- #
# Comp-off — D-022's single source of truth
# --------------------------------------------------------------------------- #


@pytest.fixture
def comp_off(leave_org):
    with SessionLocal() as db:
        leave_type = _make_type(
            db,
            leave_org["tenant"].id,
            name="Comp Off",
            code="CO",
            accrual_type="none",
            accrual_rate_milli_days=0,
            is_comp_off=True,
        )
        db.commit()
        return {**leave_org, "comp_off_type_id": leave_type.id}


def _grant(client, tenant, comp_off, *, earned, expires) -> dict:
    return client.post(
        "/api/v1/leave/comp-offs",
        json={
            "user_id": str(comp_off["staff_id"]),
            "earned_date": earned.isoformat(),
            "expires_at": expires.isoformat(),
            "credit_milli_days": 1_000,
            "reason": "worked the release weekend",
        },
        headers=tenant.headers(),
    ).json()


def test_granting_a_comp_off_writes_through_to_the_balance(client, comp_off):
    """D-022: the ledger and the projection move in the same transaction."""
    tenant = comp_off["tenant"]
    _grant(client, tenant, comp_off, earned=date(2029, 1, 6), expires=date(2029, 6, 30))

    with SessionLocal() as db:
        balance = db.scalars(
            select(LeaveBalance).where(
                LeaveBalance.leave_type_id == comp_off["comp_off_type_id"]
            )
        ).one()
        assert balance.year == svc.COMP_OFF_BALANCE_YEAR
        assert balance.accrued_milli_days == 1_000
        assert svc.reconcile_comp_off(db, tenant.id) == []


def test_comp_off_expiry_removes_the_credit_and_the_projection(client, comp_off):
    """A dead credit must leave no spendable balance behind it."""
    tenant = comp_off["tenant"]
    _grant(client, tenant, comp_off, earned=date(2029, 1, 6), expires=date(2029, 1, 20))
    _grant(client, tenant, comp_off, earned=date(2029, 2, 3), expires=date(2029, 12, 31))

    result = svc.expire_comp_offs(today=date(2029, 6, 1))
    assert result["expired"] == 1
    assert result["expired_milli_days"] == 1_000

    with SessionLocal() as db:
        balance = db.scalars(
            select(LeaveBalance).where(
                LeaveBalance.leave_type_id == comp_off["comp_off_type_id"]
            )
        ).one()
        assert balance.accrued_milli_days == 1_000
        assert svc.reconcile_comp_off(db, tenant.id) == [], (
            "the ledger and its projection have drifted"
        )
        expired = db.scalars(
            select(CompOffCredit).where(CompOffCredit.expired_at.is_not(None))
        ).all()
        assert len(expired) == 1


def test_a_spent_comp_off_is_not_expired_as_well(client, comp_off):
    """Expiring a credit that was already spent takes the day away twice."""
    tenant = comp_off["tenant"]
    _grant(client, tenant, comp_off, earned=date(2029, 1, 6), expires=date(2029, 3, 30))

    body = {
        "leave_type_id": str(comp_off["comp_off_type_id"]),
        "start_date": _monday(2029, 3).isoformat(),
        "end_date": _monday(2029, 3).isoformat(),
    }
    created = client.post(
        "/api/v1/leave/applications", json=body,
        headers=tenant.headers(tenant.employee_token),
    )
    assert created.status_code == 201, created.text
    assert _decide(client, tenant, created.json()["id"], True).status_code == 200

    svc.expire_comp_offs(today=date(2029, 12, 1))
    with SessionLocal() as db:
        credit = db.scalars(select(CompOffCredit)).one()
        assert credit.expired_at is None, "a spent credit was expired on top of being spent"
        balance = db.scalars(
            select(LeaveBalance).where(
                LeaveBalance.leave_type_id == comp_off["comp_off_type_id"]
            )
        ).one()
        assert balance.accrued_milli_days == 1_000
        assert balance.used_milli_days == 1_000
        assert balance.balance_milli_days == 0
        assert svc.reconcile_comp_off(db, tenant.id) == []


def test_a_half_day_splits_a_full_day_credit_instead_of_swallowing_it(client, comp_off):
    """Half a day taken against a whole-day credit must leave half a day behind.

    Marking the whole credit used would debit 500 while retiring 1000 from the
    ledger: the balance row would still read half a day that the ledger had
    nothing left to pay for. Two readings of one entitlement disagreeing is the
    exact failure D-022 exists to prevent.
    """
    tenant = comp_off["tenant"]
    _grant(client, tenant, comp_off, earned=date(2029, 1, 6), expires=date(2029, 6, 30))

    monday = _monday(2029, 3)
    created = client.post(
        "/api/v1/leave/applications",
        json={
            "leave_type_id": str(comp_off["comp_off_type_id"]),
            "start_date": monday.isoformat(),
            "end_date": monday.isoformat(),
            "is_half_day": True,
            "half_day_session": "first_half",
        },
        headers=tenant.headers(tenant.employee_token),
    )
    assert created.status_code == 201, created.text
    assert created.json()["duration_milli_days"] == 500
    assert _decide(client, tenant, created.json()["id"], True).status_code == 200

    with SessionLocal() as db:
        credits = db.scalars(select(CompOffCredit)).all()
        assert len(credits) == 2, "the credit was not split"
        spent = [c for c in credits if c.used_in_application_id is not None]
        left = [c for c in credits if c.used_in_application_id is None]
        assert spent[0].credit_milli_days == 500
        assert left[0].credit_milli_days == 500
        assert svc.usable_comp_off_milli_days(db, comp_off["staff_id"], monday) == 500
        balance = db.scalars(
            select(LeaveBalance).where(
                LeaveBalance.leave_type_id == comp_off["comp_off_type_id"]
            )
        ).one()
        assert balance.balance_milli_days == 500
        assert svc.reconcile_comp_off(db, tenant.id) == []


def test_cancelling_leave_does_not_resurrect_a_credit_that_died_meanwhile(client, comp_off):
    """Releasing a dead credit must expire it in the same breath.

    Otherwise withdrawing leave taken against a credit that has since passed its
    ``expires_at`` hands the employee a free day: the ``used`` debit comes back
    while the ledger has nothing left that could have paid for it.
    """
    tenant = comp_off["tenant"]
    earned, expires = date(2024, 1, 8), date(2024, 6, 30)
    _grant(client, tenant, comp_off, earned=earned, expires=expires)

    taken = _monday(2024, 3)
    created = client.post(
        "/api/v1/leave/applications",
        json={
            "leave_type_id": str(comp_off["comp_off_type_id"]),
            "start_date": taken.isoformat(),
            "end_date": taken.isoformat(),
        },
        headers=tenant.headers(tenant.employee_token),
    )
    assert created.status_code == 201, created.text
    assert _decide(client, tenant, created.json()["id"], True).status_code == 200

    # An administrator, because the leave is long past — see svc.cancel.
    cancelled = client.post(
        f"/api/v1/leave/applications/{created.json()['id']}/cancel",
        json={"reason": "filed against the wrong person"},
        headers=tenant.headers(),
    )
    assert cancelled.status_code == 200, cancelled.text

    with SessionLocal() as db:
        credit = db.scalars(select(CompOffCredit)).one()
        assert credit.used_in_application_id is None
        assert credit.expired_at is not None, "a dead credit was handed back as live"
        balance = db.scalars(
            select(LeaveBalance).where(
                LeaveBalance.leave_type_id == comp_off["comp_off_type_id"]
            )
        ).one()
        assert balance.balance_milli_days == 0
        assert svc.reconcile_comp_off(db, tenant.id) == []


def test_the_comp_off_balance_cannot_be_adjusted_by_hand(client, comp_off):
    """D-022 has one writer for this number, and it is the credit ledger."""
    tenant = comp_off["tenant"]
    refused = client.post(
        "/api/v1/leave/balances/adjust",
        json={
            "user_id": str(comp_off["staff_id"]),
            "leave_type_id": str(comp_off["comp_off_type_id"]),
            "year": 2029,
            "delta_milli_days": 5_000,
            "reason": "being generous",
        },
        headers=tenant.headers(),
    )
    assert refused.status_code == 422
    assert refused.json()["detail"]["reason"] == "comp_off_not_adjustable"


def test_a_second_comp_off_type_is_refused(client, comp_off):
    """Two comp-off types would give one ledger two projections to keep in step."""
    tenant = comp_off["tenant"]
    refused = client.post(
        "/api/v1/leave/types",
        json={
            "name": "Comp Off (legacy)",
            "accrual_type": "none",
            "accrual_rate_milli_days": 0,
            "is_comp_off": True,
        },
        headers=tenant.headers(),
    )
    assert refused.status_code == 409
    assert refused.json()["detail"]["reason"] == "comp_off_exists"


def test_a_comp_off_type_may_not_also_accrue_monthly(client, leave_org):
    """The second writer, arriving through the type editor instead."""
    tenant = leave_org["tenant"]
    refused = client.post(
        "/api/v1/leave/types",
        json={
            "name": "Comp Off",
            "accrual_type": "monthly",
            "accrual_rate_milli_days": 1_000,
            "is_comp_off": True,
        },
        headers=tenant.headers(),
    )
    assert refused.status_code == 422
    assert refused.json()["detail"]["reason"] == "comp_off_accrual"


# --------------------------------------------------------------------------- #
# Settings (D-009) and audit (D-018 / D-021)
# --------------------------------------------------------------------------- #


def test_reading_settings_never_creates_the_row(client, tenants):
    """D-009: a missing row is legal and means the defaults.

    A lazy insert on a GET turns a dashboard load into a write and races itself
    the moment two of them land together.
    """
    acme, _ = tenants
    response = client.get("/api/v1/leave/settings", headers=acme.headers())
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["leave_year_start_month"] == 1
    assert body["is_configured"] is False
    assert body["optional_holidays_are_unlimited"] is True

    with SessionLocal() as db:
        assert db.scalars(select(LeaveSettings)).all() == [], (
            "a read inserted a settings row"
        )


def test_an_april_policy_year_puts_march_in_the_previous_year(client, tenants):
    """Reading ``year`` as the year the policy year ends in is a whole year of
    somebody's balance."""
    acme, _ = tenants
    saved = client.put(
        "/api/v1/leave/settings",
        json={"leave_year_start_month": 4, "optional_holiday_quota": 2},
        headers=acme.headers(),
    )
    assert saved.status_code == 200
    assert saved.json()["is_configured"] is True
    assert svc.policy_year_for(date(2027, 3, 31), 4) == 2026
    assert svc.policy_year_for(date(2027, 4, 1), 4) == 2027


def test_adjusting_a_balance_writes_an_audit_row(client, leave_org):
    """D-018/D-021: there is no ``updated_at``, so AuditLog is the record.

    Without it, the only trace that HR moved somebody's entitlement is the new
    number itself, and the size and reason of the correction are gone.
    """
    tenant = leave_org["tenant"]
    response = client.post(
        "/api/v1/leave/balances/adjust",
        json={
            "user_id": str(leave_org["staff_id"]),
            "leave_type_id": str(leave_org["leave_type_id"]),
            "year": leave_org["year"],
            "delta_milli_days": -1_500,
            "reason": "leave taken before the system existed",
        },
        headers=tenant.headers(),
    )
    assert response.status_code == 200, response.text
    assert response.json()["adjusted_milli_days"] == -1_500

    with SessionLocal() as db:
        entry = db.scalars(
            select(AuditLog).where(AuditLog.action == "leave_balance_adjusted")
        ).one()
        assert entry.detail["delta_milli_days"] == -1_500
        assert entry.detail["reason"] == "leave taken before the system existed"
        balance = _balance(db, leave_org)
        assert balance.adjusted_by_user_id == leave_org["owner_id"]
        assert balance.balance_milli_days == 18_500


def test_the_optional_holiday_quota_is_enforced_per_org(client, leave_org):
    tenant = leave_org["tenant"]
    client.put(
        "/api/v1/leave/settings",
        json={"leave_year_start_month": 1, "optional_holiday_quota": 1},
        headers=tenant.headers(),
    )
    with SessionLocal() as db:
        ids = []
        for day, name in ((date(2029, 4, 3), "One"), (date(2029, 5, 3), "Two")):
            holiday = Holiday(
                org_id=tenant.id, holiday_date=day, name=name, is_optional=True
            )
            db.add(holiday)
            db.flush()
            ids.append(str(holiday.id))
        db.commit()

    refused = client.put(
        "/api/v1/leave/holidays/opt-ins",
        json={"holiday_ids": ids},
        headers=tenant.headers(tenant.employee_token),
    )
    assert refused.status_code == 422
    assert refused.json()["detail"]["reason"] == "quota_exceeded"


# --------------------------------------------------------------------------- #
# Alerts
# --------------------------------------------------------------------------- #


def test_the_decision_alert_cannot_be_switched_off(client, leave_org):
    """§3.2 makes ``leave_decided`` non-optional, so an opt-out must not stop it.

    The employee is told whether they may be away from work. Letting a
    preference silence that is how somebody turns up on a day they were refused,
    or stays home on a day they were not granted.
    """
    tenant = leave_org["tenant"]
    with SessionLocal() as db:
        staff = db.get(User, leave_org["staff_id"])
        # set_preference silently ignores mandatory kinds, so switch it off the
        # blunt way to prove dispatch, not the setter, is what holds the line.
        db.add(
            NotificationPreference(
                org_id=tenant.id,
                user_id=staff.id,
                kind=notif.Kind.LEAVE_DECIDED.value,
                email_enabled=False,
            )
        )
        db.commit()

    created = _apply(client, tenant, leave_org, start=BASE_MONDAY, end=BASE_MONDAY)
    _decide(client, tenant, created.json()["id"], True, "enjoy it")

    with SessionLocal() as db:
        sent = db.scalars(
            select(NotificationLog).where(
                NotificationLog.kind == notif.Kind.LEAVE_DECIDED.value
            )
        ).all()
        assert len(sent) == 1, "the employee was not told about the decision"


def test_the_manager_is_told_when_approved_leave_is_withdrawn(client, leave_org):
    """D-013's addition to §3.2: cover was rearranged around that approval."""
    tenant = leave_org["tenant"]
    created = _apply(client, tenant, leave_org, start=BASE_MONDAY, end=BASE_MONDAY)
    application_id = created.json()["id"]
    _decide(client, tenant, application_id, True)
    client.post(
        f"/api/v1/leave/applications/{application_id}/cancel",
        json={"reason": "no longer needed"},
        headers=tenant.headers(tenant.employee_token),
    )

    with SessionLocal() as db:
        rows = db.scalars(
            select(NotificationLog).where(
                NotificationLog.kind == notif.Kind.LEAVE_CANCELLED.value
            )
        ).all()
        assert len(rows) == 1
        assert rows[0].user_id == leave_org["owner_id"], (
            "the cancellation went to somebody other than the approving manager"
        )


# --------------------------------------------------------------------------- #
# Tenant isolation
# --------------------------------------------------------------------------- #


LEAVE_READS = [
    "/api/v1/leave/settings",
    "/api/v1/leave/types",
    "/api/v1/leave/holidays",
    "/api/v1/leave/balances",
    "/api/v1/leave/applications",
    "/api/v1/leave/comp-offs",
]


@pytest.mark.parametrize("path", LEAVE_READS)
def test_a_token_from_one_tenant_is_refused_by_another(client, tenants, path):
    acme, globex = tenants
    response = client.get(
        path,
        headers={"Authorization": f"Bearer {acme.owner_token}", "X-Org-Slug": globex.slug},
    )
    assert response.status_code in (401, 403), (
        f"{path} accepted a token issued for another company: {response.status_code}"
    )


@pytest.mark.parametrize("path", LEAVE_READS)
def test_the_same_endpoints_answer_their_own_tenant(client, tenants, path):
    """Without this half, an endpoint that 403s everybody would pass the test above."""
    acme, _ = tenants
    response = client.get(path, headers=acme.headers())
    assert response.status_code == 200, f"{path} refused its own tenant: {response.text[:200]}"


def test_one_tenants_leave_type_is_invisible_to_another(client, tenants, leave_org):
    """The org filter, not merely the tenant header, has to be doing the work."""
    acme, globex = tenants
    refused = client.post(
        "/api/v1/leave/applications",
        json={
            "leave_type_id": str(leave_org["leave_type_id"]),
            "start_date": BASE_MONDAY.isoformat(),
            "end_date": BASE_MONDAY.isoformat(),
        },
        headers=globex.headers(globex.employee_token),
    )
    assert refused.status_code == 404


def test_one_tenants_application_cannot_be_decided_by_another(client, tenants, leave_org):
    acme, globex = tenants
    created = _apply(client, acme, leave_org, start=BASE_MONDAY, end=BASE_MONDAY)
    application_id = created.json()["id"]

    refused = client.post(
        f"/api/v1/leave/applications/{application_id}/decision",
        json={"approve": True, "note": None},
        headers=globex.headers(),
    )
    assert refused.status_code == 404

    with SessionLocal() as db:
        assert _balance(db, leave_org).used_milli_days == 0


def test_balances_of_another_tenants_employee_are_not_readable(client, tenants, leave_org):
    _, globex = tenants
    refused = client.get(
        f"/api/v1/leave/balances?user_id={leave_org['staff_id']}",
        headers=globex.headers(),
    )
    assert refused.status_code == 404


def test_an_employee_cannot_read_a_colleagues_balance(client, tenants, leave_org):
    """Scope comes from the hierarchy service; an employee's subtree is themselves."""
    acme, _ = tenants
    refused = client.get(
        f"/api/v1/leave/balances?user_id={leave_org['owner_id']}",
        headers=acme.headers(acme.employee_token),
    )
    assert refused.status_code == 403


def test_an_employee_cannot_decide_their_own_request(client, leave_org):
    """Self-approval defeats the point, and here it spends a balance."""
    tenant = leave_org["tenant"]
    created = _apply(client, tenant, leave_org, start=BASE_MONDAY, end=BASE_MONDAY)
    refused = client.post(
        f"/api/v1/leave/applications/{created.json()['id']}/decision",
        json={"approve": True, "note": None},
        headers=tenant.headers(tenant.employee_token),
    )
    assert refused.status_code == 403
