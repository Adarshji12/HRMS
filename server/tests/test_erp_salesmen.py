"""Salesman master: create, validate, the ledger count, rename, delete, tenant isolation."""

from __future__ import annotations

from tests.test_erp import API, acme, globex, ok, refused  # noqa: F401


def _man(**extra) -> dict:
    return {"name": "Ravi Kumar", "mobile": "98765 43210", "area_beat": "Sanganer, Tonk Road",
            "commission_pct": "2.5", "monthly_target": "100000", **extra}


def test_salesman_gets_a_code_and_counts_its_ledgers(client, acme):
    row = ok(client.post(f"{API}/salesmen", json=_man(), headers=acme.headers()), 201)
    assert row["code"].startswith("SM") and row["mobile"] == "9876543210" and row["ledgers"] == 0
    ok(client.post(f"{API}/ledgers", json={"name": "Gupta Medical", "account_group": "Sundry Debtors",
                                           "salesman": "Ravi Kumar"}, headers=acme.headers()), 201)
    rows = ok(client.get(f"{API}/salesmen", headers=acme.headers()))
    assert rows[0]["ledgers"] == 1
    # Renaming carries over to the ledgers.
    ok(client.put(f"{API}/salesmen/{row['id']}", json=_man(name="Ravi K."), headers=acme.headers()))
    assert ok(client.get(f"{API}/ledgers", headers=acme.headers()))[0]["salesman"] == "Ravi K."
    # One with ledgers cannot be deleted.
    refused(client.delete(f"{API}/salesmen/{row['id']}", headers=acme.headers()), 409, "salesman_in_use")


def test_salesman_validation_and_duplicates(client, acme):
    for bad in ({"mobile": "123"}, {"email": "ravi"}, {"commission_pct": "120"}, {"monthly_target": "-1"}):
        refused(client.post(f"{API}/salesmen", json=_man(**bad), headers=acme.headers()), 422)
    ok(client.post(f"{API}/salesmen", json=_man(), headers=acme.headers()), 201)
    refused(client.post(f"{API}/salesmen", json=_man(name="ravi kumar"), headers=acme.headers()), 409, "duplicate_salesman")


def test_salesman_filter_delete_and_isolation(client, acme, globex):
    row = ok(client.post(f"{API}/salesmen", json=_man(is_active=False), headers=acme.headers()), 201)
    assert ok(client.get(f"{API}/salesmen", params={"active": "true"}, headers=acme.headers())) == []
    assert len(ok(client.get(f"{API}/salesmen", params={"active": "false"}, headers=acme.headers()))) == 1
    assert ok(client.get(f"{API}/salesmen", headers=globex.headers())) == []
    assert client.put(f"{API}/salesmen/{row['id']}", json=_man(), headers=globex.headers()).status_code == 404
    assert client.delete(f"{API}/salesmen/{row['id']}", headers=acme.headers()).status_code == 204
