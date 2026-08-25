"""Indian statutory computation: PF, ESI, professional tax, LWF.

**Pure arithmetic, no session, no ORM writes.** ``compute`` takes the wage bases
and a configuration and returns lines. That is deliberate: statutory rules are
the part of payroll that must be checkable against a printed circular, and a
function that also queries and writes cannot be read against one. The pay run
service does the reading and the writing; this decides the numbers.

The rules, and where each is easy to get wrong:

**PF is on PF wages, which is not gross.** It is the components a company has
flagged ``is_pf_wage`` — conventionally basic and DA. The ₹15,000 ceiling is
optional, because contributing on full wages is equally legitimate and common;
what is *not* optional in practice is that the pension slice stays capped even
when EPF does not, which is why those are two switches.

**The employer's 12% splits.** 8.33% goes to the pension scheme (EPS), the rest
to EPF. An ECR filing needs the two separately, so computing one employer number
and halving it later is not enough — and the pension slice rounds first, with
EPF taking the remainder, so the two always add to the employer total exactly.

**ESI is a threshold, not a slab.** At or above ₹21,000 a month it does not
apply at all. Below it, both sides pay on the *whole* ESI wage — there is no
ceiling, which is the opposite of PF and the mistake somebody makes once.

**Professional tax is a state slab table on gross**, and gross here means
salary, not salary plus a reimbursement. Reimbursing somebody's taxi fare must
not push them into a higher PT band.

**Rounding is half-up, once per figure.** Every rate is basis points and every
amount is paise, so the arithmetic is integer throughout and the only rounding
is the final division.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class StatutoryLine:
    """One computed line, ready for the pay run service to store.

    ``employer`` distinguishes a deduction from the employee from a contribution
    the company makes on top. Both are positive; nothing here is signed.
    """

    code: str
    name: str
    amount: int
    #: The ``LineSource`` value this belongs to — "pf", "esi", …
    source: str
    detail: str | None = None
    employer: bool = False
    sort_order: int = 700


@dataclass
class StatutoryResult:
    employee_lines: list[StatutoryLine] = field(default_factory=list)
    employer_lines: list[StatutoryLine] = field(default_factory=list)

    @property
    def employee_total(self) -> int:
        return sum(line.amount for line in self.employee_lines)

    @property
    def employer_total(self) -> int:
        return sum(line.amount for line in self.employer_lines)


def bps_of(amount: int, bps: int) -> int:
    """``bps`` basis points of ``amount``, rounded half-up, in paise.

    Integer throughout with a single rounding step. Reused rather than
    reimplemented per contribution, so PF and ESI cannot round differently.
    """
    if amount <= 0 or bps <= 0:
        return 0
    return (amount * bps + 5_000) // 10_000


def pt_amount(slabs, *, gross: int, month: int) -> tuple[int, str | None]:
    """The professional tax for this gross in this month, and which slab.

    A slab naming the month wins over a general one covering the same band —
    several states charge a different amount in one month of the year, and the
    month-specific row is the exception the general row is the rule for.

    Returns ``(0, None)`` when nothing matches, rather than guessing at the
    nearest band: a gross that falls outside every configured slab means the
    slab table is incomplete, and inventing a figure would hide that.
    """
    matching = [
        slab
        for slab in slabs
        if slab.min_gross <= gross and (slab.max_gross is None or gross <= slab.max_gross)
    ]
    if not matching:
        return 0, None
    # Month-specific first; then the widest band is irrelevant because bands do
    # not overlap by construction, so any remaining match is the one.
    for slab in matching:
        if slab.applies_in_month == month:
            return slab.amount, slab.label
    for slab in matching:
        if slab.applies_in_month is None:
            return slab.amount, slab.label
    return 0, None


def compute(
    config,
    *,
    pf_wage: int,
    esi_wage: int,
    pt_gross: int,
    month: int,
    pt_slabs=(),
    pf_applicable: bool | None = None,
    esi_applicable: bool | None = None,
) -> StatutoryResult:
    """Every statutory line for one payslip.

    ``pf_applicable`` and ``esi_applicable`` are the per-employee overrides:
    ``None`` means follow the company setting, which is the answer for almost
    everybody. A director or an international contractor is the reason they
    exist.

    All three wage bases are passed in rather than derived here, because "which
    components count as PF wages" is a decision the company made when it flagged
    its pay components, and re-deriving it would be a second answer to a question
    that already has one.
    """
    result = StatutoryResult()
    if config is None:
        return result

    # --- Provident Fund ------------------------------------------------------
    pf_on = config.pf_enabled if pf_applicable is None else pf_applicable
    if pf_on and pf_wage > 0:
        base = (
            min(pf_wage, config.pf_wage_ceiling)
            if config.pf_cap_at_ceiling else pf_wage
        )
        pension_base = (
            min(pf_wage, config.pf_wage_ceiling)
            if config.pf_pension_cap_at_ceiling else pf_wage
        )
        capped = config.pf_cap_at_ceiling and pf_wage > config.pf_wage_ceiling

        employee = bps_of(base, config.pf_employee_rate_bps)
        if employee:
            result.employee_lines.append(
                StatutoryLine(
                    code="PF", name="Provident Fund", amount=employee, source="pf",
                    detail=(
                        f"{config.pf_employee_rate_bps / 100:g}% of "
                        f"{base / 100:,.2f}" + (" (capped)" if capped else "")
                    ),
                    sort_order=700,
                )
            )

        employer_total = bps_of(base, config.pf_employer_rate_bps)
        if employer_total:
            pension = bps_of(pension_base, config.pf_pension_rate_bps)
            # The pension slice can exceed the total when the employer rate is
            # capped and the pension one is not; clamped so the two halves never
            # sum to more than the whole.
            pension = min(pension, employer_total)
            # EPF takes the remainder rather than being rounded on its own, so
            # the split always adds back to the employer total exactly.
            epf = employer_total - pension
            if pension:
                result.employer_lines.append(
                    StatutoryLine(
                        code="EPS", name="Pension scheme (employer)", amount=pension,
                        source="pf", employer=True,
                        detail=f"{config.pf_pension_rate_bps / 100:g}% of "
                               f"{pension_base / 100:,.2f}",
                        sort_order=710,
                    )
                )
            if epf:
                result.employer_lines.append(
                    StatutoryLine(
                        code="EPF", name="Provident Fund (employer)", amount=epf,
                        source="pf", employer=True,
                        detail="employer share less pension",
                        sort_order=711,
                    )
                )

    # --- Employees' State Insurance -----------------------------------------
    esi_on = config.esi_enabled if esi_applicable is None else esi_applicable
    # A threshold, not a slab: at or above it, ESI does not apply at all, and
    # below it both sides pay on the whole wage with no ceiling.
    if esi_on and 0 < esi_wage < config.esi_wage_threshold:
        employee = bps_of(esi_wage, config.esi_employee_rate_bps)
        if employee:
            result.employee_lines.append(
                StatutoryLine(
                    code="ESI", name="Employees' State Insurance", amount=employee,
                    source="esi",
                    detail=f"{config.esi_employee_rate_bps / 100:g}% of "
                           f"{esi_wage / 100:,.2f}",
                    sort_order=720,
                )
            )
        employer = bps_of(esi_wage, config.esi_employer_rate_bps)
        if employer:
            result.employer_lines.append(
                StatutoryLine(
                    code="ESI_ER", name="ESI (employer)", amount=employer,
                    source="esi", employer=True,
                    detail=f"{config.esi_employer_rate_bps / 100:g}% of "
                           f"{esi_wage / 100:,.2f}",
                    sort_order=721,
                )
            )

    # --- Professional tax ----------------------------------------------------
    if config.pt_enabled:
        amount, label = pt_amount(pt_slabs, gross=pt_gross, month=month)
        if amount:
            result.employee_lines.append(
                StatutoryLine(
                    code="PT", name="Professional Tax", amount=amount,
                    source="professional_tax",
                    detail=label or (config.pt_state or None),
                    sort_order=730,
                )
            )

    # --- Labour Welfare Fund -------------------------------------------------
    # NULL month means every month; most states collect once or twice a year and
    # a config that could not say so would deduct it twelve times.
    if config.lwf_enabled and (config.lwf_month is None or config.lwf_month == month):
        if config.lwf_employee_amount:
            result.employee_lines.append(
                StatutoryLine(
                    code="LWF", name="Labour Welfare Fund",
                    amount=config.lwf_employee_amount, source="lwf",
                    sort_order=740,
                )
            )
        if config.lwf_employer_amount:
            result.employer_lines.append(
                StatutoryLine(
                    code="LWF_ER", name="Labour Welfare Fund (employer)",
                    amount=config.lwf_employer_amount, source="lwf", employer=True,
                    sort_order=741,
                )
            )

    return result
