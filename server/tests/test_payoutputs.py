"""Payroll checkpoint 5 — register, bank file, statutory returns, payslips.

Four outputs, and what each test is really defending:

1. **The register's totals are summed from the payslip lines**, not read off the
   run, so a disagreement between them shows up in the document somebody is
   checking rather than hiding behind the stored figure.
2. **The bank file refuses rather than skipping.** An employee silently missing
   is somebody who does not get paid and finds out on payday.
3. **Everything but the payslip render requires a frozen run.** A register that
   moves when somebody recomputes is not a register.
4. **Filing a payslip is idempotent**, so running it twice does not give anybody
   two payslips for one month.

Amounts inside the system are paise; the CSVs convert to rupees at their own
edge, and the PF ECR to whole rupees — the detail that ruins a filing when
missed.
"""

from __future__ import annotations

import csv
import io

from sqlalchemy import select

from app.db.session import SessionLocal
from app.models import EmployeeDocument, EmployeeProfile, Payslip, User


def _setup(client, tenant, *, gross=1_00_000_00, statutory=True):
    made = {}
    for body in (
        {"code": "BASIC", "name": "Basic", "calculation": "percent_of_gross",
         "rate_bps": 4000, "is_basic": True, "is_pf_wage": True, "sort_order": 10},
        {"code": "SPL", "name": "Special Allowance", "calculation": "balance",
         "is_basic": False, "is_pf_wage": False, "rate_bps": 0, "sort_order": 90},
    ):
        made[body["code"]] = client.post("/api/v1/payroll/components", json=body,
                                         headers=tenant.headers()).json()
    client.post(
        f"/api/v1/payroll/{tenant.employee.id}",
        json={"effective_from": "2026-01-01", "gross_monthly": gross,
              "components": [{"component_id": made[c]["id"]} for c in ("BASIC", "SPL")]},
        headers=tenant.headers(),
    )
    if statutory:
        client.put("/api/v1/statutory/config",
                   json={"pf_enabled": True, "esi_enabled": True},
                   headers=tenant.headers())
    return made


def _bank_details(client, tenant, *, account="50100123456789", ifsc="HDFC0001234"):
    client.patch(
        f"/api/v1/people/{tenant.employee.id}",
        json={"bank_account": account, "bank_ifsc": ifsc,
              "bank_name": "HDFC Bank", "bank_account_name": "Sara Khan"},
        headers=tenant.headers(tenant.employee_token),
    )


def _run(client, tenant, *, month=6, approve=True, pay=False):
    run = client.post("/api/v1/payruns",
                      json={"period_year": 2026, "period_month": month},
                      headers=tenant.headers()).json()
    client.post(f"/api/v1/payruns/{run['id']}/compute", json={"overrides": []},
                headers=tenant.headers())
    if approve:
        client.post(f"/api/v1/payruns/{run['id']}/approve", headers=tenant.headers())
    if pay:
        client.post(f"/api/v1/payruns/{run['id']}/pay", json={},
                    headers=tenant.headers())
    return run


# --------------------------------------------------------------------------- #
# Register
# --------------------------------------------------------------------------- #


def test_the_register_totals_tie_to_the_run(client, tenants):
    acme, _ = tenants
    _setup(client, acme)
    run = _run(client, acme)

    body = client.get(f"/api/v1/payruns/{run['id']}/register",
                      headers=acme.headers()).json()

    assert body["period"] == "June 2026"
    assert len(body["rows"]) == 1
    assert body["earning_codes"] == ["BASIC", "SPL"]
    assert "PF" in body["deduction_codes"]
    assert body["employer_codes"] == ["EPS", "EPF"]

    row = body["rows"][0]
    assert row["gross"] == 1_00_000_00
    assert sum(row["earnings"].values()) == row["gross"]
    assert row["net"] == row["gross"] - row["total_deductions"]

    # Summed from the lines, and they agree with the run — which is what the
    # empty discrepancy list asserts.
    assert body["totals"]["gross"] == 1_00_000_00
    assert body["discrepancies"] == []


def test_the_register_reports_a_disagreement_rather_than_hiding_it(client, tenants):
    """A register that quietly prints the stored figure makes the discrepancy
    invisible in exactly the document somebody is checking."""
    acme, _ = tenants
    _setup(client, acme)
    run = _run(client, acme)

    with SessionLocal() as db:
        from app.models import PayRun
        import uuid as _uuid

        stored = db.get(PayRun, _uuid.UUID(run["id"]))
        stored.total_gross += 100_00       # somebody or something got it wrong
        db.commit()

    body = client.get(f"/api/v1/payruns/{run['id']}/register",
                      headers=acme.headers()).json()
    assert body["discrepancies"]
    assert "gross" in body["discrepancies"][0]


def test_a_draft_run_has_no_register(client, tenants):
    acme, _ = tenants
    _setup(client, acme)
    run = _run(client, acme, approve=False)
    response = client.get(f"/api/v1/payruns/{run['id']}/register",
                          headers=acme.headers())
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "not_approved"


def test_the_register_csv_is_in_rupees(client, tenants):
    """It is opened in a spreadsheet by a person, and a column of paise integers
    is a column nobody can read."""
    acme, _ = tenants
    _setup(client, acme)
    run = _run(client, acme)

    response = client.get(f"/api/v1/payruns/{run['id']}/register.csv",
                          headers=acme.headers())
    assert response.status_code == 200
    assert "attachment" in response.headers["content-disposition"]

    rows = list(csv.reader(io.StringIO(response.text)))
    assert rows[0][:3] == ["Employee", "Code", "Days"]
    gross_column = rows[0].index("Gross")
    assert rows[1][gross_column] == "100000.00"
    assert rows[-1][0] == "Total"


def test_only_a_payroll_manager_sees_the_register(client, tenants):
    acme, _ = tenants
    _setup(client, acme)
    run = _run(client, acme)
    assert client.get(f"/api/v1/payruns/{run['id']}/register",
                      headers=acme.headers(acme.employee_token)).status_code == 403


# --------------------------------------------------------------------------- #
# Bank file
# --------------------------------------------------------------------------- #


def test_the_bank_file_carries_net_pay_and_account_details(client, tenants):
    acme, _ = tenants
    _setup(client, acme)
    _bank_details(client, acme)
    run = _run(client, acme)

    response = client.post(f"/api/v1/payruns/{run['id']}/bank-file",
                           headers=acme.headers())
    assert response.status_code == 200
    rows = list(csv.reader(io.StringIO(response.text)))
    assert rows[0][3:5] == ["Account number", "IFSC"]
    assert rows[1][3] == "50100123456789"
    assert rows[1][4] == "HDFC0001234"
    assert rows[1][7] == "Salary June 2026"


def test_the_bank_file_refuses_rather_than_skipping_somebody(client, tenants):
    """An employee silently missing is somebody who does not get paid and finds
    out on payday."""
    acme, _ = tenants
    _setup(client, acme)
    run = _run(client, acme)          # no bank details set

    response = client.post(f"/api/v1/payruns/{run['id']}/bank-file",
                           headers=acme.headers())
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "missing_bank_details"
    assert acme.employee.full_name in response.json()["detail"]["message"]


def test_generating_the_bank_file_is_audited(client, tenants):
    """"Who exported everybody's bank details on the 3rd" has to be
    answerable."""
    acme, _ = tenants
    _setup(client, acme)
    _bank_details(client, acme)
    run = _run(client, acme)
    client.post(f"/api/v1/payruns/{run['id']}/bank-file", headers=acme.headers())

    with SessionLocal() as db:
        from app.models import AuditLog

        rows = list(
            db.scalars(
                select(AuditLog).where(
                    AuditLog.org_id == acme.id,
                    AuditLog.action == "payrun.bank_file_generated",
                )
            )
        )
    assert len(rows) == 1
    assert rows[0].detail["employees"] == 1


def test_an_employee_cannot_generate_the_bank_file(client, tenants):
    acme, _ = tenants
    _setup(client, acme)
    _bank_details(client, acme)
    run = _run(client, acme)
    assert client.post(f"/api/v1/payruns/{run['id']}/bank-file",
                       headers=acme.headers(acme.employee_token)).status_code == 403


# --------------------------------------------------------------------------- #
# Statutory filings
# --------------------------------------------------------------------------- #


def test_the_pf_ecr_is_in_whole_rupees_and_needs_a_uan(client, tenants):
    """Whole rupees is the detail that ruins a filing when missed."""
    acme, _ = tenants
    _setup(client, acme)
    run = _run(client, acme)

    missing = client.get(f"/api/v1/payruns/{run['id']}/pf-ecr",
                         headers=acme.headers())
    assert missing.status_code == 422
    assert missing.json()["detail"]["reason"] == "missing_uan"

    client.patch(f"/api/v1/people/{acme.employee.id}",
                 json={"uan": "100200300400"},
                 headers=acme.headers(acme.employee_token))

    response = client.get(f"/api/v1/payruns/{run['id']}/pf-ecr",
                          headers=acme.headers())
    assert response.status_code == 200
    body = response.text
    assert body.startswith("# EPFO ECR")

    row = [line for line in body.splitlines() if not line.startswith("#")][0]
    fields = row.split("#~#")
    assert fields[0] == "100200300400"
    # Employee PF is 12% of ₹15,000 = ₹1,800 — written as 1800, not 180000.
    assert fields[6] == "1800"
    # And no field carries a decimal point.
    assert all("." not in field for field in fields[2:])


def test_the_esi_return_lists_only_those_inside_the_scheme(client, tenants):
    """Somebody above the wage threshold is not an omission — they are outside
    the scheme that month, which is what a threshold means."""
    acme, _ = tenants
    _setup(client, acme, gross=1_00_000_00)      # well above ₹21,000
    run = _run(client, acme)

    response = client.get(f"/api/v1/payruns/{run['id']}/esi-return",
                          headers=acme.headers())
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "no_esi"


def test_the_esi_return_carries_a_low_earner(client, tenants):
    acme, _ = tenants
    _setup(client, acme, gross=18_000_00)
    client.patch(f"/api/v1/people/{acme.employee.id}",
                 json={"esi_number": "3100123456"},
                 headers=acme.headers(acme.employee_token))
    run = _run(client, acme)

    response = client.get(f"/api/v1/payruns/{run['id']}/esi-return",
                          headers=acme.headers())
    assert response.status_code == 200
    rows = list(csv.reader(io.StringIO(response.text)))
    assert rows[0][0] == "IP number"
    assert rows[1][0] == "3100123456"
    assert rows[1][3] == "18000.00"
    assert rows[1][4] == "135.00"     # 0.75%
    assert rows[1][5] == "585.00"     # 3.25%


# --------------------------------------------------------------------------- #
# Payslip documents
# --------------------------------------------------------------------------- #


def test_a_payslip_renders_as_a_printable_page(client, tenants):
    acme, _ = tenants
    _setup(client, acme)
    run = _run(client, acme)
    detail = client.get(f"/api/v1/payruns/{run['id']}", headers=acme.headers()).json()
    slip_id = detail["payslips"][0]["id"]

    page = client.get(f"/api/v1/payruns/payslips/{slip_id}/print",
                      headers=acme.headers(acme.employee_token))
    assert page.status_code == 200
    assert acme.employee.full_name in page.text
    assert "June 2026" in page.text
    assert "Net pay" in page.text


def test_filing_payslips_is_idempotent(client, tenants):
    """Running it twice must not give anybody two payslips for one month."""
    acme, _ = tenants
    _setup(client, acme)
    run = _run(client, acme)

    first = client.post(f"/api/v1/payruns/{run['id']}/file-payslips",
                        headers=acme.headers()).json()
    assert first["filed"] == 1

    second = client.post(f"/api/v1/payruns/{run['id']}/file-payslips",
                         headers=acme.headers()).json()
    assert second["filed"] == 0

    docs = client.get(f"/api/v1/people/{acme.employee.id}/documents",
                      headers=acme.headers()).json()
    assert len([doc for doc in docs if doc["doc_type"] == "payslip"]) == 1

    # Through the API, not the session: the console decides whether to show a
    # payslip as filed from what the endpoint returns, and a field the model has
    # but the schema drops would pass a database-level assertion while leaving
    # the screen unable to tell filed from unfiled.
    detail = client.get(f"/api/v1/payruns/{run['id']}",
                        headers=acme.headers()).json()
    assert detail["payslips"][0]["document_id"] ==         [doc for doc in docs if doc["doc_type"] == "payslip"][0]["id"]


def test_a_draft_runs_payslips_cannot_be_filed(client, tenants):
    """Filing a draft would put a figure in somebody's permanent record that a
    recompute then changes."""
    acme, _ = tenants
    _setup(client, acme)
    run = _run(client, acme, approve=False)
    response = client.post(f"/api/v1/payruns/{run['id']}/file-payslips",
                           headers=acme.headers())
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "not_approved"


def test_a_draft_payslip_still_renders(client, tenants):
    """Seeing what a draft produces is the point of reviewing one — it is
    *filing* that requires approval."""
    acme, _ = tenants
    _setup(client, acme)
    run = _run(client, acme, approve=False)
    detail = client.get(f"/api/v1/payruns/{run['id']}", headers=acme.headers()).json()
    slip_id = detail["payslips"][0]["id"]
    assert client.get(f"/api/v1/payruns/payslips/{slip_id}/print",
                      headers=acme.headers()).status_code == 200


def test_outputs_do_not_cross_tenants(client, tenants):
    acme, globex = tenants
    _setup(client, acme)
    _bank_details(client, acme)
    run = _run(client, acme)
    for call in (
        client.get(f"/api/v1/payruns/{run['id']}/register", headers=globex.headers()),
        client.post(f"/api/v1/payruns/{run['id']}/bank-file", headers=globex.headers()),
        client.get(f"/api/v1/payruns/{run['id']}/pf-ecr", headers=globex.headers()),
    ):
        assert call.status_code == 404
