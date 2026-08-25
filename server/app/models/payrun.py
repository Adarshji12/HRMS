"""Payroll, checkpoint 2: pay runs and payslips.

**All money is integer paise.**

Three tables, and the reasoning:

**``pay_runs`` is one per company per month**, enforced by a unique constraint.
Two runs for the same month is not a scenario anyone wants — it is what happens
when somebody presses a button twice, and the second one would produce a second
set of payslips nobody can reconcile against the first.

**``payslips`` store their own resolved lines and totals.** Nothing is
re-derived. A payslip is the statement the company handed a person; it has to
say the same thing next year, after the salary structure has been revised, after
the component catalogue has been edited, after the loan it deducted has been
closed. This is the fourth instance of the same rule in this codebase —
timesheet approvals, issued letters and salary structures all freeze the same
way, for the same reason.

**``payslip_lines`` carry a ``source``**, which is the difference between a
payslip and a list of numbers. A ₹6,480 deduction is not just a deduction: it is
instalment 3 of 8 of a specific loan, and when somebody queries it eleven months
later the answer has to be reachable from the line rather than reconstructed by
matching amounts.

What is deliberately **not** here yet: statutory deductions. PF, ESI, PT, LWF and
TDS are checkpoint 3. The ``source`` enum already names them so those lines slot
in without a migration, but nothing computes them, and a payslip today shows
gross less loan instalments — which is honest, rather than a net figure that
pretends to be final.
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
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDMixin


class PayRunStatus(str, enum.Enum):
    """Where a month's payroll is.

    ``DRAFT`` recomputes freely — the point of a draft is to see what today's
    data produces. ``COMPUTED`` still recomputes, because reviewing the figures
    and finding a wrong LOP day is exactly when you want to fix it and run
    again. ``APPROVED`` freezes everything. ``PAID`` additionally applies the
    side effects: loan instalments marked received, expense claims marked
    reimbursed.

    ``APPROVED`` and ``PAID`` are separate for the same reason they are in
    expenses and loans: signing off a payroll and the money leaving the bank are
    different events, usually days apart, and "approved but not yet paid" is the
    state finance actually works in.
    """

    DRAFT = "draft"
    COMPUTED = "computed"
    APPROVED = "approved"
    PAID = "paid"
    CANCELLED = "cancelled"

    @property
    def is_recomputable(self) -> bool:
        return self in (PayRunStatus.DRAFT, PayRunStatus.COMPUTED)

    @property
    def is_frozen(self) -> bool:
        return self in (PayRunStatus.APPROVED, PayRunStatus.PAID)


class LineSource(str, enum.Enum):
    """Where a payslip line came from.

    The reason a payslip is auditable. ``LOAN`` and ``EXPENSE`` lines carry a
    ``source_id`` pointing at the instalment or the claim, so "what was this
    ₹6,480" is answerable from the row rather than by matching amounts.

    The statutory values are declared now and unused until checkpoint 3, so
    those lines need no migration when they arrive.
    """

    #: A component of the employee's salary structure.
    STRUCTURE = "structure"
    #: A loan or advance instalment falling due this month.
    LOAN = "loan"
    #: An approved, unpaid expense claim settled through payroll.
    EXPENSE = "expense"
    #: Entered by hand on this run — a bonus, an arrear, a correction.
    MANUAL = "manual"
    # --- checkpoint 3, declared early ------------------------------------
    PF = "pf"
    ESI = "esi"
    PROFESSIONAL_TAX = "professional_tax"
    LWF = "lwf"
    TDS = "tds"


class PayRun(UUIDMixin, TimestampMixin, Base):
    """One month's payroll for one company."""

    __tablename__ = "pay_runs"
    __table_args__ = (
        # One per company per month. A second is a double-click, not a scenario.
        UniqueConstraint("org_id", "period_year", "period_month",
                         name="uq_pay_runs_period"),
        Index("ix_pay_runs_org_status", "org_id", "status"),
        CheckConstraint("period_month >= 1 AND period_month <= 12",
                        name="ck_pay_runs_month"),
        CheckConstraint("period_year >= 2000 AND period_year <= 2100",
                        name="ck_pay_runs_year"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )

    #: Year and month as integers rather than a date. A run is *for* March 2027,
    #: not for a day in it, and a date column invites somebody to store the 1st
    #: and somebody else the 31st.
    period_year: Mapped[int] = mapped_column(Integer, nullable=False)
    period_month: Mapped[int] = mapped_column(Integer, nullable=False)

    status: Mapped[str] = mapped_column(
        String(12), default=PayRunStatus.DRAFT.value, nullable=False, index=True
    )

    #: When salaries are credited. Distinct from the period: March's payroll is
    #: commonly paid on 1 April, and payslips, bank files and TDS all key on the
    #: pay date rather than the period.
    pay_date: Mapped[date | None] = mapped_column(Date, nullable=True)

    #: Totals across every payslip, in paise. Stored rather than summed on read
    #: because a frozen run's totals are what was signed off, and a sum over
    #: live rows is a different number the day somebody edits one.
    total_gross: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    total_deductions: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    total_net: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    employee_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    computed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    computed_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    approved_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    paid_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    payment_reference: Mapped[str | None] = mapped_column(String(120), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    payslips: Mapped[list["Payslip"]] = relationship(
        back_populates="run", cascade="all, delete-orphan"
    )

    @property
    def status_enum(self) -> PayRunStatus:
        try:
            return PayRunStatus(self.status)
        except ValueError:  # pragma: no cover - a hand-edited row
            return PayRunStatus.DRAFT

    @property
    def period_label(self) -> str:
        return f"{self.period_year}-{self.period_month:02d}"


class Payslip(UUIDMixin, TimestampMixin, Base):
    """One person's pay for one month."""

    __tablename__ = "payslips"
    __table_args__ = (
        UniqueConstraint("run_id", "user_id", name="uq_payslips_run_user"),
        Index("ix_payslips_user", "org_id", "user_id"),
        CheckConstraint("payable_days >= 0", name="ck_payslips_payable_days"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    run_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("pay_runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    #: Which structure produced this. SET NULL rather than RESTRICT: the
    #: payslip's own lines are the durable record, and a structure deleted years
    #: later must not take a payslip with it. The pointer is a convenience for
    #: "which revision was this", not the source of truth.
    structure_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("salary_structures.id", ondelete="SET NULL"), nullable=True
    )

    #: Loss of pay, in milli-days — the unit leave already uses, so a half day
    #: is 500 and no conversion happens at the boundary between the two modules.
    lop_milli_days: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    #: Calendar days in the month, and how many were paid. Both stored because
    #: the proration that produced the gross has to be re-readable — "why is
    #: this ₹1,612 short" is answered by these two numbers.
    month_days: Mapped[int] = mapped_column(Integer, default=30, nullable=False)
    payable_days: Mapped[int] = mapped_column(Integer, default=30, nullable=False)

    #: Paise. Gross after any loss-of-pay proration.
    gross: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    total_deductions: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    net: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    #: What the company paid on top of gross — employer PF, EPS, ESI and LWF.
    #: Not deducted from anybody; recorded because it is the missing half of
    #: cost to company, which checkpoint 1 declined to invent while employer
    #: contributions did not exist.
    employer_contributions: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    #: What the person's salary would have been for a full month, before LOP.
    #: Kept so a payslip can show "₹50,000 less two days" rather than only the
    #: prorated figure, which reads as a pay cut.
    full_gross: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    #: The filed copy in the employee's document record. A payslip has been
    #: re-renderable from its own lines since checkpoint 2, which is enough to
    #: show it — not enough to *have* it three years after leaving. SET NULL so
    #: deleting the copy does not delete the payslip it came from.
    document_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("employee_documents.id", ondelete="SET NULL"), nullable=True
    )

    run: Mapped["PayRun"] = relationship(back_populates="payslips")
    lines: Mapped[list["PayslipLine"]] = relationship(
        back_populates="payslip", cascade="all, delete-orphan",
        order_by="PayslipLine.sort_order",
    )


class PayslipLine(UUIDMixin, TimestampMixin, Base):
    """One line of one payslip, and where it came from."""

    __tablename__ = "payslip_lines"
    __table_args__ = (
        Index("ix_payslip_lines_payslip", "payslip_id"),
        Index("ix_payslip_lines_source", "org_id", "source", "source_id"),
        CheckConstraint("amount >= 0", name="ck_payslip_lines_amount"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    payslip_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("payslips.id", ondelete="CASCADE"), nullable=False
    )

    #: earning | deduction. Both are stored as positive amounts; the kind
    #: decides the sign. A signed amount column means every sum has to remember
    #: which convention it is in, and one of them eventually does not.
    kind: Mapped[str] = mapped_column(String(12), nullable=False)
    code: Mapped[str] = mapped_column(String(32), nullable=False)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    amount: Mapped[int] = mapped_column(Integer, nullable=False)

    source: Mapped[str] = mapped_column(
        String(20), default=LineSource.STRUCTURE.value, nullable=False
    )
    #: The loan instalment, expense claim or salary component behind this line.
    #: Untyped by design — a foreign key would need one column per source and a
    #: migration for each new one, and the ``source`` beside it says which table
    #: to look in.
    source_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    #: Human explanation, shown on the payslip: "Instalment 3 of 8", "Client
    #: visit, Mumbai". Without it a deduction is a number somebody has to ring
    #: up about.
    detail: Mapped[str | None] = mapped_column(String(300), nullable=True)

    sort_order: Mapped[int] = mapped_column(Integer, default=100, nullable=False)

    payslip: Mapped["Payslip"] = relationship(back_populates="lines")
