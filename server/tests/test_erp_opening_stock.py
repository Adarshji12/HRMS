"""Opening stock: entering what the company already holds.

Chosen for what a wrong answer would cost: stock that counts twice, a stock value
at the wrong cost, and serial numbers that cannot be dispatched afterwards.
"""

from __future__ import annotations

from datetime import date, timedelta

from tests.test_erp import API, _item, _released_order, _stock_of, _warehouse, acme, checker, globex, ok, refused  # noqa: F401


def _opening(client, tenant, wh, *lines, **extra):
    return client.post(f"{API}/stock-docs", json={"kind": "opening", "to_warehouse_id": wh["id"], "lines": list(lines), **extra},
                       headers=tenant.headers())


def _post(client, tenant, doc):
    return client.post(f"{API}/stock-docs/{doc['id']}/post", headers=tenant.headers())


def test_a_draft_moves_nothing_and_posting_adds_it_once(client, acme):
    wh, item = _warehouse(client, acme), _item(client, acme)
    doc = ok(_opening(client, acme, wh, {"item_id": item["id"], "quantity": "20", "unit_cost": "700"}, doc_date="2026-04-01"), 201)
    assert doc["number"].startswith("OPN") and doc["value"] == "14000.00" and doc["doc_date"] == "2026-04-01"
    assert ok(client.get(f"{API}/stock", headers=acme.headers())) == []

    doc = ok(_post(client, acme, doc))
    assert doc["status"] == "posted"
    bal = _stock_of(client, acme, item)
    assert bal["quantity"] == "20.000" and bal["avg_cost"] == "700.00" and bal["value"] == "14000.00"
    refused(_post(client, acme, doc), 409, "not_draft")
    assert _stock_of(client, acme, item)["quantity"] == "20.000"

    moves = ok(client.get(f"{API}/stock/movements", headers=acme.headers()))
    assert moves[0]["kind"] == "opening" and moves[0]["ref_number"] == doc["number"]


def test_a_blank_cost_takes_the_items_standard_cost(client, acme):
    wh, item = _warehouse(client, acme), _item(client, acme)
    doc = ok(_opening(client, acme, wh, {"item_id": item["id"], "quantity": "2"}), 201)
    assert doc["lines"][0]["unit_cost"] == f"{float(item['standard_cost']):.2f}"


def test_new_serials_are_created_and_can_then_be_dispatched(client, acme, checker):
    wh, item = _warehouse(client, acme), _item(client, acme, serialized=True)
    doc = ok(_opening(client, acme, wh, {"item_id": item["id"], "quantity": "2", "unit_cost": "100", "serials": ["SN-1", "SN-2"]}), 201)
    ok(_post(client, acme, doc))
    found = ok(client.get(f"{API}/stock/serials", params={"q": "SN-1"}, headers=acme.headers()))
    assert found[0]["status"] == "in_stock" and found[0]["history"][0]["kind"] == "opening"

    _, so = _released_order(client, acme, checker, item, quantity="1")
    ok(client.post(f"{API}/dispatches", json={
        "sales_order_id": so["id"], "warehouse_id": wh["id"],
        "lines": [{"order_line_id": so["lines"][0]["id"], "quantity": "1", "serials": ["SN-1"]}],
    }, headers=acme.headers()), 201)
    assert _stock_of(client, acme, item)["quantity"] == "1.000"


def test_a_serial_already_in_stock_is_refused_whole(client, acme):
    wh, item = _warehouse(client, acme), _item(client, acme, serialized=True)
    line = {"item_id": item["id"], "quantity": "1", "unit_cost": "100", "serials": ["SN-1"]}
    ok(_post(client, acme, ok(_opening(client, acme, wh, line), 201)))
    again = ok(_opening(client, acme, wh, line), 201)
    refused(_post(client, acme, again), 409, "serial_exists")
    assert _stock_of(client, acme, item)["quantity"] == "1.000"


def test_what_is_refused(client, acme):
    wh, item = _warehouse(client, acme), _item(client, acme)
    line = {"item_id": item["id"], "quantity": "1", "unit_cost": "10"}
    refused(_opening(client, acme, wh, {**line, "unit_cost": "-1"}), 422, "negative_cost")
    refused(_opening(client, acme, wh, {**line, "quantity": "-1"}), 422, "negative_quantity")
    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    refused(_opening(client, acme, wh, line, doc_date=tomorrow), 422, "future_date")
    refused(client.post(f"{API}/stock-docs", json={"kind": "opening", "lines": [line]}, headers=acme.headers()), 422, "warehouse_required")
    serial = _item(client, acme, code="SW-48", serialized=True)
    refused(_opening(client, acme, wh, {"item_id": serial["id"], "quantity": "2", "serials": ["ONLY-1"]}), 422, "serial_count")


def test_another_company_cannot_see_or_post_it(client, acme, globex):
    wh, item = _warehouse(client, acme), _item(client, acme)
    doc = ok(_opening(client, acme, wh, {"item_id": item["id"], "quantity": "1", "unit_cost": "10"}), 201)
    assert _post(client, globex, doc).status_code == 404
    assert ok(client.get(f"{API}/stock", headers=globex.headers())) == []
