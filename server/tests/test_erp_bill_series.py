"""Bill series: one default per transaction, next number only forward, party groups, delete rules."""

from __future__ import annotations

from tests.test_erp import API, acme, globex, ok, refused  # noqa: F401


def _series(txn="sales_invoice", **extra) -> dict:
    return {"transaction": txn, "name": "Retail", "prefix": "R/", "digits": 4, "restart": "april", "next_number": 1, **extra}


def _all(client, tenant) -> dict:
    return ok(client.get(f"{API}/bill-series", headers=tenant.headers()))


def test_every_transaction_starts_with_one_default_series(client, acme):
    data = _all(client, acme)
    assert len(data["transactions"]) == 16
    inv = [s for s in data["series"] if s["transaction"] == "sales_invoice"]
    assert len(inv) == 1 and inv[0]["name"] == "Default" and inv[0]["prefix"] == "INV-" and inv[0]["is_default"] is True


def test_a_new_default_replaces_the_old_one_and_party_groups_move(client, acme):
    _all(client, acme)
    a = ok(client.post(f"{API}/bill-series", json=_series(default_groups=["Sundry Debtors"]), headers=acme.headers()), 201)
    assert a["is_default"] is False
    b = ok(client.post(f"{API}/bill-series", json=_series(name="Wholesale", is_default=True, default_groups=["Sundry Debtors"]), headers=acme.headers()), 201)
    rows = {s["name"]: s for s in _all(client, acme)["series"] if s["transaction"] == "sales_invoice"}
    assert rows["Wholesale"]["is_default"] is True and rows["Default"]["is_default"] is False
    assert rows["Retail"]["default_groups"] == [] and rows["Wholesale"]["default_groups"] == ["Sundry Debtors"]
    assert b["id"] == rows["Wholesale"]["id"]


def test_a_series_keeps_its_billing_type_paper_layout_and_users(client, acme):
    _all(client, acme)
    me = ok(client.get("/api/v1/auth/me", headers=acme.headers()))
    row = ok(client.post(f"{API}/bill-series", json=_series(billing_type="wholesale", paper="thermal_3", print_layout="Executive Dark",
                                                            user_ids=[me["id"]]), headers=acme.headers()), 201)
    assert row["billing_type"] == "wholesale" and row["paper"] == "thermal_3" and row["print_layout"] == "Executive Dark"
    assert row["user_ids"] == [me["id"]]
    refused(client.post(f"{API}/bill-series", json=_series(name="X", paper="folio"), headers=acme.headers()), 422)
    refused(client.post(f"{API}/bill-series", json=_series(name="Y", user_ids=["00000000-0000-0000-0000-000000000001"]),
                        headers=acme.headers()), 422, "bad_user")


def test_the_next_number_only_moves_forward_and_names_are_unique(client, acme):
    _all(client, acme)
    a = ok(client.post(f"{API}/bill-series", json=_series(next_number=10), headers=acme.headers()), 201)
    refused(client.put(f"{API}/bill-series/{a['id']}", json=_series(next_number=5), headers=acme.headers()), 422, "next_only_forward")
    ok(client.put(f"{API}/bill-series/{a['id']}", json=_series(next_number=20), headers=acme.headers()))
    refused(client.post(f"{API}/bill-series", json=_series(name="retail"), headers=acme.headers()), 409, "duplicate")
    refused(client.post(f"{API}/bill-series", json=_series(txn="nope"), headers=acme.headers()), 422, "bad_transaction")


def test_delete_rules_and_isolation(client, acme, globex):
    data = _all(client, acme)
    default = next(s for s in data["series"] if s["transaction"] == "quotation")
    refused(client.delete(f"{API}/bill-series/{default['id']}", headers=acme.headers()), 409, "last_series")
    extra = ok(client.post(f"{API}/bill-series", json=_series("quotation", name="Online"), headers=acme.headers()), 201)
    refused(client.delete(f"{API}/bill-series/{default['id']}", headers=acme.headers()), 409, "default_series")
    refused(client.put(f"{API}/bill-series/{default['id']}", json=_series("quotation", name="Default", is_default=True, is_active=False), headers=acme.headers()), 422, "default_inactive")
    assert client.delete(f"{API}/bill-series/{extra['id']}", headers=acme.headers()).status_code == 204
    assert client.put(f"{API}/bill-series/{default['id']}", json=_series("quotation", name="Default"), headers=globex.headers()).status_code == 404
