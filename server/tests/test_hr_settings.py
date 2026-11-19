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


def test_birthday_lookahead_defaults_to_thirty_and_is_saved(client, tenants):
    tenant, _ = tenants
    body = client.get("/api/v1/hr/settings", headers=tenant.headers()).json()
    assert body["birthday_lookahead_days"] == 30
    saved = client.put("/api/v1/hr/settings", json={**body, "birthday_lookahead_days": 14, "probation_warn_days": 0},
                       headers=tenant.headers())
    assert saved.status_code == 200, saved.text
    assert saved.json()["birthday_lookahead_days"] == 14 and saved.json()["probation_warn_days"] == 0
    assert client.put("/api/v1/hr/settings", json={**body, "birthday_lookahead_days": 400},
                      headers=tenant.headers()).status_code == 422


def test_the_office_time_zone_must_be_a_real_one(client, tenants):
    tenant, _ = tenants
    assert client.put("/api/v1/org/company", json={"timezone": "Mars/Olympus"}, headers=tenant.headers()).status_code == 422
    ok = client.put("/api/v1/org/company", json={"timezone": "Asia/Kolkata"}, headers=tenant.headers())
    assert ok.status_code == 200, ok.text


def test_birthdays_report_lists_the_next_birthdays_without_the_birth_year(client, tenants):
    from datetime import date, timedelta

    tenant, _ = tenants
    soon = date.today() + timedelta(days=5)
    born = soon.replace(year=soon.year - 30) if not (soon.month == 2 and soon.day == 29) else date(1992, 2, 28)
    client.patch(f"/api/v1/people/{tenant.employee.id}", json={"date_of_birth": born.isoformat()},
                 headers=tenant.headers(tenant.employee_token))

    rows = client.get("/api/v1/people/reports/birthdays?within_days=10", headers=tenant.headers()).json()
    mine = [r for r in rows if r["user_id"] == str(tenant.employee.id)]
    assert len(mine) == 1 and mine[0]["on"] == soon.isoformat()
    assert "date_of_birth" not in mine[0] and "turns" not in mine[0]
    assert client.get("/api/v1/people/reports/birthdays?within_days=2", headers=tenant.headers()).json() == []
    assert client.get("/api/v1/people/reports/birthdays", headers=tenant.headers(tenant.employee_token)).status_code == 403
