"""Full-and-final settlement: computing one, and recording what was settled.

The shape of this module is one decision:

> **A proposal is computed. A settlement is recorded. They are different things
> and they are stored differently.**

:func:`propose` reads live data and returns an itemised breakdown. It writes
nothing. HR looks at it, argues with it, changes the notice recovery to zero
because the manager waived it, and *then* calls :func:`accept`, which writes the
lines and the three numbers onto the existing ``OffboardingFnf`` record.

Everything after that is the offboarding module's existing flow — draft,
approved, paid — unchanged, because it was already right.

What a settlement is made of, and where each piece comes from
-------------------------------------------------------------

============================  =========================================
Salary to the last day        the salary structure, prorated
Leave encashment              encashable balances × a day rate
Gratuity                      Payment of Gratuity Act, 1972
Notice pay or recovery        contract notice vs notice actually served
Unpaid expense claims         approved, never reimbursed
Statutory                     PF / ESI / PT on the final salary
Loans                         outstanding principal, recovered in full
============================  =========================================

**Income tax is not a line, and that is deliberate.** Taxing a settlement
correctly means re-projecting the whole financial year with the settlement in it,
and several of its components are taxed differently from salary — gratuity is
exempt up to a ceiling, leave encashment has its own exemption. Producing a
plausible TDS figure here would be producing a wrong one. What :func:`propose`
does instead is report the **year-to-date tax position** — salary paid, tax
already deducted — as advisory context, and say in words that the final tax
treatment needs review. A number nobody checked, sitting in a settlement, is
worse than an absence somebody has to resolve.

Refusals, and why each is a refusal rather than a zero
-----------------------------------------------------

A settlement is the last money a company owes somebody, and it is the document
most likely to be argued about. So the proposal refuses rather than guessing
when it has no basis:

* **No last working day** — every figure here is "as at" that date.
* **No salary structure** — there is nothing to prorate, encash or gratuity.

And it *warns* rather than refusing where a missing input has a defensible
reading: a missing notice period is reported as unknown (no recovery), a missing
joining date suppresses gratuity, an absent statutory config means no statutory
deductions. Each of those appears in ``warnings`` so nobody mistakes an empty
line for a computed zero.
"""

from __future__ import annotations

import calendar
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timezone

from fastapi import HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.corehr import EmployeeProfile
from app.models.expenses import ClaimStatus, ExpenseClaim
from app.models.leave import LeaveType
from app.models.loans import Loan, LoanStatus
from app.models.offboarding import FnfStatus, OffboardingFnf, OffboardingRequest
from app.models.payrun import PayRun, PayRunStatus, Payslip, PayslipLine
from app.models.settlement import FnfLine, FnfLineKind, FnfSource
from app.models.statutory import ProfessionalTaxSlab, StatutoryConfig
from app.models.user import User
from app.services import leave as leave_svc
from app.services import loans as loan_svc
from app.services import payroll as payroll_svc
from app.services import payrun as payrun_svc
from app.services import statutory as statutory_svc
from app.api.deps import audit


class SettlementError(HTTPException):
    """A typed refusal, in this module's house style.

    ``{"reason": <code>, "message": <sentence>}`` — the same shape every other
    module here refuses with, so one client-side handler covers all of them.
    """

    def __init__(self, code: str, message: str, status_code: int = 422) -> None:
        super().__init__(status_code, detail={"reason": code, "message": message})
        self.code = code


# --------------------------------------------------------------------------- #
# The computed shape
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class ProposedLine:
    """One line of a proposal, before anybody has agreed to it."""

    kind: FnfLineKind
    code: str
    label: str
    amount: int
    source: FnfSource
    source_id: uuid.UUID | None = None
    detail: str | None = None
    sort_order: int = 0


@dataclass(slots=True)
class Proposal:
    """A settlement as computed. Nothing here is stored until :func:`accept`."""

    request_id: uuid.UUID
    user_id: uuid.UUID
    user_name: str
    last_working_day: date
    lines: list[ProposedLine] = field(default_factory=list)
    #: Free-form notes about inputs that were missing or assumptions made.
    #: Shown to HR; never silently swallowed.
    warnings: list[str] = field(default_factory=list)
    #: Advisory tax context — see the module docstring on why TDS is not a line.
    tax_paid_ytd: int = 0
    tax_deducted_ytd: int = 0
    currency: str = "INR"

    @property
    def gross_dues(self) -> int:
        return sum(l.amount for l in self.lines if l.kind is FnfLineKind.EARNING)

    @property
    def deductions(self) -> int:
        return sum(l.amount for l in self.lines if l.kind is FnfLineKind.DEDUCTION)

    @property
    def net_payable(self) -> int:
        """Can be negative — a leaver with a large loan owes the company money.

        Not clamped to zero. A settlement showing ₹0 when ₹40,000 is owed is a
        settlement that quietly writes off a debt.
        """
        return self.gross_dues - self.deductions


# --------------------------------------------------------------------------- #
# Permissions
# --------------------------------------------------------------------------- #


def can_settle(viewer: User) -> bool:
    """Whoever may manage payroll may compute a settlement.

    A settlement discloses somebody's salary, their leave balance and their
    loans. That is the payroll capability, not the offboarding one — an HR
    coordinator who runs exit checklists has no business seeing a salary. The
    offboarding router's own gate still applies on top; this narrows, it does
    not widen.
    """
    return payroll_svc.can_manage(viewer)


def _require_settler(viewer: User) -> None:
    if not can_settle(viewer):
        raise SettlementError(
            "not_permitted",
            "Computing a settlement needs the payroll permission — it discloses "
            "salary, leave balance and loans.",
            403,
        )


# --------------------------------------------------------------------------- #
# Pieces of the calculation
# --------------------------------------------------------------------------- #


def completed_years(joined_on: date, until: date) -> tuple[int, int]:
    """Years of continuous service, and the leftover months.

    Returned as a pair rather than a rounded figure because gratuity rounds and
    eligibility does not: four years and eleven months is **not** five years for
    eligibility, while five years and seven months *is* six years for the
    calculation. One function answering both questions with one number would get
    one of them wrong.
    """
    years = until.year - joined_on.year
    months = until.month - joined_on.month
    if until.day < joined_on.day:
        months -= 1
    if months < 0:
        years -= 1
        months += 12
    return max(years, 0), max(months, 0)


def gratuity_amount(config, *, wage: int, years: int, months: int) -> int:
    """Fifteen days' wages per completed year, on the Act's own arithmetic.

    Six months or more rounds the year up — s.4(2) — so five years eleven months
    is paid as six. Capped at the statutory ceiling.
    """
    payable_years = years + (1 if months >= 6 else 0)
    raw = wage * config.gratuity_days_per_year * payable_years
    # One division at the end, not per year: dividing per year and summing
    # loses paise every year and the loss compounds with service length.
    amount = raw // max(config.gratuity_month_days, 1)
    return min(amount, config.gratuity_ceiling), payable_years


def _profile_for(db: Session, user_id: uuid.UUID) -> EmployeeProfile | None:
    return db.scalar(
        select(EmployeeProfile).where(EmployeeProfile.user_id == user_id)
    )


def _already_paid_for_month(
    db: Session, org_id: uuid.UUID, user_id: uuid.UUID, day: date
) -> bool:
    """Whether a frozen pay run already covers the month the exit falls in.

    If it does, the final month's salary has been paid through payroll and must
    not appear again in the settlement. This is the single most expensive
    mistake this module could make, so it is checked rather than assumed — and
    only *frozen* runs count, because a draft can still be recomputed to exclude
    a leaver.
    """
    return db.scalar(
        select(func.count(Payslip.id))
        .join(PayRun, PayRun.id == Payslip.run_id)
        .where(
            Payslip.org_id == org_id,
            Payslip.user_id == user_id,
            PayRun.period_year == day.year,
            PayRun.period_month == day.month,
            PayRun.status.in_(
                (PayRunStatus.APPROVED.value, PayRunStatus.PAID.value)
            ),
        )
    ) > 0


def _tax_position(
    db: Session, org_id: uuid.UUID, user_id: uuid.UUID, upto: date
) -> tuple[int, int]:
    """Salary paid and tax deducted in the financial year, from frozen payslips.

    Frozen only, for the reason the year-end reconciliation gives: a draft is a
    working figure, and a settlement that moves when somebody recomputes an
    unrelated month is not a settlement.
    """
    start = date(upto.year if upto.month >= 4 else upto.year - 1, 4, 1)
    frozen = (
        PayRun.status.in_((PayRunStatus.APPROVED.value, PayRunStatus.PAID.value)),
        # Year and month compared as one number rather than as a pair of
        # ranges: `(year, month) >= (2026, 4)` has no SQL spelling, and two
        # separate BETWEENs would let March of the wrong year through.
        PayRun.period_year * 100 + PayRun.period_month
        >= start.year * 100 + start.month,
        PayRun.period_year * 100 + PayRun.period_month
        <= upto.year * 100 + upto.month,
    )
    paid = db.scalar(
        select(func.coalesce(func.sum(Payslip.gross), 0))
        .join(PayRun, PayRun.id == Payslip.run_id)
        .where(Payslip.org_id == org_id, Payslip.user_id == user_id, *frozen)
    ) or 0
    deducted = db.scalar(
        select(func.coalesce(func.sum(PayslipLine.amount), 0))
        .join(Payslip, Payslip.id == PayslipLine.payslip_id)
        .join(PayRun, PayRun.id == Payslip.run_id)
        .where(
            Payslip.org_id == org_id, Payslip.user_id == user_id,
            PayslipLine.code == "TDS", *frozen,
        )
    ) or 0
    return int(paid), int(deducted)


# --------------------------------------------------------------------------- #
# The proposal
# --------------------------------------------------------------------------- #


def propose(
    db: Session,
    viewer: User,
    request_id: uuid.UUID,
) -> Proposal:
    """Compute a settlement from live data. Writes nothing.

    Read the module docstring first — particularly on income tax, and on which
    missing inputs refuse and which warn.
    """
    _require_settler(viewer)

    req = db.scalar(
        select(OffboardingRequest).where(
            OffboardingRequest.org_id == viewer.org_id,
            OffboardingRequest.id == request_id,
        )
    )
    # 404 on a cross-tenant miss, not 403: whether another company has an exit
    # with this id is not something an answer here should reveal.
    if req is None:
        raise SettlementError("not_found", "No such exit.", 404)

    if req.last_working_day is None:
        raise SettlementError(
            "no_last_working_day",
            "Set the last working day first — every figure in a settlement is "
            "as at that date.",
            409,
        )

    lwd = req.last_working_day
    employee = req.user
    proposal = Proposal(
        request_id=req.id,
        user_id=employee.id,
        user_name=employee.full_name,
        last_working_day=lwd,
    )

    structure = payroll_svc.structure_on(db, viewer.org_id, employee.id, lwd)
    if structure is None:
        raise SettlementError(
            "no_salary_structure",
            f"{employee.full_name} has no salary structure effective on {lwd}. "
            "A settlement cannot be computed without one.",
            409,
        )

    components = {line.component_id: line for line in structure.components}
    # The basic figure the Act and most encashment policies mean. `is_basic`
    # lives on the catalogue component, not on the structure line — a structure
    # line copies the figures that must not move when the catalogue is edited,
    # and which component *is* basic is not one of those.
    basic_component = payroll_svc.basic_component(db, viewer.org_id)
    basic_monthly = (
        components[basic_component.id].amount
        if basic_component is not None and basic_component.id in components
        else 0
    )
    gross_monthly = structure.gross_monthly
    if not basic_monthly:
        proposal.warnings.append(
            "No component is flagged as basic, so leave encashment and gratuity "
            "have been computed on gross instead."
        )
        basic_monthly = gross_monthly

    config, pt_slabs = payrun_svc._statutory_setup(db, viewer.org_id)
    if config is None:
        proposal.warnings.append(
            "No statutory configuration, so no PF, ESI or professional tax has "
            "been deducted from the final salary."
        )

    # --- 1. salary for the final part-month ---------------------------------- #
    month_days = calendar.monthrange(lwd.year, lwd.month)[1]
    if _already_paid_for_month(db, viewer.org_id, employee.id, lwd):
        proposal.warnings.append(
            f"A frozen pay run already covers {lwd.strftime('%B %Y')}, so no "
            "salary for the final month is included here."
        )
        final_salary = 0
        payable_days = 0
    else:
        payable_days = lwd.day
        amounts = [line.amount for line in structure.components]
        prorated = payrun_svc.prorate(
            amounts, payable_days=payable_days, month_days=month_days
        )
        final_salary = sum(prorated)
        proposal.lines.append(ProposedLine(
            kind=FnfLineKind.EARNING, code="SALARY",
            label=f"Salary for {lwd.strftime('%B %Y')}",
            amount=final_salary, source=FnfSource.SALARY,
            detail=f"{payable_days} of {month_days} days on a monthly gross of "
                   f"{gross_monthly / 100:,.2f}",
            sort_order=100,
        ))

    # --- 2. leave encashment -------------------------------------------------- #
    day_basis = basic_monthly if config is None or config.encashment_on_basic \
        else gross_monthly
    encash_days = max(config.encashment_month_days, 1) if config else 26
    day_rate = day_basis // encash_days
    resolved = leave_svc.resolve_settings(db, viewer.org_id)
    encashable = list(db.scalars(
        select(LeaveType).where(
            LeaveType.org_id == viewer.org_id,
            LeaveType.is_encashable.is_(True),
            LeaveType.is_active.is_(True),
        ).order_by(LeaveType.name)
    ))
    if not encashable:
        proposal.warnings.append(
            "No leave type is marked encashable, so nothing has been paid out "
            "for unused leave."
        )
    for leave_type in encashable:
        view = leave_svc.balance_view(
            db, user=employee, leave_type=leave_type, on=lwd, resolved=resolved
        )
        milli = max(view.available_milli_days, 0)
        if milli <= 0:
            continue
        amount = (day_rate * milli) // 1000
        proposal.lines.append(ProposedLine(
            kind=FnfLineKind.EARNING,
            code=f"ENCASH_{leave_type.code or leave_type.name[:8].upper()}",
            label=f"{leave_type.name} encashment",
            amount=amount, source=FnfSource.LEAVE_ENCASHMENT,
            source_id=leave_type.id,
            detail=f"{milli / 1000:g} days at {day_rate / 100:,.2f}/day "
                   f"({'basic' if (config is None or config.encashment_on_basic) else 'gross'} "
                   f"÷ {encash_days})",
            sort_order=200,
        ))

    # --- 3. gratuity ---------------------------------------------------------- #
    if config is not None and config.gratuity_enabled:
        if employee.joined_on is None:
            proposal.warnings.append(
                "No joining date on record, so gratuity has not been computed."
            )
        else:
            years, months = completed_years(employee.joined_on, lwd)
            if years < 5:
                proposal.warnings.append(
                    f"{years} years {months} months of service — under the five "
                    "years the Payment of Gratuity Act requires, so no gratuity."
                )
            else:
                amount, payable_years = gratuity_amount(
                    config, wage=basic_monthly, years=years, months=months
                )
                proposal.lines.append(ProposedLine(
                    kind=FnfLineKind.EARNING, code="GRATUITY", label="Gratuity",
                    amount=amount, source=FnfSource.GRATUITY,
                    detail=f"{config.gratuity_days_per_year} days × "
                           f"{payable_years} years × {basic_monthly / 100:,.2f} "
                           f"÷ {config.gratuity_month_days}"
                           + (" (capped at the statutory ceiling)"
                              if amount == config.gratuity_ceiling else ""),
                    sort_order=300,
                ))

    # --- 4. notice ------------------------------------------------------------ #
    profile = _profile_for(db, employee.id)
    required = profile.notice_period_days if profile else None
    if required is None:
        proposal.warnings.append(
            "No notice period on the employment record, so nothing has been "
            "recovered or paid for notice."
        )
    else:
        served = (lwd - req.notice_date).days
        shortfall = required - served
        if shortfall > 0 and gross_monthly:
            # Recovery is on gross at calendar days — the same basis the notice
            # period itself is expressed in. Using the encashment day rate here
            # would recover at one rate what was earned at another.
            amount = (gross_monthly * shortfall) // 30
            proposal.lines.append(ProposedLine(
                kind=FnfLineKind.DEDUCTION, code="NOTICE_SHORT",
                label="Notice period shortfall",
                amount=amount, source=FnfSource.NOTICE,
                detail=f"{shortfall} of {required} days not served "
                       f"({served} served from {req.notice_date})",
                sort_order=800,
            ))
        elif shortfall < 0:
            proposal.warnings.append(
                f"{-shortfall} days served beyond the {required}-day notice "
                "period. Nothing is added for it; extra notice served is not "
                "normally paid."
            )

    # --- 5. unpaid expense claims --------------------------------------------- #
    claims = list(db.scalars(
        select(ExpenseClaim).where(
            ExpenseClaim.org_id == viewer.org_id,
            ExpenseClaim.user_id == employee.id,
            ExpenseClaim.status == ClaimStatus.APPROVED.value,
        ).order_by(ExpenseClaim.reviewed_at)
    ))
    for claim in claims:
        proposal.lines.append(ProposedLine(
            kind=FnfLineKind.EARNING, code="EXPENSE",
            label=f"Expense claim — {claim.title}",
            # The figure that was signed off, the same choice payroll makes when
            # it settles a claim. `total_amount` can only move while a claim is
            # a draft, so they agree; using the approved one makes that checkable.
            amount=claim.approved_amount or claim.total_amount,
            source=FnfSource.EXPENSE,
            source_id=claim.id,
            detail="approved and not yet reimbursed",
            sort_order=400,
        ))

    # --- 6. statutory on the final salary ------------------------------------- #
    if config is not None and final_salary > 0:
        pf_wage = sum(
            amount for line, amount in zip(
                structure.components,
                payrun_svc.prorate([l.amount for l in structure.components],
                                   payable_days=payable_days,
                                   month_days=month_days),
            ) if line.is_pf_wage
        )
        esi_wage = sum(
            amount for line, amount in zip(
                structure.components,
                payrun_svc.prorate([l.amount for l in structure.components],
                                   payable_days=payable_days,
                                   month_days=month_days),
            ) if line.is_esi_wage
        )
        result = statutory_svc.compute(
            config,
            pf_wage=pf_wage, esi_wage=esi_wage, pt_gross=final_salary,
            month=lwd.month, pt_slabs=pt_slabs,
        )
        for line in result.employee_lines:
            proposal.lines.append(ProposedLine(
                kind=FnfLineKind.DEDUCTION, code=line.code, label=line.name,
                amount=line.amount, source=FnfSource.STATUTORY,
                detail=line.detail, sort_order=700,
            ))

    # --- 7. loans -------------------------------------------------------------- #
    open_loans = list(db.scalars(
        select(Loan).where(
            Loan.org_id == viewer.org_id,
            Loan.user_id == employee.id,
            Loan.status == LoanStatus.ACTIVE.value,
        ).order_by(Loan.created_at)
    ))
    for loan in open_loans:
        due = loan_svc.outstanding(db, loan.id)
        if due <= 0:
            continue
        proposal.lines.append(ProposedLine(
            kind=FnfLineKind.DEDUCTION, code="LOAN",
            label=f"Loan recovery — {loan.purpose or 'advance'}",
            amount=due, source=FnfSource.LOAN, source_id=loan.id,
            detail="full outstanding balance, recovered on exit",
            sort_order=900,
        ))

    # --- tax context, not a tax line ------------------------------------------- #
    proposal.tax_paid_ytd, proposal.tax_deducted_ytd = _tax_position(
        db, viewer.org_id, employee.id, lwd
    )
    proposal.warnings.append(
        "Income tax on the settlement is not computed. Gratuity and leave "
        "encashment have their own exemptions, and the year has to be "
        "re-projected with the settlement in it. Review the tax treatment "
        "before paying."
    )

    proposal.lines.sort(key=lambda l: (l.sort_order, l.code))
    return proposal


# --------------------------------------------------------------------------- #
# Accepting one
# --------------------------------------------------------------------------- #


def accept(
    db: Session,
    viewer: User,
    request_id: uuid.UUID,
    *,
    request: Request | None = None,
) -> OffboardingFnf:
    """Write a freshly computed proposal onto the exit's settlement record.

    Recomputed here rather than taking figures from the client: a proposal the
    browser has been holding for twenty minutes may have been overtaken by a
    reimbursed claim or a repaid loan, and the settlement that gets stored has
    to be the one the numbers were true for.

    The settlement is left in **draft**. Approval is somebody's decision and
    stays a separate call — the same separation approving and paying a pay run
    already have.
    """
    _require_settler(viewer)
    proposal = propose(db, viewer, request_id)

    req = db.scalar(
        select(OffboardingRequest).where(
            OffboardingRequest.org_id == viewer.org_id,
            OffboardingRequest.id == request_id,
        )
    )
    fnf = req.fnf
    if fnf is not None and fnf.status != FnfStatus.DRAFT.value:
        raise SettlementError(
            "settlement_frozen",
            f"This settlement is {fnf.status} and cannot be recomputed. "
            "A settlement somebody has been paid against is a record.",
            409,
        )

    if fnf is None:
        fnf = OffboardingFnf(
            org_id=viewer.org_id, request_id=req.id,
            status=FnfStatus.DRAFT.value, prepared_by=viewer.id,
        )
        db.add(fnf)
        db.flush()
    else:
        # Replace, not merge — the same argument payroll's compute makes. A
        # merge leaves a loan line for a loan that has since been repaid.
        for existing in list(fnf.lines):
            db.delete(existing)
        db.flush()

    for order, line in enumerate(proposal.lines):
        db.add(FnfLine(
            org_id=viewer.org_id, fnf_id=fnf.id,
            kind=line.kind.value, code=line.code, label=line.label,
            amount_paise=line.amount, source=line.source.value,
            source_id=line.source_id, detail=line.detail,
            sort_order=order,
        ))

    fnf.gross_dues_paise = proposal.gross_dues
    fnf.deductions_paise = proposal.deductions
    fnf.net_payable_paise = proposal.net_payable
    fnf.prepared_by = viewer.id
    fnf.computed_at = datetime.now(timezone.utc)

    audit(
        db, org_id=viewer.org_id, actor=viewer,
        action="offboarding.fnf.computed", request=request,
        target_type="offboarding_fnf", target_id=str(fnf.id),
        detail={
            "request_id": str(req.id),
            "lines": len(proposal.lines),
            "gross_dues_paise": fnf.gross_dues_paise,
            "deductions_paise": fnf.deductions_paise,
            "net_payable_paise": fnf.net_payable_paise,
            "warnings": len(proposal.warnings),
        },
    )
    db.commit()
    db.refresh(fnf)
    return fnf
