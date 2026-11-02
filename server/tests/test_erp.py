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

import re
import uuid
from decimal import Decimal
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


def test_delete_item_only_when_unused(client, acme, checker):
    spare = _item(client, acme, code="DEL-1")
    r = client.delete(f"{API}/items/{spare['id']}", headers=acme.headers())
    assert r.status_code == 204, r.text
    assert all(i["id"] != spare["id"] for i in ok(client.get(f"{API}/items", headers=acme.headers())))
    used = _item(client, acme, code="DEL-2")
    vendor = _active_vendor(client, acme, checker)
    ok(client.post(f"{API}/purchase-orders", json={
        "vendor_id": vendor["id"], "lines": [{"item_id": used["id"], "quantity": "1", "rate": "10"}],
    }, headers=acme.headers()), 201)
    refused(client.delete(f"{API}/items/{used['id']}", headers=acme.headers()), 409, "item_in_use")


def test_item_profile_fields(client, acme):
    item = _item(client, acme, code="BOX-1", barcode=" 8901234567890 ", tags=["Packing", "packing", " Bulk "],
                 is_favorite=True, can_be_purchased=False, track_inventory=False,
                 image="data:image/png;base64,iVBORw0KGgo=")
    assert item["barcode"] == "8901234567890"
    sized = _item(client, acme, code="BOX-9", weight_kg="1.25", volume_m3="0.012")
    assert (Decimal(sized["weight_kg"]), Decimal(sized["volume_m3"])) == (Decimal("1.25"), Decimal("0.012"))
    assert item["tags"] == ["Packing", "Bulk"]
    assert item["is_favorite"] and not item["can_be_purchased"] and item["can_be_sold"]
    listed = ok(client.get(f"{API}/items?q=8901234567890", headers=acme.headers()))
    assert [i["code"] for i in listed] == ["BOX-1"]
    # Goods with tracking off are bought and sold but never stocked.
    assert listed[0]["is_stocked"] is False
    refused(client.post(f"{API}/items", json={"code": "BOX-2", "name": "Box", "barcode": "8901234567890"},
                        headers=acme.headers()), 409, "barcode_taken")
    refused(client.post(f"{API}/items", json={"code": "BOX-3", "name": "Box", "track_inventory": False,
                                              "is_serialized": True}, headers=acme.headers()),
            422, "untracked_serialized")
    refused(client.post(f"{API}/items", json={"code": "BOX-4", "name": "Box", "image": "javascript:alert(1)"},
                        headers=acme.headers()), 422)


def test_item_purchase_tax_defaults_purchase_lines(client, acme, checker):
    item = _item(client, acme, code="NVR-16", gst_percent="18", purchase_gst_percent="12")
    assert (Decimal(item["gst_percent"]), Decimal(item["purchase_gst_percent"])) == (18, 12)
    # Left out, purchases are taxed at the sales rate.
    same = _item(client, acme, code="NVR-08", gst_percent="5")
    assert Decimal(same["purchase_gst_percent"]) == 5
    vendor = _active_vendor(client, acme, checker)
    po = ok(client.post(f"{API}/purchase-orders", json={
        "vendor_id": vendor["id"], "lines": [{"item_id": item["id"], "quantity": "1", "rate": "100"}],
    }, headers=acme.headers()), 201)
    assert Decimal(po["lines"][0]["gst_percent"]) == 12


def test_manual_invoice_due_date_and_terms(client, acme):
    customer = _customer(client, acme)
    body = {"kind": "service", "customer_id": customer["id"], "invoice_date": "2026-10-01",
            "lines": [{"description": "AMC visit", "quantity": "1", "rate": "1000"}]}
    inv = ok(client.post(f"{API}/invoices", json={**body, "due_date": "2026-10-20", "terms": "Pay by NEFT."},
                         headers=acme.headers()), 201)
    assert inv["due_date"] == "2026-10-20" and inv["terms"] == "Pay by NEFT."
    refused(client.post(f"{API}/invoices", json={**body, "due_date": "2026-09-01"}, headers=acme.headers()),
            422, "due_before_invoice")


def test_invoice_salesperson_bank_reference_delivery(client, acme):
    settings = ok(client.get(f"{API}/settings", headers=acme.headers()))
    settings["bank_accounts"] = [
        {"bank_name": "HDFC Bank", "account_number": "50200012345678", "ifsc": "HDFC0001234", "label": "Current a/c"},
        {"bank_name": "ICICI Bank", "account_number": "001105012345", "ifsc": "ICIC0000011"},
    ]
    saved = ok(client.put(f"{API}/settings", json=settings, headers=acme.headers()))
    banks = saved["bank_accounts"]
    assert all(b["id"] for b in banks) and [b["is_default"] for b in banks] == [True, False]

    customer = _customer(client, acme)
    me = ok(client.get("/api/v1/auth/me", headers=acme.headers()))
    body = {"kind": "service", "customer_id": customer["id"], "invoice_date": "2026-10-01",
            "lines": [{"description": "AMC", "quantity": "1", "rate": "500"}]}
    inv = ok(client.post(f"{API}/invoices", json={
        **body, "salesperson_id": me["id"], "recipient_bank_id": banks[1]["id"],
        "payment_ref_standard": True, "delivery_date": "2026-10-05",
    }, headers=acme.headers()), 201)
    assert inv["salesperson_name"] and inv["recipient_bank"]["bank_name"] == "ICICI Bank"
    assert inv["delivery_date"] == "2026-10-05" and inv["payment_reference"] is None
    posted = ok(client.post(f"{API}/invoices/{inv['id']}/post", headers=acme.headers()))
    # Standard communication: the reference is the invoice number.
    assert posted["payment_reference"] == posted["number"]

    free = ok(client.post(f"{API}/invoices", json={**body, "payment_reference": "PO 4501-778"},
                          headers=acme.headers()), 201)
    assert free["payment_reference"] == "PO 4501-778"
    refused(client.post(f"{API}/invoices", json={**body, "recipient_bank_id": "nope"}, headers=acme.headers()),
            422, "bad_bank")


def test_draft_invoice_edit_and_delete(client, acme):
    customer = _customer(client, acme)
    body = {"kind": "service", "customer_id": customer["id"],
            "lines": [{"description": "Visit", "quantity": "1", "rate": "100", "gst_percent": "18"}]}
    draft = ok(client.post(f"{API}/invoices", json=body, headers=acme.headers()), 201)
    edited = ok(client.put(f"{API}/invoices/{draft['id']}", json={
        **body, "notes": "Edited", "lines": [
            {"description": "Visit", "quantity": "2", "rate": "100", "gst_percent": "18"},
            {"description": "Freight charges", "quantity": "1", "rate": "50", "gst_percent": "18", "is_charge": True},
        ]}, headers=acme.headers()))
    assert edited["notes"] == "Edited" and edited["status"] == "draft"
    assert edited["sub_total"] == "250.00" and [ln["is_charge"] for ln in edited["lines"]] == [False, True]
    r = client.delete(f"{API}/invoices/{edited['id']}", headers=acme.headers())
    assert r.status_code == 204, r.text
    # A posted invoice is never edited (only an administrator may delete one
    # made in error — see test_admin_deletes_issued_invoice_made_in_error).
    posted = ok(client.post(f"{API}/invoices", json=body, headers=acme.headers()), 201)
    ok(client.post(f"{API}/invoices/{posted['id']}/post", headers=acme.headers()))
    assert client.put(f"{API}/invoices/{posted['id']}", json=body, headers=acme.headers()).status_code == 409


def test_gst_summary_with_cess_and_round_off(client, acme):
    customer = _customer(client, acme)
    inv = ok(client.post(f"{API}/invoices", json={
        "kind": "service", "customer_id": customer["id"], "round_off": True,
        "lines": [
            {"description": "Aerated drink", "quantity": "10", "rate": "40", "gst_percent": "28", "cess_percent": "12"},
            {"description": "Snack", "quantity": "3", "rate": "33.33", "gst_percent": "12"},
            {"description": "Freight charges", "quantity": "1", "rate": "100", "gst_percent": "18", "is_charge": True,
             "cess_percent": "12"},
        ],
    }, headers=acme.headers()), 201)
    lines = inv["lines"]
    # 400 × 12% cess = 48 on the drink; none on the snack; charges never carry cess.
    assert [ln["cess_amount"] for ln in lines] == ["48.00", "0.00", "0.00"]
    assert lines[0]["amount"] == "560.00"  # 400 + 112 GST + 48 cess
    # Taxable 400 + 99.99 + 100; GST 112 + 12.00 + 18; cess 48.
    assert (inv["sub_total"], inv["tax_total"], inv["cess_total"]) == ("599.99", "142.00", "48.00")
    # CGST + SGST halve the GST; the grand total is taxable + GST + cess, rounded.
    assert Decimal(inv["cgst"]) + Decimal(inv["sgst"]) == Decimal("142.00") and Decimal(inv["igst"]) == 0
    assert inv["grand_total"] == "790.00" and inv["round_off"] == "0.01"


def test_bill_discount_amounts_and_charge_tax(client, acme):
    customer = _customer(client, acme)
    base = {"kind": "service", "customer_id": customer["id"]}
    lines = [
        {"description": "Camera", "quantity": "2", "rate": "300", "gst_percent": "18"},   # 600
        {"description": "Cable", "quantity": "1", "rate": "400", "gst_percent": "12"},    # 400
        {"description": "Insurance", "quantity": "1", "rate": "100", "gst_percent": "0", "is_charge": True},
        {"description": "Freight charges", "quantity": "1", "rate": "50", "gst_percent": "18", "is_charge": True},
    ]
    inv = ok(client.post(f"{API}/invoices", json={
        **base, "lines": lines, "bill_discount_percent": "10", "bill_discount_amount": "100.01",
        "additional_discount": "50", "discount_reason": "Festive offer",
    }, headers=acme.headers()), 201)
    taxable = [Decimal(ln["taxable_value"]) for ln in inv["lines"]]
    # 1000 − 10% = 900; ₹150.01 shared 540:360 → 90.01 and 60.00; charges untouched.
    assert taxable == [Decimal("449.99"), Decimal("300.00"), Decimal("100.00"), Decimal("50.00")]
    assert sum(taxable[:2]) == Decimal("900") - Decimal("150.01")
    # GST per line: 81.00 + 36.00 + 0 (no-GST charge) + 9.00.
    assert inv["tax_total"] == "126.00" and inv["discount_reason"] == "Festive offer"
    refused(client.post(f"{API}/invoices", json={**base, "lines": lines, "additional_discount": "10"},
                        headers=acme.headers()), 422, "reason_required")
    refused(client.post(f"{API}/invoices", json={**base, "lines": lines, "bill_discount_amount": "1000.01"},
                        headers=acme.headers()), 422, "discount_too_large")


def test_invoice_po_reverse_charge_and_transport(client, acme):
    customer = _customer(client, acme)
    body = {"kind": "service", "customer_id": customer["id"],
            "lines": [{"description": "Cable", "quantity": "1", "rate": "100", "gst_percent": "18"}]}
    inv = ok(client.post(f"{API}/invoices", json={
        **body, "customer_po_number": "PO-4501-778", "reverse_charge": True, "dispatch_doc_number": "DC-0091",
        "transporter_name": "VRL Logistics", "vehicle_number": "mh 12-ab 1234", "eway_bill_number": "3410 1234 5678",
        "lr_number": "LR/88213",
    }, headers=acme.headers()), 201)
    assert inv["customer_po_number"] == "PO-4501-778" and inv["reverse_charge"] is True
    assert (inv["vehicle_number"], inv["eway_bill_number"]) == ("MH12AB1234", "341012345678")
    assert inv["transporter_name"] == "VRL Logistics" and inv["lr_number"] == "LR/88213"
    # Transport is optional; the totals are untouched by any of it.
    plain = ok(client.post(f"{API}/invoices", json=body, headers=acme.headers()), 201)
    assert plain["grand_total"] == inv["grand_total"] and plain["vehicle_number"] is None
    refused(client.post(f"{API}/invoices", json={**body, "vehicle_number": "ABC"}, headers=acme.headers()), 422)
    refused(client.post(f"{API}/invoices", json={**body, "eway_bill_number": "12345"}, headers=acme.headers()), 422)


def test_reverse_payment_restores_balance_and_keeps_history(client, acme):
    customer = _customer(client, acme)
    inv = ok(client.post(f"{API}/invoices", json={
        "kind": "service", "customer_id": customer["id"],
        "lines": [{"description": "AMC", "quantity": "1", "rate": "1000", "gst_percent": "0"}],
    }, headers=acme.headers()), 201)
    inv = ok(client.post(f"{API}/invoices/{inv['id']}/post", headers=acme.headers()))
    ok(client.post(f"{API}/receipts", json={"invoice_id": inv["id"], "amount": "600", "tds_amount": "100", "mode": "neft"},
                   headers=acme.headers()), 201)
    paid = ok(client.get(f"{API}/invoices/{inv['id']}", headers=acme.headers()))
    assert Decimal(paid["amount_received"]) == 700 and Decimal(paid["outstanding"]) == 300
    rid = paid["receipts"][0]["id"]
    assert paid["receipts"][0]["created_by_name"]
    # A reason is required.
    refused(client.post(f"{API}/receipts/{rid}/reverse", json={"reason": " "}, headers=acme.headers()), 422)
    back = ok(client.post(f"{API}/receipts/{rid}/reverse", json={"reason": "Recorded against the wrong invoice"},
                          headers=acme.headers()))
    # The whole settlement (amount + TDS) is owed again.
    assert Decimal(back["amount_received"]) == 0 and Decimal(back["outstanding"]) == 1000
    r = back["receipts"][0]
    assert r["status"] == "reversed" and r["reverse_reason"] == "Recorded against the wrong invoice"
    assert r["reversed_at"] and r["reversed_by_name"]
    # Never twice; and the record is still there.
    refused(client.post(f"{API}/receipts/{rid}/reverse", json={"reason": "again"}, headers=acme.headers()),
            409, "already_reversed")
    # A new payment can be recorded against the restored balance.
    ok(client.post(f"{API}/receipts", json={"invoice_id": inv["id"], "amount": "1000", "mode": "upi"},
                   headers=acme.headers()), 201)
    final = ok(client.get(f"{API}/invoices/{inv['id']}", headers=acme.headers()))
    assert Decimal(final["outstanding"]) == 0 and [x["status"] for x in final["receipts"]] == ["reversed", "posted"]


def test_receipt_account_proof_and_corrections(client, acme):
    ok(client.put(f"{API}/settings", json={"bank_accounts": [
        {"id": "hdfc", "label": "Current a/c", "bank_name": "HDFC Bank", "account_number": "50200012345678", "ifsc": "HDFC0001234", "is_default": True},
    ]}, headers=acme.headers()))
    customer = _customer(client, acme)
    inv = ok(client.post(f"{API}/invoices", json={
        "kind": "service", "customer_id": customer["id"],
        "lines": [{"description": "AMC", "quantity": "1", "rate": "1000", "gst_percent": "0"}],
    }, headers=acme.headers()), 201)
    inv = ok(client.post(f"{API}/invoices/{inv['id']}/post", headers=acme.headers()))
    proof = "data:image/png;base64,iVBORw0KGgo="
    refused(client.post(f"{API}/receipts", json={"invoice_id": inv["id"], "amount": "100", "deposit_account_id": "nope"},
                        headers=acme.headers()), 422, "bad_account")
    refused(client.post(f"{API}/receipts", json={"invoice_id": inv["id"], "amount": "100", "proof": "data:text/html,x"},
                        headers=acme.headers()), 422)
    paid = ok(client.post(f"{API}/receipts", json={
        "invoice_id": inv["id"], "amount": "400", "mode": "neft", "reference": "UTR1", "notes": "First instalment",
        "deposit_account_id": "hdfc", "proof": proof, "proof_name": "utr.png"}, headers=acme.headers()), 201)
    r = paid["receipts"][0]
    # Received by and when are captured; the proof itself is not in the invoice.
    assert r["created_by_name"] and r["created_at"] and r["has_proof"] and "proof" not in r
    assert r["deposit_account"].startswith("Current a/c") and r["deposit_account"].endswith("5678")
    assert Decimal(paid["outstanding"]) == 600
    got = ok(client.get(f"{API}/receipts/{r['id']}/proof", headers=acme.headers()))
    assert got == {"name": "utr.png", "data": proof}
    # A correction needs a reason, changes only details, and is kept.
    refused(client.patch(f"{API}/receipts/{r['id']}", json={"reference": "UTR2"}, headers=acme.headers()), 422)
    out = ok(client.patch(f"{API}/receipts/{r['id']}", json={"reason": "Wrong UTR typed", "reference": "UTR2",
                                                              "deposit_account_id": "cash"}, headers=acme.headers()))
    r = out["receipts"][0]
    assert r["reference"] == "UTR2" and r["deposit_account"] == "Cash in hand" and Decimal(r["amount"]) == 400
    log = r["corrections"]
    assert len(log) == 1 and log[0]["reason"] == "Wrong UTR typed" and log[0]["changes"]["reference"] == ["UTR1", "UTR2"]
    refused(client.patch(f"{API}/receipts/{r['id']}", json={"reason": "again", "reference": "UTR2"}, headers=acme.headers()),
            422, "no_change")


def test_admin_deletes_issued_invoice_made_in_error(client, acme):
    customer = _customer(client, acme)
    body = {"kind": "service", "customer_id": customer["id"], "invoice_date": "2026-10-01",
            "lines": [{"description": "Visit", "quantity": "1", "rate": "100", "gst_percent": "18"}]}

    def issue():
        inv = ok(client.post(f"{API}/invoices", json=body, headers=acme.headers()), 201)
        return ok(client.post(f"{API}/invoices/{inv['id']}/post", headers=acme.headers()))

    first, second = issue(), issue()
    # An older number can go, but leaves a gap: the next is still 0003.
    ok(client.post(f"{API}/invoices/{first['id']}/cancel", json={"reason": "Made in error"}, headers=acme.headers()))
    assert client.delete(f"{API}/invoices/{first['id']}", headers=acme.headers()).status_code == 204
    # The latest number is handed back, so the next invoice reuses it.
    assert client.delete(f"{API}/invoices/{second['id']}", headers=acme.headers()).status_code == 204
    again = issue()
    assert again["number"] == second["number"]
    # Money against it protects an invoice.
    receipt = ok(client.post(f"{API}/receipts", json={"invoice_id": again["id"], "amount": "50", "mode": "neft"},
                             headers=acme.headers()), 201)
    refused(client.delete(f"{API}/invoices/{again['id']}", headers=acme.headers()), 409, "has_money")
    # A reversed payment is still history: the invoice is kept with it, and cancelled instead.
    rid = next(r["id"] for r in ok(client.get(f"{API}/invoices/{again['id']}", headers=acme.headers()))["receipts"])
    ok(client.post(f"{API}/receipts/{rid}/reverse", json={"reason": "Bounced"}, headers=acme.headers()))
    refused(client.delete(f"{API}/invoices/{again['id']}", headers=acme.headers()), 409, "has_payment_history")
    cancelled = ok(client.post(f"{API}/invoices/{again['id']}/cancel", json={"reason": "Raised in error"}, headers=acme.headers()))
    assert cancelled["status"] == "cancelled" and cancelled["receipts"][0]["status"] == "reversed"


def test_sale_bill_discounts_charges_and_round_off(client, acme):
    customer = _customer(client, acme)
    inv = ok(client.post(f"{API}/invoices", json={
        "kind": "service", "customer_id": customer["id"], "invoice_date": "2026-10-01",
        "bill_discount_percent": "10", "round_off": True,
        "lines": [
            # 3 × 333.33 = 999.99, less ₹99.99 = 900, less 10% bill discount = 810 taxable, GST 18% = 145.80.
            {"description": "Router", "quantity": "3", "rate": "333.33", "discount_amount": "99.99", "gst_percent": "18"},
            # A charge: GST, but no bill discount. 100 + 18 = 118.
            {"description": "Freight charges", "quantity": "1", "rate": "100", "gst_percent": "18", "is_charge": True},
        ],
    }, headers=acme.headers()), 201)
    assert [ln["taxable_value"] for ln in inv["lines"]] == ["810.00", "100.00"]
    assert [ln["is_charge"] for ln in inv["lines"]] == [False, True]
    assert inv["sub_total"] == "910.00" and inv["tax_total"] == "163.80"
    # 1073.80 rounds to 1074 — the 0.20 is kept as round off.
    assert inv["grand_total"] == "1074.00" and inv["round_off"] == "0.20"
    assert Decimal(inv["bill_discount_percent"]) == 10 and Decimal(inv["lines"][0]["discount_amount"]) == Decimal("99.99")
    peek = ok(client.get(f"{API}/invoices/next-number", headers=acme.headers()))
    assert "company_state" in peek

    # Second discount off what the first left; free units are not charged.
    two = ok(client.post(f"{API}/invoices", json={
        "kind": "service", "customer_id": customer["id"],
        "lines": [{"description": "Cable", "quantity": "10", "free_qty": "2", "rate": "100",
                   "discount_percent": "10", "discount2_amount": "50", "gst_percent": "0"}],
    }, headers=acme.headers()), 201)
    # 1000 − 10% = 900, − ₹50 = 850.
    assert two["lines"][0]["taxable_value"] == "850.00"
    assert Decimal(two["lines"][0]["free_qty"]) == 2


def test_invoice_discount_shipping_and_next_number(client, acme):
    customer = _customer(client, acme)
    peek = ok(client.get(f"{API}/invoices/next-number", params={"kind": "service", "on": "2026-10-01"},
                         headers=acme.headers()))
    assert peek["number"] == "INV-2026-27-0001"
    inv = ok(client.post(f"{API}/invoices", json={
        "kind": "service", "customer_id": customer["id"], "invoice_date": "2026-10-01",
        "billing_address": "12 MG Road, Indore", "shipping_address": "Site 4, Pithampur",
        "lines": [{"description": "Install", "quantity": "2", "rate": "1000", "discount_percent": "10",
                   "gst_percent": "18"}],
    }, headers=acme.headers()), 201)
    # 2 × 1000 = 2000, less 10% = 1800 taxable, 18% GST = 324.
    assert (inv["sub_total"], inv["tax_total"], inv["grand_total"]) == ("1800.00", "324.00", "2124.00")
    assert Decimal(inv["lines"][0]["discount_percent"]) == 10
    assert inv["billing_address"] == "12 MG Road, Indore" and inv["shipping_address"] == "Site 4, Pithampur"
    # Peeking does not take a number: posting still gets 0001.
    ok(client.post(f"{API}/invoices/{inv['id']}/post", headers=acme.headers()))
    assert ok(client.get(f"{API}/invoices/{inv['id']}", headers=acme.headers()))["number"] == "INV-2026-27-0001"


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
    # INV-2026-27-0001: the GST invoice series, 16 characters at most.
    assert re.fullmatch(r"INV-\d{4}-\d{2}-\d{4}", inv["number"]) and len(inv["number"]) <= 16
    assert inv["outstanding"] == "7080.00"

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
    assert cn["status"] == "posted" and re.fullmatch(r"CN-\d{4}-\d{2}-\d{4}", cn["number"])
    inv = ok(client.get(f"{API}/invoices/{inv['id']}", headers=acme.headers()))
    assert inv["outstanding"] == "900.00"

    ageing = ok(client.get(f"{API}/invoices/ageing", headers=acme.headers()))
    assert ageing["total"] == "900.00"


def test_po_number_preview_company_and_dates(client, acme, checker):
    vendor = _active_vendor(client, acme, checker)
    peek = ok(client.get(f"{API}/purchase-orders/next-number", params={"on": "2026-10-31"}, headers=acme.headers()))
    line = [{"description": "Camera", "quantity": "2", "rate": "100"}]
    # Delivery before the order date is refused.
    refused(client.post(f"{API}/purchase-orders", json={
        "vendor_id": vendor["id"], "order_date": "2026-10-31", "expected_date": "2026-10-30", "lines": line,
    }, headers=acme.headers()), 422, "bad_dates")
    po = ok(client.post(f"{API}/purchase-orders", json={
        "vendor_id": vendor["id"], "order_date": "2026-10-31", "expected_date": "2026-11-07", "company": " Hikvision ",
        "delivery_terms": "FOR destination", "lines": line,
    }, headers=acme.headers()), 201)
    # The preview is the number the draft got, and peeking did not use it up.
    assert po["number"] == peek["number"] and po["company"] == "Hikvision" and po["order_date"] == "2026-10-31"
    after = ok(client.get(f"{API}/purchase-orders/next-number", params={"on": "2026-10-31"}, headers=acme.headers()))
    assert after["number"] != peek["number"]


def test_po_line_discount_prices_and_values_stock(client, acme, checker):
    vendor = _active_vendor(client, acme, checker)
    po = ok(client.post(f"{API}/purchase-orders", json={"vendor_id": vendor["id"], "lines": [
        # 4 × 250 = 1000, less 10% = 900 taxable, GST 18% = 162.
        {"description": "Camera", "hsn_sac": "85258900", "uom": "Nos", "quantity": "4", "rate": "250",
         "discount_percent": "10", "gst_percent": "18"},
    ]}, headers=acme.headers()), 201)
    line = po["lines"][0]
    assert Decimal(line["discount_percent"]) == 10 and Decimal(line["taxable_value"]) == 900
    assert Decimal(line["tax_amount"]) == 162 and Decimal(po["grand_total"]) == 1062
    assert line["hsn_sac"] == "85258900" and line["uom"] == "Nos"
    refused(client.post(f"{API}/purchase-orders", json={"vendor_id": vendor["id"], "lines": [
        {"description": "Camera", "quantity": "1", "rate": "250", "discount_percent": "120"}]}, headers=acme.headers()), 422)
    # Freight and other charges go on after tax; the GST is split by state.
    po = ok(client.put(f"{API}/purchase-orders/{po['id']}", json={
        "vendor_id": vendor["id"], "freight": "100", "other_charges": "50.50", "lines": [
            {"description": "Camera", "quantity": "4", "rate": "250", "discount_percent": "10", "gst_percent": "18"}]},
        headers=acme.headers()))
    assert Decimal(po["other_charges"]) == Decimal("50.50") and Decimal(po["grand_total"]) == Decimal("1212.50")
    split = (Decimal(po["cgst"]), Decimal(po["sgst"]), Decimal(po["igst"]))
    assert sum(split) == 162 and (split == (81, 81, 0) if not po["is_interstate"] else split == (0, 0, 162))
    peek = ok(client.get(f"{API}/purchase-orders/next-number", headers=acme.headers()))
    assert "company_state" in peek


def test_po_submit_reject_resubmit_approve(client, acme, checker):
    vendor = _active_vendor(client, acme, checker)
    po = ok(client.post(f"{API}/purchase-orders", json={
        "vendor_id": vendor["id"], "lines": [{"description": "Camera", "quantity": "2", "rate": "100"}]}, headers=acme.headers()), 201)
    assert po["status"] == "draft" and po["waiting_on"] == []
    po = ok(client.post(f"{API}/purchase-orders/{po['id']}/submit", headers=acme.headers()))
    # Waiting on whoever may approve — not the buyer who raised it.
    assert po["status"] == "submitted" and "Acme Checker" in po["waiting_on"]
    queue = ok(client.get(f"{API}/approvals", headers=checker))
    assert any(r["kind"] == "purchase_order" and r["id"] == po["id"] for r in queue)
    # The buyer cannot approve their own order; a rejection needs a reason.
    refused(client.post(f"{API}/purchase-orders/{po['id']}/decide", json={"approve": True}, headers=acme.headers()), 403)
    refused(client.post(f"{API}/purchase-orders/{po['id']}/decide", json={"approve": False}, headers=checker), 422)
    po = ok(client.post(f"{API}/purchase-orders/{po['id']}/decide", json={"approve": False, "note": "Rate too high"}, headers=checker))
    assert po["status"] == "rejected" and po["review_note"] == "Rate too high" and po["reviewed_by_name"] == "Acme Checker"
    # Revised and resubmitted, then approved.
    ok(client.post(f"{API}/purchase-orders/{po['id']}/amend", json={"reason": "Rate renegotiated"}, headers=acme.headers()))
    ok(client.post(f"{API}/purchase-orders/{po['id']}/submit", headers=acme.headers()))
    po = ok(client.post(f"{API}/purchase-orders/{po['id']}/decide", json={"approve": True}, headers=checker))
    assert po["status"] == "approved" and po["reviewed_by_name"] == "Acme Checker" and po["waiting_on"] == []


def test_sales_order_full_fields_discount_charges_and_attachments(client, acme):
    customer = _customer(client, acme)
    peek = ok(client.get(f"{API}/sales-orders/next-number", headers=acme.headers()))
    body = {
        "customer_id": customer["id"], "order_type": "project", "priority": "urgent", "reference": "Tender T-88",
        "salesperson_id": str(acme.owner.id), "delivery_terms": "FOR destination", "delivery_mode": "transport",
        "transporter_name": "VRL Logistics", "freight_terms": "paid", "delivery_instructions": "Unload at gate 2",
        "terms": "Warranty 1 year", "internal_notes": "Margin thin", "freight": "100", "other_charges": "50",
        "lines": [{"description": "Camera install", "quantity": "4", "rate": "250", "discount_percent": "10", "gst_percent": "18"}],
    }
    bad = {**body, "order_date": "2026-11-02", "required_by": "2026-11-01"}
    refused(client.post(f"{API}/sales-orders", json=bad, headers=acme.headers()), 422, "bad_dates")
    so = ok(client.post(f"{API}/sales-orders", json=body, headers=acme.headers()), 201)
    assert so["number"] == peek["number"]
    assert so["order_type"] == "project" and so["priority"] == "urgent" and so["salesperson_name"]
    assert so["delivery_mode"] == "transport" and so["freight_terms"] == "paid" and so["internal_notes"] == "Margin thin"
    # 4 × 250 less 10% = 900; freight 100 + other 50 are taxable at the item rate (18%):
    # taxable 1050, GST 189, total 1239.
    assert Decimal(so["sub_total"]) == 1050 and Decimal(so["tax_total"]) == 189 and Decimal(so["grand_total"]) == 1239
    assert Decimal(so["charges_gst_percent"]) == 18
    assert Decimal(so["cgst"]) + Decimal(so["sgst"]) + Decimal(so["igst"]) == 189
    # A chosen rate for the charges, and a rate that does not exist.
    zero = ok(client.put(f"{API}/sales-orders/{so['id']}", json={**body, "charges_gst_percent": "0"}, headers=acme.headers()))
    assert Decimal(zero["tax_total"]) == 162 and Decimal(zero["grand_total"]) == 1212
    refused(client.put(f"{API}/sales-orders/{so['id']}", json={**body, "charges_gst_percent": "7"}, headers=acme.headers()), 422)
    refused(client.put(f"{API}/sales-orders/{so['id']}", json={**body, "freight": "10.555"}, headers=acme.headers()), 422)
    assert Decimal(so["lines"][0]["discount_percent"]) == 10
    pdf = "data:application/pdf;base64,JVBERi0xLjQK"
    refused(client.post(f"{API}/sales-orders/{so['id']}/attachments", json={"name": "x.html", "data": "data:text/html,hi"},
                        headers=acme.headers()), 422)
    so = ok(client.post(f"{API}/sales-orders/{so['id']}/attachments", json={"name": "PO copy.pdf", "data": pdf},
                        headers=acme.headers()), 201)
    att = so["attachments"][0]
    assert att["name"] == "PO copy.pdf" and "data" not in att and att["by_name"]
    got = ok(client.get(f"{API}/sales-orders/{so['id']}/attachments/{att['id']}", headers=acme.headers()))
    assert got["data"] == pdf
    so = ok(client.delete(f"{API}/sales-orders/{so['id']}/attachments/{att['id']}", headers=acme.headers()))
    assert so["attachments"] == []


def test_sales_order_draft_keeps_everything_and_waits_for_submit(client, acme):
    """Save as draft: a numbered order in Draft, every section kept, editable."""
    customer = _customer(client, acme)
    body = {
        "customer_id": customer["id"], "order_type": "service", "priority": "high", "reference": "ENQ-12",
        "customer_po_number": "PO-778", "customer_po_date": date.today().isoformat(), "customer_po_value": "1180",
        "required_by": (date.today() + timedelta(days=7)).isoformat(),
        "billing_address": "12 MG Road, Pune 411001", "shipping_address": "Plot 4, Chakan MIDC, Pune 410501",
        "payment_terms": "50% advance, balance in 30 days", "delivery_terms": "Door delivery",
        "delivery_mode": "courier", "freight_terms": "to_pay", "delivery_instructions": "Call before arrival",
        "freight": "0", "other_charges": "0",
        "notes": "Thank you for the order", "terms": "Warranty 1 year", "internal_notes": "Repeat customer",
        "deviation_note": "PO includes AMC", "salesperson_id": str(acme.owner.id),
        "lines": [{"description": "Site survey", "hsn_sac": "998313", "uom": "Nos", "quantity": "2", "rate": "500",
                   "gst_percent": "18"}],
        "milestones": [{"name": "Advance", "kind": "advance", "taxable_amount": "500", "gst_percent": "18",
                        "due_date": date.today().isoformat()}],
    }
    first = ok(client.post(f"{API}/sales-orders", json=body, headers=acme.headers()), 201)
    second = ok(client.post(f"{API}/sales-orders", json=body, headers=acme.headers()), 201)
    assert first["status"] == second["status"] == "draft"
    assert first["number"] != second["number"]

    # It is listed under Draft, and reads back with every section intact.
    drafts = ok(client.get(f"{API}/sales-orders?status=draft", headers=acme.headers()))
    assert {first["id"], second["id"]} <= {d["id"] for d in drafts}
    got = ok(client.get(f"{API}/sales-orders/{first['id']}", headers=acme.headers()))
    for key in ("order_type", "priority", "reference", "customer_po_number", "customer_po_date", "required_by",
                "billing_address", "shipping_address", "payment_terms", "delivery_terms", "delivery_mode",
                "freight_terms", "delivery_instructions", "notes", "terms", "internal_notes", "deviation_note"):
        assert got[key] == body[key], key
    assert got["lines"][0]["hsn_sac"] == "998313" and Decimal(got["grand_total"]) == 1180
    assert got["milestones"][0]["name"] == "Advance" and got["milestones"][0]["due_date"] == body["milestones"][0]["due_date"]

    # Editing a draft keeps its number and status; nothing is submitted on its own.
    edited = ok(client.put(f"{API}/sales-orders/{first['id']}", json={**body, "notes": "Revised"}, headers=acme.headers()))
    assert edited["number"] == first["number"] and edited["status"] == "draft" and edited["notes"] == "Revised"
    assert edited["chain"] == [] and edited["reviewed_by_name"] is None

    # A milestone needs an amount; an order needs a line.
    refused(client.post(f"{API}/sales-orders", json={**body, "milestones": [{"name": "X", "taxable_amount": "0"}]},
                        headers=acme.headers()), 422)
    refused(client.post(f"{API}/sales-orders", json={**body, "lines": []}, headers=acme.headers()), 422)


def test_credit_note_for_returned_items(client, acme, checker):
    customer = _customer(client, acme)
    inv = ok(client.post(f"{API}/invoices", json={
        "kind": "service", "customer_id": customer["id"],
        "lines": [
            # 3 × 333.33 less ₹99.99 = 900 taxable, GST 18% = 162.
            {"description": "Camera", "quantity": "3", "rate": "333.33", "discount_amount": "99.99", "gst_percent": "18"},
            {"description": "Cable", "quantity": "10", "rate": "50", "gst_percent": "12"},
        ],
    }, headers=acme.headers()), 201)
    inv = ok(client.post(f"{API}/invoices/{inv['id']}/post", headers=acme.headers()))
    cam, cable = inv["lines"]
    body = {"original_invoice_id": inv["id"], "reason": "Damaged in transit"}
    # Nothing selected, a line from elsewhere, more than was sold: all refused.
    refused(client.post(f"{API}/credit-notes", json={**body, "returns": []}, headers=acme.headers()), 422)
    refused(client.post(f"{API}/credit-notes", json={**body, "returns": [{"source_line_id": str(uuid.uuid4()), "quantity": "1"}]},
                        headers=acme.headers()), 422, "bad_line")
    refused(client.post(f"{API}/credit-notes", json={**body, "returns": [{"source_line_id": cam["id"], "quantity": "4"}]},
                        headers=acme.headers()), 422, "over_return")
    # One camera back: a third of its taxable value, at the invoice's GST.
    cn = ok(client.post(f"{API}/credit-notes", json={**body, "returns": [{"source_line_id": cam["id"], "quantity": "1"}]},
                        headers=acme.headers()), 201)
    assert cn["status"] == "submitted" and cn["number"] is None
    line = cn["lines"][0]
    assert line["source_line_id"] == cam["id"] and Decimal(line["quantity"]) == 1
    assert Decimal(line["taxable_value"]) == 300 and Decimal(line["tax_amount"]) == 54 and Decimal(cn["grand_total"]) == 354
    assert Decimal(cn["cgst"]) == 27 and Decimal(cn["sgst"]) == 27
    # Awaiting approval, it already holds that camera.
    inv = ok(client.get(f"{API}/invoices/{inv['id']}", headers=acme.headers()))
    assert Decimal(inv["returned"][cam["id"]]["quantity"]) == 1
    refused(client.post(f"{API}/credit-notes", json={**body, "returns": [{"source_line_id": cam["id"], "quantity": "3"}]},
                        headers=acme.headers()), 422, "over_return")
    cn = ok(client.post(f"{API}/credit-notes/{cn['id']}/decide", json={"approve": True}, headers=checker))
    assert re.fullmatch(r"CN-\d{4}-\d{2}-\d{4}", cn["number"])
    # The other two cameras and all the cable: the last return takes exactly what is left.
    cn2 = ok(client.post(f"{API}/credit-notes", json={**body, "reason": "Order cancelled", "returns": [
        {"source_line_id": cam["id"], "quantity": "2"}, {"source_line_id": cable["id"], "quantity": "10"}]},
        headers=acme.headers()), 201)
    assert Decimal(cn2["lines"][0]["taxable_value"]) == 600 and Decimal(cn2["lines"][1]["taxable_value"]) == 500
    cn2 = ok(client.post(f"{API}/credit-notes/{cn2['id']}/decide", json={"approve": True}, headers=checker))
    assert cn2["number"] != cn["number"]
    inv = ok(client.get(f"{API}/invoices/{inv['id']}", headers=acme.headers()))
    assert Decimal(inv["outstanding"]) == 0 and Decimal(inv["amount_credited"]) == Decimal(inv["grand_total"])
    # The history: both notes, numbered, with their reasons.
    assert [(c["number"] is not None, c["reason"]) for c in inv["credit_notes"]] == [
        (True, "Damaged in transit"), (True, "Order cancelled")]


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
    # A submitted PO is not yet committed spend, but it is a recent document.
    analytics = dash["analytics"]
    assert len(analytics["trend"]) == 6
    assert analytics["kpis"]["purchases_month"] == "0.00"
    assert [r["number"] for r in analytics["recent"]] == [po["number"]]
    assert [a["bucket"] for a in analytics["ageing"]] == ["current", "1-30", "31-60", "61-90", "90+"]


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


def test_a_warehouse_needs_only_a_name_and_keeps_its_details_on_edit(client, acme):
    made = ok(client.post(f"{API}/warehouses", json={"name": "Pune Hub", "description": "Main stock"},
                          headers=acme.headers()), 201)
    assert made["code"].startswith("WH")
    assert made["description"] == "Main stock"
    hub = ok(client.put(f"{API}/warehouses/{made['id']}", json={"name": "Pune Hub", "kind": "hub", "state": "Maharashtra"},
                        headers=acme.headers()))
    edited = ok(client.put(f"{API}/warehouses/{made['id']}", json={"name": "Pune Hub 2", "description": "Moved"},
                           headers=acme.headers()))
    assert (edited["code"], edited["kind"], edited["state"]) == (hub["code"], "hub", "Maharashtra")


def test_an_unused_warehouse_can_be_deleted(client, acme):
    made = _warehouse(client, acme, code="DEL", name="Spare")
    assert client.delete(f"{API}/warehouses/{made['id']}", headers=acme.headers()).status_code == 204
    names = [w["name"] for w in ok(client.get(f"{API}/warehouses", headers=acme.headers()))]
    assert "Spare" not in names


def test_a_warehouse_holding_stock_cannot_be_deleted(client, acme, checker):
    wh, _ = _stocked(client, acme, checker, quantity="2")
    refused(client.delete(f"{API}/warehouses/{wh['id']}", headers=acme.headers()), 409, "warehouse_in_use")
