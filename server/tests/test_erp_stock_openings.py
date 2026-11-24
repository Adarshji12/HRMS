"""Opening stock entered as lots."""

from __future__ import annotations

from tests.test_erp import API, _item, _warehouse, acme, globex, ok, refused  # noqa: F401


def _stock(client, tenant, item, wh) -> float:
    rows = ok(client.get(f"{API}/stock", params={"item_id": item["id"], "warehouse_id": wh["id"]}, headers=tenant.headers()))
    return sum(float(r["quantity"]) for r in rows)


def test_lots_set_the_stock_and_replace_cleanly(client, acme):
    wh, item = _warehouse(client, acme), _item(client, acme, code="CH-1")
    out = ok(client.put(f"{API}/stock-openings/{item['id']}", json={"warehouse_id": wh["id"], "lots": [
        {"quantity": "10", "pur_rate": "8", "mrp": "15", "rate_a": "12", "rate_b": "14"},
        {"lot_no": "B-77", "quantity": "5", "pur_rate": "9", "barcode": "890100"},
    ]}, headers=acme.headers()))
    assert out["quantity"] == "15.000"
    assert {l["lot_no"] for l in out["lots"]} == {"CH-1-1", "B-77"}
    assert _stock(client, acme, item, wh) == 15
    rows = ok(client.get(f"{API}/stock-openings", params={"warehouse_id": wh["id"]}, headers=acme.headers()))
    assert rows[0]["quantity"] == "15.000" and rows[0]["lot_count"] == 2 and rows[0]["value"] == "125.00"
    # Re-saving moves the ledger by the difference only.
    ok(client.put(f"{API}/stock-openings/{item['id']}", json={"warehouse_id": wh["id"], "lots": [{"quantity": "4", "pur_rate": "8"}]}, headers=acme.headers()))
    assert _stock(client, acme, item, wh) == 4
    assert ok(client.get(f"{API}/stock-openings/{item['id']}", params={"warehouse_id": wh["id"]}, headers=acme.headers()))[0]["quantity"] == "4.000"
    refused(client.put(f"{API}/stock-openings/{item['id']}", json={"warehouse_id": wh["id"], "lots": [
        {"lot_no": "X", "quantity": "1"}, {"lot_no": "x", "quantity": "1"}]}, headers=acme.headers()), 422, "duplicate_lot")


def test_serialised_items_and_other_companies_are_refused(client, acme, globex):
    wh = _warehouse(client, acme)
    serial = _item(client, acme, code="SR-1", serialized=True)
    refused(client.put(f"{API}/stock-openings/{serial['id']}", json={"warehouse_id": wh["id"], "lots": []}, headers=acme.headers()), 409, "not_lot_stock")
    item = _item(client, acme, code="CH-2")
    refused(client.put(f"{API}/stock-openings/{item['id']}", json={"warehouse_id": wh["id"], "lots": []}, headers=globex.headers()), 404)
    assert ok(client.get(f"{API}/stock-openings", params={"warehouse_id": wh["id"]}, headers=acme.headers()))[0]["code"] == "CH-2"
