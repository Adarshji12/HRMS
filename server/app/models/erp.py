"""ERP — the operational backbone: masters, procure-to-pay, inventory, order-to-cash.

This is phase one of the LRS ERP PRD (modules 5–9 and 18, with the masters of 4
and 7). The rest of the PRD's 24 modules either already exist in this product
— CRM and quotations, projects, timesheets, expenses, helpdesk, assets, HRMS,
approval chains — or follow in later phases. The tables here are prefixed
``erp_`` and nothing another module owns is altered.

Four rules shape every table in this file, and they come straight from §3 of
the PRD:

**Single master, many transactions.** A customer is a ``crm_customers`` row —
the CRM already owns who buys from us — and ERP adds the financial account
beside it (:class:`ErpCustomerAccount`) rather than a second customer list.
Items, vendors and warehouses are new masters because nothing owned them.

**No silent overwrite.** A document is editable while it is a draft. Once it is
submitted, approved or posted, it changes through a status transition, a
reversal or an amendment — never an UPDATE of the figures somebody approved.
Lines snapshot names, rates and tax at the time of the document, exactly like
CRM quotation lines, so editing the item master does not rewrite a purchase
order a vendor has already acknowledged.

**The stock ledger is the truth; the balance is a cache of it.** Every quantity
that moves writes one :class:`ErpStockMovement`. :class:`ErpStockBalance` is
maintained in the same transaction for fast reads and for the negative-stock
guard, and can always be rebuilt from the ledger.

**Approvals go through the workflow kernel.** Requisitions, purchase orders,
stock adjustments, sales orders and credit notes carry the column names
``services.workflow`` expects — ``reviewed_by``, ``reviewed_at``,
``review_note`` — so multi-level chains, the self-approval guard and the audit
row work for them exactly as they do for an expense claim.

Money is ``Numeric(14, 2)`` and quantity ``Numeric(14, 3)``, never float.
"""

from __future__ import annotations

import enum
import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDMixin, utcnow

MONEY = Numeric(14, 2)
QTY = Numeric(14, 3)
ZERO = Decimal("0")


def _org_fk() -> Mapped[uuid.UUID]:
    return mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )


def _user_fk(nullable: bool = True) -> Mapped[uuid.UUID | None]:
    return mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=nullable)


# --------------------------------------------------------------------------- #
# Vocabularies
# --------------------------------------------------------------------------- #


class DocStatus(str, enum.Enum):
    """The default lifecycle of §7.2 of the PRD.

    Each document uses the subset that is meaningful to it. ``REJECTED`` and
    ``CANCELLED`` are explicit states with a reason, never a delete.
    """

    DRAFT = "draft"
    SUBMITTED = "submitted"
    APPROVED = "approved"
    REJECTED = "rejected"
    CANCELLED = "cancelled"
    CLOSED = "closed"


class VendorStatus(str, enum.Enum):
    DRAFT = "draft"
    PENDING = "pending"
    ACTIVE = "active"
    SUSPENDED = "suspended"
    BLACKLISTED = "blacklisted"


class PoStatus(str, enum.Enum):
    DRAFT = "draft"
    SUBMITTED = "submitted"
    APPROVED = "approved"
    REJECTED = "rejected"
    #: The vendor has confirmed the order and a delivery date.
    ACKNOWLEDGED = "acknowledged"
    PARTIALLY_RECEIVED = "partially_received"
    RECEIVED = "received"
    CLOSED = "closed"
    CANCELLED = "cancelled"

    @property
    def is_receivable(self) -> bool:
        return self in (
            PoStatus.APPROVED, PoStatus.ACKNOWLEDGED, PoStatus.PARTIALLY_RECEIVED,
        )


class RfqStatus(str, enum.Enum):
    DRAFT = "draft"
    ISSUED = "issued"
    #: A vendor quote has been selected; the RFQ is decided.
    AWARDED = "awarded"
    CANCELLED = "cancelled"


class StockCondition(str, enum.Enum):
    """§FR-08.05. A defective unit is never counted as available stock."""

    GOOD = "good"
    QUARANTINE = "quarantine"
    DEFECTIVE = "defective"
    DOA = "doa"
    RMA = "rma"
    DEMO = "demo"
    SCRAP = "scrap"


class MovementKind(str, enum.Enum):
    GRN = "grn"
    ISSUE = "issue"
    RETURN = "return"
    TRANSFER_OUT = "transfer_out"
    TRANSFER_IN = "transfer_in"
    ADJUSTMENT = "adjustment"
    DISPATCH = "dispatch"
    REVERSAL = "reversal"


class StockDocKind(str, enum.Enum):
    #: Material out to a project, an engineer or a department.
    ISSUE = "issue"
    #: Material back into a warehouse — unused, defective, or RMA.
    RETURN = "return"
    #: Between two warehouses, through an in-transit stage.
    TRANSFER = "transfer"
    #: A counted variance. The only kind that needs approval: it changes
    #: what the company owns without anything physically moving.
    ADJUSTMENT = "adjustment"


class StockDocStatus(str, enum.Enum):
    DRAFT = "draft"
    SUBMITTED = "submitted"
    APPROVED = "approved"
    REJECTED = "rejected"
    POSTED = "posted"
    IN_TRANSIT = "in_transit"
    RECEIVED = "received"
    CANCELLED = "cancelled"


class SerialStatus(str, enum.Enum):
    IN_STOCK = "in_stock"
    IN_TRANSIT = "in_transit"
    ISSUED = "issued"
    DELIVERED = "delivered"
    SCRAPPED = "scrapped"


class SalesOrderStatus(str, enum.Enum):
    DRAFT = "draft"
    SUBMITTED = "submitted"
    #: Released for fulfilment.
    APPROVED = "approved"
    REJECTED = "rejected"
    ON_HOLD = "on_hold"
    PARTIALLY_DISPATCHED = "partially_dispatched"
    DISPATCHED = "dispatched"
    CLOSED = "closed"
    CANCELLED = "cancelled"

    @property
    def is_fulfillable(self) -> bool:
        return self in (SalesOrderStatus.APPROVED, SalesOrderStatus.PARTIALLY_DISPATCHED)


class DispatchStatus(str, enum.Enum):
    DISPATCHED = "dispatched"
    DELIVERED = "delivered"
    CANCELLED = "cancelled"


class MilestoneKind(str, enum.Enum):
    """§FR-05.11."""

    ADVANCE = "advance"
    DISPATCH = "dispatch"
    DELIVERY = "delivery"
    INSTALLATION = "installation"
    UAT = "uat"
    MONTHLY = "monthly"
    CUSTOM = "custom"


class MilestoneStatus(str, enum.Enum):
    PENDING = "pending"
    #: Evidence is in — the milestone may be invoiced.
    READY = "ready"
    INVOICED = "invoiced"


class InvoiceKind(str, enum.Enum):
    PRODUCT = "product"
    SERVICE = "service"
    MILESTONE = "milestone"
    PROFORMA = "proforma"
    CREDIT_NOTE = "credit_note"


class InvoiceStatus(str, enum.Enum):
    DRAFT = "draft"
    #: Credit notes only — awaiting approval.
    SUBMITTED = "submitted"
    POSTED = "posted"
    REJECTED = "rejected"
    CANCELLED = "cancelled"


# --------------------------------------------------------------------------- #
# Numbering and settings
# --------------------------------------------------------------------------- #


class ErpCounter(UUIDMixin, Base):
    """Per-org, per-series, per-fiscal-year document numbering.

    Same discipline as ``crm_counters``: read-modify-write inside the creating
    transaction, made safe by the unique constraint on each document's number.
    """

    __tablename__ = "erp_counters"
    __table_args__ = (
        UniqueConstraint("org_id", "series", "period", name="uq_erp_counters_org_series_period"),
    )

    org_id: Mapped[uuid.UUID] = _org_fk()
    series: Mapped[str] = mapped_column(String(24), nullable=False)
    period: Mapped[str] = mapped_column(String(8), default="", nullable=False)
    last_number: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class ErpSettings(UUIDMixin, TimestampMixin, Base):
    """One row per organisation, created on first read.

    Everything here is a threshold or a rule the PRD says must be configurable
    rather than hard-coded (§1.1).
    """

    __tablename__ = "erp_settings"
    __table_args__ = (UniqueConstraint("org_id", name="uq_erp_settings_org"),)

    org_id: Mapped[uuid.UUID] = _org_fk()
    #: How far a GRN may exceed the ordered quantity, in percent. Zero means
    #: never — receiving more than was ordered is a new order, not a delivery.
    grn_over_receipt_pct: Mapped[Decimal] = mapped_column(
        Numeric(5, 2), default=ZERO, nullable=False
    )
    #: §FR-08.24 — off by default, with the exception controlled here.
    allow_negative_stock: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    #: Invoices posted by somebody other than whoever drafted them.
    invoice_maker_checker: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    default_credit_days: Mapped[int] = mapped_column(Integer, default=30, nullable=False)
    #: Blocks releasing an order for a customer whose overdue exceeds this many
    #: days. Zero turns the check off.
    block_orders_overdue_days: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    po_terms: Mapped[str | None] = mapped_column(Text, nullable=True)
    invoice_terms: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )


# --------------------------------------------------------------------------- #
# Masters
# --------------------------------------------------------------------------- #


class ErpWarehouse(UUIDMixin, TimestampMixin, Base):
    """A place stock is held — §FR-08.01: warehouse, hub, branch, site, or the
    kit an engineer carries."""

    __tablename__ = "erp_warehouses"
    __table_args__ = (UniqueConstraint("org_id", "code", name="uq_erp_warehouses_org_code"),)

    org_id: Mapped[uuid.UUID] = _org_fk()
    code: Mapped[str] = mapped_column(String(24), nullable=False)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    #: warehouse | hub | branch | site | engineer
    kind: Mapped[str] = mapped_column(String(20), default="warehouse", nullable=False)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    state: Mapped[str | None] = mapped_column(String(120), nullable=True)
    #: For an engineer's trunk stock.
    custodian_id: Mapped[uuid.UUID | None] = _user_fk()
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class ErpItem(UUIDMixin, TimestampMixin, Base):
    """An item or a service — §7.1 "Item / Service".

    ``crm_product_id`` links the CRM's catalogue entry, so a quotation priced
    from a CRM product converts into an order line without anybody re-picking
    the item. It is a link, not a merge: the CRM's product is what is sold,
    this is what is stocked.
    """

    __tablename__ = "erp_items"
    __table_args__ = (UniqueConstraint("org_id", "code", name="uq_erp_items_org_code"),)

    org_id: Mapped[uuid.UUID] = _org_fk()
    code: Mapped[str] = mapped_column(String(40), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: goods | service — a service is never stocked.
    item_type: Mapped[str] = mapped_column(String(12), default="goods", nullable=False)
    category: Mapped[str | None] = mapped_column(String(80), nullable=True)
    uom: Mapped[str] = mapped_column(String(16), default="Nos", nullable=False)
    hsn_sac: Mapped[str | None] = mapped_column(String(16), nullable=True)
    gst_percent: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=Decimal("18"), nullable=False)
    make: Mapped[str | None] = mapped_column(String(80), nullable=True)
    model: Mapped[str | None] = mapped_column(String(80), nullable=True)
    part_number: Mapped[str | None] = mapped_column(String(80), nullable=True)
    is_serialized: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    #: Months of OEM warranty a received unit carries, for the serial's expiry.
    warranty_months: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    standard_cost: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    sale_price: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    reorder_level: Mapped[Decimal] = mapped_column(QTY, default=ZERO, nullable=False)
    min_level: Mapped[Decimal] = mapped_column(QTY, default=ZERO, nullable=False)
    max_level: Mapped[Decimal] = mapped_column(QTY, default=ZERO, nullable=False)
    crm_product_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("crm_products.id", ondelete="SET NULL"), nullable=True
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    @property
    def is_stocked(self) -> bool:
        return self.item_type == "goods"


class ErpVendor(UUIDMixin, TimestampMixin, Base):
    """Somebody the company buys from — §6.7.

    A vendor is not purchasable until it is ``active``, and it only becomes
    active through an approval by somebody holding ``can_verify_vendors`` who
    did not create it. Suspension and blacklisting carry a reason and an
    effective date and are never a delete: last year's purchase orders must
    keep naming who they were placed with.
    """

    __tablename__ = "erp_vendors"
    __table_args__ = (UniqueConstraint("org_id", "code", name="uq_erp_vendors_org_code"),)

    org_id: Mapped[uuid.UUID] = _org_fk()
    code: Mapped[str] = mapped_column(String(24), nullable=False)
    legal_name: Mapped[str] = mapped_column(String(200), nullable=False)
    #: oem | distributor | service_partner | transporter | other
    vendor_type: Mapped[str] = mapped_column(String(24), default="distributor", nullable=False)
    category: Mapped[str | None] = mapped_column(String(80), nullable=True)
    gstin: Mapped[str | None] = mapped_column(String(20), nullable=True, index=True)
    pan: Mapped[str | None] = mapped_column(String(12), nullable=True, index=True)
    contact_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(24), nullable=True)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    state: Mapped[str | None] = mapped_column(String(120), nullable=True)
    payment_terms_days: Mapped[int] = mapped_column(Integer, default=30, nullable=False)
    advance_allowed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_msme: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    msme_number: Mapped[str | None] = mapped_column(String(40), nullable=True)
    #: The agreement / OEM authorisation that lapses — §FR-07.07, 07.08.
    agreement_expiry: Mapped[date | None] = mapped_column(Date, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default=VendorStatus.DRAFT.value, nullable=False)
    status_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    status_effective: Mapped[date | None] = mapped_column(Date, nullable=True)
    created_by: Mapped[uuid.UUID | None] = _user_fk()
    approved_by: Mapped[uuid.UUID | None] = _user_fk()
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    #: 1–5, recomputed from received GRNs: on time and accepted quantity.
    performance_score: Mapped[Decimal | None] = mapped_column(Numeric(4, 2), nullable=True)

    banks: Mapped[list["ErpVendorBank"]] = relationship(
        back_populates="vendor", cascade="all, delete-orphan", order_by="ErpVendorBank.created_at"
    )


class ErpVendorBank(UUIDMixin, TimestampMixin, Base):
    """A vendor's bank account — maker-checker, always (§FR-07.04).

    A change is a **new row**, never an edit: the account money was paid to
    last month must remain on record, and an edit would make a fraudulent
    change indistinguishable from a typo fixed. A row is usable only once it is
    ``verified``, and the verifier must not be the person who entered it.
    """

    __tablename__ = "erp_vendor_banks"

    org_id: Mapped[uuid.UUID] = _org_fk()
    vendor_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_vendors.id", ondelete="CASCADE"), nullable=False, index=True
    )
    account_name: Mapped[str] = mapped_column(String(160), nullable=False)
    account_number: Mapped[str] = mapped_column(String(40), nullable=False)
    ifsc: Mapped[str] = mapped_column(String(16), nullable=False)
    bank_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    #: pending | verified | rejected | superseded
    status: Mapped[str] = mapped_column(String(16), default="pending", nullable=False)
    created_by: Mapped[uuid.UUID | None] = _user_fk()
    verified_by: Mapped[uuid.UUID | None] = _user_fk()
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    vendor: Mapped["ErpVendor"] = relationship(back_populates="banks")


class ErpCustomerAccount(UUIDMixin, TimestampMixin, Base):
    """The financial side of a CRM customer — one per customer.

    The customer itself stays in ``crm_customers``; this carries what billing
    and collections need and the CRM does not: legal name for the invoice, PAN,
    credit terms, and the hold that Finance — not Sales — controls (§FR-04.13).
    """

    __tablename__ = "erp_customer_accounts"
    __table_args__ = (
        UniqueConstraint("org_id", "customer_id", name="uq_erp_customer_accounts_org_customer"),
    )

    org_id: Mapped[uuid.UUID] = _org_fk()
    customer_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("crm_customers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    legal_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    gstin: Mapped[str | None] = mapped_column(String(20), nullable=True)
    pan: Mapped[str | None] = mapped_column(String(12), nullable=True)
    billing_address: Mapped[str | None] = mapped_column(Text, nullable=True)
    billing_state: Mapped[str | None] = mapped_column(String(120), nullable=True)
    shipping_address: Mapped[str | None] = mapped_column(Text, nullable=True)
    credit_limit: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    credit_days: Mapped[int] = mapped_column(Integer, default=30, nullable=False)
    credit_hold: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    hold_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )

    sites: Mapped[list["ErpCustomerSite"]] = relationship(
        back_populates="account", cascade="all, delete-orphan", order_by="ErpCustomerSite.name"
    )


class ErpCustomerSite(UUIDMixin, TimestampMixin, Base):
    """A delivery or service location of a customer — §FR-04.01."""

    __tablename__ = "erp_customer_sites"

    org_id: Mapped[uuid.UUID] = _org_fk()
    account_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_customer_accounts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    state: Mapped[str | None] = mapped_column(String(120), nullable=True)
    contact_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    contact_phone: Mapped[str | None] = mapped_column(String(24), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    account: Mapped["ErpCustomerAccount"] = relationship(back_populates="sites")


# --------------------------------------------------------------------------- #
# Procurement
# --------------------------------------------------------------------------- #


class ErpRequisition(UUIDMixin, TimestampMixin, Base):
    """A purchase requisition — §6.6, FR-06.01.

    Anybody may raise one; nobody may approve their own. ``requested_by`` is
    the workflow kernel's subject column.
    """

    __tablename__ = "erp_requisitions"
    __table_args__ = (UniqueConstraint("org_id", "number", name="uq_erp_requisitions_org_number"),)

    org_id: Mapped[uuid.UUID] = _org_fk()
    number: Mapped[str] = mapped_column(String(32), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    purpose: Mapped[str | None] = mapped_column(Text, nullable=True)
    requested_by: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    required_by: Mapped[date | None] = mapped_column(Date, nullable=True)
    warehouse_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_warehouses.id", ondelete="SET NULL"), nullable=True
    )
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="SET NULL"), nullable=True
    )
    sales_order_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_sales_orders.id", ondelete="SET NULL"), nullable=True
    )
    status: Mapped[str] = mapped_column(String(16), default=DocStatus.DRAFT.value, nullable=False, index=True)
    estimated_total: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reviewed_by: Mapped[uuid.UUID | None] = _user_fk()
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    review_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    cancel_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    lines: Mapped[list["ErpRequisitionLine"]] = relationship(
        back_populates="requisition", cascade="all, delete-orphan",
        order_by="ErpRequisitionLine.sort_order",
    )


class ErpRequisitionLine(UUIDMixin, Base):
    __tablename__ = "erp_requisition_lines"

    org_id: Mapped[uuid.UUID] = _org_fk()
    requisition_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_requisitions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    item_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_items.id", ondelete="SET NULL"), nullable=True
    )
    description: Mapped[str] = mapped_column(String(300), nullable=False)
    uom: Mapped[str] = mapped_column(String(16), default="Nos", nullable=False)
    quantity: Mapped[Decimal] = mapped_column(QTY, nullable=False)
    estimated_rate: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    #: How much of this line is already on a purchase order.
    ordered_qty: Mapped[Decimal] = mapped_column(QTY, default=ZERO, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    requisition: Mapped["ErpRequisition"] = relationship(back_populates="lines")


class ErpRfq(UUIDMixin, TimestampMixin, Base):
    """A request for quotation sent to several vendors — FR-06.04."""

    __tablename__ = "erp_rfqs"
    __table_args__ = (UniqueConstraint("org_id", "number", name="uq_erp_rfqs_org_number"),)

    org_id: Mapped[uuid.UUID] = _org_fk()
    number: Mapped[str] = mapped_column(String(32), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    requisition_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_requisitions.id", ondelete="SET NULL"), nullable=True
    )
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    terms: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default=RfqStatus.DRAFT.value, nullable=False)
    created_by: Mapped[uuid.UUID | None] = _user_fk()
    issued_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    #: Why the selected vendor won — mandatory when it was not the lowest
    #: landed cost, or when only one vendor quoted (FR-06.07).
    award_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    lines: Mapped[list["ErpRfqLine"]] = relationship(
        back_populates="rfq", cascade="all, delete-orphan", order_by="ErpRfqLine.sort_order"
    )
    vendors: Mapped[list["ErpRfqVendor"]] = relationship(
        back_populates="rfq", cascade="all, delete-orphan"
    )
    quotes: Mapped[list["ErpVendorQuote"]] = relationship(
        back_populates="rfq", cascade="all, delete-orphan", order_by="ErpVendorQuote.created_at"
    )


class ErpRfqLine(UUIDMixin, Base):
    __tablename__ = "erp_rfq_lines"

    org_id: Mapped[uuid.UUID] = _org_fk()
    rfq_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_rfqs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    requisition_line_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_requisition_lines.id", ondelete="SET NULL"), nullable=True
    )
    item_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_items.id", ondelete="SET NULL"), nullable=True
    )
    description: Mapped[str] = mapped_column(String(300), nullable=False)
    uom: Mapped[str] = mapped_column(String(16), default="Nos", nullable=False)
    quantity: Mapped[Decimal] = mapped_column(QTY, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    rfq: Mapped["ErpRfq"] = relationship(back_populates="lines")


class ErpRfqVendor(UUIDMixin, Base):
    __tablename__ = "erp_rfq_vendors"
    __table_args__ = (UniqueConstraint("rfq_id", "vendor_id", name="uq_erp_rfq_vendors_rfq_vendor"),)

    org_id: Mapped[uuid.UUID] = _org_fk()
    rfq_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_rfqs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    vendor_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_vendors.id", ondelete="CASCADE"), nullable=False
    )

    rfq: Mapped["ErpRfq"] = relationship(back_populates="vendors")


class ErpVendorQuote(UUIDMixin, TimestampMixin, Base):
    """One vendor's answer to an RFQ — FR-06.05.

    A negotiation round is a new quote with ``round`` incremented, never an
    edit of the first: FR-06.08 requires the original offer to survive.
    """

    __tablename__ = "erp_vendor_quotes"

    org_id: Mapped[uuid.UUID] = _org_fk()
    rfq_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_rfqs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    vendor_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_vendors.id", ondelete="CASCADE"), nullable=False, index=True
    )
    round: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    quote_ref: Mapped[str | None] = mapped_column(String(60), nullable=True)
    valid_until: Mapped[date | None] = mapped_column(Date, nullable=True)
    delivery_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    payment_terms: Mapped[str | None] = mapped_column(String(160), nullable=True)
    warranty: Mapped[str | None] = mapped_column(String(160), nullable=True)
    freight: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    taxable_total: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    tax_total: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    #: Taxable + tax + freight — the figure the comparison ranks on.
    landed_total: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_selected: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    rfq: Mapped["ErpRfq"] = relationship(back_populates="quotes")
    lines: Mapped[list["ErpVendorQuoteLine"]] = relationship(
        back_populates="quote", cascade="all, delete-orphan"
    )


class ErpVendorQuoteLine(UUIDMixin, Base):
    __tablename__ = "erp_vendor_quote_lines"

    org_id: Mapped[uuid.UUID] = _org_fk()
    quote_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_vendor_quotes.id", ondelete="CASCADE"), nullable=False, index=True
    )
    rfq_line_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_rfq_lines.id", ondelete="CASCADE"), nullable=False
    )
    rate: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    gst_percent: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=Decimal("18"), nullable=False)

    quote: Mapped["ErpVendorQuote"] = relationship(back_populates="lines")


class ErpPurchaseOrder(UUIDMixin, TimestampMixin, Base):
    """A purchase order — FR-06.09 to 06.19.

    ``created_by`` is the kernel's subject: the buyer who raised the order does
    not approve it. After approval the commercial figures are frozen; a change
    is an amendment, which increments ``revision`` and goes back through
    approval (FR-06.16).
    """

    __tablename__ = "erp_purchase_orders"
    __table_args__ = (UniqueConstraint("org_id", "number", name="uq_erp_purchase_orders_org_number"),)

    org_id: Mapped[uuid.UUID] = _org_fk()
    number: Mapped[str] = mapped_column(String(32), nullable=False)
    revision: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    vendor_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_vendors.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    requisition_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_requisitions.id", ondelete="SET NULL"), nullable=True
    )
    rfq_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_rfqs.id", ondelete="SET NULL"), nullable=True
    )
    quote_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_vendor_quotes.id", ondelete="SET NULL"), nullable=True
    )
    sales_order_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_sales_orders.id", ondelete="SET NULL"), nullable=True
    )
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="SET NULL"), nullable=True
    )
    warehouse_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_warehouses.id", ondelete="SET NULL"), nullable=True
    )
    order_date: Mapped[date] = mapped_column(Date, nullable=False)
    expected_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    #: The date the vendor committed to when acknowledging.
    committed_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    payment_terms: Mapped[str | None] = mapped_column(String(160), nullable=True)
    delivery_terms: Mapped[str | None] = mapped_column(String(160), nullable=True)
    #: Liquidated damages, per the PO clause (FR-06.14): percent of the late
    #: value per week of delay, capped at ``ld_cap_percent`` of it.
    ld_percent_per_week: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=ZERO, nullable=False)
    ld_cap_percent: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=ZERO, nullable=False)
    ld_amount: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    ld_waived: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    ld_waiver_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_interstate: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    sub_total: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    tax_total: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    freight: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    grand_total: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    terms: Mapped[str | None] = mapped_column(Text, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default=PoStatus.DRAFT.value, nullable=False, index=True)
    created_by: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reviewed_by: Mapped[uuid.UUID | None] = _user_fk()
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    review_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    acknowledged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    closed_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    lines: Mapped[list["ErpPurchaseOrderLine"]] = relationship(
        back_populates="order", cascade="all, delete-orphan",
        order_by="ErpPurchaseOrderLine.sort_order",
    )
    vendor: Mapped["ErpVendor"] = relationship()


class ErpPurchaseOrderLine(UUIDMixin, Base):
    __tablename__ = "erp_purchase_order_lines"

    org_id: Mapped[uuid.UUID] = _org_fk()
    order_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_purchase_orders.id", ondelete="CASCADE"), nullable=False, index=True
    )
    item_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_items.id", ondelete="SET NULL"), nullable=True
    )
    requisition_line_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_requisition_lines.id", ondelete="SET NULL"), nullable=True
    )
    description: Mapped[str] = mapped_column(String(300), nullable=False)
    hsn_sac: Mapped[str | None] = mapped_column(String(16), nullable=True)
    uom: Mapped[str] = mapped_column(String(16), default="Nos", nullable=False)
    quantity: Mapped[Decimal] = mapped_column(QTY, nullable=False)
    received_qty: Mapped[Decimal] = mapped_column(QTY, default=ZERO, nullable=False)
    rate: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    gst_percent: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=Decimal("18"), nullable=False)
    taxable_value: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    tax_amount: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    amount: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    order: Mapped["ErpPurchaseOrder"] = relationship(back_populates="lines")


class ErpGoodsReceipt(UUIDMixin, TimestampMixin, Base):
    """A GRN — goods received against a purchase order (FR-08.04).

    Posting is immediate and is the only way stock arrives from a vendor. A
    mistake is corrected by **reversing** the GRN, which writes the opposite
    movements, never by editing what was received.
    """

    __tablename__ = "erp_goods_receipts"
    __table_args__ = (UniqueConstraint("org_id", "number", name="uq_erp_goods_receipts_org_number"),)

    org_id: Mapped[uuid.UUID] = _org_fk()
    number: Mapped[str] = mapped_column(String(32), nullable=False)
    purchase_order_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_purchase_orders.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    vendor_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_vendors.id", ondelete="RESTRICT"), nullable=False
    )
    warehouse_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_warehouses.id", ondelete="RESTRICT"), nullable=False
    )
    received_on: Mapped[date] = mapped_column(Date, nullable=False)
    challan_ref: Mapped[str | None] = mapped_column(String(60), nullable=True)
    invoice_ref: Mapped[str | None] = mapped_column(String(60), nullable=True)
    #: posted | reversed
    status: Mapped[str] = mapped_column(String(16), default="posted", nullable=False)
    days_late: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    ld_amount: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    received_by: Mapped[uuid.UUID | None] = _user_fk()
    reversed_by: Mapped[uuid.UUID | None] = _user_fk()
    reversed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reverse_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    lines: Mapped[list["ErpGoodsReceiptLine"]] = relationship(
        back_populates="receipt", cascade="all, delete-orphan"
    )


class ErpGoodsReceiptLine(UUIDMixin, Base):
    __tablename__ = "erp_goods_receipt_lines"

    org_id: Mapped[uuid.UUID] = _org_fk()
    receipt_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_goods_receipts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    po_line_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_purchase_order_lines.id", ondelete="RESTRICT"), nullable=False
    )
    item_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_items.id", ondelete="SET NULL"), nullable=True
    )
    description: Mapped[str] = mapped_column(String(300), nullable=False)
    #: What arrived, and how it splits. ``accepted + rejected == received``.
    received_qty: Mapped[Decimal] = mapped_column(QTY, nullable=False)
    accepted_qty: Mapped[Decimal] = mapped_column(QTY, nullable=False)
    rejected_qty: Mapped[Decimal] = mapped_column(QTY, default=ZERO, nullable=False)
    #: Condition the accepted quantity is booked into.
    condition: Mapped[str] = mapped_column(String(16), default=StockCondition.GOOD.value, nullable=False)
    unit_cost: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    serials: Mapped[list | None] = mapped_column(JSON, nullable=True)

    receipt: Mapped["ErpGoodsReceipt"] = relationship(back_populates="lines")


# --------------------------------------------------------------------------- #
# Inventory
# --------------------------------------------------------------------------- #


class ErpStockBalance(UUIDMixin, Base):
    """On-hand quantity per item, warehouse and condition — a cache of the ledger.

    ``reserved_qty`` is only meaningful on ``good`` stock: it is what is
    promised to sales orders and not yet dispatched. Available is
    ``quantity - reserved_qty``. ``avg_cost`` is the weighted average, moved
    only by receipts, which is the valuation the PRD asks the interface to use
    (FR-08.20).
    """

    __tablename__ = "erp_stock_balances"
    __table_args__ = (
        UniqueConstraint(
            "org_id", "item_id", "warehouse_id", "condition",
            name="uq_erp_stock_balances_org_item_wh_cond",
        ),
    )

    org_id: Mapped[uuid.UUID] = _org_fk()
    item_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_items.id", ondelete="CASCADE"), nullable=False, index=True
    )
    warehouse_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_warehouses.id", ondelete="CASCADE"), nullable=False, index=True
    )
    condition: Mapped[str] = mapped_column(String(16), default=StockCondition.GOOD.value, nullable=False)
    quantity: Mapped[Decimal] = mapped_column(QTY, default=ZERO, nullable=False)
    reserved_qty: Mapped[Decimal] = mapped_column(QTY, default=ZERO, nullable=False)
    avg_cost: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    last_movement_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ErpStockMovement(UUIDMixin, TimestampMixin, Base):
    """One line of the stock ledger. Append-only.

    ``quantity`` is signed: positive in, negative out. ``ref_type`` and
    ``ref_id`` name the document that caused it — a GRN, a dispatch, a stock
    document — so any balance drills down to its source (§8, drill-down).
    """

    __tablename__ = "erp_stock_movements"
    __table_args__ = (
        Index("ix_erp_stock_movements_org_item_created", "org_id", "item_id", "created_at"),
        Index("ix_erp_stock_movements_ref", "ref_type", "ref_id"),
    )

    org_id: Mapped[uuid.UUID] = _org_fk()
    item_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_items.id", ondelete="CASCADE"), nullable=False
    )
    warehouse_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_warehouses.id", ondelete="CASCADE"), nullable=False, index=True
    )
    condition: Mapped[str] = mapped_column(String(16), default=StockCondition.GOOD.value, nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    quantity: Mapped[Decimal] = mapped_column(QTY, nullable=False)
    unit_cost: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    #: Quantity on hand in this bucket after the movement, for a running ledger.
    balance_after: Mapped[Decimal] = mapped_column(QTY, default=ZERO, nullable=False)
    ref_type: Mapped[str] = mapped_column(String(24), nullable=False)
    ref_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    ref_number: Mapped[str | None] = mapped_column(String(32), nullable=True)
    serials: Mapped[list | None] = mapped_column(JSON, nullable=True)
    reason: Mapped[str | None] = mapped_column(String(200), nullable=True)
    created_by: Mapped[uuid.UUID | None] = _user_fk()


class ErpSerial(UUIDMixin, TimestampMixin, Base):
    """One serialised unit, wherever it is — FR-08.02/03, 08.12, 08.13.

    Its current location and condition live here; where it has been is in
    :class:`ErpSerialEvent`. Once delivered, ``customer_id`` and
    ``sales_order_id`` make it the customer's installed asset, which is what a
    service ticket later checks warranty against.
    """

    __tablename__ = "erp_serials"
    __table_args__ = (
        UniqueConstraint("org_id", "item_id", "serial_no", name="uq_erp_serials_org_item_serial"),
    )

    org_id: Mapped[uuid.UUID] = _org_fk()
    item_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_items.id", ondelete="CASCADE"), nullable=False, index=True
    )
    serial_no: Mapped[str] = mapped_column(String(80), nullable=False)
    warehouse_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_warehouses.id", ondelete="SET NULL"), nullable=True
    )
    condition: Mapped[str] = mapped_column(String(16), default=StockCondition.GOOD.value, nullable=False)
    status: Mapped[str] = mapped_column(String(16), default=SerialStatus.IN_STOCK.value, nullable=False)
    vendor_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_vendors.id", ondelete="SET NULL"), nullable=True
    )
    goods_receipt_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_goods_receipts.id", ondelete="SET NULL"), nullable=True
    )
    customer_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("crm_customers.id", ondelete="SET NULL"), nullable=True
    )
    sales_order_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_sales_orders.id", ondelete="SET NULL"), nullable=True
    )
    warranty_until: Mapped[date | None] = mapped_column(Date, nullable=True)


class ErpSerialEvent(UUIDMixin, TimestampMixin, Base):
    """Where a serial went, and on which document — its traceability trail."""

    __tablename__ = "erp_serial_events"

    org_id: Mapped[uuid.UUID] = _org_fk()
    serial_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_serials.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    warehouse_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_warehouses.id", ondelete="SET NULL"), nullable=True
    )
    condition: Mapped[str | None] = mapped_column(String(16), nullable=True)
    ref_type: Mapped[str] = mapped_column(String(24), nullable=False)
    ref_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    ref_number: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_by: Mapped[uuid.UUID | None] = _user_fk()


class ErpStockDoc(UUIDMixin, TimestampMixin, Base):
    """An issue, return, transfer or adjustment — the movements that are not a
    GRN or a dispatch.

    Only an adjustment is approved (by ``can_approve_stock``, never its maker),
    because it is the only one that changes what the company owns without
    anything physically moving — the PRD's "physical custodian vs adjustment
    approval" separation (Appendix A). A transfer posts in two steps, dispatch
    and receipt, with the stock in transit between them (FR-08.10).
    """

    __tablename__ = "erp_stock_docs"
    __table_args__ = (UniqueConstraint("org_id", "number", name="uq_erp_stock_docs_org_number"),)

    org_id: Mapped[uuid.UUID] = _org_fk()
    number: Mapped[str] = mapped_column(String(32), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    from_warehouse_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_warehouses.id", ondelete="RESTRICT"), nullable=True
    )
    to_warehouse_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_warehouses.id", ondelete="RESTRICT"), nullable=True
    )
    doc_date: Mapped[date] = mapped_column(Date, nullable=False)
    #: A reason code from the PRD's "reason codes for movement/adjustment".
    reason: Mapped[str | None] = mapped_column(String(80), nullable=True)
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="SET NULL"), nullable=True
    )
    recipient_id: Mapped[uuid.UUID | None] = _user_fk()
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default=StockDocStatus.DRAFT.value, nullable=False, index=True)
    value: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    created_by: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reviewed_by: Mapped[uuid.UUID | None] = _user_fk()
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    review_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    posted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    received_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    lines: Mapped[list["ErpStockDocLine"]] = relationship(
        back_populates="doc", cascade="all, delete-orphan", order_by="ErpStockDocLine.sort_order"
    )


class ErpStockDocLine(UUIDMixin, Base):
    __tablename__ = "erp_stock_doc_lines"

    org_id: Mapped[uuid.UUID] = _org_fk()
    doc_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_stock_docs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    item_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_items.id", ondelete="RESTRICT"), nullable=False
    )
    #: Signed for an adjustment (a counted shortfall is negative); positive for
    #: every other kind, whose direction the kind already says.
    quantity: Mapped[Decimal] = mapped_column(QTY, nullable=False)
    condition: Mapped[str] = mapped_column(String(16), default=StockCondition.GOOD.value, nullable=False)
    unit_cost: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    serials: Mapped[list | None] = mapped_column(JSON, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    doc: Mapped["ErpStockDoc"] = relationship(back_populates="lines")


# --------------------------------------------------------------------------- #
# Order management and dispatch
# --------------------------------------------------------------------------- #


class ErpSalesOrder(UUIDMixin, TimestampMixin, Base):
    """A customer order, booked from the customer's PO — §6.5.

    ``quotation_id`` points back at the CRM quotation it was converted from.
    When the order's value differs from that quotation, ``has_deviation`` is
    set and the order cannot be released without a ``deviation_note`` and an
    approval (FR-05.02, 05.03).
    """

    __tablename__ = "erp_sales_orders"
    __table_args__ = (UniqueConstraint("org_id", "number", name="uq_erp_sales_orders_org_number"),)

    org_id: Mapped[uuid.UUID] = _org_fk()
    number: Mapped[str] = mapped_column(String(32), nullable=False)
    customer_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("crm_customers.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    customer_name: Mapped[str] = mapped_column(String(200), nullable=False)
    quotation_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("crm_quotations.id", ondelete="SET NULL"), nullable=True
    )
    site_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_customer_sites.id", ondelete="SET NULL"), nullable=True
    )
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="SET NULL"), nullable=True
    )
    customer_po_number: Mapped[str | None] = mapped_column(String(60), nullable=True)
    customer_po_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    customer_po_value: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)
    order_date: Mapped[date] = mapped_column(Date, nullable=False)
    required_by: Mapped[date | None] = mapped_column(Date, nullable=True)
    billing_address: Mapped[str | None] = mapped_column(Text, nullable=True)
    shipping_address: Mapped[str | None] = mapped_column(Text, nullable=True)
    place_of_supply: Mapped[str | None] = mapped_column(String(120), nullable=True)
    payment_terms: Mapped[str | None] = mapped_column(String(160), nullable=True)
    is_interstate: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    sub_total: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    tax_total: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    grand_total: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    #: What the source quotation said, kept for the deviation report.
    quoted_total: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)
    has_deviation: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    deviation_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    hold_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(
        String(24), default=SalesOrderStatus.DRAFT.value, nullable=False, index=True
    )
    created_by: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reviewed_by: Mapped[uuid.UUID | None] = _user_fk()
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    review_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    closed_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    lines: Mapped[list["ErpSalesOrderLine"]] = relationship(
        back_populates="order", cascade="all, delete-orphan",
        order_by="ErpSalesOrderLine.sort_order",
    )
    milestones: Mapped[list["ErpBillingMilestone"]] = relationship(
        back_populates="order", cascade="all, delete-orphan",
        order_by="ErpBillingMilestone.sort_order",
    )


class ErpSalesOrderLine(UUIDMixin, Base):
    __tablename__ = "erp_sales_order_lines"

    org_id: Mapped[uuid.UUID] = _org_fk()
    order_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_sales_orders.id", ondelete="CASCADE"), nullable=False, index=True
    )
    item_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_items.id", ondelete="SET NULL"), nullable=True
    )
    description: Mapped[str] = mapped_column(String(300), nullable=False)
    hsn_sac: Mapped[str | None] = mapped_column(String(16), nullable=True)
    uom: Mapped[str] = mapped_column(String(16), default="Nos", nullable=False)
    quantity: Mapped[Decimal] = mapped_column(QTY, nullable=False)
    rate: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    gst_percent: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=Decimal("18"), nullable=False)
    taxable_value: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    tax_amount: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    amount: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    #: stock | procure | service — FR-05.06.
    fulfilment: Mapped[str] = mapped_column(String(12), default="stock", nullable=False)
    reserved_qty: Mapped[Decimal] = mapped_column(QTY, default=ZERO, nullable=False)
    #: Which warehouse the reservation sits in.
    reserved_warehouse_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_warehouses.id", ondelete="SET NULL"), nullable=True
    )
    dispatched_qty: Mapped[Decimal] = mapped_column(QTY, default=ZERO, nullable=False)
    invoiced_qty: Mapped[Decimal] = mapped_column(QTY, default=ZERO, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    order: Mapped["ErpSalesOrder"] = relationship(back_populates="lines")


class ErpBillingMilestone(UUIDMixin, TimestampMixin, Base):
    """A billable event on an order — FR-05.11, 18.03.

    ``taxable_amount`` is the milestone's own value, not a percentage resolved
    at invoice time: the customer's PO names an amount, and recomputing it from
    an order total that was later amended would bill a figure nobody agreed.
    """

    __tablename__ = "erp_billing_milestones"

    org_id: Mapped[uuid.UUID] = _org_fk()
    order_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_sales_orders.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), default=MilestoneKind.CUSTOM.value, nullable=False)
    taxable_amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    gst_percent: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=Decimal("18"), nullable=False)
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    status: Mapped[str] = mapped_column(
        String(12), default=MilestoneStatus.PENDING.value, nullable=False
    )
    #: The evidence that made it billable — "UAT signed 14 Oct", a POD number.
    evidence: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: A plain id with no foreign key, deliberately: the invoice already points
    #: at its milestone, and a constraint in both directions is a cycle no
    #: migration can create in one pass. A dangling id here reads as "was
    #: invoiced", which is true.
    invoice_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    order: Mapped["ErpSalesOrder"] = relationship(back_populates="milestones")


class ErpDispatch(UUIDMixin, TimestampMixin, Base):
    """A delivery challan and shipment — §6.9, slimmed to what billing needs.

    Posting a dispatch takes the stock out of the warehouse. Delivery is a
    second step that records the proof (FR-09.11); a product invoice may be
    raised from either, which is a billing-policy choice rather than a rule.
    """

    __tablename__ = "erp_dispatches"
    __table_args__ = (UniqueConstraint("org_id", "number", name="uq_erp_dispatches_org_number"),)

    org_id: Mapped[uuid.UUID] = _org_fk()
    number: Mapped[str] = mapped_column(String(32), nullable=False)
    sales_order_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_sales_orders.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    warehouse_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_warehouses.id", ondelete="RESTRICT"), nullable=False
    )
    dispatch_date: Mapped[date] = mapped_column(Date, nullable=False)
    transporter: Mapped[str | None] = mapped_column(String(120), nullable=True)
    tracking_ref: Mapped[str | None] = mapped_column(String(80), nullable=True)
    vehicle_no: Mapped[str | None] = mapped_column(String(24), nullable=True)
    eway_bill_no: Mapped[str | None] = mapped_column(String(24), nullable=True)
    ship_to: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(
        String(12), default=DispatchStatus.DISPATCHED.value, nullable=False, index=True
    )
    delivered_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    pod_received_by: Mapped[str | None] = mapped_column(String(120), nullable=True)
    pod_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    value: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    created_by: Mapped[uuid.UUID | None] = _user_fk()
    cancel_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    lines: Mapped[list["ErpDispatchLine"]] = relationship(
        back_populates="dispatch", cascade="all, delete-orphan"
    )


class ErpDispatchLine(UUIDMixin, Base):
    __tablename__ = "erp_dispatch_lines"

    org_id: Mapped[uuid.UUID] = _org_fk()
    dispatch_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_dispatches.id", ondelete="CASCADE"), nullable=False, index=True
    )
    order_line_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_sales_order_lines.id", ondelete="RESTRICT"), nullable=False
    )
    item_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_items.id", ondelete="SET NULL"), nullable=True
    )
    description: Mapped[str] = mapped_column(String(300), nullable=False)
    quantity: Mapped[Decimal] = mapped_column(QTY, nullable=False)
    #: How much of this dispatched quantity has been invoiced.
    invoiced_qty: Mapped[Decimal] = mapped_column(QTY, default=ZERO, nullable=False)
    serials: Mapped[list | None] = mapped_column(JSON, nullable=True)

    dispatch: Mapped["ErpDispatch"] = relationship(back_populates="lines")


# --------------------------------------------------------------------------- #
# Billing and receipts
# --------------------------------------------------------------------------- #


class ErpInvoice(UUIDMixin, TimestampMixin, Base):
    """A tax invoice, a proforma, or a credit note — §6.18.

    A draft has no number. The number is issued at posting, from the fiscal
    year's series, so a draft abandoned half-way does not leave a gap in the
    sequence a GST auditor reads. Posted invoices are never edited or deleted;
    they are cancelled with a reason, or corrected by a credit note against
    ``original_invoice_id`` (FR-18.15, 18.16).
    """

    __tablename__ = "erp_invoices"
    __table_args__ = (
        UniqueConstraint("org_id", "number", name="uq_erp_invoices_org_number"),
        Index("ix_erp_invoices_org_customer_status", "org_id", "customer_id", "status"),
    )

    org_id: Mapped[uuid.UUID] = _org_fk()
    number: Mapped[str | None] = mapped_column(String(32), nullable=True)
    kind: Mapped[str] = mapped_column(String(16), default=InvoiceKind.PRODUCT.value, nullable=False)
    customer_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("crm_customers.id", ondelete="RESTRICT"), nullable=False
    )
    customer_name: Mapped[str] = mapped_column(String(200), nullable=False)
    gstin: Mapped[str | None] = mapped_column(String(20), nullable=True)
    billing_address: Mapped[str | None] = mapped_column(Text, nullable=True)
    place_of_supply: Mapped[str | None] = mapped_column(String(120), nullable=True)
    sales_order_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_sales_orders.id", ondelete="SET NULL"), nullable=True, index=True
    )
    dispatch_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_dispatches.id", ondelete="SET NULL"), nullable=True
    )
    milestone_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_billing_milestones.id", ondelete="SET NULL"), nullable=True
    )
    original_invoice_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_invoices.id", ondelete="SET NULL"), nullable=True
    )
    invoice_date: Mapped[date] = mapped_column(Date, nullable=False)
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    is_interstate: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    sub_total: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    cgst: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    sgst: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    igst: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    tax_total: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    grand_total: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    #: Receipts and credit notes applied. Outstanding = grand_total - these.
    amount_received: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    amount_credited: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    terms: Mapped[str | None] = mapped_column(Text, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: The credit note's reason code.
    reason: Mapped[str | None] = mapped_column(String(120), nullable=True)
    status: Mapped[str] = mapped_column(String(12), default=InvoiceStatus.DRAFT.value, nullable=False)
    created_by: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reviewed_by: Mapped[uuid.UUID | None] = _user_fk()
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    review_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    posted_by: Mapped[uuid.UUID | None] = _user_fk()
    posted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    cancel_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    lines: Mapped[list["ErpInvoiceLine"]] = relationship(
        back_populates="invoice", cascade="all, delete-orphan",
        order_by="ErpInvoiceLine.sort_order",
    )

    @property
    def outstanding(self) -> Decimal:
        if self.kind in (InvoiceKind.CREDIT_NOTE.value, InvoiceKind.PROFORMA.value):
            return ZERO
        if self.status != InvoiceStatus.POSTED.value:
            return ZERO
        return self.grand_total - self.amount_received - self.amount_credited


class ErpInvoiceLine(UUIDMixin, Base):
    __tablename__ = "erp_invoice_lines"

    org_id: Mapped[uuid.UUID] = _org_fk()
    invoice_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_invoices.id", ondelete="CASCADE"), nullable=False, index=True
    )
    order_line_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_sales_order_lines.id", ondelete="SET NULL"), nullable=True
    )
    dispatch_line_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_dispatch_lines.id", ondelete="SET NULL"), nullable=True
    )
    item_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("erp_items.id", ondelete="SET NULL"), nullable=True
    )
    description: Mapped[str] = mapped_column(String(300), nullable=False)
    hsn_sac: Mapped[str | None] = mapped_column(String(16), nullable=True)
    uom: Mapped[str] = mapped_column(String(16), default="Nos", nullable=False)
    quantity: Mapped[Decimal] = mapped_column(QTY, nullable=False)
    rate: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    gst_percent: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=Decimal("18"), nullable=False)
    taxable_value: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    tax_amount: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    amount: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    invoice: Mapped["ErpInvoice"] = relationship(back_populates="lines")


class ErpReceipt(UUIDMixin, TimestampMixin, Base):
    """Money received against an invoice — the start of §6.19.

    One receipt settles one invoice. A cheque covering three invoices is three
    receipts with the same reference, which keeps "what is still owed on this
    invoice" a sum over one column rather than an allocation table.
    """

    __tablename__ = "erp_receipts"
    __table_args__ = (UniqueConstraint("org_id", "number", name="uq_erp_receipts_org_number"),)

    org_id: Mapped[uuid.UUID] = _org_fk()
    number: Mapped[str] = mapped_column(String(32), nullable=False)
    invoice_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("erp_invoices.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    customer_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("crm_customers.id", ondelete="RESTRICT"), nullable=False
    )
    received_on: Mapped[date] = mapped_column(Date, nullable=False)
    amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    #: TDS the customer deducted — counts toward settling the invoice.
    tds_amount: Mapped[Decimal] = mapped_column(MONEY, default=ZERO, nullable=False)
    #: neft | rtgs | cheque | upi | cash | other
    mode: Mapped[str] = mapped_column(String(12), default="neft", nullable=False)
    reference: Mapped[str | None] = mapped_column(String(80), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: posted | reversed
    status: Mapped[str] = mapped_column(String(12), default="posted", nullable=False)
    created_by: Mapped[uuid.UUID | None] = _user_fk()
    reverse_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
