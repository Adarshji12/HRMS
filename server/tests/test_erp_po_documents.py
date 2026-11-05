"""The purchase order as a document that leaves the building: its extra particulars,
its attachments, and sending it to the vendor.

Chosen for what a wrong answer would cost: an order reaching a vendor before
anybody approved it, attachment bytes bloating every list response, and a
script arriving dressed as a picture.
"""

from __future__ import annotations

import base64
from datetime import date, timedelta

from tests.test_erp import API, _active_vendor, _approved_po, _item, _warehouse, acme, checker, globex, ok, refused  # noqa: F401
from tests.test_erp_so_list import _Mail

PDF = base64.b64encode(b"%PDF-1.7 a very small order").decode()
FILE = "data:application/pdf;base64,JVBERi0xLjcK"


def _body(vendor, item, **extra) -> dict:
    return {"vendor_id": vendor["id"], "lines": [{"item_id": item["id"], "quantity": "2", "rate": "1000"}], **extra}


def _draft(client, acme, checker, **extra) -> dict:
    vendor = _active_vendor(client, acme, checker)
    item = _item(client, acme)
    return ok(client.post(f"{API}/purchase-orders", json=_body(vendor, item, **extra), headers=acme.headers()), 201)


def _attach(client, tenant, po, name="quote.pdf", data=FILE):
    return client.post(f"{API}/purchase-orders/{po['id']}/attachments", json={"name": name, "data": data}, headers=tenant.headers())


def _send(client, tenant, po, **extra):
    body = {"to": "sales@vendor.example.com", "subject": "Purchase order", "message": "Attached.", "pdf": PDF, **extra}
    return client.post(f"{API}/purchase-orders/{po['id']}/send", json=body, headers=tenant.headers())


def test_the_new_particulars_are_kept_and_edited(client, acme, checker):
    vendor = _active_vendor(client, acme, checker)
    item = _item(client, acme)
    today = date.today()
    wanted = (today + timedelta(days=10)).isoformat()
    body = _body(vendor, item, vendor_quote_ref="  VQ-778  ", vendor_quote_date=today.isoformat(), contact_person="Asha Rao",
                 billing_address="12 MG Road, Pune", notes="Call first", terms="Warranty one year")
    body["lines"][0]["expected_date"] = wanted
    po = ok(client.post(f"{API}/purchase-orders", json=body, headers=acme.headers()), 201)
    assert po["vendor_quote_ref"] == "VQ-778" and po["vendor_quote_date"] == today.isoformat()
    assert po["contact_person"] == "Asha Rao" and po["billing_address"] == "12 MG Road, Pune"
    assert po["notes"] == "Call first" and po["terms"] == "Warranty one year"
    assert po["lines"][0]["expected_date"] == wanted

    edited = ok(client.put(f"{API}/purchase-orders/{po['id']}", json={**body, "vendor_quote_ref": None, "terms": "New terms"}, headers=acme.headers()))
    assert edited["vendor_quote_ref"] is None and edited["terms"] == "New terms" and edited["contact_person"] == "Asha Rao"


def test_the_order_carries_what_the_printed_copy_needs_of_the_vendor(client, acme, checker):
    wh = _warehouse(client, acme)
    po = _draft(client, acme, checker, warehouse_id=wh["id"])
    assert po["vendor_name"] and "vendor_email" in po and "vendor_address" in po and "vendor_gstin" in po
    assert "warehouse_address" in po and po["attachments"] == []


def test_dates_that_cannot_be_right_are_refused(client, acme, checker):
    vendor = _active_vendor(client, acme, checker)
    item = _item(client, acme)
    today = date.today()
    early = _body(vendor, item, order_date=today.isoformat())
    early["lines"][0]["expected_date"] = (today - timedelta(days=1)).isoformat()
    refused(client.post(f"{API}/purchase-orders", json=early, headers=acme.headers()), 422, "bad_dates")
    future = _body(vendor, item, vendor_quote_date=(today + timedelta(days=1)).isoformat())
    refused(client.post(f"{API}/purchase-orders", json=future, headers=acme.headers()), 422, "future_quote")


def test_a_po_from_an_rfq_takes_the_vendors_quotation_number(client, acme, checker):
    vendor = _active_vendor(client, acme, checker)
    item = _item(client, acme)
    rfq = ok(client.post(f"{API}/rfqs", json={"title": "Switches", "vendor_ids": [vendor["id"]],
                                             "lines": [{"item_id": item["id"], "quantity": "2", "estimated_rate": "1000"}]}, headers=acme.headers()), 201)
    ok(client.post(f"{API}/rfqs/{rfq['id']}/issue", headers=acme.headers()))
    ok(client.post(f"{API}/rfqs/{rfq['id']}/quotes", json={
        "vendor_id": vendor["id"], "quote_ref": "VQ-55", "lines": [{"rfq_line_id": rfq["lines"][0]["id"], "rate": "900"}],
    }, headers=acme.headers()), 201)
    comparison = ok(client.get(f"{API}/rfqs/{rfq['id']}/comparison", headers=acme.headers()))
    ok(client.post(f"{API}/rfqs/{rfq['id']}/award", json={"quote_id": comparison["quotes"][0]["id"], "reason": "Only quote received"}, headers=acme.headers()))
    po = ok(client.post(f"{API}/rfqs/{rfq['id']}/purchase-order", headers=acme.headers()), 201)
    assert po["vendor_quote_ref"] == "VQ-55"


def test_attachments_are_listed_without_their_bytes_and_fetched_one_at_a_time(client, acme, checker):
    po = _draft(client, acme, checker)
    po = ok(_attach(client, acme, po), 201)
    assert [a["name"] for a in po["attachments"]] == ["quote.pdf"]
    assert "data" not in po["attachments"][0]
    assert "data" not in ok(client.get(f"{API}/purchase-orders", headers=acme.headers()))[0]["attachments"][0]

    att = po["attachments"][0]["id"]
    got = ok(client.get(f"{API}/purchase-orders/{po['id']}/attachments/{att}", headers=acme.headers()))
    assert got == {"name": "quote.pdf", "data": FILE}
    gone = ok(client.delete(f"{API}/purchase-orders/{po['id']}/attachments/{att}", headers=acme.headers()))
    assert gone["attachments"] == []
    refused(client.get(f"{API}/purchase-orders/{po['id']}/attachments/{att}", headers=acme.headers()), 404)


def test_only_pictures_and_pdfs_up_to_ten(client, acme, checker):
    po = _draft(client, acme, checker)
    refused(_attach(client, acme, po, "x.html", "data:text/html;base64,PGI+aGk8L2I+"), 422)
    refused(_attach(client, acme, po, "x.svg", "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIi8+"), 422)
    for n in range(10):
        ok(_attach(client, acme, po, f"f{n}.pdf"), 201)
    refused(_attach(client, acme, po, "eleven.pdf"), 422, "too_many")


def test_a_cancelled_orders_files_stay_as_they_are(client, acme, checker):
    po = _draft(client, acme, checker)
    po = ok(_attach(client, acme, po), 201)
    ok(client.post(f"{API}/purchase-orders/{po['id']}/cancel", json={"reason": "Not needed"}, headers=acme.headers()))
    refused(_attach(client, acme, po), 409, "closed")
    refused(client.delete(f"{API}/purchase-orders/{po['id']}/attachments/{po['attachments'][0]['id']}", headers=acme.headers()), 409, "closed")


def test_an_approver_can_read_the_attachments_of_what_they_decide(client, acme, checker):
    po = _draft(client, acme, checker)
    po = ok(_attach(client, acme, po), 201)
    ok(client.post(f"{API}/purchase-orders/{po['id']}/submit", headers=acme.headers()))
    seen = ok(client.get(f"{API}/purchase-orders/{po['id']}", headers=checker))
    got = ok(client.get(f"{API}/purchase-orders/{po['id']}/attachments/{seen['attachments'][0]['id']}", headers=checker))
    assert got["data"] == FILE


def test_an_unapproved_order_does_not_reach_a_vendor(client, acme, checker, monkeypatch):
    mail = _Mail(monkeypatch)
    po = _draft(client, acme, checker)
    refused(_send(client, acme, po), 409, "not_approved")
    ok(client.post(f"{API}/purchase-orders/{po['id']}/submit", headers=acme.headers()))
    refused(_send(client, acme, po), 409, "not_approved")
    assert mail.sent == []


def test_sending_attaches_the_pdf_and_is_audited(client, acme, checker, monkeypatch):
    from sqlalchemy import select

    from app.db.session import SessionLocal
    from app.models import AuditLog

    mail = _Mail(monkeypatch)
    po = _approved_po(client, acme, checker, _active_vendor(client, acme, checker), _item(client, acme))
    ok(_send(client, acme, po))
    assert len(mail.sent) == 1
    message = mail.sent[0]
    assert message["To"] == "sales@vendor.example.com"
    attached = list(message.iter_attachments())
    assert [a.get_filename() for a in attached] == [f"{po['number'].replace('/', '-')}.pdf"]
    assert attached[0].get_content().startswith(b"%PDF")
    with SessionLocal() as db:
        row = db.scalar(select(AuditLog).where(AuditLog.action == "erp.purchase_order.sent"))
    assert row.detail["to"] == "sales@vendor.example.com" and row.detail["number"] == po["number"]


def test_sending_says_so_when_it_cannot_go(client, acme, checker, monkeypatch):
    po = _approved_po(client, acme, checker, _active_vendor(client, acme, checker), _item(client, acme))
    _Mail(monkeypatch, configured=False)
    refused(_send(client, acme, po), 409, "mail_not_configured")
    mail = _Mail(monkeypatch, accepts=False)
    refused(_send(client, acme, po), 502, "mail_failed")
    refused(_send(client, acme, po, pdf=base64.b64encode(b"<html>no</html>").decode()), 422, "bad_pdf")
    refused(_send(client, acme, po, to="not-an-address"), 422)
    assert mail.sent == []


def test_another_company_sees_none_of_it(client, acme, globex, checker, monkeypatch):
    mail = _Mail(monkeypatch)
    po = _approved_po(client, acme, checker, _active_vendor(client, acme, checker), _item(client, acme))
    po = ok(_attach(client, acme, po), 201)
    refused(_send(client, globex, po), 404)
    refused(_attach(client, globex, po), 404)
    refused(client.get(f"{API}/purchase-orders/{po['id']}/attachments/{po['attachments'][0]['id']}", headers=globex.headers()), 404)
    assert mail.sent == []


def test_an_employee_cannot_attach_or_send(client, acme, checker, monkeypatch):
    mail = _Mail(monkeypatch)
    po = _approved_po(client, acme, checker, _active_vendor(client, acme, checker), _item(client, acme))
    staff = acme.headers(acme.employee_token)
    body = {"to": "sales@vendor.example.com", "subject": "x", "message": "y", "pdf": PDF}
    refused(client.post(f"{API}/purchase-orders/{po['id']}/send", json=body, headers=staff), 403)
    refused(client.post(f"{API}/purchase-orders/{po['id']}/attachments", json={"name": "a.pdf", "data": FILE}, headers=staff), 403)
    assert mail.sent == []
