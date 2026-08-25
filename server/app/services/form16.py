"""Form 16 Part B, and the year-end reconciliation behind it.

Two operations, and the first is the one people use every March:

**Reconcile** adds up what actually happened across a financial year — taxable
salary paid, TDS deducted, PF on both sides — and compares it against the
liability those figures imply. The difference is what March has to correct. It
reads only **frozen** payslips, because a draft run is a working figure and
reconciling against one produces a number that changes when somebody recomputes.

**Issue** freezes that reconciliation onto a ``Form16`` row and files a rendered
certificate into the employee's document record. Every figure is copied. A Form 16
is a statement the employer signed and the employee filed a return against; it has
to say the same thing in three years, after the salary structure has been revised
and the declaration reopened.

**A correction is a revision, not an edit.** Revision 2 gets its own reference
number and supersedes revision 1, which stays readable — somebody may already
have filed against it, and a document that vanishes cannot be reconciled.

**Part A is not produced.** It is TRACES-generated against the employer's TAN and
downloaded from the income-tax portal. Rendering something that looked like it
would let an employee file against a document no tax authority has seen.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timezone
from html import escape

from fastapi import Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import audit
from app.core import taxslabs
from app.core.crypto import decrypt_secret, mask_tail
from app.models import (
    Designation,
    EmployeeProfile,
    Form16,
    Form16Status,
    LineSource,
    Organization,
    PayRun,
    PayRunStatus,
    Payslip,
    PayslipLine,
    Regime,
    TaxDeclaration,
    User,
)
from app.services import corehr
from app.services import incometax as tax_svc
from app.services import payroll as payroll_svc

log = logging.getLogger(__name__)


class Form16Error(Exception):
    """A rule said no, with a code the console can branch on."""

    def __init__(self, code: str, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class Reconciliation:
    """What a year actually produced, against what it should have."""

    user_id: uuid.UUID
    user_name: str
    financial_year: int
    months_covered: int
    gross_salary: int
    professional_tax: int
    employee_pf: int
    employer_pf: int
    tds_deducted: int
    regime: str
    age_band: str
    breakdown: tax_svc.TaxBreakdown
    #: Positive: still owed and March must take it. Negative: over-deducted, and
    #: the employee claims it back on their return — payroll cannot refund TDS.
    balance: int
    #: True when a certificate has already been issued for this year.
    issued: bool = False


def reconcile(
    db: Session, viewer: User, user_id: uuid.UUID, financial_year: int
) -> Reconciliation:
    """Add up the year and compare it against the liability it implies.

    Frozen runs only. A draft is a working figure, and a reconciliation against
    one changes the moment somebody recomputes — which is exactly when finance
    is looking at it.
    """
    subject = db.get(User, user_id)
    if subject is None or subject.org_id != viewer.org_id:
        raise Form16Error("employee_not_found", "Employee not found", 404)
    if not (subject.id == viewer.id or payroll_svc.can_manage(viewer)):
        raise Form16Error(
            "not_permitted", "You may only view your own certificate.", 403
        )

    rows = db.execute(
        select(PayslipLine.kind, PayslipLine.source, PayslipLine.code,
               PayslipLine.amount, PayRun.period_year, PayRun.period_month)
        .join(Payslip, Payslip.id == PayslipLine.payslip_id)
        .join(PayRun, PayRun.id == Payslip.run_id)
        .where(
            Payslip.org_id == viewer.org_id,
            Payslip.user_id == subject.id,
            PayRun.status.in_(
                (PayRunStatus.APPROVED.value, PayRunStatus.PAID.value)
            ),
            # April of the FY through March of the next.
            (PayRun.period_year > financial_year)
            | ((PayRun.period_year == financial_year) & (PayRun.period_month >= 4)),
            (PayRun.period_year < financial_year + 1)
            | ((PayRun.period_year == financial_year + 1)
               & (PayRun.period_month <= 3)),
        )
    ).all()

    gross = pt = employee_pf = employer_pf = tds = 0
    months: set[tuple[int, int]] = set()
    for kind, source, code, amount, period_year, period_month in rows:
        months.add((period_year, period_month))
        if kind == "earning" and source == LineSource.STRUCTURE.value:
            # Structure lines only. A reimbursement is not taxable salary.
            gross += amount
        elif kind == "deduction":
            if source == LineSource.TDS.value:
                tds += amount
            elif source == "professional_tax":
                pt += amount
            elif source == LineSource.PF.value:
                employee_pf += amount
        elif kind == "employer" and source == LineSource.PF.value:
            employer_pf += amount

    declaration = db.scalar(
        select(TaxDeclaration).where(
            TaxDeclaration.user_id == subject.id,
            TaxDeclaration.financial_year == financial_year,
        )
    )
    regime = declaration.regime if declaration else Regime.NEW.value
    deductions: dict[str, int] = {}
    if declaration is not None:
        for item in declaration.items:
            amount = item.effective_amount
            if amount:
                deductions[item.section] = deductions.get(item.section, 0) + amount

    profile = db.get(EmployeeProfile, subject.id)
    age_band = taxslabs.age_band_on(
        profile.date_of_birth if profile else None, financial_year
    )

    breakdown = tax_svc.annual_tax(
        gross_income=gross,
        financial_year=financial_year,
        regime=regime,
        deductions=deductions,
        professional_tax=pt,
        age_band=age_band,
    )

    issued = db.scalar(
        select(func.count(Form16.id)).where(
            Form16.user_id == subject.id,
            Form16.financial_year == financial_year,
            Form16.status == Form16Status.ISSUED.value,
        )
    ) or 0

    return Reconciliation(
        user_id=subject.id,
        user_name=subject.full_name,
        financial_year=financial_year,
        months_covered=len(months),
        gross_salary=gross,
        professional_tax=pt,
        employee_pf=employee_pf,
        employer_pf=employer_pf,
        tds_deducted=tds,
        regime=regime,
        age_band=age_band,
        breakdown=breakdown,
        balance=breakdown.total_tax - tds,
        issued=bool(issued),
    )


def reconcile_all(
    db: Session, viewer: User, financial_year: int
) -> list[Reconciliation]:
    """Everybody who was paid in the year. Payroll capability only."""
    if not payroll_svc.can_manage(viewer):
        raise Form16Error("not_permitted", "You may not run payroll.", 403)

    paid = db.scalars(
        select(Payslip.user_id)
        .join(PayRun, PayRun.id == Payslip.run_id)
        .where(
            Payslip.org_id == viewer.org_id,
            PayRun.status.in_(
                (PayRunStatus.APPROVED.value, PayRunStatus.PAID.value)
            ),
            (PayRun.period_year > financial_year)
            | ((PayRun.period_year == financial_year) & (PayRun.period_month >= 4)),
            (PayRun.period_year < financial_year + 1)
            | ((PayRun.period_year == financial_year + 1)
               & (PayRun.period_month <= 3)),
        )
        .distinct()
    )
    return [reconcile(db, viewer, user_id, financial_year) for user_id in paid]


# --------------------------------------------------------------------------- #
# Issuing
# --------------------------------------------------------------------------- #


def _next_reference(db: Session, org: Organization, financial_year: int) -> str:
    """``ACME/F16/2025-26/0007``.

    Counted rather than kept in a column, like the letters module's reference:
    a counter column is one more thing to get out of step with the rows it
    counts, and this table is small.
    """
    prefix = (org.slug or "org").upper()[:12]
    used = db.scalar(
        select(func.count(Form16.id)).where(
            Form16.org_id == org.id, Form16.financial_year == financial_year
        )
    ) or 0
    return (
        f"{prefix}/F16/{financial_year}-{str(financial_year + 1)[-2:]}/{used + 1:04d}"
    )


def _render(row: Form16, org: Organization, *, full_pan: str | None) -> bytes:
    """The certificate, as a printable page.

    HTML with a print stylesheet, the same choice and the same reason as issued
    letters: no PDF renderer is installed, weasyprint needs native libraries, and
    every browser prints well from a stylesheet. The employee's **full** PAN
    appears here because a Form 16 without it is not usable for filing — but it
    is passed in by the caller, which took the audited reveal path, rather than
    being read from a column.
    """
    def money(paise: int) -> str:
        return f"{paise / 100:,.2f}"

    def line(label: str, amount: int, *, strong: bool = False) -> str:
        cls = ' class="f16-strong"' if strong else ""
        return (
            f'<tr{cls}><td>{escape(label)}</td>'
            f'<td class="num">{money(amount)}</td></tr>'
        )

    balance_label = (
        "Tax payable" if row.balance > 0
        else "Refund claimable on your return" if row.balance < 0
        else "Nil"
    )

    return f"""<!doctype html>
<html><head><meta charset="utf-8">
<title>Form 16 Part B — {escape(row.employee_name or '')}</title>
<style>
  body {{ font: 11pt/1.55 Georgia, serif; color: #111; max-width: 760px;
         margin: 36px auto; padding: 0 24px; }}
  .head {{ border-bottom: 2px solid #111; padding-bottom: 10px; margin-bottom: 8px; }}
  .title {{ font-size: 15pt; font-weight: 700; }}
  .sub {{ font-size: 10pt; color: #555; }}
  .meta {{ display: flex; gap: 32px; flex-wrap: wrap; margin: 18px 0 24px;
          font-size: 10pt; }}
  .meta div {{ flex: 1 1 220px; }}
  .meta dt {{ color: #555; }}
  .meta dd {{ margin: 0 0 6px; font-weight: 600; }}
  h2 {{ font-size: 11pt; text-transform: uppercase; letter-spacing: .06em;
       margin: 24px 0 6px; }}
  table {{ width: 100%; border-collapse: collapse; }}
  td {{ padding: 3px 0; vertical-align: top; }}
  .num {{ text-align: right; font-variant-numeric: tabular-nums;
         white-space: nowrap; }}
  .f16-strong td {{ font-weight: 700; border-top: 1px solid #999; }}
  .f16-slab td {{ color: #555; font-size: 10pt; padding-left: 16px; }}
  .foot {{ margin-top: 32px; font-size: 9.5pt; color: #555; }}
  @media print {{ body {{ margin: 0; max-width: none; }} }}
</style></head><body>
<div class="head">
  <div class="title">Form 16 — Part B</div>
  <div class="sub">
    Certificate of tax deducted at source on salary ·
    {escape(taxslabs.year_label(row.financial_year))}
    {' · Revision ' + str(row.revision) if row.revision > 1 else ''}
  </div>
</div>

<div class="meta">
  <div><dl>
    <dt>Employee</dt><dd>{escape(row.employee_name or '')}</dd>
    <dt>Designation</dt><dd>{escape(row.designation or '—')}</dd>
    <dt>PAN</dt><dd>{escape(full_pan or row.employee_pan_masked or '—')}</dd>
  </dl></div>
  <div><dl>
    <dt>Employer</dt><dd>{escape(row.employer_name or '')}</dd>
    <dt>Certificate</dt><dd>{escape(row.reference_no)}</dd>
    <dt>Issued</dt><dd>{row.issued_on.isoformat()}</dd>
  </dl></div>
</div>

<h2>Gross salary and deductions</h2>
<table><tbody>
{line("Salary paid (" + str(row.months_covered) + " month(s))", row.gross_salary)}
{line("Less: standard deduction", row.standard_deduction)}
{line("Less: tax on employment (professional tax)", row.professional_tax)}
{line("Less: deductions under Chapter VI-A", row.chapter_via)}
{line("Total taxable income", row.taxable_income, strong=True)}
</tbody></table>

<h2>Tax computed — {escape(row.regime)} regime</h2>
<table><tbody>
{line("Tax on total income", row.tax_before_rebate)}
{line("Less: rebate under section 87A", row.rebate)}
{line("Surcharge", row.surcharge)}
{line("Health and education cess", row.cess)}
{line("Total tax for the year", row.total_tax, strong=True)}
{line("Tax deducted at source", row.tds_deducted)}
{line(balance_label, abs(row.balance), strong=True)}
</tbody></table>

<h2>Provident fund</h2>
<table><tbody>
{line("Employee contribution", row.employee_pf)}
{line("Employer contribution", row.employer_pf)}
</tbody></table>

<p class="foot">
  This is Part B only. Part A — the statement of tax deposited against the
  employer's TAN — is generated by TRACES and downloaded from the income-tax
  portal; it is not produced by this system. Amounts are in rupees.
</p>
</body></html>""".encode("utf-8")


def issue(
    db: Session,
    viewer: User,
    user_id: uuid.UUID,
    financial_year: int,
    *,
    note: str | None = None,
    request: Request | None = None,
) -> Form16:
    """Freeze the reconciliation into a certificate and file it.

    Issuing a second time creates **revision 2** and supersedes the first, which
    stays readable — somebody may already have filed against it.
    """
    if not payroll_svc.can_manage(viewer):
        raise Form16Error("not_permitted", "You may not issue certificates.", 403)

    result = reconcile(db, viewer, user_id, financial_year)
    if result.months_covered == 0:
        raise Form16Error(
            "nothing_to_certify",
            "No approved payroll exists for that employee in that year.",
        )

    org = db.get(Organization, viewer.org_id)
    subject = db.get(User, user_id)
    profile = db.get(EmployeeProfile, user_id)

    previous = list(
        db.scalars(
            select(Form16).where(
                Form16.user_id == user_id,
                Form16.financial_year == financial_year,
            ).order_by(Form16.revision)
        )
    )
    for old in previous:
        old.status = Form16Status.REVISED.value

    designation = None
    if subject.designation_id:
        row = db.get(Designation, subject.designation_id)
        designation = row.name if row else None

    pan = decrypt_secret(profile.pan_enc, label="PAN") if profile else ""
    breakdown = result.breakdown

    certificate = Form16(
        org_id=viewer.org_id,
        user_id=user_id,
        financial_year=financial_year,
        revision=(previous[-1].revision + 1) if previous else 1,
        reference_no=_next_reference(db, org, financial_year),
        status=Form16Status.ISSUED.value,
        gross_salary=result.gross_salary,
        standard_deduction=breakdown.standard_deduction,
        professional_tax=breakdown.professional_tax,
        chapter_via=breakdown.chapter_via,
        taxable_income=breakdown.taxable_income,
        tax_before_rebate=breakdown.tax_before_rebate,
        rebate=breakdown.rebate,
        surcharge=breakdown.surcharge,
        cess=breakdown.cess,
        total_tax=breakdown.total_tax,
        tds_deducted=result.tds_deducted,
        balance=result.balance,
        employer_pf=result.employer_pf,
        employee_pf=result.employee_pf,
        regime=result.regime,
        age_band=result.age_band,
        months_covered=result.months_covered,
        employee_name=subject.full_name,
        # Masked on the row; the full number is rendered onto the certificate
        # from the decrypted value above and never stored a second time.
        employee_pan_masked=mask_tail(pan) if pan else None,
        designation=designation,
        employer_name=org.legal_name or org.name,
        issued_on=date.today(),
        issued_by=viewer.id,
        note=(note or "").strip() or None,
    )
    db.add(certificate)
    db.flush()

    # Filing is a side effect that must not fail the issue — same posture as a
    # promoted onboarding document and an issued letter.
    try:
        document = corehr.file_bytes(
            db,
            org_id=viewer.org_id,
            user_id=user_id,
            doc_type="form_16",
            title=f"Form 16 — {taxslabs.year_label(financial_year)}",
            raw=_render(certificate, org, full_pan=pan or None),
            file_name=f"{certificate.reference_no.replace('/', '-')}.html",
            content_type="text/html",
            actor=viewer,
            marker=f"form16:{certificate.id}",
        )
    except Exception:  # noqa: BLE001
        log.exception("could not file Form 16 %s", certificate.id)
        document = None
    if document is not None:
        certificate.document_id = document.id

    audit(db, org_id=viewer.org_id, actor=viewer, action="tax.form16_issued",
          request=request, target_type="form16", target_id=str(certificate.id),
          detail={"for": str(user_id), "financial_year": financial_year,
                  "revision": certificate.revision,
                  "reference": certificate.reference_no,
                  "total_tax": certificate.total_tax,
                  "tds_deducted": certificate.tds_deducted,
                  "balance": certificate.balance})
    db.commit()
    db.refresh(certificate)
    return certificate


def get(db: Session, viewer: User, form16_id: uuid.UUID) -> Form16:
    row = db.get(Form16, form16_id)
    if row is None or row.org_id != viewer.org_id:
        raise Form16Error("not_found", "Certificate not found", 404)
    if row.user_id == viewer.id or payroll_svc.can_manage(viewer):
        return row
    raise Form16Error("not_permitted", "You may not view this certificate.", 403)


def render(db: Session, viewer: User, form16_id: uuid.UUID) -> tuple[Form16, bytes]:
    """The printable certificate.

    The full PAN is included only when the reader is the employee themselves or
    a payroll manager — both of whom Core HR would let reveal it anyway. This
    goes through the same decryption rather than a stored copy.
    """
    row = get(db, viewer, form16_id)
    org = db.get(Organization, viewer.org_id)
    profile = db.get(EmployeeProfile, row.user_id)
    pan = decrypt_secret(profile.pan_enc, label="PAN") if profile else ""
    return row, _render(row, org, full_pan=pan or None)


def list_for(db: Session, viewer: User, user_id: uuid.UUID) -> list[Form16]:
    subject = db.get(User, user_id)
    if subject is None or subject.org_id != viewer.org_id:
        raise Form16Error("employee_not_found", "Employee not found", 404)
    if not (subject.id == viewer.id or payroll_svc.can_manage(viewer)):
        raise Form16Error("not_permitted", "You may only view your own.", 403)
    return list(
        db.scalars(
            select(Form16)
            .where(Form16.org_id == viewer.org_id, Form16.user_id == subject.id)
            .order_by(Form16.financial_year.desc(), Form16.revision.desc())
        )
    )
