"""Payroll, checkpoint 4b: Form 16.

**One table, and it is a frozen snapshot.** Every figure a Form 16 states is
copied onto the row when it is issued — gross salary, exemptions, deductions,
tax, TDS — rather than being recomputed on read. A Form 16 is a statement the
employer signed and the employee filed a return against; it has to say the same
thing in three years, after the salary structure has been revised, after the
declaration was reopened, after the slab table gained a new year. This is the
fifth instance of the same rule in this codebase, after timesheet approvals,
issued letters, salary structures and payslips, and it is the same argument every
time.

**Issued once per person per year**, enforced by a unique constraint. A revised
Form 16 is a *revision* with its own number, not an edit — the Act treats it that
way and so does anybody who has already filed against the first one.

The rendered document goes into the **Core HR document file** through
``corehr.file_bytes``, the same path a promoted onboarding document and an issued
letter take. Three producers, one writer.

What this deliberately does not model: **Part A**. That is the TRACES-generated
statement of tax deposited against the employer's TAN, downloaded from the
income-tax portal rather than produced by payroll. Generating something that
looked like Part A would be worse than not offering it — an employee could file
against a document no tax authority has seen.
"""

from __future__ import annotations

import enum
import uuid
from datetime import date, datetime

from sqlalchemy import (
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
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDMixin


class Form16Status(str, enum.Enum):
    ISSUED = "issued"
    #: Superseded by a later revision. Kept readable — an employee may have
    #: filed against it, and a document that vanishes cannot be reconciled.
    REVISED = "revised"


class Form16(UUIDMixin, TimestampMixin, Base):
    """One employee's Part B for one financial year, frozen at issue."""

    __tablename__ = "form16s"
    __table_args__ = (
        # One *current* certificate per person per year. A revision supersedes
        # rather than duplicating, so the revision number is part of the key.
        UniqueConstraint("user_id", "financial_year", "revision",
                         name="uq_form16_year_revision"),
        UniqueConstraint("org_id", "reference_no", name="uq_form16_reference"),
        Index("ix_form16_org_year", "org_id", "financial_year", "status"),
        CheckConstraint("financial_year BETWEEN 2000 AND 2100",
                        name="ck_form16_year"),
        CheckConstraint("revision >= 1", name="ck_form16_revision"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )

    #: The year the FY starts: 2025 is FY 2025-26. Same convention throughout.
    financial_year: Mapped[int] = mapped_column(Integer, nullable=False)
    #: 1 for the original. A corrected certificate is revision 2, with its own
    #: reference number, because somebody may already have filed against the
    #: first one.
    revision: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    reference_no: Mapped[str] = mapped_column(String(60), nullable=False)
    status: Mapped[str] = mapped_column(
        String(12), default=Form16Status.ISSUED.value, nullable=False
    )

    # --- the frozen figures, all in paise -----------------------------------
    #
    # Copied at issue, never recomputed. See the module docstring.
    gross_salary: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    standard_deduction: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    professional_tax: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    chapter_via: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    taxable_income: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    tax_before_rebate: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    rebate: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    surcharge: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    cess: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    total_tax: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    #: What payroll actually deducted across the year.
    tds_deducted: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    #: Positive means still owed, negative means over-deducted. Stored rather
    #: than derived so the certificate and the row cannot disagree after a
    #: rounding change.
    balance: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    #: Employer contributions across the year, so the certificate can state what
    #: was paid into PF alongside what was deducted.
    employer_pf: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    employee_pf: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    regime: Mapped[str] = mapped_column(String(8), nullable=False)
    age_band: Mapped[str] = mapped_column(String(16), default="below_60", nullable=False)
    #: Months of payroll the certificate covers. A joiner mid-year has fewer, and
    #: the certificate should say so rather than implying a full year.
    months_covered: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    #: A snapshot of the employee and employer identity as it stood. The PAN is
    #: **masked** here — the full number lives encrypted on the profile and is
    #: revealed through Core HR's audited path. A certificate rendered for the
    #: employee shows the full one; this row does not have to store it twice.
    employee_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    employee_pan_masked: Mapped[str | None] = mapped_column(String(32), nullable=True)
    designation: Mapped[str | None] = mapped_column(String(160), nullable=True)
    employer_name: Mapped[str | None] = mapped_column(String(255), nullable=True)

    issued_on: Mapped[date] = mapped_column(Date, nullable=False)
    issued_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    #: The filed copy in the employee's document record. Nullable because filing
    #: is a side effect that must not be able to fail the issue.
    document_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("employee_documents.id", ondelete="SET NULL"), nullable=True
    )
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
