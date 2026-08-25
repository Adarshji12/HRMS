"""Editing an employee, and the Super Admin's edit / delete / plan controls.

The employee test at the top is a regression test with a specific shape: the
PATCH used to return 500 whenever the change touched a field the audit log then
tried to serialise — which is to say, whenever anybody moved somebody between
teams. It asserts on the response *and* on the audit row, because a fix that
silently stopped recording the change would pass a status-code-only test.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from app.core.plans import PlanId, plan_for
from app.db.session import SessionLocal
from app.models import (
    AuditLog,
    Department,
    Device,
    Organization,
    OrgSettings,
    PlanRecord,
    Screenshot,
    Subscription,
    Team,
    User,
)


# --------------------------------------------------------------------------- #
# Employee edit
# --------------------------------------------------------------------------- #


@pytest.fixture
def org_structure(tenants):
    """A team and a department in the first tenant, to move somebody into."""
    acme, _ = tenants
    with SessionLocal() as db:
        team = Team(id=uuid.uuid4(), org_id=acme.id, name="Support")
        department = Department(id=uuid.uuid4(), org_id=acme.id, name="Operations")
        db.add_all([team, department])
        db.commit()
        return str(team.id), str(department.id)


def test_edit_employee_accepts_uuid_fields(client, tenants, org_structure):
    """The regression. Any *_id in the payload used to 500 at audit-write time."""
    acme, _ = tenants
    team_id, department_id = org_structure

    response = client.patch(
        f"/api/v1/admin/employees/{acme.employee.id}",
        json={
            "full_name": "Renamed Person",
            "team_id": team_id,
            "department_id": department_id,
            "manager_id": str(acme.owner.id),
            "employee_code": "EMP-014",
        },
        headers=acme.headers(),
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["full_name"] == "Renamed Person"
    assert body["team_id"] == team_id
    assert body["manager_id"] == str(acme.owner.id)


def test_edit_employee_records_a_readable_audit_row(client, tenants, org_structure):
    """The UUIDs have to survive into the log, as strings JSON can hold."""
    acme, _ = tenants
    team_id, _ = org_structure

    client.patch(
        f"/api/v1/admin/employees/{acme.employee.id}",
        json={"team_id": team_id},
        headers=acme.headers(),
    )

    with SessionLocal() as db:
        row = db.scalar(select(AuditLog).where(AuditLog.action == "employee.updated"))
        assert row is not None
        # Read back through the JSON column, so a value the encoder could not
        # handle would have failed on the way in.
        assert row.detail == {"team_id": team_id}


def test_edit_employee_deactivation_stops_the_agents(client, tenants):
    acme, _ = tenants
    with SessionLocal() as db:
        db.add(
            Device(
                id=uuid.uuid4(), org_id=acme.id, user_id=acme.employee.id,
                machine_id="machine-1", hostname="laptop", os="windows",
                token_hash="hash-1", is_active=True,
            )
        )
        db.commit()

    response = client.patch(
        f"/api/v1/admin/employees/{acme.employee.id}",
        json={"is_active": False},
        headers=acme.headers(),
    )
    assert response.status_code == 200

    with SessionLocal() as db:
        device = db.scalar(select(Device).where(Device.user_id == acme.employee.id))
        assert device.is_active is False


def test_edit_employee_refuses_a_reporting_loop(client, tenants):
    """Still a 409, not a 500 — the cycle guard runs before the audit write."""
    acme, _ = tenants
    client.patch(
        f"/api/v1/admin/employees/{acme.owner.id}",
        json={"manager_id": str(acme.employee.id)},
        headers=acme.headers(),
    )
    response = client.patch(
        f"/api/v1/admin/employees/{acme.employee.id}",
        json={"manager_id": str(acme.owner.id)},
        headers=acme.headers(),
    )
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "reporting_cycle"


def test_edit_employee_is_tenant_scoped(client, tenants):
    """Acme's owner cannot edit a Globex employee, even with a real user id."""
    acme, globex = tenants
    response = client.patch(
        f"/api/v1/admin/employees/{globex.employee.id}",
        json={"full_name": "Hijacked"},
        headers=acme.headers(),
    )
    assert response.status_code == 404


# --------------------------------------------------------------------------- #
# Super Admin — plans
# --------------------------------------------------------------------------- #


def platform_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_plan_catalogue_seeds_the_builtins(client_raising, platform_token):
    # client_raising: if seeding ever breaks, a traceback is far more use here
    # than a bare 500, and this endpoint is where an empty table shows up first.
    response = client_raising.get(
        "/api/v1/platform/plans", headers=platform_headers(platform_token)
    )
    assert response.status_code == 200
    ids = {p["id"] for p in response.json()}
    assert {"trial", "standard", "enterprise"} <= ids
    assert all(p["is_builtin"] for p in response.json() if p["id"] in ids)


def test_create_edit_and_delete_a_plan(client, platform_token):
    headers = platform_headers(platform_token)
    client.get("/api/v1/platform/plans", headers=headers)  # seed

    created = client.post(
        "/api/v1/platform/plans",
        json={
            "id": "growth",
            "name": "Growth",
            "description": "Negotiated mid-market rate.",
            "base_price_annual": 300_000,
            "per_employee_month": 15_000,
            "min_employees": 10,
            "max_employees": 250,
            "max_screenshot_retention_days": 60,
            "max_activity_retention_days": 180,
            "min_screenshot_interval_s": 120,
            "storage_gb": 100,
            "features": ["Everything in Standard", "  ", "Quarterly review"],
            "is_active": True,
            "is_public": False,
            "sort_order": 25,
        },
        headers=headers,
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["id"] == "growth"
    assert body["is_builtin"] is False
    # Blank feature lines are dropped rather than rendered as empty bullets.
    assert body["features"] == ["Everything in Standard", "Quarterly review"]
    # A brand new plan resolves through the same path every entitlement check
    # uses, or it exists only in the console.
    assert plan_for("growth").max_employees == 250

    edited = client.patch(
        "/api/v1/platform/plans/growth",
        json={"name": "Growth Plus", "per_employee_month": 18_000},
        headers=headers,
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["name"] == "Growth Plus"
    assert plan_for("growth").per_employee_month == 18_000

    deleted = client.delete("/api/v1/platform/plans/growth", headers=headers)
    assert deleted.status_code == 200
    with SessionLocal() as db:
        assert db.get(PlanRecord, "growth") is None


def test_duplicate_plan_id_is_refused(client, platform_token):
    headers = platform_headers(platform_token)
    client.get("/api/v1/platform/plans", headers=headers)
    payload = {"id": "standard", "name": "Another Standard"}
    response = client.post("/api/v1/platform/plans", json=payload, headers=headers)
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "plan_exists"


def test_builtin_plans_cannot_be_deleted(client, platform_token):
    headers = platform_headers(platform_token)
    client.get("/api/v1/platform/plans", headers=headers)
    response = client.delete("/api/v1/platform/plans/standard", headers=headers)
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "plan_builtin"


def test_a_plan_in_use_cannot_be_deleted(client, platform_token, tenants):
    """Deleting it would demote the subscription to trial limits, quietly."""
    acme, _ = tenants
    headers = platform_headers(platform_token)
    client.get("/api/v1/platform/plans", headers=headers)

    client.post(
        "/api/v1/platform/plans",
        json={"id": "bespoke", "name": "Bespoke", "min_employees": 1, "max_employees": 50},
        headers=headers,
    )
    with SessionLocal() as db:
        db.add(Subscription(id=uuid.uuid4(), org_id=acme.id, plan_id="bespoke", seats=5,
                            status="active"))
        db.commit()

    response = client.delete("/api/v1/platform/plans/bespoke", headers=headers)
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "plan_in_use"
    assert response.json()["detail"]["subscriptions"] == 1


def test_the_trial_plan_cannot_be_switched_off(client, platform_token):
    """It is the fallback plan_for() resolves every unknown id to."""
    headers = platform_headers(platform_token)
    client.get("/api/v1/platform/plans", headers=headers)
    response = client.patch(
        f"/api/v1/platform/plans/{PlanId.TRIAL.value}",
        json={"is_active": False},
        headers=headers,
    )
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "trial_required"


def test_an_inverted_headcount_range_is_refused(client, platform_token):
    headers = platform_headers(platform_token)
    client.get("/api/v1/platform/plans", headers=headers)
    client.post(
        "/api/v1/platform/plans",
        json={"id": "wide", "name": "Wide", "min_employees": 5, "max_employees": 500},
        headers=headers,
    )
    # Raising the minimum past the maximum inverts it just as surely as
    # lowering the maximum, and only the merged row shows that.
    response = client.patch(
        "/api/v1/platform/plans/wide", json={"min_employees": 900}, headers=headers
    )
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "employee_range_inverted"


def test_tightening_a_plan_clamps_the_companies_on_it(client, platform_token, tenants):
    """A downgrade has to reduce collection, not just relabel the plan."""
    acme, _ = tenants
    headers = platform_headers(platform_token)
    client.get("/api/v1/platform/plans", headers=headers)

    client.post(
        "/api/v1/platform/plans",
        json={
            "id": "roomy", "name": "Roomy",
            "max_screenshot_retention_days": 365, "max_activity_retention_days": 365,
        },
        headers=headers,
    )
    with SessionLocal() as db:
        db.add(Subscription(id=uuid.uuid4(), org_id=acme.id, plan_id="roomy", seats=5,
                            status="active"))
        org_settings = db.get(OrgSettings, acme.id)
        org_settings.screenshot_retention_days = 300
        db.commit()

    response = client.patch(
        "/api/v1/platform/plans/roomy",
        json={"max_screenshot_retention_days": 30},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    assert response.json()["organizations_clamped"] == 1

    with SessionLocal() as db:
        assert db.get(OrgSettings, acme.id).screenshot_retention_days == 30


def test_subscription_override_accepts_an_operator_plan(client, platform_token, tenants):
    acme, _ = tenants
    headers = platform_headers(platform_token)
    client.get("/api/v1/platform/plans", headers=headers)
    client.post("/api/v1/platform/plans", json={"id": "custom", "name": "Custom"}, headers=headers)

    response = client.patch(
        f"/api/v1/platform/companies/{acme.id}/subscription",
        json={"plan_id": "custom"},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    assert response.json()["plan_id"] == "custom"


def test_subscription_override_rejects_an_unknown_plan(client, platform_token, tenants):
    """Silently resolving to trial limits is the failure this prevents."""
    acme, _ = tenants
    response = client.patch(
        f"/api/v1/platform/companies/{acme.id}/subscription",
        json={"plan_id": "does-not-exist"},
        headers=platform_headers(platform_token),
    )
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "unknown_plan"


def test_plan_writes_need_a_platform_token(client, tenants):
    """A company owner's token is a different credential and is refused here."""
    acme, _ = tenants
    response = client.post(
        "/api/v1/platform/plans",
        json={"id": "sneaky", "name": "Sneaky"},
        headers=acme.headers(),
    )
    assert response.status_code in (401, 403)


# --------------------------------------------------------------------------- #
# Super Admin — companies
# --------------------------------------------------------------------------- #


def test_update_company_details(client, platform_token, tenants):
    acme, _ = tenants
    response = client.patch(
        f"/api/v1/platform/companies/{acme.id}",
        json={
            "name": "Acme Limited",
            "legal_name": "Acme Manufacturing Pvt Ltd",
            "contact_email": "Billing@AcmeCorp.co",
            "gstin": "29ABCDE1234F1Z5",
            "country": "in",
        },
        headers=platform_headers(platform_token),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == "Acme Limited"
    # Normalised on the way in, so a lookup by email is not case-dependent.
    assert body["contact_email"] == "billing@acmecorp.co"

    with SessionLocal() as db:
        org = db.get(Organization, acme.id)
        assert org.country == "IN"
        assert org.legal_name == "Acme Manufacturing Pvt Ltd"


def test_renaming_a_workspace_onto_a_taken_slug_is_refused(client, platform_token, tenants):
    acme, globex = tenants
    response = client.patch(
        f"/api/v1/platform/companies/{acme.id}",
        json={"slug": globex.slug},
        headers=platform_headers(platform_token),
    )
    assert response.status_code == 409


def test_delete_company_requires_the_slug_typed_back(client, platform_token, tenants):
    acme, _ = tenants
    response = client.request(
        "DELETE",
        f"/api/v1/platform/companies/{acme.id}",
        json={"confirm_slug": "not-the-slug"},
        headers=platform_headers(platform_token),
    )
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "confirmation_mismatch"
    with SessionLocal() as db:
        assert db.get(Organization, acme.id) is not None


def test_delete_company_removes_everything_of_theirs(client, platform_token, tenants):
    acme, globex = tenants
    with SessionLocal() as db:
        db.add(
            Device(
                id=uuid.uuid4(), org_id=acme.id, user_id=acme.employee.id,
                machine_id="machine-9", hostname="laptop", os="windows",
                token_hash="hash-9",
            )
        )
        db.add(Subscription(id=uuid.uuid4(), org_id=acme.id, plan_id="standard", seats=5,
                            status="active"))
        db.commit()

    response = client.request(
        "DELETE",
        f"/api/v1/platform/companies/{acme.id}",
        json={"confirm_slug": "acme", "reason": "contract ended"},
        headers=platform_headers(platform_token),
    )
    assert response.status_code == 200, response.text
    assert response.json()["slug"] == "acme"

    with SessionLocal() as db:
        assert db.get(Organization, acme.id) is None
        # The cascade has to reach every tenant table, not just the parent row.
        assert db.scalars(select(User).where(User.org_id == acme.id)).all() == []
        assert db.scalars(select(Device).where(Device.org_id == acme.id)).all() == []
        assert db.scalars(
            select(Subscription).where(Subscription.org_id == acme.id)
        ).all() == []
        assert db.get(OrgSettings, acme.id) is None
        # And must stop at the tenant boundary.
        assert db.get(Organization, globex.id) is not None
        assert db.scalars(select(User).where(User.org_id == globex.id)).all() != []


def test_delete_company_leaves_an_audit_trail_behind(client, platform_token, tenants):
    """The one audit row that must outlive its own organisation."""
    acme, _ = tenants
    client.request(
        "DELETE",
        f"/api/v1/platform/companies/{acme.id}",
        json={"confirm_slug": "acme", "reason": "data removal requested"},
        headers=platform_headers(platform_token),
    )

    with SessionLocal() as db:
        row = db.scalar(
            select(AuditLog).where(AuditLog.action == "platform.company_deleted")
        )
        assert row is not None
        # Scoped to no organisation, or the cascade would have taken it too.
        assert row.org_id is None
        assert row.detail["slug"] == "acme"
        assert row.detail["reason"] == "data removal requested"


def test_delete_company_removes_screenshot_blobs(client, platform_token, tenants):
    """The database cascade knows nothing about the files on disk."""
    from app.services import storage

    acme, _ = tenants
    now = datetime.now(timezone.utc)
    shot_id = uuid.uuid4()
    key = storage.build_key(acme.id, acme.employee.id, now, shot_id)
    storage.backend().put(key, b"not-really-a-jpeg")

    with SessionLocal() as db:
        device = Device(
            id=uuid.uuid4(), org_id=acme.id, user_id=acme.employee.id,
            machine_id="machine-shot", hostname="laptop", os="windows",
            token_hash="hash-shot",
        )
        db.add(device)
        db.flush()
        db.add(
            Screenshot(
                id=shot_id, org_id=acme.id, user_id=acme.employee.id,
                device_id=device.id, client_uid="c-1",
                captured_at=now, received_at=now,
                storage_key=key, file_size=17, width=10, height=10,
            )
        )
        db.commit()

    response = client.request(
        "DELETE",
        f"/api/v1/platform/companies/{acme.id}",
        json={"confirm_slug": "acme"},
        headers=platform_headers(platform_token),
    )
    assert response.status_code == 200, response.text
    assert response.json()["screenshot_files_removed"] >= 1
    with pytest.raises(Exception):
        storage.serve(key)


def test_company_writes_need_a_platform_token(client, tenants):
    acme, globex = tenants
    response = client.patch(
        f"/api/v1/platform/companies/{globex.id}",
        json={"name": "Renamed by a tenant"},
        headers=acme.headers(),
    )
    assert response.status_code in (401, 403)
