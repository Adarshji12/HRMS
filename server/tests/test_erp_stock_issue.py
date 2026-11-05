"""Issuing stock: who got it, for which project, and that it really left.

Chosen for what a wrong answer would cost: stock leaving with nobody answerable
for it, reserved stock given away, and a unit that cannot be traced or returned.
"""

from __future__ import annotations

from tests.test_erp import API, _item, _released_order, _stock_of, _warehouse, acme, checker, globex, ok, refused  # noqa: F401


def _in_stock(client, tenant, quantity="10", serials=(), **item):
    wh, it = _warehouse(client, tenant), _item(client, tenant, **item)
    doc = ok(client.post(f"{API}/stock-docs", json={"kind": "opening", "to_warehouse_id": wh["id"], "lines": [
        {"item_id": it["id"], "quantity": quantity, "unit_cost": "100", "serials": list(serials)}]}, headers=tenant.headers()), 201)
    ok(client.post(f"{API}/stock-docs/{doc['id']}/post", headers=tenant.headers()))
    return wh, it


def _issue(client, tenant, wh, item, quantity="4", serials=(), **extra):
    return client.post(f"{API}/stock-docs", json={
        "kind": "issue", "from_warehouse_id": wh["id"], **extra,
        "lines": [{"item_id": item["id"], "quantity": quantity, "serials": list(serials)}],
    }, headers=tenant.headers())


def _project(client, tenant):
    return ok(client.post("/api/v1/projects", json={"name": "Site Alpha"}, headers=tenant.headers()), 201)


def test_issue_says_who_and_which_project_and_stock_leaves(client, acme):
    wh, item = _in_stock(client, acme)
    project = _project(client, acme)
    doc = ok(_issue(client, acme, wh, item, recipient_id=str(acme.owner.id), project_id=project["id"], reason="Site install"), 201)
    assert doc["recipient_name"] == acme.owner.full_name and doc["project_name"] == "Site Alpha"
    assert _stock_of(client, acme, item)["quantity"] == "10.000"
    ok(client.post(f"{API}/stock-docs/{doc['id']}/post", headers=acme.headers()))
    assert _stock_of(client, acme, item)["quantity"] == "6.000"
    move = ok(client.get(f"{API}/stock/movements", headers=acme.headers()))[0]
    assert move["kind"] == "issue" and move["quantity"].startswith("-4") and move["reason"] == "Site install"


def test_an_issue_to_nobody_is_refused(client, acme):
    wh, item = _in_stock(client, acme)
    refused(_issue(client, acme, wh, item), 422, "issue_to_required")
    ok(_issue(client, acme, wh, item, project_id=_project(client, acme)["id"]), 201)
    ok(_issue(client, acme, wh, item, recipient_id=str(acme.owner.id)), 201)


def test_another_companys_people_and_projects_are_refused(client, acme, globex):
    wh, item = _in_stock(client, acme)
    refused(_issue(client, acme, wh, item, recipient_id=str(globex.owner.id)), 422, "bad_recipient")
    assert _issue(client, acme, wh, item, project_id=_project(client, globex)["id"]).status_code == 404


def test_an_archived_project_is_refused(client, acme):
    wh, item = _in_stock(client, acme)
    project = _project(client, acme)
    ok(client.patch(f"/api/v1/projects/{project['id']}", json={"name": "Site Alpha", "status": "archived"}, headers=acme.headers()))
    refused(_issue(client, acme, wh, item, project_id=project["id"]), 409, "project_archived")
    assert project["id"] not in [p["id"] for p in ok(client.get(f"{API}/stock-docs/parties", headers=acme.headers()))["projects"]]


def test_parties_lists_this_company_only(client, acme, globex):
    _project(client, acme)
    got = ok(client.get(f"{API}/stock-docs/parties", headers=globex.headers()))
    assert [p["name"] for p in got["projects"]] == []
    assert str(acme.owner.id) not in [p["id"] for p in got["people"]]
    refused(client.get(f"{API}/stock-docs/parties", headers=acme.headers(acme.employee_token)), 403)


def test_more_than_is_there_is_refused_and_nothing_moves(client, acme):
    wh, item = _in_stock(client, acme, quantity="3")
    doc = ok(_issue(client, acme, wh, item, quantity="4", recipient_id=str(acme.owner.id)), 201)
    refused(client.post(f"{API}/stock-docs/{doc['id']}/post", headers=acme.headers()), 409, "insufficient_stock")
    assert _stock_of(client, acme, item)["quantity"] == "3.000"


def test_reserved_stock_cannot_be_issued(client, acme, checker):
    wh, item = _in_stock(client, acme, quantity="10")
    _, so = _released_order(client, acme, checker, item, quantity="8")
    ok(client.post(f"{API}/sales-orders/{so['id']}/reserve", json={"warehouse_id": wh["id"]}, headers=acme.headers()))
    doc = ok(_issue(client, acme, wh, item, quantity="4", recipient_id=str(acme.owner.id)), 201)
    refused(client.post(f"{API}/stock-docs/{doc['id']}/post", headers=acme.headers()), 409, "stock_reserved")
    assert _stock_of(client, acme, item)["quantity"] == "10.000"


def test_an_issued_serial_leaves_and_can_come_back(client, acme):
    wh, item = _in_stock(client, acme, quantity="2", serials=("SN-1", "SN-2"), serialized=True)
    doc = ok(_issue(client, acme, wh, item, quantity="1", serials=("SN-1",), recipient_id=str(acme.owner.id)), 201)
    ok(client.post(f"{API}/stock-docs/{doc['id']}/post", headers=acme.headers()))
    left = ok(client.get(f"{API}/stock/serials/available", params={"item_id": item["id"], "warehouse_id": wh["id"]}, headers=acme.headers()))
    assert left == ["SN-2"]
    unit = ok(client.get(f"{API}/stock/serials", params={"q": "SN-1"}, headers=acme.headers()))[0]
    assert unit["status"] == "issued" and unit["warehouse_name"] is None

    back = ok(client.post(f"{API}/stock-docs", json={"kind": "return", "to_warehouse_id": wh["id"], "lines": [
        {"item_id": item["id"], "quantity": "1", "serials": ["SN-1"]}]}, headers=acme.headers()), 201)
    ok(client.post(f"{API}/stock-docs/{back['id']}/post", headers=acme.headers()))
    assert _stock_of(client, acme, item)["quantity"] == "2.000"


def test_a_serial_that_is_not_there_is_refused(client, acme):
    wh, item = _in_stock(client, acme, quantity="1", serials=("SN-1",), serialized=True)
    doc = ok(_issue(client, acme, wh, item, quantity="1", serials=("SN-9",), recipient_id=str(acme.owner.id)), 201)
    refused(client.post(f"{API}/stock-docs/{doc['id']}/post", headers=acme.headers()), 409, "serial_not_here")
