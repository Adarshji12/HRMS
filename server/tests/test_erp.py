"""ERP phase one: the journeys, and the controls the PRD puts around them.

Chosen for the failures that would hurt rather than for coverage:

* procure-to-pay end to end — requisition, RFQ, award, PO, GRN — with stock
  arriving at the right cost,
* segregation of duties: nobody approves what they raised, owner included,
* the stock ledger refusing negative stock and protecting reservations,
* serials that must be where the system thinks they are,
* order-to-cash: order, reserve, dispatch, invoice, receipt, credit note —
  and the guard against billing the same dispatch twice,
* credit hold blocking release,
* tenant isolation, as everywhere in this suite.
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta

import pytest

from app.core.security import create_access_token, generate_enrollment_key, hash_password
from app.db.session import SessionLocal
from app.models import User

API = "/api/v1/erp"


@pytest.fixture
def acme(tenants):
    return tenants[0]


@pytest.fixture
def globex(tenants):
    return tenants[1]


@pytest.fixture
def checker(acme) -> dict[str, str]:
    """A second administrator — the person who approves what the owner raises."""
    with SessionLocal() as db:
        user = User(
            id=uuid.uuid4(), org_id=acme.id, email="checker@acme.test", full_name="Acme Checker",
            role="admin", password_hash=hash_password("correct-horse-battery"), is_active=True,
            enrollment_key=generate_enrollment_key(),
        )
        db.add(user)
        db.commit()
        token = create_access_token(str(user.id), {"typ": "user", "org": str(acme.id), "role": "admin"})
    return acme.headers(token)


def ok(response, code: int = 200) -> dict:
    assert response.status_code == code, response.text
    return response.json()


def refused(response, code: int, reason: str | None = None) -> None:
    assert response.status_code == code, response.text
    if reason:
        assert response.json()["detail"]["reason"] == reason, response.text


def _warehouse(client, tenant, code="MUM", name="Mumbai Central") -> dict:
    return ok(client.post(f"{API}/warehouses", json={"code": code, "name": name}, headers=tenant.headers()), 201)


def _item(client, tenant, code="SW-24", serialized=False, **extra) -> dict:
    payload = {"code": code, "name": f"Switch {code}", "uom": "Nos", "gst_percent": "18",
               "standard_cost": "1000", "sale_price": "1500", "is_serialized": serialized, **extra}
    return ok(client.post(f"{API}/items", json=payload, headers=tenant.headers()), 201)


def _active_vendor(client, tenant, checker_headers, name="Tech Distributors Pvt Ltd", pan="AAACT1234F") -> dict:
    vendor = ok(client.post(f"{API}/vendors", json={"legal_name": name, "pan": pan}, headers=tenant.headers()), 201)
    ok(client.post(f"{API}/vendors/{vendor['id']}/submit", headers=tenant.headers()))
    return ok(client.post(f"{API}/vendors/{vendor['id']}/decide", json={"approve": True}, headers=checker_headers))


def _approved_po(client, tenant, checker_headers, vendor, item, quantity="10", rate="1000", **extra) -> dict:
    po = ok(client.post(f"{API}/purchase-orders", json={
        "vendor_id": vendor["id"], "lines": [{"item_id": item["id"], "quantity": quantity, "rate": rate}], **extra,
    }, headers=tenant.headers()), 201)
    ok(client.post(f"{API}/purchase-orders/{po['id']}/submit", headers=tenant.headers()))
    return ok(client.post(f"{API}/purchase-orders/{po['id']}/decide", json={"approve": True}, headers=checker_headers))


def _receive(client, tenant, po, warehouse, quantity, serials=(), **extra) -> dict:
    return client.post(f"{API}/goods-receipts", json={
        "purchase_order_id": po["id"], "warehouse_id": warehouse["id"],
        "lines": [{"po_line_id": po["lines"][0]["id"], "received_qty": quantity, "serials": list(serials)}],
        **extra,
    }, headers=tenant.headers())


def _customer(client, tenant) -> dict:
    return ok(client.post("/api/v1/crm/customers", json={"name": "Advotalk", "mobile": "919599322060"},
                          headers=tenant.headers()), 201)


def _stock_of(client, tenant, item) -> dict:
    rows = ok(client.get(f"{API}/stock", params={"item_id": item["id"]}, headers=tenant.headers()))
    return rows[0] if rows else {}


# --------------------------------------------------------------------------- #
# Masters
# --------------------------------------------------------------------------- #


def test_vendor_needs_a_second_person_to_activate(client, acme, checker):
    vendor = ok(client.post(f"{API}/vendors", json={"legal_name": "Solo Traders", "pan": "AAACS1234F"},
                            headers=acme.headers()), 201)
    ok(client.post(f"{API}/vendors/{vendor['id']}/submit", headers=acme.headers()))
    # The creator — even the owner — cannot approve their own vendor.
    refused(client.post(f"{API}/vendors/{vendor['id']}/decide", json={"approve": True}, headers=acme.headers()),
            403, "self_review")
    out = ok(client.post(f"{API}/vendors/{vendor['id']}/decide", json={"approve": True}, headers=checker))
    assert out["status"] == "active"


def test_vendor_duplicates_and_bad_tax_ids_are_refused(client, acme):
    ok(client.post(f"{API}/vendors", json={"legal_name": "Alpha Ltd", "pan": "AAACA1234F"}, headers=acme.headers()), 201)
    refused(client.post(f"{API}/vendors", json={"legal_name": "Alpha Two", "pan": "AAACA1234F"},
                        headers=acme.headers()), 409, "duplicate_vendor")
    refused(client.post(f"{API}/vendors", json={"legal_name": "Beta", "gstin": "NOT-A-GSTIN"},
                        headers=acme.headers()), 422, "bad_gstin")


def test_bank_details_are_maker_checker_and_masked(client, acme, checker):
    vendor = _active_vendor(client, acme, checker)
    out = ok(client.post(f"{API}/vendors/{vendor['id']}/banks", json={
        "account_name": "Tech Distributors", "account_number": "123456789012", "ifsc": "HDFC0001234",
    }, headers=acme.headers()), 201)
    bank = out["banks"][0]
    assert bank["account_number"] == "••••9012" and bank["status"] == "pending"
    refused(client.post(f"{API}/vendors/{vendor['id']}/banks/{bank['id']}/verify", json={"approve": True},
                        headers=acme.headers()), 403, "self_review")
    out = ok(client.post(f"{API}/vendors/{vendor['id']}/banks/{bank['id']}/verify", json={"approve": True},
                         headers=checker))
    assert out["banks"][0]["status"] == "verified"


def test_employee_without_a_role_reaches_nothing(client, acme):
    staff = acme.headers(acme.employee_token)
    refused(client.post(f"{API}/items", json={"code": "X", "name": "X"}, headers=staff), 403, "permission_denied")
    access = ok(client.get(f"{API}/access", headers=staff))
    assert not any(access.values())
    # ...but anybody may raise a requisition.
    ok(client.post(f"{API}/requisitions", json={
        "title": "Laptop bag", "lines": [{"description": "Laptop bag", "quantity": "1"}],
    }, headers=staff), 201)


# --------------------------------------------------------------------------- #
# Procure to pay
# --------------------------------------------------------------------------- #


def test_procure_to_pay_end_to_end(client, acme, checker):
    wh = _warehouse(client, acme)
    item = _item(client, acme)
    v1 = _active_vendor(client, acme, checker)
    v2 = _active_vendor(client, acme, checker, name="Cheaper Supplies", pan="AAACC1234F")

    staff = acme.headers(acme.employee_token)
    req = ok(client.post(f"{API}/requisitions", json={
        "title": "Switches for Pune rollout", "warehouse_id": wh["id"],
        "lines": [{"item_id": item["id"], "quantity": "10", "estimated_rate": "1000"}],
    }, headers=staff), 201)
    assert req["estimated_total"] == "10000.00"
    ok(client.post(f"{API}/requisitions/{req['id']}/submit", headers=staff))
    req = ok(client.post(f"{API}/requisitions/{req['id']}/decide", json={"approve": True}, headers=acme.headers()))
    assert req["status"] == "approved"

    rfq = ok(client.post(f"{API}/rfqs", json={"title": "Switches", "requisition_id": req["id"],
                                             "vendor_ids": [v1["id"], v2["id"]]}, headers=acme.headers()), 201)
    ok(client.post(f"{API}/rfqs/{rfq['id']}/issue", headers=acme.headers()))
    line_id = rfq["lines"][0]["id"]
    for vendor, rate in ((v1, "950"), (v2, "900")):
        ok(client.post(f"{API}/rfqs/{rfq['id']}/quotes", json={
            "vendor_id": vendor["id"], "lines": [{"rfq_line_id": line_id, "rate": rate}],
        }, headers=acme.headers()), 201)
    comparison = ok(client.get(f"{API}/rfqs/{rfq['id']}/comparison", headers=acme.headers()))
    assert comparison["quotes"][0]["vendor_id"] == v2["id"] and comparison["quotes"][0]["is_lowest"]

    dearer = next(q for q in comparison["quotes"] if q["vendor_id"] == v1["id"])
    # Choosing the dearer quote needs a reason.
    refused(client.post(f"{API}/rfqs/{rfq['id']}/award", json={"quote_id": dearer["id"]},
                        headers=acme.headers()), 422, "reason_required")
    ok(client.post(f"{API}/rfqs/{rfq['id']}/award", json={"quote_id": comparison["quotes"][0]["id"]},
                   headers=acme.headers()))

    po = ok(client.post(f"{API}/rfqs/{rfq['id']}/purchase-order", headers=acme.headers()), 201)
    assert po["vendor_id"] == v2["id"] and po["lines"][0]["rate"] == "900.00"
    assert po["grand_total"] == "10620.00"  # 9000 + 18% GST
    ok(client.post(f"{API}/purchase-orders/{po['id']}/submit", headers=acme.headers()))
    refused(client.post(f"{API}/purchase-orders/{po['id']}/decide", json={"approve": True},
                        headers=acme.headers()), 403, "self_review")
    po = ok(client.post(f"{API}/purchase-orders/{po['id']}/decide", json={"approve": True}, headers=checker))
    assert po["status"] == "approved"
    req = ok(client.get(f"{API}/requisitions/{req['id']}", headers=acme.headers()))
    assert req["status"] == "closed"  # fully ordered

    grn = ok(_receive(client, acme, po, wh, "6"), 201)
    assert grn["status"] == "posted"
    po = ok(client.get(f"{API}/purchase-orders/{po['id']}", headers=acme.headers()))
    assert po["status"] == "partially_received"
    bal = _stock_of(client, acme, item)
    assert bal["quantity"] == "6.000" and bal["avg_cost"] == "900.00"

    # More than is still due is refused with the default 0% tolerance.
    refused(_receive(client, acme, po, wh, "5"), 422, "over_receipt")
    ok(_receive(client, acme, po, wh, "4"), 201)
    po = ok(client.get(f"{API}/purchase-orders/{po['id']}", headers=acme.headers()))
    assert po["status"] == "received"


def test_inactive_vendor_cannot_be_ordered_from(client, acme, checker):
    vendor = ok(client.post(f"{API}/vendors", json={"legal_name": "Unapproved Co", "pan": "AAACU1234F"},
                            headers=acme.headers()), 201)
    item = _item(client, acme)
    refused(client.post(f"{API}/purchase-orders", json={
        "vendor_id": vendor["id"], "lines": [{"item_id": item["id"], "quantity": "1", "rate": "10"}],
    }, headers=acme.headers()), 409, "vendor_not_active")


def test_late_delivery_accrues_liquidated_damages(client, acme, checker):
    wh = _warehouse(client, acme)
    item = _item(client, acme)
    vendor = _active_vendor(client, acme, checker)
    po = _approved_po(client, acme, checker, vendor, item, quantity="10", rate="1000",
                      order_date=(date.today() - timedelta(days=30)).isoformat(),
                      expected_date=(date.today() - timedelta(days=10)).isoformat(),
                      ld_percent_per_week="1", ld_cap_percent="5")
    grn = ok(_receive(client, acme, po, wh, "10"), 201)
    assert grn["days_late"] == 10
    assert grn["ld_amount"] == "200.00"  # 2 weeks × 1% × 10,000
    po = ok(client.get(f"{API}/purchase-orders/{po['id']}", headers=acme.headers()))
    assert po["ld_amount"] == "200.00"


def test_grn_reversal_puts_stock_back(client, acme, checker):
    wh = _warehouse(client, acme)
    item = _item(client, acme)
    vendor = _active_vendor(client, acme, checker)
    po = _approved_po(client, acme, checker, vendor, item, quantity="5")
    grn = ok(_receive(client, acme, po, wh, "5"), 201)
    refused(client.post(f"{API}/goods-receipts/{grn['id']}/reverse", json={}, headers=acme.headers()),
            422, "reason_required")
    ok(client.post(f"{API}/goods-receipts/{grn['id']}/reverse", json={"reason": "Wrong PO"}, headers=acme.headers()))
    assert _stock_of(client, acme, item) == {}
    po = ok(client.get(f"{API}/purchase-orders/{po['id']}", headers=acme.headers()))
    assert po["status"] == "approved"


# --------------------------------------------------------------------------- #
# Inventory
# --------------------------------------------------------------------------- #


def _stocked(client, acme, checker, quantity="10", serials=(), serialized=False):
    wh = _warehouse(client, acme)
    item = _item(client, acme, serialized=serialized)
    vendor = _active_vendor(client, acme, checker)
    po = _approved_po(client, acme, checker, vendor, item, quantity=quantity)
    ok(_receive(client, acme, po, wh, quantity, serials=serials), 201)
    return wh, item


def test_no_negative_stock(client, acme, checker):
    wh, item = _stocked(client, acme, checker, quantity="3")
    doc = ok(client.post(f"{API}/stock-docs", json={
        "kind": "issue", "from_warehouse_id": wh["id"], "lines": [{"item_id": item["id"], "quantity": "5"}],
    }, headers=acme.headers()), 201)
    refused(client.post(f"{API}/stock-docs/{doc['id']}/post", headers=acme.headers()), 409, "insufficient_stock")
    assert _stock_of(client, acme, item)["quantity"] == "3.000"


def test_transfer_goes_through_transit(client, acme, checker):
    wh, item = _stocked(client, acme, checker, quantity="10")
    pune = _warehouse(client, acme, code="PUN", name="Pune")
    doc = ok(client.post(f"{API}/stock-docs", json={
        "kind": "transfer", "from_warehouse_id": wh["id"], "to_warehouse_id": pune["id"],
        "lines": [{"item_id": item["id"], "quantity": "4"}],
    }, headers=acme.headers()), 201)
    doc = ok(client.post(f"{API}/stock-docs/{doc['id']}/post", headers=acme.headers()))
    assert doc["status"] == "in_transit"
    total = sum(float(r["quantity"]) for r in ok(client.get(f"{API}/stock", params={"item_id": item["id"]},
                                                              headers=acme.headers())))
    assert total == 6
    ok(client.post(f"{API}/stock-docs/{doc['id']}/receive", headers=acme.headers()))
    pune_rows = ok(client.get(f"{API}/stock", params={"warehouse_id": pune["id"]}, headers=acme.headers()))
    assert pune_rows[0]["quantity"] == "4.000" and pune_rows[0]["avg_cost"] == "1000.00"


def test_adjustment_needs_an_independent_approver(client, acme, checker):
    wh, item = _stocked(client, acme, checker, quantity="10")
    doc = ok(client.post(f"{API}/stock-docs", json={
        "kind": "adjustment", "from_warehouse_id": wh["id"], "reason": "Cycle count shortfall",
        "lines": [{"item_id": item["id"], "quantity": "-2"}],
    }, headers=acme.headers()), 201)
    refused(client.post(f"{API}/stock-docs/{doc['id']}/post", headers=acme.headers()), 409, "needs_approval")
    ok(client.post(f"{API}/stock-docs/{doc['id']}/submit", headers=acme.headers()))
    refused(client.post(f"{API}/stock-docs/{doc['id']}/decide", json={"approve": True}, headers=acme.headers()),
            403, "self_review")
    doc = ok(client.post(f"{API}/stock-docs/{doc['id']}/decide", json={"approve": True}, headers=checker))
    assert doc["status"] == "posted"
    assert _stock_of(client, acme, item)["quantity"] == "8.000"


def test_serials_are_counted_and_tracked(client, acme, checker):
    wh = _warehouse(client, acme)
    item = _item(client, acme, serialized=True, warranty_months=12)
    vendor = _active_vendor(client, acme, checker)
    po = _approved_po(client, acme, checker, vendor, item, quantity="2")
    refused(_receive(client, acme, po, wh, "2", serials=["SN1"]), 422, "serial_count")
    ok(_receive(client, acme, po, wh, "2", serials=["SN1", "SN2"]), 201)
    found = ok(client.get(f"{API}/stock/serials", params={"q": "SN1"}, headers=acme.headers()))
    assert found[0]["status"] == "in_stock" and found[0]["warranty_until"]
    # A serial that is not on the shelf cannot be issued.
    doc = ok(client.post(f"{API}/stock-docs", json={
        "kind": "issue", "from_warehouse_id": wh["id"],
        "lines": [{"item_id": item["id"], "quantity": "1", "serials": ["SN9"]}],
    }, headers=acme.headers()), 201)
    refused(client.post(f"{API}/stock-docs/{doc['id']}/post", headers=acme.headers()), 409, "serial_not_here")


# --------------------------------------------------------------------------- #
# Order to cash
# --------------------------------------------------------------------------- #


def _released_order(client, acme, checker, item, quantity="4", rate="1500", **extra):
    customer = _customer(client, acme)
    so = ok(client.post(f"{API}/sales-orders", json={
        "customer_id": customer["id"], "customer_po_number": "PO-778",
        "lines": [{"item_id": item["id"], "quantity": quantity, "rate": rate}], **extra,
    }, headers=acme.headers()), 201)
    ok(client.post(f"{API}/sales-orders/{so['id']}/submit", headers=acme.headers()))
    so = ok(client.post(f"{API}/sales-orders/{so['id']}/decide", json={"approve": True}, headers=checker))
    assert so["status"] == "approved"
    return customer, so


def test_order_to_cash_end_to_end(client, acme, checker):
    wh, item = _stocked(client, acme, checker, quantity="10")
    customer, so = _released_order(client, acme, checker, item, quantity="4")
    assert so["grand_total"] == "7080.00"

    so = ok(client.post(f"{API}/sales-orders/{so['id']}/reserve", json={"warehouse_id": wh["id"]},
                        headers=acme.headers()))
    assert so["lines"][0]["reserved_qty"] == "4.000"
    bal = _stock_of(client, acme, item)
    assert bal["available_qty"] == "6.000"

    # Reserved stock cannot be issued to somebody else.
    doc = ok(client.post(f"{API}/stock-docs", json={
        "kind": "issue", "from_warehouse_id": wh["id"], "lines": [{"item_id": item["id"], "quantity": "8"}],
    }, headers=acme.headers()), 201)
    refused(client.post(f"{API}/stock-docs/{doc['id']}/post", headers=acme.headers()), 409, "stock_reserved")

    dispatch = ok(client.post(f"{API}/dispatches", json={
        "sales_order_id": so["id"], "warehouse_id": wh["id"],
        "lines": [{"order_line_id": so["lines"][0]["id"], "quantity": "4"}],
    }, headers=acme.headers()), 201)
    so = ok(client.get(f"{API}/sales-orders/{so['id']}", headers=acme.headers()))
    assert so["status"] == "dispatched" and so["lines"][0]["reserved_qty"] == "0.000"
    assert _stock_of(client, acme, item)["quantity"] == "6.000"

    inv = ok(client.post(f"{API}/invoices/from-dispatch", json={"dispatch_id": dispatch["id"]},
                         headers=acme.headers()), 201)
    assert inv["number"] is None and inv["grand_total"] == "7080.00"
    assert inv["cgst"] == "540.00" and inv["sgst"] == "540.00"
    # The same dispatch cannot be billed twice.
    refused(client.post(f"{API}/invoices/from-dispatch", json={"dispatch_id": dispatch["id"]},
                        headers=acme.headers()), 409, "already_invoiced")
    inv = ok(client.post(f"{API}/invoices/{inv['id']}/post", headers=acme.headers()))
    assert inv["number"].startswith("INV/") and inv["outstanding"] == "7080.00"

    refused(client.post(f"{API}/receipts", json={"invoice_id": inv["id"], "amount": "9000"},
                        headers=acme.headers()), 422, "over_receipt")
    inv = ok(client.post(f"{API}/receipts", json={"invoice_id": inv["id"], "amount": "5000"},
                         headers=acme.headers()), 201)
    assert inv["outstanding"] == "2080.00"

    cn = ok(client.post(f"{API}/credit-notes", json={
        "original_invoice_id": inv["id"], "reason": "Rate dispute",
        "lines": [{"description": "Rate correction", "quantity": "1", "rate": "1000", "gst_percent": "18"}],
    }, headers=acme.headers()), 201)
    assert cn["status"] == "submitted"
    refused(client.post(f"{API}/credit-notes/{cn['id']}/decide", json={"approve": True}, headers=acme.headers()),
            403, "self_review")
    cn = ok(client.post(f"{API}/credit-notes/{cn['id']}/decide", json={"approve": True}, headers=checker))
    assert cn["status"] == "posted" and cn["number"].startswith("CN/")
    inv = ok(client.get(f"{API}/invoices/{inv['id']}", headers=acme.headers()))
    assert inv["outstanding"] == "900.00"

    ageing = ok(client.get(f"{API}/invoices/ageing", headers=acme.headers()))
    assert ageing["total"] == "900.00"


def test_credit_hold_blocks_release(client, acme, checker):
    _, item = _stocked(client, acme, checker, quantity="2")
    customer = _customer(client, acme)
    ok(client.post(f"{API}/customers/{customer['id']}/hold", json={"hold": True, "reason": "90 days overdue"},
                   headers=checker))
    so = ok(client.post(f"{API}/sales-orders", json={
        "customer_id": customer["id"], "lines": [{"item_id": item["id"], "quantity": "1", "rate": "100"}],
    }, headers=acme.headers()), 201)
    refused(client.post(f"{API}/sales-orders/{so['id']}/submit", headers=acme.headers()), 409, "credit_hold")


def test_milestone_billing_needs_evidence(client, acme, checker):
    service = _item(client, acme, code="IMPL", item_type="service")
    customer = _customer(client, acme)
    so = ok(client.post(f"{API}/sales-orders", json={
        "customer_id": customer["id"],
        "lines": [{"item_id": service["id"], "quantity": "1", "rate": "100000"}],
        "milestones": [{"name": "UAT sign-off", "kind": "uat", "taxable_amount": "40000"}],
    }, headers=acme.headers()), 201)
    ok(client.post(f"{API}/sales-orders/{so['id']}/submit", headers=acme.headers()))
    so = ok(client.post(f"{API}/sales-orders/{so['id']}/decide", json={"approve": True}, headers=checker))
    ms = so["milestones"][0]
    refused(client.post(f"{API}/invoices/from-milestone", json={"milestone_id": ms["id"]},
                        headers=acme.headers()), 409, "not_ready")
    ok(client.post(f"{API}/milestones/{ms['id']}/ready", json={"evidence": "UAT signed 14 Oct"},
                   headers=acme.headers()))
    inv = ok(client.post(f"{API}/invoices/from-milestone", json={"milestone_id": ms["id"]},
                         headers=acme.headers()), 201)
    assert inv["grand_total"] == "47200.00"


def test_shortage_raises_a_requisition(client, acme, checker):
    _, item = _stocked(client, acme, checker, quantity="2")
    _, so = _released_order(client, acme, checker, item, quantity="5")
    req = ok(client.post(f"{API}/sales-orders/{so['id']}/shortage-requisition", headers=acme.headers()), 201)
    assert req["lines"][0]["quantity"] == "3.000" and req["status"] == "draft"


def test_dashboard_and_approval_queue(client, acme, checker):
    item = _item(client, acme)
    vendor = _active_vendor(client, acme, checker)
    po = ok(client.post(f"{API}/purchase-orders", json={
        "vendor_id": vendor["id"], "lines": [{"item_id": item["id"], "quantity": "1", "rate": "10"}],
    }, headers=acme.headers()), 201)
    ok(client.post(f"{API}/purchase-orders/{po['id']}/submit", headers=acme.headers()))
    queue = ok(client.get(f"{API}/approvals", headers=checker))
    assert [q["number"] for q in queue] == [po["number"]]
    # The raiser does not see their own document as something to approve.
    assert ok(client.get(f"{API}/approvals", headers=acme.headers())) == []
    dash = ok(client.get(f"{API}/dashboard", headers=acme.headers()))
    assert dash["procurement"]["pos_pending"] == 1


# --------------------------------------------------------------------------- #
# Tenancy
# --------------------------------------------------------------------------- #


def test_tenants_cannot_reach_each_other(client, acme, globex, checker):
    item = _item(client, acme)
    vendor = _active_vendor(client, acme, checker)
    po = _approved_po(client, acme, checker, vendor, item)
    refused(client.get(f"{API}/purchase-orders/{po['id']}", headers=globex.headers()), 404)
    refused(client.put(f"{API}/items/{item['id']}", json={"code": "HACK", "name": "x"},
                       headers=globex.headers()), 404)
    assert ok(client.get(f"{API}/items", headers=globex.headers())) == []
    assert ok(client.get(f"{API}/vendors", headers=globex.headers())) == []
