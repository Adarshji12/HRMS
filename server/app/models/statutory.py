"""Payroll, checkpoint 3: Indian statutory configuration.

**All money is integer paise; all rates are integer basis points.** 1200 bps is
12%. A rate as a decimal is the value that gets applied twice or halved.

Two tables:

**``statutory_configs`` is one row per company.** Not effective-dated, and that
is a deliberate, stated limit rather than an oversight. Rates change by
government notification, and a company that changes one mid-year would want past
months computed at the old rate — which is already what happens, because a
payslip freezes its own lines. Recomputing an *approved* month is refused
anyway, so the only case effective-dating would serve is recomputing a draft
month at a rate that has since changed, and that draft has not been paid.
Effective-dating this table is the right answer when somebody needs to run a
year-end reconciliation across a rate change; it is not needed to be correct
today, and a version-history table nobody reads is worse than a documented
limit.

**``professional_tax_slabs`` is many rows per company**, because PT is a state
tax with a slab table and no two states agree. A slab is a monthly-gross band
mapping to a flat amount. ``applies_in_month`` exists because several states
charge a different amount in one month of the year — Maharashtra's February is
the well-known one — and a config that cannot express it forces an annual manual
correction.

What is deliberately **not** here: TDS. Income tax needs declarations,
exemptions, a regime choice and a projection across the year; it is checkpoint 4
and modelling a slab table for it now would be modelling the easy tenth of it.
"""

from __future__ import annotations

import uuid

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    String,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDMixin

#: EPF statutory wage ceiling, in paise — ₹15,000 a month. A default, not a
#: constant: it has moved before and will again, so it lives in a column.
DEFAULT_PF_CEILING = 1_500_000

#: ESI applies below ₹21,000 a month, in paise.
DEFAULT_ESI_THRESHOLD = 2_100_000


class StatutoryConfig(UUIDMixin, TimestampMixin, Base):
    """What a company deducts, and at what rate."""

    __tablename__ = "statutory_configs"
    __table_args__ = (
        # One per company. A second would be two answers to "what is our PF
        # rate", and nothing in the computation could choose between them.
        Index("ix_statutory_configs_org", "org_id", unique=True),
        CheckConstraint(
            "pf_employee_rate_bps BETWEEN 0 AND 10000 "
            "AND pf_employer_rate_bps BETWEEN 0 AND 10000 "
            "AND pf_pension_rate_bps BETWEEN 0 AND 10000",
            name="ck_statutory_pf_rates",
        ),
        CheckConstraint(
            "esi_employee_rate_bps BETWEEN 0 AND 10000 "
            "AND esi_employer_rate_bps BETWEEN 0 AND 10000",
            name="ck_statutory_esi_rates",
        ),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )

    # --- Provident Fund ------------------------------------------------------
    pf_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    #: 12% employee, 12% employer, of which 8.33% goes to the pension scheme.
    pf_employee_rate_bps: Mapped[int] = mapped_column(Integer, default=1200, nullable=False)
    pf_employer_rate_bps: Mapped[int] = mapped_column(Integer, default=1200, nullable=False)
    #: The slice of the employer's 12% that goes to EPS rather than EPF. Stored
    #: because the split is what an ECR filing needs; a single employer figure
    #: would have to be broken apart by hand every month.
    pf_pension_rate_bps: Mapped[int] = mapped_column(Integer, default=833, nullable=False)
    #: Paise. Wages above this may be ignored, if the company caps.
    pf_wage_ceiling: Mapped[int] = mapped_column(
        Integer, default=DEFAULT_PF_CEILING, nullable=False
    )
    #: Whether to actually apply the ceiling. Many employers contribute on full
    #: wages instead, and both are legitimate — so it is a choice, not a
    #: constant, and getting it wrong silently changes everybody's take-home.
    pf_cap_at_ceiling: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    #: The pension slice is capped at the ceiling even when EPF is not. Separate
    #: switch because that is genuinely how the scheme works.
    pf_pension_cap_at_ceiling: Mapped[bool] = mapped_column(
        Boolean, default=True, nullable=False
    )

    # --- Employees' State Insurance -----------------------------------------
    esi_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    #: 0.75% employee, 3.25% employer.
    esi_employee_rate_bps: Mapped[int] = mapped_column(Integer, default=75, nullable=False)
    esi_employer_rate_bps: Mapped[int] = mapped_column(Integer, default=325, nullable=False)
    #: Paise a month. At or above this, ESI does not apply.
    esi_wage_threshold: Mapped[int] = mapped_column(
        Integer, default=DEFAULT_ESI_THRESHOLD, nullable=False
    )

    # --- Professional Tax ----------------------------------------------------
    pt_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    #: Free text: "Karnataka", "Maharashtra". Which slabs apply is decided by
    #: the slab rows, not by parsing this — it is a label for the screen.
    pt_state: Mapped[str | None] = mapped_column(String(80), nullable=True)

    # --- Labour Welfare Fund -------------------------------------------------
    lwf_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    #: Flat paise, not a rate. LWF is a fixed contribution wherever it applies.
    lwf_employee_amount: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    lwf_employer_amount: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    #: NULL = every month. Most states collect LWF once or twice a year, and a
    #: config that could not say which month would deduct it twelve times.
    lwf_month: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # --- Exit settlement -----------------------------------------------------
    # None of this affects a monthly payslip. It lives here because it is
    # company-wide statutory policy configured once, and a settlement screen
    # that carried its own copy of "how many days in an encashment month" would
    # be a second place for the same number to be wrong.

    #: Gratuity under the Payment of Gratuity Act, 1972. Off by default: it is
    #: due only after five years of continuous service, and a company with no
    #: employee near that has nothing to configure.
    gratuity_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    #: The Act says fifteen days' wages for each completed year, wages being
    #: last drawn basic + DA, and divides by 26 — the notional working days in a
    #: month. Both are configurable because some contracts are more generous,
    #: and neither is a number to hard-code into a settlement.
    gratuity_days_per_year: Mapped[int] = mapped_column(Integer, default=15, nullable=False)
    gratuity_month_days: Mapped[int] = mapped_column(Integer, default=26, nullable=False)
    #: ₹20,00,000, in paise. The statutory ceiling as it stands.
    gratuity_ceiling: Mapped[int] = mapped_column(
        Integer, default=200_000_000, nullable=False
    )

    #: Leave encashment divides a month's wage by this to get a day rate. 26 and
    #: 30 are both common and they differ by 15% — a difference big enough that
    #: guessing is not acceptable.
    encashment_month_days: Mapped[int] = mapped_column(Integer, default=26, nullable=False)
    #: True: encash on basic (+ DA) only, the usual reading. False: on gross.
    encashment_on_basic: Mapped[bool] = mapped_column(
        Boolean, default=True, nullable=False
    )


class ProfessionalTaxSlab(UUIDMixin, TimestampMixin, Base):
    """One band of a state's professional-tax table."""

    __tablename__ = "professional_tax_slabs"
    __table_args__ = (
        Index("ix_pt_slabs_org", "org_id", "min_gross"),
        CheckConstraint("min_gross >= 0 AND amount >= 0", name="ck_pt_slabs_amounts"),
        CheckConstraint(
            "max_gross IS NULL OR max_gross >= min_gross",
            name="ck_pt_slabs_range",
        ),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )

    #: Paise, inclusive.
    min_gross: Mapped[int] = mapped_column(Integer, nullable=False)
    #: Paise, inclusive. NULL means no upper bound — the top slab.
    max_gross: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: Flat paise deducted when gross falls in the band.
    amount: Mapped[int] = mapped_column(Integer, nullable=False)

    #: 1–12, or NULL for every month. Several states charge a different amount
    #: in one month of the year; a month-specific slab wins over a general one.
    applies_in_month: Mapped[int | None] = mapped_column(Integer, nullable=True)

    label: Mapped[str | None] = mapped_column(String(120), nullable=True)
