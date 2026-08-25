"""Payroll, checkpoint 1: the salary structure.

**All money is integer paise, and every amount here is monthly.** Annual figures
are presented by multiplying at the edge; storing both would be two numbers to
disagree.

Three tables and the reasoning behind each:

**``pay_components`` is the company's catalogue.** Basic, HRA, conveyance,
special allowance. A component carries how it is calculated and — the part that
matters later — whether it counts toward PF wages, ESI wages and taxable income.
Those three flags are the entire interface between a company's salary design and
statutory computation, and they live on the component rather than being inferred
from its name, because "Basic" is a convention and a payroll engine that guesses
from a string is one bad rename away from an incorrect PF filing.

**``salary_structures`` is effective-dated and never edited.** A revision is a
new row. Payroll must be able to reproduce a pay run from eighteen months ago,
and it cannot do that if the structure it ran against has since been edited in
place. Same rule as ``timesheet_approvals`` freezing totals and
``issued_letters`` freezing their text — this codebase now has three instances of
it, and it is the same argument every time.

**``salary_structure_components`` stores resolved amounts, not formulas.** A
component defined as "40% of basic" has its rupee value computed when the
structure is created and frozen there. Re-deriving it at pay time would mean a
company adjusting the HRA percentage silently rewrites what everybody was paid
last year.

What is deliberately **not** here: CTC. Cost to company is gross plus employer
contributions (PF, ESI, gratuity), none of which exist until the statutory
checkpoint. A ``ctc`` column now would be a number nobody could compute
correctly, and it would be wrong in the direction that loses an argument with a
candidate.
"""

from __future__ import annotations

import enum
import uuid
from datetime import date

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
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


class ComponentKind(str, enum.Enum):
    """Which side of the payslip a component sits on.

    ``DEDUCTION`` components can be catalogued now but do not contribute to
    gross — the deductions that matter (PF, ESI, TDS) are computed in the
    statutory checkpoint rather than stated on a structure.
    """

    EARNING = "earning"
    DEDUCTION = "deduction"


class Calculation(str, enum.Enum):
    """How a component's monthly value is arrived at.

    ``BALANCE`` is the one that makes a structure add up: it absorbs whatever is
    left of gross after everything else, so a company can define basic and HRA as
    percentages and let special allowance take the remainder. Exactly one earning
    component may be BALANCE — two would each want the same remainder.
    """

    #: A stated monthly amount, given per employee.
    FIXED = "fixed"
    #: Basis points of the component flagged ``is_basic``.
    PERCENT_OF_BASIC = "percent_of_basic"
    #: Basis points of monthly gross.
    PERCENT_OF_GROSS = "percent_of_gross"
    #: Gross minus everything else. At most one per organisation.
    BALANCE = "balance"


class PayComponent(UUIDMixin, TimestampMixin, Base):
    """One line a payslip can carry."""

    __tablename__ = "pay_components"
    __table_args__ = (
        # A code is what a payroll export, a Form 16 mapping and an accounting
        # integration all key on. Two components sharing one is a silent
        # misposting.
        UniqueConstraint("org_id", "code", name="uq_pay_components_code"),
        Index("ix_pay_components_org_kind", "org_id", "kind"),
        CheckConstraint("rate_bps >= 0 AND rate_bps <= 1000000",
                        name="ck_pay_components_rate"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    #: Short, stable, upper-case. BASIC, HRA, CONV.
    code: Mapped[str] = mapped_column(String(24), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    kind: Mapped[str] = mapped_column(
        String(12), default=ComponentKind.EARNING.value, nullable=False
    )
    calculation: Mapped[str] = mapped_column(
        String(20), default=Calculation.FIXED.value, nullable=False
    )
    #: Basis points, used by the two percentage calculations. 4000 is 40%.
    #: Allowed above 10000 because a component genuinely can exceed the thing it
    #: is a percentage of — HRA at 120% of basic is unusual but not invalid.
    rate_bps: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    #: The component ``percent_of_basic`` refers to. At most one per company,
    #: enforced in the service rather than by a partial index, because SQLite
    #: and Postgres disagree about those and this is a once-per-company write.
    is_basic: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # --- the statutory interface --------------------------------------------
    #
    # These three are why this table exists rather than the structure carrying
    # loose amounts. The statutory checkpoint reads exactly these flags; nothing
    # downstream infers anything from a component's name.
    #: Counts toward PF wages (basic + DA, conventionally).
    is_pf_wage: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    #: Counts toward ESI wages — broader than PF, most allowances included.
    is_esi_wage: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    #: Counts toward taxable income before exemptions.
    is_taxable: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    #: Payslip order. Not alphabetical — a payslip reads basic first, always.
    sort_order: Mapped[int] = mapped_column(Integer, default=100, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    description: Mapped[str | None] = mapped_column(String(400), nullable=True)


class SalaryStructure(UUIDMixin, TimestampMixin, Base):
    """One employee's salary, as it stood from a given date.

    Superseded rather than edited. ``effective_to`` is set when the next
    revision starts, so "what was this person on in November" is one query
    rather than a scan-and-sort.
    """

    __tablename__ = "salary_structures"
    __table_args__ = (
        # One structure may start per person per day. A second is either a
        # double submit or two people revising at once, and both should be told
        # rather than silently producing overlapping structures.
        UniqueConstraint("user_id", "effective_from",
                         name="uq_salary_structures_effective"),
        Index("ix_salary_structures_user", "org_id", "user_id", "effective_from"),
        Index("ix_salary_structures_current", "org_id", "effective_to"),
        CheckConstraint("gross_monthly > 0", name="ck_salary_structures_gross_positive"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )

    effective_from: Mapped[date] = mapped_column(Date, nullable=False)
    #: NULL means current. Set to the day before the next revision starts, so
    #: the two never overlap and no date falls in a gap.
    effective_to: Mapped[date | None] = mapped_column(Date, nullable=True)

    #: Paise per month. The defining input — components are resolved to sum to
    #: exactly this.
    gross_monthly: Mapped[int] = mapped_column(Integer, nullable=False)

    #: Why the salary changed. Free text: "annual revision", "promotion to
    #: Senior Engineer", "correction". A letter cites it, so it is worth having.
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    components: Mapped[list["SalaryStructureComponent"]] = relationship(
        back_populates="structure", cascade="all, delete-orphan",
        order_by="SalaryStructureComponent.sort_order",
    )


class SalaryStructureComponent(UUIDMixin, TimestampMixin, Base):
    """One resolved line of one structure.

    The component's calculation rule and rate are **copied here**, not joined.
    That is the same argument ``issued_letters`` makes about its body: this row
    has to keep saying how the figure was arrived at even after somebody edits
    the catalogue entry, or a payslip reprinted next year explains itself wrongly.
    """

    __tablename__ = "salary_structure_components"
    __table_args__ = (
        UniqueConstraint("structure_id", "component_id",
                         name="uq_salary_structure_components"),
        Index("ix_salary_structure_components_structure", "structure_id"),
        CheckConstraint("amount >= 0", name="ck_salary_structure_components_amount"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    structure_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("salary_structures.id", ondelete="CASCADE"), nullable=False
    )
    #: RESTRICT: a component that has ever appeared on a structure is part of
    #: somebody's pay history and cannot be deleted. Deactivating retires one.
    component_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("pay_components.id", ondelete="RESTRICT"), nullable=False
    )

    #: Paise per month, resolved and frozen.
    amount: Mapped[int] = mapped_column(Integer, nullable=False)

    # --- snapshot of the catalogue entry, as it was ------------------------
    code: Mapped[str] = mapped_column(String(24), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    kind: Mapped[str] = mapped_column(String(12), nullable=False)
    calculation: Mapped[str] = mapped_column(String(20), nullable=False)
    rate_bps: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_pf_wage: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_esi_wage: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_taxable: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=100, nullable=False)

    structure: Mapped["SalaryStructure"] = relationship(back_populates="components")
