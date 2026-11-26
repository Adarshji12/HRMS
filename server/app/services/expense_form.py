"""An expense claim as the paper form.

For a local conveyance claim this is the company's own claim form: employee details, one row per journey
(date, times, from, to, customer, SO number, mode, distance, rate, fare, food, parking, grand total, remarks),
the totals, and the three signature blocks — claimed by, approved by, verified by. The approver and the person who
paid it are filled in from what the system recorded, so the printed form carries the decisions that were made
rather than blank lines to chase.

Pure rendering: a claim in, HTML out. Printing it, or saving it as a PDF, is the browser's job.
"""

from __future__ import annotations

from html import escape

from sqlalchemy.orm import Session

from app.models import ExpenseClaim, ExpenseLine, Organization, User


def _rs(paise: int | None) -> str:
    return f"{(paise or 0) / 100:,.2f}"


def _plain(paise: int | None) -> str:
    return f"{(paise or 0) / 100:g}" if paise else "0"


def _d(value) -> str:
    return value.strftime("%d-%b-%y") if value else ""


def _name(db: Session, user_id) -> str:
    user = db.get(User, user_id) if user_id else None
    return user.full_name if user else ""


def _address(org: Organization | None) -> str:
    if org is None:
        return ""
    parts = [org.address_line1, org.address_line2, org.city, org.state, org.postal_code]
    return ", ".join(p for p in parts if p)


CSS = """
body{margin:0;background:#eef2f6;font:10pt Arial,Helvetica,sans-serif;color:#000}
.pg{max-width:1100px;margin:18px auto;background:#fff;padding:18px 20px 44px}
table{width:100%;border-collapse:collapse}
td,th{border:1px solid #000;padding:3px 6px;font-size:9.5pt}
th{font-weight:700;text-align:center}
.c{text-align:center}.r{text-align:right}.b{font-weight:700}
.co{font-size:11pt;text-align:center;font-weight:700}
.ttl{font-weight:700;text-align:center;font-size:10pt}
.hd td:first-child{width:50px;text-align:center}.hd td:nth-child(2){width:210px;font-weight:700}
.tot td{font-weight:700}
.sig{margin-top:0}.sig td{border-top:0;border-bottom:0;vertical-align:top;padding:8px 6px;font-family:Georgia,serif;font-weight:700}
.sig td span{font-weight:400}
@media print{body{background:#fff}.pg{margin:0;max-width:none;padding:8px}}
*{-webkit-print-color-adjust:exact;print-color-adjust:exact}
"""


def _signature_block(db: Session, claim: ExpenseClaim) -> str:
    claimant = _name(db, claim.user_id)
    approver = _name(db, claim.reviewed_by)
    verifier = _name(db, claim.reimbursed_by)
    claimed_on = _d(claim.submitted_at)
    approved_on = _d(claim.reviewed_at) if approver else ""
    verified_on = _d(claim.reimbursed_at) if verifier else ""
    return f"""<table class="sig"><tr>
<td style="width:36%">Claim by: <span>{escape(claimant)}</span><br>Date: <span>{claimed_on}</span><br>Signature:<br>Employee</td>
<td style="width:32%">Approved by: <span>{escape(approver)}</span><br>Date: <span>{approved_on}</span><br>Signature:<br>Approving authority</td>
<td>Verified by: <span>{escape(verifier)}</span><br>Date: <span>{verified_on}</span><br>Signature:<br>Finance / accounts</td>
</tr></table>"""


def _conveyance(db: Session, claim: ExpenseClaim, org: Organization | None, lines: list[ExpenseLine]) -> str:
    employee = db.get(User, claim.user_id)
    company = (org.legal_name or org.name) if org else ""
    rows = []
    for line in lines:
        rows.append(
            "<tr>"
            f"<td class='b'>{_d(line.spent_on)}</td><td class='c'>{escape(line.start_time or '')}</td><td class='c'>{escape(line.end_time or '')}</td>"
            f"<td>{escape(line.from_location or '')}</td><td>{escape(line.to_location or '')}</td>"
            f"<td>{escape(line.customer_name or '')}</td><td class='c'>{escape(line.so_number or '')}</td>"
            f"<td>{escape(line.conveyance_mode or '')}</td>"
            f"<td class='c'>{'' if line.distance_km is None else f'{line.distance_km:g}'}</td>"
            f"<td class='c'>{'' if not line.rate_per_km else _plain(line.rate_per_km)}</td>"
            f"<td class='c'>{_plain(line.conveyance_amount)}</td><td class='c'>{_plain(line.food_amount)}</td>"
            f"<td class='c'>{_plain(line.parking_amount)}</td><td class='r'>{_rs(line.amount)}</td>"
            f"<td>{escape(line.remarks or '')}</td></tr>"
        )
    fare = sum(l.conveyance_amount or 0 for l in lines)
    food = sum(l.food_amount or 0 for l in lines)
    park = sum(l.parking_amount or 0 for l in lines)
    grand = sum(l.amount for l in lines)
    return f"""<div class="pg">
<table><tr><td class="co">{escape(company)}</td></tr><tr><td>Address:- {escape(_address(org))}</td></tr>
<tr><td class="ttl">LOCAL CONVEYANCE CLAIM FORM</td></tr></table>
<table class="hd">
<tr><td class="b">S.No.</td><td>Description</td><td></td></tr>
<tr><td>1</td><td>Name of Employee:</td><td class="b">{escape(employee.full_name if employee else '')}</td></tr>
<tr><td>2</td><td>Employee Code:</td><td class="b">{escape((employee.employee_code if employee else '') or '')}</td></tr>
<tr><td>3</td><td>Employee Grade:</td><td class="b">{escape(claim.employee_grade or '')}</td></tr>
<tr><td>4</td><td>Location:</td><td class="b">{escape(claim.work_location or '')}</td></tr>
<tr><td>5</td><td>Project:</td><td class="b">{escape(claim.project_label or '')}</td></tr>
</table>
<table><tr><td class="ttl">DETAILS OF THE LOCAL CONVEYANCE CLAIMS</td></tr></table>
<table>
<tr><th colspan="3">Date of Journey &amp; Time</th><th colspan="2">Particulars</th><th rowspan="2">Customer Name</th><th rowspan="2">SO No</th>
<th rowspan="2">Mode of Conveyance</th><th rowspan="2">Distance in Kms</th><th rowspan="2">Rate per KM (as per Policy)</th>
<th rowspan="2">Total</th><th rowspan="2">Food Bill</th><th rowspan="2">Parking / Toll</th><th rowspan="2">Grand Total Amount (Rs.)</th><th rowspan="2">Remarks</th></tr>
<tr><th>DATE</th><th>START TIME</th><th>END TIME</th><th>FROM (Start Location)</th><th>TO (End Location)</th></tr>
{''.join(rows)}
<tr class="tot"><td colspan="3"></td><td></td><td>Total</td><td colspan="5"></td><td class="c">{_plain(fare)}</td><td class="c">{_plain(food)}</td><td class="c">{_plain(park)}</td><td class="r">{_rs(grand)}</td><td></td></tr>
</table>
{_signature_block(db, claim)}
</div>"""


def _general(db: Session, claim: ExpenseClaim, org: Organization | None, lines: list[ExpenseLine]) -> str:
    employee = db.get(User, claim.user_id)
    company = (org.legal_name or org.name) if org else ""
    rows = "".join(
        f"<tr><td>{_d(l.spent_on)}</td><td>{escape(l.description)}{('<br><small>' + escape(l.merchant) + '</small>') if l.merchant else ''}</td>"
        f"<td class='r'>{_rs(l.amount)}</td></tr>" for l in lines)
    return f"""<div class="pg">
<table><tr><td class="co">{escape(company)}</td></tr><tr><td>Address:- {escape(_address(org))}</td></tr>
<tr><td class="ttl">EXPENSE CLAIM — {escape(claim.title)}</td></tr></table>
<table class="hd">
<tr><td>1</td><td>Name of Employee:</td><td class="b">{escape(employee.full_name if employee else '')}</td></tr>
<tr><td>2</td><td>Employee Code:</td><td class="b">{escape((employee.employee_code if employee else '') or '')}</td></tr>
</table>
<table><tr><th>Date</th><th>Particulars</th><th>Amount (Rs.)</th></tr>{rows}
<tr class="tot"><td></td><td class="r">Total</td><td class="r">{_rs(sum(l.amount for l in lines))}</td></tr></table>
{_signature_block(db, claim)}
</div>"""


def render(db: Session, claim: ExpenseClaim) -> str:
    org = db.get(Organization, claim.org_id)
    lines = sorted(claim.lines, key=lambda l: (l.spent_on, l.start_time or "", l.created_at))
    body = _conveyance(db, claim, org, lines) if claim.claim_type == "conveyance" else _general(db, claim, org, lines)
    return (f'<!doctype html><html><head><meta charset="utf-8"><title>{escape(claim.title)}</title>'
            f"<style>{CSS}</style></head><body>{body}</body></html>")
