"""Subscriptions and payments.

One ``Subscription`` row per billing period or plan change — never updated in
place when the plan changes. That makes the table its own history: "what was
this company paying in March, and for how many seats" is a query, not a guess,
which is what you need when a customer disputes an invoice.

All money is integer **paise**. See ``app.core.plans`` for why.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDMixin


class Subscription(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "subscriptions"
    __table_args__ = (
        Index("ix_subscriptions_org_created", "org_id", "created_at"),
        Index("ix_subscriptions_status", "status"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )

    plan_id: Mapped[str] = mapped_column(String(32), nullable=False)
    billing_cycle: Mapped[str] = mapped_column(String(16), default="annual", nullable=False)
    # Seats purchased. The employee limit is this number — not a separate field,
    # so the limit can never drift from what was paid for.
    seats: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    status: Mapped[str] = mapped_column(String(24), default="pending_payment", nullable=False)

    base_amount: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    seat_amount: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    tax_amount: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    total_amount: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), default="INR", nullable=False)

    period_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    period_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    activated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    canceled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Free-text reason for a Super Admin override (comped seats, extended trial).
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    payments: Mapped[list["Payment"]] = relationship(
        back_populates="subscription", cascade="all, delete-orphan"
    )

    @property
    def is_expired(self) -> bool:
        from datetime import timezone

        if self.period_end is None:
            return False
        end = self.period_end
        if end.tzinfo is None:
            end = end.replace(tzinfo=timezone.utc)
        return end < datetime.now(timezone.utc)


class Payment(UUIDMixin, TimestampMixin, Base):
    """A single payment attempt.

    Failed and abandoned attempts are kept, not deleted: "the customer says they
    paid" is answered by this table, and a row that only exists on success
    cannot answer it.
    """

    __tablename__ = "payments"
    __table_args__ = (Index("ix_payments_org_created", "org_id", "created_at"),)

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    subscription_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("subscriptions.id", ondelete="SET NULL"), nullable=True
    )

    provider: Mapped[str] = mapped_column(String(24), default="razorpay", nullable=False)
    # Razorpay order id — created before the customer sees the checkout.
    order_id: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    # Set once the customer actually pays.
    payment_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    signature: Mapped[str | None] = mapped_column(String(255), nullable=True)

    amount: Mapped[int] = mapped_column(Integer, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), default="INR", nullable=False)
    status: Mapped[str] = mapped_column(String(24), default="created", nullable=False, index=True)
    method: Mapped[str | None] = mapped_column(String(32), nullable=True)

    contact_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    contact_phone: Mapped[str | None] = mapped_column(String(32), nullable=True)

    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error_description: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Verbatim provider payload. Kept because reconciliation questions always
    # turn out to need a field nobody thought to model.
    raw: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    subscription: Mapped["Subscription | None"] = relationship(back_populates="payments")
