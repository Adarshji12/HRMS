"""Stations: the geography master's towns, with ledger counts, a source tag and a guarded delete."""

from __future__ import annotations

from tests.test_erp import API, acme, globex, ok, refused  # noqa: F401


def _load(client, tenant) -> None:
    ok(client.post("/api/v1/crm/geography/india", headers=tenant.headers()))


def _state(client, tenant, name="Rajasthan") -> dict:
    return next(s for s in ok(client.get("/api/v1/crm/masters/states", headers=tenant.headers())) if s["name"] == name)


def test_standard_towns_are_tagged_and_a_new_one_is_custom(client, acme):
    _load(client, acme)
    rows = ok(client.get(f"{API}/stations", headers=acme.headers()))
    assert next(r for r in rows if r["name"] == "Jaipur")["source"] == "standard"
    st = _state(client, acme)
    made = ok(client.post(f"{API}/stations", json={"name": "Chomu", "state_id": st["id"], "pincode": "303702"}, headers=acme.headers()), 201)
    assert made["source"] == "custom" and made["state_name"] == "Rajasthan" and made["pincode"] == "303702"
    refused(client.post(f"{API}/stations", json={"name": "chomu", "state_id": st["id"]}, headers=acme.headers()), 409, "duplicate")
    refused(client.post(f"{API}/stations", json={"name": "X", "state_id": st["id"], "pincode": "12"}, headers=acme.headers()), 422)


def test_ledgers_are_counted_follow_a_rename_and_block_delete(client, acme):
    _load(client, acme)
    st = _state(client, acme)
    town = ok(client.post(f"{API}/stations", json={"name": "Chomu", "state_id": st["id"]}, headers=acme.headers()), 201)
    ok(client.post(f"{API}/ledgers", json={"name": "Gupta Medical", "account_group": "Sundry Debtors", "station": "Chomu"}, headers=acme.headers()), 201)
    assert next(r for r in ok(client.get(f"{API}/stations", headers=acme.headers())) if r["id"] == town["id"])["ledgers"] == 1
    refused(client.delete(f"{API}/stations/{town['id']}", headers=acme.headers()), 409, "station_in_use")
    ok(client.put(f"{API}/stations/{town['id']}", json={"name": "Chomu Town", "state_id": st["id"]}, headers=acme.headers()))
    assert ok(client.get(f"{API}/ledgers", headers=acme.headers()))[0]["station"] == "Chomu Town"
    unused = ok(client.post(f"{API}/stations", json={"name": "Sambhar", "state_id": st["id"]}, headers=acme.headers()), 201)
    assert client.delete(f"{API}/stations/{unused['id']}", headers=acme.headers()).status_code == 204


def test_a_station_stays_inside_its_company_and_district_state(client, acme, globex):
    _load(client, acme)
    _load(client, globex)
    st = _state(client, acme)
    other = _state(client, acme, "Kerala")
    dist = ok(client.post("/api/v1/crm/masters/districts", json={"name": "Alwar Test", "state_id": st["id"]}, headers=acme.headers()), 201)
    refused(client.post(f"{API}/stations", json={"name": "Town", "state_id": other["id"], "district_id": dist["id"]}, headers=acme.headers()), 422, "bad_district")
    refused(client.post(f"{API}/stations", json={"name": "Town", "state_id": st["id"]}, headers=globex.headers()), 422, "bad_state")
