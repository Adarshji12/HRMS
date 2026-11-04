"""CRM opportunities: the deal a lead turns into, and its requirement-type master.

A lead is somebody who might buy; an opportunity is the deal being worked —
what it is worth, how likely it is, what it costs to deliver. One lead can have
several (a hardware refresh now, a support contract later), so the foreign key
points from the opportunity to the lead and not the other way round.

The salesperson on an opportunity is the lead's owner and is deliberately not
copied here: a second copy is a second answer to "who owns this?".
"""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    Date,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDMixin


class CrmRequirementType(UUIDMixin, TimestampMixin, Base):
    """What the customer is asking for — "New purchase", "AMC renewal", "Upgrade"."""

    __tablename__ = "crm_requirement_types"
    __table_args__ = (UniqueConstraint("org_id", "name", name="uq_crm_requirement_types_org_name"),)

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class CrmOpportunity(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "crm_opportunities"

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    lead_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("crm_leads.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    #: An existing customer the deal is with, when there is one — an upgrade or
    #: renewal for somebody who already bought. Optional: most opportunities
    #: start from a lead that is not a customer yet.
    customer_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey("crm_customers.id", ondelete="SET NULL", name="fk_crm_opportunities_customer_id"),
        nullable=True,
    )

    # Rupees, two places, like a lead's value. The currency is not stored: this
    # workspace sells in one.
    expected_revenue: Mapped[Decimal] = mapped_column(
        Numeric(14, 2), default=Decimal("0"), nullable=False
    )
    probability: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    expected_closing: Mapped[date | None] = mapped_column(Date, nullable=True)
    #: Stars, 0-3.
    priority: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    tags: Mapped[list] = mapped_column(JSON, default=list, nullable=False)

    requirement_type_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("crm_requirement_types.id", ondelete="SET NULL"), nullable=True
    )
    #: The make — read from the item-company master, which is where the ERP's
    #: makes are kept.
    oem_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("crm_item_companies.id", ondelete="SET NULL"), nullable=True
    )
    raw_cost: Mapped[Decimal | None] = mapped_column(Numeric(14, 2), nullable=True)
    team_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("teams.id", ondelete="SET NULL"), nullable=True
    )
    is_mail_send: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Two attachments, each one stored object. The *_key is the storage key and
    # never leaves the server; the console reads the file through an endpoint
    # that checks who is asking.
    costsheet_key: Mapped[str | None] = mapped_column(String(300), nullable=True)
    costsheet_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    costsheet_type: Mapped[str | None] = mapped_column(String(120), nullable=True)
    costsheet_size: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    #: Where the costsheet stands: ``none`` (not sent), ``pending`` (sent for
    #: approval), ``approved`` or ``rejected``. Who decided and when are in the
    #: audit log, which is where that question is asked.
    costsheet_status: Mapped[str] = mapped_column(
        String(10), default="none", server_default="none", nullable=False
    )
    quotation_key: Mapped[str | None] = mapped_column(String(300), nullable=True)
    quotation_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    quotation_type: Mapped[str | None] = mapped_column(String(120), nullable=True)
    quotation_size: Mapped[int | None] = mapped_column(BigInteger, nullable=True)

    created_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
