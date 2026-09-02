"""CRM: lead generation, the customers leads become, and the desk work around both.

The module is one story told in two halves, and the split is the thing a reader
must not collapse:

* A **lead** is somebody who has not bought anything. It is cheap, duplicated,
  abandoned, and deleted without consequence.
* A **customer** is somebody who has. It carries plans, renewal dates, money,
  and support history, and it must survive the lead being tidied away.

Conversion therefore **copies forward and does not point back with a
constraint**. ``CrmCustomer.converted_from_lead_id`` is a plain ``Uuid`` with no
foreign key, exactly like helpdesk's ``source_ref``: a dangling id is expected
(the lead can be deleted or purged) and must render as "originally a lead" with
nothing behind it, never a 500. The reverse pointer, ``CrmLead.customer_id``,
IS a real FK with ``SET NULL`` — that direction is safe because losing it only
un-marks a lead as converted.

Masters (statuses, sources, industries, products, plans, geography,
dispositions, visit types) are **per organisation**, not global. Two tenants
selling different things must not share a product list, and a status named
"Site visit booked" is meaningful to exactly one company. They are seeded with
sensible defaults on first use — see ``app.services.crm.ensure_defaults`` — so a
new workspace opens a working CRM rather than nine empty configuration screens.

Everything a person can select is a **soft** list: masters carry ``is_active``
and are never hard-deleted once referenced, because a lead created last March
has to keep saying which source it came from.

Money lives on quotations and customer plans as ``Numeric(14, 2)``, never float.
Quotation lines **snapshot** the product name, rate and GST rate at the moment
the quotation was priced: editing the product master afterwards must not rewrite
an offer that has already been sent to a customer.
"""

from __future__ import annotations

import enum
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    Numeric,
    String,
    Text,
    Uuid,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDMixin, utcnow

if TYPE_CHECKING:
    from app.models.user import User


# --------------------------------------------------------------------------- #
# Vocabularies
#
# These are Python enums where the product decides the values, and master
# TABLES where the customer decides them. Getting that boundary right is what
# keeps "Pending / Contacted / Qualified / Won / Lost" editable by an admin
# while "inbound / outbound" stays a fixed pair the code can branch on.
# --------------------------------------------------------------------------- #


class StatusBehaviour(str, enum.Enum):
    """What a lead status *means* to the pipeline, independent of its name.

    A company can rename "Qualified" to "Site visit done" and add three more
    stages; the funnel, the conversion rate and the dashboard still have to
    work. They work off this, never off the label.

    ``DEFAULT`` is where a new lead lands and there is exactly one per org.
    ``WON`` and ``LOST`` are terminal — a lead in either is out of the pipeline
    and stops appearing in "pending follow-up" counts.
    """

    DEFAULT = "default"
    IN_PROGRESS = "in_progress"
    WON = "won"
    LOST = "lost"

    @property
    def is_terminal(self) -> bool:
        return self in (StatusBehaviour.WON, StatusBehaviour.LOST)


class FollowUpStatus(str, enum.Enum):
    PENDING = "pending"
    DONE = "done"
    CANCELLED = "cancelled"


class VisitStatus(str, enum.Enum):
    SCHEDULED = "scheduled"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    CANCELLED = "cancelled"

    @property
    def is_open(self) -> bool:
        return self in (VisitStatus.SCHEDULED, VisitStatus.IN_PROGRESS)


class Priority(str, enum.Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    URGENT = "urgent"

    @property
    def rank(self) -> int:
        return {"low": 0, "medium": 1, "high": 2, "urgent": 3}[self.value]


class InteractionDirection(str, enum.Enum):
    """Who called whom. Fixed, because every support report splits on it."""

    INBOUND = "inbound"
    OUTBOUND = "outbound"


class InteractionStatus(str, enum.Enum):
    OPEN = "open"
    CLOSED = "closed"


class CustomerStatus(str, enum.Enum):
    ACTIVE = "active"
    ON_HOLD = "on_hold"
    EXPIRED = "expired"
    CHURNED = "churned"


class PlanStatus(str, enum.Enum):
    ACTIVE = "active"
    EXPIRED = "expired"
    CANCELLED = "cancelled"


class PaymentStatus(str, enum.Enum):
    PENDING = "pending"
    PARTIAL = "partial"
    PAID = "paid"


class QuotationStatus(str, enum.Enum):
    """A quotation's life.

    ``FAILED`` is not a synonym for ``REJECTED``: rejected is the customer
    saying no, failed is the send itself not working (a bounced mail, a WhatsApp
    that never delivered). Collapsing them would tell a salesperson they were
    turned down when in fact nobody ever saw the offer.
    """

    DRAFT = "draft"
    SENT = "sent"
    FAILED = "failed"
    ACCEPTED = "accepted"
    REJECTED = "rejected"
    EXPIRED = "expired"

    @property
    def is_open(self) -> bool:
        return self in (QuotationStatus.DRAFT, QuotationStatus.SENT)


class ReminderAudience(str, enum.Enum):
    """Who a scheduled reminder goes to.

    ``LIST`` is a hand-typed roster held in ``crm_reminder_recipients``;
    ``LEADS`` and ``CUSTOMERS`` are resolved at send time from the live filter,
    so a lead added tomorrow is included tomorrow without anybody editing the
    reminder.
    """

    LIST = "list"
    LEADS = "leads"
    CUSTOMERS = "customers"


# --------------------------------------------------------------------------- #
# Masters
# --------------------------------------------------------------------------- #


class CrmLeadStatus(UUIDMixin, TimestampMixin, Base):
    """A stage in the pipeline. Named by the customer, behaved by the product."""

    __tablename__ = "crm_lead_statuses"
    __table_args__ = (
        UniqueConstraint("org_id", "name", name="uq_crm_lead_statuses_org_name"),
        Index("ix_crm_lead_statuses_org_sort", "org_id", "sort_order"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    behaviour: Mapped[str] = mapped_column(
        String(20), default=StatusBehaviour.IN_PROGRESS.value, nullable=False
    )
    #: Hex, shown as the dot in the table and the column head in Kanban.
    colour: Mapped[str] = mapped_column(String(9), default="#3882F6", nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    @property
    def behaviour_enum(self) -> StatusBehaviour:
        try:
            return StatusBehaviour(self.behaviour)
        except ValueError:
            return StatusBehaviour.IN_PROGRESS


class CrmLeadSource(UUIDMixin, TimestampMixin, Base):
    """Where a lead came from — "Meta Ads", "Website", "Walk-in", "Referral"."""

    __tablename__ = "crm_lead_sources"
    __table_args__ = (UniqueConstraint("org_id", "name", name="uq_crm_lead_sources_org_name"),)

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    #: Set on the row the Meta/webhook intake writes to, so captured leads land
    #: on a source without an operator mapping every campaign by hand.
    is_intake_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class CrmIndustry(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "crm_industries"
    __table_args__ = (UniqueConstraint("org_id", "name", name="uq_crm_industries_org_name"),)

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class CrmCountry(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "crm_countries"
    __table_args__ = (UniqueConstraint("org_id", "name", name="uq_crm_countries_org_name"),)

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    iso2: Mapped[str | None] = mapped_column(String(2), nullable=True)
    dial_code: Mapped[str | None] = mapped_column(String(8), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    states: Mapped[list["CrmState"]] = relationship(
        back_populates="country", cascade="all, delete-orphan"
    )


class CrmState(UUIDMixin, TimestampMixin, Base):
    """A state, and — for India — the GST place of supply.

    ``gst_code`` is what decides CGST+SGST against IGST on a quotation, so it is
    on the master rather than typed per document: getting it wrong is a tax
    error repeated on every invoice, and it should be fixed in one place.
    """

    __tablename__ = "crm_states"
    __table_args__ = (
        UniqueConstraint("org_id", "country_id", "name", name="uq_crm_states_org_country_name"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    country_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("crm_countries.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    gst_code: Mapped[str | None] = mapped_column(String(2), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    country: Mapped["CrmCountry"] = relationship(back_populates="states")
    cities: Mapped[list["CrmCity"]] = relationship(
        back_populates="state", cascade="all, delete-orphan"
    )


class CrmCity(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "crm_cities"
    __table_args__ = (
        UniqueConstraint("org_id", "state_id", "name", name="uq_crm_cities_org_state_name"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    state_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("crm_states.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    state: Mapped["CrmState"] = relationship(back_populates="cities")


class CrmProduct(UUIDMixin, TimestampMixin, Base):
    """Something the company sells. Priced here; over-ridable per quotation line."""

    __tablename__ = "crm_products"
    __table_args__ = (UniqueConstraint("org_id", "name", name="uq_crm_products_org_name"),)

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: HSN (goods) or SAC (services). Printed on the quotation where set.
    hsn_sac: Mapped[str | None] = mapped_column(String(16), nullable=True)
    unit: Mapped[str | None] = mapped_column(String(24), nullable=True)
    rate: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=Decimal("0"), nullable=False)
    gst_percent: Mapped[Decimal] = mapped_column(
        Numeric(5, 2), default=Decimal("18"), nullable=False
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    plans: Mapped[list["CrmPlan"]] = relationship(
        back_populates="product", cascade="all, delete-orphan"
    )


class CrmPlan(UUIDMixin, TimestampMixin, Base):
    """A priced term of a product — "Enterprise, 12 months".

    ``duration_days`` is what a renewal date is computed from. Nullable means
    perpetual: a one-off sale has no renewal, and inventing one would put every
    hardware sale in next year's renewal report.
    """

    __tablename__ = "crm_plans"
    __table_args__ = (
        UniqueConstraint("org_id", "product_id", "name", name="uq_crm_plans_org_product_name"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    product_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("crm_products.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    duration_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    price: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=Decimal("0"), nullable=False)
    gst_percent: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    product: Mapped["CrmProduct"] = relationship(back_populates="plans")


class CrmDisposition(UUIDMixin, TimestampMixin, Base):
    """What a logged call was about — "Update call", "Complaint", "Renewal"."""

    __tablename__ = "crm_dispositions"
    __table_args__ = (UniqueConstraint("org_id", "name", name="uq_crm_dispositions_org_name"),)

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    #: Whether picking this disposition should default the interaction to closed.
    #: "Resolved" closes; "Call back later" does not.
    closes_interaction: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class CrmVisitType(UUIDMixin, TimestampMixin, Base):
    """A kind of field call — service, sales, collection, demo."""

    __tablename__ = "crm_visit_types"
    __table_args__ = (UniqueConstraint("org_id", "name", name="uq_crm_visit_types_org_name"),)

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    colour: Mapped[str] = mapped_column(String(9), default="#3882F6", nullable=False)
    #: Field staff must verify arrival with a one-time code sent to the customer.
    #: Per type, because a collection visit is worth proving and a courtesy call
    #: is not.
    requires_otp: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #


class CrmSettings(UUIDMixin, TimestampMixin, Base):
    """One row per organisation. Created on demand, never required to exist."""

    __tablename__ = "crm_settings"
    __table_args__ = (UniqueConstraint("org_id", name="uq_crm_settings_org"),)

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )

    #: How a captured lead gets an owner. ``round_robin`` spreads across the
    #: users named in ``assignment_pool``; ``fixed`` sends everything to
    #: ``default_owner_id``; ``unassigned`` leaves it for a manager to hand out.
    assignment_rule: Mapped[str] = mapped_column(
        String(20), default="unassigned", nullable=False
    )
    default_owner_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    #: User ids in round-robin order. A plain JSON list rather than a join
    #: table: it is read whole, written whole, and never queried across.
    assignment_pool: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    #: Where the round robin got to. Stored so restarting the API does not send
    #: the next three leads to the same person.
    assignment_cursor: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    #: Secret in the Meta / webhook lead-capture URL. Whoever holds it can
    #: create leads in this workspace, so it is rotatable and never logged.
    intake_token: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    intake_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    quotation_prefix: Mapped[str] = mapped_column(String(12), default="QT", nullable=False)
    #: Printed under the totals. Company-wide, over-ridable per quotation.
    quotation_terms: Mapped[str | None] = mapped_column(Text, nullable=True)
    quotation_validity_days: Mapped[int] = mapped_column(Integer, default=15, nullable=False)

    visit_prefix: Mapped[str] = mapped_column(String(12), default="VST", nullable=False)
    ticket_prefix: Mapped[str] = mapped_column(String(12), default="TKT", nullable=False)

    #: Days before a renewal that a customer starts appearing in "renewal due".
    renewal_window_days: Mapped[int] = mapped_column(Integer, default=30, nullable=False)

    #: Master switch for scheduled WhatsApp reminders. Off means the scheduler
    #: skips this org entirely, whatever any individual reminder says.
    reminders_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )


class CrmCounter(UUIDMixin, Base):
    """Per-org, per-series document numbering.

    A row per series ("quotation", "visit", "ticket", "lead") holding the last
    number issued. Numbers are handed out inside the transaction that creates
    the document and the pair (org, series, period) is unique, so two people
    saving at once cannot both get QT-2026-0007 — one loses on the constraint
    and retries.

    ``period`` is the year for series that reset annually, and the empty string
    for series that never reset. Part of the key rather than a column to
    interpret, so "reset every year" costs no branch at read time.
    """

    __tablename__ = "crm_counters"
    __table_args__ = (
        UniqueConstraint("org_id", "series", "period", name="uq_crm_counters_org_series_period"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    series: Mapped[str] = mapped_column(String(24), nullable=False)
    period: Mapped[str] = mapped_column(String(8), default="", nullable=False)
    last_number: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


# --------------------------------------------------------------------------- #
# Leads
# --------------------------------------------------------------------------- #


class CrmLead(UUIDMixin, TimestampMixin, Base):
    """Somebody who might buy.

    ``mobile`` is the identity of a lead in practice — names are typed three
    ways and emails are often absent — so it is indexed and the duplicate check
    runs on it. It is deliberately NOT unique: the same number legitimately
    enquires twice about two different products, and refusing the second is how
    a salesperson loses a live enquiry to a constraint.
    """

    __tablename__ = "crm_leads"
    __table_args__ = (
        UniqueConstraint("org_id", "code", name="uq_crm_leads_org_code"),
        # The list, newest first, which is what "My Leads" opens on.
        Index("ix_crm_leads_org_created", "org_id", "created_at"),
        # "Mine", and the per-owner performance table on the dashboard.
        Index("ix_crm_leads_org_owner", "org_id", "owner_id"),
        # The funnel, and every status filter.
        Index("ix_crm_leads_org_status", "org_id", "status_id"),
        # Duplicate detection on capture.
        Index("ix_crm_leads_org_mobile", "org_id", "mobile"),
        # "Follow-ups due today" and the overdue count read this directly.
        Index("ix_crm_leads_org_next_followup", "org_id", "next_follow_up_at"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    #: Short human reference shown in the table (#3BF118). Generated, unique per
    #: org, and never reused — a salesperson reads it out on the phone.
    code: Mapped[str] = mapped_column(String(16), nullable=False)

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    company: Mapped[str | None] = mapped_column(String(200), nullable=True)
    mobile: Mapped[str] = mapped_column(String(24), nullable=False)
    whatsapp: Mapped[str | None] = mapped_column(String(24), nullable=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # RESTRICT would block deleting a status that is in use, which is the right
    # instinct and the wrong mechanism — masters are deactivated, not deleted,
    # and the API refuses to delete a referenced one with a message. SET NULL
    # here is the safety net for a direct database deletion: a lead with no
    # status is rendered as "unassigned stage", not lost.
    status_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("crm_lead_statuses.id", ondelete="SET NULL"), nullable=True
    )
    source_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("crm_lead_sources.id", ondelete="SET NULL"), nullable=True
    )
    industry_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("crm_industries.id", ondelete="SET NULL"), nullable=True
    )
    product_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("crm_products.id", ondelete="SET NULL"), nullable=True
    )

    #: Who is working it. SET NULL so an employee leaving returns their pipeline
    #: to the unassigned pool rather than deleting it.
    owner_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    state_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("crm_states.id", ondelete="SET NULL"), nullable=True
    )
    city_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("crm_cities.id", ondelete="SET NULL"), nullable=True
    )
    pincode: Mapped[str | None] = mapped_column(String(12), nullable=True)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    #: What the enquiry is thought to be worth. Optional — a salesperson who
    #: does not know should not be made to invent a number.
    value: Mapped[Decimal | None] = mapped_column(Numeric(14, 2), nullable=True)

    #: Denormalised from the open follow-up, so the list and the "due today"
    #: counters need no correlated subquery per row. Written by the service
    #: whenever a follow-up is created, completed or cancelled — never by hand.
    next_follow_up_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_contacted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    #: The customer this lead became. SET NULL: deleting a customer must not
    #: delete the lead history that produced it.
    customer_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("crm_customers.id", ondelete="SET NULL"), nullable=True
    )
    converted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    lost_reason: Mapped[str | None] = mapped_column(String(300), nullable=True)

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )

    status: Mapped["CrmLeadStatus | None"] = relationship()
    source: Mapped["CrmLeadSource | None"] = relationship()
    industry: Mapped["CrmIndustry | None"] = relationship()
    product: Mapped["CrmProduct | None"] = relationship()
    owner: Mapped["User | None"] = relationship(foreign_keys="CrmLead.owner_id")
    state: Mapped["CrmState | None"] = relationship()
    city: Mapped["CrmCity | None"] = relationship()
    activities: Mapped[list["CrmActivity"]] = relationship(
        back_populates="lead",
        cascade="all, delete-orphan",
        order_by="CrmActivity.created_at.desc()",
    )


class CrmActivity(UUIDMixin, TimestampMixin, Base):
    """The timeline on a lead: status moves, calls, notes, quotations sent.

    Append-only. Nothing here is edited or deleted by any handler, because the
    value of a timeline is that it is not tidied — "why did this go quiet in
    March" is only answerable if March is still there.
    """

    __tablename__ = "crm_activities"
    __table_args__ = (Index("ix_crm_activities_lead_created", "lead_id", "created_at"),)

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    lead_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("crm_leads.id", ondelete="CASCADE"), nullable=False, index=True
    )
    actor_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    #: note | status | call | followup | quotation | assignment | converted
    kind: Mapped[str] = mapped_column(String(24), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)

    lead: Mapped["CrmLead"] = relationship(back_populates="activities")
    actor: Mapped["User | None"] = relationship()


class CrmFollowUp(UUIDMixin, TimestampMixin, Base):
    """A promise to get back to somebody, on a date.

    Attaches to a lead OR a customer, never both and never neither — enforced in
    the service rather than by a check constraint, because the same row is
    created from four screens and the message matters more than the constraint.
    A follow-up with neither would be an item in "My Follow-ups" that opens
    nothing.
    """

    __tablename__ = "crm_follow_ups"
    __table_args__ = (
        # The whole point of the module: what is owed, by whom, when.
        Index("ix_crm_follow_ups_org_owner_due", "org_id", "owner_id", "due_at"),
        Index("ix_crm_follow_ups_org_status_due", "org_id", "status", "due_at"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    lead_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("crm_leads.id", ondelete="CASCADE"), nullable=True, index=True
    )
    customer_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("crm_customers.id", ondelete="CASCADE"), nullable=True, index=True
    )
    owner_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    purpose: Mapped[str | None] = mapped_column(String(300), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(
        String(16), default=FollowUpStatus.PENDING.value, nullable=False
    )
    outcome: Mapped[str | None] = mapped_column(Text, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    lead: Mapped["CrmLead | None"] = relationship()
    customer: Mapped["CrmCustomer | None"] = relationship()
    owner: Mapped["User | None"] = relationship()


# --------------------------------------------------------------------------- #
# Customers
# --------------------------------------------------------------------------- #


class CrmCustomer(UUIDMixin, TimestampMixin, Base):
    """Somebody who bought. The record every other CRM screen hangs off.

    ``code`` is the company's own reference (an account number they already
    use), so it is optional on the way in and generated when absent. Unique per
    org where present, because two accounts with the same number is a support
    call waiting to happen.
    """

    __tablename__ = "crm_customers"
    __table_args__ = (
        UniqueConstraint("org_id", "code", name="uq_crm_customers_org_code"),
        Index("ix_crm_customers_org_mobile", "org_id", "mobile"),
        Index("ix_crm_customers_org_status", "org_id", "status"),
        Index("ix_crm_customers_org_manager", "org_id", "manager_id"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    code: Mapped[str] = mapped_column(String(40), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    company: Mapped[str | None] = mapped_column(String(200), nullable=True)
    mobile: Mapped[str] = mapped_column(String(24), nullable=False)
    whatsapp: Mapped[str | None] = mapped_column(String(24), nullable=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)

    customer_type: Mapped[str | None] = mapped_column(String(40), nullable=True)
    industry_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("crm_industries.id", ondelete="SET NULL"), nullable=True
    )
    source_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("crm_lead_sources.id", ondelete="SET NULL"), nullable=True
    )
    gstin: Mapped[str | None] = mapped_column(String(20), nullable=True)

    country_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("crm_countries.id", ondelete="SET NULL"), nullable=True
    )
    state_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("crm_states.id", ondelete="SET NULL"), nullable=True
    )
    city_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("crm_cities.id", ondelete="SET NULL"), nullable=True
    )
    pincode: Mapped[str | None] = mapped_column(String(12), nullable=True)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)

    #: The account manager. SET NULL: a customer outlives whoever owned them.
    manager_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    status: Mapped[str] = mapped_column(
        String(16), default=CustomerStatus.ACTIVE.value, nullable=False
    )
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    #: Where this account came from. NO foreign key — see the module docstring.
    #: A dangling id renders as "converted from a lead" with nothing behind it.
    converted_from_lead_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )

    industry: Mapped["CrmIndustry | None"] = relationship()
    state: Mapped["CrmState | None"] = relationship()
    city: Mapped["CrmCity | None"] = relationship()
    country: Mapped["CrmCountry | None"] = relationship()
    manager: Mapped["User | None"] = relationship()
    plans: Mapped[list["CrmCustomerPlan"]] = relationship(
        back_populates="customer", cascade="all, delete-orphan"
    )


class CrmCustomerPlan(UUIDMixin, TimestampMixin, Base):
    """One thing a customer is subscribed to, for a period.

    ``renewal_on`` is stored, not derived from ``end_on``: a renewal
    conversation starts before the plan lapses and a company may want it a month
    early on one account and a week early on another. Defaulted from ``end_on``
    when nobody says otherwise.
    """

    __tablename__ = "crm_customer_plans"
    __table_args__ = (
        Index("ix_crm_customer_plans_org_renewal", "org_id", "renewal_on"),
        Index("ix_crm_customer_plans_customer", "customer_id", "status"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    customer_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("crm_customers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    product_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("crm_products.id", ondelete="SET NULL"), nullable=True
    )
    plan_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("crm_plans.id", ondelete="SET NULL"), nullable=True
    )
    #: Snapshots, so a renamed product does not rewrite what was sold.
    product_name: Mapped[str] = mapped_column(String(200), nullable=False)
    plan_name: Mapped[str | None] = mapped_column(String(160), nullable=True)

    start_on: Mapped[date] = mapped_column(Date, nullable=False)
    end_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    renewal_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=Decimal("0"), nullable=False)
    payment_status: Mapped[str] = mapped_column(
        String(16), default=PaymentStatus.PENDING.value, nullable=False
    )
    status: Mapped[str] = mapped_column(
        String(16), default=PlanStatus.ACTIVE.value, nullable=False
    )
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    customer: Mapped["CrmCustomer"] = relationship(back_populates="plans")
    product: Mapped["CrmProduct | None"] = relationship()
    plan: Mapped["CrmPlan | None"] = relationship()


class CrmInteraction(UUIDMixin, TimestampMixin, Base):
    """One logged call with a customer — the support desk's unit of work."""

    __tablename__ = "crm_interactions"
    __table_args__ = (
        UniqueConstraint("org_id", "ticket_no", name="uq_crm_interactions_org_ticket"),
        Index("ix_crm_interactions_customer_created", "customer_id", "created_at"),
        Index("ix_crm_interactions_org_status", "org_id", "status"),
        Index("ix_crm_interactions_org_created", "org_id", "created_at"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    ticket_no: Mapped[str] = mapped_column(String(24), nullable=False)
    customer_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("crm_customers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    direction: Mapped[str] = mapped_column(String(12), nullable=False)
    disposition_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("crm_dispositions.id", ondelete="SET NULL"), nullable=True
    )
    disposition_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    status: Mapped[str] = mapped_column(
        String(12), default=InteractionStatus.OPEN.value, nullable=False
    )
    remarks: Mapped[str | None] = mapped_column(Text, nullable=True)
    staff_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    #: The follow-up this call booked, if it booked one. SET NULL rather than
    #: CASCADE: cancelling a follow-up must not erase the call that raised it.
    follow_up_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("crm_follow_ups.id", ondelete="SET NULL"), nullable=True
    )
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    customer: Mapped["CrmCustomer"] = relationship()
    staff: Mapped["User | None"] = relationship()
    follow_up: Mapped["CrmFollowUp | None"] = relationship()


# --------------------------------------------------------------------------- #
# Field visits
# --------------------------------------------------------------------------- #


class CrmVisit(UUIDMixin, TimestampMixin, Base):
    """A field call booked against a customer.

    The OTP is proof of arrival, not authentication: the code goes to the
    customer's number and the employee types back what they were told, which is
    evidence that somebody physically met somebody. It is stored hashed-free
    (a six-digit code has no secrecy value once used) but is cleared on
    verification so it cannot be replayed for the next visit.
    """

    __tablename__ = "crm_visits"
    __table_args__ = (
        UniqueConstraint("org_id", "visit_no", name="uq_crm_visits_org_visit_no"),
        Index("ix_crm_visits_org_scheduled", "org_id", "scheduled_at"),
        Index("ix_crm_visits_org_employee_status", "org_id", "assigned_to", "status"),
        Index("ix_crm_visits_customer", "customer_id"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    visit_no: Mapped[str] = mapped_column(String(24), nullable=False)
    customer_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("crm_customers.id", ondelete="CASCADE"), nullable=False
    )
    visit_type_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("crm_visit_types.id", ondelete="SET NULL"), nullable=True
    )
    visit_type_name: Mapped[str | None] = mapped_column(String(120), nullable=True)

    contact_person: Mapped[str | None] = mapped_column(String(200), nullable=True)
    mobile: Mapped[str | None] = mapped_column(String(24), nullable=True)
    #: Blank means "the address on the customer record", resolved at read time
    #: rather than copied, so correcting the customer corrects the visit.
    address: Mapped[str | None] = mapped_column(Text, nullable=True)

    priority: Mapped[str] = mapped_column(String(12), default=Priority.MEDIUM.value, nullable=False)
    purpose: Mapped[str | None] = mapped_column(Text, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    assigned_to: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    scheduled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(
        String(16), default=VisitStatus.SCHEDULED.value, nullable=False
    )
    outcome: Mapped[str | None] = mapped_column(Text, nullable=True)

    otp_code: Mapped[str | None] = mapped_column(String(8), nullable=True)
    otp_verified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    customer: Mapped["CrmCustomer"] = relationship()
    employee: Mapped["User | None"] = relationship(foreign_keys="CrmVisit.assigned_to")
    visit_type: Mapped["CrmVisitType | None"] = relationship()

    @property
    def duration_minutes(self) -> int | None:
        """Time on site, or None while it is still open."""
        if not self.started_at or not self.completed_at:
            return None
        return max(0, int((self.completed_at - self.started_at).total_seconds() // 60))


# --------------------------------------------------------------------------- #
# Quotations
# --------------------------------------------------------------------------- #


class CrmQuotation(UUIDMixin, TimestampMixin, Base):
    """A priced offer.

    Every party detail is **copied onto the document**, not read through the
    customer at print time. A quotation is a statement of what was offered to
    whom at an address on a date; re-rendering it against today's customer
    record would silently rewrite history, and the address on it may be the one
    thing that decided the tax treatment.
    """

    __tablename__ = "crm_quotations"
    __table_args__ = (
        UniqueConstraint("org_id", "number", name="uq_crm_quotations_org_number"),
        Index("ix_crm_quotations_org_status", "org_id", "status"),
        Index("ix_crm_quotations_org_date", "org_id", "quote_date"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    number: Mapped[str] = mapped_column(String(32), nullable=False)

    #: Either, both, or neither may be set: a quotation can be raised against a
    #: lead, an existing customer, or typed free-hand for somebody who is not on
    #: the system yet.
    lead_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("crm_leads.id", ondelete="SET NULL"), nullable=True, index=True
    )
    customer_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("crm_customers.id", ondelete="SET NULL"), nullable=True, index=True
    )

    customer_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    company: Mapped[str | None] = mapped_column(String(200), nullable=True)
    gstin: Mapped[str | None] = mapped_column(String(20), nullable=True)
    mobile: Mapped[str | None] = mapped_column(String(24), nullable=True)
    whatsapp: Mapped[str | None] = mapped_column(String(24), nullable=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    city: Mapped[str | None] = mapped_column(String(120), nullable=True)
    state: Mapped[str | None] = mapped_column(String(120), nullable=True)
    pincode: Mapped[str | None] = mapped_column(String(12), nullable=True)
    billing_address: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: NULL means "same as billing", which is the common case and is stored as
    #: absence rather than a copy so correcting the billing address corrects
    #: both.
    shipping_address: Mapped[str | None] = mapped_column(Text, nullable=True)

    quote_date: Mapped[date] = mapped_column(Date, nullable=False)
    valid_until: Mapped[date | None] = mapped_column(Date, nullable=True)
    status: Mapped[str] = mapped_column(
        String(16), default=QuotationStatus.DRAFT.value, nullable=False
    )

    #: Computed from the lines on every save. Stored rather than summed at read
    #: time so the list page can total a hundred quotations without loading a
    #: thousand lines, and so a historic document keeps the arithmetic it was
    #: sent with.
    sub_total: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=Decimal("0"), nullable=False)
    discount_total: Mapped[Decimal] = mapped_column(
        Numeric(14, 2), default=Decimal("0"), nullable=False
    )
    taxable_value: Mapped[Decimal] = mapped_column(
        Numeric(14, 2), default=Decimal("0"), nullable=False
    )
    cgst: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=Decimal("0"), nullable=False)
    sgst: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=Decimal("0"), nullable=False)
    igst: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=Decimal("0"), nullable=False)
    grand_total: Mapped[Decimal] = mapped_column(
        Numeric(14, 2), default=Decimal("0"), nullable=False
    )
    #: True when the place of supply differs from the company's own state, so a
    #: reprint does not have to re-derive a decision made months ago against a
    #: company address that may since have changed.
    is_interstate: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    terms: Mapped[str | None] = mapped_column(Text, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )

    creator: Mapped["User | None"] = relationship()
    lines: Mapped[list["CrmQuotationLine"]] = relationship(
        back_populates="quotation",
        cascade="all, delete-orphan",
        order_by="CrmQuotationLine.sort_order",
    )

    @property
    def status_enum(self) -> QuotationStatus:
        try:
            return QuotationStatus(self.status)
        except ValueError:
            return QuotationStatus.DRAFT


class CrmQuotationLine(UUIDMixin, Base):
    """One priced row. Snapshotted — see the note on quotation lines above."""

    __tablename__ = "crm_quotation_lines"
    __table_args__ = (Index("ix_crm_quotation_lines_quotation", "quotation_id", "sort_order"),)

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    quotation_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("crm_quotations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    product_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("crm_products.id", ondelete="SET NULL"), nullable=True
    )
    plan_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("crm_plans.id", ondelete="SET NULL"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    hsn_sac: Mapped[str | None] = mapped_column(String(16), nullable=True)

    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3), default=Decimal("1"), nullable=False)
    rate: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=Decimal("0"), nullable=False)
    #: A percentage when ``discount_is_percent``, an absolute amount otherwise.
    #: One column and a flag rather than two columns, because a line has exactly
    #: one discount and two nullable columns would allow a row that claims both.
    discount: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"), nullable=False)
    discount_is_percent: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    gst_percent: Mapped[Decimal] = mapped_column(
        Numeric(5, 2), default=Decimal("0"), nullable=False
    )

    taxable_value: Mapped[Decimal] = mapped_column(
        Numeric(14, 2), default=Decimal("0"), nullable=False
    )
    tax_amount: Mapped[Decimal] = mapped_column(
        Numeric(14, 2), default=Decimal("0"), nullable=False
    )
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=Decimal("0"), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    quotation: Mapped["CrmQuotation"] = relationship(back_populates="lines")


# --------------------------------------------------------------------------- #
# Scheduled reminders
# --------------------------------------------------------------------------- #


class CrmReminder(UUIDMixin, TimestampMixin, Base):
    """A scheduled WhatsApp message to a list, the leads, or the customers.

    ``is_active`` is the only thing the scheduler reads to decide whether to
    send. A reminder saved with a schedule but left inactive is a draft, and
    that is deliberate: the wizard saves as you go, and a half-built campaign
    must never go out because somebody closed the dialog.
    """

    __tablename__ = "crm_reminders"
    __table_args__ = (Index("ix_crm_reminders_org_active", "org_id", "is_active"),)

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: Public URL of the header image. WhatsApp fetches it at send time, so it
    #: has to stay reachable for the life of the reminder — the console says so
    #: next to the upload.
    image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    template_name: Mapped[str | None] = mapped_column(String(160), nullable=True)

    audience: Mapped[str] = mapped_column(
        String(16), default=ReminderAudience.LIST.value, nullable=False
    )
    #: Audience filter for the LEADS/CUSTOMERS cases — status ids, source ids,
    #: renewal windows. Resolved at send time so the list stays live.
    audience_filter: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)

    start_on: Mapped[date] = mapped_column(Date, nullable=False)
    end_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    #: "HH:MM" in the organisation's timezone, not UTC. A 10:00 reminder means
    #: ten in the morning where the customer is, and storing an instant would
    #: make it drift by an hour twice a year.
    send_time: Mapped[str] = mapped_column(String(5), default="10:00", nullable=False)
    #: ISO weekdays (1=Mon … 7=Sun) the reminder runs on. Empty means every day.
    weekdays: Mapped[list] = mapped_column(JSON, default=list, nullable=False)

    is_active: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    last_run_on: Mapped[date | None] = mapped_column(Date, nullable=True)

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )

    recipients: Mapped[list["CrmReminderRecipient"]] = relationship(
        back_populates="reminder", cascade="all, delete-orphan"
    )
    runs: Mapped[list["CrmReminderRun"]] = relationship(
        back_populates="reminder",
        cascade="all, delete-orphan",
        order_by="CrmReminderRun.created_at.desc()",
    )


class CrmReminderRecipient(UUIDMixin, TimestampMixin, Base):
    """A hand-typed recipient, for the ``list`` audience only."""

    __tablename__ = "crm_reminder_recipients"
    __table_args__ = (
        UniqueConstraint("reminder_id", "mobile", name="uq_crm_reminder_recipients_mobile"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    reminder_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("crm_reminders.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    mobile: Mapped[str] = mapped_column(String(24), nullable=False)

    reminder: Mapped["CrmReminder"] = relationship(back_populates="recipients")


class CrmReminderRun(UUIDMixin, TimestampMixin, Base):
    """What one day's send actually did. The History tab reads these.

    Kept even when everything failed — especially then. "It did not go out" is
    the question this table exists to answer, and a run row that is only written
    on success cannot answer it.
    """

    __tablename__ = "crm_reminder_runs"
    __table_args__ = (
        UniqueConstraint("reminder_id", "run_on", name="uq_crm_reminder_runs_reminder_day"),
        Index("ix_crm_reminder_runs_org_created", "org_id", "created_at"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    reminder_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("crm_reminders.id", ondelete="CASCADE"), nullable=False, index=True
    )
    run_on: Mapped[date] = mapped_column(Date, nullable=False)
    recipients: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    sent: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    failed: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    #: Why a run did nothing, when it did nothing. Free text, shown verbatim.
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    reminder: Mapped["CrmReminder"] = relationship(back_populates="runs")
