import pytest

CASES = {
    "/api/v1/org/departments": {"name": "Sales Team"},
    "/api/v1/org/designations": {"name": "Manager One"},
    "/api/v1/org/branches": {"name": "Head Office"},
    "/api/v1/attendance/locations": {"name": "Noida Office", "latitude": 28.5, "longitude": 77.3, "radius_m": 100},
    "/api/v1/leave/holidays": {"name": "Diwali", "holiday_date": "2026-11-08"},
}


@pytest.mark.parametrize("url", list(CASES))
def test_a_repeat_is_refused_in_any_case(client, tenants, url):
    acme, _ = tenants
    body = CASES[url]
    assert client.post(url, json=body, headers=acme.headers()).status_code == 201
    for form in (body["name"].lower(), " " + body["name"].upper() + " "):
        r = client.post(url, json={**body, "name": form}, headers=acme.headers())
        assert r.status_code == 409 and "already exists" in r.json()["detail"]["message"], (url, r.text)


def test_the_same_holiday_name_on_another_date_is_fine(client, tenants):
    acme, _ = tenants
    url = "/api/v1/leave/holidays"
    assert client.post(url, json={"name": "Diwali", "holiday_date": "2026-11-08"}, headers=acme.headers()).status_code == 201
    assert client.post(url, json={"name": "Diwali", "holiday_date": "2027-10-29"}, headers=acme.headers()).status_code == 201


def test_leave_types_refuse_a_repeat_in_any_case(client, tenants):
    acme, _ = tenants
    url = "/api/v1/leave/types"
    assert client.post(url, json={"name": "Earned Leave", "code": "EL", "accrual_type": "none"}, headers=acme.headers()).status_code == 201
    r = client.post(url, json={"name": "earned  leave", "code": "EL2", "accrual_type": "none"}, headers=acme.headers())
    assert r.status_code == 409 and "already exists" in r.json()["detail"]["message"]
