"""CRM sales masters: the reference lists the opportunity pipeline stands on.

Territories, campaigns, competitors, contact designations, lost reasons and
opportunity stages (PRD 6.1.2). The rules worth pinning are the ones the
database alone cannot enforce: a state in one territory only, a closed stage
whose probability means what closing means, the last open stage staying put,
and every reference staying inside its own tenant.
"""

from __future__ import annotations

import pytest


@pytest.fixture
def acme(tenants):
    return tenants[0]


@pytest.fixture
def globex(tenants):
    return tenants[1]


def _get(client, tenant, kind: str) -> list[dict]:
    response = client.get(f"/api/v1/crm/masters/{kind}", headers=tenant.headers())
    assert response.status_code == 200, response.text
    return response.json()


def _post(client, tenant, kind: str, body: dict):
    return client.post(f"/api/v1/crm/masters/{kind}", json=body, headers=tenant.headers())


def test_sales_masters_seed(client, acme):
    stages = _get(client, acme, "opportunity-stages")
    assert stages[0]["name"] == "Qualification"
    assert {s["behaviour"] for s in stages} == {"open", "won", "lost", "no_decision"}
    won = next(s for s in stages if s["behaviour"] == "won")
    assert won["probability"] == 100 and won["forecast_category"] is None

    reasons = _get(client, acme, "lost-reasons")
    assert any(r["requires_competitor"] for r in reasons)
    assert {r["outcome"] for r in reasons} == {"lost", "no_decision"}
    assert _get(client, acme, "contact-designations")

    territories = _get(client, acme, "territories")
    north = next(t for t in territories if t["name"] == "North")
    assert "Delhi" in north["state_names"]
    assert len(north["state_ids"]) == len(north["state_names"])


def test_closed_stage_probability_is_forced(client, acme):
    response = _post(client, acme, "opportunity-stages", {
        "name": "Dropped", "behaviour": "lost", "probability": 55,
        "forecast_category": "commit", "stale_after_days": 10,
    })
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["probability"] == 0
    assert body["forecast_category"] is None
    assert body["stale_after_days"] == 0


def test_last_open_stage_cannot_be_closed_or_removed(client, acme):
    stages = _get(client, acme, "opportunity-stages")
    open_stages = [s for s in stages if s["behaviour"] == "open"]
    for stage in open_stages[:-1]:
        r = client.delete(
            f"/api/v1/crm/masters/opportunity-stages/{stage['id']}", headers=acme.headers()
        )
        assert r.status_code == 204, r.text
    last = open_stages[-1]
    r = client.put(
        f"/api/v1/crm/masters/opportunity-stages/{last['id']}",
        json={**last, "behaviour": "won"}, headers=acme.headers(),
    )
    assert r.status_code == 422
    assert r.json()["detail"]["reason"] == "last_open_stage"
    r = client.delete(
        f"/api/v1/crm/masters/opportunity-stages/{last['id']}", headers=acme.headers()
    )
    assert r.status_code == 422


def test_state_sits_in_one_territory(client, acme):
    north = next(t for t in _get(client, acme, "territories") if t["name"] == "North")
    delhi = north["state_ids"][north["state_names"].index("Delhi")]

    r = _post(client, acme, "territories", {"name": "NCR", "state_ids": [delhi]})
    assert r.status_code == 422
    assert r.json()["detail"]["reason"] == "state_in_other_territory"
    assert "Delhi" in r.json()["detail"]["message"]

    # Saving North again with its own states is not a clash with itself.
    r = client.put(
        f"/api/v1/crm/masters/territories/{north['id']}",
        json={"name": "North", "state_ids": north["state_ids"], "manager_id": str(acme.owner.id)},
        headers=acme.headers(),
    )
    assert r.status_code == 200, r.text
    assert r.json()["manager_name"]


def test_territory_refuses_another_tenants_state_and_manager(client, acme, globex):
    foreign_state = _get(client, globex, "states")[0]["id"]
    r = _post(client, acme, "territories", {"name": "Overseas", "state_ids": [foreign_state]})
    assert r.status_code == 422
    r = _post(client, acme, "territories", {"name": "Overseas", "manager_id": str(globex.owner.id)})
    assert r.status_code == 422


def test_campaign_source_and_dates(client, acme, globex):
    source = _get(client, acme, "sources")[0]
    r = _post(client, acme, "campaigns", {
        "name": "Diwali push", "source_id": source["id"], "starts_on": "2026-10-01",
        "ends_on": "2026-11-15", "budget": "250000",
    })
    assert r.status_code == 201, r.text
    assert r.json()["source_name"] == source["name"]

    # The source is now held by a campaign and cannot be deleted under it.
    r = client.delete(f"/api/v1/crm/masters/sources/{source['id']}", headers=acme.headers())
    assert r.status_code == 409

    r = _post(client, acme, "campaigns", {
        "name": "Backwards", "starts_on": "2026-11-15", "ends_on": "2026-10-01",
    })
    assert r.status_code == 422

    foreign = _get(client, globex, "sources")[0]["id"]
    r = _post(client, acme, "campaigns", {"name": "Borrowed", "source_id": foreign})
    assert r.status_code == 422


def test_products_carry_category_and_oem(client, acme):
    r = _post(client, acme, "products", {
        "name": "Firewall AMC", "rate": "50000", "category": "support_amc", "oem": "Fortinet",
    })
    assert r.status_code == 201, r.text
    assert r.json()["category"] == "support_amc" and r.json()["oem"] == "Fortinet"
    r = _post(client, acme, "products", {"name": "Odd", "category": "magic"})
    assert r.status_code == 422


def test_competitors_are_per_tenant(client, acme, globex):
    assert _post(client, acme, "competitors", {"name": "Rival Infotech"}).status_code == 201
    assert _get(client, globex, "competitors") == []
    assert _post(client, acme, "competitors", {"name": "Rival Infotech"}).status_code == 409


def test_employee_cannot_write_sales_masters(client, acme):
    r = client.post(
        "/api/v1/crm/masters/competitors", json={"name": "X"},
        headers=acme.headers(acme.employee_token),
    )
    assert r.status_code == 403
    # ...but can read them, to fill the dropdowns on an opportunity.
    r = client.get(
        "/api/v1/crm/masters/lost-reasons", headers=acme.headers(acme.employee_token)
    )
    assert r.status_code == 200


def test_districts_sit_under_their_state(client, acme, globex):
    states = {s["name"]: s["id"] for s in _get(client, acme, "states")}
    # A name of our own: a new workspace already holds every real district
    # (services/crm_geography), Pune among them.
    r = _post(client, acme, "districts", {"name": "Test District", "state_id": states["Maharashtra"]})
    assert r.status_code == 201, r.text
    pune = r.json()
    assert pune["state_name"] == "Maharashtra"

    listed = client.get(
        f"/api/v1/crm/masters/districts?parent_id={states['Maharashtra']}", headers=acme.headers()
    ).json()
    names = [d["name"] for d in listed]
    assert "Test District" in names and "Pune" in names
    karnataka = client.get(
        f"/api/v1/crm/masters/districts?parent_id={states['Karnataka']}", headers=acme.headers()
    ).json()
    assert "Test District" not in [d["name"] for d in karnataka]

    r = _post(client, acme, "cities", {
        "name": "Hinjewadi", "state_id": states["Maharashtra"], "district_id": pune["id"],
    })
    assert r.status_code == 201, r.text
    assert r.json()["district_name"] == "Test District"

    # A district of Maharashtra cannot hold a city in Karnataka.
    r = _post(client, acme, "cities", {
        "name": "Mysuru", "state_id": states["Karnataka"], "district_id": pune["id"],
    })
    assert r.status_code == 422
    assert r.json()["detail"]["reason"] == "district_state_mismatch"

    # Held by a city, so it can be switched off but not deleted.
    r = client.delete(f"/api/v1/crm/masters/districts/{pune['id']}", headers=acme.headers())
    assert r.status_code == 409

    foreign = _get(client, globex, "states")[0]["id"]
    assert _post(client, acme, "districts", {"name": "X", "state_id": foreign}).status_code == 422
