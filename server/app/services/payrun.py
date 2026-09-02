"""Payroll checkpoint 2: computing a month's pay, and paying it.

The five rules that matter:

**Compute is a replace, not a merge.** Recomputing a draft deletes every payslip
and builds them again from current data. Merging would leave a payslip for
somebody who has since left, and a stale line for a loan that closed — and those
are precisely the rows nobody notices until the bank file is wrong.

**Approval freezes.** After it, nothing recomputes and no line changes. The
fourth instance of that rule here, after timesheet approvals, issued letters and
salary structures, and for the same reason each time: the figure that was signed
off must not move.

**Paying applies the side effects, once.** Loan instalments become paid, expense
claims become reimbursed. It happens on the ``paid`` transition rather than on
approval, because those are statements that money moved and it has not moved
yet at approval.

**Loss of pay is derived, not typed.** Unpaid leave approved for the period is
summed from the leave module, in the milli-days unit leave already uses, so no
conversion happens at the boundary. An override exists for the cases leave
cannot know about, and it is recorded as an override rather than silently
replacing the derived figure.

**Every line sums to the payslip and every payslip to the run.** Proration
divides, and division loses paise; the earnings are prorated with the same
largest-remainder method the loan schedule uses, so the components still add to
the prorated gross exactly.

Statutory deductions arrived in checkpoint 3 and are computed by
``services/statutory``, which is pure arithmetic this module feeds. The wage
bases come from the *structure* lines only: reimbursing somebody's taxi fare must
not raise their PF, their ESI or their professional-tax band.

**TDS is a projection, not a monthly slab.** Checkpoint 4 added it: the year's
estimated liability, less what has already been deducted, spread over the months
that remain. That is why somebody's TDS moves when they declare an investment in
December — the remaining months absorb the whole correction. The year-to-date
figures come from this company's own earlier payslips, so a mid-year salary
revision re-projects from the month it takes effect.

What is still absent is **Form 16** and the year-end reconciliation. Perquisites,
other income and previous-employer income are not modelled either; they are named
in ``models/incometax`` so their absence is visible rather than assumed.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass
import logging
import uuid
from datetime import date, datetime, timezone

from fastapi import Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import audit
from app.models import (
    ClaimStatus,
    ExpenseClaim,
    InstalmentStatus,
    LeaveApplication,
    LeaveStatus,
    LeaveType,
    EmployeeProfile,
    LineSource,
    Loan,
    LoanInstalment,
    LoanStatus,
    OffboardingRequest,
    PayRun,
    PayRunStatus,
    Payslip,
    PayslipLine,
    ProfessionalTaxSlab,
    RegularizationRequest,
    RegularizationStatus,
    Role,
    StatutoryConfig,
    TaxDeclaration,
    User,
)
from app.services import leave as leave_svc
from app.services import payroll as structure_svc
from app.services import statutory as statutory_svc
from app.services import incometax as tax_svc
from app.core import taxslabs

log = logging.getLogger(__name__)

#: Leave's unit. 1000 milli-days is one day; a half day is 500.
MILLI = 1000


class PayRunError(Exception):
    """A rule said no, with a code the console can branch on."""

    def __init__(self, code: str, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _now() -> datetime:
    return datetime.now(timezone.utc)


def can_manage(viewer: User) -> bool:
    """Same capability as salary structures — see ``services/payroll``."""
    return structure_svc.can_manage(viewer)


def _require_manager(viewer: User) -> None:
    if not can_manage(viewer):
        raise PayRunError("not_permitted", "You may not run payroll.", 403)


# --------------------------------------------------------------------------- #
# Money
# --------------------------------------------------------------------------- #


def prorate(amounts: list[int], *, payable_days: int, month_days: int) -> list[int]:
    """Scale each amount by ``payable_days / month_days``, preserving the total.

    Each amount is prorated and then the rounding remainder is handed out one
    paise at a time to the largest fractional parts — the largest-remainder
    method, and the same discipline ``loans.split_amount`` uses. Rounding each
    component independently and summing would leave the components disagreeing
    with the gross by a few paise, which is exactly the discrepancy an employee
    notices and finance cannot explain.

    A full month short-circuits, so the overwhelmingly common case does no
    arithmetic at all and cannot introduce an error.
    """
    if payable_days >= month_days:
        return list(amounts)
    if payable_days <= 0:
        return [0] * len(amounts)

    total = sum(amounts)
    target = (total * payable_days + month_days // 2) // month_days

    scaled = [(value * payable_days) // month_days for value in amounts]
    remainders = [
        ((value * payable_days) % month_days, index)
        for index, value in enumerate(amounts)
    ]
    shortfall = target - sum(scaled)
    # Largest remainder first; ties broken by position so the result is stable.
    for _, index in sorted(remainders, key=lambda pair: (-pair[0], pair[1])):
        if shortfall <= 0:
            break
        scaled[index] += 1
        shortfall -= 1
    return scaled


def lop_for(
    db: Session, user: User, *, year: int, month: int
) -> int:
    """Unpaid leave in this period, in milli-days.

    Read from approved leave applications whose type is not paid. Computed from
    the days that actually fall **inside the period** rather than the
    application's stored duration: a ten-day unpaid absence spanning a month
    boundary must not dock ten days from one month and ten from the next.

    Half days are honoured because the unit is leave's own — this returns
    milli-days and never converts.
    """
    first = date(year, month, 1)
    last = date(year, month, calendar.monthrange(year, month)[1])

    rows = db.execute(
        select(LeaveApplication, LeaveType)
        .join(LeaveType, LeaveType.id == LeaveApplication.leave_type_id)
        .where(
            LeaveApplication.org_id == user.org_id,
            LeaveApplication.user_id == user.id,
            LeaveApplication.status == "approved",
            LeaveType.is_paid.is_(False),
            LeaveApplication.start_date <= last,
            LeaveApplication.end_date >= first,
        )
    ).all()

    total = 0
    for application, _ in rows:
        window_start = max(application.start_date, first)
        window_end = min(application.end_date, last)
        days = leave_svc.leave_days_in_range(db, user, window_start, window_end)
        if not days:
            continue
        if application.start_date == application.end_date:
            # A single-day application carries its own duration, which already
            # encodes whether it was a half day.
            total += application.duration_milli_days
        else:
            # A multi-day application is whole days; count the ones inside the
            # period rather than apportioning the stored total, which would be
            # wrong whenever the working days are unevenly split by the boundary.
            total += len(days) * MILLI
    return total


# --------------------------------------------------------------------------- #
# Runs
# --------------------------------------------------------------------------- #


def get_run(db: Session, viewer: User, run_id: uuid.UUID) -> PayRun:
    row = db.get(PayRun, run_id)
    if row is None or row.org_id != viewer.org_id:
        raise PayRunError("not_found", "Pay run not found", 404)
    return row


def list_runs(db: Session, viewer: User) -> list[PayRun]:
    _require_manager(viewer)
    return list(
        db.scalars(
            select(PayRun)
            .where(PayRun.org_id == viewer.org_id)
            .order_by(PayRun.period_year.desc(), PayRun.period_month.desc())
        )
    )


def create_run(
    db: Session, viewer: User, payload, *, request: Request | None = None
) -> PayRun:
    """Open a month. One per company per month, enforced here and by the index."""
    _require_manager(viewer)
    existing = db.scalar(
        select(PayRun).where(
            PayRun.org_id == viewer.org_id,
            PayRun.period_year == payload.period_year,
            PayRun.period_month == payload.period_month,
        )
    )
    if existing is not None:
        raise PayRunError(
            "run_exists",
            f"A pay run for {payload.period_year}-{payload.period_month:02d} "
            "already exists.",
            409,
        )

    row = PayRun(
        org_id=viewer.org_id,
        period_year=payload.period_year,
        period_month=payload.period_month,
        pay_date=payload.pay_date,
        notes=(payload.notes or "").strip() or None,
        status=PayRunStatus.DRAFT.value,
    )
    db.add(row)
    audit(db, org_id=viewer.org_id, actor=viewer, action="payrun.created",
          request=request, target_type="pay_run", target_id=str(row.id),
          detail={"period": f"{payload.period_year}-{payload.period_month:02d}"})
    db.commit()
    db.refresh(row)
    return row


# --------------------------------------------------------------------------- #
# Computing
# --------------------------------------------------------------------------- #


def _employees_for(db: Session, org_id: uuid.UUID, period_end: date) -> list[User]:
    """Who is on this run.

    Active employees who had joined by the end of the period. Somebody who left
    mid-month still has a payslip — they worked part of it — and is excluded
    only once they are no longer active, which offboarding sets.
    """
    return list(
        db.scalars(
            select(User)
            .where(
                User.org_id == org_id,
                User.is_active.is_(True),
                (User.joined_on.is_(None)) | (User.joined_on <= period_end),
            )
            .order_by(User.full_name)
        )
    )


def _loan_lines(
    db: Session, org_id: uuid.UUID, user_id: uuid.UUID, period_start: date
) -> list[tuple[LoanInstalment, Loan]]:
    """Instalments due this month on this person's active loans.

    The same query ``loans.due_schedule`` makes, narrowed to one person. Written
    against the loan module's own tables rather than duplicating its rules — the
    instalment rows *are* the schedule, and there is nothing to recompute.
    """
    return list(
        db.execute(
            select(LoanInstalment, Loan)
            .join(Loan, Loan.id == LoanInstalment.loan_id)
            .where(
                LoanInstalment.org_id == org_id,
                Loan.user_id == user_id,
                LoanInstalment.due_on == period_start,
                LoanInstalment.status == InstalmentStatus.PENDING.value,
                Loan.status == LoanStatus.ACTIVE.value,
            )
            .order_by(LoanInstalment.sequence)
        ).all()
    )


def _year_to_date(
    db: Session, org_id: uuid.UUID, user_id: uuid.UUID, *, financial_year: int,
    before_year: int, before_month: int,
) -> tuple[int, int]:
    """Taxable pay and TDS already taken this financial year, before this month.

    Read from this company's own earlier payslips rather than a running total on
    a profile row. A stored total is a second number to drift from the payslips
    it summarises, and it would be wrong the moment a draft run was recomputed.

    Only **frozen** runs count. A draft or computed run is a working figure that
    may be rebuilt twice before anybody signs it, and projecting against one
    would make this month's TDS depend on another month nobody has approved.
    """
    start = date(financial_year, 4, 1)
    rows = db.execute(
        select(PayslipLine.kind, PayslipLine.source, PayslipLine.amount)
        .join(Payslip, Payslip.id == PayslipLine.payslip_id)
        .join(PayRun, PayRun.id == Payslip.run_id)
        .where(
            Payslip.org_id == org_id,
            Payslip.user_id == user_id,
            PayRun.status.in_(
                (PayRunStatus.APPROVED.value, PayRunStatus.PAID.value)
            ),
            # Inside the financial year, and strictly before the month being
            # computed. The (year, month) comparison is spelled out because a
            # naive `year * 12 + month` reads worse than the thing it encodes.
            (PayRun.period_year > start.year)
            | ((PayRun.period_year == start.year) & (PayRun.period_month >= 4)),
            (PayRun.period_year < before_year)
            | ((PayRun.period_year == before_year)
               & (PayRun.period_month < before_month)),
        )
    ).all()

    taxable = tds = 0
    for kind, source, amount in rows:
        if kind == "earning" and source == LineSource.STRUCTURE.value:
            # Structure lines only. A reimbursement is not taxable salary.
            taxable += amount
        elif kind == "deduction" and source == LineSource.TDS.value:
            tds += amount
    return taxable, tds


def _statutory_setup(db: Session, org_id: uuid.UUID):
    """The company's statutory configuration and its PT slab table, once.

    Fetched per run rather than per employee: it is one row and one small table,
    and a lookup inside the employee loop would be a query per person for data
    that cannot change mid-run.
    """
    config = db.scalar(
        select(StatutoryConfig).where(StatutoryConfig.org_id == org_id)
    )
    slabs = list(
        db.scalars(
            select(ProfessionalTaxSlab)
            .where(ProfessionalTaxSlab.org_id == org_id)
            .order_by(ProfessionalTaxSlab.min_gross)
        )
    ) if config is not None and config.pt_enabled else []
    return config, slabs


def _expense_claims(
    db: Session, org_id: uuid.UUID, user_id: uuid.UUID
) -> list[ExpenseClaim]:
    """Approved, unpaid claims — settled through this payroll.

    Not filtered by date: a claim approved in January and still unpaid in March
    should be settled in March's payroll, not left behind because it belongs to
    an earlier month.
    """
    return list(
        db.scalars(
            select(ExpenseClaim)
            .where(
                ExpenseClaim.org_id == org_id,
                ExpenseClaim.user_id == user_id,
                ExpenseClaim.status == ClaimStatus.APPROVED.value,
            )
            .order_by(ExpenseClaim.reviewed_at)
        )
    )


def compute(
    db: Session,
    viewer: User,
    run_id: uuid.UUID,
    *,
    overrides: dict[uuid.UUID, int] | None = None,
    request: Request | None = None,
) -> PayRun:
    """Build every payslip for the run, replacing whatever was there.

    A replace rather than a merge: merging leaves a payslip for somebody who has
    since left and a line for a loan that closed, and those are the rows nobody
    notices until the bank file is wrong.

    ``overrides`` maps a user id to a loss-of-pay figure in milli-days, for the
    cases the leave module cannot know about. It is applied instead of the
    derived value and recorded on the payslip note, so the payslip says a human
    decided rather than implying the system worked it out.
    """
    _require_manager(viewer)
    run = get_run(db, viewer, run_id)
    if not run.status_enum.is_recomputable:
        raise PayRunError(
            "frozen",
            f"This run is {run.status} and cannot be recomputed.",
            409,
        )

    overrides = overrides or {}
    year, month = run.period_year, run.period_month
    month_days = calendar.monthrange(year, month)[1]
    period_start = date(year, month, 1)
    period_end = date(year, month, month_days)

    # Replace: everything from a previous compute goes, including its lines via
    # the cascade.
    for existing in list(run.payslips):
        db.delete(existing)
    db.flush()

    config, pt_slabs = _statutory_setup(db, viewer.org_id)

    financial_year = taxslabs.financial_year_of(year, month)
    months_remaining = tax_svc.months_left_in_year(month)
    # One query for the whole run rather than one per employee.
    declarations = {
        row.user_id: row
        for row in db.scalars(
            select(TaxDeclaration).where(
                TaxDeclaration.org_id == viewer.org_id,
                TaxDeclaration.financial_year == financial_year,
            )
        )
    }
    # A year with no slab table is a refusal, not a silent zero: computing
    # payroll without income tax would look like it worked.
    try:
        taxslabs.rules_for(financial_year, "new")
    except taxslabs.UnknownYear as exc:
        raise PayRunError("no_tax_slabs", str(exc), 409) from None

    total_gross = total_deductions = total_net = 0
    made = 0

    for employee in _employees_for(db, viewer.org_id, period_end):
        structure = structure_svc.structure_on(
            db, viewer.org_id, employee.id, period_end
        )
        if structure is None:
            # No salary on file. Skipped rather than paid zero — a ₹0 payslip
            # reads as "we decided you get nothing" and would be filed as such.
            continue

        earnings = [
            line for line in structure.components if line.kind == "earning"
        ]
        full_gross = sum(line.amount for line in earnings)

        lop_milli = overrides.get(
            employee.id,
            lop_for(db, employee, year=year, month=month),
        )
        # Rounded up to whole days for the proration: a company that docks pay
        # for half a day still pays by the day, and the fractional part is
        # carried by the milli-day figure shown beside it.
        lop_days = lop_milli // MILLI
        payable_days = max(0, month_days - lop_days)

        prorated = prorate(
            [line.amount for line in earnings],
            payable_days=payable_days,
            month_days=month_days,
        )

        payslip = Payslip(
            org_id=viewer.org_id,
            run_id=run.id,
            user_id=employee.id,
            structure_id=structure.id,
            lop_milli_days=lop_milli,
            month_days=month_days,
            payable_days=payable_days,
            full_gross=full_gross,
            note="Loss of pay entered by hand." if employee.id in overrides else None,
        )
        db.add(payslip)
        db.flush()

        gross = 0
        # Salary only. Every statutory base derives from this rather than from
        # `gross`, because a reimbursement is not wages: it must not raise PF,
        # ESI or a professional-tax band.
        salary_gross = 0
        pf_wage = esi_wage = taxable_salary = 0
        for line, amount in zip(earnings, prorated):
            db.add(
                PayslipLine(
                    org_id=viewer.org_id,
                    payslip_id=payslip.id,
                    kind="earning",
                    code=line.code,
                    name=line.name,
                    amount=amount,
                    source=LineSource.STRUCTURE.value,
                    source_id=line.component_id,
                    detail=(
                        f"{lop_days} day(s) loss of pay" if amount != line.amount else None
                    ),
                    sort_order=line.sort_order,
                )
            )
            gross += amount
            salary_gross += amount
            # The three flags a company set on its pay components are the whole
            # interface to statutory computation; nothing here infers anything
            # from a component's name.
            if line.is_pf_wage:
                pf_wage += amount
            if line.is_esi_wage:
                esi_wage += amount
            if line.is_taxable:
                taxable_salary += amount

        # --- reimbursements: earnings, but not salary ----------------------
        for claim in _expense_claims(db, viewer.org_id, employee.id):
            amount = claim.approved_amount or claim.total_amount
            if amount <= 0:
                continue
            db.add(
                PayslipLine(
                    org_id=viewer.org_id,
                    payslip_id=payslip.id,
                    kind="earning",
                    code="REIMB",
                    name="Expense reimbursement",
                    amount=amount,
                    source=LineSource.EXPENSE.value,
                    source_id=claim.id,
                    detail=claim.title,
                    # After every salary component. A reimbursement is not pay
                    # and should not sit among the components that are.
                    sort_order=500,
                )
            )
            gross += amount

        # --- deductions: loans only, until checkpoint 3 ---------------------
        deductions = 0
        for instalment, loan in _loan_lines(
            db, viewer.org_id, employee.id, period_start
        ):
            db.add(
                PayslipLine(
                    org_id=viewer.org_id,
                    payslip_id=payslip.id,
                    kind="deduction",
                    code="LOAN",
                    name=loan.loan_type.replace("_", " ").title(),
                    amount=instalment.amount,
                    source=LineSource.LOAN.value,
                    source_id=instalment.id,
                    detail=f"Instalment {instalment.sequence} of {loan.instalment_count}",
                    sort_order=600,
                )
            )
            deductions += instalment.amount

        # --- statutory: PF, ESI, professional tax, LWF ---------------------
        profile = db.get(EmployeeProfile, employee.id)
        statutory = statutory_svc.compute(
            config,
            pf_wage=pf_wage,
            esi_wage=esi_wage,
            pt_gross=salary_gross,
            month=month,
            pt_slabs=pt_slabs,
            pf_applicable=profile.pf_applicable if profile else None,
            esi_applicable=profile.esi_applicable if profile else None,
        )
        for line in statutory.employee_lines:
            db.add(
                PayslipLine(
                    org_id=viewer.org_id, payslip_id=payslip.id, kind="deduction",
                    code=line.code, name=line.name, amount=line.amount,
                    source=line.source, detail=line.detail,
                    sort_order=line.sort_order,
                )
            )
            deductions += line.amount
        for line in statutory.employer_lines:
            db.add(
                PayslipLine(
                    org_id=viewer.org_id, payslip_id=payslip.id,
                    # A third kind. Employer contributions are neither an
                    # earning nor a deduction: nobody is paid them and nobody
                    # has them taken away. Summing `earning` and `deduction`
                    # therefore ignores them automatically, which is what keeps
                    # gross and net correct without a filter at every call site.
                    kind="employer",
                    code=line.code, name=line.name, amount=line.amount,
                    source=line.source, detail=line.detail,
                    sort_order=line.sort_order,
                )
            )

        # --- income tax ----------------------------------------------------
        #
        # After the statutory block on purpose: professional tax is deductible
        # under the old regime, so the TDS projection needs the figure this
        # month's computation just produced rather than an estimate of it.
        declaration = declarations.get(employee.id)
        regime = declaration.regime if declaration else "new"
        deductions_declared: dict[str, int] = {}
        if declaration is not None:
            for item in declaration.items:
                amount = item.effective_amount
                if amount:
                    deductions_declared[item.section] = (
                        deductions_declared.get(item.section, 0) + amount
                    )

        ytd_taxable, ytd_tds = _year_to_date(
            db, viewer.org_id, employee.id,
            financial_year=financial_year, before_year=year, before_month=month,
        )
        pt_this_month = sum(
            line.amount for line in statutory.employee_lines
            if line.source == "professional_tax"
        )
        projected = tax_svc.project_annual_income(
            earned_so_far=ytd_taxable,
            current_month_taxable=taxable_salary,
            months_remaining=months_remaining,
        )
        breakdown = tax_svc.annual_tax(
            gross_income=projected,
            financial_year=financial_year,
            regime=regime,
            deductions=deductions_declared,
            # From the date of birth on the master record, taken at 31 March per
            # the Act. Absent is the ordinary band — refusing to run payroll over
            # a missing birthday would be absurd.
            age_band=taxslabs.age_band_on(
                profile.date_of_birth if profile else None, financial_year
            ),
            # Annualised the same way the income is: this month's PT for every
            # month that is left, plus nothing for the months already run, whose
            # PT is already inside their own payslips.
            professional_tax=pt_this_month * months_remaining,
        )
        tds = tax_svc.monthly_tds(
            breakdown=breakdown,
            already_deducted=ytd_tds,
            months_remaining=months_remaining,
        )
        if tds.amount > 0:
            db.add(
                PayslipLine(
                    org_id=viewer.org_id, payslip_id=payslip.id, kind="deduction",
                    code="TDS", name="Income tax", amount=tds.amount,
                    source=LineSource.TDS.value,
                    detail=(
                        f"{regime} regime · projected "
                        f"{breakdown.total_tax / 100:,.0f} for the year, "
                        f"{months_remaining} month(s) remaining"
                    ),
                    sort_order=750,
                )
            )
            deductions += tds.amount

        payslip.employer_contributions = statutory.employer_total
        payslip.gross = gross
        payslip.total_deductions = deductions
        # Can go negative in principle — a loan instalment larger than a
        # prorated month of pay. Left as a negative rather than clamped: it is a
        # real condition finance must see and resolve, and a zero would hide it.
        payslip.net = gross - deductions

        total_gross += gross
        total_deductions += deductions
        total_net += payslip.net
        made += 1

    run.total_gross = total_gross
    run.total_deductions = total_deductions
    run.total_net = total_net
    run.employee_count = made
    run.status = PayRunStatus.COMPUTED.value
    run.computed_at = _now()
    run.computed_by = viewer.id

    audit(db, org_id=viewer.org_id, actor=viewer, action="payrun.computed",
          request=request, target_type="pay_run", target_id=str(run.id),
          detail={"period": run.period_label, "employees": made,
                  "gross": total_gross, "deductions": total_deductions,
                  "net": total_net, "overrides": len(overrides)})
    db.commit()
    db.refresh(run)
    return run


# --------------------------------------------------------------------------- #
# Transitions
# --------------------------------------------------------------------------- #


def approve(
    db: Session, viewer: User, run_id: uuid.UUID, *, request: Request | None = None
) -> PayRun:
    """Sign off the figures. Nothing recomputes afterwards."""
    _require_manager(viewer)
    run = get_run(db, viewer, run_id)
    if run.status_enum is not PayRunStatus.COMPUTED:
        raise PayRunError(
            "not_computed",
            f"This run is {run.status}; compute it before approving.",
            409,
        )
    if run.employee_count == 0:
        raise PayRunError(
            "empty_run",
            "There are no payslips to approve. Check that salary structures "
            "exist for the period.",
        )

    run.status = PayRunStatus.APPROVED.value
    run.approved_at = _now()
    run.approved_by = viewer.id
    audit(db, org_id=viewer.org_id, actor=viewer, action="payrun.approved",
          request=request, target_type="pay_run", target_id=str(run.id),
          detail={"period": run.period_label, "employees": run.employee_count,
                  "net": run.total_net})
    db.commit()
    db.refresh(run)
    return run


def mark_paid(
    db: Session,
    viewer: User,
    run_id: uuid.UUID,
    payload,
    *,
    request: Request | None = None,
) -> PayRun:
    """Record that salaries went out, and apply what that means elsewhere.

    Loan instalments become paid and expense claims become reimbursed — here,
    not at approval, because both are statements that money moved and at
    approval it has not.

    Every side effect goes through the owning module's own tables using the ids
    the payslip lines recorded, so nothing is matched by amount and nothing is
    applied twice: a line points at exactly one instalment, and that instalment
    is only pending once.
    """
    _require_manager(viewer)
    run = get_run(db, viewer, run_id)
    if run.status_enum is not PayRunStatus.APPROVED:
        raise PayRunError(
            "not_approved",
            f"This run is {run.status}; only an approved run can be paid.",
            409,
        )

    paid_on = payload.paid_on or date.today()
    reference = (payload.payment_reference or "").strip() or None
    loans_settled = claims_settled = 0

    lines = list(
        db.scalars(
            select(PayslipLine)
            .join(Payslip, Payslip.id == PayslipLine.payslip_id)
            .where(
                Payslip.run_id == run.id,
                PayslipLine.source.in_(
                    (LineSource.LOAN.value, LineSource.EXPENSE.value)
                ),
            )
        )
    )

    for line in lines:
        if line.source_id is None:  # pragma: no cover - written with an id always
            continue
        if line.source == LineSource.LOAN.value:
            instalment = db.get(LoanInstalment, line.source_id)
            if instalment is None or instalment.status != InstalmentStatus.PENDING.value:
                # Already settled by hand between approval and payment. Left
                # alone rather than overwritten — somebody recorded it
                # deliberately and this run has no better information.
                continue
            instalment.status = InstalmentStatus.PAID.value
            instalment.paid_amount = line.amount
            instalment.paid_on = paid_on
            instalment.recorded_by = viewer.id
            instalment.reference = reference or f"Payroll {run.period_label}"
            # Flushed before the count below. The session is autoflush=False, so
            # without this the query still sees this instalment as pending and a
            # loan whose final instalment just settled would stay open.
            db.flush()
            loan = db.get(Loan, instalment.loan_id)
            if loan is not None:
                remaining = db.scalar(
                    select(func.count(LoanInstalment.id)).where(
                        LoanInstalment.loan_id == loan.id,
                        LoanInstalment.status == InstalmentStatus.PENDING.value,
                    )
                ) or 0
                if remaining == 0:
                    loan.status = LoanStatus.CLOSED.value
                    loan.closed_on = paid_on
            loans_settled += 1
        else:
            claim = db.get(ExpenseClaim, line.source_id)
            if claim is None or claim.status != ClaimStatus.APPROVED.value:
                continue
            claim.status = ClaimStatus.REIMBURSED.value
            claim.reimbursed_at = _now()
            claim.reimbursed_by = viewer.id
            claim.payment_reference = reference or f"Payroll {run.period_label}"
            claims_settled += 1

    run.status = PayRunStatus.PAID.value
    run.paid_at = _now()
    run.paid_by = viewer.id
    run.pay_date = run.pay_date or paid_on
    run.payment_reference = reference

    audit(db, org_id=viewer.org_id, actor=viewer, action="payrun.paid",
          request=request, target_type="pay_run", target_id=str(run.id),
          detail={"period": run.period_label, "net": run.total_net,
                  "reference": reference, "loan_instalments": loans_settled,
                  "expense_claims": claims_settled})
    db.commit()
    db.refresh(run)
    return run


def cancel(
    db: Session, viewer: User, run_id: uuid.UUID, *, request: Request | None = None
) -> PayRun:
    """Abandon a run before it is paid.

    Payslips are deleted with it: an unpaid run's payslips were never handed to
    anybody, so there is nothing to preserve, and leaving them behind would put
    a payslip in somebody's history for money they never received. A **paid**
    run cannot be cancelled — the money has gone, and the correction for that is
    a reversal in a later run.
    """
    _require_manager(viewer)
    run = get_run(db, viewer, run_id)
    if run.status_enum is PayRunStatus.PAID:
        raise PayRunError(
            "already_paid",
            "A paid run cannot be cancelled. Correct it in a later run.",
            409,
        )
    if run.status_enum is PayRunStatus.CANCELLED:
        raise PayRunError("already_cancelled", "This run is already cancelled.", 409)

    for payslip in list(run.payslips):
        db.delete(payslip)
    run.status = PayRunStatus.CANCELLED.value
    run.total_gross = run.total_deductions = run.total_net = 0
    run.employee_count = 0

    audit(db, org_id=viewer.org_id, actor=viewer, action="payrun.cancelled",
          request=request, target_type="pay_run", target_id=str(run.id),
          detail={"period": run.period_label})
    db.commit()
    db.refresh(run)
    return run


# --------------------------------------------------------------------------- #
# Reading
# --------------------------------------------------------------------------- #


def payslips_for_run(db: Session, viewer: User, run_id: uuid.UUID) -> list[Payslip]:
    _require_manager(viewer)
    run = get_run(db, viewer, run_id)
    return list(
        db.scalars(
            select(Payslip)
            .join(User, User.id == Payslip.user_id)
            .where(Payslip.run_id == run.id)
            .order_by(User.full_name)
        )
    )


def get_payslip(db: Session, viewer: User, payslip_id: uuid.UUID) -> Payslip:
    """One payslip, if this caller may see it.

    An employee may read their own — but only once the run is approved. A draft
    payslip is a working figure that may be recomputed twice before anybody
    signs it, and showing somebody a salary that then changes is worse than
    showing nothing.
    """
    row = db.get(Payslip, payslip_id)
    if row is None or row.org_id != viewer.org_id:
        raise PayRunError("not_found", "Payslip not found", 404)
    if can_manage(viewer):
        return row
    if row.user_id == viewer.id and row.run.status_enum.is_frozen:
        return row
    raise PayRunError("not_permitted", "You may not view this payslip.", 403)


def my_payslips(db: Session, viewer: User) -> list[Payslip]:
    """Your own, from approved and paid runs only."""
    return list(
        db.scalars(
            select(Payslip)
            .join(PayRun, PayRun.id == Payslip.run_id)
            .where(
                Payslip.org_id == viewer.org_id,
                Payslip.user_id == viewer.id,
                PayRun.status.in_(
                    (PayRunStatus.APPROVED.value, PayRunStatus.PAID.value)
                ),
            )
            .order_by(PayRun.period_year.desc(), PayRun.period_month.desc())
        )
    )


# --------------------------------------------------------------------------- #
# Pre-payroll readiness
#
# Everything that has to be true *before* a month is computed. The exceptions
# the console already shows are found by computing; these are found instead of
# computing, which is the whole point: a missing bank account discovered on the
# 30th is a fix, and the same one discovered on payday is somebody not paid.
#
# Nothing here blocks anything. A check reports, the console shows it, and a
# payroll manager decides — because every one of these has a legitimate "yes,
# I know" (a consultant with no bank row, an employee who genuinely earned
# nothing this month). A hard gate on any of them would be a gate somebody
# learns to work around.
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Check:
    """One pre-payroll question, and who it is about.

    ``severity`` is advice about attention, never about permission:

    * ``blocking``  — this person will not be paid correctly if it stands.
    * ``warning``   — probably fine, worth a look.
    * ``info``      — a fact about the month, needing no action at all.
    """

    key: str
    title: str
    severity: str
    detail: str
    #: Who it concerns, as "name · what about them". Capped by the caller.
    names: list[str]

    @property
    def count(self) -> int:
        return len(self.names)


def readiness(db: Session, viewer: User, run_id: uuid.UUID) -> list[Check]:
    """The pre-payroll checklist for one open month.

    Read-only and side-effect free — it may be called as often as the console
    likes, including while somebody is still fixing what it reported.
    """
    _require_manager(viewer)
    run = get_run(db, viewer, run_id)

    year, month = run.period_year, run.period_month
    month_days = calendar.monthrange(year, month)[1]
    period_start = date(year, month, 1)
    period_end = date(year, month, month_days)

    employees = _employees_for(db, viewer.org_id, period_end)
    checks: list[Check] = []

    # --- who has no salary to pay ------------------------------------------ #
    no_structure = [
        person for person in employees
        if structure_svc.structure_on(db, viewer.org_id, person.id, period_end) is None
    ]
    checks.append(Check(
        key="no_structure",
        title="No salary structure",
        severity="blocking",
        detail=(
            "These people are active this month but have no salary covering it, so the run "
            "will skip them entirely. Set a structure, then compute."
        ),
        names=[person.full_name for person in no_structure],
    ))

    # --- who cannot be paid even once the amount is known ------------------- #
    profiles = {
        row.user_id: row
        for row in db.scalars(
            select(EmployeeProfile).where(
                EmployeeProfile.org_id == viewer.org_id,
                EmployeeProfile.user_id.in_([person.id for person in employees] or [None]),
            )
        )
    }
    no_bank = [
        person for person in employees
        if not (
            (profile := profiles.get(person.id))
            and profile.bank_account_enc
            and profile.bank_ifsc
        )
    ]
    checks.append(Check(
        key="no_bank",
        title="No bank account on file",
        severity="blocking",
        detail=(
            "The bank file refuses to leave anybody out, so it will not generate until every "
            "person being paid has an account and an IFSC on their record."
        ),
        names=[person.full_name for person in no_bank],
    ))

    # --- decisions still owed on things that change the payslip ------------- #
    pending_leave = db.scalars(
        select(LeaveApplication)
        .where(
            LeaveApplication.org_id == viewer.org_id,
            LeaveApplication.status == LeaveStatus.PENDING.value,
            LeaveApplication.start_date <= period_end,
            LeaveApplication.end_date >= period_start,
        )
        .order_by(LeaveApplication.start_date)
    ).all()
    names = {person.id: person.full_name for person in employees}
    checks.append(Check(
        key="pending_leave",
        title="Leave still awaiting a decision",
        severity="warning",
        detail=(
            "Leave overlapping this month that nobody has approved or rejected. Approving it "
            "after the run is computed changes the loss of pay, and the run has to be "
            "computed again."
        ),
        names=[
            f"{names.get(row.user_id, 'Somebody')} · "
            f"{row.start_date:%d %b}–{row.end_date:%d %b}"
            for row in pending_leave
        ],
    ))

    pending_reg = db.scalars(
        select(RegularizationRequest).where(
            RegularizationRequest.org_id == viewer.org_id,
            RegularizationRequest.status == RegularizationStatus.PENDING.value,
            RegularizationRequest.date.between(period_start, period_end),
        )
    ).all()
    checks.append(Check(
        key="pending_regularization",
        title="Attendance corrections awaiting a decision",
        severity="warning",
        detail=(
            "A missed punch that is corrected later can turn a loss-of-pay day back into a "
            "paid one. Decide these before computing."
        ),
        names=[
            f"{names.get(row.user_id, 'Somebody')} · {row.date:%d %b}"
            for row in pending_reg
        ],
    ))

    # --- reimbursements that would otherwise miss this payroll -------------- #
    ready_claims = db.scalars(
        select(ExpenseClaim).where(
            ExpenseClaim.org_id == viewer.org_id,
            ExpenseClaim.status == "submitted",
        )
    ).all()
    checks.append(Check(
        key="pending_expenses",
        title="Expense claims awaiting approval",
        severity="info",
        detail=(
            "Approved claims ride along with this payroll as a reimbursement. Ones still "
            "waiting will wait for next month instead."
        ),
        names=[
            f"{names.get(row.user_id, 'Somebody')} · {row.title}"
            for row in ready_claims
            if row.user_id in names
        ],
    ))

    # --- who is new, and who is going -------------------------------------- #
    joiners = [
        person for person in employees
        if person.joined_on and period_start <= person.joined_on <= period_end
    ]
    checks.append(Check(
        key="joiners",
        title="Joined this month",
        severity="info",
        detail=(
            "Paid from their joining date, prorated across the month. Worth confirming the "
            "date is right — it is the one input nobody can correct afterwards without a "
            "second run."
        ),
        names=[
            f"{person.full_name} · joined {person.joined_on:%d %b}"
            for person in joiners
        ],
    ))

    exits = db.scalars(
        select(OffboardingRequest).where(
            OffboardingRequest.org_id == viewer.org_id,
            OffboardingRequest.last_working_day.between(period_start, period_end),
        )
    ).all()
    checks.append(Check(
        key="leavers",
        title="Leaving this month",
        severity="warning",
        detail=(
            "Their last month of ordinary payroll. Anything owed beyond it — notice pay, "
            "leave encashment, gratuity — belongs on the full and final settlement, not here."
        ),
        names=[
            f"{names.get(row.user_id, 'Somebody')} · last day {row.last_working_day:%d %b}"
            for row in exits
        ],
    ))

    # --- tax that will be estimated rather than declared -------------------- #
    financial_year = taxslabs.financial_year_of(year, month)
    declared = {
        row.user_id
        for row in db.scalars(
            select(TaxDeclaration).where(
                TaxDeclaration.org_id == viewer.org_id,
                TaxDeclaration.financial_year == financial_year,
            )
        )
    }
    checks.append(Check(
        key="no_declaration",
        title="No tax declaration this year",
        severity="info",
        detail=(
            f"Nobody has declared investments for {financial_year}, so their tax is computed "
            "on the default regime with no deductions. That is correct until they declare, "
            "and over-deducts if they were going to."
        ),
        names=[
            person.full_name for person in employees if person.id not in declared
        ],
    ))

    return checks


# --------------------------------------------------------------------------- #
# Variance
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class VarianceRow:
    user_id: uuid.UUID
    name: str
    previous_net: int
    current_net: int
    previous_gross: int
    current_gross: int
    #: Why it moved, in words, from what the two payslips actually differ on.
    reasons: list[str]

    @property
    def delta(self) -> int:
        return self.current_net - self.previous_net

    @property
    def percent(self) -> float:
        if self.previous_net == 0:
            return 100.0 if self.current_net else 0.0
        return round(abs(self.delta) * 100 / self.previous_net, 1)


def variance(
    db: Session, viewer: User, run_id: uuid.UUID, *, threshold_percent: float = 10.0
) -> tuple[list[VarianceRow], list[VarianceRow]]:
    """Compare this run against the previous month, per employee.

    Returns ``(moved, unchanged_count_rows)`` — everybody whose net moved by
    more than ``threshold_percent``, and everybody else.

    This is the check a payroll manager actually runs before approving, and it
    is the one this product did not have: the exceptions list answers "is
    anything wrong with this run", and variance answers the different and more
    useful question, "is anything *different* from last month, and do I know
    why". A salary revision, a joiner, a month of unpaid leave and a fat-
    fingered override all look identical in a register and obvious here.

    Reasons are derived from the two payslips rather than guessed: a changed
    structure id is a revision, a changed LOP is unpaid leave, a manual line is
    somebody's decision, and the absence of a previous payslip is a joiner.
    """
    _require_manager(viewer)
    run = get_run(db, viewer, run_id)

    previous = db.scalar(
        select(PayRun)
        .where(
            PayRun.org_id == viewer.org_id,
            PayRun.id != run.id,
            PayRun.status != PayRunStatus.CANCELLED.value,
            # The most recent run that starts before this one, by period rather
            # than by creation: months can be opened out of order.
            (PayRun.period_year * 12 + PayRun.period_month)
            < (run.period_year * 12 + run.period_month),
        )
        .order_by((PayRun.period_year * 12 + PayRun.period_month).desc())
        .limit(1)
    )

    before = {slip.user_id: slip for slip in (previous.payslips if previous else [])}
    names = {
        row.id: row.full_name
        for row in db.scalars(select(User).where(User.org_id == viewer.org_id))
    }

    moved: list[VarianceRow] = []
    steady: list[VarianceRow] = []

    for slip in run.payslips:
        old = before.get(slip.user_id)
        reasons: list[str] = []

        if old is None:
            reasons.append("First payslip — no previous month to compare")
        else:
            if old.structure_id != slip.structure_id:
                reasons.append("Salary structure changed")
            if old.lop_milli_days != slip.lop_milli_days:
                reasons.append(
                    f"Loss of pay {old.lop_milli_days / 1000:.1f}d → "
                    f"{slip.lop_milli_days / 1000:.1f}d"
                )
            if old.payable_days != slip.payable_days:
                reasons.append(f"Payable days {old.payable_days} → {slip.payable_days}")

            manual_now = sum(
                line.amount for line in slip.lines if line.source == LineSource.MANUAL.value
            )
            manual_before = sum(
                line.amount for line in old.lines if line.source == LineSource.MANUAL.value
            )
            if manual_now != manual_before:
                reasons.append("One-off line added or changed by hand")

            loan_now = sum(
                line.amount for line in slip.lines if line.source == LineSource.LOAN.value
            )
            loan_before = sum(
                line.amount for line in old.lines if line.source == LineSource.LOAN.value
            )
            if loan_now != loan_before:
                reasons.append("Loan instalment started, changed or finished")

            expense_now = sum(
                line.amount for line in slip.lines if line.source == LineSource.EXPENSE.value
            )
            expense_before = sum(
                line.amount for line in old.lines if line.source == LineSource.EXPENSE.value
            )
            if expense_now != expense_before:
                reasons.append("Expense reimbursement differs")

        row = VarianceRow(
            user_id=slip.user_id,
            name=names.get(slip.user_id, "Somebody"),
            previous_net=old.net if old else 0,
            current_net=slip.net,
            previous_gross=old.gross if old else 0,
            current_gross=slip.gross,
            reasons=reasons or ["No reason found in the payslips — worth opening"],
        )
        # A first payslip always counts as movement: it is exactly the row
        # somebody should look at, and comparing it against a zero it never had
        # would bury it under a percentage.
        if old is None or row.percent >= threshold_percent:
            moved.append(row)
        else:
            steady.append(row)

    moved.sort(key=lambda r: abs(r.delta), reverse=True)
    return moved, steady
