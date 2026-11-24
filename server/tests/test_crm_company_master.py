"""Company master (item-companies): the fields beyond a name."""

from __future__ import annotations

from tests.test_crm import acme  # noqa: F401

URL = "/api/v1/crm/masters/item-companies"


def test_company_keeps_contacts_margin_and_days(client, acme):
    body = {
        "name": "Cipla Ltd", "short_name": "CIPLA", "min_margin_pct": "12.5", "expiry_receive_days": 90, "dump_days": 30,
        "website": "www.cipla.com", "notes": "Takes back expired stock",
        "contacts": [{"name": "Asha", "mobile": "+91 98765 43210", "email": "asha@cipla.com"}, {"name": "", "mobile": "", "email": ""}],
    }
    r = client.post(URL, json=body, headers=acme.headers())
    assert r.status_code == 201, r.text
    row = r.json()
    assert row["short_name"] == "CIPLA" and row["expiry_receive_days"] == 90 and row["dump_days"] == 30
    assert row["contacts"] == [{"name": "Asha", "mobile": "9876543210", "email": "asha@cipla.com"}]  # blank row dropped
    got = client.get(URL, headers=acme.headers()).json()[0]
    assert got["website"] == "www.cipla.com"


def test_company_rejects_a_bad_contact_or_margin(client, acme):
    for bad in ({"contacts": [{"mobile": "123"}]}, {"contacts": [{"email": "asha"}]}, {"min_margin_pct": "150"}, {"dump_days": -1}):
        assert client.post(URL, json={"name": "X", **bad}, headers=acme.headers()).status_code == 422
