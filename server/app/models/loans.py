"""Loans and salary advances — the agreement, and the repayment schedule.

**All money is integer paise**, as everywhere else here.

Two tables, and the reason the schedule is a table rather than three columns and
some arithmetic: an instalment is a thing that happens to it. It gets paid on a
date, by a payroll run, sometimes waived, occasionally paid early. A loan
carrying only `principal`, `instalments` and `paid_so_far` cannot answer "which
month was missed", which is the only question anybody asks of a loan ledger.

**The schedule is generated at disbursement, not at approval.** Approval says
the company will lend; disbursement is when the money actually leaves, and the
first deduction month depends on that date rather than on when a form was signed.
Generating early would produce a schedule anchored to a month that turns out to
be wrong, and a schedule that has to be regenerated is one that can be
regenerated after somebody has already paid against it.

**Outstanding is derived, never stored.** It is the sum of the unpaid
instalments, and a stored copy is a second number to drift from the rows it
summarises. That is the opposite of the choice `expense_claims.total_amount`
makes, and deliberately: a claim total is frozen at approval and must not move,
whereas an outstanding balance is *supposed* to move every time an instalment is
paid.

Interest is **simple, on the original principal**, and defaults to zero because
most of what this table will hold is interest-free salary advances. Reducing
balance is not implemented — see `services/loans.total_repayable`.
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


class LoanType(str, enum.Enum):
    """What kind of borrowing this is.

    Not free text: the type is what a company sets policy and reporting on, and
    "salary advance" and "personal loan" are treated differently by finance even
    when the mechanics are identical.
    """

    SALARY_ADVANCE = "salary_advance"
    PERSONAL_LOAN = "personal_loan"
    EMERGENCY_LOAN = "emergency_loan"
    TRAVEL_ADVANCE = "travel_advance"
    OTHER = "other"


class LoanStatus(str, enum.Enum):
    """A loan's life.

    ``APPROVED`` and ``ACTIVE`` are separate because approval is a promise and
    disbursement is a transfer, usually days apart. Collapsing them would make
    "approved but not yet paid out" — the state an employee rings up about —
    unrepresentable, the same argument expense claims make about approved and
    reimbursed.

    ``CLOSED`` is reached automatically when every instalment is settled, so
    nobody has to remember to close a loan and no report has to guess.
    """

    REQUESTED = "requested"
    APPROVED = "approved"
    REJECTED = "rejected"
    #: Money disbursed, schedule live, balance outstanding.
    ACTIVE = "active"
    CLOSED = "closed"
    CANCELLED = "cancelled"
    #: The company has given up on recovery. Distinct from CLOSED: the balance
    #: was forgiven rather than repaid, which matters to both accounting and to
    #: any future lending decision.
    WRITTEN_OFF = "written_off"

    @property
    def is_open(self) -> bool:
        return self in (LoanStatus.REQUESTED, LoanStatus.APPROVED, LoanStatus.ACTIVE)

    @property
    def is_final(self) -> bool:
        return self in (
            LoanStatus.REJECTED, LoanStatus.CLOSED,
            LoanStatus.CANCELLED, LoanStatus.WRITTEN_OFF,
        )


class InstalmentStatus(str, enum.Enum):
    PENDING = "pending"
    PAID = "paid"
    #: Forgiven by the company. Counts as settled for closing the loan, and is
    #: kept distinct from PAID so a written-down amount is never reported as
    #: money recovered.
    WAIVED = "waived"

    @property
    def is_settled(self) -> bool:
        return self in (InstalmentStatus.PAID, InstalmentStatus.WAIVED)


class Loan(UUIDMixin, TimestampMixin, Base):
    """One borrowing agreement."""

    __tablename__ = "loans"
    __table_args__ = (
        Index("ix_loans_user", "org_id", "user_id", "status"),
        Index("ix_loans_status", "org_id", "status"),
        CheckConstraint("principal > 0", name="ck_loans_principal_positive"),
        CheckConstraint(
            "instalment_count > 0 AND instalment_count <= 120",
            name="ck_loans_instalment_count",
        ),
        CheckConstraint(
            "interest_rate_bps >= 0 AND interest_rate_bps <= 10000",
            name="ck_loans_interest_rate",
        ),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    #: The borrower. A loan filed by HR on somebody's behalf still names them
    #: here; ``created_by_user_id`` records the filer.
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    loan_type: Mapped[str] = mapped_column(
        String(24), default=LoanType.SALARY_ADVANCE.value, nullable=False
    )
    #: Paise, as requested. Frozen once approved — see ``approved_principal``
    #: for the figure actually sanctioned, which may be lower.
    principal: Mapped[int] = mapped_column(Integer, nullable=False)
    #: What the company agreed to lend. NULL until approved. Separate from
    #: ``principal`` because approving a smaller amount than was asked for is
    #: routine, and overwriting the request would lose what the employee wanted.
    approved_principal: Mapped[int | None] = mapped_column(Integer, nullable=True)

    instalment_count: Mapped[int] = mapped_column(Integer, nullable=False)
    #: Basis points — 1200 is 12%. An integer, so a rate never picks up a
    #: floating-point error on its way into an interest calculation. Simple
    #: interest on the original principal; see the module docstring.
    interest_rate_bps: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    purpose: Mapped[str | None] = mapped_column(Text, nullable=True)

    status: Mapped[str] = mapped_column(
        String(16), default=LoanStatus.REQUESTED.value, nullable=False, index=True
    )

    requested_on: Mapped[date] = mapped_column(Date, nullable=False)
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    review_note: Mapped[str | None] = mapped_column(Text, nullable=True)

    disbursed_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    disbursed_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    #: Whatever finance can trace the transfer by. Free text, like an expense
    #: payment reference, because every company answers this differently.
    disbursement_reference: Mapped[str | None] = mapped_column(String(120), nullable=True)

    closed_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    closure_note: Mapped[str | None] = mapped_column(Text, nullable=True)

    instalments: Mapped[list["LoanInstalment"]] = relationship(
        back_populates="loan", cascade="all, delete-orphan",
        order_by="LoanInstalment.sequence",
    )

    @property
    def status_enum(self) -> LoanStatus:
        try:
            return LoanStatus(self.status)
        except ValueError:  # pragma: no cover - a hand-edited row
            return LoanStatus.REQUESTED


class LoanInstalment(UUIDMixin, TimestampMixin, Base):
    """One scheduled repayment."""

    __tablename__ = "loan_instalments"
    __table_args__ = (
        # One row per instalment number per loan. Without this a regenerated
        # schedule silently doubles a loan's obligations.
        UniqueConstraint("loan_id", "sequence", name="uq_loan_instalments_sequence"),
        Index("ix_loan_instalments_due", "org_id", "due_on", "status"),
        CheckConstraint("amount > 0", name="ck_loan_instalments_amount_positive"),
        CheckConstraint("sequence > 0", name="ck_loan_instalments_sequence_positive"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    loan_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("loans.id", ondelete="CASCADE"), nullable=False, index=True
    )

    #: 1-based, so instalment 3 of 12 reads as "3" everywhere including the UI.
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    #: The month this is deducted in, stored as its first day. A day-of-month
    #: would imply a precision payroll does not have — a deduction happens in a
    #: pay cycle, not on the 14th.
    due_on: Mapped[date] = mapped_column(Date, nullable=False)
    #: Paise. Instalments differ by at most one paise; see
    #: ``services/loans.build_schedule`` for how the remainder is spread.
    amount: Mapped[int] = mapped_column(Integer, nullable=False)

    status: Mapped[str] = mapped_column(
        String(12), default=InstalmentStatus.PENDING.value, nullable=False
    )
    #: What was actually taken. Normally equals ``amount``; recorded separately
    #: because a part-payment is a real event and forcing it to equal the
    #: scheduled figure would mean either refusing it or lying about it.
    paid_amount: Mapped[int | None] = mapped_column(Integer, nullable=True)
    paid_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    recorded_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    #: A payroll cycle, a UTR, a cash receipt number.
    reference: Mapped[str | None] = mapped_column(String(120), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    loan: Mapped["Loan"] = relationship(back_populates="instalments")

    @property
    def status_enum(self) -> InstalmentStatus:
        try:
            return InstalmentStatus(self.status)
        except ValueError:  # pragma: no cover
            return InstalmentStatus.PENDING
