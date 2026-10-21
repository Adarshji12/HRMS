"""The Add Employee form — what it sends is what gets stored.

Two things the hire form relies on: every permission it offers is honoured at
creation (several were silently dropped to the model default), and the three
hire-time profile fields round-trip through the core HR endpoints.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from app.db.session import SessionLocal
from app.models import Organization, Subscription, User


def _grant_seats(org_id) -> None:
    """Conftest tenants have no subscription, so creation would 402."""
    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        db.get(Organization, org_id).status = "active"
        db.add(Subscription(
            id=uuid.uuid4(), org_id=org_id, plan_id="standard", billing_cycle="annual",
            seats=50, status="active", period_start=now - timedelta(days=1),
            period_end=now + timedelta(days=365), activated_at=now,
        ))
        db.commit()


def test_create_honours_every_permission_flag(client, tenants):
    tenant, _ = tenants
    flags = {
        "can_manage_people": False,
        "can_issue_letters": False,
        "can_approve_expenses": False,
        "can_reimburse_expenses": False,
        "can_approve_loans": False,
        "can_disburse_loans": False,
        "can_manage_performance": False,
        "can_manage_engagement": False,
        "can_manage_payroll": True,
    }
    _grant_seats(tenant.id)
    response = client.post(
        "/api/v1/admin/employees",
        json={"email": "hire@example.com", "full_name": "New Hire", "role": "manager", **flags},
        headers=tenant.headers(),
    )
    assert response.status_code == 201, response.text

    with SessionLocal() as db:
        user = db.get(User, uuid.UUID(response.json()["id"]))
        for key, expected in flags.items():
            assert getattr(user, key) is expected, key


def test_hire_fields_round_trip(client, tenants):
    tenant, _ = tenants
    uid = tenant.employee.id

    personal = client.patch(
        f"/api/v1/people/{uid}",
        json={"father_name": "R. Sharma"},
        headers=tenant.headers(),
    )
    assert personal.status_code == 200, personal.text
    assert personal.json()["father_name"] == "R. Sharma"

    employment = client.patch(
        f"/api/v1/people/{uid}/employment",
        json={"attendance_type": "hybrid", "grade": "L3"},
        headers=tenant.headers(),
    )
    assert employment.status_code == 200, employment.text
    body = employment.json()
    assert body["attendance_type"] == "hybrid"
    assert body["grade"] == "L3"


def test_attendance_type_is_validated(client, tenants):
    tenant, _ = tenants
    response = client.patch(
        f"/api/v1/people/{tenant.employee.id}/employment",
        json={"attendance_type": "moon"},
        headers=tenant.headers(),
    )
    assert response.status_code == 422


def test_employee_cannot_set_their_own_attendance_type(client, tenants):
    tenant, _ = tenants
    response = client.patch(
        f"/api/v1/people/{tenant.employee.id}/employment",
        json={"attendance_type": "remote"},
        headers=tenant.headers(tenant.employee_token),
    )
    assert response.status_code == 403


def test_the_add_employee_form_end_to_end(client, tenants):
    """Every call the Add Employee form makes, in its order, with its payloads.

    Mirrors ``plan()`` in admin/src/pages/hrms/people/hire/AddEmployee.tsx. A
    change to either side that breaks the wire contract fails here rather than
    as a half-created employee in front of HR.
    """
    tenant, _ = tenants
    _grant_seats(tenant.id)
    h = tenant.headers()

    shift = client.post("/api/v1/attendance/shifts", json={"name": "General"}, headers=h)
    assert shift.status_code == 201, shift.text
    basic = client.post("/api/v1/payroll/components", json={
        "code": "BASIC", "name": "Basic", "calculation": "percent_of_gross",
        "rate_bps": 5000, "is_basic": True, "is_pf_wage": True,
    }, headers=h)
    assert basic.status_code == 201, basic.text
    special = client.post("/api/v1/payroll/components", json={
        "code": "SPL", "name": "Special allowance", "calculation": "balance",
    }, headers=h)
    assert special.status_code == 201, special.text
    asset = client.post("/api/v1/assets", json={"asset_tag": "LAP-001", "category": "laptop"}, headers=h)
    assert asset.status_code == 201, asset.text

    created = client.post("/api/v1/admin/employees", json={
        "full_name": "Asha Kumari Verma", "email": "asha@example.com", "phone": "+91 98765 43210",
        "employee_code": "EMP-002", "joined_on": "2026-11-02", "status": "pending_setup",
        "timezone": "Asia/Kolkata", "role": "employee", "role_id": None, "schedule_id": None,
        "password": "s3cret-pass", "can_punch_anywhere": False, "hidden_pages": [],
    }, headers=h)
    assert created.status_code == 201, created.text
    uid = created.json()["id"]

    steps = [
        ("patch", f"/api/v1/people/{uid}", {
            "date_of_birth": "1996-04-12", "gender": "female", "marital_status": "single",
            "blood_group": "B+", "nationality": "Indian", "father_name": "Ravi Verma",
            "personal_email": "asha.v@gmail.com", "emergency_name": "Ravi Verma",
            "emergency_relationship": "Father", "emergency_phone": "+91 99999 00000",
            "current_address": "12 MG Road", "current_city": "Pune", "current_state": "MH",
            "current_postal_code": "411001", "current_country": "IN",
            "permanent_address": "12 MG Road", "permanent_city": "Pune", "permanent_state": "MH",
            "permanent_postal_code": "411001", "permanent_country": "IN",
            "pan": "ABCDE1234F", "aadhaar": "123412341234", "bank_ifsc": "HDFC0001234",
            "bank_account": "001234567890", "bank_account_name": "Asha Kumari Verma",
        }),
        ("patch", f"/api/v1/people/{uid}/employment", {
            "employment_type": "full_time", "work_location": "Pune", "grade": "L2",
            "attendance_type": "field", "probation_months": 6, "probation_end_on": "2027-05-02",
            "notice_period_days": 30, "bgv_status": "pending",
        }),
        ("post", f"/api/v1/people/{uid}/confirmation", {"status": "probation", "note": "Started at hire."}),
        ("post", "/api/v1/attendance/shift-assignments", {
            "user_id": uid, "shift_id": shift.json()["id"], "effective_from": "2026-11-02",
        }),
        ("post", f"/api/v1/payroll/{uid}", {
            "effective_from": "2026-11-02", "gross_monthly": 5_000_000,
            "components": [
                {"component_id": basic.json()["id"], "amount": None},
                {"component_id": special.json()["id"], "amount": None},
            ],
            "reason": "Joining salary",
        }),
        ("post", "/api/v1/assets/assign", {
            "asset_id": asset.json()["id"], "user_id": uid, "assigned_condition_note": "New",
        }),
    ]
    for method, url, body in steps:
        response = getattr(client, method)(url, json=body, headers=h)
        assert response.status_code in (200, 201), f"{url}: {response.text}"

    profile = client.get(f"/api/v1/people/{uid}", headers=h).json()
    assert profile["attendance_type"] == "field"
    assert profile["father_name"] == "Ravi Verma"
    assert profile["confirmation_status"] == "probation"
    assert profile["pan_masked"].endswith("234F")
