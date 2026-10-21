"""ERP HTTP surface. Thin: every handler hands off to ``app.services.erp``.

Permission is decided in the services, through ``services.erp.common.may``,
not by a dependency here — the rule is not "administrators only" but ten
capabilities with segregation of duties between them, and a router-level gate
could only ever express the first.

Items and warehouses are readable by every signed-in member of the workspace:
anybody may raise a requisition, and a requester with an empty item dropdown
cannot. Everything else checks a capability.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Query, Request, Response, status

from app.api.deps import CurrentUser, DbSession
from app.schemas import erp as S
from app.services.erp import billing, masters, purchase, reports, sales, stock
from app.services.erp.common import capabilities, get_settings, record_audit, require, row_dict

router = APIRouter(prefix="/erp", tags=["erp"])


# --------------------------------------------------------------------------- #
# Access, dashboard, settings
# --------------------------------------------------------------------------- #


@router.get("/access")
def access(viewer: CurrentUser) -> dict:
    """What this person may do in the ERP — the console hides what they may not."""
    return capabilities(viewer)


@router.get("/dashboard")
def dashboard(viewer: CurrentUser, db: DbSession) -> dict:
    return reports.dashboard(db, viewer)


@router.get("/approvals")
def approvals(viewer: CurrentUser, db: DbSession) -> list[dict]:
    return reports.pending_approvals(db, viewer)


@router.get("/settings")
def read_settings(viewer: CurrentUser, db: DbSession) -> dict:
    row = get_settings(db, viewer.org_id)
    db.commit()
    return row_dict(row)


@router.put("/settings")
def write_settings(payload: S.SettingsIn, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    if not viewer.role_enum.can_administer:
        from app.services.erp.common import ErpError

        raise ErpError("permission_denied", "Only an administrator changes ERP settings.", 403)
    row = get_settings(db, viewer.org_id)
    for field, value in payload.model_dump().items():
        setattr(row, field, value)
    record_audit(db, viewer, "settings.saved", row, request=request, detail=payload.model_dump(mode="json"))
    db.commit()
    return row_dict(row)


# --------------------------------------------------------------------------- #
# Masters
# --------------------------------------------------------------------------- #


@router.get("/warehouses")
def list_warehouses(viewer: CurrentUser, db: DbSession, active_only: bool = False) -> list[dict]:
    return masters.list_warehouses(db, viewer, active_only=active_only)


@router.post("/warehouses", status_code=status.HTTP_201_CREATED)
def create_warehouse(payload: S.WarehouseIn, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return masters.save_warehouse(db, viewer, payload, request=request)


@router.put("/warehouses/{row_id}")
def update_warehouse(row_id: uuid.UUID, payload: S.WarehouseIn, viewer: CurrentUser, db: DbSession,
                     request: Request) -> dict:
    return masters.save_warehouse(db, viewer, payload, row_id, request=request)


@router.get("/items")
def list_items(viewer: CurrentUser, db: DbSession, q: str | None = None, active_only: bool = False,
               item_type: str | None = None) -> list[dict]:
    return masters.list_items(db, viewer, q=q, active_only=active_only, item_type=item_type)


@router.post("/items", status_code=status.HTTP_201_CREATED)
def create_item(payload: S.ItemIn, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return masters.save_item(db, viewer, payload, request=request)


@router.put("/items/{row_id}")
def update_item(row_id: uuid.UUID, payload: S.ItemIn, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return masters.save_item(db, viewer, payload, row_id, request=request)


@router.get("/vendors")
def list_vendors(viewer: CurrentUser, db: DbSession, q: str | None = None, status: str | None = None) -> list[dict]:
    return masters.list_vendors(db, viewer, q=q, status=status)


@router.get("/vendors/{vendor_id}")
def get_vendor(vendor_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> dict:
    return masters.get_vendor(db, viewer, vendor_id)


@router.post("/vendors", status_code=status.HTTP_201_CREATED)
def create_vendor(payload: S.VendorIn, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return masters.save_vendor(db, viewer, payload, request=request)


@router.put("/vendors/{vendor_id}")
def update_vendor(vendor_id: uuid.UUID, payload: S.VendorIn, viewer: CurrentUser, db: DbSession,
                  request: Request) -> dict:
    return masters.save_vendor(db, viewer, payload, vendor_id, request=request)


@router.post("/vendors/{vendor_id}/submit")
def submit_vendor(vendor_id: uuid.UUID, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return masters.submit_vendor(db, viewer, vendor_id, request=request)


@router.post("/vendors/{vendor_id}/decide")
def decide_vendor(vendor_id: uuid.UUID, payload: S.DecisionIn, viewer: CurrentUser, db: DbSession,
                  request: Request) -> dict:
    return masters.decide_vendor(db, viewer, vendor_id, payload, request=request)


@router.post("/vendors/{vendor_id}/status")
def vendor_status(vendor_id: uuid.UUID, payload: S.VendorStatusIn, viewer: CurrentUser, db: DbSession,
                  request: Request) -> dict:
    return masters.set_vendor_status(db, viewer, vendor_id, payload, request=request)


@router.post("/vendors/{vendor_id}/banks", status_code=status.HTTP_201_CREATED)
def add_bank(vendor_id: uuid.UUID, payload: S.VendorBankIn, viewer: CurrentUser, db: DbSession,
             request: Request) -> dict:
    return masters.add_vendor_bank(db, viewer, vendor_id, payload, request=request)


@router.post("/vendors/{vendor_id}/banks/{bank_id}/verify")
def verify_bank(vendor_id: uuid.UUID, bank_id: uuid.UUID, payload: S.DecisionIn, viewer: CurrentUser,
                db: DbSession, request: Request) -> dict:
    return masters.verify_vendor_bank(db, viewer, vendor_id, bank_id, payload, request=request)


@router.get("/customers")
def list_customers(viewer: CurrentUser, db: DbSession, q: str | None = None) -> list[dict]:
    return masters.list_customer_accounts(db, viewer, q=q)


@router.get("/customers/{customer_id}")
def get_customer(customer_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> dict:
    return masters.get_customer_account(db, viewer, customer_id)


@router.put("/customers/{customer_id}")
def save_customer(customer_id: uuid.UUID, payload: S.CustomerAccountIn, viewer: CurrentUser, db: DbSession,
                  request: Request) -> dict:
    return masters.save_customer_account(db, viewer, customer_id, payload, request=request)


@router.post("/customers/{customer_id}/hold")
def customer_hold(customer_id: uuid.UUID, payload: S.CreditHoldIn, viewer: CurrentUser, db: DbSession,
                  request: Request) -> dict:
    return masters.set_credit_hold(db, viewer, customer_id, payload, request=request)


@router.post("/customers/{customer_id}/sites", status_code=status.HTTP_201_CREATED)
def add_site(customer_id: uuid.UUID, payload: S.CustomerSiteIn, viewer: CurrentUser, db: DbSession,
             request: Request) -> dict:
    return masters.add_site(db, viewer, customer_id, payload, request=request)


@router.put("/customers/{customer_id}/sites/{site_id}")
def update_site(customer_id: uuid.UUID, site_id: uuid.UUID, payload: S.CustomerSiteIn, viewer: CurrentUser,
                db: DbSession, request: Request) -> dict:
    return masters.add_site(db, viewer, customer_id, payload, site_id, request=request)


# --------------------------------------------------------------------------- #
# Requisitions
# --------------------------------------------------------------------------- #


@router.get("/requisitions")
def list_requisitions(viewer: CurrentUser, db: DbSession, status: str | None = None, mine: bool = False) -> list[dict]:
    return purchase.list_requisitions(db, viewer, status=status, mine=mine)


@router.get("/requisitions/{req_id}")
def get_requisition(req_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> dict:
    return purchase.get_requisition(db, viewer, req_id)


@router.post("/requisitions", status_code=status.HTTP_201_CREATED)
def create_requisition(payload: S.RequisitionIn, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return purchase.save_requisition(db, viewer, payload, request=request)


@router.put("/requisitions/{req_id}")
def update_requisition(req_id: uuid.UUID, payload: S.RequisitionIn, viewer: CurrentUser, db: DbSession,
                       request: Request) -> dict:
    return purchase.save_requisition(db, viewer, payload, req_id, request=request)


@router.post("/requisitions/{req_id}/submit")
def submit_requisition(req_id: uuid.UUID, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return purchase.submit_requisition(db, viewer, req_id, request=request)


@router.post("/requisitions/{req_id}/decide")
def decide_requisition(req_id: uuid.UUID, payload: S.DecisionIn, viewer: CurrentUser, db: DbSession,
                       request: Request) -> dict:
    return purchase.decide_requisition(db, viewer, req_id, payload, request=request)


@router.post("/requisitions/{req_id}/revise")
def revise_requisition(req_id: uuid.UUID, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return purchase.revise_requisition(db, viewer, req_id, request=request)


@router.post("/requisitions/{req_id}/cancel")
def cancel_requisition(req_id: uuid.UUID, payload: S.ReasonIn, viewer: CurrentUser, db: DbSession,
                       request: Request) -> dict:
    return purchase.cancel_requisition(db, viewer, req_id, payload.reason, request=request)


@router.post("/requisitions/{req_id}/purchase-order", status_code=status.HTTP_201_CREATED)
def requisition_to_po(req_id: uuid.UUID, viewer: CurrentUser, db: DbSession, request: Request,
                      vendor_id: uuid.UUID = Query()) -> dict:
    return purchase.po_from_requisition(db, viewer, req_id, vendor_id, request=request)


# --------------------------------------------------------------------------- #
# RFQs
# --------------------------------------------------------------------------- #


@router.get("/rfqs")
def list_rfqs(viewer: CurrentUser, db: DbSession) -> list[dict]:
    return purchase.list_rfqs(db, viewer)


@router.get("/rfqs/{rfq_id}")
def get_rfq(rfq_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> dict:
    return purchase.get_rfq(db, viewer, rfq_id)


@router.post("/rfqs", status_code=status.HTTP_201_CREATED)
def create_rfq(payload: S.RfqIn, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return purchase.create_rfq(db, viewer, payload, request=request)


@router.post("/rfqs/{rfq_id}/issue")
def issue_rfq(rfq_id: uuid.UUID, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return purchase.issue_rfq(db, viewer, rfq_id, request=request)


@router.post("/rfqs/{rfq_id}/quotes", status_code=status.HTTP_201_CREATED)
def add_quote(rfq_id: uuid.UUID, payload: S.VendorQuoteIn, viewer: CurrentUser, db: DbSession,
              request: Request) -> dict:
    return purchase.add_quote(db, viewer, rfq_id, payload, request=request)


@router.get("/rfqs/{rfq_id}/comparison")
def rfq_comparison(rfq_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> dict:
    return purchase.comparison(db, viewer, rfq_id)


@router.post("/rfqs/{rfq_id}/award")
def award_rfq(rfq_id: uuid.UUID, payload: S.AwardIn, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return purchase.award(db, viewer, rfq_id, payload, request=request)


@router.post("/rfqs/{rfq_id}/cancel")
def cancel_rfq(rfq_id: uuid.UUID, payload: S.ReasonIn, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return purchase.cancel_rfq(db, viewer, rfq_id, payload.reason, request=request)


@router.post("/rfqs/{rfq_id}/purchase-order", status_code=status.HTTP_201_CREATED)
def rfq_to_po(rfq_id: uuid.UUID, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return purchase.po_from_quote(db, viewer, rfq_id, request=request)


# --------------------------------------------------------------------------- #
# Purchase orders
# --------------------------------------------------------------------------- #


@router.get("/purchase-orders")
def list_pos(viewer: CurrentUser, db: DbSession, status: str | None = None, vendor_id: uuid.UUID | None = None,
             q: str | None = None) -> list[dict]:
    return purchase.list_purchase_orders(db, viewer, status=status, vendor_id=vendor_id, q=q)


@router.get("/purchase-orders/{po_id}")
def get_po(po_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> dict:
    return purchase.get_purchase_order(db, viewer, po_id)


@router.post("/purchase-orders", status_code=status.HTTP_201_CREATED)
def create_po(payload: S.PurchaseOrderIn, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return purchase.save_purchase_order(db, viewer, payload, request=request)


@router.put("/purchase-orders/{po_id}")
def update_po(po_id: uuid.UUID, payload: S.PurchaseOrderIn, viewer: CurrentUser, db: DbSession,
              request: Request) -> dict:
    return purchase.save_purchase_order(db, viewer, payload, po_id, request=request)


@router.post("/purchase-orders/{po_id}/submit")
def submit_po(po_id: uuid.UUID, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return purchase.submit_purchase_order(db, viewer, po_id, request=request)


@router.post("/purchase-orders/{po_id}/decide")
def decide_po(po_id: uuid.UUID, payload: S.DecisionIn, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return purchase.decide_purchase_order(db, viewer, po_id, payload, request=request)


@router.post("/purchase-orders/{po_id}/acknowledge")
def acknowledge_po(po_id: uuid.UUID, payload: S.AcknowledgeIn, viewer: CurrentUser, db: DbSession,
                   request: Request) -> dict:
    return purchase.acknowledge(db, viewer, po_id, payload, request=request)


@router.post("/purchase-orders/{po_id}/amend")
def amend_po(po_id: uuid.UUID, payload: S.ReasonIn, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return purchase.amend(db, viewer, po_id, payload.reason, request=request)


@router.post("/purchase-orders/{po_id}/cancel")
def cancel_po(po_id: uuid.UUID, payload: S.ReasonIn, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return purchase.cancel_purchase_order(db, viewer, po_id, payload.reason, request=request)


@router.post("/purchase-orders/{po_id}/short-close")
def short_close_po(po_id: uuid.UUID, payload: S.ReasonIn, viewer: CurrentUser, db: DbSession,
                   request: Request) -> dict:
    return purchase.short_close(db, viewer, po_id, payload.reason, request=request)


@router.post("/purchase-orders/{po_id}/waive-ld")
def waive_ld(po_id: uuid.UUID, payload: S.ReasonIn, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return purchase.waive_ld(db, viewer, po_id, payload.reason, request=request)


# --------------------------------------------------------------------------- #
# Goods receipts
# --------------------------------------------------------------------------- #


@router.get("/goods-receipts")
def list_grns(viewer: CurrentUser, db: DbSession, po_id: uuid.UUID | None = None) -> list[dict]:
    return purchase.list_receipts(db, viewer, po_id=po_id)


@router.get("/goods-receipts/{grn_id}")
def get_grn(grn_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> dict:
    return purchase.get_receipt(db, viewer, grn_id)


@router.post("/goods-receipts", status_code=status.HTTP_201_CREATED)
def post_grn(payload: S.GoodsReceiptIn, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return purchase.post_receipt(db, viewer, payload, request=request)


@router.post("/goods-receipts/{grn_id}/reverse")
def reverse_grn(grn_id: uuid.UUID, payload: S.ReasonIn, viewer: CurrentUser, db: DbSession,
                request: Request) -> dict:
    return purchase.reverse_receipt(db, viewer, grn_id, payload.reason, request=request)


# --------------------------------------------------------------------------- #
# Stock
# --------------------------------------------------------------------------- #


def _stock_reader(viewer) -> None:
    from app.services.erp.common import may

    if not any(may(viewer, f) for f in ("can_manage_inventory", "can_approve_stock", "can_manage_procurement",
                                         "can_manage_sales_orders")):
        require(viewer, "can_manage_inventory")


@router.get("/stock")
def list_stock(viewer: CurrentUser, db: DbSession, item_id: uuid.UUID | None = None,
               warehouse_id: uuid.UUID | None = None, condition: str | None = None) -> list[dict]:
    _stock_reader(viewer)
    return stock.list_balances(db, viewer, item_id=item_id, warehouse_id=warehouse_id, condition=condition)


@router.get("/stock/movements")
def list_movements(viewer: CurrentUser, db: DbSession, item_id: uuid.UUID | None = None,
                   warehouse_id: uuid.UUID | None = None, ref_id: uuid.UUID | None = None) -> list[dict]:
    _stock_reader(viewer)
    return stock.list_movements(db, viewer, item_id=item_id, warehouse_id=warehouse_id, ref_id=ref_id)


@router.get("/stock/serials")
def search_serials(viewer: CurrentUser, db: DbSession, q: str = Query(min_length=2)) -> list[dict]:
    _stock_reader(viewer)
    return stock.find_serial(db, viewer, q)


@router.get("/stock/serials/available")
def available_serials(viewer: CurrentUser, db: DbSession, item_id: uuid.UUID, warehouse_id: uuid.UUID,
                      condition: str = "good") -> list[str]:
    _stock_reader(viewer)
    return stock.serials_in(db, viewer, item_id, warehouse_id, condition)


@router.get("/stock-docs")
def list_stock_docs(viewer: CurrentUser, db: DbSession, kind: str | None = None, status: str | None = None) -> list[dict]:
    _stock_reader(viewer)
    return stock.list_docs(db, viewer, kind=kind, status=status)


@router.get("/stock-docs/{doc_id}")
def get_stock_doc(doc_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> dict:
    _stock_reader(viewer)
    return stock.get_doc(db, viewer, doc_id)


@router.post("/stock-docs", status_code=status.HTTP_201_CREATED)
def create_stock_doc(payload: S.StockDocIn, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return stock.save_doc(db, viewer, payload, request=request)


@router.put("/stock-docs/{doc_id}")
def update_stock_doc(doc_id: uuid.UUID, payload: S.StockDocIn, viewer: CurrentUser, db: DbSession,
                     request: Request) -> dict:
    return stock.save_doc(db, viewer, payload, doc_id, request=request)


@router.post("/stock-docs/{doc_id}/post")
def post_stock_doc(doc_id: uuid.UUID, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return stock.post_doc(db, viewer, doc_id, request=request)


@router.post("/stock-docs/{doc_id}/receive")
def receive_stock_doc(doc_id: uuid.UUID, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return stock.receive_transfer(db, viewer, doc_id, request=request)


@router.post("/stock-docs/{doc_id}/submit")
def submit_stock_doc(doc_id: uuid.UUID, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return stock.submit_adjustment(db, viewer, doc_id, request=request)


@router.post("/stock-docs/{doc_id}/decide")
def decide_stock_doc(doc_id: uuid.UUID, payload: S.DecisionIn, viewer: CurrentUser, db: DbSession,
                     request: Request) -> dict:
    return stock.decide_adjustment(db, viewer, doc_id, payload, request=request)


@router.post("/stock-docs/{doc_id}/cancel")
def cancel_stock_doc(doc_id: uuid.UUID, payload: S.ReasonIn, viewer: CurrentUser, db: DbSession,
                     request: Request) -> dict:
    return stock.cancel_doc(db, viewer, doc_id, payload.reason, request=request)


# --------------------------------------------------------------------------- #
# Sales orders and dispatch
# --------------------------------------------------------------------------- #


@router.get("/sales-orders")
def list_sales_orders(viewer: CurrentUser, db: DbSession, status: str | None = None,
                      customer_id: uuid.UUID | None = None, q: str | None = None) -> list[dict]:
    return sales.list_orders(db, viewer, status=status, customer_id=customer_id, q=q)


@router.get("/sales-orders/{so_id}")
def get_sales_order(so_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> dict:
    return sales.get_order(db, viewer, so_id)


@router.post("/sales-orders", status_code=status.HTTP_201_CREATED)
def create_sales_order(payload: S.SalesOrderIn, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return sales.save_order(db, viewer, payload, request=request)


@router.post("/sales-orders/from-quotation", status_code=status.HTTP_201_CREATED)
def sales_order_from_quotation(payload: S.FromQuotationIn, viewer: CurrentUser, db: DbSession,
                               request: Request) -> dict:
    return sales.from_quotation(db, viewer, payload.quotation_id, request=request)


@router.put("/sales-orders/{so_id}")
def update_sales_order(so_id: uuid.UUID, payload: S.SalesOrderIn, viewer: CurrentUser, db: DbSession,
                       request: Request) -> dict:
    return sales.save_order(db, viewer, payload, so_id, request=request)


@router.post("/sales-orders/{so_id}/submit")
def submit_sales_order(so_id: uuid.UUID, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return sales.submit_order(db, viewer, so_id, request=request)


@router.post("/sales-orders/{so_id}/decide")
def decide_sales_order(so_id: uuid.UUID, payload: S.DecisionIn, viewer: CurrentUser, db: DbSession,
                       request: Request) -> dict:
    return sales.decide_order(db, viewer, so_id, payload, request=request)


@router.post("/sales-orders/{so_id}/revise")
def revise_sales_order(so_id: uuid.UUID, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return sales.revise_order(db, viewer, so_id, request=request)


@router.post("/sales-orders/{so_id}/hold")
def hold_sales_order(so_id: uuid.UUID, payload: S.HoldIn, viewer: CurrentUser, db: DbSession,
                     request: Request) -> dict:
    return sales.set_hold(db, viewer, so_id, payload, request=request)


@router.post("/sales-orders/{so_id}/reserve")
def reserve_sales_order(so_id: uuid.UUID, payload: S.ReserveIn, viewer: CurrentUser, db: DbSession,
                        request: Request) -> dict:
    return sales.reserve(db, viewer, so_id, payload, request=request)


@router.post("/sales-orders/{so_id}/unreserve")
def unreserve_sales_order(so_id: uuid.UUID, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return sales.unreserve(db, viewer, so_id, request=request)


@router.post("/sales-orders/{so_id}/shortage-requisition", status_code=status.HTTP_201_CREATED)
def shortage_requisition(so_id: uuid.UUID, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return sales.raise_shortage_requisition(db, viewer, so_id, request=request)


@router.post("/sales-orders/{so_id}/cancel")
def cancel_sales_order(so_id: uuid.UUID, payload: S.ReasonIn, viewer: CurrentUser, db: DbSession,
                       request: Request) -> dict:
    return sales.cancel_order(db, viewer, so_id, payload.reason, request=request)


@router.post("/sales-orders/{so_id}/close")
def close_sales_order(so_id: uuid.UUID, payload: S.ReasonIn, viewer: CurrentUser, db: DbSession,
                      request: Request) -> dict:
    return sales.short_close(db, viewer, so_id, payload.reason, request=request)


@router.post("/milestones/{milestone_id}/ready")
def milestone_ready(milestone_id: uuid.UUID, payload: S.MilestoneReadyIn, viewer: CurrentUser, db: DbSession,
                    request: Request) -> dict:
    return sales.mark_milestone_ready(db, viewer, milestone_id, payload, request=request)


@router.get("/dispatches")
def list_dispatches(viewer: CurrentUser, db: DbSession, status: str | None = None,
                    uninvoiced: bool = False) -> list[dict]:
    return sales.list_dispatches(db, viewer, status=status, uninvoiced=uninvoiced)


@router.get("/dispatches/{dispatch_id}")
def get_dispatch(dispatch_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> dict:
    return sales.get_dispatch(db, viewer, dispatch_id)


@router.post("/dispatches", status_code=status.HTTP_201_CREATED)
def create_dispatch(payload: S.DispatchIn, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return sales.create_dispatch(db, viewer, payload, request=request)


@router.post("/dispatches/{dispatch_id}/deliver")
def deliver_dispatch(dispatch_id: uuid.UUID, payload: S.DeliveryIn, viewer: CurrentUser, db: DbSession,
                     request: Request) -> dict:
    return sales.deliver(db, viewer, dispatch_id, payload, request=request)


@router.post("/dispatches/{dispatch_id}/cancel")
def cancel_dispatch(dispatch_id: uuid.UUID, payload: S.ReasonIn, viewer: CurrentUser, db: DbSession,
                    request: Request) -> dict:
    return sales.cancel_dispatch(db, viewer, dispatch_id, payload.reason, request=request)


# --------------------------------------------------------------------------- #
# Billing
# --------------------------------------------------------------------------- #


@router.get("/invoices")
def list_invoices(viewer: CurrentUser, db: DbSession, kind: str | None = None, status: str | None = None,
                  customer_id: uuid.UUID | None = None, q: str | None = None,
                  outstanding_only: bool = False) -> list[dict]:
    return billing.list_invoices(db, viewer, kind=kind, status=status, customer_id=customer_id, q=q,
                                 outstanding_only=outstanding_only)


@router.get("/invoices/ageing")
def invoice_ageing(viewer: CurrentUser, db: DbSession) -> dict:
    return billing.ageing(db, viewer)


@router.get("/invoices/{invoice_id}")
def get_invoice(invoice_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> dict:
    return billing.get_invoice(db, viewer, invoice_id)


@router.post("/invoices", status_code=status.HTTP_201_CREATED)
def create_invoice(payload: S.InvoiceIn, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return billing.save_manual(db, viewer, payload, request=request)


@router.put("/invoices/{invoice_id}")
def update_invoice(invoice_id: uuid.UUID, payload: S.InvoiceIn, viewer: CurrentUser, db: DbSession,
                   request: Request) -> dict:
    return billing.save_manual(db, viewer, payload, invoice_id, request=request)


@router.post("/invoices/from-dispatch", status_code=status.HTTP_201_CREATED)
def invoice_from_dispatch(payload: S.InvoiceFromDispatchIn, viewer: CurrentUser, db: DbSession,
                          request: Request) -> dict:
    return billing.from_dispatch(db, viewer, payload, request=request)


@router.post("/invoices/from-milestone", status_code=status.HTTP_201_CREATED)
def invoice_from_milestone(payload: S.InvoiceFromMilestoneIn, viewer: CurrentUser, db: DbSession,
                           request: Request) -> dict:
    return billing.from_milestone(db, viewer, payload, request=request)


@router.post("/invoices/{invoice_id}/post")
def post_invoice(invoice_id: uuid.UUID, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return billing.post_invoice(db, viewer, invoice_id, request=request)


@router.post("/invoices/{invoice_id}/cancel")
def cancel_invoice(invoice_id: uuid.UUID, payload: S.ReasonIn, viewer: CurrentUser, db: DbSession,
                   request: Request) -> dict:
    return billing.cancel_invoice(db, viewer, invoice_id, payload.reason, request=request)


@router.delete("/invoices/{invoice_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_invoice(invoice_id: uuid.UUID, viewer: CurrentUser, db: DbSession, request: Request) -> Response:
    billing.delete_draft(db, viewer, invoice_id, request=request)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/credit-notes", status_code=status.HTTP_201_CREATED)
def create_credit_note(payload: S.CreditNoteIn, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return billing.create_credit_note(db, viewer, payload, request=request)


@router.post("/credit-notes/{cn_id}/decide")
def decide_credit_note(cn_id: uuid.UUID, payload: S.DecisionIn, viewer: CurrentUser, db: DbSession,
                       request: Request) -> dict:
    return billing.decide_credit_note(db, viewer, cn_id, payload, request=request)


@router.get("/receipts")
def list_receipts(viewer: CurrentUser, db: DbSession, customer_id: uuid.UUID | None = None) -> list[dict]:
    return billing.list_receipts(db, viewer, customer_id=customer_id)


@router.post("/receipts", status_code=status.HTTP_201_CREATED)
def record_receipt(payload: S.ReceiptIn, viewer: CurrentUser, db: DbSession, request: Request) -> dict:
    return billing.record_receipt(db, viewer, payload, request=request)


@router.post("/receipts/{receipt_id}/reverse")
def reverse_receipt(receipt_id: uuid.UUID, payload: S.ReasonIn, viewer: CurrentUser, db: DbSession,
                    request: Request) -> dict:
    return billing.reverse_receipt(db, viewer, receipt_id, payload.reason, request=request)
