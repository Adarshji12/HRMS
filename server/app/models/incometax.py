"""Payroll, checkpoint 4: investment declarations and the regime choice.

**All money is integer paise.**

Two tables:

**``tax_declarations`` is one per employee per financial year.** It holds the
thing that matters most and is easiest to overlook: **which regime the employee
chose**. The two produce very different numbers, the choice is the employee's,
and a payroll that assumes one is wrong for roughly half the workforce.

**``tax_declaration_items`` are the individual claims** — 80C, 80D, home-loan
interest — each with a *declared* amount and, later, a *verified* one. Two
columns rather than one because they are two different facts at two different
times: an employer honours a declaration until the proof deadline and the
verified figure after it, and collapsing them loses the ability to say what
changed when somebody's TDS jumps in February.

Proof is a document in the **Core HR document file**, not a second store. That
module already handles upload, permission and download; a parallel one here would
be a second place to get an employee's personal documents wrong.

What is deliberately **not** modelled: perquisites, other-income declarations,
and previous-employer income. Each is a real part of a full Form 16 and each
needs its own rules; they are named here so it is clear they are absent rather
than forgotten.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
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


class Regime(str, enum.Enum):
    """Which tax regime this employee elected for the year.

    ``NEW`` is the default in law, so it is the default here — but the column is
    never null, because "we do not know" is not a state payroll can compute
    against and defaulting silently to the old regime would over-deduct from
    everybody who never filled the form in.
    """

    OLD = "old"
    NEW = "new"


class DeclarationStatus(str, enum.Enum):
    """Where a declaration is in the year.

    ``SUBMITTED`` is what payroll honours from the moment it is made. ``VERIFIED``
    is after proofs were checked, usually in January or February, and is when the
    verified amounts start being used instead of the declared ones — which is
    exactly when somebody's TDS changes and they ask why.
    """

    DRAFT = "draft"
    SUBMITTED = "submitted"
    VERIFIED = "verified"
    #: Proofs were rejected wholesale. The declared figures stop being honoured,
    #: so TDS jumps; kept distinct from a zero declaration so the reason is on
    #: the record.
    REJECTED = "rejected"


class ItemStatus(str, enum.Enum):
    DECLARED = "declared"
    #: A document was attached; nobody has checked it yet.
    PROOF_SUBMITTED = "proof_submitted"
    VERIFIED = "verified"
    REJECTED = "rejected"


class TaxDeclaration(UUIDMixin, TimestampMixin, Base):
    """One employee's declaration for one financial year."""

    __tablename__ = "tax_declarations"
    __table_args__ = (
        # One per person per year. A second would be two regime choices, and
        # nothing in the computation could pick between them.
        UniqueConstraint("user_id", "financial_year", name="uq_tax_declarations_year"),
        Index("ix_tax_declarations_org_year", "org_id", "financial_year", "status"),
        CheckConstraint("financial_year BETWEEN 2000 AND 2100",
                        name="ck_tax_declarations_year"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )

    #: The year the financial year *starts*: 2025 is FY 2025-26. Same convention
    #: as ``core.taxslabs``, so no conversion happens between them.
    financial_year: Mapped[int] = mapped_column(Integer, nullable=False)

    regime: Mapped[str] = mapped_column(
        String(8), default=Regime.NEW.value, nullable=False
    )
    status: Mapped[str] = mapped_column(
        String(16), default=DeclarationStatus.DRAFT.value, nullable=False
    )

    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    verified_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    items: Mapped[list["TaxDeclarationItem"]] = relationship(
        back_populates="declaration", cascade="all, delete-orphan",
        order_by="TaxDeclarationItem.section",
    )

    @property
    def status_enum(self) -> DeclarationStatus:
        try:
            return DeclarationStatus(self.status)
        except ValueError:  # pragma: no cover
            return DeclarationStatus.DRAFT

    @property
    def is_editable(self) -> bool:
        """Draft and submitted are both editable.

        Submitted is deliberately still editable by the employee: a declaration
        is an estimate for the year and people genuinely do invest more in
        November than they said in April. Verification is what closes it.
        """
        return self.status in (
            DeclarationStatus.DRAFT.value, DeclarationStatus.SUBMITTED.value
        )


class TaxDeclarationItem(UUIDMixin, TimestampMixin, Base):
    """One claim under one section."""

    __tablename__ = "tax_declaration_items"
    __table_args__ = (
        # One row per section per declaration. Two "80C" rows would each be half
        # an answer, and the cap would be applied to whichever was summed first.
        UniqueConstraint("declaration_id", "section", name="uq_tax_items_section"),
        Index("ix_tax_items_declaration", "declaration_id"),
        CheckConstraint("declared_amount >= 0 AND (verified_amount IS NULL "
                        "OR verified_amount >= 0)",
                        name="ck_tax_items_amounts"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    declaration_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("tax_declarations.id", ondelete="CASCADE"), nullable=False
    )

    #: "80C", "80D", "24B", "HRA". Free text against a known list rather than an
    #: enum: sections are added by Finance Acts, and an unrecognised one is
    #: summed rather than refused so a company is never blocked by our vocabulary
    #: being out of date.
    section: Mapped[str] = mapped_column(String(24), nullable=False)
    label: Mapped[str | None] = mapped_column(String(200), nullable=True)

    #: What the employee says they will invest. Honoured until proofs are due.
    declared_amount: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    #: What was actually evidenced. NULL until somebody checks — distinct from
    #: zero, which means "checked, and nothing stands up".
    verified_amount: Mapped[int | None] = mapped_column(Integer, nullable=True)

    status: Mapped[str] = mapped_column(
        String(20), default=ItemStatus.DECLARED.value, nullable=False
    )

    #: The proof, held in the Core HR document file rather than a second store.
    #: SET NULL so deleting a document does not delete the claim it evidenced.
    document_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("employee_documents.id", ondelete="SET NULL"), nullable=True
    )
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    declaration: Mapped["TaxDeclaration"] = relationship(back_populates="items")

    @property
    def effective_amount(self) -> int:
        """What payroll should use right now.

        The verified figure once there is one, the declared figure until then.
        A rejected item contributes nothing regardless of what was declared.
        """
        if self.status == ItemStatus.REJECTED.value:
            return 0
        if self.verified_amount is not None:
            return self.verified_amount
        return self.declared_amount
