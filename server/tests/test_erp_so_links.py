"""What an order hands on: the invoice's due date, terms and shipping come from the
order that was agreed, and an accepted quotation reaches the order whole.

Chosen for what a wrong answer would cost: a due date that makes an invoice
overdue on the wrong day, and terms the customer never agreed printed on a bill.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from app.services.erp.billing import _days_from_terms
from tests.test_erp import API, _customer, _released_order, _stocked, acme, checker, globex, ok  # noqa: F401


@pytest.mark.parametrize("terms,days", [
    ("Net 15 days", 15), ("45 days", 45), ("50% advance, balance in 30 days", 30),
    ("100% advance", 0), ("Due on receipt", 0), ("Within 1 day of delivery", 1),
    ("As agreed with the buyer", 60), ("", 60), (None, 60),
])
def test_days_from_terms(terms, days):
    assert _days_from_terms(terms, 60) == days


def _ship_and_bill(client, acme, checker, **order):
    wh, item = _stocked(client, acme, checker, quantity="10")
    _, so = _released_order(client, acme, checker, item, quantity="2", **order)
    d = ok(client.post(f"{API}/dispatches", json={
        "sales_order_id": so["id"], "warehouse_id": wh["id"],
        "lines": [{"order_line_id": so["lines"][0]["id"], "quantity": "2"}],
    }, headers=acme.headers()), 201)
    return ok(client.post(f"{API}/invoices/from-dispatch", json={"dispatch_id": d["id"]}, headers=acme.headers()), 201)


def test_an_invoice_takes_what_the_order_agreed(client, acme, checker):
    inv = _ship_and_bill(client, acme, checker, payment_terms="Net 15 days", terms="Warranty one year",
                         shipping_address="Plot 9, Pune")
    assert inv["due_date"] == (date.today() + timedelta(days=15)).isoformat()
    assert inv["terms"] == "Warranty one year"
    assert inv["shipping_address"] == "Plot 9, Pune"


def test_an_order_without_a_period_uses_the_customers_credit_days(client, acme, checker):
    inv = _ship_and_bill(client, acme, checker, payment_terms="As agreed with the buyer")
    credit = ok(client.get(f"{API}/customers", headers=acme.headers()))[0]["account"]["credit_days"]
    assert inv["due_date"] == (date.today() + timedelta(days=credit)).isoformat()


def test_a_bill_with_no_order_is_unchanged(client, acme):
    customer = _customer(client, acme)
    inv = ok(client.post(f"{API}/invoices", json={
        "kind": "service", "customer_id": customer["id"],
        "lines": [{"description": "AMC visit", "quantity": "1", "rate": "1000"}],
    }, headers=acme.headers()), 201)
    assert inv["shipping_address"] is None and inv["salesperson_id"] is None


def test_an_accepted_quotation_reaches_the_order_whole(client, acme):
    customer = _customer(client, acme)
    quote = client.post("/api/v1/crm/quotations", json={
        "quote_date": date.today().isoformat(), "customer_id": customer["id"], "customer_name": customer["name"],
        "payment_terms": "Net 15 days", "delivery_terms": "D" * 300, "terms": "Valid for GST invoices only",
        "warranty_terms": "One year onsite", "lines": [{"name": "Thing", "rate": "100", "quantity": "1"}],
    }, headers=acme.headers())
    assert quote.status_code == 201, quote.text
    quote = quote.json()
    client.post(f"/api/v1/crm/quotations/{quote['id']}/status", json={"status": "accepted"}, headers=acme.headers())
    so = ok(client.post(f"{API}/sales-orders/from-quotation", json={"quotation_id": quote["id"]}, headers=acme.headers()), 201)
    assert so["payment_terms"] == "Net 15 days"
    # Longer than the order's field: cut, not refused.
    assert len(so["delivery_terms"]) == 160 and so["delivery_terms"].endswith("…")
    assert so["terms"] == "Valid for GST invoices only\n\nOne year onsite"
    assert so["salesperson_id"] == quote["created_by"]


def test_the_order_page_reports_its_transporter(client, acme, checker):
    """The dispatch form starts from this, so it must reach the page."""
    _, item = _stocked(client, acme, checker, quantity="10")
    _, so = _released_order(client, acme, checker, item, quantity="2", transporter_name="VRL Logistics")
    assert ok(client.get(f"{API}/sales-orders/{so['id']}", headers=acme.headers()))["transporter_name"] == "VRL Logistics"
