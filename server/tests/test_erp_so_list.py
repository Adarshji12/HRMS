"""The All Sales Orders list: what each row reports, the date range, and sending
the order to the customer.

Chosen for what a wrong answer would cost: a pending figure that ignores a
credit note, a delivery status that says delivered too early, and an order
reaching a customer before anybody approved it.
"""

from __future__ import annotations

import base64
from datetime import date, timedelta
from email import message_from_bytes
from email.policy import default as default_policy

from tests.test_erp import API, _customer, _released_order, _stocked, acme, checker, globex, ok, refused  # noqa: F401

PDF = base64.b64encode(b"%PDF-1.7 a very small order").decode()


def _draft(client, acme, **extra) -> dict:
    customer = _customer(client, acme)
    return ok(client.post(f"{API}/sales-orders", json={
        "customer_id": customer["id"],
        "lines": [{"description": "Site survey", "quantity": "1", "rate": "1000", "gst_percent": "18"}], **extra,
    }, headers=acme.headers()), 201)


def _dispatch(client, acme, so, wh, quantity) -> dict:
    return ok(client.post(f"{API}/dispatches", json={
        "sales_order_id": so["id"], "warehouse_id": wh["id"],
        "lines": [{"order_line_id": so["lines"][0]["id"], "quantity": quantity}],
    }, headers=acme.headers()), 201)


def _get(client, acme, so) -> dict:
    return ok(client.get(f"{API}/sales-orders/{so['id']}", headers=acme.headers()))


def test_approval_status_follows_the_order(client, acme, checker):
    so = _draft(client, acme)
    assert so["approval_status"] == "not_submitted" and so["approval_level"] is None
    ok(client.post(f"{API}/sales-orders/{so['id']}/submit", headers=acme.headers()))
    assert _get(client, acme, so)["approval_status"] == "pending"
    decided = ok(client.post(f"{API}/sales-orders/{so['id']}/decide", json={"approve": False, "note": "Wrong rate"}, headers=checker))
    assert decided["approval_status"] == "rejected"

    other = _draft(client, acme)
    cancelled = ok(client.post(f"{API}/sales-orders/{other['id']}/cancel", json={"reason": "Customer withdrew"}, headers=acme.headers()))
    assert cancelled["approval_status"] == "cancelled"


def test_delivery_status_tracks_the_goods(client, acme, checker):
    wh, item = _stocked(client, acme, checker, quantity="10")
    _, so = _released_order(client, acme, checker, item, quantity="4")
    assert so["approval_status"] == "approved" and so["delivery_status"] == "pending"

    _dispatch(client, acme, so, wh, "1")
    assert _get(client, acme, so)["delivery_status"] == "partial"

    last = _dispatch(client, acme, so, wh, "3")
    first = _get(client, acme, so)["dispatches"][0]
    assert _get(client, acme, so)["delivery_status"] == "in_transit"

    ok(client.post(f"{API}/dispatches/{first['id']}/deliver", json={"received_by": "Stores"}, headers=acme.headers()))
    assert _get(client, acme, so)["delivery_status"] == "in_transit", "one of two shipments is still on the road"
    ok(client.post(f"{API}/dispatches/{last['id']}/deliver", json={"received_by": "Stores"}, headers=acme.headers()))
    assert _get(client, acme, so)["delivery_status"] == "delivered"


def test_an_order_with_nothing_to_ship_has_no_delivery_status(client, acme):
    assert _draft(client, acme)["delivery_status"] == "not_applicable"


def test_pending_is_value_less_invoiced_net_of_credit_notes(client, acme, checker):
    wh, item = _stocked(client, acme, checker, quantity="10")
    _, so = _released_order(client, acme, checker, item, quantity="2", rate="1000")
    assert so["grand_total"] == "2360.00" and so["pending_amount"] == "2360.00" and so["invoiced_total"] == "0.00"

    d = _dispatch(client, acme, so, wh, "1")
    row = _get(client, acme, so)["dispatches"][0]
    assert row["uninvoiced"] is True and row["unbilled_value"] == "1180.00"

    inv = ok(client.post(f"{API}/invoices/from-dispatch", json={"dispatch_id": d["id"]}, headers=acme.headers()), 201)
    # A draft has billed nobody yet.
    assert _get(client, acme, so)["pending_amount"] == "2360.00"
    inv = ok(client.post(f"{API}/invoices/{inv['id']}/post", headers=acme.headers()))
    after = _get(client, acme, so)
    assert after["invoiced_total"] == "1180.00" and after["pending_amount"] == "1180.00"
    assert after["dispatches"][0]["uninvoiced"] is False

    note = ok(client.post(f"{API}/credit-notes", json={
        "original_invoice_id": inv["id"], "reason": "Damaged",
        "lines": [{"description": "Return", "quantity": "1", "rate": "500", "gst_percent": "18"}],
    }, headers=acme.headers()), 201)
    ok(client.post(f"{API}/credit-notes/{note['id']}/decide", json={"approve": True}, headers=checker))
    credited = _get(client, acme, so)
    assert credited["invoiced_total"] == "590.00" and credited["pending_amount"] == "1770.00"


def test_a_cancelled_order_has_nothing_pending(client, acme):
    so = _draft(client, acme)
    assert so["pending_amount"] == "1180.00"
    cancelled = ok(client.post(f"{API}/sales-orders/{so['id']}/cancel", json={"reason": "Withdrawn"}, headers=acme.headers()))
    assert cancelled["pending_amount"] == "0.00"


def test_date_range_is_inclusive_and_on_the_order_date(client, acme):
    today = date.today()
    old = _draft(client, acme, order_date=(today - timedelta(days=40)).isoformat())
    new = _draft(client, acme, order_date=today.isoformat())

    def numbers(**params):
        rows = ok(client.get(f"{API}/sales-orders", params=params, headers=acme.headers()))
        return {r["number"] for r in rows}

    assert numbers() == {old["number"], new["number"]}
    assert numbers(date_from=today.isoformat()) == {new["number"]}
    assert numbers(date_to=(today - timedelta(days=40)).isoformat()) == {old["number"]}
    assert numbers(date_from=(today - timedelta(days=39)).isoformat(), date_to=(today - timedelta(days=1)).isoformat()) == set()


def test_row_carries_the_customer_contact_from_the_master(client, acme):
    customer = _customer(client, acme)
    so = ok(client.post(f"{API}/sales-orders", json={
        "customer_id": customer["id"], "lines": [{"description": "X", "quantity": "1", "rate": "1"}],
    }, headers=acme.headers()), 201)
    assert so["customer_email"] == customer.get("email")
    assert so["customer_mobile"] == customer.get("mobile")


class _Mail:
    """Stands in for the SMTP server, so the whole message is still built."""

    def __init__(self, monkeypatch, *, configured=True, accepts=True):
        from app.services import email, mailconfig

        self.sent = []
        self.accepts = accepts
        real = mailconfig.resolve

        def resolve(*args, **kwargs):
            config = real(*args, **kwargs)
            return type("Config", (), {"configured": configured, "sender": "orders@acme.test", "inner": config})()

        def deliver(_config, message):
            if not self.accepts:
                raise OSError("connection refused")
            self.sent.append(message_from_bytes(message.as_bytes(), policy=default_policy))

        monkeypatch.setattr(mailconfig, "resolve", resolve)
        monkeypatch.setattr(email, "_deliver", deliver)


def _send(client, acme, so, **extra):
    body = {"to": "buyer@customer.example.com", "subject": "Sales order", "message": "Please find it attached.", "pdf": PDF, **extra}
    return client.post(f"{API}/sales-orders/{so['id']}/send", json=body, headers=acme.headers())


def test_an_unapproved_order_is_not_sent(client, acme, monkeypatch):
    mail = _Mail(monkeypatch)
    refused(_send(client, acme, _draft(client, acme)), 409, "not_released")
    assert mail.sent == []


def test_sending_attaches_the_pdf_and_is_audited(client, acme, checker, monkeypatch):
    from sqlalchemy import select

    from app.db.session import SessionLocal
    from app.models import AuditLog

    mail = _Mail(monkeypatch)
    _, item = _stocked(client, acme, checker, quantity="10")
    _, so = _released_order(client, acme, checker, item)
    ok(_send(client, acme, so, subject="Sales order\r\nBcc: someone@else.example.com"))

    assert len(mail.sent) == 1
    message = mail.sent[0]
    assert message["To"] == "buyer@customer.example.com"
    assert message["Subject"] == "Sales order Bcc: someone@else.example.com" and message["Bcc"] is None
    assert "Please find it attached." in message.get_body(("plain",)).get_content()
    attached = list(message.iter_attachments())
    assert [a.get_filename() for a in attached] == [f"{so['number'].replace('/', '-')}.pdf"]
    assert attached[0].get_content_type() == "application/pdf"
    assert attached[0].get_content().startswith(b"%PDF")

    with SessionLocal() as db:
        actions = list(db.scalars(select(AuditLog.action).where(AuditLog.org_id == acme.id)))
    assert "erp.sales_order.sent" in actions


def test_sending_refuses_what_is_not_a_pdf_or_an_address(client, acme, checker, monkeypatch):
    mail = _Mail(monkeypatch)
    _, item = _stocked(client, acme, checker, quantity="10")
    _, so = _released_order(client, acme, checker, item)
    refused(_send(client, acme, so, pdf=base64.b64encode(b"<html>not a pdf</html>").decode()), 422, "bad_pdf")
    refused(_send(client, acme, so, pdf="not base64 at all!!"), 422, "bad_pdf")
    refused(_send(client, acme, so, to="not-an-address"), 422)
    assert mail.sent == []


def test_sending_says_so_when_mail_cannot_go(client, acme, checker, monkeypatch):
    _, item = _stocked(client, acme, checker, quantity="10")
    _, so = _released_order(client, acme, checker, item)

    _Mail(monkeypatch, configured=False)
    refused(_send(client, acme, so), 409, "mail_not_configured")

    _Mail(monkeypatch, accepts=False)
    refused(_send(client, acme, so), 502, "mail_failed")


def test_another_company_cannot_send_this_order(client, acme, globex, checker, monkeypatch):
    mail = _Mail(monkeypatch)
    _, item = _stocked(client, acme, checker, quantity="10")
    _, so = _released_order(client, acme, checker, item)
    refused(_send(client, globex, so), 404)
    assert mail.sent == []


def test_create_invoice_bills_service_lines_and_charges_against_the_order(client, acme, checker):
    """The payload the list's Create invoice dialog sends for what no dispatch covers."""
    customer = _customer(client, acme)
    so = ok(client.post(f"{API}/sales-orders", json={
        "customer_id": customer["id"], "freight": "500", "other_charges": "100", "charges_gst_percent": "18",
        "payment_terms": "Net 45 days", "terms": "Warranty one year", "shipping_address": "Plot 4, Chakan MIDC",
        "salesperson_id": str(acme.owner.id),
        "lines": [{"description": "Installation", "uom": "Nos", "quantity": "1", "rate": "1000", "gst_percent": "18"}],
    }, headers=acme.headers()), 201)
    ok(client.post(f"{API}/sales-orders/{so['id']}/submit", headers=acme.headers()))
    so = ok(client.post(f"{API}/sales-orders/{so['id']}/decide", json={"approve": True}, headers=checker))
    line = so["lines"][0]
    charge = {"quantity": "1", "gst_percent": "18", "is_charge": True}
    inv = ok(client.post(f"{API}/invoices", json={
        "kind": "service", "customer_id": so["customer_id"], "sales_order_id": so["id"], "place_of_supply": so["place_of_supply"],
        "billing_address": so["billing_address"], "shipping_address": so["shipping_address"], "salesperson_id": so["salesperson_id"],
        "customer_po_number": so["customer_po_number"], "notes": so["notes"], "terms": so["terms"],
        "lines": [
            {"item_id": line["item_id"], "description": line["description"], "hsn_sac": line["hsn_sac"], "uom": line["uom"],
             "quantity": line["quantity"], "rate": line["rate"], "discount_percent": line["discount_percent"], "gst_percent": line["gst_percent"]},
            {"description": "Freight charges", "rate": "500", **charge},
            {"description": "Other charges", "rate": "100", **charge},
        ],
    }, headers=acme.headers()), 201)
    assert inv["grand_total"] == so["grand_total"] == "1888.00"
    assert inv["order_number"] == so["number"]
    assert inv["shipping_address"] == "Plot 4, Chakan MIDC" and inv["terms"] == "Warranty one year"

    ok(client.post(f"{API}/invoices/{inv['id']}/post", headers=acme.headers()))
    after = _get(client, acme, so)
    assert after["invoiced_total"] == "1888.00" and after["pending_amount"] == "0.00"


# --------------------------------------------------------------------------- #
# Delete
# --------------------------------------------------------------------------- #


def _person(acme, *, role="employee", permissions=None, overrides=None) -> dict:
    """Somebody in the company, with a named role when it is given permissions."""
    import uuid

    from app.core.security import create_access_token, generate_enrollment_key, hash_password
    from app.db.session import SessionLocal
    from app.models import OrgRole, User

    with SessionLocal() as db:
        named = None
        if permissions is not None:
            named = OrgRole(id=uuid.uuid4(), org_id=acme.id, name=f"Role {uuid.uuid4().hex[:8]}", base_role=role, permissions=permissions)
            db.add(named)
            db.flush()
        user = User(
            id=uuid.uuid4(), org_id=acme.id, email=f"{uuid.uuid4().hex[:8]}@acme.test", full_name="Somebody", role=role,
            password_hash=hash_password("correct-horse-battery"), is_active=True, enrollment_key=generate_enrollment_key(),
            role_id=named.id if named else None, permission_overrides=overrides,
        )
        db.add(user)
        db.commit()
        token = create_access_token(str(user.id), {"typ": "user", "org": str(acme.id), "role": role})
    return acme.headers(token)


def _delete(client, headers, so):
    return client.delete(f"{API}/sales-orders/{so['id']}", headers=headers)


def test_deleting_a_draft_removes_it_and_keeps_an_audit_record(client, acme):
    from sqlalchemy import select

    from app.db.session import SessionLocal
    from app.models import AuditLog
    from app.models.erp import ErpBillingMilestone, ErpSalesOrderLine

    so = _draft(client, acme, customer_po_number="PO-778", milestones=[{"name": "Advance", "taxable_amount": "100"}])
    assert _delete(client, acme.headers(), so).status_code == 204
    refused(client.get(f"{API}/sales-orders/{so['id']}", headers=acme.headers()), 404)
    assert ok(client.get(f"{API}/sales-orders", headers=acme.headers())) == []

    with SessionLocal() as db:
        assert list(db.scalars(select(ErpSalesOrderLine))) == [] and list(db.scalars(select(ErpBillingMilestone))) == []
        row = db.scalar(select(AuditLog).where(AuditLog.action == "erp.sales_order.deleted"))
    assert row.target_id == so["id"]
    assert row.detail["number"] == so["number"] and row.detail["grand_total"] == "1180.00"
    assert row.detail["customer_po"] == "PO-778" and row.detail["lines"] == 1

    # The number is not handed back.
    assert _draft(client, acme)["number"] != so["number"]


def test_a_submitted_or_approved_order_cannot_be_deleted(client, acme, checker):
    so = _draft(client, acme)
    ok(client.post(f"{API}/sales-orders/{so['id']}/submit", headers=acme.headers()))
    refused(_delete(client, acme.headers(), so), 409, "not_draft")
    ok(client.post(f"{API}/sales-orders/{so['id']}/decide", json={"approve": True}, headers=checker))
    refused(_delete(client, acme.headers(), so), 409, "not_draft")
    assert _get(client, acme, so)["status"] == "approved"


def test_a_dispatched_delivered_or_invoiced_order_cannot_be_deleted(client, acme, checker):
    wh, item = _stocked(client, acme, checker, quantity="10")
    _, so = _released_order(client, acme, checker, item, quantity="1")
    d = _dispatch(client, acme, so, wh, "1")
    refused(_delete(client, acme.headers(), so), 409, "not_draft")
    ok(client.post(f"{API}/dispatches/{d['id']}/deliver", json={"received_by": "Stores"}, headers=acme.headers()))
    refused(_delete(client, acme.headers(), so), 409, "not_draft")
    ok(client.post(f"{API}/invoices/from-dispatch", json={"dispatch_id": d["id"]}, headers=acme.headers()), 201)
    refused(_delete(client, acme.headers(), so), 409, "not_draft")


def test_a_rejected_and_revised_draft_keeps_its_history(client, acme, checker):
    so = _draft(client, acme)
    ok(client.post(f"{API}/sales-orders/{so['id']}/submit", headers=acme.headers()))
    ok(client.post(f"{API}/sales-orders/{so['id']}/decide", json={"approve": False, "note": "Wrong rate"}, headers=checker))
    refused(_delete(client, acme.headers(), so), 409, "not_draft")
    revised = ok(client.post(f"{API}/sales-orders/{so['id']}/revise", headers=acme.headers()))
    assert revised["status"] == "draft" and revised["submitted_at"]
    refused(_delete(client, acme.headers(), so), 409, "was_submitted")


def test_a_draft_something_points_at_cannot_be_deleted(client, acme):
    so = _draft(client, acme)
    ok(client.post(f"{API}/invoices", json={
        "kind": "proforma", "customer_id": so["customer_id"], "sales_order_id": so["id"],
        "lines": [{"description": "Advance", "quantity": "1", "rate": "100", "gst_percent": "18"}],
    }, headers=acme.headers()), 201)
    refused(_delete(client, acme.headers(), so), 409, "has_documents")
    assert _get(client, acme, so)["status"] == "draft"


def test_deleting_is_a_permission_of_its_own(client, acme):
    so = _draft(client, acme)
    # Raises orders, may not delete them.
    refused(_delete(client, _person(acme, permissions={"can_manage_sales_orders": True}), so), 403, "permission_denied")
    # An ordinary employee, and an administrator with it taken away.
    refused(_delete(client, _person(acme), so), 403, "permission_denied")
    refused(_delete(client, _person(acme, role="admin", overrides={"can_delete_sales_orders": False}), so), 403, "permission_denied")
    assert _get(client, acme, so)["status"] == "draft"
    # A role that was given it.
    deleter = _person(acme, permissions={"can_delete_sales_orders": True})
    assert ok(client.get(f"{API}/access", headers=deleter))["can_delete_sales_orders"] is True
    assert ok(client.get(f"{API}/sales-orders", headers=deleter))[0]["id"] == so["id"]
    assert _delete(client, deleter, so).status_code == 204


def test_an_administrator_may_delete_and_another_company_may_not(client, acme, globex):
    so = _draft(client, acme)
    refused(_delete(client, globex.headers(), so), 404)
    assert _delete(client, _person(acme, role="admin"), so).status_code == 204
