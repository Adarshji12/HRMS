"""Procure-to-pay: requisitions, RFQs and vendor quotes, purchase orders, GRNs.

The journey is J02 of the PRD: PR → RFQ → vendor quotation → comparison → PO →
GRN. Each step may be skipped where a company does not need it — a PO can be
raised straight from an approved requisition, or with no requisition at all —
but no step can be skipped *around an approval*: a PO is approved before
anything is received against it, and a requisition is approved before it is
ordered.

Amendment and the approval chain
--------------------------------

``chains.begin`` is idempotent by design: a record that already has steps
keeps them. That is right for a resubmitted performance review and wrong for
an amended purchase order, whose new figures nobody has approved — reusing
the old, already-approved steps would approve the amendment silently. So an
amendment (and the revision of a rejected document) clears the record's steps
with :func:`reset_chain` before it goes back to draft. The earlier decisions
are not lost: the kernel wrote an audit row for every one of them.
"""

from __future__ import annotations

import math
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal

from fastapi import Request
from sqlalchemy import delete, or_, select
from sqlalchemy.orm import Session

from app.models import User, WorkflowStep
from app.models.erp import (
    DocStatus,
    ErpGoodsReceipt,
    ErpGoodsReceiptLine,
    ErpItem,
    ErpPurchaseOrder,
    ErpPurchaseOrderLine,
    ErpRequisition,
    ErpRequisitionLine,
    ErpRfq,
    ErpRfqLine,
    ErpRfqVendor,
    ErpVendor,
    ErpVendorQuote,
    ErpVendorQuoteLine,
    ErpWarehouse,
    MovementKind,
    PoStatus,
    RfqStatus,
)
from app.schemas import erp as S
from app.services.erp import masters, stock
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
    user_names,
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def reset_chain(db: Session, record_id: uuid.UUID) -> None:
    """See the module docstring."""
    db.execute(delete(WorkflowStep).where(WorkflowStep.record_id == record_id))


def _chain(db: Session, record_id: uuid.UUID) -> list[dict]:
    from app.services import chains

    steps = chains.steps_for(db, record_id)
    names = user_names(db, steps[0].org_id, [s.reviewer_user_id for s in steps]
                       + [s.acted_by for s in steps]) if steps else {}
    return [
        {**row_dict(s), "reviewer_name": names.get(s.reviewer_user_id),
         "acted_by_name": names.get(s.acted_by)}
        for s in steps
    ]


def _item_defaults(db: Session, org_id: uuid.UUID, item_id: uuid.UUID | None, description: str | None):
    if item_id is None:
        if not description:
            raise ErpError("description_required", "A line without an item needs a description.")
        return None
    item = get_owned(db, ErpItem, org_id, item_id, "item")
    if not item.is_active:
        raise ErpError("item_inactive", f"{item.code} is inactive.", 409)
    return item


# --------------------------------------------------------------------------- #
# Requisitions
# --------------------------------------------------------------------------- #


def _sees_all_requisitions(viewer: User) -> bool:
    return may(viewer, "can_manage_procurement") or may(viewer, "can_approve_purchases")


def _req_out(db: Session, row: ErpRequisition) -> dict:
    names = user_names(db, row.org_id, [row.requested_by, row.reviewed_by])
    items = {i.id: i for i in db.scalars(select(ErpItem).where(
        ErpItem.id.in_([line.item_id for line in row.lines if line.item_id])))}
    return {
        **row_dict(row),
        "requested_by_name": names.get(row.requested_by),
        "reviewed_by_name": names.get(row.reviewed_by),
        "chain": _chain(db, row.id),
        "lines": [
            {**row_dict(line), "item_code": items[line.item_id].code if line.item_id in items else None,
             "remaining_qty": str(line.quantity - line.ordered_qty)}
            for line in row.lines
        ],
    }


def list_requisitions(db: Session, viewer: User, *, status: str | None = None, mine: bool = False) -> list[dict]:
    stmt = select(ErpRequisition).where(ErpRequisition.org_id == viewer.org_id)
    if mine or not _sees_all_requisitions(viewer):
        stmt = stmt.where(ErpRequisition.requested_by == viewer.id)
    if status:
        stmt = stmt.where(ErpRequisition.status == status)
    return [_req_out(db, r) for r in db.scalars(stmt.order_by(ErpRequisition.created_at.desc()).limit(300))]


def _get_req(db: Session, viewer: User, req_id: uuid.UUID) -> ErpRequisition:
    from app.services import chains

    row = get_owned(db, ErpRequisition, viewer.org_id, req_id, "requisition")
    if (
        row.requested_by != viewer.id and not _sees_all_requisitions(viewer)
        and not chains.is_current_reviewer(db, row.id, viewer)
    ):
        raise ErpError("not_found", "No such requisition.", 404)
    return row


def get_requisition(db: Session, viewer: User, req_id: uuid.UUID) -> dict:
    return _req_out(db, _get_req(db, viewer, req_id))


def save_requisition(
    db: Session, viewer: User, payload: S.RequisitionIn, req_id: uuid.UUID | None = None,
    request: Request | None = None,
) -> dict:
    """Anybody may raise one — see ``services.erp.common``."""
    today = date.today()
    if req_id:
        row = _get_req(db, viewer, req_id)
        if row.requested_by != viewer.id:
            raise ErpError("not_yours", "Only the requester edits a requisition.", 403)
        if row.status != DocStatus.DRAFT.value:
            raise ErpError("not_draft", "Only a draft can be edited.", 409)
    else:
        row = ErpRequisition(
            org_id=viewer.org_id, requested_by=viewer.id,
            number=next_number(db, viewer.org_id, "PR", today),
        )
    db.add(row)
    if payload.warehouse_id:
        stock.active_warehouse(db, viewer.org_id, payload.warehouse_id)
    for field in ("title", "purpose", "required_by", "warehouse_id", "project_id", "sales_order_id"):
        setattr(row, field, getattr(payload, field))
    row.lines.clear()
    total = ZERO
    for order, line in enumerate(payload.lines):
        item = _item_defaults(db, viewer.org_id, line.item_id, line.description)
        rate = line.estimated_rate or (item.standard_cost if item else ZERO)
        row.lines.append(ErpRequisitionLine(
            org_id=viewer.org_id, item_id=item.id if item else None,
            description=line.description or item.name, uom=line.uom or (item.uom if item else "Nos"),
            quantity=qty(line.quantity), estimated_rate=money(rate), sort_order=order,
        ))
        total += qty(line.quantity) * money(rate)
    row.estimated_total = money(total)
    db.flush()
    record_audit(db, viewer, "requisition.saved", row, request=request)
    db.commit()
    return get_requisition(db, viewer, row.id)


def submit_requisition(db: Session, viewer: User, req_id: uuid.UUID, request: Request | None = None) -> dict:
    from app.services import chains

    row = _get_req(db, viewer, req_id)
    if row.requested_by != viewer.id:
        raise ErpError("not_yours", "Only the requester submits a requisition.", 403)
    if row.status != DocStatus.DRAFT.value:
        raise ErpError("not_draft", f"This requisition is {row.status}.", 409)
    row.status = DocStatus.SUBMITTED.value
    row.submitted_at = _now()
    db.flush()
    chains.start_for(db, kind="purchase_requisition", record_id=row.id, subject=viewer, record=row)
    record_audit(db, viewer, "requisition.submitted", row, request=request)
    db.commit()
    return get_requisition(db, viewer, row.id)


def decide_requisition(
    db: Session, viewer: User, req_id: uuid.UUID, payload: S.DecisionIn, request: Request | None = None,
) -> dict:
    from app.services import workflow

    row = _get_req(db, viewer, req_id)
    kernel_decide(db, viewer, workflow.ERP_REQUISITION, row, payload, request=request)
    db.commit()
    return get_requisition(db, viewer, row.id)


def revise_requisition(db: Session, viewer: User, req_id: uuid.UUID, request: Request | None = None) -> dict:
    """A rejected requisition back to draft, for the requester to fix and resubmit."""
    row = _get_req(db, viewer, req_id)
    if row.requested_by != viewer.id:
        raise ErpError("not_yours", "Only the requester revises a requisition.", 403)
    if row.status != DocStatus.REJECTED.value:
        raise ErpError("not_rejected", "Only a rejected requisition is revised.", 409)
    reset_chain(db, row.id)
    row.status = DocStatus.DRAFT.value
    record_audit(db, viewer, "requisition.revised", row, request=request)
    db.commit()
    return get_requisition(db, viewer, row.id)


def cancel_requisition(db: Session, viewer: User, req_id: uuid.UUID, reason: str | None,
                       request: Request | None = None) -> dict:
    row = _get_req(db, viewer, req_id)
    if row.requested_by != viewer.id and not may(viewer, "can_manage_procurement"):
        raise ErpError("not_yours", "Only the requester or procurement cancels a requisition.", 403)
    if row.status in (DocStatus.CANCELLED.value, DocStatus.CLOSED.value):
        raise ErpError("already_closed", f"This requisition is {row.status}.", 409)
    if any(line.ordered_qty > 0 for line in row.lines):
        raise ErpError("already_ordered", "Part of this requisition is on a purchase order — close it instead.", 409)
    row.cancel_reason = require_reason(reason, "requisition is cancelled")
    row.status = DocStatus.CANCELLED.value
    record_audit(db, viewer, "requisition.cancelled", row, request=request, detail={"reason": row.cancel_reason})
    db.commit()
    return get_requisition(db, viewer, row.id)


# --------------------------------------------------------------------------- #
# RFQs and vendor quotes
# --------------------------------------------------------------------------- #


def _rfq_out(db: Session, rfq: ErpRfq) -> dict:
    vendors = {v.id: v for v in db.scalars(select(ErpVendor).where(
        ErpVendor.id.in_([rv.vendor_id for rv in rfq.vendors] + [q.vendor_id for q in rfq.quotes])))}
    return {
        **row_dict(rfq),
        "lines": [row_dict(line) for line in rfq.lines],
        "vendors": [
            {"vendor_id": str(rv.vendor_id), "legal_name": vendors[rv.vendor_id].legal_name,
             "code": vendors[rv.vendor_id].code,
             "quoted": any(q.vendor_id == rv.vendor_id for q in rfq.quotes)}
            for rv in rfq.vendors if rv.vendor_id in vendors
        ],
        "quotes": [
            {**row_dict(q), "vendor_name": vendors[q.vendor_id].legal_name if q.vendor_id in vendors else None,
             "lines": [row_dict(line) for line in q.lines]}
            for q in rfq.quotes
        ],
    }


def list_rfqs(db: Session, viewer: User) -> list[dict]:
    require(viewer, "can_manage_procurement")
    return [_rfq_out(db, r) for r in db.scalars(select(ErpRfq).where(
        ErpRfq.org_id == viewer.org_id).order_by(ErpRfq.created_at.desc()).limit(300))]


def get_rfq(db: Session, viewer: User, rfq_id: uuid.UUID) -> dict:
    require(viewer, "can_manage_procurement")
    return _rfq_out(db, get_owned(db, ErpRfq, viewer.org_id, rfq_id, "RFQ"))


def create_rfq(db: Session, viewer: User, payload: S.RfqIn, request: Request | None = None) -> dict:
    require(viewer, "can_manage_procurement")
    rfq = ErpRfq(
        org_id=viewer.org_id, title=payload.title, due_date=payload.due_date, terms=payload.terms,
        requisition_id=payload.requisition_id, created_by=viewer.id,
        number=next_number(db, viewer.org_id, "RFQ", date.today()),
    )
    db.add(rfq)
    if payload.requisition_id:
        req = get_owned(db, ErpRequisition, viewer.org_id, payload.requisition_id, "requisition")
        if req.status != DocStatus.APPROVED.value:
            raise ErpError("not_approved", "Only an approved requisition goes out for quotation.", 409)
        for order, line in enumerate(req.lines):
            remaining = line.quantity - line.ordered_qty
            if remaining > 0:
                rfq.lines.append(ErpRfqLine(
                    org_id=viewer.org_id, requisition_line_id=line.id, item_id=line.item_id,
                    description=line.description, uom=line.uom, quantity=remaining, sort_order=order,
                ))
    else:
        for order, line in enumerate(payload.lines):
            item = _item_defaults(db, viewer.org_id, line.item_id, line.description)
            rfq.lines.append(ErpRfqLine(
                org_id=viewer.org_id, item_id=item.id if item else None,
                description=line.description or item.name, uom=line.uom or (item.uom if item else "Nos"),
                quantity=qty(line.quantity), sort_order=order,
            ))
    if not rfq.lines:
        raise ErpError("no_lines", "An RFQ needs at least one line to quote on.")
    for vendor_id in dict.fromkeys(payload.vendor_ids):
        masters.purchasable_vendor(db, viewer.org_id, vendor_id)
        rfq.vendors.append(ErpRfqVendor(org_id=viewer.org_id, vendor_id=vendor_id))
    db.flush()
    record_audit(db, viewer, "rfq.created", rfq, request=request, detail={"vendors": len(payload.vendor_ids)})
    db.commit()
    return get_rfq(db, viewer, rfq.id)


def issue_rfq(db: Session, viewer: User, rfq_id: uuid.UUID, request: Request | None = None) -> dict:
    require(viewer, "can_manage_procurement")
    rfq = get_owned(db, ErpRfq, viewer.org_id, rfq_id, "RFQ")
    if rfq.status != RfqStatus.DRAFT.value:
        raise ErpError("not_draft", f"This RFQ is {rfq.status}.", 409)
    rfq.status = RfqStatus.ISSUED.value
    rfq.issued_at = _now()
    record_audit(db, viewer, "rfq.issued", rfq, request=request)
    db.commit()
    return get_rfq(db, viewer, rfq.id)


def add_quote(db: Session, viewer: User, rfq_id: uuid.UUID, payload: S.VendorQuoteIn,
              request: Request | None = None) -> dict:
    """Record one vendor's offer. A second offer from the same vendor is a new
    negotiation round, and the first stays exactly as it was (FR-06.08)."""
    require(viewer, "can_manage_procurement")
    rfq = get_owned(db, ErpRfq, viewer.org_id, rfq_id, "RFQ")
    if rfq.status != RfqStatus.ISSUED.value:
        raise ErpError("not_issued", "Quotes are recorded against an issued RFQ.", 409)
    if payload.vendor_id not in {rv.vendor_id for rv in rfq.vendors}:
        raise ErpError("not_invited", "That vendor was not invited to this RFQ.", 409)
    rfq_lines = {line.id: line for line in rfq.lines}
    given = {line.rfq_line_id for line in payload.lines}
    if given != set(rfq_lines):
        raise ErpError("incomplete_quote", "Quote a rate for every line of the RFQ — use 0 for an item not offered.")

    rounds = [q.round for q in rfq.quotes if q.vendor_id == payload.vendor_id]
    quote = ErpVendorQuote(
        org_id=viewer.org_id, rfq_id=rfq.id, vendor_id=payload.vendor_id,
        round=(max(rounds) + 1) if rounds else 1, quote_ref=payload.quote_ref,
        valid_until=payload.valid_until, delivery_days=payload.delivery_days,
        payment_terms=payload.payment_terms, warranty=payload.warranty,
        freight=money(payload.freight), notes=payload.notes,
    )
    taxable = tax = ZERO
    for line in payload.lines:
        priced = price_line(rfq_lines[line.rfq_line_id].quantity, line.rate, line.gst_percent)
        taxable += priced["taxable_value"]
        tax += priced["tax_amount"]
        quote.lines.append(ErpVendorQuoteLine(
            org_id=viewer.org_id, rfq_line_id=line.rfq_line_id, rate=money(line.rate),
            gst_percent=line.gst_percent,
        ))
    quote.taxable_total = money(taxable)
    quote.tax_total = money(tax)
    quote.landed_total = money(taxable + tax + quote.freight)
    db.add(quote)
    db.flush()
    record_audit(db, viewer, "rfq.quote_added", rfq, request=request,
                 detail={"vendor_id": str(payload.vendor_id), "round": quote.round,
                         "landed_total": str(quote.landed_total)})
    db.commit()
    return get_rfq(db, viewer, rfq.id)


def _latest_quotes(rfq: ErpRfq) -> list[ErpVendorQuote]:
    latest: dict[uuid.UUID, ErpVendorQuote] = {}
    for q in rfq.quotes:
        if q.vendor_id not in latest or q.round > latest[q.vendor_id].round:
            latest[q.vendor_id] = q
    return list(latest.values())


def comparison(db: Session, viewer: User, rfq_id: uuid.UUID) -> dict:
    """The commercial comparison — FR-06.06. Each vendor's latest round,
    normalised to landed cost (taxable + tax + freight), ranked."""
    require(viewer, "can_manage_procurement")
    rfq = get_owned(db, ErpRfq, viewer.org_id, rfq_id, "RFQ")
    quotes = sorted(_latest_quotes(rfq), key=lambda q: q.landed_total)
    vendors = {v.id: v for v in db.scalars(select(ErpVendor).where(
        ErpVendor.id.in_([q.vendor_id for q in quotes])))}
    lowest = quotes[0].landed_total if quotes else None
    rows = []
    for line in rfq.lines:
        rates = {}
        for q in quotes:
            match = next((ql for ql in q.lines if ql.rfq_line_id == line.id), None)
            if match is not None:
                rates[str(q.id)] = {"rate": str(match.rate), "gst_percent": str(match.gst_percent),
                                    "amount": str(money(line.quantity * match.rate))}
        offered = [Decimal(r["rate"]) for r in rates.values() if Decimal(r["rate"]) > 0]
        rows.append({**row_dict(line), "rates": rates,
                     "lowest_rate": str(min(offered)) if offered else None})
    return {
        "rfq": row_dict(rfq),
        "quotes": [
            {**row_dict(q), "vendor_name": vendors[q.vendor_id].legal_name,
             "vendor_score": str(vendors[q.vendor_id].performance_score)
             if vendors[q.vendor_id].performance_score is not None else None,
             "rank": index + 1, "is_lowest": q.landed_total == lowest}
            for index, q in enumerate(quotes)
        ],
        "lines": rows,
    }


def award(db: Session, viewer: User, rfq_id: uuid.UUID, payload: S.AwardIn, request: Request | None = None) -> dict:
    """Select the winning quote. A reason is mandatory when it is not the lowest
    landed cost, or when it was the only quote — FR-06.07."""
    require(viewer, "can_manage_procurement")
    rfq = get_owned(db, ErpRfq, viewer.org_id, rfq_id, "RFQ")
    if rfq.status != RfqStatus.ISSUED.value:
        raise ErpError("not_issued", f"This RFQ is {rfq.status}.", 409)
    latest = _latest_quotes(rfq)
    quote = next((q for q in latest if q.id == payload.quote_id), None)
    if quote is None:
        raise ErpError("not_latest", "Award a vendor's latest round, not a superseded one.", 409)
    lowest = min(q.landed_total for q in latest)
    needs_reason = quote.landed_total > lowest or len(latest) == 1
    reason = (payload.reason or "").strip() or None
    if needs_reason and not reason:
        raise ErpError(
            "reason_required",
            "Say why: this is the only quote received." if len(latest) == 1
            else "Say why this vendor was chosen over a lower landed cost.",
        )
    for q in rfq.quotes:
        q.is_selected = q.id == quote.id
    rfq.status = RfqStatus.AWARDED.value
    rfq.award_reason = reason
    record_audit(db, viewer, "rfq.awarded", rfq, request=request,
                 detail={"quote_id": str(quote.id), "landed_total": str(quote.landed_total),
                         "lowest": str(lowest), "reason": reason})
    db.commit()
    return get_rfq(db, viewer, rfq.id)


def cancel_rfq(db: Session, viewer: User, rfq_id: uuid.UUID, reason: str | None,
               request: Request | None = None) -> dict:
    require(viewer, "can_manage_procurement")
    rfq = get_owned(db, ErpRfq, viewer.org_id, rfq_id, "RFQ")
    if rfq.status in (RfqStatus.CANCELLED.value, RfqStatus.AWARDED.value):
        raise ErpError("closed", f"This RFQ is {rfq.status}.", 409)
    cleaned = require_reason(reason, "RFQ is cancelled")
    rfq.status = RfqStatus.CANCELLED.value
    record_audit(db, viewer, "rfq.cancelled", rfq, request=request, detail={"reason": cleaned})
    db.commit()
    return get_rfq(db, viewer, rfq.id)


# --------------------------------------------------------------------------- #
# Purchase orders
# --------------------------------------------------------------------------- #


def _po_out(db: Session, po: ErpPurchaseOrder) -> dict:
    names = user_names(db, po.org_id, [po.created_by, po.reviewed_by])
    vendor = db.get(ErpVendor, po.vendor_id)
    wh = db.get(ErpWarehouse, po.warehouse_id) if po.warehouse_id else None
    grns = list(db.scalars(select(ErpGoodsReceipt).where(
        ErpGoodsReceipt.purchase_order_id == po.id).order_by(ErpGoodsReceipt.created_at)))
    items = {i.id: i for i in db.scalars(select(ErpItem).where(
        ErpItem.id.in_([line.item_id for line in po.lines if line.item_id])))}
    today = date.today()
    due = po.committed_date or po.expected_date
    return {
        **row_dict(po),
        "vendor_name": vendor.legal_name if vendor else None,
        "vendor_code": vendor.code if vendor else None,
        "warehouse_name": wh.name if wh else None,
        "created_by_name": names.get(po.created_by),
        "reviewed_by_name": names.get(po.reviewed_by),
        "is_overdue": bool(due and due < today and PoStatus(po.status).is_receivable),
        "chain": _chain(db, po.id),
        "lines": [
            {**row_dict(line),
             "item_code": items[line.item_id].code if line.item_id in items else None,
             "is_serialized": items[line.item_id].is_serialized if line.item_id in items else False,
             "is_stocked": items[line.item_id].is_stocked if line.item_id in items else False,
             "pending_qty": str(line.quantity - line.received_qty)}
            for line in po.lines
        ],
        "receipts": [
            {"id": str(g.id), "number": g.number, "received_on": g.received_on.isoformat(),
             "status": g.status, "days_late": g.days_late, "ld_amount": str(g.ld_amount)}
            for g in grns
        ],
    }


def list_purchase_orders(
    db: Session, viewer: User, *, status: str | None = None, vendor_id: uuid.UUID | None = None,
    q: str | None = None,
) -> list[dict]:
    if not (may(viewer, "can_manage_procurement") or may(viewer, "can_approve_purchases")
            or may(viewer, "can_manage_inventory")):
        require(viewer, "can_manage_procurement")
    stmt = select(ErpPurchaseOrder).where(ErpPurchaseOrder.org_id == viewer.org_id)
    if status == "open":
        stmt = stmt.where(ErpPurchaseOrder.status.in_([s.value for s in PoStatus if s.is_receivable]))
    elif status:
        stmt = stmt.where(ErpPurchaseOrder.status == status)
    if vendor_id:
        stmt = stmt.where(ErpPurchaseOrder.vendor_id == vendor_id)
    if q:
        stmt = stmt.join(ErpVendor, ErpVendor.id == ErpPurchaseOrder.vendor_id).where(or_(
            ErpPurchaseOrder.number.ilike(f"%{q}%"), ErpVendor.legal_name.ilike(f"%{q}%")))
    return [_po_out(db, p) for p in db.scalars(stmt.order_by(ErpPurchaseOrder.created_at.desc()).limit(300))]


def _get_po(db: Session, viewer: User, po_id: uuid.UUID) -> ErpPurchaseOrder:
    from app.services import chains

    po = get_owned(db, ErpPurchaseOrder, viewer.org_id, po_id, "purchase order")
    if not (may(viewer, "can_manage_procurement") or may(viewer, "can_approve_purchases")
            or may(viewer, "can_manage_inventory") or chains.is_current_reviewer(db, po.id, viewer)):
        raise ErpError("not_found", "No such purchase order.", 404)
    return po


def get_purchase_order(db: Session, viewer: User, po_id: uuid.UUID) -> dict:
    return _po_out(db, _get_po(db, viewer, po_id))


def _apply_po(db: Session, viewer: User, po: ErpPurchaseOrder, payload: S.PurchaseOrderIn) -> None:
    vendor = masters.purchasable_vendor(db, viewer.org_id, payload.vendor_id)
    if payload.warehouse_id:
        stock.active_warehouse(db, viewer.org_id, payload.warehouse_id)
    settings = get_settings(db, viewer.org_id)
    for field in ("vendor_id", "requisition_id", "sales_order_id", "project_id", "warehouse_id",
                  "expected_date", "payment_terms", "delivery_terms", "ld_percent_per_week",
                  "ld_cap_percent", "notes"):
        setattr(po, field, getattr(payload, field))
    po.order_date = payload.order_date or date.today()
    po.terms = payload.terms if payload.terms is not None else settings.po_terms
    po.payment_terms = payload.payment_terms or f"{vendor.payment_terms_days} days"
    po.freight = money(payload.freight)
    po.is_interstate = is_interstate(db, viewer.org_id, vendor.state)

    po.lines.clear()
    sub = tax = ZERO
    for order, line in enumerate(payload.lines):
        item = _item_defaults(db, viewer.org_id, line.item_id, line.description)
        if line.requisition_line_id:
            req_line = get_owned(db, ErpRequisitionLine, viewer.org_id, line.requisition_line_id,
                                 "requisition line")
            req = db.get(ErpRequisition, req_line.requisition_id)
            if req.status != DocStatus.APPROVED.value:
                raise ErpError("not_approved", f"{req.number} is not approved.", 409)
            if qty(line.quantity) > req_line.quantity - req_line.ordered_qty:
                raise ErpError(
                    "over_requisition",
                    f"{req.number}: only {(req_line.quantity - req_line.ordered_qty).normalize()} "
                    f"of “{req_line.description}” is left to order.",
                )
        gst = line.gst_percent if line.gst_percent is not None else (item.gst_percent if item else Decimal("18"))
        priced = price_line(line.quantity, line.rate, gst)
        po.lines.append(ErpPurchaseOrderLine(
            org_id=viewer.org_id, item_id=item.id if item else None,
            requisition_line_id=line.requisition_line_id,
            description=line.description or item.name,
            hsn_sac=line.hsn_sac or (item.hsn_sac if item else None),
            uom=line.uom or (item.uom if item else "Nos"), gst_percent=gst, sort_order=order,
            **priced,
        ))
        sub += priced["taxable_value"]
        tax += priced["tax_amount"]
    po.sub_total = money(sub)
    po.tax_total = money(tax)
    po.grand_total = money(sub + tax + po.freight)


def save_purchase_order(
    db: Session, viewer: User, payload: S.PurchaseOrderIn, po_id: uuid.UUID | None = None,
    request: Request | None = None,
) -> dict:
    require(viewer, "can_manage_procurement")
    if po_id:
        po = _get_po(db, viewer, po_id)
        if po.status != PoStatus.DRAFT.value:
            raise ErpError("not_draft", "An approved order changes by amendment, not by editing.", 409)
    else:
        po = ErpPurchaseOrder(
            org_id=viewer.org_id, created_by=viewer.id,
            number=next_number(db, viewer.org_id, "PO", payload.order_date or date.today()),
        )
    # Added only once populated: `_apply_po` queries, a query autoflushes, and a
    # row in the session without its vendor is a NOT NULL failure.
    with db.no_autoflush:
        _apply_po(db, viewer, po, payload)
    db.add(po)
    db.flush()
    record_audit(db, viewer, "purchase_order.saved", po, request=request,
                 detail={"grand_total": str(po.grand_total), "revision": po.revision})
    db.commit()
    return get_purchase_order(db, viewer, po.id)


def po_from_requisition(db: Session, viewer: User, req_id: uuid.UUID, vendor_id: uuid.UUID,
                        request: Request | None = None) -> dict:
    """A draft PO for whatever of an approved requisition is not yet ordered."""
    req = get_owned(db, ErpRequisition, viewer.org_id, req_id, "requisition")
    lines = [
        S.PoLineIn(item_id=line.item_id, requisition_line_id=line.id, description=line.description,
                   uom=line.uom, quantity=line.quantity - line.ordered_qty, rate=line.estimated_rate)
        for line in req.lines if line.quantity > line.ordered_qty
    ]
    if not lines:
        raise ErpError("fully_ordered", "Everything on this requisition is already ordered.", 409)
    payload = S.PurchaseOrderIn(
        vendor_id=vendor_id, requisition_id=req.id, project_id=req.project_id,
        sales_order_id=req.sales_order_id, warehouse_id=req.warehouse_id,
        expected_date=req.required_by, lines=lines,
    )
    return save_purchase_order(db, viewer, payload, request=request)


def po_from_quote(db: Session, viewer: User, rfq_id: uuid.UUID, request: Request | None = None) -> dict:
    """A draft PO from an RFQ's awarded quote — the vendor's rates, not retyped."""
    rfq = get_owned(db, ErpRfq, viewer.org_id, rfq_id, "RFQ")
    quote = next((q for q in rfq.quotes if q.is_selected), None)
    if rfq.status != RfqStatus.AWARDED.value or quote is None:
        raise ErpError("not_awarded", "Award the RFQ first.", 409)
    rfq_lines = {line.id: line for line in rfq.lines}
    req = db.get(ErpRequisition, rfq.requisition_id) if rfq.requisition_id else None
    lines = []
    for ql in quote.lines:
        line = rfq_lines[ql.rfq_line_id]
        if ql.rate <= 0:
            continue
        lines.append(S.PoLineIn(
            item_id=line.item_id, requisition_line_id=line.requisition_line_id,
            description=line.description, uom=line.uom, quantity=line.quantity,
            rate=ql.rate, gst_percent=ql.gst_percent,
        ))
    payload = S.PurchaseOrderIn(
        vendor_id=quote.vendor_id, requisition_id=rfq.requisition_id,
        project_id=req.project_id if req else None, warehouse_id=req.warehouse_id if req else None,
        sales_order_id=req.sales_order_id if req else None,
        expected_date=(date.today().fromordinal(date.today().toordinal() + quote.delivery_days)
                       if quote.delivery_days else None),
        payment_terms=quote.payment_terms, freight=quote.freight, lines=lines,
    )
    result = save_purchase_order(db, viewer, payload, request=request)
    po = db.get(ErpPurchaseOrder, uuid.UUID(result["id"]))
    po.rfq_id = rfq.id
    po.quote_id = quote.id
    db.commit()
    return get_purchase_order(db, viewer, po.id)


def submit_purchase_order(db: Session, viewer: User, po_id: uuid.UUID, request: Request | None = None) -> dict:
    from app.services import chains

    require(viewer, "can_manage_procurement")
    po = _get_po(db, viewer, po_id)
    if po.status != PoStatus.DRAFT.value:
        raise ErpError("not_draft", f"This order is {po.status}.", 409)
    masters.purchasable_vendor(db, viewer.org_id, po.vendor_id)
    po.status = PoStatus.SUBMITTED.value
    po.submitted_at = _now()
    db.flush()
    chains.start_for(db, kind="purchase_order", record_id=po.id, subject=viewer, record=po)
    record_audit(db, viewer, "purchase_order.submitted", po, request=request)
    db.commit()
    return get_purchase_order(db, viewer, po.id)


def decide_purchase_order(db: Session, viewer: User, po_id: uuid.UUID, payload: S.DecisionIn,
                          request: Request | None = None) -> dict:
    """Approval commits the requisition quantity, so two POs cannot both order
    the last ten units of one requisition line."""
    from app.services import workflow

    po = _get_po(db, viewer, po_id)

    def on_approve() -> None:
        masters.purchasable_vendor(db, viewer.org_id, po.vendor_id)
        touched: set[uuid.UUID] = set()
        for line in po.lines:
            if line.requisition_line_id:
                req_line = db.get(ErpRequisitionLine, line.requisition_line_id)
                if req_line.ordered_qty + line.quantity > req_line.quantity:
                    raise ErpError("over_requisition",
                                   f"“{req_line.description}” has been ordered elsewhere since this PO was raised.", 409)
                req_line.ordered_qty = qty(req_line.ordered_qty + line.quantity)
                touched.add(req_line.requisition_id)
        for req_id in touched:
            req = db.get(ErpRequisition, req_id)
            if all(rl.ordered_qty >= rl.quantity for rl in req.lines):
                req.status = DocStatus.CLOSED.value

    kernel_decide(db, viewer, workflow.ERP_PURCHASE_ORDER, po, payload, on_approve=on_approve,
                  request=request)
    db.commit()
    return get_purchase_order(db, viewer, po.id)


def acknowledge(db: Session, viewer: User, po_id: uuid.UUID, payload: S.AcknowledgeIn,
                request: Request | None = None) -> dict:
    require(viewer, "can_manage_procurement")
    po = _get_po(db, viewer, po_id)
    if po.status != PoStatus.APPROVED.value:
        raise ErpError("not_approved", "Only an approved order is acknowledged.", 409)
    po.status = PoStatus.ACKNOWLEDGED.value
    po.acknowledged_at = _now()
    po.committed_date = payload.committed_date or po.expected_date
    record_audit(db, viewer, "purchase_order.acknowledged", po, request=request,
                 detail={"committed_date": po.committed_date})
    db.commit()
    return get_purchase_order(db, viewer, po.id)


def _release_requisition(db: Session, po: ErpPurchaseOrder, only_pending: bool) -> None:
    for line in po.lines:
        if not line.requisition_line_id:
            continue
        req_line = db.get(ErpRequisitionLine, line.requisition_line_id)
        if req_line is None:
            continue
        give_back = (line.quantity - line.received_qty) if only_pending else line.quantity
        req_line.ordered_qty = max(ZERO, qty(req_line.ordered_qty - give_back))
        req = db.get(ErpRequisition, req_line.requisition_id)
        if req.status == DocStatus.CLOSED.value and req_line.ordered_qty < req_line.quantity:
            req.status = DocStatus.APPROVED.value


def amend(db: Session, viewer: User, po_id: uuid.UUID, reason: str | None, request: Request | None = None) -> dict:
    """Back to draft with the revision bumped — FR-06.16. Only before anything is
    received: a receipt is against the figures that were approved."""
    require(viewer, "can_manage_procurement")
    po = _get_po(db, viewer, po_id)
    if po.status not in (PoStatus.APPROVED.value, PoStatus.ACKNOWLEDGED.value, PoStatus.REJECTED.value):
        raise ErpError("not_amendable", f"A {po.status} order cannot be amended.", 409)
    if any(line.received_qty > 0 for line in po.lines):
        raise ErpError("received", "Goods are already received against this order — short-close it and raise another.", 409)
    cleaned = require_reason(reason, "order is amended")
    if po.status != PoStatus.REJECTED.value:
        _release_requisition(db, po, only_pending=False)
        po.revision += 1
    reset_chain(db, po.id)
    po.status = PoStatus.DRAFT.value
    po.reviewed_by = po.reviewed_at = None
    po.review_note = None
    po.acknowledged_at = None
    record_audit(db, viewer, "purchase_order.amended", po, request=request,
                 detail={"reason": cleaned, "revision": po.revision})
    db.commit()
    return get_purchase_order(db, viewer, po.id)


def cancel_purchase_order(db: Session, viewer: User, po_id: uuid.UUID, reason: str | None,
                          request: Request | None = None) -> dict:
    require(viewer, "can_manage_procurement")
    po = _get_po(db, viewer, po_id)
    if po.status in (PoStatus.CANCELLED.value, PoStatus.CLOSED.value, PoStatus.RECEIVED.value):
        raise ErpError("closed", f"This order is {po.status}.", 409)
    if any(line.received_qty > 0 for line in po.lines):
        raise ErpError("received", "Goods are received against this order — short-close it instead.", 409)
    cleaned = require_reason(reason, "order is cancelled")
    if po.status in (PoStatus.APPROVED.value, PoStatus.ACKNOWLEDGED.value):
        _release_requisition(db, po, only_pending=False)
    po.status = PoStatus.CANCELLED.value
    po.closed_reason = cleaned
    record_audit(db, viewer, "purchase_order.cancelled", po, request=request, detail={"reason": cleaned})
    db.commit()
    return get_purchase_order(db, viewer, po.id)


def short_close(db: Session, viewer: User, po_id: uuid.UUID, reason: str | None,
                request: Request | None = None) -> dict:
    """Close what will never arrive, releasing the commitment — FR-06.19."""
    require(viewer, "can_manage_procurement")
    po = _get_po(db, viewer, po_id)
    if po.status != PoStatus.PARTIALLY_RECEIVED.value:
        raise ErpError("not_partial", "Only a partly received order is short-closed.", 409)
    cleaned = require_reason(reason, "order is short-closed")
    _release_requisition(db, po, only_pending=True)
    po.status = PoStatus.CLOSED.value
    po.closed_reason = cleaned
    record_audit(db, viewer, "purchase_order.short_closed", po, request=request, detail={"reason": cleaned})
    db.commit()
    return get_purchase_order(db, viewer, po.id)


def waive_ld(db: Session, viewer: User, po_id: uuid.UUID, reason: str | None, request: Request | None = None) -> dict:
    require(viewer, "can_approve_purchases")
    po = _get_po(db, viewer, po_id)
    if po.ld_amount <= 0 or po.ld_waived:
        raise ErpError("no_ld", "There is no liquidated damage to waive on this order.", 409)
    if po.created_by == viewer.id:
        raise ErpError("self_review", "You raised this order; somebody else must waive its LD.", 403)
    po.ld_waived = True
    po.ld_waiver_reason = require_reason(reason, "LD is waived")
    record_audit(db, viewer, "purchase_order.ld_waived", po, request=request,
                 detail={"amount": str(po.ld_amount), "reason": po.ld_waiver_reason})
    db.commit()
    return get_purchase_order(db, viewer, po.id)


def _refresh_po_status(po: ErpPurchaseOrder) -> None:
    if all(line.received_qty >= line.quantity for line in po.lines):
        po.status = PoStatus.RECEIVED.value
    elif any(line.received_qty > 0 for line in po.lines):
        po.status = PoStatus.PARTIALLY_RECEIVED.value
    else:
        po.status = PoStatus.ACKNOWLEDGED.value if po.acknowledged_at else PoStatus.APPROVED.value


# --------------------------------------------------------------------------- #
# Goods receipts
# --------------------------------------------------------------------------- #


def _grn_out(db: Session, grn: ErpGoodsReceipt) -> dict:
    vendor = db.get(ErpVendor, grn.vendor_id)
    wh = db.get(ErpWarehouse, grn.warehouse_id)
    po = db.get(ErpPurchaseOrder, grn.purchase_order_id)
    names = user_names(db, grn.org_id, [grn.received_by, grn.reversed_by])
    return {
        **row_dict(grn), "vendor_name": vendor.legal_name if vendor else None,
        "warehouse_name": wh.name if wh else None, "po_number": po.number if po else None,
        "received_by_name": names.get(grn.received_by), "reversed_by_name": names.get(grn.reversed_by),
        "lines": [row_dict(line) for line in grn.lines],
    }


def list_receipts(db: Session, viewer: User, *, po_id: uuid.UUID | None = None) -> list[dict]:
    if not may(viewer, "can_manage_inventory"):
        require(viewer, "can_manage_procurement")
    stmt = select(ErpGoodsReceipt).where(ErpGoodsReceipt.org_id == viewer.org_id)
    if po_id:
        stmt = stmt.where(ErpGoodsReceipt.purchase_order_id == po_id)
    return [_grn_out(db, g) for g in db.scalars(stmt.order_by(ErpGoodsReceipt.created_at.desc()).limit(300))]


def get_receipt(db: Session, viewer: User, grn_id: uuid.UUID) -> dict:
    if not may(viewer, "can_manage_inventory"):
        require(viewer, "can_manage_procurement")
    return _grn_out(db, get_owned(db, ErpGoodsReceipt, viewer.org_id, grn_id, "goods receipt"))


def post_receipt(db: Session, viewer: User, payload: S.GoodsReceiptIn, request: Request | None = None) -> dict:
    """Receive and post in one step. See ``ErpGoodsReceipt``."""
    require(viewer, "can_manage_inventory")
    po = get_owned(db, ErpPurchaseOrder, viewer.org_id, payload.purchase_order_id, "purchase order")
    if not PoStatus(po.status).is_receivable:
        raise ErpError("not_receivable", f"Order {po.number} is {po.status} — nothing can be received against it.", 409)
    warehouse = stock.active_warehouse(db, viewer.org_id, payload.warehouse_id or po.warehouse_id)
    settings = get_settings(db, viewer.org_id)
    tolerance = Decimal("1") + settings.grn_over_receipt_pct / Decimal("100")
    received_on = payload.received_on or date.today()
    if received_on > date.today():
        raise ErpError("future_date", "Goods cannot be received in the future.")
    if received_on < po.order_date:
        raise ErpError("before_order", "Goods cannot be received before the order date.")

    po_lines = {line.id: line for line in po.lines}
    grn = ErpGoodsReceipt(
        org_id=viewer.org_id, purchase_order_id=po.id, vendor_id=po.vendor_id,
        warehouse_id=warehouse.id, received_on=received_on, challan_ref=payload.challan_ref,
        invoice_ref=payload.invoice_ref, notes=payload.notes, received_by=viewer.id,
        number=next_number(db, viewer.org_id, "GRN", received_on),
    )
    db.add(grn)
    db.flush()

    accepted_value = ZERO
    for line in payload.lines:
        po_line = po_lines.get(line.po_line_id)
        if po_line is None:
            raise ErpError("wrong_order", "A line does not belong to this purchase order.")
        received = qty(line.received_qty)
        rejected = qty(line.rejected_qty)
        if rejected > received:
            raise ErpError("over_rejected", f"“{po_line.description}”: more rejected than received.")
        accepted = received - rejected
        limit = qty((po_line.quantity * tolerance) - po_line.received_qty)
        if accepted > limit:
            raise ErpError(
                "over_receipt",
                f"“{po_line.description}”: {accepted.normalize()} accepted, but only "
                f"{max(limit, ZERO).normalize()} is still due on the order.",
            )
        item = stock.stocked_item(db, viewer.org_id, po_line.item_id)
        serials: list[str] = []
        if item is not None and accepted > 0:
            serials = stock.check_serial_count(item, accepted, line.serials)
            stock.receive_serials(
                db, viewer, item=item, serials=serials, warehouse_id=warehouse.id,
                condition=line.condition, ref_type="goods_receipt", ref_id=grn.id,
                ref_number=grn.number, vendor_id=po.vendor_id, grn_id=grn.id, received_on=received_on,
            )
            stock.move(
                db, viewer, item=item, warehouse_id=warehouse.id, quantity=accepted,
                kind=MovementKind.GRN, ref_type="goods_receipt", ref_id=grn.id, ref_number=grn.number,
                condition=line.condition, unit_cost=po_line.rate, serials=serials,
            )
        grn.lines.append(ErpGoodsReceiptLine(
            org_id=viewer.org_id, po_line_id=po_line.id, item_id=po_line.item_id,
            description=po_line.description, received_qty=received, accepted_qty=accepted,
            rejected_qty=rejected, condition=line.condition, unit_cost=po_line.rate,
            serials=serials or None,
        ))
        po_line.received_qty = qty(po_line.received_qty + accepted)
        accepted_value += accepted * po_line.rate

    # Liquidated damages — FR-06.14. Whole weeks late, each costing the PO's
    # percentage of what arrived late, capped.
    due = po.committed_date or po.expected_date
    if due and received_on > due:
        grn.days_late = (received_on - due).days
        if po.ld_percent_per_week > 0:
            weeks = math.ceil(grn.days_late / 7)
            pct = Decimal(weeks) * po.ld_percent_per_week
            if po.ld_cap_percent > 0:
                pct = min(pct, po.ld_cap_percent)
            grn.ld_amount = money(accepted_value * pct / Decimal("100"))
            po.ld_amount = money(po.ld_amount + grn.ld_amount)

    _refresh_po_status(po)
    db.flush()
    masters.refresh_vendor_score(db, po.vendor_id)
    record_audit(db, viewer, "goods_receipt.posted", grn, request=request,
                 detail={"po": po.number, "days_late": grn.days_late, "ld": str(grn.ld_amount)})
    db.commit()
    return get_receipt(db, viewer, grn.id)


def reverse_receipt(db: Session, viewer: User, grn_id: uuid.UUID, reason: str | None,
                    request: Request | None = None) -> dict:
    """Undo a GRN with opposite movements. Fails if the stock has already gone
    on — a unit dispatched to a customer cannot be un-received."""
    require(viewer, "can_manage_inventory")
    grn = get_owned(db, ErpGoodsReceipt, viewer.org_id, grn_id, "goods receipt")
    if grn.status != "posted":
        raise ErpError("already_reversed", "This receipt is already reversed.", 409)
    cleaned = require_reason(reason, "receipt is reversed")
    po = db.get(ErpPurchaseOrder, grn.purchase_order_id)
    po_lines = {line.id: line for line in po.lines}
    from app.models.erp import SerialStatus

    for line in grn.lines:
        item = stock.stocked_item(db, viewer.org_id, line.item_id)
        if item is not None and line.accepted_qty > 0:
            if line.serials:
                stock.take_serials(
                    db, viewer, item=item, serials=line.serials, warehouse_id=grn.warehouse_id,
                    condition=line.condition, new_status=SerialStatus.SCRAPPED, kind=MovementKind.REVERSAL,
                    ref_type="goods_receipt", ref_id=grn.id, ref_number=grn.number,
                )
            stock.move(
                db, viewer, item=item, warehouse_id=grn.warehouse_id, quantity=-line.accepted_qty,
                kind=MovementKind.REVERSAL, ref_type="goods_receipt", ref_id=grn.id,
                ref_number=grn.number, condition=line.condition, serials=line.serials, reason=cleaned,
            )
        po_line = po_lines.get(line.po_line_id)
        if po_line is not None:
            po_line.received_qty = max(ZERO, qty(po_line.received_qty - line.accepted_qty))
    po.ld_amount = max(ZERO, money(po.ld_amount - grn.ld_amount))
    if po.status in (PoStatus.PARTIALLY_RECEIVED.value, PoStatus.RECEIVED.value):
        _refresh_po_status(po)
    grn.status = "reversed"
    grn.reversed_by = viewer.id
    grn.reversed_at = _now()
    grn.reverse_reason = cleaned
    db.flush()
    masters.refresh_vendor_score(db, po.vendor_id)
    record_audit(db, viewer, "goods_receipt.reversed", grn, request=request, detail={"reason": cleaned})
    db.commit()
    return get_receipt(db, viewer, grn.id)
