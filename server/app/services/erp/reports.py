"""The ERP dashboard and the approvals waiting on the viewer.

The dashboard is the PRD's §8 "operational worklists" in figures: what is
waiting, what is late, what is owed. Every figure is a count over the same
tables the module pages list, so a number on the dashboard always matches the
list it links to.
"""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import User
from app.models.erp import (
    DispatchStatus,
    ErpDispatch,
    ErpInvoice,
    ErpItem,
    ErpPurchaseOrder,
    ErpRequisition,
    ErpSalesOrder,
    ErpStockBalance,
    ErpStockDoc,
    ErpVendor,
    PoStatus,
    SalesOrderStatus,
)
from app.services.erp import billing
from app.services.erp.common import ZERO, capabilities, may, money, user_names


def dashboard(db: Session, viewer: User) -> dict:
    org = viewer.org_id
    today = date.today()
    open_po_statuses = [s.value for s in PoStatus if s.is_receivable]

    def count(stmt) -> int:
        return db.scalar(stmt) or 0

    open_pos = list(db.scalars(select(ErpPurchaseOrder).where(
        ErpPurchaseOrder.org_id == org, ErpPurchaseOrder.status.in_(open_po_statuses))))
    overdue_pos = [p for p in open_pos if (p.committed_date or p.expected_date) and
                   (p.committed_date or p.expected_date) < today]
    open_po_value = sum((sum((line.quantity - line.received_qty) * line.rate for line in p.lines) for p in open_pos), ZERO)

    stock_value = db.scalar(select(func.coalesce(func.sum(ErpStockBalance.quantity * ErpStockBalance.avg_cost), 0))
                            .where(ErpStockBalance.org_id == org, ErpStockBalance.quantity > 0)) or 0
    on_hand = dict(db.execute(
        select(ErpStockBalance.item_id, func.sum(ErpStockBalance.quantity - ErpStockBalance.reserved_qty))
        .where(ErpStockBalance.org_id == org, ErpStockBalance.condition == "good")
        .group_by(ErpStockBalance.item_id)).all())
    low = [i for i in db.scalars(select(ErpItem).where(
        ErpItem.org_id == org, ErpItem.is_active.is_(True), ErpItem.item_type == "goods", ErpItem.reorder_level > 0))
        if (on_hand.get(i.id) or 0) <= i.reorder_level]

    open_sos = list(db.scalars(select(ErpSalesOrder).where(
        ErpSalesOrder.org_id == org, ErpSalesOrder.status.in_([
            SalesOrderStatus.APPROVED.value, SalesOrderStatus.PARTIALLY_DISPATCHED.value,
            SalesOrderStatus.ON_HOLD.value]))))
    backlog = sum((sum((line.quantity - line.dispatched_qty) * line.rate for line in so.lines
                       if line.fulfilment != "service") for so in open_sos), ZERO)

    uninvoiced = [d for d in db.scalars(select(ErpDispatch).where(
        ErpDispatch.org_id == org, ErpDispatch.status != DispatchStatus.CANCELLED.value))
        if any(line.invoiced_qty < line.quantity for line in d.lines)]

    invoices = list(db.scalars(select(ErpInvoice).where(
        ErpInvoice.org_id == org, ErpInvoice.status == "posted",
        ErpInvoice.kind.in_(["product", "service", "milestone"]))))
    outstanding = sum((i.outstanding for i in invoices), ZERO)
    overdue = sum((i.outstanding for i in invoices if i.due_date and i.due_date < today), ZERO)
    month_start = today.replace(day=1)
    billed_month = sum((i.grand_total for i in invoices if i.invoice_date >= month_start), ZERO)

    return {
        "capabilities": capabilities(viewer),
        "procurement": {
            "requisitions_pending": count(select(func.count()).select_from(ErpRequisition).where(
                ErpRequisition.org_id == org, ErpRequisition.status == "submitted")),
            "requisitions_to_order": count(select(func.count()).select_from(ErpRequisition).where(
                ErpRequisition.org_id == org, ErpRequisition.status == "approved")),
            "pos_pending": count(select(func.count()).select_from(ErpPurchaseOrder).where(
                ErpPurchaseOrder.org_id == org, ErpPurchaseOrder.status == "submitted")),
            "pos_open": len(open_pos),
            "pos_overdue": len(overdue_pos),
            "open_po_value": str(money(open_po_value)),
            "vendors_pending": count(select(func.count()).select_from(ErpVendor).where(
                ErpVendor.org_id == org, ErpVendor.status == "pending")),
        },
        "inventory": {
            "stock_value": str(money(Decimal(str(stock_value)))),
            "low_stock": len(low),
            "low_stock_items": [{"id": str(i.id), "code": i.code, "name": i.name,
                                 "available": str(on_hand.get(i.id) or 0), "reorder_level": str(i.reorder_level)}
                                for i in low[:8]],
            "transfers_in_transit": count(select(func.count()).select_from(ErpStockDoc).where(
                ErpStockDoc.org_id == org, ErpStockDoc.status == "in_transit")),
            "adjustments_pending": count(select(func.count()).select_from(ErpStockDoc).where(
                ErpStockDoc.org_id == org, ErpStockDoc.status == "submitted")),
        },
        "sales": {
            "orders_pending": count(select(func.count()).select_from(ErpSalesOrder).where(
                ErpSalesOrder.org_id == org, ErpSalesOrder.status == "submitted")),
            "orders_open": len(open_sos),
            "orders_on_hold": sum(1 for so in open_sos if so.status == SalesOrderStatus.ON_HOLD.value),
            "backlog_value": str(money(backlog)),
            "uninvoiced_dispatches": len(uninvoiced),
        },
        "billing": {
            "outstanding": str(money(outstanding)),
            "overdue": str(money(overdue)),
            "billed_this_month": str(money(billed_month)),
            "credit_notes_pending": count(select(func.count()).select_from(ErpInvoice).where(
                ErpInvoice.org_id == org, ErpInvoice.kind == "credit_note", ErpInvoice.status == "submitted")),
            "drafts": count(select(func.count()).select_from(ErpInvoice).where(
                ErpInvoice.org_id == org, ErpInvoice.status == "draft")),
        },
    }


#: Which document each approval flow decides, and how to describe one row.
_FLOWS = (
    ("purchase_requisition", ErpRequisition, "requested_by", "estimated_total", "can_approve_purchases"),
    ("purchase_order", ErpPurchaseOrder, "created_by", "grand_total", "can_approve_purchases"),
    ("stock_adjustment", ErpStockDoc, "created_by", "value", "can_approve_stock"),
    ("sales_order", ErpSalesOrder, "created_by", "grand_total", "can_approve_sales_orders"),
    ("credit_note", ErpInvoice, "created_by", "grand_total", "can_approve_billing"),
)


def pending_approvals(db: Session, viewer: User) -> list[dict]:
    """Every submitted ERP document this viewer could decide now.

    The same rule :func:`common.kernel_decide` enforces, asked in advance: with
    a chain, the viewer must be the rung it is waiting on; without one, they
    must hold the capability. Their own documents are left out — the kernel
    would refuse them, and a queue of things you cannot act on is not a queue.
    """
    from app.services import chains

    out = []
    for kind, model, subject_col, amount_col, capability in _FLOWS:
        rows = list(db.scalars(select(model).where(model.org_id == viewer.org_id, model.status == "submitted")))
        for row in rows:
            if getattr(row, subject_col) == viewer.id:
                continue
            if chains.steps_for(db, row.id):
                step = chains.current_step(db, row.id)
                if step is None or not chains.may_act(db, step, viewer, capability=capability):
                    continue
                level = f"Level {step.level}"
            elif may(viewer, capability):
                level = None
            else:
                continue
            title = (getattr(row, "title", None) or getattr(row, "customer_name", None)
                     or getattr(row, "reason", None) or kind.replace("_", " "))
            if kind == "purchase_order":
                vendor = db.get(ErpVendor, row.vendor_id)
                title = vendor.legal_name if vendor else title
            if kind == "stock_adjustment":
                title = f"Stock adjustment — {row.reason}"
            out.append({
                "kind": kind, "id": str(row.id), "number": row.number,
                "title": title, "amount": str(getattr(row, amount_col)),
                "subject_id": str(getattr(row, subject_col)),
                "submitted_at": row.submitted_at.isoformat() if row.submitted_at else None,
                "level": level,
            })
    names = user_names(db, viewer.org_id, [uuid.UUID(r["subject_id"]) for r in out])
    for r in out:
        r["subject_name"] = names.get(uuid.UUID(r["subject_id"]))
    return sorted(out, key=lambda r: r["submitted_at"] or "")


def ageing(db: Session, viewer: User) -> dict:
    return billing.ageing(db, viewer)
