"""Billing, credit notes and receipts — §6.18 and the start of §6.19.

Three ways an invoice is born, and two of them cannot be typed:

* **From a dispatch** — a product invoice for what left the warehouse, at the
  order's rates. ``invoiced_qty`` on the dispatch line and the order line stops
  the same unit being billed twice (FR-18.01).
* **From a milestone** — once the milestone is ``ready``, i.e. its evidence is
  in (FR-18.03, 18.07).
* **By hand** — a service or proforma invoice. If it names an order, the
  order's value caps it (FR-18.08, "billing beyond PO balance").

A draft has no number; posting issues one. With ``invoice_maker_checker`` on,
the person who posts is not the person who drafted. A posted invoice is never
edited: it is cancelled (only while nothing is received or credited against
it) or corrected by a credit note, which is approved through the workflow
kernel like any other money leaving the company.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from fastapi import Request
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models import CrmCustomer, User
from app.models.erp import (
    DispatchStatus,
    ErpBillingMilestone,
    ErpDispatch,
    ErpInvoice,
    ErpInvoiceLine,
    ErpItem,
    ErpReceipt,
    ErpSalesOrder,
    ErpSalesOrderLine,
    InvoiceKind,
    InvoiceStatus,
    MilestoneStatus,
    SalesOrderStatus,
)
from app.schemas import erp as S
from app.services.erp import masters
from app.services.erp.common import (
    ZERO,
    ErpError,
    get_owned,
    get_settings,
    is_interstate,
    kernel_decide,
    may,
    money,
    next_number,
    price_line,
    qty,
    record_audit,
    require,
    require_reason,
    row_dict,
    split_tax,
    user_names,
)

PREFIX = {"product": "INV", "service": "INV", "milestone": "INV", "proforma": "PI", "credit_note": "CN"}
BUCKETS = ((0, "current"), (30, "1-30"), (60, "31-60"), (90, "61-90"))


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _readable(viewer: User) -> bool:
    return any(may(viewer, f) for f in ("can_manage_billing", "can_approve_billing", "can_manage_sales_orders"))


# --------------------------------------------------------------------------- #
# Exposure
# --------------------------------------------------------------------------- #


def customer_exposure(db: Session, org_id: uuid.UUID, customer_id: uuid.UUID) -> dict:
    """What a customer owes, what is ordered but not billed, and how late."""
    invoices = list(db.scalars(select(ErpInvoice).where(
        ErpInvoice.org_id == org_id, ErpInvoice.customer_id == customer_id,
        ErpInvoice.status == InvoiceStatus.POSTED.value,
        ErpInvoice.kind.notin_([InvoiceKind.CREDIT_NOTE.value, InvoiceKind.PROFORMA.value]),
    )))
    today = date.today()
    outstanding = sum((i.outstanding for i in invoices), ZERO)
    overdue = [i for i in invoices if i.outstanding > 0 and i.due_date and i.due_date < today]
    open_orders = list(db.scalars(select(ErpSalesOrder).where(
        ErpSalesOrder.org_id == org_id, ErpSalesOrder.customer_id == customer_id,
        ErpSalesOrder.status.in_([SalesOrderStatus.APPROVED.value, SalesOrderStatus.PARTIALLY_DISPATCHED.value,
                                  SalesOrderStatus.ON_HOLD.value, SalesOrderStatus.DISPATCHED.value]),
    )))
    billed_on_orders = ZERO
    if open_orders:
        billed_on_orders = Decimal(str(db.scalar(select(func.coalesce(func.sum(ErpInvoice.grand_total), 0)).where(
            ErpInvoice.sales_order_id.in_([o.id for o in open_orders]),
            ErpInvoice.status == InvoiceStatus.POSTED.value,
            ErpInvoice.kind.notin_([InvoiceKind.CREDIT_NOTE.value, InvoiceKind.PROFORMA.value]),
        )) or 0))
    open_value = max(ZERO, sum((o.grand_total for o in open_orders), ZERO) - billed_on_orders)
    return {
        "outstanding": str(money(outstanding)),
        "overdue": str(money(sum((i.outstanding for i in overdue), ZERO))),
        "oldest_overdue_days": max(((today - i.due_date).days for i in overdue), default=0),
        "open_order_value": str(money(open_value)),
    }


# --------------------------------------------------------------------------- #
# Reads
# --------------------------------------------------------------------------- #


def _invoice_out(db: Session, inv: ErpInvoice) -> dict:
    from app.services import chains

    names = user_names(db, inv.org_id, [inv.created_by, inv.reviewed_by, inv.posted_by])
    so = db.get(ErpSalesOrder, inv.sales_order_id) if inv.sales_order_id else None
    original = db.get(ErpInvoice, inv.original_invoice_id) if inv.original_invoice_id else None
    receipts = list(db.scalars(select(ErpReceipt).where(ErpReceipt.invoice_id == inv.id).order_by(ErpReceipt.created_at)))
    credits = list(db.scalars(select(ErpInvoice).where(ErpInvoice.original_invoice_id == inv.id)))
    today = date.today()
    return {
        **row_dict(inv),
        "outstanding": str(inv.outstanding),
        "days_overdue": (today - inv.due_date).days if inv.due_date and inv.outstanding > 0 and inv.due_date < today else 0,
        "order_number": so.number if so else None,
        "original_number": original.number if original else None,
        "created_by_name": names.get(inv.created_by),
        "reviewed_by_name": names.get(inv.reviewed_by),
        "posted_by_name": names.get(inv.posted_by),
        "chain": [row_dict(s) for s in chains.steps_for(db, inv.id)],
        "lines": [row_dict(line) for line in inv.lines],
        "receipts": [row_dict(r) for r in receipts],
        "credit_notes": [
            {"id": str(c.id), "number": c.number, "status": c.status, "grand_total": str(c.grand_total)}
            for c in credits
        ],
    }


def list_invoices(
    db: Session, viewer: User, *, kind: str | None = None, status: str | None = None,
    customer_id: uuid.UUID | None = None, q: str | None = None, outstanding_only: bool = False,
) -> list[dict]:
    if not _readable(viewer):
        require(viewer, "can_manage_billing")
    stmt = select(ErpInvoice).where(ErpInvoice.org_id == viewer.org_id)
    if kind == "invoice":
        stmt = stmt.where(ErpInvoice.kind.in_(["product", "service", "milestone"]))
    elif kind:
        stmt = stmt.where(ErpInvoice.kind == kind)
    if status:
        stmt = stmt.where(ErpInvoice.status == status)
    if customer_id:
        stmt = stmt.where(ErpInvoice.customer_id == customer_id)
    if q:
        stmt = stmt.where(or_(ErpInvoice.number.ilike(f"%{q}%"), ErpInvoice.customer_name.ilike(f"%{q}%")))
    rows = [_invoice_out(db, i) for i in db.scalars(stmt.order_by(ErpInvoice.created_at.desc()).limit(500))]
    if outstanding_only:
        rows = [r for r in rows if Decimal(r["outstanding"]) > 0]
    return rows


def get_invoice(db: Session, viewer: User, invoice_id: uuid.UUID) -> dict:
    from app.services import chains

    inv = get_owned(db, ErpInvoice, viewer.org_id, invoice_id, "invoice")
    if not _readable(viewer) and not chains.is_current_reviewer(db, inv.id, viewer):
        raise ErpError("not_found", "No such invoice.", 404)
    return _invoice_out(db, inv)


# --------------------------------------------------------------------------- #
# Drafting
# --------------------------------------------------------------------------- #


def _price(db: Session, inv: ErpInvoice, lines: list[dict]) -> None:
    inv.lines.clear()
    sub = tax = ZERO
    for order, line in enumerate(lines):
        priced = price_line(line["quantity"], line["rate"], line["gst_percent"])
        inv.lines.append(ErpInvoiceLine(
            org_id=inv.org_id, order_line_id=line.get("order_line_id"),
            dispatch_line_id=line.get("dispatch_line_id"), item_id=line.get("item_id"),
            description=line["description"], hsn_sac=line.get("hsn_sac"), uom=line.get("uom") or "Nos",
            gst_percent=Decimal(str(line["gst_percent"])), sort_order=order, **priced,
        ))
        sub += priced["taxable_value"]
        tax += priced["tax_amount"]
    inv.sub_total = money(sub)
    inv.tax_total = money(tax)
    for key, value in split_tax(inv.tax_total, interstate=inv.is_interstate).items():
        setattr(inv, key, value)
    inv.grand_total = money(sub + tax)


def _new_invoice(db: Session, viewer: User, *, kind: str, customer_id: uuid.UUID, invoice_date: date | None,
                 place_of_supply: str | None, sales_order: ErpSalesOrder | None = None) -> ErpInvoice:
    customer = get_owned(db, CrmCustomer, viewer.org_id, customer_id, "customer")
    account = masters.ensure_account(db, viewer.org_id, customer.id)
    when = invoice_date or date.today()
    place = place_of_supply or (sales_order.place_of_supply if sales_order else None) or account.billing_state
    settings = get_settings(db, viewer.org_id)
    inv = ErpInvoice(
        org_id=viewer.org_id, kind=kind, customer_id=customer.id,
        customer_name=account.legal_name or customer.company or customer.name,
        gstin=account.gstin, billing_address=(sales_order.billing_address if sales_order else None)
        or account.billing_address, place_of_supply=place,
        sales_order_id=sales_order.id if sales_order else None, invoice_date=when,
        due_date=when + timedelta(days=account.credit_days), terms=settings.invoice_terms,
        is_interstate=is_interstate(db, viewer.org_id, place), created_by=viewer.id,
    )
    db.add(inv)
    return inv


def _invoiced_on_order(db: Session, so_id: uuid.UUID, excluding: uuid.UUID | None = None) -> Decimal:
    stmt = select(func.coalesce(func.sum(ErpInvoice.grand_total), 0)).where(
        ErpInvoice.sales_order_id == so_id,
        ErpInvoice.status.in_([InvoiceStatus.POSTED.value, InvoiceStatus.DRAFT.value]),
        ErpInvoice.kind.in_(["product", "service", "milestone"]),
    )
    if excluding:
        stmt = stmt.where(ErpInvoice.id != excluding)
    credited = db.scalar(select(func.coalesce(func.sum(ErpInvoice.grand_total), 0)).where(
        ErpInvoice.status == InvoiceStatus.POSTED.value, ErpInvoice.kind == "credit_note",
        ErpInvoice.original_invoice_id.in_(select(ErpInvoice.id).where(ErpInvoice.sales_order_id == so_id)),
    ))
    return Decimal(str(db.scalar(stmt) or 0)) - Decimal(str(credited or 0))


def save_manual(db: Session, viewer: User, payload: S.InvoiceIn, invoice_id: uuid.UUID | None = None,
                request: Request | None = None) -> dict:
    require(viewer, "can_manage_billing")
    so = get_owned(db, ErpSalesOrder, viewer.org_id, payload.sales_order_id, "sales order") if payload.sales_order_id else None
    if so is not None and so.customer_id != payload.customer_id:
        raise ErpError("wrong_customer", "That order belongs to a different customer.")
    if invoice_id:
        inv = get_owned(db, ErpInvoice, viewer.org_id, invoice_id, "invoice")
        if inv.status != InvoiceStatus.DRAFT.value or inv.kind not in ("service", "proforma"):
            raise ErpError("not_editable", "Only a draft service or proforma invoice is edited.", 409)
        db.delete(inv)
        db.flush()
    inv = _new_invoice(db, viewer, kind=payload.kind, customer_id=payload.customer_id,
                       invoice_date=payload.invoice_date, place_of_supply=payload.place_of_supply, sales_order=so)
    inv.notes = payload.notes
    lines = []
    for line in payload.lines:
        item = get_owned(db, ErpItem, viewer.org_id, line.item_id, "item") if line.item_id else None
        lines.append({"item_id": item.id if item else None, "description": line.description,
                      "hsn_sac": line.hsn_sac or (item.hsn_sac if item else None),
                      "uom": line.uom or (item.uom if item else None), "quantity": line.quantity,
                      "rate": line.rate, "gst_percent": line.gst_percent})
    _price(db, inv, lines)
    db.flush()
    if so is not None and payload.kind != "proforma":
        if _invoiced_on_order(db, so.id) > so.grand_total:
            raise ErpError("over_order",
                           f"This takes billing on {so.number} past its value of ₹{so.grand_total:,.2f}.", 409)
    record_audit(db, viewer, "invoice.drafted", inv, request=request, detail={"kind": inv.kind})
    db.commit()
    return get_invoice(db, viewer, inv.id)


def from_dispatch(db: Session, viewer: User, payload: S.InvoiceFromDispatchIn, request: Request | None = None) -> dict:
    require(viewer, "can_manage_billing")
    d = get_owned(db, ErpDispatch, viewer.org_id, payload.dispatch_id, "dispatch")
    if d.status == DispatchStatus.CANCELLED.value:
        raise ErpError("cancelled", "A cancelled dispatch is not billed.", 409)
    so = db.get(ErpSalesOrder, d.sales_order_id)
    order_lines = {line.id: line for line in so.lines}
    lines = []
    for dl in d.lines:
        remaining = dl.quantity - dl.invoiced_qty
        if remaining <= 0:
            continue
        ol = order_lines[dl.order_line_id]
        lines.append({"order_line_id": ol.id, "dispatch_line_id": dl.id, "item_id": ol.item_id,
                      "description": ol.description, "hsn_sac": ol.hsn_sac, "uom": ol.uom,
                      "quantity": remaining, "rate": ol.rate, "gst_percent": ol.gst_percent})
    if not lines:
        raise ErpError("already_invoiced", f"Everything on {d.number} is already invoiced.", 409)
    inv = _new_invoice(db, viewer, kind="product", customer_id=so.customer_id,
                       invoice_date=payload.invoice_date, place_of_supply=None, sales_order=so)
    inv.dispatch_id = d.id
    _price(db, inv, lines)
    # Claimed at draft, so two drafts cannot both bill one dispatch. Released if
    # the draft is deleted.
    for line in inv.lines:
        dl = next(x for x in d.lines if x.id == line.dispatch_line_id)
        dl.invoiced_qty = qty(dl.invoiced_qty + line.quantity)
        ol = order_lines[line.order_line_id]
        ol.invoiced_qty = qty(ol.invoiced_qty + line.quantity)
    db.flush()
    record_audit(db, viewer, "invoice.drafted", inv, request=request, detail={"kind": "product", "dispatch": d.number})
    db.commit()
    return get_invoice(db, viewer, inv.id)


def from_milestone(db: Session, viewer: User, payload: S.InvoiceFromMilestoneIn, request: Request | None = None) -> dict:
    require(viewer, "can_manage_billing")
    ms = get_owned(db, ErpBillingMilestone, viewer.org_id, payload.milestone_id, "milestone")
    if ms.status != MilestoneStatus.READY.value:
        raise ErpError(
            "not_ready",
            "This milestone is already invoiced." if ms.status == MilestoneStatus.INVOICED.value
            else "Mark the milestone ready, with its evidence, before invoicing it.", 409,
        )
    so = db.get(ErpSalesOrder, ms.order_id)
    inv = _new_invoice(db, viewer, kind="milestone", customer_id=so.customer_id,
                       invoice_date=payload.invoice_date, place_of_supply=None, sales_order=so)
    inv.milestone_id = ms.id
    inv.notes = ms.evidence
    _price(db, inv, [{"description": f"{ms.name} — {so.number}", "quantity": 1,
                      "rate": ms.taxable_amount, "gst_percent": ms.gst_percent}])
    db.flush()
    ms.status = MilestoneStatus.INVOICED.value
    ms.invoice_id = inv.id
    record_audit(db, viewer, "invoice.drafted", inv, request=request, detail={"kind": "milestone", "milestone": ms.name})
    db.commit()
    return get_invoice(db, viewer, inv.id)


def _unclaim(db: Session, inv: ErpInvoice) -> None:
    """Give back what a draft or cancelled invoice had claimed."""
    from app.models.erp import ErpDispatchLine

    for line in inv.lines:
        if line.dispatch_line_id:
            dl = db.get(ErpDispatchLine, line.dispatch_line_id)
            if dl is not None:
                dl.invoiced_qty = max(ZERO, qty(dl.invoiced_qty - line.quantity))
        if line.order_line_id:
            ol = db.get(ErpSalesOrderLine, line.order_line_id)
            if ol is not None:
                ol.invoiced_qty = max(ZERO, qty(ol.invoiced_qty - line.quantity))
    if inv.milestone_id:
        ms = db.get(ErpBillingMilestone, inv.milestone_id)
        if ms is not None and ms.invoice_id == inv.id:
            ms.status = MilestoneStatus.READY.value
            ms.invoice_id = None


def delete_draft(db: Session, viewer: User, invoice_id: uuid.UUID, request: Request | None = None) -> None:
    require(viewer, "can_manage_billing")
    inv = get_owned(db, ErpInvoice, viewer.org_id, invoice_id, "invoice")
    if inv.status not in (InvoiceStatus.DRAFT.value, InvoiceStatus.REJECTED.value):
        raise ErpError("not_draft", "A posted invoice is cancelled or credited, never deleted.", 409)
    _unclaim(db, inv)
    record_audit(db, viewer, "invoice.draft_deleted", inv, request=request)
    db.delete(inv)
    db.commit()


def post_invoice(db: Session, viewer: User, invoice_id: uuid.UUID, request: Request | None = None) -> dict:
    """Issue the number and post. Credit notes are posted by approval instead."""
    require(viewer, "can_manage_billing")
    inv = get_owned(db, ErpInvoice, viewer.org_id, invoice_id, "invoice")
    if inv.kind == InvoiceKind.CREDIT_NOTE.value:
        raise ErpError("needs_approval", "A credit note is submitted for approval.", 409)
    if inv.status != InvoiceStatus.DRAFT.value:
        raise ErpError("not_draft", f"This invoice is {inv.status}.", 409)
    settings = get_settings(db, viewer.org_id)
    if settings.invoice_maker_checker and inv.created_by == viewer.id:
        raise ErpError("self_review", "You drafted this invoice; somebody else posts it.", 403)
    account = masters.ensure_account(db, viewer.org_id, inv.customer_id)
    if account.credit_hold and inv.kind != InvoiceKind.PROFORMA.value:
        raise ErpError("billing_hold", f"{inv.customer_name} is on hold: {account.hold_reason}", 409)
    if inv.invoice_date > date.today():
        raise ErpError("future_date", "An invoice cannot be dated in the future.")
    inv.number = next_number(db, viewer.org_id, PREFIX[inv.kind], inv.invoice_date)
    inv.status = InvoiceStatus.POSTED.value
    inv.posted_by = viewer.id
    inv.posted_at = _now()
    record_audit(db, viewer, "invoice.posted", inv, request=request, detail={"grand_total": str(inv.grand_total)})
    db.commit()
    return get_invoice(db, viewer, inv.id)


def cancel_invoice(db: Session, viewer: User, invoice_id: uuid.UUID, reason: str | None,
                   request: Request | None = None) -> dict:
    """FR-18.16 — only while nothing is received or credited against it."""
    require(viewer, "can_approve_billing")
    inv = get_owned(db, ErpInvoice, viewer.org_id, invoice_id, "invoice")
    if inv.status != InvoiceStatus.POSTED.value or inv.kind == InvoiceKind.CREDIT_NOTE.value:
        raise ErpError("not_posted", "Only a posted invoice is cancelled; drafts are deleted.", 409)
    if inv.amount_received > 0 or inv.amount_credited > 0:
        raise ErpError("settled", "Money is received or credited against this invoice — raise a credit note.", 409)
    inv.cancel_reason = require_reason(reason, "invoice is cancelled")
    inv.status = InvoiceStatus.CANCELLED.value
    _unclaim(db, inv)
    record_audit(db, viewer, "invoice.cancelled", inv, request=request, detail={"reason": inv.cancel_reason})
    db.commit()
    return get_invoice(db, viewer, inv.id)


# --------------------------------------------------------------------------- #
# Credit notes
# --------------------------------------------------------------------------- #


def create_credit_note(db: Session, viewer: User, payload: S.CreditNoteIn, request: Request | None = None) -> dict:
    require(viewer, "can_manage_billing")
    original = get_owned(db, ErpInvoice, viewer.org_id, payload.original_invoice_id, "invoice")
    if original.status != InvoiceStatus.POSTED.value or original.kind in ("credit_note", "proforma"):
        raise ErpError("not_creditable", "A credit note is raised against a posted tax invoice.", 409)
    so = db.get(ErpSalesOrder, original.sales_order_id) if original.sales_order_id else None
    cn = _new_invoice(db, viewer, kind="credit_note", customer_id=original.customer_id,
                      invoice_date=payload.invoice_date, place_of_supply=original.place_of_supply,
                      sales_order=None)
    cn.original_invoice_id = original.id
    cn.is_interstate = original.is_interstate
    cn.reason = payload.reason
    cn.due_date = None
    _price(db, cn, [{"item_id": line.item_id, "description": line.description, "hsn_sac": line.hsn_sac,
                     "uom": line.uom, "quantity": line.quantity, "rate": line.rate,
                     "gst_percent": line.gst_percent} for line in payload.lines])
    if cn.grand_total > original.outstanding:
        raise ErpError("over_credit",
                       f"₹{cn.grand_total:,.2f} is more than the ₹{original.outstanding:,.2f} still open on {original.number}.")
    cn.status = InvoiceStatus.SUBMITTED.value
    cn.submitted_at = _now()
    db.flush()
    from app.services import chains

    chains.start_for(db, kind="credit_note", record_id=cn.id, subject=viewer, record=cn)
    record_audit(db, viewer, "credit_note.submitted", cn, request=request,
                 detail={"against": original.number, "amount": str(cn.grand_total), "order": so.number if so else None})
    db.commit()
    return get_invoice(db, viewer, cn.id)


def decide_credit_note(db: Session, viewer: User, cn_id: uuid.UUID, payload: S.DecisionIn,
                       request: Request | None = None) -> dict:
    from app.services import workflow

    cn = get_owned(db, ErpInvoice, viewer.org_id, cn_id, "credit note")
    if cn.kind != InvoiceKind.CREDIT_NOTE.value:
        raise ErpError("not_credit_note", "That is not a credit note.", 409)

    def on_approve() -> None:
        original = db.get(ErpInvoice, cn.original_invoice_id)
        if cn.grand_total > original.outstanding:
            raise ErpError("over_credit", f"{original.number} has less than this left open now.", 409)
        original.amount_credited = money(original.amount_credited + cn.grand_total)
        cn.number = next_number(db, viewer.org_id, "CN", cn.invoice_date)
        cn.posted_by = viewer.id
        cn.posted_at = _now()

    kernel_decide(db, viewer, workflow.ERP_CREDIT_NOTE, cn, payload, on_approve=on_approve, request=request)
    db.commit()
    return get_invoice(db, viewer, cn.id)


# --------------------------------------------------------------------------- #
# Receipts
# --------------------------------------------------------------------------- #


def list_receipts(db: Session, viewer: User, *, customer_id: uuid.UUID | None = None) -> list[dict]:
    if not _readable(viewer):
        require(viewer, "can_manage_billing")
    stmt = select(ErpReceipt, ErpInvoice).join(ErpInvoice, ErpInvoice.id == ErpReceipt.invoice_id).where(
        ErpReceipt.org_id == viewer.org_id)
    if customer_id:
        stmt = stmt.where(ErpReceipt.customer_id == customer_id)
    return [
        {**row_dict(r), "invoice_number": inv.number, "customer_name": inv.customer_name}
        for r, inv in db.execute(stmt.order_by(ErpReceipt.created_at.desc()).limit(500)).all()
    ]


def record_receipt(db: Session, viewer: User, payload: S.ReceiptIn, request: Request | None = None) -> dict:
    require(viewer, "can_manage_billing")
    inv = get_owned(db, ErpInvoice, viewer.org_id, payload.invoice_id, "invoice")
    if inv.status != InvoiceStatus.POSTED.value or inv.kind in ("credit_note", "proforma"):
        raise ErpError("not_payable", "Receipts are recorded against a posted tax invoice.", 409)
    settled = money(payload.amount) + money(payload.tds_amount)
    if settled <= 0:
        raise ErpError("zero_receipt", "A receipt must settle something.")
    if settled > inv.outstanding:
        raise ErpError("over_receipt",
                       f"₹{settled:,.2f} is more than the ₹{inv.outstanding:,.2f} outstanding on {inv.number}.")
    when = payload.received_on or date.today()
    if when > date.today():
        raise ErpError("future_date", "Money cannot be received in the future.")
    row = ErpReceipt(
        org_id=viewer.org_id, invoice_id=inv.id, customer_id=inv.customer_id, received_on=when,
        amount=money(payload.amount), tds_amount=money(payload.tds_amount), mode=payload.mode,
        reference=payload.reference, notes=payload.notes, created_by=viewer.id,
        number=next_number(db, viewer.org_id, "RCT", when),
    )
    db.add(row)
    inv.amount_received = money(inv.amount_received + settled)
    db.flush()
    record_audit(db, viewer, "receipt.recorded", row, request=request,
                 detail={"invoice": inv.number, "amount": str(row.amount), "tds": str(row.tds_amount)})
    db.commit()
    return get_invoice(db, viewer, inv.id)


def reverse_receipt(db: Session, viewer: User, receipt_id: uuid.UUID, reason: str | None,
                    request: Request | None = None) -> dict:
    """A bounced cheque. The receipt stays, marked reversed."""
    require(viewer, "can_approve_billing")
    row = get_owned(db, ErpReceipt, viewer.org_id, receipt_id, "receipt")
    if row.status != "posted":
        raise ErpError("already_reversed", "This receipt is already reversed.", 409)
    row.reverse_reason = require_reason(reason, "receipt is reversed")
    row.status = "reversed"
    inv = db.get(ErpInvoice, row.invoice_id)
    inv.amount_received = max(ZERO, money(inv.amount_received - row.amount - row.tds_amount))
    record_audit(db, viewer, "receipt.reversed", row, request=request, detail={"reason": row.reverse_reason})
    db.commit()
    return get_invoice(db, viewer, inv.id)


# --------------------------------------------------------------------------- #
# Ageing
# --------------------------------------------------------------------------- #


def _bucket(days: int) -> str:
    if days <= 0:
        return "current"
    for limit, label in BUCKETS[1:]:
        if days <= limit:
            return label
    return "90+"


def ageing(db: Session, viewer: User) -> dict:
    """AR ageing by customer — FR-19.01. Days past the due date, not the invoice date."""
    if not _readable(viewer):
        require(viewer, "can_manage_billing")
    today = date.today()
    labels = ["current", "1-30", "31-60", "61-90", "90+"]
    by_customer: dict[uuid.UUID, dict] = {}
    totals = {label: ZERO for label in labels}
    for inv in db.scalars(select(ErpInvoice).where(
        ErpInvoice.org_id == viewer.org_id, ErpInvoice.status == InvoiceStatus.POSTED.value,
        ErpInvoice.kind.in_(["product", "service", "milestone"]),
    )):
        open_amount = inv.outstanding
        if open_amount <= 0:
            continue
        days = (today - inv.due_date).days if inv.due_date else 0
        label = _bucket(days)
        row = by_customer.setdefault(inv.customer_id, {
            "customer_id": str(inv.customer_id), "customer_name": inv.customer_name,
            **{label_: ZERO for label_ in labels}, "total": ZERO, "invoices": 0,
        })
        row[label] += open_amount
        row["total"] += open_amount
        row["invoices"] += 1
        totals[label] += open_amount
    rows = sorted(by_customer.values(), key=lambda r: r["total"], reverse=True)
    return {
        "buckets": labels,
        "rows": [{k: (str(money(v)) if isinstance(v, Decimal) else v) for k, v in r.items()} for r in rows],
        "totals": {k: str(money(v)) for k, v in totals.items()},
        "total": str(money(sum(totals.values(), ZERO))),
    }
