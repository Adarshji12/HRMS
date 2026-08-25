"""Full-and-final settlement: the itemisation behind the three numbers.

``OffboardingFnf`` (in :mod:`app.models.offboarding`) has held a settlement's
gross, deductions and net since before payroll existed, and its docstring says
plainly that nothing about it is calculated -- an HR admin worked the figure out
in a spreadsheet and typed it in. **That premise has expired.** Salary
structures, statutory deductions, loans, expense claims and a tax position all
exist now, which is everything a settlement is made of.

So this module adds the missing half: a **line** table, so the itemisation lives
here rather than in somebody's spreadsheet, and so "why was ₹41,208 recovered"
has an answer three years later.

Two things it deliberately does not do:

**It does not replace the typed numbers.** ``OffboardingFnf`` still stores gross,
deductions and net exactly as recorded, and still does not derive net from the
other two. A settlement gets negotiated -- ex-gratia, a waived recovery, a
rounding to the nearest thousand -- and the figure actually paid is the one that
matters. The proposal is a starting point that HR accepts, edits or ignores.

**It does not compute in the model.** Every figure here arrives from
:mod:`app.services.settlement`, which reads live data once, at the moment HR asks
for a proposal. Lines are a record of what was settled, not a formula that
re-evaluates -- for the same reason a payslip freezes its lines.
"""

from __future__ import annotations

import enum
import uuid

from sqlalchemy import ForeignKey, Index, Integer, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDMixin


class FnfLineKind(str, enum.Enum):
    """Which side of the settlement a line sits on.

    ``EARNING`` is money owed to the leaver, ``DEDUCTION`` money recovered from
    them. Both are stored **positive**; the kind carries the sign. A negative
    amount in an earning row and a positive one in a deduction row would mean
    the same thing two different ways, and every total would have to know which
    convention each row followed.
    """

    EARNING = "earning"
    DEDUCTION = "deduction"


class FnfSource(str, enum.Enum):
    """Where a line's figure came from, so it can be traced back.

    Not free text: a settlement is challenged more often than any other document
    this system produces, and "which loan" has to resolve to a row.
    """

    #: Salary for the days worked in the final month, from the salary structure.
    SALARY = "salary"
    #: Encashable leave balance at the last working day.
    LEAVE_ENCASHMENT = "leave_encashment"
    #: Payment of Gratuity Act, 1972.
    GRATUITY = "gratuity"
    #: Pay in lieu of notice not served, either direction.
    NOTICE = "notice"
    #: Statutory deduction on the final salary -- PF, ESI, PT, LWF.
    STATUTORY = "statutory"
    #: Outstanding principal on a loan or advance.
    LOAN = "loan"
    #: An approved expense claim never reimbursed.
    EXPENSE = "expense"
    #: Typed in by HR. The escape hatch, and the honest label for one.
    MANUAL = "manual"


class FnfLine(UUIDMixin, TimestampMixin, Base):
    """One component of a settlement.

    Written when HR accepts a proposal, and editable only while the settlement
    is a draft -- the eighth thing in this system that freezes on approval,
    after timesheet approvals, issued letters, salary structures, payslips,
    Form 16 and expense claim totals. A settlement somebody has been paid
    against is evidence.
    """

    __tablename__ = "offboarding_fnf_lines"
    __table_args__ = (
        Index("ix_offboarding_fnf_lines_fnf", "fnf_id", "sort_order"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    fnf_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("offboarding_fnf.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )

    kind: Mapped[str] = mapped_column(String(12), nullable=False)
    #: Short stable handle -- "SALARY", "EL_ENCASH", "GRATUITY", "LOAN". What a
    #: report groups by; ``label`` is what a human reads.
    code: Mapped[str] = mapped_column(String(32), nullable=False)
    label: Mapped[str] = mapped_column(String(160), nullable=False)
    #: Integer paise, always positive. See :class:`FnfLineKind`.
    amount_paise: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    source: Mapped[str] = mapped_column(
        String(24), default=FnfSource.MANUAL.value, nullable=False
    )
    #: Points into whichever table ``source`` names. Null for computed lines
    #: with no single row behind them -- salary, gratuity, notice.
    source_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    #: The working. "18.5 days of earned leave at ₹1,923/day", "5 of 30 days'
    #: notice not served". This is what makes a settlement defensible.
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)

    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    fnf: Mapped["OffboardingFnf"] = relationship(back_populates="lines")  # noqa: F821

    @property
    def kind_enum(self) -> FnfLineKind:
        try:
            return FnfLineKind(self.kind)
        except ValueError:
            return FnfLineKind.EARNING

    @property
    def signed_paise(self) -> int:
        """The amount with the sign its kind implies. For summing, not storage."""
        return (
            self.amount_paise
            if self.kind_enum is FnfLineKind.EARNING
            else -self.amount_paise
        )
