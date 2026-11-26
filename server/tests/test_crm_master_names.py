"""A master list does not take the same name twice, however it is capitalised or spaced."""

from __future__ import annotations

M = "/api/v1/crm/masters"


def _post(client, tenant, kind, body):
    return client.post(f"{M}/{kind}", json=body, headers=tenant.headers())


def test_call_dispositions_and_visit_types_refuse_a_repeat_in_any_case(client, tenants):
    acme, _ = tenants
    assert _post(client, acme, "dispositions", {"name": "Update Call"}).status_code == 201
    for again in ("update call", "UPDATE CALL", "  Update   Call "):
        r = _post(client, acme, "dispositions", {"name": again})
        assert r.status_code == 409 and r.json()["detail"]["reason"] == "duplicate", again
    assert _post(client, acme, "visit-types", {"name": "Demo"}).status_code == 201
    assert _post(client, acme, "visit-types", {"name": "dEmO"}).status_code == 409


def test_state_district_and_city_names_ignore_case_within_their_parent(client, tenants):
    acme, _ = tenants
    country = _post(client, acme, "countries", {"name": "India"}).json()
    state = _post(client, acme, "states", {"name": "Rajasthan", "country_id": country["id"]})
    assert state.status_code == 201
    assert _post(client, acme, "states", {"name": "rajasthan", "country_id": country["id"]}).status_code == 409

    district = _post(client, acme, "districts", {"name": "Kota", "state_id": state.json()["id"]})
    assert district.status_code == 201
    assert _post(client, acme, "districts", {"name": "kota", "state_id": state.json()["id"]}).status_code == 409

    city = _post(client, acme, "cities", {"name": "Kota", "state_id": state.json()["id"]})
    assert city.status_code == 201
    assert _post(client, acme, "cities", {"name": "KOTA", "state_id": state.json()["id"]}).status_code == 409

    # The same name under another state is a different place.
    other = _post(client, acme, "states", {"name": "Haryana", "country_id": country["id"]}).json()
    assert _post(client, acme, "cities", {"name": "kota", "state_id": other["id"]}).status_code == 201


def test_renaming_into_an_existing_name_is_refused_but_keeping_your_own_is_fine(client, tenants):
    acme, _ = tenants
    a = _post(client, acme, "dispositions", {"name": "Enquiry"}).json()
    b = _post(client, acme, "dispositions", {"name": "Complaint"}).json()
    clash = client.put(f"{M}/dispositions/{b['id']}", json={"name": "enquiry"}, headers=acme.headers())
    assert clash.status_code == 409
    same = client.put(f"{M}/dispositions/{a['id']}", json={"name": "ENQUIRY"}, headers=acme.headers())
    assert same.status_code == 200 and same.json()["name"] == "ENQUIRY"


def test_the_refusal_says_the_name_already_exists(client, tenants):
    acme, _ = tenants
    _post(client, acme, "dispositions", {"name": "Update Call"})
    r = _post(client, acme, "dispositions", {"name": "update call"})
    assert r.status_code == 409 and "already exists" in r.json()["detail"]["message"]
    assert "Update Call" in r.json()["detail"]["message"]
