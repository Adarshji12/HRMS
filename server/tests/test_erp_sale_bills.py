"""Sale bills raised against a ledger or a walk-in customer."""

from __future__ import annotations

from tests.test_erp import API, _item, _warehouse, acme, globex, ok, refused  # noqa: F401


def _ledger(client, tenant, name="Gupta Medical"):
    return ok(client.post(f"{API}/ledgers", json={"name": name, "account_group": "Sundry Debtors"}, headers=tenant.headers()), 201)


def test_bill_is_totalled_numbered_and_listed(client, acme):
    led, wh, item = _ledger(client, acme), _warehouse(client, acme), _item(client, acme, code="CH-1")
    bill = ok(client.post(f"{API}/sale-bills", json={
        "ledger_id": led["id"], "warehouse_id": wh["id"], "bill_type": "credit",
        "lines": [{"item_id": item["id"], "description": "Chips", "quantity": "10", "rate": "100", "discount_percent": "10", "gst_percent": "18"},
                  {"description": "Carry bag", "quantity": "1", "rate": "50", "gst_percent": "0"}]}, headers=acme.headers()), 201)
    assert bill["party_name"] == "Gupta Medical" and bill["number"].startswith("SB/")
    # 10 x 100 less 10% = 900 + 18% = 1062; 50 untaxed.
    assert bill["sub_total"] == "950.00" and bill["tax_total"] == "162.00" and bill["grand_total"] == "1112.00"
    assert bill["discount_total"] == "100.00" and len(bill["lines"]) == 2
    second = ok(client.post(f"{API}/sale-bills", json={"ledger_id": led["id"], "lines": [{"description": "x", "quantity": "1", "rate": "1"}]}, headers=acme.headers()), 201)
    assert second["number"].endswith("/0002")
    assert len(ok(client.get(f"{API}/sale-bills", headers=acme.headers()))) == 2
    assert ok(client.get(f"{API}/sale-bills/{bill['id']}", headers=acme.headers()))["lines"][0]["lot_no"] is None


def test_walkin_bill_needs_a_party_and_stays_in_the_company(client, acme, globex):
    line = {"description": "x", "quantity": "1", "rate": "10"}
    refused(client.post(f"{API}/sale-bills", json={"lines": [line]}, headers=acme.headers()), 422, "party_required")
    anon = ok(client.post(f"{API}/sale-bills", json={"walkin_bill": True, "bill_type": "cash", "lines": [line]}, headers=acme.headers()), 201)
    assert anon["party_name"] == "Walk-in Customer"
    walkin = ok(client.post(f"{API}/walkin-customers", json={"name": "Ravi", "mobile": "9876543210"}, headers=acme.headers()), 201)
    named = ok(client.post(f"{API}/sale-bills", json={"walkin_id": walkin["id"], "lines": [line]}, headers=acme.headers()), 201)
    assert named["party_name"] == "Ravi"
    ravi = ok(client.get(f"{API}/walkin-customers", headers=acme.headers()))[0]
    assert ravi["bills"] == 1 and ravi["total_bought"] == "10.00" and ravi["last_bill"] == named["bill_date"]
    refused(client.post(f"{API}/sale-bills", json={"walkin_id": walkin["id"], "lines": [line]}, headers=globex.headers()), 404)
    assert ok(client.get(f"{API}/sale-bills", headers=globex.headers())) == []
    refused(client.get(f"{API}/sale-bills/{anon['id']}", headers=globex.headers()), 404)


def test_invoice_for_a_walkin_uses_their_name(client, acme):
    line = {"description": "Repair", "quantity": "1", "rate": "500"}
    refused(client.post(f"{API}/invoices", json={"kind": "service", "lines": [line]}, headers=acme.headers()), 422, "party_required")
    walkin = ok(client.post(f"{API}/walkin-customers", json={"name": "Ravi", "mobile": "9876543210"}, headers=acme.headers()), 201)
    named = ok(client.post(f"{API}/invoices", json={"kind": "service", "walkin_id": walkin["id"], "lines": [line]}, headers=acme.headers()), 201)
    anon = ok(client.post(f"{API}/invoices", json={"kind": "service", "walkin_bill": True, "lines": [line]}, headers=acme.headers()), 201)
    assert named["customer_name"] == "Ravi" and anon["customer_name"] == "Walk-in Customer"
    assert named["customer_id"] == anon["customer_id"]


def test_quotation_has_its_own_series_and_list(client, acme):
    led = _ledger(client, acme)
    line = {"description": "Chips", "quantity": "2", "rate": "6"}
    q = ok(client.post(f"{API}/sale-bills", json={"doc_type": "quotation", "valid_till": "2026-12-09", "ledger_id": led["id"], "lines": [line]}, headers=acme.headers()), 201)
    assert q["number"].startswith("QT-") and q["doc_type"] == "quotation" and q["status"] == "open" and q["valid_till"] == "2026-12-09"
    bill = ok(client.post(f"{API}/sale-bills", json={"ledger_id": led["id"], "lines": [line]}, headers=acme.headers()), 201)
    assert bill["number"].startswith("SB/")
    assert [r["id"] for r in ok(client.get(f"{API}/sale-bills", headers=acme.headers()))] == [bill["id"]]
    assert [r["id"] for r in ok(client.get(f"{API}/sale-bills?doc_type=quotation", headers=acme.headers()))] == [q["id"]]


def test_return_and_stock_issue_take_their_numbers_from_the_bill_series(client, acme):
    led = _ledger(client, acme)
    line = {"description": "Chips", "quantity": "2", "rate": "6"}
    ret = ok(client.post(f"{API}/sale-bills", json={"doc_type": "return", "ledger_id": led["id"], "against_number": "INV-2026-27-0001", "lines": [line]}, headers=acme.headers()), 201)
    assert ret["number"].startswith("CN-") and ret["against_number"] == "INV-2026-27-0001"
    issue = ok(client.post(f"{API}/sale-bills", json={"doc_type": "issue", "issued_to": "Main store", "lines": [line]}, headers=acme.headers()), 201)
    assert issue["number"].startswith("SI-") and issue["party_name"] == "Main store"
    again = ok(client.post(f"{API}/sale-bills", json={"doc_type": "issue", "issued_to": "Main store", "lines": [line]}, headers=acme.headers()), 201)
    assert again["number"] != issue["number"]


def test_the_form_is_shown_the_generated_number_before_saving_and_gets_that_number(client, acme):
    led = _ledger(client, acme)
    line = {"description": "Chips", "quantity": "2", "rate": "6"}
    shown = ok(client.get(f"{API}/sale-bills/next-number?doc_type=return", headers=acme.headers()))["number"]
    assert shown.startswith("CN-")
    # Asking does not use the number up.
    assert ok(client.get(f"{API}/sale-bills/next-number?doc_type=return", headers=acme.headers()))["number"] == shown
    saved = ok(client.post(f"{API}/sale-bills", json={"doc_type": "return", "ledger_id": led["id"], "lines": [line]}, headers=acme.headers()), 201)
    assert saved["number"] == shown
    assert ok(client.get(f"{API}/sale-bills/next-number?doc_type=return", headers=acme.headers()))["number"] != shown
