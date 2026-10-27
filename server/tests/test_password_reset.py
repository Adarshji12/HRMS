"""Forgot password — request a link, use it once, and nothing else.

The rules each test pins:

1. The request answers the same for an unknown address as a real one.
2. A link sets the password, and the old password stops working.
3. A link works once: after the password changes it is dead.
4. A link is bound to its company.
5. A reset token is never a session.
"""

from __future__ import annotations

from urllib.parse import parse_qs, urlparse

from app.core.security import hash_password
from app.db.session import SessionLocal
from app.models import User


def _set_password(user_id, password: str) -> None:
    with SessionLocal() as db:
        db.get(User, user_id).password_hash = hash_password(password)
        db.commit()


def _request_link(client, tenant, email: str) -> str | None:
    response = client.post("/api/v1/auth/forgot-password", json={"email": email},
                           headers={"X-Org-Slug": tenant.slug})
    assert response.status_code == 200, response.text
    return response.json()["dev_reset_url"]


def _token(url: str) -> str:
    return parse_qs(urlparse(url).query)["token"][0]


def _login(client, tenant, email: str, password: str) -> int:
    return client.post("/api/v1/auth/login", json={"email": email, "password": password},
                       headers={"X-Org-Slug": tenant.slug}).status_code


def test_unknown_address_gets_the_same_answer(client, tenants):
    tenant, _ = tenants
    response = client.post("/api/v1/auth/forgot-password", json={"email": "nobody@nowhere.test"},
                           headers={"X-Org-Slug": tenant.slug})
    assert response.status_code == 200
    assert response.json() == {"ok": True, "dev_reset_url": None}


def test_reset_sets_the_password_and_retires_the_old_one(client, tenants):
    tenant, _ = tenants
    user = tenant.employee
    _set_password(user.id, "old-password-1")

    url = _request_link(client, tenant, user.email)
    assert url and "/reset-password?token=" in url
    token = _token(url)

    check = client.get("/api/v1/auth/reset-password", params={"token": token},
                       headers={"X-Org-Slug": tenant.slug})
    assert check.status_code == 200, check.text
    assert check.json()["email"] == user.email

    done = client.post("/api/v1/auth/reset-password",
                       json={"token": token, "password": "new-password-2"},
                       headers={"X-Org-Slug": tenant.slug})
    assert done.status_code == 200, done.text

    assert _login(client, tenant, user.email, "new-password-2") == 200
    assert _login(client, tenant, user.email, "old-password-1") == 401


def test_a_link_works_once(client, tenants):
    tenant, _ = tenants
    user = tenant.employee
    _set_password(user.id, "old-password-1")
    token = _token(_request_link(client, tenant, user.email))

    first = client.post("/api/v1/auth/reset-password", json={"token": token, "password": "first-new-1"},
                        headers={"X-Org-Slug": tenant.slug})
    assert first.status_code == 200
    again = client.post("/api/v1/auth/reset-password", json={"token": token, "password": "second-new-2"},
                        headers={"X-Org-Slug": tenant.slug})
    assert again.status_code == 400
    assert again.json()["detail"]["reason"] == "reset_link_invalid"


def test_a_link_is_bound_to_its_company(client, tenants):
    tenant, other = tenants
    _set_password(tenant.employee.id, "old-password-1")
    token = _token(_request_link(client, tenant, tenant.employee.email))

    elsewhere = client.get("/api/v1/auth/reset-password", params={"token": token},
                           headers={"X-Org-Slug": other.slug})
    assert elsewhere.status_code == 400


def test_a_reset_token_is_not_a_session(client, tenants):
    tenant, _ = tenants
    _set_password(tenant.employee.id, "old-password-1")
    token = _token(_request_link(client, tenant, tenant.employee.email))

    me = client.get("/api/v1/auth/me",
                    headers={"Authorization": f"Bearer {token}", "X-Org-Slug": tenant.slug})
    assert me.status_code == 401


def test_new_password_must_be_long_enough(client, tenants):
    tenant, _ = tenants
    _set_password(tenant.employee.id, "old-password-1")
    token = _token(_request_link(client, tenant, tenant.employee.email))
    short = client.post("/api/v1/auth/reset-password", json={"token": token, "password": "short"},
                        headers={"X-Org-Slug": tenant.slug})
    assert short.status_code == 422
