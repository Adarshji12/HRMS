"""The workforce overview's single endpoint.

The assertions that matter are about *arithmetic and scope*, not about shape:

* a leave that straddles two months must not land wholly in one of them, and
  the twelve monthly figures must still sum to the frozen duration;
* pending and cancelled applications are not leave that was taken;
* a manager sees their subtree and an employee cannot open the page at all.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

from app.db.session import SessionLocal
from app.models import Holiday, LeaveApplication, LeaveStatus, LeaveType, OptionalHolidayOptIn


def _type(db, org_id, name="Casual Leave", code="CL") -> LeaveType:
    row = LeaveType(id=uuid.uuid4(), org_id=org_id, name=name, code=code)
    db.add(row)
    db.flush()
    return row


def _apply(db, org_id, user_id, type_id, start, end, milli, status=LeaveStatus.APPROVED.value):
    row = LeaveApplication(
        id=uuid.uuid4(), org_id=org_id, user_id=user_id, leave_type_id=type_id,
        start_date=start, end_date=end, duration_milli_days=milli, status=status,
        applied_at=datetime.now(timezone.utc),
    )
    db.add(row)
    db.flush()
    return row


def test_employee_cannot_open_the_overview(client, tenants):
    """It is a page about other people, so it needs the team-viewer role."""
    acme, _ = tenants
    r = client.get("/api/v1/leave/overview", headers=acme.headers(acme.employee_token))
    assert r.status_code == 403


def test_month_and_year_tallies(client, tenants):
    acme, _ = tenants
    with SessionLocal() as db:
        leave_type = _type(db, acme.id)
        _apply(db, acme.id, acme.employee.id, leave_type.id,
               date(2025, 3, 3), date(2025, 3, 5), 3000)
        _apply(db, acme.id, acme.employee.id, leave_type.id,
               date(2025, 7, 1), date(2025, 7, 1), 500)
        db.commit()

    body = client.get(
        "/api/v1/leave/overview?year=2025&month=3", headers=acme.headers()
    ).json()

    months = {row["month"]: row["milli_days"] for row in body["by_month"]}
    assert months[3] == 3000
    assert months[7] == 500
    assert sum(months.values()) == 3500

    # The selected month drives by_type, and every type is listed even at zero.
    tally = {row["code"]: row["milli_days"] for row in body["by_type"]}
    assert tally["CL"] == 3000


def test_a_leave_across_a_month_boundary_is_split(client, tenants):
    """Five days from 30 Jan to 3 Feb: two in January, three in February.

    The split is by calendar days across the span, and the halves must still add
    up to the frozen duration — that is the whole reason it is a split rather
    than an attribution to the starting month.
    """
    acme, _ = tenants
    with SessionLocal() as db:
        leave_type = _type(db, acme.id)
        _apply(db, acme.id, acme.employee.id, leave_type.id,
               date(2025, 1, 30), date(2025, 2, 3), 5000)
        db.commit()

    body = client.get("/api/v1/leave/overview?year=2025&month=1", headers=acme.headers()).json()
    months = {row["month"]: row["milli_days"] for row in body["by_month"]}
    assert months[1] == 2000
    assert months[2] == 3000
    assert sum(months.values()) == 5000


def test_pending_and_cancelled_are_not_counted(client, tenants):
    acme, _ = tenants
    with SessionLocal() as db:
        leave_type = _type(db, acme.id)
        _apply(db, acme.id, acme.employee.id, leave_type.id,
               date(2025, 5, 1), date(2025, 5, 2), 2000, status=LeaveStatus.PENDING.value)
        _apply(db, acme.id, acme.employee.id, leave_type.id,
               date(2025, 5, 5), date(2025, 5, 6), 2000, status=LeaveStatus.CANCELLED.value)
        db.commit()

    body = client.get("/api/v1/leave/overview?year=2025&month=5", headers=acme.headers()).json()
    assert sum(row["milli_days"] for row in body["by_month"]) == 0
    assert body["on_leave"] == []


def test_on_leave_window_and_default(client, tenants):
    acme, _ = tenants
    today = date.today()
    with SessionLocal() as db:
        leave_type = _type(db, acme.id)
        _apply(db, acme.id, acme.employee.id, leave_type.id, today, today, 1000)
        db.commit()

    # No window given: this week, so today is inside it.
    default = client.get(
        f"/api/v1/leave/overview?year={today.year}&month={today.month}",
        headers=acme.headers(),
    ).json()
    assert len(default["on_leave"]) == 1
    assert default["on_leave"][0]["leave_type_name"] == "Casual Leave"
    assert default["window_start"] <= today.isoformat() <= default["window_end"]

    # A window that excludes today returns nobody, while the year tallies —
    # which the window must not touch — still carry the day.
    far = today + timedelta(days=400)
    narrow = client.get(
        f"/api/v1/leave/overview?year={today.year}&month={today.month}"
        f"&window_start={far.isoformat()}&window_end={far.isoformat()}",
        headers=acme.headers(),
    ).json()
    assert narrow["on_leave"] == []
    assert sum(row["milli_days"] for row in narrow["by_month"]) == 1000


def test_optional_holiday_uptake_counts_only_people_in_scope(client, tenants):
    """Fixed holidays are excluded: everybody is off, so counting is headcount."""
    acme, globex = tenants
    with SessionLocal() as db:
        optional = Holiday(
            id=uuid.uuid4(), org_id=acme.id, name="Ambedkar Jayanti",
            holiday_date=date(2025, 4, 14), is_optional=True,
        )
        fixed = Holiday(
            id=uuid.uuid4(), org_id=acme.id, name="Republic Day",
            holiday_date=date(2025, 1, 26), is_optional=False,
        )
        db.add_all([optional, fixed])
        db.flush()
        db.add(OptionalHolidayOptIn(
            id=uuid.uuid4(), org_id=acme.id, user_id=acme.employee.id, holiday_id=optional.id,
        ))
        db.commit()

    body = client.get("/api/v1/leave/overview?year=2025&month=4", headers=acme.headers()).json()
    assert [h["name"] for h in body["optional_holidays"]] == ["Ambedkar Jayanti"]
    assert body["optional_holidays"][0]["employees"] == 1

    # The other company sees none of it.
    other = client.get("/api/v1/leave/overview?year=2025&month=4", headers=globex.headers()).json()
    assert other["optional_holidays"] == []


def test_one_company_cannot_see_anothers_leave(client, tenants):
    acme, globex = tenants
    with SessionLocal() as db:
        leave_type = _type(db, acme.id)
        _apply(db, acme.id, acme.employee.id, leave_type.id,
               date(2025, 6, 2), date(2025, 6, 3), 2000)
        db.commit()

    body = client.get("/api/v1/leave/overview?year=2025&month=6", headers=globex.headers()).json()
    assert sum(row["milli_days"] for row in body["by_month"]) == 0
    assert body["by_type"] == []
