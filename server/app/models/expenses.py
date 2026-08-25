"""Expense claims — categories, claims, and the lines they are made of.

**All money is integer paise**, the convention `app.core.plans` sets out and
billing already follows. Never floats: 0.1 + 0.2 is not 0.3, and a rounding
error in a reimbursement is a support ticket from somebody who was underpaid.

**A claim's total is derived from its lines and stored.** Derived, because a
total the client sends is a total the client can lie about. Stored, because
approval freezes it: the figure a manager signed off must not move when somebody
edits a line afterwards — the same rule `timesheet_approvals` follows, and the
reason a claim's lines become immutable the moment it is submitted.

**One receipt per line, not many.** A line is one expense, and two receipts on
one line almost always means two expenses that should be two lines — which is
also what makes per-category limits and per-day checks meaningful. Splitting is
free; a line whose amount is the sum of two unrelated receipts is not
reviewable.

Three-state lifecycle for money, deliberately: **approved** and **reimbursed**
are separate. A manager approving a claim is not the same event as finance paying
it, they are usually different people days apart, and collapsing them would make
"approved but unpaid" — the state every employee chases — unrepresentable.
"""

from __future__ import annotations

import enum
import uuid
from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDMixin


class ClaimStatus(str, enum.Enum):
    """Where a claim is.

    ``DRAFT`` is the employee's; its lines are editable. Everything after is a
    record. ``REJECTED`` is terminal for that claim — re-submitting a corrected
    version is a new claim, not a status rewind, so the rejection stays
    answerable months later.
    """

    DRAFT = "draft"
    SUBMITTED = "submitted"
    APPROVED = "approved"
    REJECTED = "rejected"
    #: Approved *and* paid. Separate from APPROVED — see the module docstring.
    REIMBURSED = "reimbursed"
    CANCELLED = "cancelled"

    @property
    def is_open(self) -> bool:
        """Still needs somebody to do something."""
        return self in (ClaimStatus.DRAFT, ClaimStatus.SUBMITTED, ClaimStatus.APPROVED)

    @property
    def is_editable(self) -> bool:
        return self is ClaimStatus.DRAFT

    @property
    def is_final(self) -> bool:
        return self in (
            ClaimStatus.REJECTED, ClaimStatus.REIMBURSED, ClaimStatus.CANCELLED
        )


class ExpenseCategory(UUIDMixin, TimestampMixin, Base):
    """What a company will reimburse, and the rules for it."""

    __tablename__ = "expense_categories"
    __table_args__ = (
        # Two categories called "Travel" in one company is a data-entry mistake
        # that makes every per-category report wrong and nobody notices.
        UniqueConstraint("org_id", "name", name="uq_expense_categories_name"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(String(400), nullable=True)

    #: Refuse a line in this category with no receipt attached. Per category
    #: because a taxi fare and a laptop purchase do not warrant the same
    #: evidence, and a single company-wide switch means it is set for the
    #: strictest case and ignored for the rest.
    requires_receipt: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    #: Paise. NULL means no ceiling — not zero, which would refuse everything.
    max_amount: Mapped[int | None] = mapped_column(Integer, nullable=True)

    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class ExpenseClaim(UUIDMixin, TimestampMixin, Base):
    """One submission: a covering note and a set of lines."""

    __tablename__ = "expense_claims"
    __table_args__ = (
        Index("ix_expense_claims_user", "org_id", "user_id", "status"),
        Index("ix_expense_claims_status", "org_id", "status"),
        CheckConstraint("total_amount >= 0", name="ck_expense_claims_total_nonneg"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    #: Whose claim it is — the person to be reimbursed, always. A claim filed by
    #: somebody else still names the subject here; `created_by_user_id` records
    #: the filer, so the row says who claimed on whose behalf rather than reading
    #: as self-filed.
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    title: Mapped[str] = mapped_column(String(200), nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: Optional project attribution, so a client-billable expense can be found
    #: alongside the time booked to the same project. Reuses the existing
    #: projects table rather than inventing a cost-centre concept.
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="SET NULL"), nullable=True
    )

    status: Mapped[str] = mapped_column(
        String(16), default=ClaimStatus.DRAFT.value, nullable=False, index=True
    )
    #: Paise, derived from the lines. See the module docstring for why it is both
    #: derived and stored.
    total_amount: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    #: One currency per deployment for now: there is no FX table and no rate
    #: source, and a claim in USD sitting beside one in INR with both totalled
    #: as if they were the same unit is worse than not offering the field.
    currency: Mapped[str] = mapped_column(String(3), default="INR", nullable=False)

    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    review_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: The figure that was signed off, captured at approval. `total_amount` can
    #: only change while a claim is a draft, so in practice these agree — this
    #: column is what makes that checkable rather than assumed.
    approved_amount: Mapped[int | None] = mapped_column(Integer, nullable=True)

    reimbursed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reimbursed_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    #: Whatever finance can trace the payment by — a UTR, a payroll cycle, a
    #: cheque number. Free text because every company answers this differently
    #: and an enum here would be wrong within a week.
    payment_reference: Mapped[str | None] = mapped_column(String(120), nullable=True)

    lines: Mapped[list["ExpenseLine"]] = relationship(
        back_populates="claim", cascade="all, delete-orphan"
    )

    @property
    def status_enum(self) -> ClaimStatus:
        try:
            return ClaimStatus(self.status)
        except ValueError:  # pragma: no cover - a hand-edited row
            return ClaimStatus.DRAFT


class ExpenseLine(UUIDMixin, TimestampMixin, Base):
    """One expense: what, when, how much, and the receipt for it."""

    __tablename__ = "expense_lines"
    __table_args__ = (
        Index("ix_expense_lines_claim", "claim_id"),
        Index("ix_expense_lines_category", "org_id", "category_id"),
        # A zero-amount line is a note, not an expense, and it makes a claim's
        # line count disagree with what a reviewer sees as substantive.
        CheckConstraint("amount > 0", name="ck_expense_lines_amount_positive"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    claim_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("expense_claims.id", ondelete="CASCADE"), nullable=False
    )
    #: RESTRICT rather than SET NULL: a line with no category cannot be reported
    #: on or checked against a limit, so a category in use is not deletable —
    #: deactivating it is the way to retire one.
    category_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("expense_categories.id", ondelete="RESTRICT"), nullable=False
    )

    spent_on: Mapped[date] = mapped_column(Date, nullable=False)
    description: Mapped[str] = mapped_column(String(300), nullable=False)
    merchant: Mapped[str | None] = mapped_column(String(160), nullable=True)
    #: Paise.
    amount: Mapped[int] = mapped_column(Integer, nullable=False)

    #: The receipt. Nullable because some categories do not require one; the
    #: service refuses submission when a category does and this is empty.
    receipt_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    receipt_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    receipt_type: Mapped[str | None] = mapped_column(String(120), nullable=True)
    receipt_size: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    claim: Mapped["ExpenseClaim"] = relationship(back_populates="lines")
