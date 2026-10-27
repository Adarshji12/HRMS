"""Sign-in and password reset from a host that names no workspace.

The console asks only for email and password. On a tenant subdomain the
company is the address; anywhere else the server has to find it from the
account — and must never sign anyone in to the wrong company doing so.
"""
import uuid

from app.core.security import create_access_token, decode_access_token, generate_enrollment_key, hash_password
from app.db.session import SessionLocal
from app.models import User

PASSWORD = "correct-horse-battery"


def _login(client, email, password=PASSWORD, slug=None):
    headers = {"X-Org-Slug": slug} if slug else {}
    return client.post("/api/v1/auth/login", json={"email": email, "password": password}, headers=headers)


def _second_account(org_id, email, password=PASSWORD):
    with SessionLocal() as db:
        db.add(User(
            id=uuid.uuid4(), org_id=org_id, email=email, full_name="Shared Person",
            role="employee", password_hash=hash_password(password), is_active=True,
            enrollment_key=generate_enrollment_key(),
        ))
        db.commit()


def test_finds_the_company_from_the_account(client, tenants):
    acme, _ = tenants
    response = _login(client, acme.owner.email)
    assert response.status_code == 200
    body = response.json()
    assert body["organization"]["slug"] == "acme"
    assert decode_access_token(body["access_token"])["org"] == str(acme.id)


def test_wrong_password_is_the_usual_refusal(client, tenants):
    acme, _ = tenants
    response = _login(client, acme.owner.email, "not-the-password")
    assert response.status_code == 401
    assert _login(client, "nobody@nowhere.test").status_code == 401


def test_a_tenant_host_still_scopes_the_lookup(client, tenants):
    acme, _ = tenants
    assert _login(client, acme.owner.email, slug="globex").status_code == 401
    assert _login(client, acme.owner.email, slug="acme").status_code == 200


def test_same_email_in_two_companies_asks_which(client, tenants):
    acme, globex = tenants
    _second_account(globex.id, acme.owner.email)
    response = _login(client, acme.owner.email)
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["reason"] == "choose_workspace"
    assert [w["slug"] for w in detail["workspaces"]] == ["acme", "globex"]
    # Picking one signs in to exactly that company.
    picked = _login(client, acme.owner.email, slug="globex")
    assert picked.json()["organization"]["slug"] == "globex"


def test_only_companies_whose_password_matches_count(client, tenants):
    acme, globex = tenants
    _second_account(globex.id, acme.owner.email, password="a-different-password")
    response = _login(client, acme.owner.email)
    assert response.status_code == 200
    assert response.json()["organization"]["slug"] == "acme"


def test_reset_works_without_a_workspace(client, tenants):
    acme, _ = tenants
    asked = client.post("/api/v1/auth/forgot-password", json={"email": acme.owner.email})
    assert asked.status_code == 200
    with SessionLocal() as db:
        user = db.get(User, acme.owner.id)
        from app.api.v1.auth import _RESET_TYP, _fingerprint
        token = create_access_token(
            str(user.id), {"typ": _RESET_TYP, "org": str(user.org_id), "ph": _fingerprint(user)},
        )
    assert client.get(f"/api/v1/auth/reset-password?token={token}").status_code == 200
    done = client.post("/api/v1/auth/reset-password", json={"token": token, "password": "brand-new-pass-1"})
    assert done.status_code == 200
    assert _login(client, acme.owner.email, "brand-new-pass-1").status_code == 200


def test_a_reset_link_still_cannot_cross_companies(client, tenants):
    acme, _ = tenants
    with SessionLocal() as db:
        user = db.get(User, acme.owner.id)
        from app.api.v1.auth import _RESET_TYP, _fingerprint
        token = create_access_token(
            str(user.id), {"typ": _RESET_TYP, "org": str(user.org_id), "ph": _fingerprint(user)},
        )
    response = client.get(
        f"/api/v1/auth/reset-password?token={token}", headers={"X-Org-Slug": "globex"}
    )
    assert response.status_code == 400
