"""Order management and dispatch — §6.5 and the shipping half of §6.9.

An order is booked from the customer's PO, ideally by converting the CRM
quotation that won it. Release is an approval (``sales_order`` flow), and it is
refused outright — not routed — for a customer on credit hold or over their
credit limit: those are Finance's decisions, made on the customer account, and
an order approver is not the person to overrule them (FR-04.13, 19.10).

Fulfilment is reservation, then dispatch. A reservation takes good stock off
the available figure without moving it; a dispatch moves it out and consumes
the reservation. A dispatch is the only document a product invoice is raised
from, so "delivered but not billed" is a query rather than a spreadsheet.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from decimal import Decimal

from fastapi import Request
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.models import CrmCustomer, CrmQuotation, User
from app.models.erp import (
    DispatchStatus,
    ErpBillingMilestone,
    ErpCustomerSite,
    ErpDispatch,
    ErpDispatchLine,
    ErpItem,
    ErpSalesOrder,
    ErpSalesOrderLine,
    ErpSalesReturn,
    ErpWarehouse,
    MilestoneStatus,
    MovementKind,
    SalesOrderStatus,
    SerialStatus,
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
    split_tax,
    user_names,
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _readable(viewer: User) -> bool:
    return any(may(viewer, f) for f in (
        "can_manage_sales_orders", "can_approve_sales_orders", "can_delete_sales_orders", "can_manage_inventory",
        "can_manage_billing", "can_manage_procurement",
    ))


#: Orders that have been released, so may go out to the customer.
_RELEASED = (
    SalesOrderStatus.APPROVED.value, SalesOrderStatus.ON_HOLD.value, SalesOrderStatus.PARTIALLY_DISPATCHED.value,
    SalesOrderStatus.DISPATCHED.value, SalesOrderStatus.CLOSED.value,
)


def _approval_status(so: ErpSalesOrder) -> str:
    """Where the order stands with its approvers, whatever happened to it since."""
    if so.status in _RELEASED:
        return "approved"
    return {
        SalesOrderStatus.DRAFT.value: "not_submitted",
        SalesOrderStatus.SUBMITTED.value: "pending",
    }.get(so.status, so.status)  # rejected, cancelled


def _delivery_status(so: ErpSalesOrder, dispatches: list[ErpDispatch]) -> str:
    """How far the goods have got. An order with nothing to ship has no such status."""
    goods = [line for line in so.lines if line.fulfilment != "service"]
    if not goods:
        return "not_applicable"
    if not any(line.dispatched_qty > 0 for line in goods):
        ended = so.status in (SalesOrderStatus.CANCELLED.value, SalesOrderStatus.CLOSED.value)
        return "not_applicable" if ended else "pending"
    if any(line.dispatched_qty < line.quantity for line in goods):
        return "partial"
    live = [d for d in dispatches if d.status != DispatchStatus.CANCELLED.value]
    return "delivered" if live and all(d.status == DispatchStatus.DELIVERED.value for d in live) else "in_transit"


def _unbilled_value(d: ErpDispatch, lines: dict[uuid.UUID, ErpSalesOrderLine]) -> Decimal:
    """What invoicing the rest of this dispatch would come to, GST included."""
    total = ZERO
    for dl in d.lines:
        line = lines.get(dl.order_line_id)
        if line is not None:
            total += dl.billable_qty * line.net_rate * (1 + line.gst_percent / Decimal("100"))
    return money(total)


def _returned_unbilled(so: ErpSalesOrder, dispatches: list[ErpDispatch]) -> Decimal:
    """The value of goods that came back before they were billed, GST included.
    They will never be invoiced, so they are no longer "still to bill"."""
    lines = {line.id: line for line in so.lines}
    total = ZERO
    for d in dispatches:
        if d.status == DispatchStatus.CANCELLED.value:
            continue
        for dl in d.lines:
            line = lines.get(dl.order_line_id)
            # Replaced goods will be shipped and billed again, so they still count.
            unbilled = min(dl.returned_qty - dl.replaced_qty, max(ZERO, dl.quantity - dl.invoiced_qty - dl.free_qty))
            if line is not None and unbilled > 0:
                total += unbilled * line.net_rate * (1 + line.gst_percent / Decimal("100"))
    return money(total)


def billed_by_milestones(so: ErpSalesOrder | None) -> bool:
    """An order with a dispatch or delivery milestone bills its goods through
    that milestone: the dispatch only makes it ready, and invoicing the goods
    as well would bill the same value twice. Other milestones (an advance, UAT)
    sit beside dispatch billing, held to the order's value by the invoice cap."""
    return bool(so is not None and any(m.kind in ("dispatch", "delivery") for m in so.milestones))


def _order_out(db: Session, so: ErpSalesOrder) -> dict:
    from app.models.erp import ErpCustomerAccount, ErpInvoice
    from app.services import chains

    names = user_names(db, so.org_id, [so.created_by, so.reviewed_by, so.salesperson_id])
    items = {i.id: i for i in db.scalars(select(ErpItem).where(
        ErpItem.id.in_([line.item_id for line in so.lines if line.item_id])))}
    dispatches = list(db.scalars(select(ErpDispatch).where(
        ErpDispatch.sales_order_id == so.id).order_by(ErpDispatch.created_at)))
    invoices = list(db.scalars(select(ErpInvoice).where(
        ErpInvoice.sales_order_id == so.id).order_by(ErpInvoice.created_at)))
    quotation = db.get(CrmQuotation, so.quotation_id) if so.quotation_id else None
    site = db.get(ErpCustomerSite, so.site_id) if so.site_id else None
    steps = chains.steps_for(db, so.id)
    billed = [i for i in invoices if i.status == "posted" and i.kind not in ("proforma", "credit_note")]
    credited = db.scalar(select(func.coalesce(func.sum(ErpInvoice.grand_total), 0)).where(
        ErpInvoice.kind == "credit_note", ErpInvoice.status == "posted",
        ErpInvoice.original_invoice_id.in_([i.id for i in billed]))) if billed else 0
    invoiced = money(sum((i.grand_total for i in billed), ZERO) - Decimal(str(credited or 0)))
    # A cancelled or closed order will not be billed any further.
    ended = so.status in (SalesOrderStatus.CANCELLED.value, SalesOrderStatus.CLOSED.value)
    customer = db.get(CrmCustomer, so.customer_id)
    account = db.scalar(select(ErpCustomerAccount).where(
        ErpCustomerAccount.org_id == so.org_id, ErpCustomerAccount.customer_id == so.customer_id))
    order_lines = {line.id: line for line in so.lines}
    waiting = next((s for s in steps if s.is_open), None)
    return {
        **row_dict(so),
        "approval_status": _approval_status(so),
        "approval_level": waiting.level if waiting and so.status == SalesOrderStatus.SUBMITTED.value else None,
        "delivery_status": _delivery_status(so, dispatches),
        "pending_amount": str(money(ZERO if ended else max(ZERO, so.grand_total - invoiced - _returned_unbilled(so, dispatches)))),
        "customer_email": customer.email if customer else None,
        "customer_mobile": customer.mobile if customer else None,
        "customer_gstin": (account.gstin if account else None) or (customer.gstin if customer else None),
        "created_by_name": names.get(so.created_by),
        "reviewed_by_name": names.get(so.reviewed_by),
        "salesperson_name": names.get(so.salesperson_id),
        # The files themselves are fetched one at a time.
        "attachments": [{k: v for k, v in a.items() if k != "data"} for a in (so.attachments or [])],
        "quotation_number": quotation.number if quotation else None,
        "site_name": site.name if site else None,
        "chain": [row_dict(s) for s in steps],
        "lines": [
            {**row_dict(line),
             "item_code": items[line.item_id].code if line.item_id in items else None,
             "is_serialized": items[line.item_id].is_serialized if line.item_id in items else False,
             "is_stocked": items[line.item_id].is_stocked if line.item_id in items else False,
             "pending_qty": str(line.quantity - line.dispatched_qty),
             "available_qty": str(stock.available(db, so.org_id, line.item_id))
             if line.item_id in items and items[line.item_id].is_stocked else None}
            for line in so.lines
        ],
        "milestones": [row_dict(m) for m in so.milestones],
        "dispatches": [
            {"id": str(d.id), "number": d.number, "dispatch_date": d.dispatch_date.isoformat(),
             "status": d.status, "value": str(d.value),
             "uninvoiced": d.status != DispatchStatus.CANCELLED.value and not billed_by_milestones(so)
             and any(line.billable_qty > 0 for line in d.lines),
             "unbilled_value": str(_unbilled_value(d, order_lines))}
            for d in dispatches
        ],
        "invoices": [
            {"id": str(i.id), "number": i.number, "kind": i.kind, "status": i.status,
             "grand_total": str(i.grand_total), "invoice_date": i.invoice_date.isoformat()}
            for i in invoices
        ],
        "invoiced_total": str(invoiced),
    }


#: The list's Open tab, and what its sort keys read.
_OPEN = (SalesOrderStatus.APPROVED.value, SalesOrderStatus.PARTIALLY_DISPATCHED.value, SalesOrderStatus.ON_HOLD.value)
_SORTS = {
    "number": lambda row: row["so"].number,
    "order_date": lambda row: row["so"].order_date,
    "customer": lambda row: (row["so"].customer_name or "").lower(),
    "required_by": lambda row: row["so"].required_by,
    "grand_total": lambda row: row["so"].grand_total,
    "invoiced": lambda row: row["invoiced"],
    "pending": lambda row: row["pending"],
    "approval": lambda row: row["approval"],
    "delivery": lambda row: row["delivery"],
}


def page_orders(
    db: Session, viewer: User, *, status: str | None = None, approval: str | None = None,
    delivery: str | None = None, customer_id: uuid.UUID | None = None, q: str | None = None,
    date_from: date | None = None, date_to: date | None = None, sort: str = "created",
    direction: str = "desc", page: int = 1, page_size: int = 25,
) -> dict:
    """One page of the list, and the figures around it.

    Approval, delivery, invoiced and pending are worked out from linked records
    rather than stored, so they cannot go stale; that is why they are filtered
    and sorted here after a batch read, and only the page shown is built in full.
    """
    from app.models.erp import ErpInvoice

    if not _readable(viewer):
        require(viewer, "can_manage_sales_orders")
    org = viewer.org_id

    # The cards and tabs count the whole book, whatever the filters are.
    by_status = db.execute(select(
        ErpSalesOrder.status, func.count(), func.coalesce(func.sum(ErpSalesOrder.grand_total), 0),
    ).where(ErpSalesOrder.org_id == org).group_by(ErpSalesOrder.status)).all()

    stmt = select(ErpSalesOrder).where(ErpSalesOrder.org_id == org)
    if status == "open":
        stmt = stmt.where(ErpSalesOrder.status.in_(_OPEN))
    elif status:
        stmt = stmt.where(ErpSalesOrder.status == status)
    if customer_id:
        stmt = stmt.where(ErpSalesOrder.customer_id == customer_id)
    if q and q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(ErpSalesOrder.number.ilike(like), ErpSalesOrder.customer_name.ilike(like),
                              ErpSalesOrder.customer_po_number.ilike(like)))
    if date_from:
        stmt = stmt.where(ErpSalesOrder.order_date >= date_from)
    if date_to:
        stmt = stmt.where(ErpSalesOrder.order_date <= date_to)
    orders = list(db.scalars(stmt.options(selectinload(ErpSalesOrder.lines)).order_by(ErpSalesOrder.created_at.desc())))
    ids = [so.id for so in orders]

    dispatches: dict[uuid.UUID, list[ErpDispatch]] = {}
    invoiced: dict[uuid.UUID, Decimal] = {}
    if ids:
        for d in db.scalars(select(ErpDispatch).where(ErpDispatch.sales_order_id.in_(ids))):
            dispatches.setdefault(d.sales_order_id, []).append(d)
        billed = db.execute(select(ErpInvoice.id, ErpInvoice.sales_order_id, ErpInvoice.grand_total).where(
            ErpInvoice.sales_order_id.in_(ids), ErpInvoice.status == "posted",
            ErpInvoice.kind.not_in(("proforma", "credit_note")))).all()
        order_of = {row.id: row.sales_order_id for row in billed}
        for row in billed:
            invoiced[row.sales_order_id] = invoiced.get(row.sales_order_id, ZERO) + row.grand_total
        if order_of:
            for original, total in db.execute(select(
                ErpInvoice.original_invoice_id, func.coalesce(func.sum(ErpInvoice.grand_total), 0),
            ).where(ErpInvoice.kind == "credit_note", ErpInvoice.status == "posted",
                    ErpInvoice.original_invoice_id.in_(order_of)).group_by(ErpInvoice.original_invoice_id)):
                invoiced[order_of[original]] -= Decimal(str(total))

    rows = []
    for so in orders:
        ended = so.status in (SalesOrderStatus.CANCELLED.value, SalesOrderStatus.CLOSED.value)
        done = money(invoiced.get(so.id, ZERO))
        rows.append({
            "so": so, "invoiced": done, "approval": _approval_status(so),
            "pending": money(ZERO if ended else max(ZERO, so.grand_total - done)),
            "delivery": _delivery_status(so, dispatches.get(so.id, [])),
        })
    if approval:
        rows = [row for row in rows if row["approval"] == approval]
    if delivery:
        rows = [row for row in rows if row["delivery"] == delivery]
    key = _SORTS.get(sort)
    if key:
        # Rows with no value stay last whichever way the column is sorted.
        filled = [row for row in rows if key(row) is not None]
        blank = [row for row in rows if key(row) is None]
        filled.sort(key=key, reverse=direction == "desc")
        rows = filled + blank

    total = len(rows)
    pages = max(1, (total + page_size - 1) // page_size)
    page = min(page, pages)  # the last row of the last page may just have gone
    start = (page - 1) * page_size
    return {
        "rows": [_order_out(db, row["so"]) for row in rows[start:start + page_size]],
        "total": total, "page": page, "page_size": page_size, "pages": pages,
        "summary": {name: {"count": n, "value": str(money(Decimal(str(value))))} for name, n, value in by_status},
    }


def list_orders(
    db: Session, viewer: User, *, status: str | None = None, customer_id: uuid.UUID | None = None,
    q: str | None = None, date_from: date | None = None, date_to: date | None = None,
) -> list[dict]:
    if not _readable(viewer):
        require(viewer, "can_manage_sales_orders")
    stmt = select(ErpSalesOrder).where(ErpSalesOrder.org_id == viewer.org_id)
    if status == "open":
        stmt = stmt.where(ErpSalesOrder.status.in_([
            SalesOrderStatus.APPROVED.value, SalesOrderStatus.PARTIALLY_DISPATCHED.value,
            SalesOrderStatus.ON_HOLD.value]))
    elif status:
        stmt = stmt.where(ErpSalesOrder.status == status)
    if customer_id:
        stmt = stmt.where(ErpSalesOrder.customer_id == customer_id)
    if date_from:
        stmt = stmt.where(ErpSalesOrder.order_date >= date_from)
    if date_to:
        stmt = stmt.where(ErpSalesOrder.order_date <= date_to)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(or_(ErpSalesOrder.number.ilike(like), ErpSalesOrder.customer_name.ilike(like),
                              ErpSalesOrder.customer_po_number.ilike(like)))
    return [_order_out(db, so) for so in db.scalars(stmt.order_by(ErpSalesOrder.created_at.desc()).limit(300))]


def _get(db: Session, viewer: User, so_id: uuid.UUID) -> ErpSalesOrder:
    from app.services import chains

    so = get_owned(db, ErpSalesOrder, viewer.org_id, so_id, "sales order")
    if not _readable(viewer) and not chains.is_current_reviewer(db, so.id, viewer):
        raise ErpError("not_found", "No such sales order.", 404)
    return so


def get_order(db: Session, viewer: User, so_id: uuid.UUID) -> dict:
    so = _get(db, viewer, so_id)
    return {**_order_out(db, so), **_order_detail(db, so)}


def _order_detail(db: Session, so: ErpSalesOrder) -> dict:
    """What the order's own page adds to a list row: the customer, the linked
    quotation, dispatch and delivery details, invoices with what was paid on
    them, and the activity trail — all read from records that already exist."""
    from app.models import AuditLog
    from app.models.erp import ErpCustomerAccount, ErpInvoice, ErpReceipt, ErpWarehouse
    from app.services.erp import billing

    customer = db.get(CrmCustomer, so.customer_id)
    account = db.scalar(select(ErpCustomerAccount).where(
        ErpCustomerAccount.org_id == so.org_id, ErpCustomerAccount.customer_id == so.customer_id))
    exposure = billing.customer_exposure(db, so.org_id, so.customer_id)
    quotation = db.get(CrmQuotation, so.quotation_id) if so.quotation_id else None

    dispatches = list(db.scalars(select(ErpDispatch).where(
        ErpDispatch.sales_order_id == so.id).order_by(ErpDispatch.created_at)))
    invoices = list(db.scalars(select(ErpInvoice).where(
        ErpInvoice.sales_order_id == so.id).order_by(ErpInvoice.created_at)))
    receipts = list(db.scalars(select(ErpReceipt).where(
        ErpReceipt.invoice_id.in_([i.id for i in invoices])).order_by(ErpReceipt.received_on))) if invoices else []
    houses = {w.id: w.name for w in db.scalars(select(ErpWarehouse).where(
        ErpWarehouse.id.in_({d.warehouse_id for d in dispatches})))} if dispatches else {}

    ids = [str(so.id), *(str(d.id) for d in dispatches), *(str(i.id) for i in invoices), *(str(r.id) for r in receipts)]
    trail = list(db.scalars(select(AuditLog).where(
        AuditLog.org_id == so.org_id, AuditLog.target_id.in_(ids)).order_by(AuditLog.created_at.desc()).limit(200)))
    names = user_names(db, so.org_id, [
        *(a.actor_user_id for a in trail), *(d.created_by for d in dispatches),
        *(i.created_by for i in invoices), *(r.created_by for r in receipts)])

    billed = [i for i in invoices if i.status == "posted" and i.kind not in ("proforma", "credit_note")]
    received = sum((r.amount for r in receipts if r.status == "posted"), ZERO)
    credited = sum((i.amount_credited for i in billed), ZERO)
    outstanding = sum((i.outstanding for i in billed), ZERO)
    invoiced = sum((i.grand_total for i in billed), ZERO)
    return {
        "customer": {
            "id": str(so.customer_id), "code": customer.code if customer else None,
            "name": customer.name if customer else so.customer_name,
            "company": customer.company if customer else None,
            "mobile": customer.mobile if customer else None, "email": customer.email if customer else None,
            "gstin": (account.gstin if account else None) or (customer.gstin if customer else None),
            "pan": account.pan if account else None,
            "billing_state": account.billing_state if account else None,
            "credit_days": account.credit_days if account else None,
            "credit_limit": str(account.credit_limit) if account else None,
            "credit_hold": bool(account and account.credit_hold),
            "outstanding": exposure["outstanding"], "overdue": exposure["overdue"],
        },
        "quotation": None if quotation is None else {
            "id": str(quotation.id), "number": quotation.number, "status": quotation.status,
            "quote_date": quotation.quote_date.isoformat() if quotation.quote_date else None,
            "grand_total": str(quotation.grand_total),
        },
        "dispatch_details": [{
            "id": str(d.id), "number": d.number, "status": d.status, "dispatch_date": d.dispatch_date.isoformat(),
            "warehouse": houses.get(d.warehouse_id), "transporter": d.transporter, "vehicle_no": d.vehicle_no,
            "tracking_ref": d.tracking_ref, "eway_bill_no": d.eway_bill_no, "value": str(d.value), "ship_to": d.ship_to,
            "delivered_on": d.delivered_on.isoformat() if d.delivered_on else None,
            "pod_received_by": d.pod_received_by, "pod_note": d.pod_note, "cancel_reason": d.cancel_reason,
            "created_by_name": names.get(d.created_by), "created_at": d.created_at.isoformat(),
            "lines": [{"id": str(line.id), "order_line_id": str(line.order_line_id), "description": line.description,
                       "quantity": str(line.quantity), "invoiced_qty": str(line.invoiced_qty),
                       "returned_qty": str(line.returned_qty), "replaced_qty": str(line.replaced_qty),
                       "free_qty": str(line.free_qty), "serials": line.serials or []} for line in d.lines],
        } for d in dispatches],
        "returns": [{
            "id": str(r.id), "number": r.number, "dispatch_id": str(r.dispatch_id), "return_date": r.return_date.isoformat(),
            "warehouse": db.get(ErpWarehouse, r.warehouse_id).name, "condition": r.condition, "reason": r.reason,
            "lines": r.lines, "value": str(r.value), "replace": r.replace, "created_by_name": user_names(db, so.org_id, [r.created_by]).get(r.created_by),
        } for r in db.scalars(select(ErpSalesReturn).where(ErpSalesReturn.sales_order_id == so.id)
                              .order_by(ErpSalesReturn.created_at.desc()))],
        "invoice_details": [{
            "id": str(i.id), "number": i.number, "kind": i.kind, "status": i.status,
            "invoice_date": i.invoice_date.isoformat(), "due_date": i.due_date.isoformat() if i.due_date else None,
            "grand_total": str(i.grand_total), "amount_received": str(i.amount_received),
            "amount_credited": str(i.amount_credited), "outstanding": str(money(i.outstanding)),
            "created_by_name": names.get(i.created_by),
        } for i in invoices],
        "receipts": [{
            "id": str(r.id), "number": r.number, "invoice_id": str(r.invoice_id), "received_on": r.received_on.isoformat(),
            "amount": str(r.amount), "mode": r.mode, "reference": r.reference, "status": r.status,
            "created_by_name": names.get(r.created_by),
        } for r in receipts],
        "payment_summary": {
            "order_value": str(so.grand_total), "invoiced": str(money(invoiced)), "credited": str(money(credited)),
            "received": str(money(received)), "outstanding": str(money(outstanding)),
            "to_bill": str(money(max(ZERO, so.grand_total - invoiced + credited - _returned_unbilled(so, dispatches)))),
        },
        "activity": [{
            "id": str(a.id), "action": a.action.removeprefix("erp."), "at": a.created_at.isoformat(),
            "by": names.get(a.actor_user_id) if a.actor_user_id else None,
            "target": a.target_type, "detail": a.detail or {},
        } for a in trail],
    }


def _known_state(db: Session, org_id: uuid.UUID, place: str | None) -> str | None:
    """The place of supply, checked against the States master when the company
    keeps one — GST turns on it, so a typo must not quietly become inter-state."""
    from app.models.crm import CrmState

    value = (place or "").strip()
    if not value:
        return None
    names = list(db.scalars(select(CrmState.name).where(CrmState.org_id == org_id, CrmState.is_active.is_(True))))
    if not names:
        return value
    match = next((n for n in names if n.lower() == value.lower()), None)
    if match is None:
        raise ErpError("bad_place_of_supply", f"“{value}” is not a state in Master › States — pick the place of supply from the list.")
    return match


def _apply(db: Session, viewer: User, so: ErpSalesOrder, payload: S.SalesOrderIn) -> None:
    customer = get_owned(db, CrmCustomer, viewer.org_id, payload.customer_id, "customer")
    account = masters.ensure_account(db, viewer.org_id, customer.id)
    if payload.site_id:
        site = get_owned(db, ErpCustomerSite, viewer.org_id, payload.site_id, "site")
        if site.account_id != account.id:
            raise ErpError("wrong_site", "That site belongs to a different customer.")
    if payload.customer_po_date and payload.customer_po_date > date.today():
        raise ErpError("future_po", "The customer's PO cannot be dated in the future.")
    so.customer_id = customer.id
    so.customer_name = account.legal_name or customer.company or customer.name
    if payload.required_by and payload.required_by < (payload.order_date or date.today()):
        raise ErpError("bad_dates", "The delivery date cannot be before the order date.")
    if payload.salesperson_id:
        person = db.get(User, payload.salesperson_id)
        if person is None or person.org_id != viewer.org_id:
            raise ErpError("bad_salesperson", "That salesperson is not in this company.")
    for field in ("quotation_id", "site_id", "project_id", "customer_po_number", "customer_po_date",
                  "customer_po_value", "required_by", "deviation_note", "notes", "salesperson_id",
                  "order_type", "priority", "delivery_mode", "freight_terms"):
        setattr(so, field, getattr(payload, field))
    for field in ("reference", "delivery_terms", "transporter_name", "delivery_instructions", "terms", "internal_notes"):
        setattr(so, field, (getattr(payload, field) or "").strip() or None)
    so.freight = money(payload.freight)
    so.other_charges = money(payload.other_charges)
    so.order_date = payload.order_date or date.today()
    so.billing_address = payload.billing_address or account.billing_address
    so.shipping_address = payload.shipping_address or account.shipping_address or so.billing_address
    so.place_of_supply = _known_state(db, viewer.org_id, payload.place_of_supply) or account.billing_state
    so.payment_terms = payload.payment_terms or f"{account.credit_days} days"
    so.is_interstate = is_interstate(db, viewer.org_id, so.place_of_supply)

    so.lines.clear()
    sub = tax = ZERO
    for order, line in enumerate(payload.lines):
        item = get_owned(db, ErpItem, viewer.org_id, line.item_id, "item") if line.item_id else None
        if item is None and not line.description:
            raise ErpError("description_required", "A line without an item needs a description.")
        if item is not None and not item.is_active:
            raise ErpError("item_inactive", f"{item.code} is inactive.", 409)
        gst = line.gst_percent if line.gst_percent is not None else (item.gst_percent if item else Decimal("18"))
        fulfilment = line.fulfilment or ("stock" if item and item.is_stocked else "service")
        if fulfilment != "service" and (item is None or not item.is_stocked):
            raise ErpError("needs_item", "Only a stocked item can be fulfilled from stock or procured.")
        priced = price_line(line.quantity, line.rate, gst, line.discount_percent)
        so.lines.append(ErpSalesOrderLine(
            org_id=viewer.org_id, item_id=item.id if item else None,
            description=line.description or item.name, hsn_sac=line.hsn_sac or (item.hsn_sac if item else None),
            uom=line.uom or (item.uom if item else "Nos"), gst_percent=gst, fulfilment=fulfilment,
            sort_order=order, discount_percent=line.discount_percent, **priced,
        ))
        sub += priced["taxable_value"]
        tax += priced["tax_amount"]
    # Freight and other charges are part of the supply: taxable, at the rate
    # asked for or else the highest rate on the items.
    charges = so.freight + so.other_charges
    rate = payload.charges_gst_percent if payload.charges_gst_percent is not None else max(
        (line.gst_percent for line in so.lines), default=Decimal("18"))
    so.charges_gst_percent = rate
    sub += charges
    tax += money(charges * rate / Decimal("100"))
    so.sub_total = money(sub)
    so.tax_total = money(tax)
    for key, value in split_tax(so.tax_total, interstate=so.is_interstate).items():
        setattr(so, key, value)
    so.grand_total = money(sub + tax)

    so.milestones.clear()
    for order, ms in enumerate(payload.milestones):
        so.milestones.append(ErpBillingMilestone(
            org_id=viewer.org_id, name=ms.name, kind=ms.kind, taxable_amount=money(ms.taxable_amount),
            gst_percent=ms.gst_percent, due_date=ms.due_date, sort_order=order,
        ))
    if sum((m.taxable_amount for m in so.milestones), ZERO) > so.sub_total and so.sub_total > 0:
        raise ErpError("milestones_exceed", "The billing milestones add up to more than the order value.")

    # PO vs quote — FR-05.02. The comparison is on value: a matching total with
    # shuffled lines is a re-presentation, a different total is a deviation.
    if so.quotation_id:
        quotation = get_owned(db, CrmQuotation, viewer.org_id, so.quotation_id, "quotation")
        so.quoted_total = quotation.grand_total
        so.has_deviation = money(quotation.grand_total) != so.grand_total
    else:
        so.quoted_total = None
        so.has_deviation = False
    if payload.customer_po_value is not None and money(payload.customer_po_value) != so.grand_total:
        so.has_deviation = True


def peek_order_number(db: Session, viewer: User, on: date | None = None) -> dict:
    """The number the next new order would get — shown on the form, not taken."""
    from app.services.erp.common import company_state, peek_number

    require(viewer, "can_manage_sales_orders")
    return {"number": peek_number(db, viewer.org_id, "SO", on or date.today()),
            "company_state": company_state(db, viewer.org_id)}


def add_attachment(db: Session, viewer: User, so_id: uuid.UUID, payload: S.AttachmentIn,
                   request: Request | None = None) -> dict:
    """The customer's PO copy, a drawing, a signed BOQ. Kept while the order is
    live; closed and cancelled orders are a record and take no more files."""
    require(viewer, "can_manage_sales_orders")
    so = _get(db, viewer, so_id)
    if so.status in (SalesOrderStatus.CANCELLED.value, SalesOrderStatus.CLOSED.value):
        raise ErpError("closed", f"This order is {so.status}.", 409)
    files = list(so.attachments or [])
    if len(files) >= 10:
        raise ErpError("too_many", "An order holds up to 10 attachments.")
    kind = payload.data.split(";", 1)[0].removeprefix("data:")
    entry = {"id": uuid.uuid4().hex[:12], "name": payload.name.strip(), "type": kind,
             "size": len(payload.data) * 3 // 4, "data": payload.data, "at": _now().isoformat(),
             "by_name": viewer.full_name or viewer.email}
    so.attachments = [*files, entry]
    record_audit(db, viewer, "sales_order.attachment_added", so, request=request, detail={"name": entry["name"]})
    db.commit()
    return get_order(db, viewer, so.id)


def get_attachment(db: Session, viewer: User, so_id: uuid.UUID, att_id: str) -> dict:
    so = _get(db, viewer, so_id)
    found = next((a for a in so.attachments or [] if a.get("id") == att_id), None)
    if found is None:
        raise ErpError("not_found", "No such attachment.", 404)
    return {"name": found["name"], "data": found["data"]}


def remove_attachment(db: Session, viewer: User, so_id: uuid.UUID, att_id: str,
                      request: Request | None = None) -> dict:
    require(viewer, "can_manage_sales_orders")
    so = _get(db, viewer, so_id)
    files = list(so.attachments or [])
    found = next((a for a in files if a.get("id") == att_id), None)
    if found is None:
        raise ErpError("not_found", "No such attachment.", 404)
    so.attachments = [a for a in files if a.get("id") != att_id] or None
    record_audit(db, viewer, "sales_order.attachment_removed", so, request=request, detail={"name": found["name"]})
    db.commit()
    return get_order(db, viewer, so.id)


def send_to_customer(db: Session, viewer: User, so_id: uuid.UUID, payload: S.SendOrderIn,
                     request: Request | None = None) -> dict:
    """Email the order's PDF. Only once released: until then it is not a commitment."""
    from app.services.erp.common import mail_order_pdf

    require(viewer, "can_manage_sales_orders")
    so = _get(db, viewer, so_id)
    if so.status not in _RELEASED:
        raise ErpError("not_released", "Only an approved order is sent to the customer.", 409)
    mail_order_pdf(so.org_id, so.number, payload.to, payload.subject, payload.message, payload.pdf)
    record_audit(db, viewer, "sales_order.sent", so, request=request, detail={"to": payload.to})
    db.commit()
    return get_order(db, viewer, so.id)


def save_order(db: Session, viewer: User, payload: S.SalesOrderIn, so_id: uuid.UUID | None = None,
               request: Request | None = None) -> dict:
    require(viewer, "can_manage_sales_orders")
    if so_id:
        so = _get(db, viewer, so_id)
        if so.status != SalesOrderStatus.DRAFT.value:
            raise ErpError("not_draft", "A released order is not edited.", 409)
    else:
        so = ErpSalesOrder(
            org_id=viewer.org_id, created_by=viewer.id,
            number=next_number(db, viewer.org_id, "SO", payload.order_date or date.today()),
        )
    with db.no_autoflush:  # see purchase.save_purchase_order
        _apply(db, viewer, so, payload)
    db.add(so)
    db.flush()
    record_audit(db, viewer, "sales_order.saved", so, request=request,
                 detail={"grand_total": str(so.grand_total), "deviation": so.has_deviation})
    db.commit()
    return get_order(db, viewer, so.id)


def delete_order(db: Session, viewer: User, so_id: uuid.UUID, request: Request | None = None) -> None:
    """Delete an order nobody but its author has ever seen.

    Only a draft that was never submitted. One that was submitted, rejected and
    revised is a draft again but has an approval history, so it is cancelled with
    a reason instead, as is anything further along. The number is not handed back:
    it may already have been quoted to somebody. What was deleted stays in the
    audit log, because the row itself no longer can.
    """
    from app.models.erp import ErpInvoice, ErpPurchaseOrder, ErpRequisition, ErpSerial

    require(viewer, "can_delete_sales_orders")
    so = _get(db, viewer, so_id)
    if so.status != SalesOrderStatus.DRAFT.value:
        raise ErpError("not_draft", f"This order is {so.status}. Only a draft that was never submitted is deleted.", 409)
    if so.submitted_at is not None:
        raise ErpError("was_submitted", "This order has been through approval, so its history is kept. Cancel it instead.", 409)
    linked = (("dispatches", ErpDispatch), ("invoices", ErpInvoice), ("requisitions", ErpRequisition),
              ("purchase orders", ErpPurchaseOrder), ("serials", ErpSerial))
    for name, model in linked:
        if db.scalar(select(func.count()).select_from(model).where(model.sales_order_id == so.id)):
            raise ErpError("has_documents", f"This order has {name} against it, so it cannot be deleted.", 409)
    record_audit(db, viewer, "sales_order.deleted", so, request=request, detail={
        "customer": so.customer_name, "grand_total": str(so.grand_total), "order_date": so.order_date.isoformat(),
        "customer_po": so.customer_po_number, "quotation_id": str(so.quotation_id) if so.quotation_id else None,
        "lines": len(so.lines), "created_by": str(so.created_by),
    })
    db.delete(so)
    db.commit()


def _clip(text: str | None, limit: int) -> str | None:
    """A quotation's free text, cut to what the order's field can hold."""
    text = (text or "").strip()
    if not text:
        return None
    return text if len(text) <= limit else f"{text[:limit - 1].rstrip()}…"


def from_quotation(db: Session, viewer: User, quotation_id: uuid.UUID, request: Request | None = None) -> dict:
    """Convert an accepted CRM quotation — J01's handoff, no re-entry.

    Lines map to ERP items through ``ErpItem.crm_product_id``; a quotation line
    whose product has no ERP item comes across as a service line, which is the
    honest reading of "something sold that is not stocked".
    """
    from app.models import CrmQuotationLine

    quotation = get_owned(db, CrmQuotation, viewer.org_id, quotation_id, "quotation")
    if quotation.status != "accepted":
        raise ErpError("not_accepted", f"Quotation {quotation.number} is {quotation.status}, not accepted.", 409)
    if quotation.customer_id is None:
        raise ErpError("no_customer", "Convert the lead to a customer before booking the order.", 409)
    existing = db.scalar(select(ErpSalesOrder).where(
        ErpSalesOrder.org_id == viewer.org_id, ErpSalesOrder.quotation_id == quotation.id,
        ErpSalesOrder.status != SalesOrderStatus.CANCELLED.value))
    if existing is not None:
        raise ErpError("already_ordered", f"{existing.number} was already booked from this quotation.", 409)
    by_product = {i.crm_product_id: i for i in db.scalars(select(ErpItem).where(
        ErpItem.org_id == viewer.org_id, ErpItem.crm_product_id.is_not(None)))}
    lines = []
    for ql in db.scalars(select(CrmQuotationLine).where(
            CrmQuotationLine.quotation_id == quotation.id).order_by(CrmQuotationLine.sort_order)):
        item = by_product.get(ql.product_id)
        # The quotation's discount is baked into the rate, so the order's taxable
        # value equals the quotation's line for line.
        rate = money(ql.taxable_value / ql.quantity) if ql.quantity else money(ql.rate)
        lines.append(S.SalesOrderLineIn(
            item_id=item.id if item else None, description=ql.name, hsn_sac=ql.hsn_sac,
            quantity=ql.quantity, rate=rate, gst_percent=ql.gst_percent,
            fulfilment=None if item else "service",
        ))
    # Who sold it: the quotation's author, if still with the company.
    author = db.get(User, quotation.created_by) if quotation.created_by else None
    terms = "\n\n".join(t.strip() for t in (quotation.terms, quotation.warranty_terms) if t and t.strip())
    payload = S.SalesOrderIn(
        customer_id=quotation.customer_id, quotation_id=quotation.id, lines=lines,
        billing_address=quotation.billing_address, shipping_address=quotation.shipping_address,
        place_of_supply=quotation.state, payment_terms=_clip(quotation.payment_terms, 160),
        delivery_terms=_clip(quotation.delivery_terms, 160), terms=_clip(terms, 4000), notes=quotation.notes,
        salesperson_id=author.id if author and author.org_id == viewer.org_id and author.is_active else None,
    )
    return save_order(db, viewer, payload, request=request)


def credit_check(db: Session, so: ErpSalesOrder) -> None:
    """Refuse release for a held, over-limit or badly overdue customer."""
    from app.services.erp import billing

    account = masters.ensure_account(db, so.org_id, so.customer_id)
    if account.credit_hold:
        raise ErpError("credit_hold", f"{so.customer_name} is on credit hold: {account.hold_reason}", 409)
    exposure = billing.customer_exposure(db, so.org_id, so.customer_id)
    if account.credit_limit > 0:
        committed = Decimal(exposure["outstanding"]) + Decimal(exposure["open_order_value"]) + so.grand_total
        if committed > account.credit_limit:
            raise ErpError(
                "credit_limit",
                f"Releasing this order takes {so.customer_name} to ₹{committed:,.2f} against a "
                f"credit limit of ₹{account.credit_limit:,.2f}.", 409,
            )
    settings = get_settings(db, so.org_id)
    if settings.block_orders_overdue_days and exposure["oldest_overdue_days"] > settings.block_orders_overdue_days:
        raise ErpError(
            "overdue",
            f"{so.customer_name} has an invoice {exposure['oldest_overdue_days']} days overdue.", 409,
        )


def submit_order(db: Session, viewer: User, so_id: uuid.UUID, request: Request | None = None) -> dict:
    from app.services import chains

    require(viewer, "can_manage_sales_orders")
    so = _get(db, viewer, so_id)
    if so.status != SalesOrderStatus.DRAFT.value:
        raise ErpError("not_draft", f"This order is {so.status}.", 409)
    if so.has_deviation and not (so.deviation_note or "").strip():
        raise ErpError("deviation_note", "This order differs from its quotation or the customer's PO value — explain the deviation before submitting.")
    credit_check(db, so)
    so.status = SalesOrderStatus.SUBMITTED.value
    so.submitted_at = _now()
    db.flush()
    chains.start_for(db, kind="sales_order", record_id=so.id, subject=viewer, record=so)
    record_audit(db, viewer, "sales_order.submitted", so, request=request)
    db.commit()
    return get_order(db, viewer, so.id)


def decide_order(db: Session, viewer: User, so_id: uuid.UUID, payload: S.DecisionIn,
                 request: Request | None = None) -> dict:
    from app.services import workflow

    so = _get(db, viewer, so_id)
    kernel_decide(db, viewer, workflow.ERP_SALES_ORDER, so, payload,
                  on_approve=lambda: credit_check(db, so), request=request)
    db.commit()
    return get_order(db, viewer, so.id)


def revise_order(db: Session, viewer: User, so_id: uuid.UUID, request: Request | None = None) -> dict:
    from app.services.erp.purchase import reset_chain

    require(viewer, "can_manage_sales_orders")
    so = _get(db, viewer, so_id)
    if so.status != SalesOrderStatus.REJECTED.value:
        raise ErpError("not_rejected", "Only a rejected order is revised.", 409)
    reset_chain(db, so.id)
    so.status = SalesOrderStatus.DRAFT.value
    record_audit(db, viewer, "sales_order.revised", so, request=request)
    db.commit()
    return get_order(db, viewer, so.id)


def _live_invoices(db: Session, so: ErpSalesOrder) -> bool:
    from app.models.erp import ErpInvoice

    return any(i.status not in ("cancelled", "rejected") and i.kind not in ("proforma", "credit_note")
               for i in db.scalars(select(ErpInvoice).where(ErpInvoice.sales_order_id == so.id)))


def amend_order(db: Session, viewer: User, so_id: uuid.UUID, reason: str | None, request: Request | None = None) -> dict:
    """An approved order back to draft, to be changed and approved again. Only
    before anything has happened against the figures that were approved."""
    from app.services.erp.purchase import reset_chain

    require(viewer, "can_manage_sales_orders")
    so = _get(db, viewer, so_id)
    if so.status != SalesOrderStatus.APPROVED.value:
        raise ErpError("not_amendable", f"A {so.status} order cannot be amended.", 409)
    if db.scalar(select(func.count()).select_from(ErpDispatch).where(ErpDispatch.sales_order_id == so.id)):
        raise ErpError("dispatched", "This order has a dispatch against it. Close it and raise another.", 409)
    if _live_invoices(db, so):
        raise ErpError("invoiced", "An invoice is raised against this order. Delete or cancel it first.", 409)
    cleaned = require_reason(reason, "order is amended")
    _release_all(db, so)
    reset_chain(db, so.id)
    so.status = SalesOrderStatus.DRAFT.value
    so.reviewed_by = so.reviewed_at = None
    so.review_note = None
    record_audit(db, viewer, "sales_order.amended", so, request=request, detail={"reason": cleaned})
    db.commit()
    return get_order(db, viewer, so.id)


def duplicate_order(db: Session, viewer: User, so_id: uuid.UUID, request: Request | None = None) -> dict:
    """A new draft with the same customer, lines and terms. The customer's PO,
    the quotation and the dates belong to the old order, so they do not come."""
    require(viewer, "can_manage_sales_orders")
    so = _get(db, viewer, so_id)
    payload = S.SalesOrderIn(
        customer_id=so.customer_id, site_id=so.site_id, project_id=so.project_id,
        billing_address=so.billing_address, shipping_address=so.shipping_address,
        place_of_supply=so.place_of_supply, payment_terms=so.payment_terms, notes=so.notes,
        salesperson_id=so.salesperson_id, order_type=so.order_type, priority=so.priority,
        delivery_terms=so.delivery_terms, delivery_mode=so.delivery_mode, transporter_name=so.transporter_name,
        freight_terms=so.freight_terms, delivery_instructions=so.delivery_instructions, terms=so.terms,
        internal_notes=so.internal_notes, freight=so.freight, other_charges=so.other_charges,
        charges_gst_percent=so.charges_gst_percent,
        lines=[S.SalesOrderLineIn(
            item_id=line.item_id, description=line.description, hsn_sac=line.hsn_sac, uom=line.uom,
            quantity=line.quantity, rate=line.rate, discount_percent=line.discount_percent,
            gst_percent=line.gst_percent, fulfilment=line.fulfilment,
        ) for line in so.lines],
        milestones=[S.MilestoneIn(
            name=m.name, kind=m.kind, taxable_amount=m.taxable_amount, gst_percent=m.gst_percent,
        ) for m in so.milestones],
    )
    copy = save_order(db, viewer, payload, request=request)
    new = _get(db, viewer, uuid.UUID(copy["id"]))
    record_audit(db, viewer, "sales_order.duplicated", new, request=request, detail={"from": so.number})
    db.commit()
    return get_order(db, viewer, new.id)


def set_hold(db: Session, viewer: User, so_id: uuid.UUID, payload: S.HoldIn, request: Request | None = None) -> dict:
    """FR-05.12. A hold stops dispatch; releasing it returns the order to where it was."""
    require(viewer, "can_approve_sales_orders")
    so = _get(db, viewer, so_id)
    reason = require_reason(payload.reason, "hold changes")
    if payload.hold:
        if not SalesOrderStatus(so.status).is_fulfillable:
            raise ErpError("not_open", f"A {so.status} order cannot be put on hold.", 409)
        so.status = SalesOrderStatus.ON_HOLD.value
        so.hold_reason = reason
    else:
        if so.status != SalesOrderStatus.ON_HOLD.value:
            raise ErpError("not_on_hold", "This order is not on hold.", 409)
        so.status = (SalesOrderStatus.PARTIALLY_DISPATCHED if any(
            line.dispatched_qty > 0 for line in so.lines) else SalesOrderStatus.APPROVED).value
        so.hold_reason = None
    record_audit(db, viewer, "sales_order.hold", so, request=request, detail={"hold": payload.hold, "reason": reason})
    db.commit()
    return get_order(db, viewer, so.id)


def reserve(db: Session, viewer: User, so_id: uuid.UUID, payload: S.ReserveIn, request: Request | None = None) -> dict:
    """Reserve what is available, line by line, in one warehouse — FR-05.05.

    Partial by design: an order for ten with six on the shelf reserves six and
    reports four short, which is the input to :func:`raise_shortage_requisition`.
    """
    require(viewer, "can_manage_sales_orders")
    so = _get(db, viewer, so_id)
    if not SalesOrderStatus(so.status).is_fulfillable:
        raise ErpError("not_released", "Reserve stock against a released order.", 409)
    wh = stock.active_warehouse(db, viewer.org_id, payload.warehouse_id)
    reserved_any = False
    for line in so.lines:
        if line.fulfilment == "service" or line.item_id is None:
            continue
        if line.reserved_qty > 0 and line.reserved_warehouse_id not in (None, wh.id):
            continue  # already reserved elsewhere — release first to move it
        needed = line.quantity - line.dispatched_qty - line.reserved_qty
        if needed <= 0:
            continue
        free = stock.available(db, viewer.org_id, line.item_id, wh.id)
        take = min(needed, free)
        if take <= 0:
            continue
        item = db.get(ErpItem, line.item_id)
        stock.reserve(db, viewer.org_id, item, wh.id, take)
        line.reserved_qty = qty(line.reserved_qty + take)
        line.reserved_warehouse_id = wh.id
        reserved_any = True
    if not reserved_any:
        raise ErpError("nothing_to_reserve", f"Nothing more can be reserved from {wh.name}.", 409)
    record_audit(db, viewer, "sales_order.reserved", so, request=request, detail={"warehouse": wh.name})
    db.commit()
    return get_order(db, viewer, so.id)


def unreserve(db: Session, viewer: User, so_id: uuid.UUID, request: Request | None = None) -> dict:
    require(viewer, "can_manage_sales_orders")
    so = _get(db, viewer, so_id)
    _release_all(db, so)
    record_audit(db, viewer, "sales_order.unreserved", so, request=request)
    db.commit()
    return get_order(db, viewer, so.id)


def _release_all(db: Session, so: ErpSalesOrder) -> None:
    for line in so.lines:
        if line.reserved_qty > 0 and line.reserved_warehouse_id and line.item_id:
            stock.release(db, so.org_id, line.item_id, line.reserved_warehouse_id, line.reserved_qty)
        line.reserved_qty = ZERO
        line.reserved_warehouse_id = None


def raise_shortage_requisition(db: Session, viewer: User, so_id: uuid.UUID, request: Request | None = None) -> dict:
    """Auto-PR from order shortage — FR-06.02. Raised as a draft in the
    caller's name, so it still goes through requisition approval."""
    from app.services.erp import purchase

    require(viewer, "can_manage_sales_orders")
    so = _get(db, viewer, so_id)
    if not SalesOrderStatus(so.status).is_fulfillable:
        raise ErpError("not_released", "Shortages are raised against a released order.", 409)
    lines = []
    for line in so.lines:
        if line.fulfilment == "service" or line.item_id is None:
            continue
        short = line.quantity - line.dispatched_qty - line.reserved_qty - stock.available(db, viewer.org_id, line.item_id)
        if short > 0:
            item = db.get(ErpItem, line.item_id)
            lines.append(S.RequisitionLineIn(item_id=item.id, quantity=short, estimated_rate=item.standard_cost))
    if not lines:
        raise ErpError("no_shortage", "Stock on hand covers this order.", 409)
    return purchase.save_requisition(db, viewer, S.RequisitionIn(
        title=f"Shortage for {so.number} — {so.customer_name}", sales_order_id=so.id,
        project_id=so.project_id, required_by=so.required_by, lines=lines,
    ), request=request)


def mark_milestone_ready(db: Session, viewer: User, milestone_id: uuid.UUID, payload: S.MilestoneReadyIn,
                         request: Request | None = None) -> dict:
    """Evidence in, milestone billable — FR-18.07's prerequisite, in its simplest form."""
    require(viewer, "can_manage_sales_orders")
    ms = get_owned(db, ErpBillingMilestone, viewer.org_id, milestone_id, "milestone")
    so = db.get(ErpSalesOrder, ms.order_id)
    if not (SalesOrderStatus(so.status).is_fulfillable or so.status in (
            SalesOrderStatus.DISPATCHED.value, SalesOrderStatus.ON_HOLD.value)):
        raise ErpError("not_released", "Milestones are billable on a released order.", 409)
    if ms.status != MilestoneStatus.PENDING.value:
        raise ErpError("not_pending", f"This milestone is {ms.status}.", 409)
    ms.evidence = require_reason(payload.evidence, "milestone is marked ready (the evidence)")
    ms.status = MilestoneStatus.READY.value
    record_audit(db, viewer, "sales_order.milestone_ready", so, request=request,
                 detail={"milestone": ms.name, "evidence": ms.evidence})
    db.commit()
    return get_order(db, viewer, so.id)


def cancel_order(db: Session, viewer: User, so_id: uuid.UUID, reason: str | None, request: Request | None = None) -> dict:
    require(viewer, "can_manage_sales_orders")
    so = _get(db, viewer, so_id)
    if any(line.dispatched_qty > 0 for line in so.lines):
        raise ErpError("dispatched", "Goods have left against this order — short-close it instead.", 409)
    if so.status in (SalesOrderStatus.CANCELLED.value, SalesOrderStatus.CLOSED.value):
        raise ErpError("closed", f"This order is {so.status}.", 409)
    if any(m.status == MilestoneStatus.INVOICED.value for m in so.milestones):
        raise ErpError("invoiced", "A milestone is invoiced — raise a credit note before cancelling.", 409)
    from app.models.erp import ErpInvoice

    # A draft invoice counts: left behind, it could still be posted against a dead order.
    live = list(db.scalars(select(ErpInvoice).where(
        ErpInvoice.sales_order_id == so.id, ErpInvoice.kind.not_in(("proforma", "credit_note")),
        ErpInvoice.status.not_in(("cancelled", "rejected")))))
    if live:
        raise ErpError("invoiced", f"Invoice {live[0].number or '(draft)'} is raised against this order — delete or cancel it first.", 409)
    cleaned = require_reason(reason, "order is cancelled")
    _release_all(db, so)  # FR-05.19
    so.status = SalesOrderStatus.CANCELLED.value
    so.closed_reason = cleaned
    record_audit(db, viewer, "sales_order.cancelled", so, request=request, detail={"reason": cleaned})
    db.commit()
    return get_order(db, viewer, so.id)


def short_close(db: Session, viewer: User, so_id: uuid.UUID, reason: str | None, request: Request | None = None) -> dict:
    require(viewer, "can_approve_sales_orders")
    so = _get(db, viewer, so_id)
    if so.status not in (SalesOrderStatus.PARTIALLY_DISPATCHED.value, SalesOrderStatus.DISPATCHED.value,
                         SalesOrderStatus.ON_HOLD.value, SalesOrderStatus.APPROVED.value):
        raise ErpError("not_open", f"A {so.status} order cannot be closed.", 409)
    cleaned = require_reason(reason, "order is closed")
    _release_all(db, so)
    so.status = SalesOrderStatus.CLOSED.value
    so.closed_reason = cleaned
    record_audit(db, viewer, "sales_order.closed", so, request=request, detail={"reason": cleaned})
    db.commit()
    return get_order(db, viewer, so.id)


def _refresh_status(so: ErpSalesOrder) -> None:
    if so.status in (SalesOrderStatus.ON_HOLD.value, SalesOrderStatus.CLOSED.value):
        return
    goods = [line for line in so.lines if line.fulfilment != "service"]
    if goods and all(line.dispatched_qty >= line.quantity for line in goods):
        so.status = SalesOrderStatus.DISPATCHED.value
    elif any(line.dispatched_qty > 0 for line in goods):
        so.status = SalesOrderStatus.PARTIALLY_DISPATCHED.value
    else:
        so.status = SalesOrderStatus.APPROVED.value


# --------------------------------------------------------------------------- #
# Dispatch
# --------------------------------------------------------------------------- #


def _dispatch_out(db: Session, d: ErpDispatch) -> dict:
    so = db.get(ErpSalesOrder, d.sales_order_id)
    wh = db.get(ErpWarehouse, d.warehouse_id)
    names = user_names(db, d.org_id, [d.created_by])
    return {
        **row_dict(d), "order_number": so.number if so else None,
        "customer_name": so.customer_name if so else None, "customer_id": str(so.customer_id) if so else None,
        "warehouse_name": wh.name if wh else None, "created_by_name": names.get(d.created_by),
        "uninvoiced": not billed_by_milestones(so) and any(line.billable_qty > 0 for line in d.lines),
        "billed_by_milestones": billed_by_milestones(so),
        "lines": [row_dict(line) for line in d.lines],
    }


def list_dispatches(db: Session, viewer: User, *, status: str | None = None, uninvoiced: bool = False) -> list[dict]:
    if not _readable(viewer):
        require(viewer, "can_manage_sales_orders")
    stmt = select(ErpDispatch).where(ErpDispatch.org_id == viewer.org_id)
    if status:
        stmt = stmt.where(ErpDispatch.status == status)
    rows = [_dispatch_out(db, d) for d in db.scalars(stmt.order_by(ErpDispatch.created_at.desc()).limit(300))]
    if uninvoiced:
        rows = [r for r in rows if r["uninvoiced"] and r["status"] != DispatchStatus.CANCELLED.value]
    return rows


def get_dispatch(db: Session, viewer: User, dispatch_id: uuid.UUID) -> dict:
    if not _readable(viewer):
        require(viewer, "can_manage_sales_orders")
    return _dispatch_out(db, get_owned(db, ErpDispatch, viewer.org_id, dispatch_id, "dispatch"))


def create_dispatch(db: Session, viewer: User, payload: S.DispatchIn, request: Request | None = None) -> dict:
    """Pick, check serials, and ship — FR-09.01 to 09.07. Stock leaves here."""
    require(viewer, "can_manage_sales_orders")
    so = _get(db, viewer, payload.sales_order_id)
    if not SalesOrderStatus(so.status).is_fulfillable:
        raise ErpError(
            "not_dispatchable",
            "This order is on hold." if so.status == SalesOrderStatus.ON_HOLD.value
            else f"A {so.status} order cannot be dispatched.", 409,
        )
    wh = stock.active_warehouse(db, viewer.org_id, payload.warehouse_id)
    when = payload.dispatch_date or date.today()
    lines_by_id = {line.id: line for line in so.lines}
    d = ErpDispatch(
        org_id=viewer.org_id, sales_order_id=so.id, warehouse_id=wh.id, dispatch_date=when,
        transporter=payload.transporter, tracking_ref=payload.tracking_ref, vehicle_no=payload.vehicle_no,
        eway_bill_no=payload.eway_bill_no, ship_to=payload.ship_to or so.shipping_address,
        created_by=viewer.id, number=next_number(db, viewer.org_id, "DC", when),
    )
    db.add(d)
    db.flush()
    value = ZERO
    for pl in payload.lines:
        line = lines_by_id.get(pl.order_line_id)
        if line is None:
            raise ErpError("wrong_order", "A line does not belong to this order.")
        if line.fulfilment == "service":
            raise ErpError("service_line", f"“{line.description}” is a service; it is billed, not dispatched.")
        quantity = qty(pl.quantity)
        if quantity > line.quantity - line.dispatched_qty:
            raise ErpError("over_dispatch",
                           f"“{line.description}”: only {(line.quantity - line.dispatched_qty).normalize():f} left to dispatch.")
        item = db.get(ErpItem, line.item_id)
        serials = stock.check_serial_count(item, quantity, pl.serials)
        consume = min(line.reserved_qty, quantity) if line.reserved_warehouse_id == wh.id else ZERO
        if serials:
            stock.take_serials(db, viewer, item=item, serials=serials, warehouse_id=wh.id, condition="good",
                               new_status=SerialStatus.DELIVERED, kind=MovementKind.DISPATCH,
                               ref_type="dispatch", ref_id=d.id, ref_number=d.number,
                               customer_id=so.customer_id, sales_order_id=so.id)
        stock.move(db, viewer, item=item, warehouse_id=wh.id, quantity=-quantity, kind=MovementKind.DISPATCH,
                   ref_type="dispatch", ref_id=d.id, ref_number=d.number, serials=serials,
                   consume_reserved=consume)
        line.reserved_qty = qty(line.reserved_qty - consume)
        if line.reserved_qty <= 0:
            line.reserved_warehouse_id = None
        line.dispatched_qty = qty(line.dispatched_qty + quantity)
        value += quantity * line.net_rate
        free = min(quantity, line.free_replacement_qty)
        line.free_replacement_qty = qty(line.free_replacement_qty - free)
        d.lines.append(ErpDispatchLine(
            org_id=viewer.org_id, order_line_id=line.id, item_id=line.item_id,
            description=line.description, quantity=quantity, serials=serials or None, free_qty=free,
        ))
    d.value = money(value)
    _refresh_status(so)
    for ms in so.milestones:
        if ms.kind == "dispatch" and ms.status == MilestoneStatus.PENDING.value:
            ms.status = MilestoneStatus.READY.value
            ms.evidence = f"Dispatched on {d.number}"
    record_audit(db, viewer, "dispatch.created", d, request=request, detail={"order": so.number, "value": str(d.value)})
    db.commit()
    return get_dispatch(db, viewer, d.id)


def deliver(db: Session, viewer: User, dispatch_id: uuid.UUID, payload: S.DeliveryIn,
            request: Request | None = None) -> dict:
    """Proof of delivery — FR-09.11. Readies any delivery milestone."""
    require(viewer, "can_manage_sales_orders")
    d = get_owned(db, ErpDispatch, viewer.org_id, dispatch_id, "dispatch")
    if d.status != DispatchStatus.DISPATCHED.value:
        raise ErpError("not_in_transit", f"This dispatch is {d.status}.", 409)
    delivered = payload.delivered_on or date.today()
    if delivered < d.dispatch_date:
        raise ErpError("before_dispatch", "Delivery cannot be before dispatch.")
    d.status = DispatchStatus.DELIVERED.value
    d.delivered_on = delivered
    d.pod_received_by = require_reason(payload.received_by, "delivery is recorded (who received it)")
    d.pod_note = payload.note
    so = db.get(ErpSalesOrder, d.sales_order_id)
    for ms in so.milestones:
        if ms.kind == "delivery" and ms.status == MilestoneStatus.PENDING.value:
            ms.status = MilestoneStatus.READY.value
            ms.evidence = f"Delivered on {d.number}, received by {d.pod_received_by}"
    record_audit(db, viewer, "dispatch.delivered", d, request=request, detail={"received_by": d.pod_received_by})
    db.commit()
    return get_dispatch(db, viewer, d.id)


_TRANSPORT = ("transporter", "tracking_ref", "vehicle_no", "eway_bill_no")


def update_transport(db: Session, viewer: User, dispatch_id: uuid.UUID, payload: S.DispatchTransportIn,
                     request: Request | None = None) -> dict:
    """Correct how a shipment travels: transporter, vehicle, LR and e-way bill.
    Nothing about the goods or the stock changes. Only while it is in transit:
    once delivered, the paperwork is what was delivered against."""
    require(viewer, "can_manage_sales_orders")
    d = get_owned(db, ErpDispatch, viewer.org_id, dispatch_id, "dispatch")
    if d.status != DispatchStatus.DISPATCHED.value:
        raise ErpError("not_in_transit", f"A {d.status} dispatch cannot be changed.", 409)
    changes = {}
    for field in _TRANSPORT:
        value = (getattr(payload, field) or "").strip() or None
        if field == "vehicle_no" and value:
            value = value.upper().replace(" ", "")
        if value != getattr(d, field):
            changes[field] = {"from": getattr(d, field), "to": value}
            setattr(d, field, value)
    if changes:
        record_audit(db, viewer, "dispatch.transport_changed", d, request=request,
                     detail={"number": d.number, "changes": changes})
        db.commit()
    return get_dispatch(db, viewer, d.id)


def cancel_dispatch(db: Session, viewer: User, dispatch_id: uuid.UUID, reason: str | None,
                    request: Request | None = None) -> dict:
    """A shipment that never left, or came straight back — stock returns to the
    warehouse it left. Refused once anything on it is invoiced."""
    require(viewer, "can_manage_sales_orders")
    d = get_owned(db, ErpDispatch, viewer.org_id, dispatch_id, "dispatch")
    if d.status != DispatchStatus.DISPATCHED.value:
        raise ErpError("not_cancellable", f"A {d.status} dispatch cannot be cancelled.", 409)
    if any(line.invoiced_qty > 0 for line in d.lines):
        raise ErpError("invoiced", "This dispatch is invoiced — credit the invoice first.", 409)
    if any(line.returned_qty > 0 for line in d.lines):
        raise ErpError("returned", "Goods have already come back against this dispatch.", 409)
    cleaned = require_reason(reason, "dispatch is cancelled")
    so = db.get(ErpSalesOrder, d.sales_order_id)
    order_lines = {line.id: line for line in so.lines}
    for line in d.lines:
        item = db.get(ErpItem, line.item_id)
        if line.serials:
            stock.place_serials(db, viewer, item=item, serials=line.serials, warehouse_id=d.warehouse_id,
                                condition="good", kind=MovementKind.REVERSAL, ref_type="dispatch",
                                ref_id=d.id, ref_number=d.number, expect=(SerialStatus.DELIVERED,))
        stock.move(db, viewer, item=item, warehouse_id=d.warehouse_id, quantity=line.quantity,
                   kind=MovementKind.REVERSAL, ref_type="dispatch", ref_id=d.id, ref_number=d.number,
                   serials=line.serials, reason=cleaned)
        ol = order_lines[line.order_line_id]
        ol.dispatched_qty = max(ZERO, qty(ol.dispatched_qty - line.quantity))
        ol.free_replacement_qty = qty(ol.free_replacement_qty + line.free_qty)
    d.status = DispatchStatus.CANCELLED.value
    d.cancel_reason = cleaned
    if so.status == SalesOrderStatus.DISPATCHED.value:
        so.status = SalesOrderStatus.PARTIALLY_DISPATCHED.value
    _refresh_status(so)
    record_audit(db, viewer, "dispatch.cancelled", d, request=request, detail={"reason": cleaned})
    db.commit()
    return get_dispatch(db, viewer, d.id)


def record_return(db: Session, viewer: User, dispatch_id: uuid.UUID, payload: S.SalesReturnIn,
                  request: Request | None = None) -> dict:
    """Goods back from the customer. Stock comes in, in the condition it arrived.

    With ``replace`` the same quantity opens up on the order to be dispatched
    again. What had been billed is shipped free next time; what had not is
    billed when the replacement is. Without it, the order stays dispatched and
    any money back is a credit note against the invoice."""
    require(viewer, "can_manage_sales_orders")
    d = get_owned(db, ErpDispatch, viewer.org_id, dispatch_id, "dispatch")
    if d.status == DispatchStatus.CANCELLED.value:
        raise ErpError("cancelled", "A cancelled dispatch has nothing to return.", 409)
    wh = stock.active_warehouse(db, viewer.org_id, payload.warehouse_id)
    when = payload.return_date or date.today()
    if when < d.dispatch_date:
        raise ErpError("before_dispatch", "A return cannot be before the dispatch.")
    if when > date.today():
        raise ErpError("future_return", "A return cannot be dated in the future.")
    cleaned = require_reason(payload.reason, "return is recorded")
    so = db.get(ErpSalesOrder, d.sales_order_id)
    order_lines = {line.id: line for line in so.lines}
    by_id = {line.id: line for line in d.lines}
    number = next_number(db, viewer.org_id, "SR", when)
    row = ErpSalesReturn(
        org_id=viewer.org_id, number=number, sales_order_id=so.id, dispatch_id=d.id, warehouse_id=wh.id,
        return_date=when, condition=payload.condition, reason=cleaned, created_by=viewer.id, lines=[],
        replace=payload.replace,
    )
    db.add(row)
    db.flush()
    kept = []
    value = ZERO
    for rl in payload.lines:
        line = by_id.get(rl.dispatch_line_id)
        if line is None:
            raise ErpError("wrong_dispatch", "A line does not belong to this dispatch.")
        quantity = qty(rl.quantity)
        left = line.quantity - line.returned_qty
        if quantity > left:
            raise ErpError("over_return", f"“{line.description}”: only {left.normalize():f} can come back.")
        item = db.get(ErpItem, line.item_id)
        serials = stock.check_serial_count(item, quantity, rl.serials)
        if serials:
            if not set(serials) <= set(line.serials or []):
                raise ErpError("serial_not_dispatched", "A serial was not on this dispatch.")
            stock.place_serials(db, viewer, item=item, serials=serials, warehouse_id=wh.id,
                                condition=payload.condition, kind=MovementKind.RETURN, ref_type="sales_return",
                                ref_id=row.id, ref_number=number, expect=(SerialStatus.DELIVERED,))
        stock.move(db, viewer, item=item, warehouse_id=wh.id, quantity=quantity, kind=MovementKind.RETURN,
                   ref_type="sales_return", ref_id=row.id, ref_number=number, condition=payload.condition,
                   serials=serials, reason=cleaned)
        # Returns come out of the unbilled part first; the rest had been billed.
        unbilled = max(ZERO, line.quantity - line.invoiced_qty - line.free_qty - line.returned_qty)
        billed = max(ZERO, quantity - unbilled)
        line.returned_qty = qty(line.returned_qty + quantity)
        ol = order_lines[line.order_line_id]
        if payload.replace:
            line.replaced_qty = qty(line.replaced_qty + quantity)
            ol.dispatched_qty = max(ZERO, qty(ol.dispatched_qty - quantity))
            ol.free_replacement_qty = qty(ol.free_replacement_qty + billed)
        value += quantity * ol.net_rate
        kept.append({"description": line.description, "quantity": str(quantity), "serials": serials or []})
    row.lines = kept
    row.value = money(value)
    if payload.replace:
        _refresh_status(so)
    record_audit(db, viewer, "dispatch.returned", d, request=request,
                 detail={"number": number, "reason": cleaned, "value": str(row.value), "replace": payload.replace})
    db.commit()
    return get_order(db, viewer, so.id)
