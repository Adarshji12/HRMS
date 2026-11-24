"""Walk-in customers: create, validate, filter, edit, delete, tenant isolation."""

from __future__ import annotations

from tests.test_erp import API, acme, globex, ok, refused  # noqa: F401


def _w(**extra) -> dict:
    return {"name": "Asha Verma", "mobile": "+91 98765 43210", "email": "asha@example.com", **extra}


def test_walkin_is_created_and_cleaned(client, acme):
    row = ok(client.post(f"{API}/walkin-customers", json=_w(), headers=acme.headers()), 201)
    assert row["mobile"] == "9876543210" and row["bills"] == 0
    out = ok(client.put(f"{API}/walkin-customers/{row['id']}", json=_w(remark="Prefers evenings"), headers=acme.headers()))
    assert out["remark"] == "Prefers evenings"
    assert [r["id"] for r in ok(client.get(f"{API}/walkin-customers", params={"q": "asha"}, headers=acme.headers()))] == [row["id"]]


def test_walkin_validation_and_duplicate_mobile(client, acme):
    for bad in ({"mobile": "12"}, {"email": "asha"}, {"dob": "2999-01-01"}):
        refused(client.post(f"{API}/walkin-customers", json=_w(**bad), headers=acme.headers()), 422)
    ok(client.post(f"{API}/walkin-customers", json=_w(), headers=acme.headers()), 201)
    refused(client.post(f"{API}/walkin-customers", json=_w(name="Another"), headers=acme.headers()), 409, "duplicate_walkin")


def test_walkin_filter_delete_and_isolation(client, acme, globex):
    row = ok(client.post(f"{API}/walkin-customers", json=_w(is_active=False), headers=acme.headers()), 201)
    assert ok(client.get(f"{API}/walkin-customers", params={"active": "true"}, headers=acme.headers())) == []
    assert ok(client.get(f"{API}/walkin-customers", headers=globex.headers())) == []
    assert client.put(f"{API}/walkin-customers/{row['id']}", json=_w(), headers=globex.headers()).status_code == 404
    assert client.delete(f"{API}/walkin-customers/{row['id']}", headers=acme.headers()).status_code == 204
