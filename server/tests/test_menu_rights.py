"""Per-menu role rights: Access / Add / Edit / Delete, enforced on writes.

The guard runs before every handler, so these use the Department menu — an
administrator endpoint with no module gate — to see it allow and refuse.
"""

from __future__ import annotations

import uuid

import pytest

from app.core import menus
from app.core.security import create_access_token
from app.db.session import SessionLocal
from app.models import PERMISSION_KEYS, Organization, OrgRole, User

from tests.conftest import _make_user


def _admin_with_role(tenant, menu_rights):
    """A fresh administrator holding a custom admin-level role."""
    with SessionLocal() as db:
        role = OrgRole(
            id=uuid.uuid4(), org_id=tenant.id, name=f"Ops {uuid.uuid4().hex[:6]}",
            base_role="admin", data_scope="company", permissions={},
            menu_rights=menu_rights, is_builtin=False,
        )
        db.add(role)
        db.flush()
        org = db.get(Organization, tenant.id)
        user = _make_user(db, org, f"ops-{uuid.uuid4().hex[:6]}@{tenant.slug}.test", "admin", "Ops Admin")
        user.role_id = role.id
        db.commit()
        token = create_access_token(str(user.id), {"typ": "user", "org": str(tenant.id), "role": "admin"})
    return {"Authorization": f"Bearer {token}", "X-Org-Slug": tenant.slug}


def _dept(client, headers, name="Sales"):
    return client.post("/api/v1/org/departments", json={"name": name}, headers=headers)


def test_the_catalogue_claims_every_permission_flag_once():
    claimed = [flag for m in menus.MENUS for flag in m.rights]
    assert sorted(claimed) == sorted(PERMISSION_KEYS)


def test_no_api_prefix_belongs_to_two_menus():
    prefixes = [p for m in menus.MENUS for p in m.writes]
    assert len(prefixes) == len(set(prefixes))


@pytest.mark.parametrize("method,remainder,expected", [
    ("POST", "", "add"),
    ("POST", "/", "add"),
    ("POST", "/123/convert", "edit"),
    ("PATCH", "/123", "edit"),
    ("PUT", "/123", "edit"),
    ("DELETE", "/123", "delete"),
])
def test_method_maps_to_action(method, remainder, expected):
    assert menus.action_for(method, remainder) == expected


def test_a_role_never_restricted_keeps_every_write(client, tenants):
    acme, _ = tenants
    headers = _admin_with_role(acme, None)
    assert _dept(client, headers).status_code == 201


def test_add_off_refuses_create_but_edit_still_works(client, tenants):
    acme, _ = tenants
    created = _dept(client, acme.headers()).json()  # the owner, unrestricted
    headers = _admin_with_role(acme, {"/departments": {"access": True, "add": False, "edit": True, "delete": False}})

    refused = _dept(client, headers, "Marketing")
    assert refused.status_code == 403
    assert "cannot add" in refused.json()["detail"]

    edited = client.patch(f"/api/v1/org/departments/{created['id']}",
                          json={"name": "Sales & Marketing"}, headers=headers)
    assert edited.status_code == 200, edited.text

    deleted = client.delete(f"/api/v1/org/departments/{created['id']}", headers=headers)
    assert deleted.status_code == 403


def test_no_access_refuses_every_write(client, tenants):
    acme, _ = tenants
    headers = _admin_with_role(acme, {"/departments": {"access": False}})
    response = _dept(client, headers)
    assert response.status_code == 403
    assert "does not have access" in response.json()["detail"]


def test_a_menu_missing_from_saved_rights_is_closed(client, tenants):
    acme, _ = tenants
    headers = _admin_with_role(acme, {"/designations": {"access": True, "add": True}})
    assert _dept(client, headers).status_code == 403


def test_reads_are_not_gated(client, tenants):
    acme, _ = tenants
    headers = _admin_with_role(acme, {"/departments": {"access": False}})
    assert client.get("/api/v1/org/departments", headers=headers).status_code == 200


def test_the_owner_is_never_restricted(client, tenants):
    acme, _ = tenants
    with SessionLocal() as db:
        owner_role = OrgRole(id=uuid.uuid4(), org_id=acme.id, name="Owner X", base_role="owner",
                             data_scope="company", permissions={}, is_builtin=False,
                             menu_rights={"/departments": {"access": False}})
        db.add(owner_role)
        db.flush()
        db.get(User, acme.owner.id).role_id = owner_role.id
        db.commit()
    assert _dept(client, acme.headers()).status_code == 201


def test_me_carries_the_rights_with_aliases(client, tenants):
    acme, _ = tenants
    headers = _admin_with_role(acme, {"/roles": {"access": True, "add": True, "edit": True, "delete": True}})
    me = client.get("/api/v1/auth/me", headers=headers).json()
    assert me["menu_rights"]["/roles"]["access"] is True
    assert me["menu_rights"]["/settings/roles"]["access"] is True
    assert client.get("/api/v1/auth/me", headers=acme.headers()).json()["menu_rights"] is None


def test_saving_rights_through_the_api_cleans_them(client, tenants):
    acme, _ = tenants
    roles = client.get("/api/v1/roles", headers=acme.headers()).json()
    manager = next(r for r in roles if r["base_role"] == "manager")
    assert manager["menu_rights"] is None

    response = client.patch(f"/api/v1/roles/{manager['id']}", headers=acme.headers(), json={
        "menu_rights": {
            "/crm/leads": {"access": True, "add": True, "edit": False, "delete": True},
            "/crm": {"access": True, "add": True},          # no actions on a dashboard
            "/nowhere": {"access": True},                    # not a menu
            "/departments": {"access": False, "add": True},  # no access, no actions
        },
    })
    assert response.status_code == 200, response.text
    saved = response.json()["menu_rights"]
    assert saved["/crm/leads"] == {"access": True, "add": True, "edit": False, "delete": True}
    assert saved["/crm"] == {"access": True}
    assert "/nowhere" not in saved
    assert saved["/departments"] == {"access": False, "add": False, "edit": False, "delete": False}


def test_the_owner_role_cannot_be_restricted(client, tenants):
    acme, _ = tenants
    roles = client.get("/api/v1/roles", headers=acme.headers()).json()
    owner = next(r for r in roles if r["base_role"] == "owner")
    response = client.patch(f"/api/v1/roles/{owner['id']}", headers=acme.headers(),
                            json={"menu_rights": {"/crm": {"access": False}}})
    assert response.status_code in (400, 409, 422)


def test_the_menu_catalogue_is_served(client, tenants):
    acme, _ = tenants
    groups = client.get("/api/v1/roles/menus", headers=acme.headers()).json()
    leads = next(m for g in groups for m in g["menus"] if m["key"] == "/crm/leads")
    assert leads["actions"] == ["add", "edit", "delete"]
