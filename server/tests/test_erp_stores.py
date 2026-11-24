"""Stores (warehouses): the default flag, the racks count, and renames."""

from __future__ import annotations

from tests.test_erp import API, acme, globex, ok, refused  # noqa: F401


def test_only_one_store_is_the_default(client, acme):
    a = ok(client.post(f"{API}/warehouses", json={"name": "Main Store", "is_default": True}, headers=acme.headers()), 201)
    b = ok(client.post(f"{API}/warehouses", json={"name": "Godown", "is_default": True}, headers=acme.headers()), 201)
    rows = {r["name"]: r for r in ok(client.get(f"{API}/warehouses", headers=acme.headers()))}
    assert rows["Godown"]["is_default"] is True and rows["Main Store"]["is_default"] is False
    assert a["id"] != b["id"]


def test_racks_are_counted_followed_on_rename_and_block_delete(client, acme):
    store = ok(client.post(f"{API}/warehouses", json={"name": "Main Store"}, headers=acme.headers()), 201)
    ok(client.post(f"{API}/lookups/rack", json={"name": "R1", "parent_name": "Main Store"}, headers=acme.headers()), 201)
    ok(client.post(f"{API}/lookups/rack", json={"name": "R2", "parent_name": "Main Store"}, headers=acme.headers()), 201)
    assert ok(client.get(f"{API}/warehouses", headers=acme.headers()))[0]["racks"] == 2
    ok(client.put(f"{API}/warehouses/{store['id']}", json={"name": "Central Store"}, headers=acme.headers()))
    assert {r["parent_name"] for r in ok(client.get(f"{API}/lookups/rack", headers=acme.headers()))} == {"Central Store"}
    refused(client.delete(f"{API}/warehouses/{store['id']}", headers=acme.headers()), 409, "warehouse_has_racks")
