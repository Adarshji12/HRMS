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
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

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
    user_names,
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _readable(viewer: User) -> bool:
    return any(may(viewer, f) for f in (
        "can_manage_sales_orders", "can_approve_sales_orders", "can_manage_inventory",
        "can_manage_billing", "can_manage_procurement",
    ))


def _order_out(db: Session, so: ErpSalesOrder) -> dict:
    from app.models.erp import ErpInvoice
    from app.services import chains

    names = user_names(db, so.org_id, [so.created_by, so.reviewed_by])
    items = {i.id: i for i in db.scalars(select(ErpItem).where(
        ErpItem.id.in_([line.item_id for line in so.lines if line.item_id])))}
    dispatches = list(db.scalars(select(ErpDispatch).where(
        ErpDispatch.sales_order_id == so.id).order_by(ErpDispatch.created_at)))
    invoices = list(db.scalars(select(ErpInvoice).where(
        ErpInvoice.sales_order_id == so.id).order_by(ErpInvoice.created_at)))
    quotation = db.get(CrmQuotation, so.quotation_id) if so.quotation_id else None
    site = db.get(ErpCustomerSite, so.site_id) if so.site_id else None
    steps = chains.steps_for(db, so.id)
    return {
        **row_dict(so),
        "created_by_name": names.get(so.created_by),
        "reviewed_by_name": names.get(so.reviewed_by),
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
             "status": d.status, "value": str(d.value)}
            for d in dispatches
        ],
        "invoices": [
            {"id": str(i.id), "number": i.number, "kind": i.kind, "status": i.status,
             "grand_total": str(i.grand_total), "invoice_date": i.invoice_date.isoformat()}
            for i in invoices
        ],
        "invoiced_total": str(money(sum(
            (i.grand_total for i in invoices if i.status == "posted" and i.kind not in ("proforma", "credit_note")),
            ZERO))),
    }


def list_orders(
    db: Session, viewer: User, *, status: str | None = None, customer_id: uuid.UUID | None = None,
    q: str | None = None,
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
    return _order_out(db, _get(db, viewer, so_id))


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
    for field in ("quotation_id", "site_id", "project_id", "customer_po_number", "customer_po_date",
                  "customer_po_value", "required_by", "deviation_note", "notes"):
        setattr(so, field, getattr(payload, field))
    so.order_date = payload.order_date or date.today()
    so.billing_address = payload.billing_address or account.billing_address
    so.shipping_address = payload.shipping_address or account.shipping_address or so.billing_address
    so.place_of_supply = payload.place_of_supply or account.billing_state
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
        priced = price_line(line.quantity, line.rate, gst)
        so.lines.append(ErpSalesOrderLine(
            org_id=viewer.org_id, item_id=item.id if item else None,
            description=line.description or item.name, hsn_sac=line.hsn_sac or (item.hsn_sac if item else None),
            uom=line.uom or (item.uom if item else "Nos"), gst_percent=gst, fulfilment=fulfilment,
            sort_order=order, **priced,
        ))
        sub += priced["taxable_value"]
        tax += priced["tax_amount"]
    so.sub_total = money(sub)
    so.tax_total = money(tax)
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
    payload = S.SalesOrderIn(
        customer_id=quotation.customer_id, quotation_id=quotation.id, lines=lines,
        billing_address=quotation.billing_address, shipping_address=quotation.shipping_address,
        place_of_supply=quotation.state,
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
        "uninvoiced": any(line.invoiced_qty < line.quantity for line in d.lines),
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
                           f"“{line.description}”: only {(line.quantity - line.dispatched_qty).normalize()} left to dispatch.")
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
        value += quantity * line.rate
        d.lines.append(ErpDispatchLine(
            org_id=viewer.org_id, order_line_id=line.id, item_id=line.item_id,
            description=line.description, quantity=quantity, serials=serials or None,
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
    d.status = DispatchStatus.CANCELLED.value
    d.cancel_reason = cleaned
    if so.status == SalesOrderStatus.DISPATCHED.value:
        so.status = SalesOrderStatus.PARTIALLY_DISPATCHED.value
    _refresh_status(so)
    record_audit(db, viewer, "dispatch.cancelled", d, request=request, detail={"reason": cleaned})
    db.commit()
    return get_dispatch(db, viewer, d.id)
