"""Payroll checkpoint 2 — computing a month's pay, and paying it.

This moves real money and touches three other modules, so the tests are weighted
towards six things:

1. **Proration preserves the total.** Prorated components still sum to the
   prorated gross, exactly, for every payable-day count.
2. **Compute is a replace.** Recomputing does not leave a stale payslip or a
   duplicate line.
3. **Approval freezes.** After it, nothing recomputes.
4. **Paying applies side effects once**, through the ids the lines recorded —
   loan instalments settle, expense claims reimburse, and a loan that finishes
   closes itself.
5. **Employees with no structure are skipped and reported**, never paid ₹0.
6. **A draft payslip is invisible to the employee**; an approved one is not.

Amounts are integer paise. ₹50,000 is `5000000`.
"""

from __future__ import annotations

import calendar
from datetime import date

from sqlalchemy import select

from app.db.session import SessionLocal
from app.models import (
    ClaimStatus,
    ExpenseClaim,
    InstalmentStatus,
    Loan,
    LoanInstalment,
    LoanStatus,
    PayRun,
    Payslip,
    PayslipLine,
    User,
)
from app.services import payrun as svc


# --------------------------------------------------------------------------- #
# Fixtures built through the real API
# --------------------------------------------------------------------------- #


def _catalogue(client, tenant) -> dict[str, dict]:
    made = {}
    for body in (
        {"code": "BASIC", "name": "Basic", "calculation": "percent_of_gross",
         "rate_bps": 4000, "is_basic": True, "is_pf_wage": True, "sort_order": 10},
        {"code": "HRA", "name": "House Rent Allowance", "is_basic": False,
         "is_pf_wage": False, "calculation": "percent_of_basic", "rate_bps": 5000,
         "sort_order": 20},
        {"code": "SPL", "name": "Special Allowance", "calculation": "balance",
         "is_basic": False, "is_pf_wage": False, "rate_bps": 0, "sort_order": 90},
    ):
        response = client.post("/api/v1/payroll/components", json=body,
                               headers=tenant.headers())
        assert response.status_code == 201, response.text
        made[body["code"]] = response.json()
    return made


def _salary(client, tenant, user_id, catalogue, *, gross=5000000,
            effective="2026-01-01"):
    response = client.post(
        f"/api/v1/payroll/{user_id}",
        json={"effective_from": effective, "gross_monthly": gross,
              "components": [{"component_id": catalogue[code]["id"]}
                             for code in ("BASIC", "HRA", "SPL")]},
        headers=tenant.headers(),
    )
    assert response.status_code == 201, response.text
    return response.json()


def _run(client, tenant, *, year=2026, month=6, **overrides):
    body = {"period_year": year, "period_month": month} | overrides
    response = client.post("/api/v1/payruns", json=body, headers=tenant.headers())
    assert response.status_code == 201, response.text
    return response.json()


def _computed(client, tenant, run_id, overrides=None):
    response = client.post(
        f"/api/v1/payruns/{run_id}/compute",
        json={"overrides": overrides or []},
        headers=tenant.headers(),
    )
    assert response.status_code == 200, response.text
    return response.json()


def _ready(client, tenant, *, gross=5000000):
    """Catalogue, salary for the employee, and an open run for June 2026."""
    catalogue = _catalogue(client, tenant)
    _salary(client, tenant, tenant.employee.id, catalogue, gross=gross)
    return catalogue, _run(client, tenant)


# --------------------------------------------------------------------------- #
# 1. Proration
# --------------------------------------------------------------------------- #


def test_proration_preserves_the_total_for_every_payable_day_count():
    """Rounding each component and summing would leave the components
    disagreeing with the gross — the discrepancy an employee notices and finance
    cannot explain."""
    for month_days in (28, 29, 30, 31):
        for payable in range(0, month_days + 1):
            for amounts in (
                [2000000, 1000000, 160000, 1840000],
                [333333, 1, 999999],
                [5000000],
            ):
                out = svc.prorate(amounts, payable_days=payable, month_days=month_days)
                total = sum(amounts)
                if payable >= month_days:
                    expected = total
                elif payable <= 0:
                    expected = 0
                else:
                    expected = (total * payable + month_days // 2) // month_days
                assert sum(out) == expected, (month_days, payable, amounts)
                assert all(value >= 0 for value in out)


def test_a_full_month_is_the_identity():
    """The common case does no arithmetic and so cannot introduce an error."""
    amounts = [2000000, 1000000, 1840000]
    assert svc.prorate(amounts, payable_days=31, month_days=31) == amounts
    assert svc.prorate(amounts, payable_days=40, month_days=31) == amounts


# --------------------------------------------------------------------------- #
# 2. Computing
# --------------------------------------------------------------------------- #


def test_a_run_computes_one_payslip_per_covered_employee(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.employee.id, catalogue, gross=5000000)
    run = _run(client, acme)

    body = _computed(client, acme, run["id"])
    assert body["status"] == "computed"
    assert body["employee_count"] == 1
    assert body["total_gross"] == 5000000
    assert body["total_net"] == 5000000

    slip = body["payslips"][0]
    assert slip["user_name"] == acme.employee.full_name
    assert slip["gross"] == 5000000
    assert slip["full_gross"] == 5000000
    assert slip["payable_days"] == 30      # June
    assert slip["month_days"] == 30

    detail = client.get(f"/api/v1/payruns/payslips/{slip['id']}",
                        headers=acme.headers()).json()
    by_code = {line["code"]: line["amount"] for line in detail["lines"]}
    assert by_code == {"BASIC": 2000000, "HRA": 1000000, "SPL": 2000000}
    assert sum(by_code.values()) == 5000000


def test_an_employee_without_a_structure_is_skipped_and_reported(client, tenants):
    """Skipping is right — a zero payslip reads as a decision — but silence
    about it is not."""
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.employee.id, catalogue)
    run = _run(client, acme)

    body = _computed(client, acme, run["id"])
    assert body["employee_count"] == 1
    skipped = {row["full_name"] for row in body["skipped"]}
    assert acme.owner.full_name in skipped
    assert all("no salary structure" in row["reason"] for row in body["skipped"])


def test_the_structure_in_force_for_the_period_is_the_one_used(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.employee.id, catalogue,
            gross=5000000, effective="2026-01-01")
    _salary(client, acme, acme.employee.id, catalogue,
            gross=8000000, effective="2026-09-01")

    june = _computed(client, acme, _run(client, acme, month=6)["id"])
    assert june["total_gross"] == 5000000

    october = _computed(client, acme, _run(client, acme, month=10)["id"])
    assert october["total_gross"] == 8000000


def test_recomputing_replaces_rather_than_accumulates(client, tenants):
    """Merging would leave a payslip for somebody who has since left and a line
    for a loan that closed."""
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.employee.id, catalogue)
    run = _run(client, acme)

    _computed(client, acme, run["id"])
    _computed(client, acme, run["id"])
    body = _computed(client, acme, run["id"])

    assert body["employee_count"] == 1
    assert len(body["payslips"]) == 1
    with SessionLocal() as db:
        assert len(list(db.scalars(select(Payslip)))) == 1
        assert len(list(db.scalars(select(PayslipLine)))) == 3


def test_a_second_run_for_the_same_month_is_refused(client, tenants):
    acme, _ = tenants
    _run(client, acme, month=6)
    again = client.post("/api/v1/payruns",
                        json={"period_year": 2026, "period_month": 6},
                        headers=acme.headers())
    assert again.status_code == 409
    assert again.json()["detail"]["reason"] == "run_exists"


# --------------------------------------------------------------------------- #
# 3. Loss of pay
# --------------------------------------------------------------------------- #


def test_an_lop_override_prorates_and_is_recorded_as_manual(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.employee.id, catalogue, gross=5000000)
    run = _run(client, acme)   # June, 30 days

    body = _computed(client, acme, run["id"], overrides=[
        {"user_id": str(acme.employee.id), "lop_milli_days": 2000},   # two days
    ])
    slip = body["payslips"][0]
    assert slip["lop_milli_days"] == 2000
    assert slip["payable_days"] == 28
    assert slip["full_gross"] == 5000000
    # 5000000 * 28 / 30, rounded once on the total.
    assert slip["gross"] == 4666667
    # And the payslip says a human decided, rather than implying it was derived.
    assert "hand" in (slip["note"] or "")

    detail = client.get(f"/api/v1/payruns/payslips/{slip['id']}",
                        headers=acme.headers()).json()
    assert sum(line["amount"] for line in detail["lines"]
               if line["kind"] == "earning") == slip["gross"]


def test_unpaid_leave_is_derived_from_the_leave_module(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.employee.id, catalogue, gross=5000000)

    # An unpaid leave type, and an approved application inside June.
    unpaid = client.post(
        "/api/v1/leave/types",
        # A yearly accrual so a balance exists to apply against. Real
        # leave-without-pay is usually uncapped, which this module models as a
        # granted balance rather than a special case — the point of the test is
        # the payroll side, so the leave side is set up the ordinary way.
        json={"name": "Leave without pay", "code": "LWP", "is_paid": False,
              "accrual_type": "yearly", "accrual_rate_milli_days": 30000},
        headers=acme.headers(),
    )
    assert unpaid.status_code in (200, 201), unpaid.text
    type_id = unpaid.json()["id"]

    # Grant the balance explicitly rather than waiting on the accrual job — the
    # point of this test is the payroll side, and a scheduled accrual is not
    # something a test should be sequencing around.
    granted = client.post(
        "/api/v1/leave/balances/adjust",
        json={"user_id": str(acme.employee.id), "leave_type_id": type_id,
              "year": 2026, "delta_milli_days": 10000,
              "reason": "Opening balance for the test"},
        headers=acme.headers(),
    )
    assert granted.status_code == 200, granted.text

    applied = client.post(
        "/api/v1/leave/applications",
        json={"leave_type_id": type_id, "start_date": "2026-06-10",
              "end_date": "2026-06-11", "reason": "Personal"},
        headers=acme.headers(acme.employee_token),
    )
    assert applied.status_code in (200, 201), applied.text
    application = applied.json()
    decided = client.post(
        f"/api/v1/leave/applications/{application['id']}/decision",
        json={"approve": True},
        headers=acme.headers(),
    )
    assert decided.status_code == 200, decided.text

    body = _computed(client, acme, _run(client, acme, month=6)["id"])
    slip = body["payslips"][0]
    # Two working days docked, derived — no override was passed.
    assert slip["lop_milli_days"] == 2000
    assert slip["payable_days"] == 28
    assert slip["note"] is None


# --------------------------------------------------------------------------- #
# 4. Loans and expenses on the payslip
# --------------------------------------------------------------------------- #


def _loan(client, tenant, *, principal=1000000, months=4, first_due="2026-06-01"):
    loan = client.post(
        "/api/v1/loans",
        json={"loan_type": "salary_advance", "principal": principal,
              "instalment_count": months},
        headers=tenant.headers(tenant.employee_token),
    ).json()
    client.post(f"/api/v1/loans/{loan['id']}/review", json={"status": "approved"},
                headers=tenant.headers())
    return client.post(
        f"/api/v1/loans/{loan['id']}/disburse",
        json={"disbursed_on": "2026-05-10", "first_due_on": first_due},
        headers=tenant.headers(),
    ).json()


def test_a_loan_instalment_appears_as_a_traceable_deduction(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.employee.id, catalogue, gross=5000000)
    loan = _loan(client, acme, principal=1000000, months=4)

    body = _computed(client, acme, _run(client, acme, month=6)["id"])
    slip = body["payslips"][0]
    assert slip["total_deductions"] == 250000
    assert slip["net"] == 4750000

    detail = client.get(f"/api/v1/payruns/payslips/{slip['id']}",
                        headers=acme.headers()).json()
    line = next(row for row in detail["lines"] if row["kind"] == "deduction")
    assert line["source"] == "loan"
    # Traceable: the line points at the instalment, not just an amount.
    assert line["source_id"] == loan["instalments"][0]["id"]
    assert line["detail"] == "Instalment 1 of 4"


def test_an_approved_expense_claim_is_added_as_a_reimbursement(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.employee.id, catalogue, gross=5000000)

    category = client.post("/api/v1/expenses/categories",
                           json={"name": "Travel", "requires_receipt": False},
                           headers=acme.headers()).json()
    claim = client.post("/api/v1/expenses", json={"title": "Client visit"},
                        headers=acme.headers(acme.employee_token)).json()
    client.post(f"/api/v1/expenses/{claim['id']}/lines",
                json={"category_id": category["id"], "spent_on": "2026-06-05",
                      "description": "Taxi", "amount": 120000},
                headers=acme.headers(acme.employee_token))
    client.post(f"/api/v1/expenses/{claim['id']}/submit",
                headers=acme.headers(acme.employee_token))
    client.post(f"/api/v1/expenses/{claim['id']}/review",
                json={"status": "approved"}, headers=acme.headers())

    body = _computed(client, acme, _run(client, acme, month=6)["id"])
    slip = body["payslips"][0]
    assert slip["gross"] == 5120000     # salary plus the reimbursement

    detail = client.get(f"/api/v1/payruns/payslips/{slip['id']}",
                        headers=acme.headers()).json()
    line = next(row for row in detail["lines"] if row["source"] == "expense")
    assert line["amount"] == 120000
    assert line["source_id"] == claim["id"]
    assert line["detail"] == "Client visit"


# --------------------------------------------------------------------------- #
# 5. Approving and paying
# --------------------------------------------------------------------------- #


def test_approval_freezes_the_run(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.employee.id, catalogue)
    run = _run(client, acme)
    _computed(client, acme, run["id"])

    approved = client.post(f"/api/v1/payruns/{run['id']}/approve",
                           headers=acme.headers()).json()
    assert approved["status"] == "approved"

    again = client.post(f"/api/v1/payruns/{run['id']}/compute", json={"overrides": []},
                        headers=acme.headers())
    assert again.status_code == 409
    assert again.json()["detail"]["reason"] == "frozen"


def test_an_empty_run_cannot_be_approved(client, tenants):
    acme, _ = tenants
    run = _run(client, acme)
    _computed(client, acme, run["id"])
    response = client.post(f"/api/v1/payruns/{run['id']}/approve",
                           headers=acme.headers())
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "empty_run"


def test_paying_settles_the_loan_instalment_and_the_expense_claim(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.employee.id, catalogue, gross=5000000)
    loan = _loan(client, acme, principal=1000000, months=4)

    category = client.post("/api/v1/expenses/categories",
                           json={"name": "Travel", "requires_receipt": False},
                           headers=acme.headers()).json()
    claim = client.post("/api/v1/expenses", json={"title": "Client visit"},
                        headers=acme.headers(acme.employee_token)).json()
    client.post(f"/api/v1/expenses/{claim['id']}/lines",
                json={"category_id": category["id"], "spent_on": "2026-06-05",
                      "description": "Taxi", "amount": 120000},
                headers=acme.headers(acme.employee_token))
    client.post(f"/api/v1/expenses/{claim['id']}/submit",
                headers=acme.headers(acme.employee_token))
    client.post(f"/api/v1/expenses/{claim['id']}/review",
                json={"status": "approved"}, headers=acme.headers())

    run = _run(client, acme, month=6)
    _computed(client, acme, run["id"])
    client.post(f"/api/v1/payruns/{run['id']}/approve", headers=acme.headers())

    # Not yet: approval is not payment.
    with SessionLocal() as db:
        assert db.get(LoanInstalment,
                      __import__("uuid").UUID(loan["instalments"][0]["id"])
                      ).status == InstalmentStatus.PENDING.value
        assert db.get(ExpenseClaim, __import__("uuid").UUID(claim["id"])
                      ).status == ClaimStatus.APPROVED.value

    paid = client.post(f"/api/v1/payruns/{run['id']}/pay",
                       json={"paid_on": "2026-07-01",
                             "payment_reference": "SAL-2026-06"},
                       headers=acme.headers()).json()
    assert paid["status"] == "paid"

    with SessionLocal() as db:
        instalment = db.get(LoanInstalment,
                            __import__("uuid").UUID(loan["instalments"][0]["id"]))
        assert instalment.status == InstalmentStatus.PAID.value
        assert instalment.paid_amount == 250000
        assert instalment.reference == "SAL-2026-06"

        settled = db.get(ExpenseClaim, __import__("uuid").UUID(claim["id"]))
        assert settled.status == ClaimStatus.REIMBURSED.value
        assert settled.payment_reference == "SAL-2026-06"


def test_paying_the_last_instalment_closes_the_loan(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.employee.id, catalogue, gross=5000000)
    loan = _loan(client, acme, principal=200000, months=1)

    run = _run(client, acme, month=6)
    _computed(client, acme, run["id"])
    client.post(f"/api/v1/payruns/{run['id']}/approve", headers=acme.headers())
    client.post(f"/api/v1/payruns/{run['id']}/pay", json={},
                headers=acme.headers())

    with SessionLocal() as db:
        assert db.get(Loan, __import__("uuid").UUID(loan["id"])
                      ).status == LoanStatus.CLOSED.value


def test_an_instalment_settled_by_hand_before_payment_is_left_alone(client, tenants):
    """Somebody recorded it deliberately and this run has no better
    information."""
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.employee.id, catalogue)
    loan = _loan(client, acme, principal=1000000, months=4)

    run = _run(client, acme, month=6)
    _computed(client, acme, run["id"])
    client.post(f"/api/v1/payruns/{run['id']}/approve", headers=acme.headers())

    client.post(f"/api/v1/loans/instalments/{loan['instalments'][0]['id']}/repay",
                json={"paid_amount": 250000, "reference": "CASH-1"},
                headers=acme.headers())
    client.post(f"/api/v1/payruns/{run['id']}/pay", json={"payment_reference": "SAL"},
                headers=acme.headers())

    with SessionLocal() as db:
        instalment = db.get(LoanInstalment,
                            __import__("uuid").UUID(loan["instalments"][0]["id"]))
        assert instalment.reference == "CASH-1"


def test_an_unapproved_run_cannot_be_paid(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.employee.id, catalogue)
    run = _run(client, acme)
    _computed(client, acme, run["id"])
    response = client.post(f"/api/v1/payruns/{run['id']}/pay", json={},
                           headers=acme.headers())
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "not_approved"


def test_a_paid_run_cannot_be_cancelled(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.employee.id, catalogue)
    run = _run(client, acme)
    _computed(client, acme, run["id"])
    client.post(f"/api/v1/payruns/{run['id']}/approve", headers=acme.headers())
    client.post(f"/api/v1/payruns/{run['id']}/pay", json={}, headers=acme.headers())

    response = client.post(f"/api/v1/payruns/{run['id']}/cancel",
                           headers=acme.headers())
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "already_paid"


def test_cancelling_removes_the_payslips(client, tenants):
    """They were never handed to anybody; leaving them puts a payslip in
    somebody's history for money they never received."""
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.employee.id, catalogue)
    run = _run(client, acme)
    _computed(client, acme, run["id"])

    body = client.post(f"/api/v1/payruns/{run['id']}/cancel",
                       headers=acme.headers()).json()
    assert body["status"] == "cancelled"
    assert body["employee_count"] == 0
    with SessionLocal() as db:
        assert db.scalars(select(Payslip)).all() == []


# --------------------------------------------------------------------------- #
# 6. Access
# --------------------------------------------------------------------------- #


def test_an_employee_cannot_see_a_draft_payslip_but_can_see_an_approved_one(
    client, tenants
):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.employee.id, catalogue)
    run = _run(client, acme)
    body = _computed(client, acme, run["id"])
    slip_id = body["payslips"][0]["id"]

    assert client.get(f"/api/v1/payruns/payslips/{slip_id}",
                      headers=acme.headers(acme.employee_token)).status_code == 403
    assert client.get("/api/v1/payruns/payslips/mine",
                      headers=acme.headers(acme.employee_token)).json() == []

    client.post(f"/api/v1/payruns/{run['id']}/approve", headers=acme.headers())

    assert client.get(f"/api/v1/payruns/payslips/{slip_id}",
                      headers=acme.headers(acme.employee_token)).status_code == 200
    mine = client.get("/api/v1/payruns/payslips/mine",
                      headers=acme.headers(acme.employee_token)).json()
    assert [row["id"] for row in mine] == [slip_id]


def test_an_employee_cannot_reach_the_runs_at_all(client, tenants):
    acme, _ = tenants
    run = _run(client, acme)
    assert client.get("/api/v1/payruns",
                      headers=acme.headers(acme.employee_token)).status_code == 403
    assert client.post(f"/api/v1/payruns/{run['id']}/compute", json={"overrides": []},
                       headers=acme.headers(acme.employee_token)).status_code == 403


def test_an_employee_cannot_read_a_colleagues_payslip(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.owner.id, catalogue)
    run = _run(client, acme)
    body = _computed(client, acme, run["id"])
    client.post(f"/api/v1/payruns/{run['id']}/approve", headers=acme.headers())

    slip_id = body["payslips"][0]["id"]
    assert client.get(f"/api/v1/payruns/payslips/{slip_id}",
                      headers=acme.headers(acme.employee_token)).status_code == 403


def test_pay_runs_do_not_cross_tenants(client, tenants):
    acme, globex = tenants
    run = _run(client, acme)
    assert client.get(f"/api/v1/payruns/{run['id']}",
                      headers=globex.headers()).status_code == 404
    assert client.get("/api/v1/payruns", headers=globex.headers()).json() == []


def test_pay_runs_are_gated_by_the_payroll_module(client, tenants, platform_token):
    acme, _ = tenants
    client.put(
        f"/api/v1/platform/companies/{acme.id}/modules",
        json={"grants": [{"key": "payroll", "enabled": False}]},
        headers={"Authorization": f"Bearer {platform_token}"},
    )
    response = client.get("/api/v1/payruns", headers=acme.headers())
    assert response.status_code == 402
    assert response.json()["detail"]["module"] == "payroll"


def test_a_structure_a_payslip_used_cannot_be_deleted(client, tenants):
    """The guard checkpoint 1 promised and checkpoint 2 made necessary.

    `payslips.structure_id` is SET NULL, so the delete would otherwise succeed
    and the payslip would quietly lose the ability to say which revision
    produced it — a loss that only shows up months later.
    """
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    structure = _salary(client, acme, acme.employee.id, catalogue)
    run = _run(client, acme)
    _computed(client, acme, run["id"])

    refused = client.delete(f"/api/v1/payroll/structures/{structure['id']}",
                            headers=acme.headers())
    assert refused.status_code == 409
    assert refused.json()["detail"]["reason"] == "structure_in_use"

    # A revision nothing has been computed from is still removable.
    spare = _salary(client, acme, acme.employee.id, catalogue,
                    effective="2027-01-01")
    assert client.delete(f"/api/v1/payroll/structures/{spare['id']}",
                         headers=acme.headers()).status_code == 204
