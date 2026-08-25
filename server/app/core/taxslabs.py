"""Indian income-tax slabs, by financial year and regime.

**In code, not in the database, and deliberately.** Slabs are national law, not
customer configuration: putting them in a table would duplicate the same rows
across every tenant and invite one company to "fix" them. More to the point, a
new Finance Act rarely changes only the numbers — it moves rebate thresholds,
adds surcharge bands, changes the standard deduction — so a new year needs a
code change anyway. What it must never do is *guess*: an unknown year raises
rather than falling back to the last one it knows, because a payslip computed
against last year's slabs is wrong in a way nobody notices until assessment.

**All money is integer paise.** A slab boundary of ₹4,00,000 is `40_000_000`.

**Marginal relief on surcharge is not implemented**, and that is a stated limit
rather than an omission: it applies only just above each surcharge threshold, it
needs an iterative comparison against the income at the threshold, and getting it
subtly wrong is worse than not offering it. Companies with employees near ₹50
lakh should check those cases by hand. Every other part of the computation is
exact.

**FY 2026-27 is marked provisional.** It is carried forward from 2025-26 because
the rates for it were not known when this was written; ``provisional`` is
surfaced through the API so a screen can say so rather than presenting a figure
with unearned confidence.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass
from datetime import date

LAKH = 10_000_000  # one lakh rupees, in paise


@dataclass(frozen=True)
class Slab:
    """Income above ``floor`` and up to ``ceiling`` is taxed at ``rate_bps``."""

    floor: int
    #: None for the top slab.
    ceiling: int | None
    rate_bps: int


@dataclass(frozen=True)
class SurchargeBand:
    above: int
    rate_bps: int


@dataclass(frozen=True)
class RegimeRules:
    slabs: tuple[Slab, ...]
    #: Flat deduction from salary income before the slabs apply.
    standard_deduction: int
    #: Section 87A: total income at or below ``rebate_limit`` pays no tax, up to
    #: a cap of ``rebate_cap``.
    rebate_limit: int
    rebate_cap: int
    surcharge: tuple[SurchargeBand, ...]
    #: Health and education cess, on tax plus surcharge.
    cess_bps: int
    #: Whether the regime allows Chapter VI-A deductions (80C, 80D…) and the
    #: usual exemptions. The new regime does not, which is the whole trade.
    allows_deductions: bool


#: Surcharge above ₹50 lakh. The new regime caps at 25% where the old goes to
#: 37% — one of the few places the two genuinely differ in structure rather than
#: in rate.
_OLD_SURCHARGE = (
    SurchargeBand(above=50 * LAKH, rate_bps=1000),
    SurchargeBand(above=100 * LAKH, rate_bps=1500),
    SurchargeBand(above=200 * LAKH, rate_bps=2500),
    SurchargeBand(above=500 * LAKH, rate_bps=3700),
)
_NEW_SURCHARGE = (
    SurchargeBand(above=50 * LAKH, rate_bps=1000),
    SurchargeBand(above=100 * LAKH, rate_bps=1500),
    SurchargeBand(above=200 * LAKH, rate_bps=2500),
)


class AgeBand(str, enum.Enum):
    """Which basic exemption applies under the old regime.

    Age is taken **at the end of the financial year**, which is how the Act
    reads: somebody turning 60 in March is a senior citizen for that whole year.
    Getting that wrong under-taxes or over-taxes them for eleven months.

    The new regime has no age variants at all — one more thing the trade buys.
    """

    BELOW_60 = "below_60"
    SENIOR = "senior"          # 60 to 79
    SUPER_SENIOR = "super_senior"   # 80 and over


_OLD_REGIME = RegimeRules(
    slabs=(
        Slab(0, int(2.5 * LAKH), 0),
        Slab(int(2.5 * LAKH), 5 * LAKH, 500),
        Slab(5 * LAKH, 10 * LAKH, 2000),
        Slab(10 * LAKH, None, 3000),
    ),
    standard_deduction=int(0.5 * LAKH),          # ₹50,000
    rebate_limit=5 * LAKH,
    rebate_cap=12_500_00,                        # ₹12,500
    surcharge=_OLD_SURCHARGE,
    cess_bps=400,
    allows_deductions=True,
)


def _old_with_exemption(basic_exemption: int) -> RegimeRules:
    """The old regime with a wider nil band, and nothing else changed.

    Built from ``_OLD_REGIME`` rather than written out three times: only the
    first slab's ceiling moves, and three hand-copied tables are three places for
    a Finance Act to be applied to two of them.
    """
    rest = tuple(
        slab for slab in _OLD_REGIME.slabs if slab.ceiling is None
        or slab.ceiling > basic_exemption
    )
    adjusted = []
    for slab in rest:
        floor = max(slab.floor, basic_exemption)
        if slab.ceiling is not None and floor >= slab.ceiling:
            continue
        adjusted.append(Slab(floor, slab.ceiling, slab.rate_bps))
    return RegimeRules(
        slabs=(Slab(0, basic_exemption, 0), *adjusted),
        standard_deduction=_OLD_REGIME.standard_deduction,
        rebate_limit=_OLD_REGIME.rebate_limit,
        rebate_cap=_OLD_REGIME.rebate_cap,
        surcharge=_OLD_REGIME.surcharge,
        cess_bps=_OLD_REGIME.cess_bps,
        allows_deductions=True,
    )


#: 60–79: ₹3,00,000 nil band. 80 and over: ₹5,00,000.
_OLD_SENIOR = _old_with_exemption(3 * LAKH)
_OLD_SUPER_SENIOR = _old_with_exemption(5 * LAKH)


#: New regime as it stands after the 2025 Budget.
_NEW_REGIME_2025 = RegimeRules(
    slabs=(
        Slab(0, 4 * LAKH, 0),
        Slab(4 * LAKH, 8 * LAKH, 500),
        Slab(8 * LAKH, 12 * LAKH, 1000),
        Slab(12 * LAKH, 16 * LAKH, 1500),
        Slab(16 * LAKH, 20 * LAKH, 2000),
        Slab(20 * LAKH, 24 * LAKH, 2500),
        Slab(24 * LAKH, None, 3000),
    ),
    standard_deduction=int(0.75 * LAKH),         # ₹75,000
    rebate_limit=12 * LAKH,
    rebate_cap=60_000_00,                        # ₹60,000
    surcharge=_NEW_SURCHARGE,
    cess_bps=400,
    #: The trade the new regime makes: lower rates, no Chapter VI-A.
    allows_deductions=False,
)


@dataclass(frozen=True)
class YearRules:
    label: str
    old: RegimeRules
    new: RegimeRules
    #: True when the rates were carried forward rather than legislated —
    #: surfaced so a screen can say so instead of implying certainty.
    provisional: bool = False


#: Keyed by the year the financial year *starts*: 2025 is FY 2025-26.
YEARS: dict[int, YearRules] = {
    2025: YearRules("FY 2025-26", _OLD_REGIME, _NEW_REGIME_2025),
    # Carried forward. Marked provisional rather than omitted, because a payroll
    # that refuses to compute is worse than one that computes and says so.
    2026: YearRules("FY 2026-27", _OLD_REGIME, _NEW_REGIME_2025, provisional=True),
}


class UnknownYear(Exception):
    """No slab table for that financial year."""


def financial_year_of(year: int, month: int) -> int:
    """Which financial year a calendar month falls in.

    India's runs April to March, so January 2027 is FY 2026-27 and returns
    ``2026``. One function, because a module that computes this inline gets it
    wrong for exactly three months of the year.
    """
    return year if month >= 4 else year - 1


def rules_for(
    financial_year: int, regime: str, age_band: str = AgeBand.BELOW_60.value
) -> RegimeRules:
    """The slab table, or ``UnknownYear``.

    Never falls back to an adjacent year. A payslip computed against last year's
    slabs is wrong in a way nobody notices until assessment.

    ``age_band`` only affects the old regime; the new one has no age variants,
    so passing a band with it is harmless rather than an error — the caller
    reads the band off a date of birth without knowing which regime applies.
    """
    year = YEARS.get(financial_year)
    if year is None:
        raise UnknownYear(
            f"No income-tax slabs are configured for FY {financial_year}-"
            f"{str(financial_year + 1)[-2:]}."
        )
    if regime == "new":
        return year.new
    if age_band == AgeBand.SUPER_SENIOR.value:
        return _OLD_SUPER_SENIOR
    if age_band == AgeBand.SENIOR.value:
        return _OLD_SENIOR
    return year.old


def age_band_on(date_of_birth, financial_year: int) -> str:
    """Which band somebody falls in for a financial year.

    Age at **31 March** of the year it ends, per the Act: somebody turning 60 in
    March is a senior citizen for the whole of that year. A null date of birth is
    the ordinary band rather than an error — most records do not have one, and
    refusing to run payroll over a missing birthday would be absurd.
    """
    if date_of_birth is None:
        return AgeBand.BELOW_60.value
    end = date(financial_year + 1, 3, 31)
    age = end.year - date_of_birth.year - (
        (end.month, end.day) < (date_of_birth.month, date_of_birth.day)
    )
    if age >= 80:
        return AgeBand.SUPER_SENIOR.value
    if age >= 60:
        return AgeBand.SENIOR.value
    return AgeBand.BELOW_60.value


def year_label(financial_year: int) -> str:
    year = YEARS.get(financial_year)
    return year.label if year else (
        f"FY {financial_year}-{str(financial_year + 1)[-2:]}"
    )


def is_provisional(financial_year: int) -> bool:
    year = YEARS.get(financial_year)
    return bool(year and year.provisional)
