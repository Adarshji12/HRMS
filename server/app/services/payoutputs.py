"""What comes out of a pay run: registers, a bank file, statutory returns.

Everything here reads a **frozen** run. A register that changes when somebody
recomputes is not a register, and a bank file generated from a draft would pay
figures nobody signed off. The one exception is the payslip render, which works
on any run because seeing a draft payslip is the point of reviewing one — but
*filing* it is gated on the run being frozen, for the same reason.

Four outputs, and what each is actually for:

**The register** is the month on one page — everybody, every component, every
deduction, with totals. It is what finance signs and the first thing an auditor
asks for. Its totals are recomputed from the payslip lines rather than read off
the run, deliberately: if those two ever disagree the register should show it,
not hide it behind the stored figure.

**The bank file** is net pay per employee with the account details from the
master record. It decrypts bank accounts, so it is the most sensitive thing this
system produces — payroll capability only, audited on every generation, and it
refuses rather than silently skipping anybody whose details are missing.

**The PF ECR and the ESI return** are statutory filings. Both are text formats
whose exact shape varies by portal version, so what is produced here is the
common layout with its columns named in a header comment — a starting point an
operator adapts, not a claim of compliance. Amounts in the ECR are **whole
rupees**, not paise, which is the detail that ruins a filing when missed.

**The payslip** is filed into the employee's document record on demand. It has
been re-renderable from its own lines since checkpoint 2, which is enough to show
it and not enough to *have* it three years after leaving.
"""

from __future__ import annotations

import csv
import io
import logging
import uuid
from dataclasses import dataclass, field
from datetime import date
from html import escape

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import audit
from app.core.crypto import decrypt_secret
from app.models import (
    Designation,
    EmployeeProfile,
    LineSource,
    Organization,
    PayRun,
    PayRunStatus,
    Payslip,
    PayslipLine,
    User,
)
from app.services import corehr
from app.services import payroll as payroll_svc

log = logging.getLogger(__name__)

MONTHS = (
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)


class OutputError(Exception):
    """A rule said no, with a code the console can branch on."""

    def __init__(self, code: str, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _require_manager(viewer: User) -> None:
    if not payroll_svc.can_manage(viewer):
        raise OutputError("not_permitted", "You may not run payroll.", 403)


def _get_run(db: Session, viewer: User, run_id: uuid.UUID) -> PayRun:
    run = db.get(PayRun, run_id)
    if run is None or run.org_id != viewer.org_id:
        raise OutputError("not_found", "Pay run not found", 404)
    return run


def _require_frozen(run: PayRun) -> None:
    """Registers and filings come from a signed-off run, never a draft."""
    if not run.status_enum.is_frozen:
        raise OutputError(
            "not_approved",
            f"This run is {run.status}. Approve it before producing registers "
            "or filings — a draft can still be recomputed.",
            409,
        )


def period_label(run: PayRun) -> str:
    return f"{MONTHS[run.period_month - 1]} {run.period_year}"


def _payslips(db: Session, run: PayRun) -> list[Payslip]:
    return list(
        db.scalars(
            select(Payslip)
            .join(User, User.id == Payslip.user_id)
            .where(Payslip.run_id == run.id)
            .order_by(User.full_name)
        )
    )


# --------------------------------------------------------------------------- #
# Register
# --------------------------------------------------------------------------- #


@dataclass
class RegisterRow:
    user_id: uuid.UUID
    name: str
    employee_code: str | None
    payable_days: int
    month_days: int
    earnings: dict[str, int] = field(default_factory=dict)
    deductions: dict[str, int] = field(default_factory=dict)
    employer: dict[str, int] = field(default_factory=dict)
    gross: int = 0
    total_deductions: int = 0
    net: int = 0
    employer_total: int = 0


@dataclass
class Register:
    run_id: uuid.UUID
    period: str
    status: str
    pay_date: date | None
    rows: list[RegisterRow]
    #: Every code that appears, in payslip order, so the table has stable
    #: columns across employees who do not share every component.
    earning_codes: list[str]
    deduction_codes: list[str]
    employer_codes: list[str]
    totals: RegisterRow
    #: Set when the recomputed totals disagree with what the run stored. It
    #: should always be empty; showing it beats hiding it behind the stored
    #: figure, because a disagreement means something is wrong upstream.
    discrepancies: list[str] = field(default_factory=list)


def register(db: Session, viewer: User, run_id: uuid.UUID) -> Register:
    """The month on one page.

    Totals are summed from the payslip lines rather than read off the run. If
    those two ever disagree the register shows it — a register that quietly
    prints the stored figure would make the discrepancy invisible in exactly the
    document somebody is checking.
    """
    _require_manager(viewer)
    run = _get_run(db, viewer, run_id)
    _require_frozen(run)

    slips = _payslips(db, run)
    ids = [slip.id for slip in slips]
    lines_by_slip: dict[uuid.UUID, list[PayslipLine]] = {slip.id: [] for slip in slips}
    if ids:
        for line in db.scalars(
            select(PayslipLine)
            .where(PayslipLine.payslip_id.in_(ids))
            .order_by(PayslipLine.sort_order, PayslipLine.code)
        ):
            lines_by_slip[line.payslip_id].append(line)

    names = {
        row[0]: (row[1], row[2])
        for row in db.execute(
            select(User.id, User.full_name, User.employee_code).where(
                User.id.in_({slip.user_id for slip in slips} or {uuid.uuid4()})
            )
        )
    }

    earning_codes: list[str] = []
    deduction_codes: list[str] = []
    employer_codes: list[str] = []
    rows: list[RegisterRow] = []

    for slip in slips:
        name, code = names.get(slip.user_id, ("", None))
        row = RegisterRow(
            user_id=slip.user_id, name=name, employee_code=code,
            payable_days=slip.payable_days, month_days=slip.month_days,
        )
        for line in lines_by_slip[slip.id]:
            bucket, order = (
                (row.earnings, earning_codes) if line.kind == "earning"
                else (row.deductions, deduction_codes) if line.kind == "deduction"
                else (row.employer, employer_codes)
            )
            bucket[line.code] = bucket.get(line.code, 0) + line.amount
            if line.code not in order:
                order.append(line.code)
        row.gross = sum(row.earnings.values())
        row.total_deductions = sum(row.deductions.values())
        row.net = row.gross - row.total_deductions
        row.employer_total = sum(row.employer.values())
        rows.append(row)

    totals = RegisterRow(
        user_id=uuid.UUID(int=0), name="Total", employee_code=None,
        payable_days=0, month_days=0,
    )
    for row in rows:
        for code, amount in row.earnings.items():
            totals.earnings[code] = totals.earnings.get(code, 0) + amount
        for code, amount in row.deductions.items():
            totals.deductions[code] = totals.deductions.get(code, 0) + amount
        for code, amount in row.employer.items():
            totals.employer[code] = totals.employer.get(code, 0) + amount
    totals.gross = sum(totals.earnings.values())
    totals.total_deductions = sum(totals.deductions.values())
    totals.net = totals.gross - totals.total_deductions
    totals.employer_total = sum(totals.employer.values())

    discrepancies = []
    if totals.gross != run.total_gross:
        discrepancies.append(
            f"gross: register {totals.gross / 100:,.2f} against run "
            f"{run.total_gross / 100:,.2f}"
        )
    if totals.total_deductions != run.total_deductions:
        discrepancies.append(
            f"deductions: register {totals.total_deductions / 100:,.2f} against "
            f"run {run.total_deductions / 100:,.2f}"
        )
    if totals.net != run.total_net:
        discrepancies.append(
            f"net: register {totals.net / 100:,.2f} against run "
            f"{run.total_net / 100:,.2f}"
        )

    return Register(
        run_id=run.id, period=period_label(run), status=run.status,
        pay_date=run.pay_date, rows=rows,
        earning_codes=earning_codes, deduction_codes=deduction_codes,
        employer_codes=employer_codes, totals=totals,
        discrepancies=discrepancies,
    )


def register_csv(reg: Register) -> bytes:
    """The register as a spreadsheet.

    Amounts are written in **rupees with two decimals**, not paise: this file is
    opened in a spreadsheet by a person, and a column of paise integers is a
    column nobody can read. Everything inside the system stays in paise; the
    conversion happens here, at the edge, once.
    """
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    header = (
        ["Employee", "Code", "Days"]
        + reg.earning_codes + ["Gross"]
        + reg.deduction_codes + ["Deductions", "Net"]
        + [f"ER {code}" for code in reg.employer_codes] + ["Employer total"]
    )
    writer.writerow(header)

    def rupees(paise: int) -> str:
        return f"{paise / 100:.2f}"

    for row in reg.rows:
        writer.writerow(
            [row.name, row.employee_code or "",
             f"{row.payable_days}/{row.month_days}"]
            + [rupees(row.earnings.get(code, 0)) for code in reg.earning_codes]
            + [rupees(row.gross)]
            + [rupees(row.deductions.get(code, 0)) for code in reg.deduction_codes]
            + [rupees(row.total_deductions), rupees(row.net)]
            + [rupees(row.employer.get(code, 0)) for code in reg.employer_codes]
            + [rupees(row.employer_total)]
        )
    writer.writerow(
        ["Total", "", ""]
        + [rupees(reg.totals.earnings.get(code, 0)) for code in reg.earning_codes]
        + [rupees(reg.totals.gross)]
        + [rupees(reg.totals.deductions.get(code, 0)) for code in reg.deduction_codes]
        + [rupees(reg.totals.total_deductions), rupees(reg.totals.net)]
        + [rupees(reg.totals.employer.get(code, 0)) for code in reg.employer_codes]
        + [rupees(reg.totals.employer_total)]
    )
    return buffer.getvalue().encode("utf-8")


# --------------------------------------------------------------------------- #
# Bank transfer file
# --------------------------------------------------------------------------- #


def bank_file(
    db: Session, viewer: User, run_id: uuid.UUID, *, request: Request | None = None
) -> bytes:
    """Net pay per employee, with the account details to send it to.

    The most sensitive output this system produces: it decrypts bank account
    numbers. Payroll capability only, and **audited on every generation** —
    "who exported everybody's bank details on the 3rd" has to be answerable.

    Refuses rather than skipping. An employee silently missing from a bank file
    is somebody who does not get paid and finds out on payday; an error naming
    them is a five-minute fix before the file is uploaded.

    A generic layout, deliberately: every bank ingests a slightly different one,
    and the columns are named in the header so an operator can map them rather
    than reverse-engineer them.
    """
    _require_manager(viewer)
    run = _get_run(db, viewer, run_id)
    _require_frozen(run)

    slips = _payslips(db, run)
    payable = [slip for slip in slips if slip.net > 0]
    if not payable:
        raise OutputError("nothing_to_pay", "No payslip on this run has a positive net.")

    users = {
        row.id: row
        for row in db.scalars(
            select(User).where(User.id.in_({slip.user_id for slip in payable}))
        )
    }
    profiles = {
        row.user_id: row
        for row in db.scalars(
            select(EmployeeProfile).where(
                EmployeeProfile.user_id.in_({slip.user_id for slip in payable})
            )
        )
    }

    missing: list[str] = []
    rows: list[list[str]] = []
    for slip in payable:
        employee = users.get(slip.user_id)
        profile = profiles.get(slip.user_id)
        account = decrypt_secret(
            profile.bank_account_enc, label="bank account"
        ) if profile else ""
        ifsc = (profile.bank_ifsc if profile else None) or ""
        if not account or not ifsc:
            missing.append(employee.full_name if employee else str(slip.user_id))
            continue
        rows.append([
            employee.employee_code or "",
            employee.full_name,
            (profile.bank_account_name if profile else None) or employee.full_name,
            account,
            ifsc,
            (profile.bank_name if profile else None) or "",
            f"{slip.net / 100:.2f}",
            f"Salary {period_label(run)}",
        ])

    if missing:
        raise OutputError(
            "missing_bank_details",
            "These employees have no bank account or IFSC on file: "
            + ", ".join(missing[:10])
            + (f" and {len(missing) - 10} more" if len(missing) > 10 else "")
            + ". Add them before generating the file.",
        )

    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow([
        "Employee code", "Employee name", "Account holder", "Account number",
        "IFSC", "Bank", "Amount", "Narration",
    ])
    writer.writerows(rows)

    audit(db, org_id=viewer.org_id, actor=viewer, action="payrun.bank_file_generated",
          request=request, target_type="pay_run", target_id=str(run.id),
          detail={"period": run.period_label, "employees": len(rows),
                  "total_net": sum(slip.net for slip in payable)})
    db.commit()
    return buffer.getvalue().encode("utf-8")


# --------------------------------------------------------------------------- #
# Statutory filings
# --------------------------------------------------------------------------- #


def _line_totals(
    db: Session, run: PayRun, slips: list[Payslip]
) -> dict[uuid.UUID, dict[str, int]]:
    """Per employee, the amount against each payslip line code."""
    out: dict[uuid.UUID, dict[str, int]] = {slip.user_id: {} for slip in slips}
    by_id = {slip.id: slip.user_id for slip in slips}
    if not by_id:
        return out
    for line in db.scalars(
        select(PayslipLine).where(PayslipLine.payslip_id.in_(list(by_id)))
    ):
        bucket = out[by_id[line.payslip_id]]
        bucket[line.code] = bucket.get(line.code, 0) + line.amount
        # Also keyed by source, so PF wages can be summed without knowing which
        # component codes a company happened to flag.
        key = f"@{line.source}:{line.kind}"
        bucket[key] = bucket.get(key, 0) + line.amount
    return out


def pf_ecr(db: Session, viewer: User, run_id: uuid.UUID) -> bytes:
    """The EPFO electronic challan-cum-return, in its common layout.

    **Amounts are whole rupees, not paise.** That is the detail that ruins a
    filing when missed, and it is why the conversion happens here rather than
    being left to whoever opens the file.

    The exact column set varies by portal version, so the header names what each
    field is. This is a starting point an operator adapts — not a claim that the
    file will upload unmodified.

    Employees with no UAN are listed as an error rather than dropped: a missing
    person in an ECR is a contribution that never reaches their account.
    """
    _require_manager(viewer)
    run = _get_run(db, viewer, run_id)
    _require_frozen(run)

    slips = _payslips(db, run)
    totals = _line_totals(db, run, slips)
    users = {
        row.id: row
        for row in db.scalars(
            select(User).where(User.id.in_({slip.user_id for slip in slips} or {uuid.uuid4()}))
        )
    }
    profiles = {
        row.user_id: row
        for row in db.scalars(
            select(EmployeeProfile).where(
                EmployeeProfile.user_id.in_({slip.user_id for slip in slips} or {uuid.uuid4()})
            )
        )
    }

    missing: list[str] = []
    lines: list[str] = []
    for slip in slips:
        figures = totals.get(slip.user_id, {})
        employee_pf = figures.get("PF", 0)
        if not employee_pf:
            # No PF this month — not in the return at all.
            continue
        employee = users.get(slip.user_id)
        profile = profiles.get(slip.user_id)
        uan = (profile.uan if profile else None) or ""
        if not uan:
            missing.append(employee.full_name if employee else str(slip.user_id))
            continue

        eps = figures.get("EPS", 0)
        epf = figures.get("EPF", 0)
        # PF wages: what the contribution was computed on. Recovered from the
        # employee contribution rather than re-derived, so the return and the
        # payslip cannot disagree.
        gross_wages = slip.gross
        pf_wages = round(employee_pf / 0.12) if employee_pf else 0

        def rupees(paise: int) -> int:
            # Whole rupees, rounded half-up. The ECR has no decimal places.
            return (paise + 50) // 100

        lines.append("#~#".join([
            uan,
            employee.full_name if employee else "",
            str(rupees(gross_wages)),
            str(rupees(pf_wages)),        # EPF wages
            str(rupees(pf_wages)),        # EPS wages
            str(rupees(pf_wages)),        # EDLI wages
            str(rupees(employee_pf)),     # employee contribution
            str(rupees(eps)),             # employer pension
            str(rupees(epf)),             # employer PF
            str(slip.month_days - slip.payable_days),   # non-contributory days
            "0",                          # refund of advances
        ]))

    if missing:
        raise OutputError(
            "missing_uan",
            "These employees have PF deducted but no UAN on file: "
            + ", ".join(missing[:10])
            + ". A missing person in an ECR is a contribution that never reaches "
            "their account.",
        )
    if not lines:
        raise OutputError("no_pf", "No PF was deducted on this run.")

    header = (
        "# EPFO ECR — UAN#~#Name#~#Gross wages#~#EPF wages#~#EPS wages#~#"
        "EDLI wages#~#EE share#~#EPS contribution#~#ER PF share#~#NCP days#~#"
        "Refund of advances\n"
        f"# {period_label(run)} — amounts in whole rupees. Column set varies by "
        "portal version; check before uploading.\n"
    )
    return (header + "\n".join(lines) + "\n").encode("utf-8")


def esi_return(db: Session, viewer: User, run_id: uuid.UUID) -> bytes:
    """The ESIC monthly contribution file, in its common layout.

    Only employees who actually had ESI deducted appear. Somebody above the wage
    threshold is not an omission — they are outside the scheme that month, which
    is what the threshold means.
    """
    _require_manager(viewer)
    run = _get_run(db, viewer, run_id)
    _require_frozen(run)

    slips = _payslips(db, run)
    totals = _line_totals(db, run, slips)
    users = {
        row.id: row
        for row in db.scalars(
            select(User).where(User.id.in_({slip.user_id for slip in slips} or {uuid.uuid4()}))
        )
    }
    profiles = {
        row.user_id: row
        for row in db.scalars(
            select(EmployeeProfile).where(
                EmployeeProfile.user_id.in_({slip.user_id for slip in slips} or {uuid.uuid4()})
            )
        )
    }

    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow([
        "IP number", "IP name", "Days worked", "Total wages",
        "Employee contribution", "Employer contribution", "Reason code",
    ])

    written = 0
    for slip in slips:
        figures = totals.get(slip.user_id, {})
        employee_esi = figures.get("ESI", 0)
        if not employee_esi:
            continue
        employee = users.get(slip.user_id)
        profile = profiles.get(slip.user_id)
        writer.writerow([
            (profile.esi_number if profile else None) or "",
            employee.full_name if employee else "",
            slip.payable_days,
            f"{slip.gross / 100:.2f}",
            f"{employee_esi / 100:.2f}",
            f"{figures.get('ESI_ER', 0) / 100:.2f}",
            # 0 means worked the full period. Anything else is a reason the
            # portal has its own vocabulary for, which this does not invent.
            "0" if slip.payable_days == slip.month_days else "",
        ])
        written += 1

    if not written:
        raise OutputError(
            "no_esi",
            "No ESI was deducted on this run — everybody is above the wage "
            "threshold, or ESI is not switched on.",
        )
    return buffer.getvalue().encode("utf-8")


# --------------------------------------------------------------------------- #
# The payslip as a document
# --------------------------------------------------------------------------- #


def render_payslip(db: Session, viewer: User, payslip_id: uuid.UUID) -> tuple[Payslip, bytes]:
    """One payslip as a printable page.

    Works on any run, including a draft: seeing what a draft produces is the
    point of reviewing one. *Filing* it is gated on the run being frozen.
    """
    from app.services import payrun as payrun_svc

    try:
        slip = payrun_svc.get_payslip(db, viewer, payslip_id)
    except payrun_svc.PayRunError as error:
        raise OutputError(error.code, error.message, error.status_code) from None

    org = db.get(Organization, viewer.org_id)
    employee = db.get(User, slip.user_id)
    profile = db.get(EmployeeProfile, slip.user_id)
    designation = None
    if employee and employee.designation_id:
        row = db.get(Designation, employee.designation_id)
        designation = row.name if row else None

    lines = list(
        db.scalars(
            select(PayslipLine)
            .where(PayslipLine.payslip_id == slip.id)
            .order_by(PayslipLine.sort_order, PayslipLine.code)
        )
    )
    return slip, _payslip_html(
        slip, lines, org=org, employee=employee, profile=profile,
        designation=designation, period=period_label(slip.run),
    )


def _payslip_html(slip, lines, *, org, employee, profile, designation,
                  period: str) -> bytes:
    """HTML with a print stylesheet — the same choice letters and Form 16 make.

    Earnings and deductions side by side because that is the shape of a payslip
    and the shape people read one in. Employer contributions sit apart from
    both: nobody is paid them and nobody has them taken away.
    """
    def money(paise: int) -> str:
        return f"{paise / 100:,.2f}"

    def rows_for(kind: str) -> str:
        return "".join(
            f"<tr><td>{escape(line.name)}"
            + (f'<div class="ps-detail">{escape(line.detail)}</div>'
               if line.detail else "")
            + f'</td><td class="num">{money(line.amount)}</td></tr>'
            for line in lines if line.kind == kind
        )

    employer_block = ""
    if any(line.kind == "employer" for line in lines):
        employer_block = f"""
<h2>Paid by the company</h2>
<table><tbody>{rows_for("employer")}
<tr class="ps-strong"><td>Total</td>
<td class="num">{money(slip.employer_contributions)}</td></tr>
</tbody></table>"""

    lop = ""
    if slip.payable_days != slip.month_days:
        lop = (
            f'<div class="ps-note">Paid for {slip.payable_days} of '
            f'{slip.month_days} days. A full month would be '
            f'{money(slip.full_gross)}.</div>'
        )

    return f"""<!doctype html>
<html><head><meta charset="utf-8">
<title>Payslip — {escape(employee.full_name if employee else '')} · {escape(period)}</title>
<style>
  body {{ font: 11pt/1.5 Georgia, serif; color: #111; max-width: 720px;
         margin: 36px auto; padding: 0 24px; }}
  .head {{ display: flex; justify-content: space-between; align-items: baseline;
          border-bottom: 2px solid #111; padding-bottom: 8px; }}
  .org {{ font-size: 15pt; font-weight: 700; }}
  .period {{ font-size: 10pt; color: #555; text-align: right; }}
  .who {{ display: flex; gap: 32px; flex-wrap: wrap; margin: 18px 0 6px;
         font-size: 10pt; }}
  .who div {{ flex: 1 1 200px; }}
  .who dt {{ color: #555; }} .who dd {{ margin: 0 0 5px; font-weight: 600; }}
  h2 {{ font-size: 10.5pt; text-transform: uppercase; letter-spacing: .06em;
       margin: 20px 0 4px; }}
  table {{ width: 100%; border-collapse: collapse; }}
  td {{ padding: 3px 0; vertical-align: top; }}
  .num {{ text-align: right; font-variant-numeric: tabular-nums;
         white-space: nowrap; }}
  .ps-strong td {{ font-weight: 700; border-top: 1px solid #999; }}
  .ps-detail {{ font-size: 9pt; color: #666; }}
  .ps-cols {{ display: flex; gap: 32px; flex-wrap: wrap; }}
  .ps-cols > div {{ flex: 1 1 260px; }}
  .ps-net {{ margin-top: 20px; padding-top: 10px; border-top: 2px solid #111;
            font-size: 13pt; text-align: right; }}
  .ps-note {{ margin-top: 8px; font-size: 9.5pt; color: #666; }}
  .foot {{ margin-top: 28px; font-size: 9pt; color: #666; }}
  @media print {{ body {{ margin: 0; max-width: none; }} }}
</style></head><body>
<div class="head">
  <div class="org">{escape((org.legal_name or org.name) if org else '')}</div>
  <div class="period">Payslip<br>{escape(period)}</div>
</div>

<div class="who">
  <div><dl>
    <dt>Employee</dt><dd>{escape(employee.full_name if employee else '')}</dd>
    <dt>Designation</dt><dd>{escape(designation or '—')}</dd>
  </dl></div>
  <div><dl>
    <dt>Employee code</dt><dd>{escape((employee.employee_code if employee else None) or '—')}</dd>
    <dt>Days paid</dt><dd>{slip.payable_days} of {slip.month_days}</dd>
  </dl></div>
  <div><dl>
    <dt>PF number</dt><dd>{escape((profile.pf_number if profile else None) or '—')}</dd>
    <dt>UAN</dt><dd>{escape((profile.uan if profile else None) or '—')}</dd>
  </dl></div>
</div>

<div class="ps-cols">
  <div>
    <h2>Earnings</h2>
    <table><tbody>{rows_for("earning")}
      <tr class="ps-strong"><td>Gross</td>
      <td class="num">{money(slip.gross)}</td></tr>
    </tbody></table>
  </div>
  <div>
    <h2>Deductions</h2>
    <table><tbody>{rows_for("deduction") or '<tr><td colspan="2">None</td></tr>'}
      <tr class="ps-strong"><td>Total</td>
      <td class="num">{money(slip.total_deductions)}</td></tr>
    </tbody></table>
  </div>
</div>
{employer_block}

<div class="ps-net">Net pay <strong>{money(slip.net)}</strong></div>
{lop}

<p class="foot">
  Computer-generated; no signature required. Income tax shown is the amount
  deducted this month against your estimated liability for the year.
</p>
</body></html>""".encode("utf-8")


def file_payslips(
    db: Session, viewer: User, run_id: uuid.UUID, *, request: Request | None = None
) -> int:
    """Put a copy of every payslip into its employee's document record.

    Only on a frozen run: filing a draft would put a figure in somebody's
    permanent record that a recompute then changes.

    Idempotent through ``corehr.file_bytes``'s provenance marker, so running it
    twice does not give anybody two payslips for one month.
    """
    _require_manager(viewer)
    run = _get_run(db, viewer, run_id)
    _require_frozen(run)

    filed = 0
    for slip in _payslips(db, run):
        if slip.document_id is not None:
            continue
        lines = list(
            db.scalars(
                select(PayslipLine)
                .where(PayslipLine.payslip_id == slip.id)
                .order_by(PayslipLine.sort_order, PayslipLine.code)
            )
        )
        employee = db.get(User, slip.user_id)
        profile = db.get(EmployeeProfile, slip.user_id)
        designation = None
        if employee and employee.designation_id:
            row = db.get(Designation, employee.designation_id)
            designation = row.name if row else None
        org = db.get(Organization, viewer.org_id)

        try:
            document = corehr.file_bytes(
                db,
                org_id=viewer.org_id,
                user_id=slip.user_id,
                doc_type="payslip",
                title=f"Payslip — {run.period_label}",
                raw=_payslip_html(slip, lines, org=org, employee=employee,
                                  profile=profile, designation=designation,
                                  period=period_label(run)),
                file_name=f"payslip-{run.period_label}.html",
                content_type="text/html",
                actor=viewer,
                marker=f"payslip:{slip.id}",
            )
        except Exception:  # noqa: BLE001 - filing must not fail the run
            log.exception("could not file payslip %s", slip.id)
            continue
        if document is not None:
            slip.document_id = document.id
            filed += 1

    if filed:
        audit(db, org_id=viewer.org_id, actor=viewer, action="payrun.payslips_filed",
              request=request, target_type="pay_run", target_id=str(run.id),
              detail={"period": run.period_label, "filed": filed})
    db.commit()
    return filed
