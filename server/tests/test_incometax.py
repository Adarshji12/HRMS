"""Payroll checkpoint 4 — income tax, declarations and TDS.

Most of this file is arithmetic against figures worked by hand, because that is
how anybody checks a tax computation:

* ₹12,00,000 under the new regime: standard ₹75,000 → taxable ₹11,25,000 →
  slab tax ₹52,500 → wiped by the 87A rebate → **nil**.
* ₹20,00,000 under the new regime: taxable ₹19,25,000 → ₹1,85,000 of slab tax →
  4% cess → **₹1,92,400**.
* ₹10,00,000 under the old regime with full 80C and ₹2,400 of PT: taxable
  ₹7,97,600 → ₹72,020 → cess → **₹74,900.80**.

The rest defends the two things a tax calculator does not have to get right:
that **TDS is a projection** which corrects itself when a declaration changes
mid-year, and that a declaration's **regime choice belongs to the employee**.

Amounts are integer paise. ₹1,00,000 is `10_000_000`.
"""

from __future__ import annotations

from app.core import taxslabs
from app.db.session import SessionLocal
from app.models import TaxDeclaration, User
from app.services import incometax as tax

LAKH = 10_000_000


# --------------------------------------------------------------------------- #
# The slab tables
# --------------------------------------------------------------------------- #


def test_an_unknown_financial_year_raises_rather_than_guessing():
    """A payslip computed against last year's slabs is wrong in a way nobody
    notices until assessment."""
    import pytest

    with pytest.raises(taxslabs.UnknownYear):
        taxslabs.rules_for(1999, "new")


def test_the_financial_year_starts_in_april():
    assert taxslabs.financial_year_of(2026, 4) == 2026
    assert taxslabs.financial_year_of(2026, 3) == 2025
    assert taxslabs.financial_year_of(2027, 1) == 2026


def test_months_remaining_counts_from_april():
    assert tax.months_left_in_year(4) == 12
    assert tax.months_left_in_year(12) == 4
    assert tax.months_left_in_year(3) == 1


# --------------------------------------------------------------------------- #
# The annual computation
# --------------------------------------------------------------------------- #


def test_twelve_lakh_under_the_new_regime_pays_nothing():
    """The 87A rebate wipes it: taxable ₹11.25L is inside the ₹12L limit."""
    breakdown = tax.annual_tax(gross_income=12 * LAKH, financial_year=2025,
                               regime="new")
    assert breakdown.standard_deduction == 75_000_00
    assert breakdown.taxable_income == 11_25_000_00
    assert breakdown.tax_before_rebate == 52_500_00
    assert breakdown.rebate == 52_500_00
    assert breakdown.total_tax == 0


def test_twenty_lakh_under_the_new_regime():
    breakdown = tax.annual_tax(gross_income=20 * LAKH, financial_year=2025,
                               regime="new")
    assert breakdown.taxable_income == 19_25_000_00
    assert breakdown.tax_before_rebate == 1_85_000_00
    assert breakdown.rebate == 0
    assert breakdown.cess == 7_400_00
    assert breakdown.total_tax == 1_92_400_00
    # The working adds up to the tax it explains — otherwise a payslip's
    # breakdown and its figure disagree.
    assert sum(row[2] for row in breakdown.slab_working) == breakdown.tax_before_rebate


def test_ten_lakh_under_the_old_regime_with_deductions():
    breakdown = tax.annual_tax(
        gross_income=10 * LAKH, financial_year=2025, regime="old",
        deductions={"80C": 1_50_000_00}, professional_tax=2_400_00,
    )
    assert breakdown.chapter_via == 1_50_000_00
    assert breakdown.taxable_income == 7_97_600_00
    assert breakdown.total_tax == 74_900_80


def test_the_new_regime_ignores_deductions_rather_than_refusing_them():
    """The caller reads the regime off the declaration and passes what it has;
    making it branch would be a second place that knows the rule."""
    with_them = tax.annual_tax(
        gross_income=20 * LAKH, financial_year=2025, regime="new",
        deductions={"80C": 1_50_000_00}, professional_tax=2_400_00,
    )
    without = tax.annual_tax(gross_income=20 * LAKH, financial_year=2025,
                             regime="new")
    assert with_them.total_tax == without.total_tax
    assert with_them.chapter_via == 0


def test_deductions_are_capped_rather_than_refused():
    """The return would cap it anyway, and refusing means an employee cannot
    record what they actually invested."""
    total, capped = tax.cap_deductions({"80C": 3_00_000_00, "80D": 20_000_00})
    assert capped["80C"] == 1_50_000_00
    assert capped["80D"] == 20_000_00
    assert total == 1_70_000_00


def test_rebate_is_applied_before_surcharge():
    """A liability rebated to zero has nothing to surcharge."""
    breakdown = tax.annual_tax(gross_income=12 * LAKH, financial_year=2025,
                               regime="new")
    assert breakdown.rebate > 0
    assert breakdown.surcharge == 0


def test_surcharge_applies_above_fifty_lakh():
    breakdown = tax.annual_tax(gross_income=60 * LAKH, financial_year=2025,
                               regime="new")
    assert breakdown.surcharge > 0
    # Cess is on tax plus surcharge, not on tax alone.
    expected_cess = ((breakdown.tax_before_rebate - breakdown.rebate
                      + breakdown.surcharge) * 400 + 5_000) // 10_000
    assert breakdown.cess == expected_cess


def test_zero_income_pays_nothing_and_does_not_go_negative():
    breakdown = tax.annual_tax(gross_income=0, financial_year=2025, regime="new")
    assert breakdown.taxable_income == 0
    assert breakdown.total_tax == 0
    assert breakdown.standard_deduction == 0


# --------------------------------------------------------------------------- #
# The monthly projection
# --------------------------------------------------------------------------- #


def test_tds_spreads_the_liability_over_the_months_that_remain():
    breakdown = tax.annual_tax(gross_income=20 * LAKH, financial_year=2025,
                               regime="new")
    april = tax.monthly_tds(breakdown=breakdown, already_deducted=0,
                            months_remaining=12)
    assert april.amount == -(-breakdown.total_tax // 12)


def test_a_mid_year_declaration_is_absorbed_by_the_months_that_are_left():
    """Somebody declares an investment in December and the remaining three
    months take the whole correction — that is what a projection is for."""
    before = tax.annual_tax(gross_income=15 * LAKH, financial_year=2025,
                            regime="old")
    after = tax.annual_tax(gross_income=15 * LAKH, financial_year=2025,
                           regime="old", deductions={"80C": 1_50_000_00})
    assert after.total_tax < before.total_tax

    # Eight months were deducted at the old rate; four remain.
    paid = -(-before.total_tax // 12) * 8
    december = tax.monthly_tds(breakdown=after, already_deducted=paid,
                               months_remaining=4)
    assert december.amount == -(-(after.total_tax - paid) // 4)


def test_an_over_deduction_stops_rather_than_going_negative():
    """Payroll cannot refund through TDS; it stops taking and the employee
    claims the excess on their return."""
    breakdown = tax.annual_tax(gross_income=20 * LAKH, financial_year=2025,
                               regime="new")
    result = tax.monthly_tds(breakdown=breakdown,
                             already_deducted=breakdown.total_tax + 50_000_00,
                             months_remaining=3)
    assert result.amount == 0


def test_march_clears_whatever_is_outstanding():
    breakdown = tax.annual_tax(gross_income=20 * LAKH, financial_year=2025,
                               regime="new")
    march = tax.monthly_tds(breakdown=breakdown, already_deducted=1_00_000_00,
                            months_remaining=1)
    assert march.amount == breakdown.total_tax - 1_00_000_00


def test_the_projection_follows_a_raise():
    """Earned so far plus this month at the new rate for every month left."""
    assert tax.project_annual_income(
        earned_so_far=6 * LAKH, current_month_taxable=2 * LAKH, months_remaining=6
    ) == 18 * LAKH


# --------------------------------------------------------------------------- #
# Declarations
# --------------------------------------------------------------------------- #


def _declaration(client, tenant, token=None):
    return client.get("/api/v1/tax/declaration?financial_year=2026",
                      headers=tenant.headers(token)).json()


def test_a_declaration_is_created_empty_on_first_open(client, tenants):
    """The new regime is the default, matching the default in law."""
    acme, _ = tenants
    body = _declaration(client, acme, acme.employee_token)
    assert body["regime"] == "new"
    assert body["status"] == "draft"
    assert body["items"] == []
    assert body["can_edit"] is True
    # FY 2026-27's rates were carried forward, and the payload says so.
    assert body["provisional"] is True


def test_the_employee_chooses_the_regime_and_hr_cannot(client, tenants):
    """The choice has consequences they own."""
    acme, _ = tenants
    body = _declaration(client, acme, acme.employee_token)

    chosen = client.post(f"/api/v1/tax/declaration/{body['id']}/regime",
                         json={"regime": "old"},
                         headers=acme.headers(acme.employee_token)).json()
    assert chosen["regime"] == "old"

    refused = client.post(f"/api/v1/tax/declaration/{body['id']}/regime",
                          json={"regime": "new"}, headers=acme.headers())
    assert refused.status_code == 403


def test_claims_upsert_on_the_section(client, tenants):
    """Two "80C" rows would each be half an answer with the cap applied to
    whichever was summed first."""
    acme, _ = tenants
    body = _declaration(client, acme, acme.employee_token)
    for amount in (50_000_00, 1_20_000_00):
        body = client.post(
            f"/api/v1/tax/declaration/{body['id']}/items",
            json={"section": "80c", "declared_amount": amount, "label": "PPF"},
            headers=acme.headers(acme.employee_token),
        ).json()
    assert len(body["items"]) == 1
    item = body["items"][0]
    assert item["section"] == "80C"          # canonicalised
    assert item["declared_amount"] == 1_20_000_00
    assert item["effective_amount"] == 1_20_000_00
    assert item["cap"] == 1_50_000_00


def test_hr_verifies_a_lower_amount_and_payroll_switches_to_it(client, tenants):
    """Declared ₹1,50,000 in April, produced receipts for ₹1,10,000 in
    February — the ordinary case."""
    acme, _ = tenants
    body = _declaration(client, acme, acme.employee_token)
    body = client.post(f"/api/v1/tax/declaration/{body['id']}/items",
                       json={"section": "80C", "declared_amount": 1_50_000_00},
                       headers=acme.headers(acme.employee_token)).json()
    item_id = body["items"][0]["id"]

    verified = client.post(f"/api/v1/tax/items/{item_id}/verify",
                           json={"verified_amount": 1_10_000_00},
                           headers=acme.headers()).json()
    item = verified["items"][0]
    assert item["declared_amount"] == 1_50_000_00
    assert item["verified_amount"] == 1_10_000_00
    assert item["effective_amount"] == 1_10_000_00
    assert item["status"] == "verified"


def test_a_rejection_needs_a_reason_and_zeroes_the_claim(client, tenants):
    acme, _ = tenants
    body = _declaration(client, acme, acme.employee_token)
    body = client.post(f"/api/v1/tax/declaration/{body['id']}/items",
                       json={"section": "80C", "declared_amount": 1_50_000_00},
                       headers=acme.headers(acme.employee_token)).json()
    item_id = body["items"][0]["id"]

    blank = client.post(f"/api/v1/tax/items/{item_id}/verify",
                        json={"reject": True, "note": "  "},
                        headers=acme.headers())
    assert blank.status_code == 422

    rejected = client.post(f"/api/v1/tax/items/{item_id}/verify",
                           json={"reject": True, "note": "No receipts produced"},
                           headers=acme.headers()).json()
    assert rejected["items"][0]["effective_amount"] == 0


def test_revising_a_verified_claim_resets_it(client, tenants):
    """The amount changed, so the previous check no longer covers it."""
    acme, _ = tenants
    body = _declaration(client, acme, acme.employee_token)
    body = client.post(f"/api/v1/tax/declaration/{body['id']}/items",
                       json={"section": "80C", "declared_amount": 1_00_000_00},
                       headers=acme.headers(acme.employee_token)).json()
    item_id = body["items"][0]["id"]
    client.post(f"/api/v1/tax/items/{item_id}/verify", json={},
                headers=acme.headers())

    revised = client.post(f"/api/v1/tax/declaration/{body['id']}/items",
                          json={"section": "80C", "declared_amount": 1_40_000_00},
                          headers=acme.headers(acme.employee_token)).json()
    item = revised["items"][0]
    assert item["verified_amount"] is None
    assert item["status"] == "declared"


def test_a_submitted_declaration_is_still_editable_but_a_verified_one_is_not(
    client, tenants
):
    """People genuinely do invest more in November than they said in April."""
    acme, _ = tenants
    body = _declaration(client, acme, acme.employee_token)
    client.post(f"/api/v1/tax/declaration/{body['id']}/items",
                json={"section": "80C", "declared_amount": 50_000_00},
                headers=acme.headers(acme.employee_token))
    client.post(f"/api/v1/tax/declaration/{body['id']}/submit",
                headers=acme.headers(acme.employee_token))

    still = client.post(f"/api/v1/tax/declaration/{body['id']}/items",
                        json={"section": "80D", "declared_amount": 25_000_00},
                        headers=acme.headers(acme.employee_token))
    assert still.status_code == 200

    client.post(f"/api/v1/tax/declaration/{body['id']}/close", json={},
                headers=acme.headers())
    closed = client.post(f"/api/v1/tax/declaration/{body['id']}/items",
                         json={"section": "80E", "declared_amount": 10_000_00},
                         headers=acme.headers(acme.employee_token))
    assert closed.status_code == 409
    assert closed.json()["detail"]["reason"] == "not_editable"

    # Reopening exists because somebody always produces a receipt the day after.
    client.post(f"/api/v1/tax/declaration/{body['id']}/close",
                json={"reopen": True}, headers=acme.headers())
    assert client.post(f"/api/v1/tax/declaration/{body['id']}/items",
                       json={"section": "80E", "declared_amount": 10_000_00},
                       headers=acme.headers(acme.employee_token)).status_code == 200


def test_an_employee_cannot_read_a_colleagues_declaration(client, tenants):
    acme, _ = tenants
    response = client.get(f"/api/v1/tax/declaration/{acme.owner.id}",
                          headers=acme.headers(acme.employee_token))
    assert response.status_code == 403


def test_proof_must_belong_to_the_declaring_employee(client, tenants):
    """Attaching somebody else's document as proof of your own claim is the hole
    this closes."""
    import io

    acme, _ = tenants
    body = _declaration(client, acme, acme.employee_token)
    body = client.post(f"/api/v1/tax/declaration/{body['id']}/items",
                       json={"section": "80C", "declared_amount": 50_000_00},
                       headers=acme.headers(acme.employee_token)).json()
    item_id = body["items"][0]["id"]

    others = client.post(
        f"/api/v1/people/{acme.owner.id}/documents",
        data={"meta": '{"doc_type": "other", "title": "Not mine"}'},
        files={"file": ("x.pdf", io.BytesIO(b"x"), "application/pdf")},
        headers=acme.headers(),
    ).json()
    refused = client.post(f"/api/v1/tax/items/{item_id}/proof",
                          json={"document_id": others["id"]},
                          headers=acme.headers(acme.employee_token))
    assert refused.status_code == 403
    assert refused.json()["detail"]["reason"] == "wrong_owner"


def test_the_estimate_shows_both_regimes(client, tenants):
    """An employee looking at one number cannot make the comparison the choice
    exists for."""
    acme, _ = tenants
    body = _declaration(client, acme, acme.employee_token)
    client.post(f"/api/v1/tax/declaration/{body['id']}/items",
                json={"section": "80C", "declared_amount": 1_50_000_00},
                headers=acme.headers(acme.employee_token))

    estimate = client.get(
        f"/api/v1/tax/declaration/{body['id']}/estimate?annual_income={10 * LAKH}",
        headers=acme.headers(acme.employee_token),
    ).json()
    assert estimate["old"]["chapter_via"] == 1_50_000_00
    assert estimate["new"]["chapter_via"] == 0

    # At ₹10L the NEW regime wins outright — its ₹12L rebate wipes the whole
    # liability — even against the old regime with a full ₹1,50,000 of 80C.
    # That is exactly why both are shown: an employee who assumes "80C means the
    # old regime is better" would elect it and lose the entire amount below.
    assert estimate["new"]["total_tax"] == 0
    assert estimate["old"]["total_tax"] > 0


# --------------------------------------------------------------------------- #
# TDS on a real payslip
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


def _compute(client, tenant, month=6):
    run = client.post("/api/v1/payruns",
                      json={"period_year": 2026, "period_month": month},
                      headers=tenant.headers()).json()
    return run, client.post(f"/api/v1/payruns/{run['id']}/compute",
                            json={"overrides": []},
                            headers=tenant.headers()).json()


def test_a_low_salary_attracts_no_tds(client, tenants):
    """₹6L a year under the new regime is inside the rebate — a payslip that
    deducted anything here would be wrong."""
    acme, _ = tenants
    _payroll_ready(client, acme, gross=50_000_00)
    _, body = _compute(client, acme)
    detail = client.get(f"/api/v1/payruns/payslips/{body['payslips'][0]['id']}",
                        headers=acme.headers()).json()
    assert "TDS" not in {line["code"] for line in detail["lines"]}


def test_a_higher_salary_attracts_tds_spread_over_the_year(client, tenants):
    acme, _ = tenants
    _payroll_ready(client, acme, gross=2_00_000_00)      # ₹24L a year
    _, body = _compute(client, acme, month=4)            # April: 12 months left
    detail = client.get(f"/api/v1/payruns/payslips/{body['payslips'][0]['id']}",
                        headers=acme.headers()).json()

    line = next(row for row in detail["lines"] if row["code"] == "TDS")
    expected = tax.annual_tax(gross_income=24 * LAKH, financial_year=2026,
                              regime="new")
    assert line["amount"] == -(-expected.total_tax // 12)
    assert "12 month(s) remaining" in line["detail"]
    assert "new regime" in line["detail"]


def test_electing_the_old_regime_changes_the_tds(client, tenants):
    acme, _ = tenants
    _payroll_ready(client, acme, gross=2_00_000_00)
    _, before = _compute(client, acme, month=4)
    before_detail = client.get(
        f"/api/v1/payruns/payslips/{before['payslips'][0]['id']}",
        headers=acme.headers(),
    ).json()
    before_tds = next(r["amount"] for r in before_detail["lines"] if r["code"] == "TDS")

    declaration = _declaration(client, acme, acme.employee_token)
    client.post(f"/api/v1/tax/declaration/{declaration['id']}/regime",
                json={"regime": "old"},
                headers=acme.headers(acme.employee_token))
    client.post(f"/api/v1/tax/declaration/{declaration['id']}/items",
                json={"section": "80C", "declared_amount": 1_50_000_00},
                headers=acme.headers(acme.employee_token))

    run_id = before["id"]
    after = client.post(f"/api/v1/payruns/{run_id}/compute", json={"overrides": []},
                        headers=acme.headers()).json()
    after_detail = client.get(f"/api/v1/payruns/payslips/{after['payslips'][0]['id']}",
                              headers=acme.headers()).json()
    after_tds = next(r["amount"] for r in after_detail["lines"] if r["code"] == "TDS")

    assert after_tds != before_tds
    assert "old regime" in next(
        r["detail"] for r in after_detail["lines"] if r["code"] == "TDS"
    )
