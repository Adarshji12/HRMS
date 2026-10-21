"""HR settings — the employee ID format, and codes minted from it."""

from __future__ import annotations

from tests.test_employee_hire import _grant_seats


def _hire(client, tenant, email: str, code: str | None = None) -> dict:
    body = {"email": email, "full_name": "New Hire", "role": "employee"}
    if code is not None:
        body["employee_code"] = code
    response = client.post("/api/v1/admin/employees", json=body, headers=tenant.headers())
    assert response.status_code == 201, response.text
    return response.json()


def test_defaults_are_created_on_first_read(client, tenants):
    tenant, _ = tenants
    response = client.get("/api/v1/hr/settings", headers=tenant.headers())
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["emp_code_prefix"] == "EMP"
    assert body["next_code"] == "EMP-0001"


def test_employees_read_but_only_admins_write(client, tenants):
    tenant, _ = tenants
    staff = tenant.headers(tenant.employee_token)
    assert client.get("/api/v1/hr/settings", headers=staff).status_code == 200
    response = client.put("/api/v1/hr/settings", json={}, headers=staff)
    assert response.status_code == 403


def test_blank_code_is_minted_from_the_format(client, tenants):
    tenant, _ = tenants
    _grant_seats(tenant.id)
    response = client.put(
        "/api/v1/hr/settings",
        json={"emp_code_prefix": "lrs", "emp_code_separator": "/", "emp_code_digits": 3,
              "emp_code_next": 7, "default_probation_months": 3, "default_notice_days": 30,
              "probation_warn_days": 15, "document_warn_days": 60},
        headers=tenant.headers(),
    )
    assert response.status_code == 200, response.text
    assert response.json()["next_code"] == "LRS/007"

    first = _hire(client, tenant, "a@example.com")
    second = _hire(client, tenant, "b@example.com")
    assert first["employee_code"] == "LRS/007"
    assert second["employee_code"] == "LRS/008"


def test_hand_typed_next_code_advances_the_counter(client, tenants):
    tenant, _ = tenants
    _grant_seats(tenant.id)
    preview = client.get("/api/v1/hr/settings", headers=tenant.headers()).json()["next_code"]
    _hire(client, tenant, "typed@example.com", code=preview)
    after = client.get("/api/v1/hr/settings", headers=tenant.headers()).json()["next_code"]
    assert after != preview
    minted = _hire(client, tenant, "auto@example.com")
    assert minted["employee_code"] == after
