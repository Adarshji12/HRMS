"""The ERP dashboard and the approvals waiting on the viewer.

The dashboard is the PRD's §8 "operational worklists" in figures: what is
waiting, what is late, what is owed. Every figure is a count over the same
tables the module pages list, so a number on the dashboard always matches the
list it links to.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import User
from app.models.erp import (
    DispatchStatus,
    ErpDispatch,
    ErpInvoice,
    ErpInvoiceLine,
    ErpItem,
    ErpPurchaseOrder,
    ErpReceipt,
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
    from app.services.erp.sales import billed_by_milestones

    org = viewer.org_id
    today = date.today()
    open_po_statuses = [s.value for s in PoStatus if s.is_receivable]

    def count(stmt) -> int:
        return db.scalar(stmt) or 0

    open_pos = list(db.scalars(select(ErpPurchaseOrder).where(
        ErpPurchaseOrder.org_id == org, ErpPurchaseOrder.status.in_(open_po_statuses))))
    overdue_pos = [p for p in open_pos if (p.committed_date or p.expected_date) and
                   (p.committed_date or p.expected_date) < today]
    open_po_value = sum((sum((line.quantity - line.received_qty) * line.net_rate for line in p.lines) for p in open_pos), ZERO)

    stock_value = db.scalar(select(func.coalesce(func.sum(ErpStockBalance.quantity * ErpStockBalance.avg_cost), 0))
                            .where(ErpStockBalance.org_id == org, ErpStockBalance.quantity > 0)) or 0
    on_hand = dict(db.execute(
        select(ErpStockBalance.item_id, func.sum(ErpStockBalance.quantity - ErpStockBalance.reserved_qty))
        .where(ErpStockBalance.org_id == org, ErpStockBalance.condition == "good")
        .group_by(ErpStockBalance.item_id)).all())
    low = [i for i in db.scalars(select(ErpItem).where(
        ErpItem.org_id == org, ErpItem.is_active.is_(True), ErpItem.item_type == "goods",
        ErpItem.track_inventory.is_(True), ErpItem.reorder_level > 0))
        if (on_hand.get(i.id) or 0) <= i.reorder_level]

    open_sos = list(db.scalars(select(ErpSalesOrder).where(
        ErpSalesOrder.org_id == org, ErpSalesOrder.status.in_([
            SalesOrderStatus.APPROVED.value, SalesOrderStatus.PARTIALLY_DISPATCHED.value,
            SalesOrderStatus.ON_HOLD.value]))))
    backlog = sum((sum((line.quantity - line.dispatched_qty) * line.net_rate for line in so.lines
                       if line.fulfilment != "service") for so in open_sos), ZERO)

    uninvoiced = [d for d in db.scalars(select(ErpDispatch).where(
        ErpDispatch.org_id == org, ErpDispatch.status != DispatchStatus.CANCELLED.value))
        if any(line.billable_qty > 0 for line in d.lines)
        and not billed_by_milestones(db.get(ErpSalesOrder, d.sales_order_id))]

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
        "analytics": _analytics(db, org, today, invoices),
    }


#: Purchase orders that commit money: approved onwards, never cancelled.
_COMMITTED_PO = [PoStatus.APPROVED.value, PoStatus.ACKNOWLEDGED.value, PoStatus.PARTIALLY_RECEIVED.value,
                 PoStatus.RECEIVED.value, PoStatus.CLOSED.value]


def _month_start(day: date, back: int = 0) -> date:
    """The first of the month ``back`` months before ``day``'s month."""
    index = day.year * 12 + day.month - 1 - back
    return date(index // 12, index % 12 + 1, 1)


def _analytics(db: Session, org: uuid.UUID, today: date, invoices: list[ErpInvoice]) -> dict:
    """The trend side of the dashboard: six months of sales, purchases and
    collections, this month against last, receivables by age, and the
    customers, items and documents behind the figures.

    Sales are posted invoices by invoice date, purchases are committed POs by
    order date, collections are posted receipts by receipt date — the same
    rows the billing and purchase pages list.
    """
    months = [_month_start(today, back) for back in range(5, -1, -1)]
    first = months[0]

    def key(day: date) -> tuple[int, int]:
        return day.year, day.month

    sales: dict = defaultdict(lambda: ZERO)
    for inv in invoices:
        if inv.invoice_date >= first:
            sales[key(inv.invoice_date)] += inv.grand_total

    purchases: dict = defaultdict(lambda: ZERO)
    for po in db.scalars(select(ErpPurchaseOrder).where(
            ErpPurchaseOrder.org_id == org, ErpPurchaseOrder.status.in_(_COMMITTED_PO),
            ErpPurchaseOrder.order_date >= first)):
        purchases[key(po.order_date)] += po.grand_total

    collections: dict = defaultdict(lambda: ZERO)
    for day, amount, tds in db.execute(select(ErpReceipt.received_on, ErpReceipt.amount, ErpReceipt.tds_amount).where(
            ErpReceipt.org_id == org, ErpReceipt.status == "posted", ErpReceipt.received_on >= first)):
        collections[key(day)] += amount + tds

    trend = [{
        "month": m.isoformat()[:7], "label": m.strftime("%b"),
        "sales": str(money(sales[key(m)])), "purchases": str(money(purchases[key(m)])),
        "collections": str(money(collections[key(m)])),
    } for m in months]
    this, last = key(months[-1]), key(months[-2])

    # Indian financial year: April to March.
    fy_start = date(today.year if today.month >= 4 else today.year - 1, 4, 1)
    sales_fy = sum((i.grand_total for i in invoices if i.invoice_date >= fy_start), ZERO)

    # Days sales outstanding, over the last 90 days of billing.
    billed_90 = sum((i.grand_total for i in invoices if i.invoice_date >= today - timedelta(days=90)), ZERO)
    outstanding = sum((i.outstanding for i in invoices), ZERO)
    dso = round(float(outstanding / billed_90 * 90)) if billed_90 > 0 else None

    buckets = ["current", "1-30", "31-60", "61-90", "90+"]
    ageing = {label: ZERO for label in buckets}
    for inv in invoices:
        if inv.outstanding > 0:
            ageing[billing._bucket((today - inv.due_date).days if inv.due_date else 0)] += inv.outstanding

    year_ago = today - timedelta(days=365)
    by_customer: dict = defaultdict(lambda: {"name": "", "total": ZERO, "invoices": 0})
    for inv in invoices:
        if inv.invoice_date >= year_ago:
            row = by_customer[inv.customer_id]
            row["name"] = inv.customer_name
            row["total"] += inv.grand_total
            row["invoices"] += 1
    top_customers = sorted(by_customer.values(), key=lambda r: r["total"], reverse=True)[:5]

    year_ids = [i.id for i in invoices if i.invoice_date >= year_ago]
    top_items = []
    if year_ids:
        name = func.coalesce(ErpItem.name, ErpInvoiceLine.description)
        top_items = [{"name": n, "quantity": str(qty), "total": str(money(Decimal(str(total))))}
                     for n, qty, total in db.execute(
                         select(name, func.sum(ErpInvoiceLine.quantity), func.sum(ErpInvoiceLine.amount))
                         .outerjoin(ErpItem, ErpItem.id == ErpInvoiceLine.item_id)
                         .where(ErpInvoiceLine.invoice_id.in_(year_ids))
                         .group_by(name).order_by(func.sum(ErpInvoiceLine.amount).desc()).limit(5))]

    order_status = dict(db.execute(select(ErpSalesOrder.status, func.count()).where(
        ErpSalesOrder.org_id == org).group_by(ErpSalesOrder.status)).all())

    recent: list[dict] = []
    for inv in db.scalars(select(ErpInvoice).where(ErpInvoice.org_id == org)
                          .order_by(ErpInvoice.created_at.desc()).limit(8)):
        recent.append({"kind": "credit_note" if inv.kind == "credit_note" else "invoice", "id": str(inv.id),
                       "number": inv.number, "party": inv.customer_name, "date": inv.invoice_date.isoformat(),
                       "amount": str(inv.grand_total), "status": inv.status, "at": inv.created_at})
    for so in db.scalars(select(ErpSalesOrder).where(ErpSalesOrder.org_id == org)
                         .order_by(ErpSalesOrder.created_at.desc()).limit(8)):
        recent.append({"kind": "sales_order", "id": str(so.id), "number": so.number, "party": so.customer_name,
                       "date": so.order_date.isoformat(), "amount": str(so.grand_total), "status": so.status,
                       "at": so.created_at})
    recent_pos = list(db.scalars(select(ErpPurchaseOrder).where(ErpPurchaseOrder.org_id == org)
                                 .order_by(ErpPurchaseOrder.created_at.desc()).limit(8)))
    vendors = dict(db.execute(select(ErpVendor.id, ErpVendor.legal_name).where(
        ErpVendor.id.in_([p.vendor_id for p in recent_pos]))).all()) if recent_pos else {}
    for po in recent_pos:
        recent.append({"kind": "purchase_order", "id": str(po.id), "number": po.number,
                       "party": vendors.get(po.vendor_id), "date": po.order_date.isoformat(),
                       "amount": str(po.grand_total), "status": po.status, "at": po.created_at})
    recent.sort(key=lambda r: r["at"], reverse=True)
    for r in recent:
        del r["at"]

    return {
        "trend": trend,
        "kpis": {
            "sales_month": str(money(sales[this])), "sales_last_month": str(money(sales[last])),
            "purchases_month": str(money(purchases[this])), "purchases_last_month": str(money(purchases[last])),
            "collections_month": str(money(collections[this])),
            "collections_last_month": str(money(collections[last])),
            "sales_fy": str(money(sales_fy)),
            "dso_days": dso,
        },
        "ageing": [{"bucket": label, "amount": str(money(ageing[label]))} for label in buckets],
        "top_customers": [{"name": r["name"], "total": str(money(r["total"])), "invoices": r["invoices"]}
                          for r in top_customers],
        "top_items": top_items,
        "order_status": order_status,
        "recent": recent[:8],
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
    must hold the capability. Documents the flow will not let them decide as
    their own are left out — the kernel would refuse them, and a queue of things
    you cannot act on is not a queue.
    """
    from app.services import chains, workflow

    out = []
    for kind, model, subject_col, amount_col, capability in _FLOWS:
        rows = list(db.scalars(select(model).where(model.org_id == viewer.org_id, model.status == "submitted")))
        for row in rows:
            try:
                workflow.ensure_not_self(workflow.POLICIES[kind], row, viewer)
            except workflow.WorkflowError:
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


def approval_register(db: Session, viewer: User) -> list[dict]:
    """The ERP Approvals screen: every document that has been through approval,
    pending and decided, newest first.

    A viewer sees a flow's documents if they hold its capability, and otherwise
    only those they raised, decided, or are the current chain rung for.
    ``can_decide`` is the same answer :func:`pending_approvals` gives.
    """
    from app.services import chains

    queue = {(r["kind"], r["id"]): r for r in pending_approvals(db, viewer)}
    out = []
    for kind, model, subject_col, amount_col, capability in _FLOWS:
        stmt = select(model).where(model.org_id == viewer.org_id, model.submitted_at.is_not(None))
        if kind == "credit_note":
            stmt = stmt.where(model.kind == "credit_note")
        for row in db.scalars(stmt.order_by(model.submitted_at.desc()).limit(500)):
            if row.status == "submitted":
                state = "pending"
            elif row.status == "rejected":
                state = "rejected"
            elif row.reviewed_at is not None:
                state = "approved"
            else:
                continue  # back in draft, or cancelled before anybody decided
            subject = getattr(row, subject_col)
            pending = queue.get((kind, str(row.id)))
            if not (pending or may(viewer, capability) or viewer.id in (subject, row.reviewed_by)
                    or chains.is_current_reviewer(db, row.id, viewer)):
                continue
            title = getattr(row, "title", None) or getattr(row, "customer_name", None) or getattr(row, "reason", None) or kind.replace("_", " ")
            if kind == "purchase_order":
                vendor = db.get(ErpVendor, row.vendor_id)
                title = vendor.legal_name if vendor else title
            if kind == "stock_adjustment":
                title = f"Stock adjustment — {row.reason}"
            out.append({
                "kind": kind, "id": str(row.id), "number": row.number, "title": title,
                "amount": str(getattr(row, amount_col)), "subject_id": str(subject),
                "submitted_at": row.submitted_at.isoformat(), "state": state, "doc_status": row.status,
                "can_decide": pending is not None, "own": subject == viewer.id,
                "level": pending["level"] if pending else None,
                "reviewed_by": str(row.reviewed_by) if row.reviewed_by else None,
                "reviewed_at": row.reviewed_at.isoformat() if row.reviewed_at else None,
                "review_note": row.review_note,
            })
    names = user_names(db, viewer.org_id, [uuid.UUID(r["subject_id"]) for r in out]
                       + [uuid.UUID(r["reviewed_by"]) for r in out if r["reviewed_by"]])
    for r in out:
        r["subject_name"] = names.get(uuid.UUID(r["subject_id"]))
        r["reviewed_by_name"] = names.get(uuid.UUID(r["reviewed_by"])) if r["reviewed_by"] else None
    return sorted(out, key=lambda r: r["submitted_at"], reverse=True)


def ageing(db: Session, viewer: User) -> dict:
    return billing.ageing(db, viewer)
