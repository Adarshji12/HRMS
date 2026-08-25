"""Payroll checkpoint 4b — senior slabs, year-end reconciliation, Form 16.

Three things this defends:

1. **Senior-citizen slabs**, and the rule that age is taken at 31 March — so
   somebody turning 60 in March is a senior citizen for that whole year.
2. **Reconciliation reads frozen payslips only.** A draft is a working figure,
   and a March reconciliation that moves when somebody recomputes is worse than
   no reconciliation.
3. **A Form 16 is frozen, and a correction is a revision.** Every figure is
   copied at issue and nothing recomputes it; issuing again supersedes rather
   than editing, because somebody may already have filed against the first one.

Amounts are integer paise.
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import select

from app.core.taxslabs import AgeBand, age_band_on, rules_for
from app.db.session import SessionLocal
from app.models import EmployeeProfile, Form16, Form16Status
from app.services import incometax as tax

LAKH = 10_000_000


# --------------------------------------------------------------------------- #
# Senior-citizen slabs
# --------------------------------------------------------------------------- #


def test_the_nil_band_widens_with_age_under_the_old_regime():
    assert rules_for(2025, "old", AgeBand.BELOW_60.value).slabs[0].ceiling == 250_000_00
    assert rules_for(2025, "old", AgeBand.SENIOR.value).slabs[0].ceiling == 300_000_00
    assert (rules_for(2025, "old", AgeBand.SUPER_SENIOR.value).slabs[0].ceiling
            == 500_000_00)


def test_the_new_regime_has_no_age_variants():
    """One more thing the trade buys — and why passing a band with it is
    harmless rather than an error."""
    ordinary = rules_for(2025, "new", AgeBand.BELOW_60.value)
    senior = rules_for(2025, "new", AgeBand.SUPER_SENIOR.value)
    assert ordinary.slabs == senior.slabs


def test_a_senior_pays_less_on_the_same_income():
    """₹8L, old regime: ₹65,000 ordinary, ₹62,400 senior, ₹52,000 super."""
    figures = {
        band: tax.annual_tax(gross_income=8 * LAKH, financial_year=2025,
                             regime="old", age_band=band).total_tax
        for band in (AgeBand.BELOW_60.value, AgeBand.SENIOR.value,
                     AgeBand.SUPER_SENIOR.value)
    }
    assert figures[AgeBand.BELOW_60.value] == 65_000_00
    assert figures[AgeBand.SENIOR.value] == 62_400_00
    assert figures[AgeBand.SUPER_SENIOR.value] == 52_000_00


def test_age_is_taken_at_the_end_of_the_financial_year():
    """Somebody turning 60 in March is a senior citizen for that whole year —
    getting it wrong mis-taxes them for eleven months."""
    # Turns 60 on 15 March 2026, inside FY 2025-26.
    assert age_band_on(date(1966, 3, 15), 2025) == AgeBand.SENIOR.value
    # Turns 60 on 15 April 2026, which is the *next* financial year.
    assert age_band_on(date(1966, 4, 15), 2025) == AgeBand.BELOW_60.value
    assert age_band_on(date(1946, 1, 1), 2025) == AgeBand.SUPER_SENIOR.value


def test_a_missing_date_of_birth_is_the_ordinary_band():
    """Refusing to run payroll over a missing birthday would be absurd."""
    assert age_band_on(None, 2025) == AgeBand.BELOW_60.value


# --------------------------------------------------------------------------- #
# Fixtures: a paid year
# --------------------------------------------------------------------------- #


def _payroll_ready(client, tenant, *, gross):
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
    return made


def _paid_month(client, tenant, month, *, approve=True, pay=True):
    run = client.post("/api/v1/payruns",
                      json={"period_year": 2026, "period_month": month},
                      headers=tenant.headers()).json()
    client.post(f"/api/v1/payruns/{run['id']}/compute", json={"overrides": []},
                headers=tenant.headers())
    if approve:
        client.post(f"/api/v1/payruns/{run['id']}/approve", headers=tenant.headers())
    if approve and pay:
        client.post(f"/api/v1/payruns/{run['id']}/pay", json={},
                    headers=tenant.headers())
    return run


# --------------------------------------------------------------------------- #
# Reconciliation
# --------------------------------------------------------------------------- #


def test_reconciliation_adds_up_the_months_that_were_paid(client, tenants):
    acme, _ = tenants
    _payroll_ready(client, acme, gross=2_00_000_00)
    for month in (4, 5, 6):
        _paid_month(client, acme, month)

    body = client.get(
        f"/api/v1/form16/reconcile/{acme.employee.id}?financial_year=2026",
        headers=acme.headers(),
    ).json()

    assert body["months_covered"] == 3
    assert body["gross_salary"] == 6_00_000_00        # three months at ₹2L
    assert body["tds_deducted"] > 0

    # The balance is NEGATIVE part-way through a year, and that is right rather
    # than a bug. TDS is deducted against a *twelve-month projection* of ₹24L;
    # the reconciliation computes tax on the ₹6L actually paid so far, which the
    # new regime's rebate wipes entirely. So three months of deduction sit
    # against three months of nil liability.
    #
    # This is why reconciliation is a March activity: it only means "over-
    # deducted" once the year is complete. `months_covered` is what tells a
    # reader which of the two they are looking at.
    assert body["balance"] < 0
    assert body["total_tax"] == 0
    assert body["balance"] == -body["tds_deducted"]
    assert body["issued"] is False


def test_a_draft_run_does_not_count(client, tenants):
    """A March reconciliation that moves when somebody recomputes is worse than
    no reconciliation."""
    acme, _ = tenants
    _payroll_ready(client, acme, gross=2_00_000_00)
    _paid_month(client, acme, 4)
    _paid_month(client, acme, 5, approve=False)      # left computed, not approved

    body = client.get(
        f"/api/v1/form16/reconcile/{acme.employee.id}?financial_year=2026",
        headers=acme.headers(),
    ).json()
    assert body["months_covered"] == 1
    assert body["gross_salary"] == 2_00_000_00


def test_a_reimbursement_is_not_taxable_salary(client, tenants):
    acme, _ = tenants
    _payroll_ready(client, acme, gross=2_00_000_00)

    category = client.post("/api/v1/expenses/categories",
                           json={"name": "Travel", "requires_receipt": False},
                           headers=acme.headers()).json()
    claim = client.post("/api/v1/expenses", json={"title": "Trip"},
                        headers=acme.headers(acme.employee_token)).json()
    client.post(f"/api/v1/expenses/{claim['id']}/lines",
                json={"category_id": category["id"], "spent_on": "2026-04-05",
                      "description": "Taxi", "amount": 500_00},
                headers=acme.headers(acme.employee_token))
    client.post(f"/api/v1/expenses/{claim['id']}/submit",
                headers=acme.headers(acme.employee_token))
    client.post(f"/api/v1/expenses/{claim['id']}/review",
                json={"status": "approved"}, headers=acme.headers())

    _paid_month(client, acme, 4)
    body = client.get(
        f"/api/v1/form16/reconcile/{acme.employee.id}?financial_year=2026",
        headers=acme.headers(),
    ).json()
    assert body["gross_salary"] == 2_00_000_00        # the ₹500 is not in it


def test_an_employee_sees_their_own_reconciliation_but_not_a_colleagues(client, tenants):
    acme, _ = tenants
    _payroll_ready(client, acme, gross=2_00_000_00)
    _paid_month(client, acme, 4)

    assert client.get(
        f"/api/v1/form16/reconcile/{acme.employee.id}?financial_year=2026",
        headers=acme.headers(acme.employee_token),
    ).status_code == 200
    assert client.get(
        f"/api/v1/form16/reconcile/{acme.owner.id}?financial_year=2026",
        headers=acme.headers(acme.employee_token),
    ).status_code == 403
    assert client.get("/api/v1/form16/reconcile?financial_year=2026",
                      headers=acme.headers(acme.employee_token)).status_code == 403


# --------------------------------------------------------------------------- #
# Issuing
# --------------------------------------------------------------------------- #


def test_issuing_freezes_the_figures_and_files_the_certificate(client, tenants):
    acme, _ = tenants
    _payroll_ready(client, acme, gross=2_00_000_00)
    for month in (4, 5):
        _paid_month(client, acme, month)

    before = client.get(
        f"/api/v1/form16/reconcile/{acme.employee.id}?financial_year=2026",
        headers=acme.headers(),
    ).json()

    issued = client.post(f"/api/v1/form16/issue/{acme.employee.id}",
                         json={"financial_year": 2026},
                         headers=acme.headers()).json()

    assert issued["revision"] == 1
    assert issued["reference_no"].startswith("ACME/F16/2026-27/")
    assert issued["gross_salary"] == before["gross_salary"]
    assert issued["tds_deducted"] == before["tds_deducted"]
    assert issued["months_covered"] == 2
    assert issued["document_id"] is not None

    # And it is in the employee's document record, where they would look.
    docs = client.get(f"/api/v1/people/{acme.employee.id}/documents",
                      headers=acme.headers()).json()
    assert any(doc["doc_type"] == "form_16" for doc in docs)


def test_a_later_payroll_does_not_change_an_issued_certificate(client, tenants):
    """A Form 16 is a statement somebody filed a return against."""
    acme, _ = tenants
    _payroll_ready(client, acme, gross=2_00_000_00)
    _paid_month(client, acme, 4)
    issued = client.post(f"/api/v1/form16/issue/{acme.employee.id}",
                         json={"financial_year": 2026},
                         headers=acme.headers()).json()

    _paid_month(client, acme, 5)

    after = client.get(f"/api/v1/form16/employee/{acme.employee.id}",
                       headers=acme.headers()).json()[0]
    assert after["gross_salary"] == issued["gross_salary"]
    assert after["months_covered"] == 1

    # The live reconciliation has moved on, which is the point of having both.
    live = client.get(
        f"/api/v1/form16/reconcile/{acme.employee.id}?financial_year=2026",
        headers=acme.headers(),
    ).json()
    assert live["months_covered"] == 2
    assert live["gross_salary"] > issued["gross_salary"]


def test_issuing_again_creates_a_revision_and_supersedes_the_first(client, tenants):
    """A correction is a revision, not an edit — somebody may already have filed
    against the first one."""
    acme, _ = tenants
    _payroll_ready(client, acme, gross=2_00_000_00)
    _paid_month(client, acme, 4)
    first = client.post(f"/api/v1/form16/issue/{acme.employee.id}",
                        json={"financial_year": 2026},
                        headers=acme.headers()).json()

    _paid_month(client, acme, 5)
    second = client.post(f"/api/v1/form16/issue/{acme.employee.id}",
                         json={"financial_year": 2026, "note": "Corrected"},
                         headers=acme.headers()).json()

    assert second["revision"] == 2
    assert second["reference_no"] != first["reference_no"]
    assert second["months_covered"] == 2

    rows = client.get(f"/api/v1/form16/employee/{acme.employee.id}",
                      headers=acme.headers()).json()
    by_revision = {row["revision"]: row for row in rows}
    # The superseded one stays readable.
    assert by_revision[1]["status"] == "revised"
    assert by_revision[2]["status"] == "issued"


def test_a_year_with_no_payroll_cannot_be_certified(client, tenants):
    acme, _ = tenants
    response = client.post(f"/api/v1/form16/issue/{acme.employee.id}",
                           json={"financial_year": 2026},
                           headers=acme.headers())
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "nothing_to_certify"


def test_an_employee_cannot_issue_their_own_certificate(client, tenants):
    acme, _ = tenants
    _payroll_ready(client, acme, gross=2_00_000_00)
    _paid_month(client, acme, 4)
    assert client.post(f"/api/v1/form16/issue/{acme.employee.id}",
                       json={"financial_year": 2026},
                       headers=acme.headers(acme.employee_token)).status_code == 403


# --------------------------------------------------------------------------- #
# The certificate itself
# --------------------------------------------------------------------------- #


def test_the_certificate_renders_with_the_full_pan_for_the_employee(client, tenants):
    """A Form 16 without the PAN is not usable for filing — but it is read
    through the encrypted value, not a second stored copy."""
    acme, _ = tenants
    client.patch(f"/api/v1/people/{acme.employee.id}",
                 json={"pan": "ABCDE1234F"},
                 headers=acme.headers(acme.employee_token))
    _payroll_ready(client, acme, gross=2_00_000_00)
    _paid_month(client, acme, 4)
    issued = client.post(f"/api/v1/form16/issue/{acme.employee.id}",
                         json={"financial_year": 2026},
                         headers=acme.headers()).json()

    # The row itself holds only the masked value.
    assert "ABCDE1234F" not in str(issued)
    assert issued["employee_pan_masked"].endswith("234F")

    page = client.get(f"/api/v1/form16/{issued['id']}/print",
                      headers=acme.headers(acme.employee_token))
    assert page.status_code == 200
    assert "ABCDE1234F" in page.text
    assert "Form 16" in page.text
    # Part A is named as absent rather than silently missing.
    assert "TRACES" in page.text


def test_an_employee_cannot_print_a_colleagues_certificate(client, tenants):
    acme, _ = tenants
    _payroll_ready(client, acme, gross=2_00_000_00)
    _paid_month(client, acme, 4)
    issued = client.post(f"/api/v1/form16/issue/{acme.employee.id}",
                         json={"financial_year": 2026},
                         headers=acme.headers()).json()

    with SessionLocal() as db:
        row = db.get(Form16, __import__("uuid").UUID(issued["id"]))
        row.user_id = acme.owner.id
        db.commit()

    assert client.get(f"/api/v1/form16/{issued['id']}/print",
                      headers=acme.headers(acme.employee_token)).status_code == 403


def test_certificates_do_not_cross_tenants(client, tenants):
    acme, globex = tenants
    _payroll_ready(client, acme, gross=2_00_000_00)
    _paid_month(client, acme, 4)
    issued = client.post(f"/api/v1/form16/issue/{acme.employee.id}",
                         json={"financial_year": 2026},
                         headers=acme.headers()).json()
    assert client.get(f"/api/v1/form16/{issued['id']}/print",
                      headers=globex.headers()).status_code == 404


def test_a_senior_employees_certificate_uses_the_wider_band(client, tenants):
    """End to end: the date of birth on the master record reaches the
    certificate."""
    acme, _ = tenants
    with SessionLocal() as db:
        profile = db.get(EmployeeProfile, acme.employee.id)
        if profile is None:
            profile = EmployeeProfile(user_id=acme.employee.id, org_id=acme.id)
            db.add(profile)
        profile.date_of_birth = date(1960, 1, 1)
        db.commit()

    _payroll_ready(client, acme, gross=2_00_000_00)
    _paid_month(client, acme, 4)
    issued = client.post(f"/api/v1/form16/issue/{acme.employee.id}",
                         json={"financial_year": 2026},
                         headers=acme.headers()).json()
    assert issued["age_band"] == AgeBand.SENIOR.value
