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
from decimal import ROUND_HALF_UP, Decimal

from fastapi import Request
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models import CrmCustomer, User
from app.models.erp import (
    DispatchStatus,
    ErpBillingMilestone,
    ErpCounter,
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
    company_state,
    fiscal_year,
    get_owned,
    get_settings,
    is_interstate,
    line_value,
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

    names = user_names(db, inv.org_id, [inv.created_by, inv.reviewed_by, inv.posted_by, inv.salesperson_id])
    so = db.get(ErpSalesOrder, inv.sales_order_id) if inv.sales_order_id else None
    original = db.get(ErpInvoice, inv.original_invoice_id) if inv.original_invoice_id else None
    receipts = list(db.scalars(select(ErpReceipt).where(ErpReceipt.invoice_id == inv.id).order_by(ErpReceipt.created_at)))
    people = user_names(db, inv.org_id, [u for r in receipts for u in (r.created_by, r.reversed_by)])
    credits = list(db.scalars(select(ErpInvoice).where(ErpInvoice.original_invoice_id == inv.id)
                              .order_by(ErpInvoice.created_at)))
    credit_names = user_names(db, inv.org_id, [c.created_by for c in credits])
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
        "salesperson_name": names.get(inv.salesperson_id),
        "chain": [row_dict(s) for s in chains.steps_for(db, inv.id)],
        "lines": [row_dict(line) for line in inv.lines],
        "receipts": [_receipt_out(r, people) for r in receipts],
        "credit_notes": [
            {"id": str(c.id), "number": c.number, "status": c.status, "grand_total": str(c.grand_total),
             "invoice_date": c.invoice_date.isoformat() if c.invoice_date else None, "reason": c.reason,
             "created_by_name": credit_names.get(c.created_by), "posted_at": c.posted_at.isoformat() if c.posted_at else None}
            for c in credits
        ],
        # Quantity of each line already returned on live credit notes.
        "returned": {str(k): {"quantity": str(v[0]), "taxable_value": str(v[1])} for k, v in _returned(db, inv.id).items()}
        if inv.kind not in (InvoiceKind.CREDIT_NOTE.value, "proforma") else {},
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


def _bill_shares(inv: ErpInvoice, lines: list[dict]) -> dict[int, Decimal]:
    """The rupee discounts on the whole bill — the bill discount amount and the
    additional discount — shared over the item lines in proportion to their
    value, so each line's GST is on its own discounted value. Rounded to the
    paisa; the last line takes what rounding left, so the shares add up to
    exactly the discount. Charges never take a share."""
    total = money(inv.bill_discount_amount or 0) + money(inv.additional_discount or 0)
    if total <= 0:
        return {}
    pct = inv.bill_discount_percent or 0
    values = {
        i: line_value(line["quantity"], line["rate"], line.get("discount_percent") or 0,
                      line.get("discount_amount") or 0, pct,
                      line.get("discount2_percent") or 0, line.get("discount2_amount") or 0)
        for i, line in enumerate(lines) if not line.get("is_charge")
    }
    worth = sum(values.values(), ZERO)
    if total > money(worth):
        raise ErpError("discount_too_large",
                       f"The bill discount (₹{total:,.2f}) is more than the items are worth (₹{money(worth):,.2f}).")
    shares: dict[int, Decimal] = {}
    given = ZERO
    keys = [i for i, v in values.items() if v > 0]
    for n, i in enumerate(keys):
        share = total - given if n == len(keys) - 1 else money(total * values[i] / worth)
        shares[i] = share
        given += share
    return shares


def _price(db: Session, inv: ErpInvoice, lines: list[dict]) -> None:
    inv.lines.clear()
    sub = tax = ZERO
    shares = _bill_shares(inv, lines)
    cess_sum = ZERO
    for order, line in enumerate(lines):
        priced = price_line(line["quantity"], line["rate"], line["gst_percent"], line.get("discount_percent") or 0,
                            line.get("discount_amount") or 0,
                            ZERO if line.get("is_charge") else inv.bill_discount_percent or 0,
                            line.get("discount2_percent") or 0, line.get("discount2_amount") or 0,
                            shares.get(order, ZERO))
        # Cess is charged on the same taxable value as GST, rounded per line.
        cess_pct = ZERO if line.get("is_charge") else Decimal(str(line.get("cess_percent") or 0))
        cess = money(priced["taxable_value"] * cess_pct / Decimal("100"))
        inv.lines.append(ErpInvoiceLine(
            org_id=inv.org_id, order_line_id=line.get("order_line_id"),
            dispatch_line_id=line.get("dispatch_line_id"), item_id=line.get("item_id"),
            source_line_id=line.get("source_line_id"),
            description=line["description"], hsn_sac=line.get("hsn_sac"), uom=line.get("uom") or "Nos",
            gst_percent=Decimal(str(line["gst_percent"])), sort_order=order,
            discount_percent=Decimal(str(line.get("discount_percent") or 0)),
            discount_amount=money(line.get("discount_amount") or 0),
            discount2_percent=Decimal(str(line.get("discount2_percent") or 0)),
            discount2_amount=money(line.get("discount2_amount") or 0),
            free_qty=qty(line.get("free_qty") or 0), is_charge=bool(line.get("is_charge")),
            cess_percent=Decimal(str(cess_pct)), cess_amount=cess, **{**priced, "amount": priced["amount"] + cess},
        ))
        sub += priced["taxable_value"]
        tax += priced["tax_amount"]
        cess_sum += cess
    inv.sub_total = money(sub)
    inv.tax_total = money(tax)
    inv.cess_total = money(cess_sum)
    for key, value in split_tax(inv.tax_total, interstate=inv.is_interstate).items():
        setattr(inv, key, value)
    inv.grand_total = money(sub + tax + cess_sum)
    inv.round_off = ZERO


def peek_number(db: Session, viewer: User, kind: str, on: date | None = None) -> dict:
    """The number the next invoice of ``kind`` would get if posted on ``on`` —
    shown on a draft. Read only: the counter moves when an invoice is posted,
    so two drafts open at once show the same next number."""
    require(viewer, "can_manage_billing")
    if kind not in PREFIX:
        raise ErpError("bad_kind", "Unknown invoice kind.")
    when = on or date.today()
    prefix = PREFIX[kind]
    row = db.scalar(select(ErpCounter).where(
        ErpCounter.org_id == viewer.org_id, ErpCounter.series == prefix, ErpCounter.period == fiscal_year(when)))
    start = when.year if when.month >= 4 else when.year - 1
    n = (row.last_number if row else 0) + 1
    # The company's state goes with it, so the bill can say intra- or
    # inter-state before it is saved.
    return {"number": f"{prefix}-{start}-{(start + 1) % 100:02d}-{n:04d}",
            "company_state": company_state(db, viewer.org_id)}


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
        customer_po_number=sales_order.customer_po_number if sales_order else None,
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
    if payload.due_date is not None:
        if payload.due_date < inv.invoice_date:
            raise ErpError("due_before_invoice", "The due date cannot be before the invoice date.")
        inv.due_date = payload.due_date
    if payload.terms is not None:
        inv.terms = payload.terms
    if payload.billing_address is not None:
        inv.billing_address = payload.billing_address
    inv.shipping_address = payload.shipping_address
    if payload.salesperson_id is not None:
        person = db.get(User, payload.salesperson_id)
        if person is None or person.org_id != viewer.org_id:
            raise ErpError("bad_salesperson", "That salesperson is not in this organisation.")
    inv.salesperson_id = payload.salesperson_id
    if payload.recipient_bank_id:
        accounts = get_settings(db, viewer.org_id).bank_accounts or []
        bank = next((a for a in accounts if a.get("id") == payload.recipient_bank_id), None)
        if bank is None:
            raise ErpError("bad_bank", "That bank account is not set up in ERP settings.")
        inv.recipient_bank = bank
    else:
        inv.recipient_bank = None
    for field in ("customer_po_number", "reverse_charge", "dispatch_doc_number", "transporter_name",
                  "vehicle_number", "eway_bill_number", "lr_number"):
        setattr(inv, field, getattr(payload, field))
    inv.payment_ref_standard = payload.payment_ref_standard
    inv.payment_reference = None if payload.payment_ref_standard else payload.payment_reference
    inv.delivery_date = payload.delivery_date
    lines = []
    for line in payload.lines:
        item = get_owned(db, ErpItem, viewer.org_id, line.item_id, "item") if line.item_id else None
        lines.append({"item_id": item.id if item else None, "description": line.description,
                      "hsn_sac": line.hsn_sac or (item.hsn_sac if item else None),
                      "uom": line.uom or (item.uom if item else None), "quantity": line.quantity,
                      "rate": line.rate, "discount_percent": line.discount_percent,
                      "discount_amount": line.discount_amount, "is_charge": line.is_charge,
                      "discount2_percent": line.discount2_percent, "discount2_amount": line.discount2_amount,
                      "free_qty": line.free_qty, "cess_percent": line.cess_percent,
                      "gst_percent": line.gst_percent})
    inv.bill_discount_percent = payload.bill_discount_percent
    inv.bill_discount_amount = payload.bill_discount_amount
    inv.additional_discount = payload.additional_discount
    inv.discount_reason = (payload.discount_reason or "").strip() or None
    if inv.additional_discount > 0 and not inv.discount_reason:
        raise ErpError("reason_required", "Give a reason for the additional discount.")
    _price(db, inv, lines)
    if payload.round_off:
        rounded = inv.grand_total.quantize(Decimal("1"), rounding=ROUND_HALF_UP)
        inv.round_off = money(rounded - inv.grand_total)
        inv.grand_total = money(rounded)
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
                      "quantity": remaining, "rate": ol.rate, "gst_percent": ol.gst_percent,
                      "discount_percent": ol.discount_percent})
    if not lines:
        raise ErpError("already_invoiced", f"Everything on {d.number} is already invoiced.", 409)
    inv = _new_invoice(db, viewer, kind="product", customer_id=so.customer_id,
                       invoice_date=payload.invoice_date, place_of_supply=None, sales_order=so)
    inv.dispatch_id = d.id
    # The goods travelled under this dispatch: its transport goes on the invoice.
    inv.dispatch_doc_number = d.number
    inv.transporter_name = d.transporter
    inv.vehicle_number = d.vehicle_no
    inv.eway_bill_number = d.eway_bill_no
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
    """Delete a draft — or, for an administrator, an issued invoice made in
    error that nothing has been paid or credited against.

    An issued invoice's number is freed when it is the latest in its series,
    so the next invoice takes it and the series has no gap; an older number
    leaves a gap, which the screen warns about before asking. Every deletion
    of an issued invoice is in the audit log with its number."""
    require(viewer, "can_manage_billing")
    inv = get_owned(db, ErpInvoice, viewer.org_id, invoice_id, "invoice")
    if inv.status in (InvoiceStatus.DRAFT.value, InvoiceStatus.REJECTED.value):
        _unclaim(db, inv)
        record_audit(db, viewer, "invoice.draft_deleted", inv, request=request)
        db.delete(inv)
        db.commit()
        return
    if not viewer.role_enum.can_administer:
        raise ErpError("not_draft", "Only an administrator deletes an issued invoice. Cancel it instead.", 403)
    if inv.kind == InvoiceKind.CREDIT_NOTE.value or inv.status not in (
            InvoiceStatus.POSTED.value, InvoiceStatus.CANCELLED.value):
        raise ErpError("not_deletable", "This document cannot be deleted.", 409)
    # Payment records are never deleted, reversed ones included: they are the
    # audit trail of what was received and taken back. A draft or rejected
    # credit note was never issued; those go with the invoice.
    receipts = list(db.scalars(select(ErpReceipt).where(ErpReceipt.invoice_id == inv.id)))
    credits = list(db.scalars(select(ErpInvoice).where(ErpInvoice.original_invoice_id == inv.id)))
    live_credits = [c for c in credits if c.status not in (InvoiceStatus.DRAFT.value, InvoiceStatus.REJECTED.value)]
    if any(r.status == "posted" for r in receipts):
        raise ErpError("has_money", "A payment is recorded against this invoice. Reverse the payment first, "
                                    "then delete the invoice.", 409)
    if receipts:
        raise ErpError("has_payment_history", "This invoice has payment history (a reversed payment), which is kept "
                                              "for audit. Cancel the invoice instead.", 409)
    if live_credits:
        raise ErpError("has_money", "A credit note is issued against this invoice, so it cannot be deleted.", 409)
    for row in credits:
        db.delete(row)
    db.flush()
    if inv.status == InvoiceStatus.POSTED.value:
        _unclaim(db, inv)  # cancelling already gave these back
    freed = _release_number(db, inv)
    record_audit(db, viewer, "invoice.deleted", inv, request=request,
                 detail={"number": inv.number, "status": inv.status, "number_reused": freed})
    db.delete(inv)
    db.commit()


def _release_number(db: Session, inv: ErpInvoice) -> bool:
    """Hand the number back when it is the last one issued in its series."""
    if not inv.number:
        return False
    try:
        n = int(inv.number.replace("/", "-").rsplit("-", 1)[-1])
    except ValueError:
        return False
    counter = db.scalar(select(ErpCounter).where(
        ErpCounter.org_id == inv.org_id, ErpCounter.series == PREFIX[inv.kind],
        ErpCounter.period == fiscal_year(inv.invoice_date)))
    if counter is None or counter.last_number != n:
        return False
    counter.last_number -= 1
    return True


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
    inv.number = next_number(db, viewer.org_id, PREFIX[inv.kind], inv.invoice_date, dashed=True)
    if inv.payment_ref_standard:
        inv.payment_reference = inv.number
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


_LIVE_CREDIT = (InvoiceStatus.SUBMITTED.value, InvoiceStatus.POSTED.value)


def _returned(db: Session, invoice_id: uuid.UUID) -> dict[uuid.UUID, tuple[Decimal, Decimal]]:
    """Per original line: quantity and taxable value already credited on credit
    notes that are posted or awaiting approval (a rejected one frees it)."""
    rows = db.execute(
        select(ErpInvoiceLine.source_line_id, func.sum(ErpInvoiceLine.quantity), func.sum(ErpInvoiceLine.taxable_value))
        .join(ErpInvoice, ErpInvoice.id == ErpInvoiceLine.invoice_id)
        .where(ErpInvoice.original_invoice_id == invoice_id, ErpInvoice.kind == InvoiceKind.CREDIT_NOTE.value,
               ErpInvoice.status.in_(_LIVE_CREDIT), ErpInvoiceLine.source_line_id.is_not(None))
        .group_by(ErpInvoiceLine.source_line_id)
    ).all()
    return {sid: (qty(q or 0), money(t or 0)) for sid, q, t in rows}


def _return_lines(db: Session, original: ErpInvoice, returns: list[S.CreditReturnIn]) -> list[dict]:
    """Price returned goods from the invoice they were sold on: the same rate,
    discounts, GST and cess, in proportion to the quantity returned. The last
    of a line takes whatever taxable value is left, so a full return credits
    exactly what was billed."""
    by_id = {line.id: line for line in original.lines}
    done = _returned(db, original.id)
    out = []
    for r in returns:
        src = by_id.get(r.source_line_id)
        if src is None:
            raise ErpError("bad_line", "That line is not on this invoice.")
        back_qty, back_value = done.get(src.id, (ZERO, ZERO))
        left = qty(src.quantity - back_qty)
        q = qty(r.quantity)
        if q > left:
            raise ErpError("over_return", f"Only {left.normalize():f} of “{src.description}” is left to return.")
        taxable = money(src.taxable_value - back_value) if q == left else money(src.taxable_value * q / src.quantity)
        gross = money(q * src.rate)
        out.append({
            "source_line_id": src.id, "item_id": src.item_id, "description": src.description, "hsn_sac": src.hsn_sac,
            "uom": src.uom, "quantity": q, "rate": src.rate, "gst_percent": src.gst_percent,
            "cess_percent": src.cess_percent, "is_charge": False,
            # Whatever the invoice took off this line, the credit takes off in proportion.
            "discount_amount": max(gross - taxable, ZERO),
        })
    return out


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
    _price(db, cn, _return_lines(db, original, payload.returns) + [
        {"item_id": line.item_id, "description": line.description, "hsn_sac": line.hsn_sac,
         "uom": line.uom, "quantity": line.quantity, "rate": line.rate,
         "gst_percent": line.gst_percent} for line in payload.lines])
    if cn.grand_total <= 0:
        raise ErpError("nothing_to_credit", "This credit note comes to nothing.")
    # Credit notes still awaiting approval already claim part of what is open.
    pending = money(db.scalar(select(func.coalesce(func.sum(ErpInvoice.grand_total), 0)).where(
        ErpInvoice.original_invoice_id == original.id, ErpInvoice.kind == InvoiceKind.CREDIT_NOTE.value,
        ErpInvoice.status == InvoiceStatus.SUBMITTED.value)) or 0)
    room = money(original.outstanding - pending)
    if cn.grand_total > room:
        raise ErpError("over_credit",
                       f"₹{cn.grand_total:,.2f} is more than the ₹{max(room, ZERO):,.2f} still open on {original.number}"
                       + (f" (₹{pending:,.2f} is on credit notes awaiting approval)." if pending > 0 else "."))
    cn.status = InvoiceStatus.SUBMITTED.value
    cn.submitted_at = _now()
    db.flush()
    from app.services import chains

    chains.start_for(db, kind="credit_note", record_id=cn.id, subject=viewer, record=cn)
    record_audit(db, viewer, "credit_note.submitted", cn, request=request,
                 detail={"against": original.number, "amount": str(cn.grand_total), "order": so.number if so else None,
                         "reason": cn.reason, "returned": [{"line": str(r.source_line_id), "quantity": str(r.quantity)}
                                                          for r in payload.returns]})
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
        cn.number = next_number(db, viewer.org_id, "CN", cn.invoice_date, dashed=True)
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
        {**{k: v for k, v in row_dict(r).items() if k != "proof"}, "has_proof": bool(r.proof),
         "invoice_number": inv.number, "customer_name": inv.customer_name}
        for r, inv in db.execute(stmt.order_by(ErpReceipt.created_at.desc()).limit(500)).all()
    ]


CASH_ACCOUNT = "cash"


def _deposit_label(db: Session, org_id: uuid.UUID, account_id: str | None) -> str | None:
    """The account's label as it reads today, or a refusal if Settings has no
    such account. "cash" is cash in hand."""
    if not account_id:
        return None
    if account_id == CASH_ACCOUNT:
        return "Cash in hand"
    for acc in get_settings(db, org_id).bank_accounts or []:
        if str(acc.get("id")) == account_id:
            tail = str(acc.get("account_number") or "")[-4:]
            name = acc.get("label") or acc.get("bank_name") or "Bank account"
            return f"{name} · {acc.get('bank_name') or ''} ••{tail}".replace(" ·  ••", " ••").strip()
    raise ErpError("bad_account", "That account is not in ERP Settings → Bank accounts.")


def _receipt_out(r: ErpReceipt, people: dict) -> dict:
    """A receipt for screens and lists — without the proof file itself."""
    out = row_dict(r)
    out.pop("proof", None)
    return {**out, "has_proof": bool(r.proof), "created_by_name": people.get(r.created_by),
            "reversed_by_name": people.get(r.reversed_by), "corrections": r.corrections or []}


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
        reference=(payload.reference or "").strip() or None, notes=(payload.notes or "").strip() or None,
        created_by=viewer.id, number=next_number(db, viewer.org_id, "RCT", when),
        deposit_account_id=payload.deposit_account_id or None,
        deposit_account=_deposit_label(db, viewer.org_id, payload.deposit_account_id),
        proof=payload.proof or None, proof_name=(payload.proof_name or None) if payload.proof else None,
    )
    db.add(row)
    inv.amount_received = money(inv.amount_received + settled)
    db.flush()
    record_audit(db, viewer, "receipt.recorded", row, request=request,
                 detail={"invoice": inv.number, "amount": str(row.amount), "tds": str(row.tds_amount),
                         "account": row.deposit_account, "proof": bool(row.proof)})
    db.commit()
    return get_invoice(db, viewer, inv.id)


def correct_receipt(db: Session, viewer: User, receipt_id: uuid.UUID, payload: S.ReceiptCorrectionIn,
                    request: Request | None = None) -> dict:
    """Fix a posted receipt's details — mode, reference, account, notes, proof.
    Never the money: a wrong amount is reversed and recorded again. Each
    correction is kept on the receipt, old and new side by side, with who,
    when and why, and written to the audit log."""
    require(viewer, "can_manage_billing")
    row = get_owned(db, ErpReceipt, viewer.org_id, receipt_id, "receipt")
    if row.status != "posted":
        raise ErpError("not_posted", "A reversed receipt is not corrected.", 409)
    reason = require_reason(payload.reason, "receipt is corrected")
    sent = payload.model_fields_set
    changes: dict[str, list] = {}

    def change(field: str, new, shown_old=None, shown_new=None) -> None:
        old = getattr(row, field)
        if (old or None) != (new or None):
            changes[field] = [shown_old if shown_old is not None else old, shown_new if shown_new is not None else new]
            setattr(row, field, new)

    if "mode" in sent and payload.mode:
        change("mode", payload.mode)
    if "reference" in sent:
        change("reference", (payload.reference or "").strip() or None)
    if "notes" in sent:
        change("notes", (payload.notes or "").strip() or None)
    if "deposit_account_id" in sent:
        new_id = payload.deposit_account_id or None
        if (row.deposit_account_id or None) != new_id:
            label = _deposit_label(db, viewer.org_id, new_id)
            changes["deposit_account"] = [row.deposit_account, label]
            row.deposit_account_id, row.deposit_account = new_id, label
    if payload.remove_proof and row.proof:
        changes["proof"] = [row.proof_name or "proof", None]
        row.proof = row.proof_name = None
    elif payload.proof:
        changes["proof"] = [row.proof_name if row.proof else None, payload.proof_name or "proof"]
        row.proof, row.proof_name = payload.proof, payload.proof_name or "proof"
    if not changes:
        raise ErpError("no_change", "Nothing was changed.")
    entry = {"at": _now().isoformat(), "by": str(viewer.id), "by_name": viewer.full_name or viewer.email,
             "reason": reason, "changes": changes}
    row.corrections = [*(row.corrections or []), entry]
    record_audit(db, viewer, "receipt.corrected", row, request=request, detail={"reason": reason, "changes": changes})
    db.commit()
    return get_invoice(db, viewer, row.invoice_id)


def receipt_proof(db: Session, viewer: User, receipt_id: uuid.UUID) -> dict:
    if not _readable(viewer):
        require(viewer, "can_manage_billing")
    row = get_owned(db, ErpReceipt, viewer.org_id, receipt_id, "receipt")
    if not row.proof:
        raise ErpError("no_proof", "No proof is attached to this receipt.", 404)
    return {"name": row.proof_name or f"{row.number}-proof", "data": row.proof}


def reverse_receipt(db: Session, viewer: User, receipt_id: uuid.UUID, reason: str | None,
                    request: Request | None = None) -> dict:
    """A payment recorded by mistake, or a bounced cheque. The receipt is never
    deleted: it stays, marked reversed, with the reason, who reversed it and
    when — and the invoice owes again what it had settled."""
    require(viewer, "can_approve_billing")
    row = get_owned(db, ErpReceipt, viewer.org_id, receipt_id, "receipt")
    if row.status != "posted":
        raise ErpError("already_reversed", "This receipt is already reversed.", 409)
    row.reverse_reason = require_reason(reason, "receipt is reversed")
    row.status = "reversed"
    row.reversed_at = datetime.now(timezone.utc)
    row.reversed_by = viewer.id
    inv = db.get(ErpInvoice, row.invoice_id)
    inv.amount_received = max(ZERO, money(inv.amount_received - row.amount - row.tds_amount))
    record_audit(db, viewer, "receipt.reversed", row, request=request,
                 detail={"reason": row.reverse_reason, "number": row.number, "invoice": inv.number,
                         "amount": str(row.amount), "tds": str(row.tds_amount)})
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
