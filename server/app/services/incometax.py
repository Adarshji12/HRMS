"""Income tax: the annual liability, and the monthly TDS that pays it.

**Pure arithmetic, like ``services/statutory``.** No session, no ORM. This is the
part of payroll that gets checked against a tax calculator, and a function that
also queries cannot be read against one.

Two computations, and the second is where payroll differs from a tax calculator:

**The annual liability** is slabs, then rebate, then surcharge, then cess, in
that order — and the order is not negotiable. Cess is on tax *plus* surcharge;
rebate applies before surcharge because a rebated liability of zero has nothing
to surcharge.

**Monthly TDS is a projection, not a slab lookup.** The year's estimated
liability, less what has already been deducted, spread over the months that
remain. That is why somebody's TDS changes when they declare an investment in
December: the remaining months absorb the whole correction. A payroll that
divided the annual figure by twelve every month would under-deduct all year and
then take an impossible amount in March.

**Deductions are honoured on declaration until proof is due, then on proof.**
That is what employers actually do, and the caller decides which by passing the
figure it wants used — this module does not reach for a policy it cannot see.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.core.taxslabs import RegimeRules, rules_for

#: The old regime allows these; the new regime allows none of them. Kept here
#: rather than in the model so the computation is readable on its own — the
#: model stores whatever section string the company used, and unknown ones are
#: simply summed rather than refused.
DEDUCTION_SECTIONS = (
    "80C", "80CCD1B", "80D", "80E", "80G", "80TTA", "80TTB", "24B", "HRA", "LTA",
)

#: Statutory caps, in paise. Applied per section so a declaration of ₹3,00,000
#: under 80C contributes ₹1,50,000 — the employee is not refused, they are
#: capped, which is what the return would do anyway.
SECTION_CAPS: dict[str, int] = {
    "80C": 150_000_00,
    "80CCD1B": 50_000_00,
    "80D": 100_000_00,      # the ceiling with senior-citizen parents
    "80TTA": 10_000_00,
    "80TTB": 50_000_00,
    "24B": 200_000_00,      # self-occupied home-loan interest
}


@dataclass(frozen=True)
class TaxBreakdown:
    """Every intermediate figure, because a payslip has to explain itself."""

    gross_income: int
    standard_deduction: int
    chapter_via: int
    professional_tax: int
    taxable_income: int
    tax_before_rebate: int
    rebate: int
    surcharge: int
    cess: int
    total_tax: int
    regime: str
    financial_year: int
    #: Which basic exemption applied. Only meaningful under the old regime.
    age_band: str = "below_60"
    #: Per-slab working, so a screen can show where each rupee was taxed.
    slab_working: tuple[tuple[str, int, int], ...] = ()


def cap_deductions(items: dict[str, int]) -> tuple[int, dict[str, int]]:
    """Apply the per-section statutory caps.

    Returns the total and the capped figures. An over-declaration is capped
    rather than refused: the return would cap it anyway, and refusing means an
    employee cannot record what they actually invested.
    """
    capped: dict[str, int] = {}
    for section, amount in items.items():
        limit = SECTION_CAPS.get(section)
        capped[section] = min(amount, limit) if limit is not None else amount
    return sum(capped.values()), capped


def _slab_tax(taxable: int, rules: RegimeRules) -> tuple[int, list[tuple[str, int, int]]]:
    """Tax on ``taxable`` and the per-slab working.

    Each slab taxes only the income *within* it. Integer throughout, rounding
    half-up once per slab — the alternative, one rounding at the end, differs by
    at most a rupee and makes the working not add up to the total, which is worse
    on a payslip somebody is querying.
    """
    total = 0
    working: list[tuple[str, int, int]] = []
    for slab in rules.slabs:
        if taxable <= slab.floor:
            break
        top = taxable if slab.ceiling is None else min(taxable, slab.ceiling)
        amount = top - slab.floor
        if amount <= 0:
            continue
        tax = (amount * slab.rate_bps + 5_000) // 10_000
        total += tax
        label = (
            f"{slab.floor / 100:,.0f}–{slab.ceiling / 100:,.0f}"
            if slab.ceiling is not None
            else f"above {slab.floor / 100:,.0f}"
        )
        working.append((f"{label} @ {slab.rate_bps / 100:g}%", amount, tax))
    return total, working


def _surcharge(tax: int, total_income: int, rules: RegimeRules) -> int:
    """Surcharge on the tax, by income band.

    **Marginal relief is not applied** — see ``core.taxslabs``. It matters only
    just above each threshold, and an approximate implementation is worse than an
    absent one that is documented.
    """
    rate = 0
    for band in rules.surcharge:
        if total_income > band.above:
            rate = band.rate_bps
    return (tax * rate + 5_000) // 10_000 if rate else 0


def annual_tax(
    *,
    gross_income: int,
    financial_year: int,
    regime: str,
    deductions: dict[str, int] | None = None,
    professional_tax: int = 0,
    age_band: str = "below_60",
) -> TaxBreakdown:
    """The year's liability, with every intermediate figure.

    ``gross_income`` is taxable salary for the year — the components a company
    flagged ``is_taxable``, annualised by the caller. Exempt allowances are the
    caller's business; this takes what is taxable.

    Under the **new regime** Chapter VI-A deductions and the professional-tax
    deduction do not apply, and passing them is not an error — they are ignored,
    because the caller often does not know which regime the employee chose until
    it reads the declaration, and making it branch would duplicate that check.
    """
    rules = rules_for(financial_year, regime, age_band)

    standard = min(rules.standard_deduction, max(0, gross_income))
    if rules.allows_deductions:
        chapter_via, _ = cap_deductions(deductions or {})
        pt = professional_tax
    else:
        # Ignored rather than refused. The caller reads the regime off the
        # declaration and passes what it has; branching here would be a second
        # place that knows the new regime disallows them.
        chapter_via = 0
        pt = 0

    taxable = max(0, gross_income - standard - chapter_via - pt)

    tax, working = _slab_tax(taxable, rules)

    # Rebate before surcharge: a liability rebated to zero has nothing to
    # surcharge, and applying them the other way round produces surcharge on tax
    # that is about to be forgiven.
    rebate = min(tax, rules.rebate_cap) if taxable <= rules.rebate_limit else 0
    after_rebate = tax - rebate

    surcharge = _surcharge(after_rebate, taxable, rules)
    cess = ((after_rebate + surcharge) * rules.cess_bps + 5_000) // 10_000

    return TaxBreakdown(
        gross_income=gross_income,
        standard_deduction=standard,
        chapter_via=chapter_via,
        professional_tax=pt,
        taxable_income=taxable,
        tax_before_rebate=tax,
        rebate=rebate,
        surcharge=surcharge,
        cess=cess,
        total_tax=after_rebate + surcharge + cess,
        regime=regime,
        financial_year=financial_year,
        age_band=age_band,
        slab_working=tuple(working),
    )


@dataclass(frozen=True)
class MonthlyTds:
    annual: TaxBreakdown
    #: What has already been deducted this financial year.
    already_deducted: int
    months_remaining: int
    #: What to take this month.
    amount: int


def monthly_tds(
    *,
    breakdown: TaxBreakdown,
    already_deducted: int,
    months_remaining: int,
) -> MonthlyTds:
    """Spread the remaining liability over the months that are left.

    Not the annual figure divided by twelve. TDS is a projection that corrects
    itself: when somebody declares an investment in December, the remaining three
    months absorb the whole difference, and if they have already over-paid the
    deduction drops to zero rather than going negative.

    ``months_remaining`` includes the month being computed, so March is 1 and the
    last month always clears whatever is outstanding.
    """
    outstanding = max(0, breakdown.total_tax - already_deducted)
    if months_remaining <= 0:
        # Past the year end: whatever is left is taken now, because there is no
        # later month to spread it over.
        amount = outstanding
    else:
        # Rounded up, so twelve monthly deductions never leave a rupee unpaid
        # that March would have to find.
        amount = -(-outstanding // months_remaining)
    return MonthlyTds(
        annual=breakdown,
        already_deducted=already_deducted,
        months_remaining=months_remaining,
        amount=min(amount, outstanding),
    )


def months_left_in_year(month: int) -> int:
    """How many pay months remain, counting this one.

    April is 12, March is 1. The financial year is the thing being counted, not
    the calendar one, which is why this is a function and not ``12 - month``.
    """
    return (12 - month + 4) % 12 or 12


def project_annual_income(
    *,
    earned_so_far: int,
    current_month_taxable: int,
    months_remaining: int,
) -> int:
    """Estimated taxable salary for the whole year.

    What has actually been paid, plus this month and every month left at the
    current rate. A salary revision therefore re-projects from the month it takes
    effect, which is what makes TDS follow a raise instead of being wrong until
    March.
    """
    return earned_so_far + current_month_taxable * max(0, months_remaining)
