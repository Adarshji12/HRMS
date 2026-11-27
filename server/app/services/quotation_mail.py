"""Sending a quotation to the customer by email, from the company's own mail connector (Settings > Email setup).

The email body is the quotation document itself, laid out as in the on-screen preview: letterhead, bill-to, covering
letter, items, bank details, totals, terms and signature. Email clients ignore most CSS, so it is built from tables
with inline styles.
"""

from __future__ import annotations

import uuid
from datetime import date
from html import escape

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models import Organization
from app.schemas import crm as S
from app.services import crm as crm_svc
from app.services import email as mail

MUTED = "#6b7a86"
LINE = "#dde6ec"


def _money(value) -> str:
    return f"₹{float(value or 0):,.2f}"


def _plain(value) -> str:
    n = float(value or 0)
    return str(int(n)) if n == int(n) else f"{n:.2f}"


def _long(d: date | None) -> str:
    return d.strftime("%d %b %Y") if d else "-"


def _pre(text: str | None) -> str:
    return escape(text or "").replace("\n", "<br>")


def _images(db: Session, org_id: uuid.UUID) -> dict[str, tuple[bytes, str]]:
    """The letterhead logo and the stamp, as bytes to embed. Anything that cannot be read is simply left out."""
    from app.services import storage

    found: dict[str, tuple[bytes, str]] = {}
    for kind in crm_svc.QUOTATION_IMAGES:
        key = crm_svc.quotation_image_key(db, org_id, kind)
        if not key:
            continue
        try:
            served = storage.serve(key)
            if served.path:
                with open(served.path, "rb") as fh:
                    found[kind] = (fh.read(), "image/png")
        except Exception:  # noqa: BLE001 - a missing image must not stop the quotation going out
            continue
    return found


def render(q: S.QuotationOut, s: S.QuotationSetup, company: str, intro: str, images: dict[str, tuple[bytes, str]]) -> str:
    detailed = q.style == "detailed"
    accent = s.accent_color if detailed else "#1f2937"
    name = s.company_name or company or "Your company"

    def fill(text: str | None) -> str:
        return (text or "").replace("{customer}", q.customer_name or "Sir / Madam").replace("{company}", name) \
            .replace("{number}", q.number).replace("{date}", _long(q.quote_date))

    td = "padding:8px 10px;border-bottom:1px solid " + LINE
    th = f"padding:8px 10px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:{MUTED};border-bottom:1px solid {LINE};"
    has_discount = any(float(l.discount or 0) > 0 for l in q.lines)

    org_lines = []
    if detailed and s.tagline:
        org_lines.append(f"<div style='font-style:italic;color:{MUTED}'>{escape(s.tagline)}</div>")
    if s.address:
        org_lines.append(f"<div style='color:{MUTED}'>{_pre(s.address)}</div>")
    contact = "  &middot;  ".join(escape(x) for x in (s.phone, s.email, s.website) if x)
    if contact:
        org_lines.append(f"<div style='color:{MUTED}'>{contact}</div>")
    if s.gstin and (not detailed or s.show_gstin_in_header):
        extra = (f"  &middot;  PAN {escape(s.pan)}" if detailed and s.pan else "") + (f"  &middot;  CIN {escape(s.cin)}" if detailed and s.cin else "")
        org_lines.append(f"<div style='color:{MUTED}'>GSTIN {escape(s.gstin)}{extra}</div>")
    logo = "<img src='cid:qlogo' width='64' style='display:block;max-width:64px' alt=''>" if "logo" in images else ""

    head = (
        f"<table width='100%' cellpadding='0' cellspacing='0' style='border-bottom:2px solid {accent};padding-bottom:12px'><tr>"
        f"<td width='72' valign='top'>{logo}</td>"
        f"<td valign='top'><div style='font-size:20px;font-weight:700;color:{accent}'>{escape(name)}</div>{''.join(org_lines)}</td>"
        f"<td valign='top' align='right' style='white-space:nowrap'><div style='font-size:22px;font-weight:700;letter-spacing:.12em;color:{accent}'>QUOTATION</div>"
        f"<div style='color:{MUTED}'>No. <b style='color:#102a3c'>{escape(q.number)}</b></div>"
        f"<div style='color:{MUTED}'>Date <b style='color:#102a3c'>{_long(q.quote_date)}</b></div>"
        f"<div style='color:{MUTED}'>Valid till <b style='color:#102a3c'>{_long(q.valid_until)}</b></div></td></tr></table>"
    )

    place = ", ".join(x for x in (q.city, q.state, q.pincode) if x)
    bill = [f"<div style='font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:{MUTED}'>Bill to</div>",
            f"<div style='font-weight:700;font-size:15px'>{escape(q.customer_name or '-')}</div>"]
    if q.company:
        bill.append(f"<div>{escape(q.company)}</div>")
    if q.billing_address:
        bill.append(f"<div>{_pre(q.billing_address)}</div>")
    if place:
        bill.append(f"<div>{escape(place)}</div>")
    reach = "  &middot;  ".join(escape(x) for x in (q.mobile, q.email) if x)
    if reach:
        bill.append(f"<div>{reach}</div>")
    if q.gstin:
        bill.append(f"<div>GSTIN {escape(q.gstin)}</div>")
    ship = ""
    if q.shipping_address:
        ship = (f"<td width='50%' valign='top' style='padding:12px 14px;background:#f5f6f8;border-radius:8px'>"
                f"<div style='font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:{MUTED}'>Ship to</div>"
                f"<div>{_pre(q.shipping_address)}</div></td>")
    parties = (f"<table width='100%' cellpadding='0' cellspacing='8' style='margin-top:14px'><tr>"
               f"<td width='{'50%' if ship else '60%'}' valign='top' style='padding:12px 14px;background:#f5f6f8;border-radius:8px'>{''.join(bill)}</td>{ship}</tr></table>")

    letter = ""
    if detailed and (q.subject or q.letter_body):
        greeting = fill(s.letter_greeting) or f"Dear {q.customer_name or 'Sir / Madam'},"
        letter = ("<div style='margin-top:14px'>"
                  + (f"<p style='margin:0 0 8px'><b>Subject:</b> {escape(fill(q.subject))}</p>" if q.subject else "")
                  + f"<p style='margin:0 0 8px'>{escape(greeting)}</p>"
                  + (f"<p style='margin:0 0 8px'>{_pre(fill(q.letter_body))}</p>" if q.letter_body else "") + "</div>")

    rows = ""
    for i, l in enumerate(q.lines, start=1):
        disc = ""
        if has_discount:
            d = float(l.discount or 0)
            shown = (f"{_plain(l.discount)}%" if l.discount_is_percent else _money(l.discount)) if d > 0 else "-"
            disc = f"<td style='{td};text-align:right'>{shown}</td>"
        rows += (f"<tr><td style='{td};text-align:center;color:{MUTED}'>{i}</td>"
                 f"<td style='{td}'><b>{escape(l.name)}</b>"
                 + (f"<div style='color:{MUTED};font-size:12px'>{_pre(l.description)}</div>" if l.description else "") + "</td>"
                 f"<td style='{td};color:{MUTED}'>{escape(l.hsn_sac or '-')}</td>"
                 f"<td style='{td};text-align:right'>{_plain(l.quantity)}</td><td style='{td};text-align:right'>{_money(l.rate)}</td>"
                 f"{disc}<td style='{td};text-align:right'>{_plain(l.gst_percent)}%</td>"
                 f"<td style='{td};text-align:right'><b>{_money(l.amount)}</b></td></tr>")
    items = (f"<table width='100%' cellpadding='0' cellspacing='0' style='margin-top:14px;border-collapse:collapse;font-size:13px'>"
             f"<tr><th style='{th}text-align:center'>#</th><th style='{th}text-align:left'>Item &amp; description</th>"
             f"<th style='{th}text-align:left'>HSN/SAC</th><th style='{th}text-align:right'>Qty</th><th style='{th}text-align:right'>Rate</th>"
             + (f"<th style='{th}text-align:right'>Discount</th>" if has_discount else "")
             + f"<th style='{th}text-align:right'>GST</th><th style='{th}text-align:right'>Amount</th></tr>{rows}</table>")

    pay = ""
    if s.bank_enabled and s.account_number:
        pay += (f"<div style='margin-bottom:10px'><div style='font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:{MUTED}'>Bank details</div>"
                f"<div>{escape(s.account_name or '')}</div><div>{escape(s.bank_name or '')}{', ' + escape(s.branch) if s.branch else ''}</div>"
                f"<div>A/c {escape(s.account_number)}{'  &middot;  IFSC ' + escape(s.ifsc) if s.ifsc else ''}</div></div>")
    if s.upi_enabled and s.upi_id:
        pay += (f"<div><div style='font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:{MUTED}'>UPI</div>"
                f"<div>{escape(s.upi_id)}{' (' + escape(s.upi_name) + ')' if s.upi_name else ''}</div></div>")

    def total(label: str, value: str, strong: bool = False) -> str:
        weight = "font-weight:700;font-size:15px;border-top:1px solid " + LINE if strong else ""
        return f"<tr><td style='padding:4px 0;color:{MUTED if not strong else '#102a3c'};{weight}'>{label}</td><td align='right' style='padding:4px 0;{weight}'>{value}</td></tr>"

    tax = (total("IGST", _money(q.igst)) if q.is_interstate else total("CGST", _money(q.cgst)) + total("SGST", _money(q.sgst)))
    totals = ("<table width='260' cellpadding='0' cellspacing='0' align='right' style='font-size:13px'>"
              + total("Sub total", _money(q.sub_total))
              + (total("Discount", "&minus; " + _money(q.discount_total)) if float(q.discount_total or 0) > 0 else "")
              + total("Taxable value", _money(q.taxable_value)) + tax + total("Grand total", _money(q.grand_total), True) + "</table>")
    summary = (f"<table width='100%' cellpadding='0' cellspacing='0' style='margin-top:14px'><tr><td valign='top' style='font-size:13px'>{pay}</td>"
               f"<td valign='top' width='270'>{totals}</td></tr></table>")

    terms_list = ([("Payment terms", q.payment_terms), ("Delivery terms", q.delivery_terms), ("Warranty", q.warranty_terms),
                   ("Terms &amp; conditions", q.terms)] if detailed else [("Terms &amp; conditions", q.terms)])
    terms = "".join(f"<div style='margin-top:10px'><div style='font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:{MUTED}'>{label}</div>"
                    f"<div>{_pre(text)}</div></div>" for label, text in terms_list if text)

    closing = ""
    if detailed and s.letter_closing:
        closing += f"<p style='margin:0 0 6px'>{_pre(fill(s.letter_closing))}</p>"
    if s.footer:
        closing += f"<p style='margin:0;color:{MUTED}'>{_pre(fill(s.footer))}</p>"
    stamp = "<img src='cid:qstamp' height='56' alt='' style='display:block;margin:6px 0'>" if "stamp" in images else "<div style='height:40px'></div>"
    foot = (f"<table width='100%' cellpadding='0' cellspacing='0' style='margin-top:18px;font-size:13px'><tr><td valign='bottom'>{closing}</td>"
            f"<td valign='bottom' align='right' width='220'><div>For {escape(name)}</div>{stamp}"
            f"<div style='font-weight:700'>{escape(s.signatory or 'Authorised signatory')}</div></td></tr></table>")

    cover = "".join(f"<p style='margin:0 0 10px'>{escape(p)}</p>" for p in (intro or "").split("\n\n") if p.strip())
    return (
        "<div style='font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#102a3c;max-width:760px'>"
        f"{cover}"
        "<div style='border:1px solid " + LINE + ";border-radius:10px;padding:22px;background:#fff'>"
        f"{head}{parties}{letter}{items}{summary}{terms}{foot}</div></div>"
    )


def send_quotation(db: Session, org_id: uuid.UUID, q: S.QuotationOut, *, to: str, subject: str, message: str,
                   cc: str | None = None) -> None:
    org = db.get(Organization, org_id)
    company = (org.name if org else "") or ""
    setup = crm_svc.quotation_setup(crm_svc.get_settings(db, org_id))
    images = _images(db, org_id)
    html = render(q, setup, company, message, images)
    inline = [("qlogo" if kind == "logo" else "qstamp", data, mime) for kind, (data, mime) in images.items()]
    ok = mail.send(to, subject, message, html=html, org_id=org_id, bcc=[cc] if cc else None, inline_images=inline)
    if not ok:
        why = mail.last_error()
        raise HTTPException(status.HTTP_409_CONFLICT, detail={
            "reason": "mail_not_configured" if why is None else "mail_failed",
            "message": ("Email is not set up for this company yet. An owner can set it up in Settings, Email setup."
                        if why is None else f"The email could not be sent ({why}).")})
