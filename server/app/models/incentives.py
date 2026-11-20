"""Sales targets and incentives.

HR assigns a target per employee per month. When the month's achievement meets the rule, an
incentive is raised; unless the company has switched approval off it goes to the Approvals queue
(through the same chain engine as everything else), and once approved the amount rides on the
next pay run as an Incentive earning.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDMixin


class IncentiveStatus(str, enum.Enum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    #: Settled through a pay run.
    PAID = "paid"


class SalesIncentiveSettings(TimestampMixin, Base):
    """The rule, one row per company. A missing row means incentives are off."""

    __tablename__ = "sales_incentive_settings"

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), primary_key=True
    )
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    #: What a target counts: "customers" (customers brought in) or "sales" (rupees invoiced).
    target_type: Mapped[str] = mapped_column(String(16), default="customers", nullable=False)
    #: The target an employee gets when HR has not set one for them.
    default_target: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    #: fixed — one amount when earned (incentive_paise is paise).
    #: percent — a share of the sales achieved, sales targets only (incentive_paise is then basis points).
    incentive_type: Mapped[str] = mapped_column(String(8), default="fixed", nullable=False)
    incentive_paise: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    #: full — only at 100% of the target. min — from min_percent of the target. prorata — in proportion.
    achievement: Mapped[str] = mapped_column(String(8), default="full", nullable=False)
    min_percent: Mapped[int] = mapped_column(Integer, default=80, nullable=False)
    #: An achieved target goes to the Approvals queue. Off, it is approved the moment it is raised.
    requires_approval: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class SalesTarget(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "sales_targets"
    __table_args__ = (
        UniqueConstraint("org_id", "user_id", "period_year", "period_month", name="uq_sales_targets_period"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    period_year: Mapped[int] = mapped_column(Integer, nullable=False)
    period_month: Mapped[int] = mapped_column(Integer, nullable=False)
    target: Mapped[int] = mapped_column(Integer, nullable=False)


class SalesIncentive(UUIDMixin, TimestampMixin, Base):
    """One incentive raised for one employee for one month. At most one per person per month."""

    __tablename__ = "sales_incentives"
    __table_args__ = (
        UniqueConstraint("org_id", "user_id", "period_year", "period_month", name="uq_sales_incentives_period"),
        Index("ix_sales_incentives_org_status", "org_id", "status"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    period_year: Mapped[int] = mapped_column(Integer, nullable=False)
    period_month: Mapped[int] = mapped_column(Integer, nullable=False)
    target: Mapped[int] = mapped_column(Integer, nullable=False)
    achieved: Mapped[int] = mapped_column(Integer, nullable=False)
    #: Paise.
    amount: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(12), default=IncentiveStatus.PENDING.value, nullable=False)
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    review_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
