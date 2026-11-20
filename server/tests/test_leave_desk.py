"""The HR leave desk: requests across the team, the balance matrix, preview, carry forward."""

from __future__ import annotations

from datetime import date, timedelta


def _type(client, tenant, **over):
    body = {"name": "Casual Leave", "code": "CL", "accrual_type": "none", **over}
    r = client.post("/api/v1/leave/types", json=body, headers=tenant.headers())
    assert r.status_code in (200, 201), r.text
    return r.json()


def test_desk_lists_requests_balances_and_previews(client, tenants):
    acme, _ = tenants
    lt = _type(client, acme)
    day = date.today() + timedelta(days=30)
    while day.weekday() >= 5:
        day += timedelta(days=1)
    pv = client.get(f"/api/v1/leave/preview?user_id={acme.employee.id}&leave_type_id={lt['id']}&start={day}&end={day}",
                    headers=acme.headers())
    assert pv.status_code == 200 and pv.json()["duration_milli_days"] == 1000

    from app.services.leave import policy_year_for
    adj = client.post("/api/v1/leave/balances/adjust", json={
        "user_id": str(acme.employee.id), "leave_type_id": lt["id"], "year": policy_year_for(day, 1),
        "delta_milli_days": 5000, "reason": "opening grant"}, headers=acme.headers())
    assert adj.status_code == 200, adj.text
    applied = client.post(f"/api/v1/leave/applications?user_id={acme.employee.id}",
                          json={"leave_type_id": lt["id"], "start_date": str(day), "end_date": str(day),
                                "reason": "trip", "contact_phone": "9000000000"}, headers=acme.headers())
    assert applied.status_code == 201, applied.text

    data = client.get("/api/v1/leave/requests", headers=acme.headers()).json()
    assert data["counts"]["pending"] >= 1
    mine = next(i for i in data["items"] if i["user_id"] == str(acme.employee.id))
    assert mine["contact_phone"] == "9000000000" and mine["waiting_on_me"] is True

    m = client.get("/api/v1/leave/balances/matrix", headers=acme.headers()).json()
    assert any(t["code"] == "CL" for t in m["types"]) and m["rows"]
    cal = client.get(f"/api/v1/leave/calendar?year={day.year}&month={day.month}", headers=acme.headers()).json()
    assert any(i["user_id"] == str(acme.employee.id) for i in cal["items"])
    assert client.get("/api/v1/leave/requests", headers=acme.headers(acme.employee_token)).status_code == 403


def test_carry_forward_is_capped_and_repeatable(client, tenants):
    acme, _ = tenants
    _type(client, acme, name="Earned", code="EL", carry_forward_limit_milli_days=2000)
    y = date.today().year
    r1 = client.post("/api/v1/leave/carry-forward", json={"from_year": y - 1, "into_year": y}, headers=acme.headers())
    assert r1.status_code == 200, r1.text
    assert client.post("/api/v1/leave/carry-forward", json={"from_year": y - 1, "into_year": y}, headers=acme.headers()).json() == r1.json()
    assert client.post("/api/v1/leave/carry-forward", json={"from_year": y - 1, "into_year": y + 3}, headers=acme.headers()).status_code == 422
