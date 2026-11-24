"""Update Master: bulk ledger openings and bulk rack assignment."""

from __future__ import annotations

from tests.test_erp import API, _item, acme, globex, ok, refused  # noqa: F401


def _ledger(client, tenant, name) -> dict:
    return ok(client.post(f"{API}/ledgers", json={"name": name, "account_group": "Sundry Debtors"}, headers=tenant.headers()), 201)


def test_ledger_openings_are_set_in_bulk(client, acme):
    a, b = _ledger(client, acme, "A Traders"), _ledger(client, acme, "B Traders")
    out = ok(client.put(f"{API}/ledger-openings", json={"rows": [
        {"id": a["id"], "opening_balance": "1500.50", "opening_type": "dr"}, {"id": b["id"], "opening_balance": "200", "opening_type": "cr"}]},
        headers=acme.headers()))
    assert out["updated"] == 2
    rows = {r["name"]: r for r in ok(client.get(f"{API}/ledgers", headers=acme.headers()))}
    assert rows["A Traders"]["balance"] == "1500.50" and rows["B Traders"]["balance_type"] == "cr"
    # Nothing changed, nothing counted.
    assert ok(client.put(f"{API}/ledger-openings", json={"rows": [{"id": a["id"], "opening_balance": "1500.50", "opening_type": "dr"}]},
                         headers=acme.headers()))["updated"] == 0
    refused(client.put(f"{API}/ledger-openings", json={"rows": [{"id": a["id"], "opening_balance": "-1", "opening_type": "dr"}]}, headers=acme.headers()), 422)


def test_openings_stay_inside_the_company(client, acme, globex):
    a = _ledger(client, acme, "A Traders")
    refused(client.put(f"{API}/ledger-openings", json={"rows": [{"id": a["id"], "opening_balance": "5", "opening_type": "dr"}]}, headers=globex.headers()), 422, "bad_ledger")


def test_items_are_put_on_racks_in_bulk_and_racks_count_them(client, acme):
    ok(client.post(f"{API}/lookups/rack", json={"name": "Fridge Chest", "parent_name": "Main Store"}, headers=acme.headers()), 201)
    i1, i2 = _item(client, acme, code="A-1"), _item(client, acme, code="A-2", name="Second")
    out = ok(client.post(f"{API}/items/rack", json={"rack": "fridge chest", "item_ids": [i1["id"], i2["id"]]}, headers=acme.headers()))
    assert out == {"updated": 2, "rack": "Fridge Chest"}
    assert {r["rack"] for r in ok(client.get(f"{API}/items", headers=acme.headers()))} == {"Fridge Chest"}
    assert ok(client.get(f"{API}/lookups/rack", headers=acme.headers()))[0]["items"] == 2
    refused(client.post(f"{API}/items/rack", json={"rack": "Nowhere", "item_ids": [i1["id"]]}, headers=acme.headers()), 422, "bad_rack")
    ok(client.post(f"{API}/items/rack", json={"rack": None, "item_ids": [i1["id"]]}, headers=acme.headers()))
    assert ok(client.get(f"{API}/lookups/rack", headers=acme.headers()))[0]["items"] == 1
