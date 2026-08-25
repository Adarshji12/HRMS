"""One company must never reach another's data.

This is the property the whole product rests on: it sells surveillance of
employees to their employer, and the single failure that would end it is
company A seeing company B's staff, hours or screenshots. These were verified
by hand during the production audit; they live here so they stay verified.
"""

from __future__ import annotations

import uuid

import pytest

# Endpoints that read something belonging to the tenant. Each is asked for with
# a token minted for a *different* tenant.
TENANT_READS = [
    "/api/v1/auth/me",
    "/api/v1/admin/employees",
    "/api/v1/admin/settings",
    "/api/v1/org/hierarchy",
    "/api/v1/org/teams",
    "/api/v1/org/departments",
    "/api/v1/admin/rules",
]


@pytest.mark.parametrize("path", TENANT_READS)
def test_token_from_one_tenant_is_refused_by_another(client, tenants, path):
    acme, globex = tenants
    response = client.get(path, headers={
        "Authorization": f"Bearer {acme.owner_token}",
        "X-Org-Slug": globex.slug,
    })
    assert response.status_code in (401, 403), (
        f"{path} accepted a token issued for another company: {response.status_code}"
    )


@pytest.mark.parametrize("path", TENANT_READS)
def test_the_same_endpoints_work_for_their_own_tenant(client, tenants, path):
    """The guard above must refuse the foreign case *and* allow the real one.

    Without this half, an endpoint that returned 403 to everybody would pass
    the isolation test while being completely broken.
    """
    acme, _ = tenants
    response = client.get(path, headers=acme.headers())
    assert response.status_code == 200, f"{path} refused its own tenant: {response.text[:200]}"


@pytest.mark.parametrize("path", TENANT_READS)
def test_anonymous_access_is_refused(client, tenants, path):
    acme, _ = tenants
    response = client.get(path, headers={"X-Org-Slug": acme.slug})
    assert response.status_code in (401, 403)


def test_foreign_employee_is_not_readable_by_id(client, tenants):
    """The tenant header is correct; only the id belongs to someone else."""
    acme, globex = tenants
    response = client.get(
        f"/api/v1/admin/employees/{acme.employee.id}/devices", headers=globex.headers()
    )
    assert response.status_code in (403, 404)


def test_foreign_employee_cannot_be_edited(client, tenants):
    acme, globex = tenants
    response = client.patch(
        f"/api/v1/admin/employees/{acme.employee.id}",
        json={"full_name": "Renamed By Another Company"},
        headers=globex.headers(),
    )
    assert response.status_code in (403, 404)

    # Assert the data, not just the status. A 404 with the write already
    # committed would pass a status-only check.
    check = client.get("/api/v1/admin/employees", headers=acme.headers())
    names = [u["full_name"] for u in check.json()]
    assert "Renamed By Another Company" not in names


def test_foreign_employee_cannot_be_reassigned(client, tenants):
    acme, globex = tenants
    response = client.post(
        "/api/v1/org/assign",
        json={"user_ids": [str(acme.employee.id)], "clear_manager": True},
        headers=globex.headers(),
    )
    assert response.status_code in (403, 404)


def test_platform_token_is_not_a_tenant_user(client, tenants, platform_token):
    acme, _ = tenants
    response = client.get("/api/v1/admin/employees", headers={
        "Authorization": f"Bearer {platform_token}",
        "X-Org-Slug": acme.slug,
    })
    assert response.status_code in (401, 403)


def test_tenant_owner_cannot_reach_the_platform_console(client, tenants):
    acme, _ = tenants
    response = client.get("/api/v1/platform/companies", headers=acme.headers())
    assert response.status_code in (401, 403)


def test_an_employee_may_read_the_tracking_policy(client, tenants):
    """Deliberately readable by everyone.

    On a monitoring product, the policy describing what is collected about you
    is the one thing you are most entitled to see. Asserted so nobody "fixes"
    it into an admin-only endpoint by tidying up dependencies.
    """
    acme, _ = tenants
    response = client.get("/api/v1/admin/settings", headers=acme.headers(acme.employee_token))
    assert response.status_code == 200


def test_an_employee_cannot_change_the_tracking_policy(client, tenants):
    """Role separation inside one tenant, not just between tenants."""
    acme, _ = tenants
    current = client.get("/api/v1/admin/settings", headers=acme.headers()).json()
    response = client.put(
        "/api/v1/admin/settings",
        json={**current, "screenshot_enabled": False},
        headers=acme.headers(acme.employee_token),
    )
    assert response.status_code in (401, 403)

    after = client.get("/api/v1/admin/settings", headers=acme.headers()).json()
    assert after["screenshot_enabled"] == current["screenshot_enabled"]


def test_deactivating_a_user_revokes_their_live_token(client, tenants):
    """A token already in the wild must stop working the moment HR disables
    the account — otherwise 'revoked' means 'revoked in up to twelve hours'."""
    from app.db.session import SessionLocal
    from app.models import User

    acme, _ = tenants
    assert client.get("/api/v1/auth/me", headers=acme.headers()).status_code == 200

    with SessionLocal() as db:
        db.get(User, acme.owner.id).is_active = False
        db.commit()

    assert client.get("/api/v1/auth/me", headers=acme.headers()).status_code in (401, 403)


def test_unknown_id_is_not_distinguishable_from_a_foreign_one(client, tenants):
    """A different status for 'exists elsewhere' than for 'does not exist'
    turns any id endpoint into an oracle for enumerating other companies."""
    _, globex = tenants
    from tests.conftest import Tenant  # noqa: F401  (documents the fixture's shape)

    acme, _ = tenants
    foreign = client.get(
        f"/api/v1/admin/employees/{acme.employee.id}/devices", headers=globex.headers()
    ).status_code
    nonexistent = client.get(
        f"/api/v1/admin/employees/{uuid.uuid4()}/devices", headers=globex.headers()
    ).status_code
    assert foreign == nonexistent
