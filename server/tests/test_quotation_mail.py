"""Emailing a quotation to the customer."""

from __future__ import annotations

from datetime import date

from app.services import email as mail


def _quote(client, tenant):
    r = client.post("/api/v1/crm/quotations", headers=tenant.headers(), json={
        "quote_date": date.today().isoformat(), "customer_name": "Advotalk",
        "lines": [{"name": "Bizinteract Enterprise", "quantity": "2", "rate": "1000", "gst_percent": "18"}]})
    assert r.status_code == 201, r.text
    return r.json()


def test_the_email_carries_the_lines_and_the_total(client, tenants, monkeypatch):
    acme, _ = tenants
    q = _quote(client, acme)
    seen = {}

    def fake(to, subject, body, html=None, org_id=None, attachments=None, bcc=None, inline_images=None):
        seen.update(to=to, subject=subject, html=html, bcc=bcc)
        return True

    monkeypatch.setattr(mail, "send", fake)
    r = client.post(f"/api/v1/crm/quotations/{q['id']}/email", headers=acme.headers(),
                    json={"to": "buyer@example.com", "cc": "boss@example.com", "subject": "Quotation",
                          "message": "Hello,\n\nPlease find it."})
    assert r.status_code == 204, r.text
    assert seen["to"] == "buyer@example.com" and seen["bcc"] == ["boss@example.com"]
    assert "Bizinteract Enterprise" in seen["html"] and q["number"] in seen["html"]
    # The document itself, not a note: letterhead, bill-to, tax and the grand total.
    assert "QUOTATION" in seen["html"] and "Bill to" in seen["html"] and "Grand total" in seen["html"] and "CGST" in seen["html"]


def test_without_a_mail_connector_it_says_so(client, tenants, monkeypatch):
    acme, _ = tenants
    q = _quote(client, acme)
    monkeypatch.setattr(mail, "send", lambda *a, **k: False)
    monkeypatch.setattr(mail, "last_error", lambda: None)
    r = client.post(f"/api/v1/crm/quotations/{q['id']}/email", headers=acme.headers(),
                    json={"to": "buyer@example.com", "subject": "S", "message": "m"})
    assert r.status_code == 409 and r.json()["detail"]["reason"] == "mail_not_configured"
