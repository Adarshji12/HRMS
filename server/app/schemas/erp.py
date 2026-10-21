"""ERP request bodies.

Inputs only. Responses are built by the services as plain dictionaries through
``services.erp.common.row_dict``, which renders money as decimal strings — the
same wire shape the CRM uses — and keeps thirty response classes from having
to mirror thirty tables column by column.

Quantities and money arrive as ``Decimal``. A float here would be the one
place in the ERP where 0.1 + 0.2 stops being 0.3.
"""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, field_validator

Condition = Literal["good", "quarantine", "defective", "doa", "rma", "demo", "scrap"]


class _In(BaseModel):
    @field_validator("*", mode="before")
    @classmethod
    def _blank_is_none(cls, value):
        # A cleared text box arrives as "", which is not the same as "not set"
        # to a unique index or a date column.
        if isinstance(value, str) and not value.strip():
            return None
        return value


# --------------------------------------------------------------------------- #
# Masters
# --------------------------------------------------------------------------- #


class WarehouseIn(_In):
    code: str = Field(min_length=1, max_length=24)
    name: str = Field(min_length=1, max_length=160)
    kind: Literal["warehouse", "hub", "branch", "site", "engineer"] = "warehouse"
    address: str | None = None
    state: str | None = None
    custodian_id: uuid.UUID | None = None
    is_active: bool = True


class ItemIn(_In):
    code: str = Field(min_length=1, max_length=40)
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    item_type: Literal["goods", "service"] = "goods"
    category: str | None = None
    uom: str = "Nos"
    hsn_sac: str | None = None
    gst_percent: Decimal = Field(default=Decimal("18"), ge=0, le=28)
    make: str | None = None
    model: str | None = None
    part_number: str | None = None
    is_serialized: bool = False
    warranty_months: int = Field(default=0, ge=0, le=240)
    standard_cost: Decimal = Field(default=Decimal("0"), ge=0)
    sale_price: Decimal = Field(default=Decimal("0"), ge=0)
    reorder_level: Decimal = Field(default=Decimal("0"), ge=0)
    min_level: Decimal = Field(default=Decimal("0"), ge=0)
    max_level: Decimal = Field(default=Decimal("0"), ge=0)
    crm_product_id: uuid.UUID | None = None
    is_active: bool = True


class VendorIn(_In):
    code: str | None = Field(default=None, max_length=24)
    legal_name: str = Field(min_length=1, max_length=200)
    vendor_type: Literal["oem", "distributor", "service_partner", "transporter", "other"] = "distributor"
    category: str | None = None
    gstin: str | None = Field(default=None, max_length=20)
    pan: str | None = Field(default=None, max_length=12)
    contact_name: str | None = None
    email: str | None = None
    phone: str | None = None
    address: str | None = None
    state: str | None = None
    payment_terms_days: int = Field(default=30, ge=0, le=365)
    advance_allowed: bool = False
    is_msme: bool = False
    msme_number: str | None = None
    agreement_expiry: date | None = None


class VendorStatusIn(_In):
    status: Literal["active", "suspended", "blacklisted"]
    reason: str | None = None
    effective: date | None = None


class VendorBankIn(_In):
    account_name: str = Field(min_length=1, max_length=160)
    account_number: str = Field(min_length=4, max_length=40)
    ifsc: str = Field(min_length=4, max_length=16)
    bank_name: str | None = None


class DecisionIn(_In):
    approve: bool
    note: str | None = None


class ReasonIn(_In):
    reason: str | None = None


class CustomerSiteIn(_In):
    name: str = Field(min_length=1, max_length=160)
    address: str | None = None
    state: str | None = None
    contact_name: str | None = None
    contact_phone: str | None = None
    is_active: bool = True


class CustomerAccountIn(_In):
    legal_name: str | None = None
    gstin: str | None = None
    pan: str | None = None
    billing_address: str | None = None
    billing_state: str | None = None
    shipping_address: str | None = None
    credit_limit: Decimal = Field(default=Decimal("0"), ge=0)
    credit_days: int = Field(default=30, ge=0, le=365)


class CreditHoldIn(_In):
    hold: bool
    reason: str | None = None


class SettingsIn(_In):
    grn_over_receipt_pct: Decimal = Field(default=Decimal("0"), ge=0, le=100)
    allow_negative_stock: bool = False
    invoice_maker_checker: bool = False
    default_credit_days: int = Field(default=30, ge=0, le=365)
    block_orders_overdue_days: int = Field(default=0, ge=0, le=365)
    po_terms: str | None = None
    invoice_terms: str | None = None


# --------------------------------------------------------------------------- #
# Procurement
# --------------------------------------------------------------------------- #


class RequisitionLineIn(_In):
    item_id: uuid.UUID | None = None
    description: str | None = None
    uom: str | None = None
    quantity: Decimal = Field(gt=0)
    estimated_rate: Decimal = Field(default=Decimal("0"), ge=0)


class RequisitionIn(_In):
    title: str = Field(min_length=1, max_length=200)
    purpose: str | None = None
    required_by: date | None = None
    warehouse_id: uuid.UUID | None = None
    project_id: uuid.UUID | None = None
    sales_order_id: uuid.UUID | None = None
    lines: list[RequisitionLineIn] = Field(min_length=1)


class RfqIn(_In):
    title: str = Field(min_length=1, max_length=200)
    requisition_id: uuid.UUID | None = None
    due_date: date | None = None
    terms: str | None = None
    vendor_ids: list[uuid.UUID] = Field(min_length=1)
    #: Only when not built from a requisition.
    lines: list[RequisitionLineIn] = Field(default_factory=list)


class QuoteLineIn(_In):
    rfq_line_id: uuid.UUID
    rate: Decimal = Field(ge=0)
    gst_percent: Decimal = Field(default=Decimal("18"), ge=0, le=28)


class VendorQuoteIn(_In):
    vendor_id: uuid.UUID
    quote_ref: str | None = None
    valid_until: date | None = None
    delivery_days: int | None = Field(default=None, ge=0)
    payment_terms: str | None = None
    warranty: str | None = None
    freight: Decimal = Field(default=Decimal("0"), ge=0)
    notes: str | None = None
    lines: list[QuoteLineIn] = Field(min_length=1)


class AwardIn(_In):
    quote_id: uuid.UUID
    reason: str | None = None


class PoLineIn(_In):
    item_id: uuid.UUID | None = None
    requisition_line_id: uuid.UUID | None = None
    description: str | None = None
    hsn_sac: str | None = None
    uom: str | None = None
    quantity: Decimal = Field(gt=0)
    rate: Decimal = Field(ge=0)
    gst_percent: Decimal | None = Field(default=None, ge=0, le=28)


class PurchaseOrderIn(_In):
    vendor_id: uuid.UUID
    requisition_id: uuid.UUID | None = None
    sales_order_id: uuid.UUID | None = None
    project_id: uuid.UUID | None = None
    warehouse_id: uuid.UUID | None = None
    order_date: date | None = None
    expected_date: date | None = None
    payment_terms: str | None = None
    delivery_terms: str | None = None
    ld_percent_per_week: Decimal = Field(default=Decimal("0"), ge=0, le=100)
    ld_cap_percent: Decimal = Field(default=Decimal("0"), ge=0, le=100)
    freight: Decimal = Field(default=Decimal("0"), ge=0)
    terms: str | None = None
    notes: str | None = None
    lines: list[PoLineIn] = Field(min_length=1)


class AcknowledgeIn(_In):
    committed_date: date | None = None


class GrnLineIn(_In):
    po_line_id: uuid.UUID
    received_qty: Decimal = Field(gt=0)
    rejected_qty: Decimal = Field(default=Decimal("0"), ge=0)
    condition: Condition = "good"
    serials: list[str] = Field(default_factory=list)


class GoodsReceiptIn(_In):
    purchase_order_id: uuid.UUID
    warehouse_id: uuid.UUID | None = None
    received_on: date | None = None
    challan_ref: str | None = None
    invoice_ref: str | None = None
    notes: str | None = None
    lines: list[GrnLineIn] = Field(min_length=1)


class LdWaiverIn(_In):
    reason: str | None = None


# --------------------------------------------------------------------------- #
# Inventory
# --------------------------------------------------------------------------- #


class StockDocLineIn(_In):
    item_id: uuid.UUID
    quantity: Decimal
    condition: Condition = "good"
    serials: list[str] = Field(default_factory=list)


class StockDocIn(_In):
    kind: Literal["issue", "return", "transfer", "adjustment"]
    from_warehouse_id: uuid.UUID | None = None
    to_warehouse_id: uuid.UUID | None = None
    doc_date: date | None = None
    reason: str | None = None
    project_id: uuid.UUID | None = None
    recipient_id: uuid.UUID | None = None
    notes: str | None = None
    lines: list[StockDocLineIn] = Field(min_length=1)


# --------------------------------------------------------------------------- #
# Sales
# --------------------------------------------------------------------------- #


class SalesOrderLineIn(_In):
    item_id: uuid.UUID | None = None
    description: str | None = None
    hsn_sac: str | None = None
    uom: str | None = None
    quantity: Decimal = Field(gt=0)
    rate: Decimal = Field(ge=0)
    gst_percent: Decimal | None = Field(default=None, ge=0, le=28)
    fulfilment: Literal["stock", "procure", "service"] | None = None


class MilestoneIn(_In):
    name: str = Field(min_length=1, max_length=160)
    kind: Literal["advance", "dispatch", "delivery", "installation", "uat", "monthly", "custom"] = "custom"
    taxable_amount: Decimal = Field(gt=0)
    gst_percent: Decimal = Field(default=Decimal("18"), ge=0, le=28)
    due_date: date | None = None


class SalesOrderIn(_In):
    customer_id: uuid.UUID
    quotation_id: uuid.UUID | None = None
    site_id: uuid.UUID | None = None
    project_id: uuid.UUID | None = None
    customer_po_number: str | None = None
    customer_po_date: date | None = None
    customer_po_value: Decimal | None = Field(default=None, ge=0)
    order_date: date | None = None
    required_by: date | None = None
    billing_address: str | None = None
    shipping_address: str | None = None
    place_of_supply: str | None = None
    payment_terms: str | None = None
    deviation_note: str | None = None
    notes: str | None = None
    lines: list[SalesOrderLineIn] = Field(min_length=1)
    milestones: list[MilestoneIn] = Field(default_factory=list)


class FromQuotationIn(_In):
    quotation_id: uuid.UUID


class HoldIn(_In):
    hold: bool
    reason: str | None = None


class ReserveIn(_In):
    warehouse_id: uuid.UUID


class MilestoneReadyIn(_In):
    evidence: str | None = None


class DispatchLineIn(_In):
    order_line_id: uuid.UUID
    quantity: Decimal = Field(gt=0)
    serials: list[str] = Field(default_factory=list)


class DispatchIn(_In):
    sales_order_id: uuid.UUID
    warehouse_id: uuid.UUID
    dispatch_date: date | None = None
    transporter: str | None = None
    tracking_ref: str | None = None
    vehicle_no: str | None = None
    eway_bill_no: str | None = None
    ship_to: str | None = None
    lines: list[DispatchLineIn] = Field(min_length=1)


class DeliveryIn(_In):
    delivered_on: date | None = None
    received_by: str | None = None
    note: str | None = None


# --------------------------------------------------------------------------- #
# Billing
# --------------------------------------------------------------------------- #


class InvoiceLineIn(_In):
    item_id: uuid.UUID | None = None
    description: str = Field(min_length=1, max_length=300)
    hsn_sac: str | None = None
    uom: str | None = None
    quantity: Decimal = Field(gt=0)
    rate: Decimal = Field(ge=0)
    gst_percent: Decimal = Field(default=Decimal("18"), ge=0, le=28)


class InvoiceIn(_In):
    """A manual service or proforma invoice. Product and milestone invoices
    are raised *from* a dispatch or a milestone, never typed."""

    kind: Literal["service", "proforma"] = "service"
    customer_id: uuid.UUID
    sales_order_id: uuid.UUID | None = None
    invoice_date: date | None = None
    place_of_supply: str | None = None
    notes: str | None = None
    lines: list[InvoiceLineIn] = Field(min_length=1)


class InvoiceFromDispatchIn(_In):
    dispatch_id: uuid.UUID
    invoice_date: date | None = None


class InvoiceFromMilestoneIn(_In):
    milestone_id: uuid.UUID
    invoice_date: date | None = None


class CreditNoteIn(_In):
    original_invoice_id: uuid.UUID
    reason: str = Field(min_length=1, max_length=120)
    invoice_date: date | None = None
    lines: list[InvoiceLineIn] = Field(min_length=1)


class ReceiptIn(_In):
    invoice_id: uuid.UUID
    received_on: date | None = None
    amount: Decimal = Field(ge=0)
    tds_amount: Decimal = Field(default=Decimal("0"), ge=0)
    mode: Literal["neft", "rtgs", "cheque", "upi", "cash", "other"] = "neft"
    reference: str | None = None
    notes: str | None = None
