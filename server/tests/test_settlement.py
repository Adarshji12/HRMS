"""Full-and-final settlement: the computed proposal, and accepting one.

What these tests are really defending:

1. **The proposal refuses where it has no basis and warns where it has a
   defensible reading.** A settlement is the document most likely to be argued
   about; a silent zero in one is a figure nobody can challenge because nobody
   can see it is missing.
2. **A frozen pay run for the exit month suppresses the final salary.** Paying
   somebody's last month twice is the most expensive mistake this module could
   make, and it is the one that would look right on screen.
3. **Net can be negative.** A leaver with a large loan owes the company money,
   and clamping to zero writes a debt off silently.
4. **Accepting recomputes.** The figures the browser is holding may be stale by
   the time somebody presses the button.
5. **An approved settlement is frozen** — the eighth freeze in this system.
6. Two tenants, always: a settlement is salary data.
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import select

from app.db.session import SessionLocal
from app.models import Loan, User

_LWD = date(2026, 6, 30)


# --------------------------------------------------------------------------- #
# Setup
# --------------------------------------------------------------------------- #


def _payroll(client, tenant, *, gross=60_000_00, statutory=True):
    """A basic + balance structure, and PF/ESI on. Mirrors the payroll tests."""
    made = {}
    for body in (
        {"code": "BASIC", "name": "Basic", "calculation": "percent_of_gross",
         "rate_bps": 5000, "is_basic": True, "is_pf_wage": True,
         "is_esi_wage": True, "is_taxable": True, "sort_order": 10},
        {"code": "SPL", "name": "Special Allowance", "calculation": "balance",
         "rate_bps": 0, "is_basic": False, "is_pf_wage": False,
         "is_esi_wage": True, "is_taxable": True, "sort_order": 90},
    ):
        made[body["code"]] = client.post("/api/v1/payroll/components", json=body,
                                         headers=tenant.headers()).json()
    response = client.post(
        f"/api/v1/payroll/{tenant.employee.id}",
        json={"effective_from": "2024-01-01", "gross_monthly": gross,
              "components": [{"component_id": made[c]["id"]} for c in ("BASIC", "SPL")]},
        headers=tenant.headers(),
    )
    assert response.status_code in (200, 201), response.text
    if statutory:
        client.put("/api/v1/statutory/config",
                   json={"pf_enabled": True, "esi_enabled": True},
                   headers=tenant.headers())
    return made


def _exit(client, tenant, *, last_working_day=_LWD, notice_date="2026-06-01"):
    body = {"user_id": str(tenant.employee.id), "reason": "resignation",
            "notice_date": notice_date}
    if last_working_day is not None:
        body["last_working_day"] = last_working_day.isoformat()
    response = client.post("/api/v1/offboarding/requests", json=body,
                           headers=tenant.headers())
    assert response.status_code == 201, response.text
    return response.json()


def _propose(client, tenant, exit_id):
    response = client.get(
        f"/api/v1/offboarding/requests/{exit_id}/settlement/proposal",
        headers=tenant.headers(),
    )
    assert response.status_code == 200, response.text
    return response.json()


def _codes(proposal):
    return [line["code"] for line in proposal["lines"]]


def _line(proposal, code):
    return next(line for line in proposal["lines"] if line["code"] == code)


# --------------------------------------------------------------------------- #
# What it refuses
# --------------------------------------------------------------------------- #


def test_a_proposal_needs_a_last_working_day(client, tenants):
    """Every figure in a settlement is "as at" that date. Without it there is
    nothing to prorate to and no balance to read."""
    acme, _ = tenants
    _payroll(client, acme)
    exit_ = _exit(client, acme, last_working_day=None)

    response = client.get(
        f"/api/v1/offboarding/requests/{exit_['id']}/settlement/proposal",
        headers=acme.headers(),
    )
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "no_last_working_day"


def test_a_proposal_needs_a_salary_structure(client, tenants):
    """Refused, not zeroed. A settlement of ₹0 reads as a decision."""
    acme, _ = tenants
    exit_ = _exit(client, acme)

    response = client.get(
        f"/api/v1/offboarding/requests/{exit_['id']}/settlement/proposal",
        headers=acme.headers(),
    )
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "no_salary_structure"


def test_another_tenants_exit_is_not_found(client, tenants):
    """404, not 403 — whether Beta has an exit with this id is not something an
    answer to Acme should reveal."""
    acme, beta = tenants
    _payroll(client, beta)
    theirs = _exit(client, beta)

    response = client.get(
        f"/api/v1/offboarding/requests/{theirs['id']}/settlement/proposal",
        headers=acme.headers(),
    )
    assert response.status_code == 404


# --------------------------------------------------------------------------- #
# What it computes
# --------------------------------------------------------------------------- #


def test_the_final_month_is_prorated_to_the_last_working_day(client, tenants):
    acme, _ = tenants
    _payroll(client, acme, gross=60_000_00)
    exit_ = _exit(client, acme, last_working_day=date(2026, 6, 15))

    proposal = _propose(client, acme, exit_["id"])
    salary = _line(proposal, "SALARY")

    # 15 of June's 30 days. Exactly half, because June has thirty of them —
    # a month chosen so the assertion is arithmetic rather than a rounding
    # tolerance.
    assert salary["amount_paise"] == 30_000_00
    assert "15 of 30 days" in salary["detail"]


def test_a_frozen_pay_run_for_the_exit_month_suppresses_the_salary_line(client, tenants):
    """Otherwise the last month is paid twice — once by payroll, once by the
    settlement — and both documents look right on their own."""
    acme, _ = tenants
    _payroll(client, acme)
    run = client.post("/api/v1/payruns",
                      json={"period_year": 2026, "period_month": 6},
                      headers=acme.headers()).json()
    client.post(f"/api/v1/payruns/{run['id']}/compute", json={"overrides": []},
                headers=acme.headers())
    client.post(f"/api/v1/payruns/{run['id']}/approve", headers=acme.headers())

    exit_ = _exit(client, acme)
    proposal = _propose(client, acme, exit_["id"])

    assert "SALARY" not in _codes(proposal)
    assert any("already covers June 2026" in w for w in proposal["warnings"])


def test_a_draft_pay_run_does_not_suppress_the_salary_line(client, tenants):
    """A draft can still be recomputed to exclude the leaver, so it is not
    evidence that anybody has been paid."""
    acme, _ = tenants
    _payroll(client, acme)
    run = client.post("/api/v1/payruns",
                      json={"period_year": 2026, "period_month": 6},
                      headers=acme.headers()).json()
    client.post(f"/api/v1/payruns/{run['id']}/compute", json={"overrides": []},
                headers=acme.headers())

    exit_ = _exit(client, acme)
    assert "SALARY" in _codes(_propose(client, acme, exit_["id"]))


def test_statutory_is_deducted_from_the_final_salary(client, tenants):
    acme, _ = tenants
    _payroll(client, acme, gross=20_000_00)
    exit_ = _exit(client, acme, last_working_day=date(2026, 6, 15))

    proposal = _propose(client, acme, exit_["id"])
    # Basic is half of 20,000, prorated to half a month: 5,000. PF at 12%.
    assert _line(proposal, "PF")["amount_paise"] == 600_00
    # 10,000 for the half month is under the 21,000 ESI threshold, so ESI applies.
    assert "ESI" in _codes(proposal)


def test_no_statutory_config_warns_rather_than_deducting_nothing_quietly(client, tenants):
    acme, _ = tenants
    _payroll(client, acme, statutory=False)
    exit_ = _exit(client, acme)

    proposal = _propose(client, acme, exit_["id"])
    assert "PF" not in _codes(proposal)
    assert any("No statutory configuration" in w for w in proposal["warnings"])


# --------------------------------------------------------------------------- #
# Leave encashment
# --------------------------------------------------------------------------- #


def _encashable_leave(client, tenant, *, days):
    """A leave type marked encashable, with a granted balance."""
    leave_type = client.post(
        "/api/v1/leave/types",
        json={"name": "Earned Leave", "code": "EL", "accrual_type": "none",
              "is_encashable": True},
        headers=tenant.headers(),
    )
    assert leave_type.status_code in (200, 201), leave_type.text
    leave_type = leave_type.json()
    granted = client.post(
        "/api/v1/leave/balances/adjust",
        json={"user_id": str(tenant.employee.id),
              "leave_type_id": leave_type["id"], "year": 2026,
              "delta_milli_days": days * 1000, "reason": "opening balance"},
        headers=tenant.headers(),
    )
    assert granted.status_code in (200, 201), granted.text
    return leave_type


def test_an_encashable_balance_is_paid_at_the_configured_day_rate(client, tenants):
    acme, _ = tenants
    _payroll(client, acme, gross=52_000_00)   # basic 26,000 → 1,000/day at /26
    _encashable_leave(client, acme, days=10)
    exit_ = _exit(client, acme)

    proposal = _propose(client, acme, exit_["id"])
    line = _line(proposal, "ENCASH_EL")
    assert line["amount_paise"] == 10_000_00
    assert "10 days at 1,000.00/day" in line["detail"]


def test_a_leave_type_not_marked_encashable_is_not_paid_out(client, tenants):
    """The expensive direction to be wrong in — hence the default and this test."""
    acme, _ = tenants
    _payroll(client, acme)
    leave_type = client.post(
        "/api/v1/leave/types",
        json={"name": "Casual Leave", "code": "CL", "accrual_type": "none"},
        headers=acme.headers(),
    ).json()
    client.post(
        "/api/v1/leave/balances/adjust",
        json={"user_id": str(acme.employee.id), "leave_type_id": leave_type["id"],
              "year": 2026, "delta_milli_days": 10_000,
              "reason": "opening balance"},
        headers=acme.headers(),
    )
    exit_ = _exit(client, acme)

    proposal = _propose(client, acme, exit_["id"])
    assert not any(code.startswith("ENCASH") for code in _codes(proposal))
    assert any("No leave type is marked encashable" in w for w in proposal["warnings"])


# --------------------------------------------------------------------------- #
# Gratuity
# --------------------------------------------------------------------------- #


def _joined(tenant, on: date):
    with SessionLocal() as db:
        user = db.get(User, tenant.employee.id)
        user.joined_on = on
        db.commit()


def test_gratuity_needs_five_years_and_says_so_when_it_is_short(client, tenants):
    acme, _ = tenants
    _payroll(client, acme)
    client.put("/api/v1/statutory/config",
               json={"pf_enabled": True, "esi_enabled": True, "gratuity_enabled": True},
               headers=acme.headers())
    _joined(acme, date(2022, 7, 1))          # four years short of the exit
    exit_ = _exit(client, acme)

    proposal = _propose(client, acme, exit_["id"])
    assert "GRATUITY" not in _codes(proposal)
    assert any("under the five years" in w for w in proposal["warnings"])


def test_gratuity_rounds_a_part_year_of_six_months_or_more_up(client, tenants):
    """s.4(2) of the Act. Five years eleven months is paid as six."""
    acme, _ = tenants
    _payroll(client, acme, gross=52_000_00)  # basic 26,000
    client.put("/api/v1/statutory/config",
               json={"pf_enabled": True, "esi_enabled": True, "gratuity_enabled": True},
               headers=acme.headers())
    _joined(acme, date(2020, 7, 15))         # 5 years 11 months at 2026-06-30
    exit_ = _exit(client, acme)

    proposal = _propose(client, acme, exit_["id"])
    line = _line(proposal, "GRATUITY")
    # 15 × 6 × 26,000 ÷ 26 = 90,000
    assert line["amount_paise"] == 90_000_00
    assert "× 6 years" in line["detail"]


def test_gratuity_is_off_unless_the_company_turns_it_on(client, tenants):
    """A large number appearing in a settlement unasked is not a good default."""
    acme, _ = tenants
    _payroll(client, acme)
    _joined(acme, date(2015, 1, 1))
    exit_ = _exit(client, acme)

    assert "GRATUITY" not in _codes(_propose(client, acme, exit_["id"]))


# --------------------------------------------------------------------------- #
# Notice
# --------------------------------------------------------------------------- #


def _notice_period(client, tenant, days):
    # The employment endpoint, not the profile one: a notice period is a term
    # of employment, and that is where the schema puts it.
    response = client.patch(f"/api/v1/people/{tenant.employee.id}/employment",
                            json={"notice_period_days": days},
                            headers=tenant.headers())
    assert response.status_code == 200, response.text


def test_a_notice_shortfall_is_recovered(client, tenants):
    acme, _ = tenants
    _payroll(client, acme, gross=60_000_00)
    _notice_period(client, acme, 60)
    # Notice given 2026-06-01, last day 2026-06-30 — 29 days served of 60.
    exit_ = _exit(client, acme)

    proposal = _propose(client, acme, exit_["id"])
    line = _line(proposal, "NOTICE_SHORT")
    assert line["amount_paise"] == (60_000_00 * 31) // 30
    assert "31 of 60 days not served" in line["detail"]


def test_no_notice_period_on_record_recovers_nothing_and_says_why(client, tenants):
    """Recovering against a default nobody set is how a settlement gets disputed."""
    acme, _ = tenants
    _payroll(client, acme)
    exit_ = _exit(client, acme)

    proposal = _propose(client, acme, exit_["id"])
    assert "NOTICE_SHORT" not in _codes(proposal)
    assert any("No notice period" in w for w in proposal["warnings"])


def test_notice_served_in_full_recovers_nothing(client, tenants):
    acme, _ = tenants
    _payroll(client, acme)
    _notice_period(client, acme, 15)
    exit_ = _exit(client, acme)

    assert "NOTICE_SHORT" not in _codes(_propose(client, acme, exit_["id"]))


# --------------------------------------------------------------------------- #
# Loans and claims
# --------------------------------------------------------------------------- #


def _active_loan(client, tenant, *, amount=1_00_000_00, instalments=10):
    loan = client.post(
        "/api/v1/loans",
        json={"principal": amount, "instalment_count": instalments,
              "purpose": "Laptop advance"},
        headers=tenant.headers(tenant.employee_token),
    )
    assert loan.status_code in (200, 201), loan.text
    loan = loan.json()
    approved = client.post(f"/api/v1/loans/{loan['id']}/review",
                           json={"status": "approved"}, headers=tenant.headers())
    assert approved.status_code == 200, approved.text
    paid = client.post(f"/api/v1/loans/{loan['id']}/disburse",
                       json={"disbursed_on": "2026-01-05",
                             "first_due_on": "2026-02-01"},
                       headers=tenant.headers())
    assert paid.status_code == 200, paid.text
    return loan


def test_an_open_loan_is_recovered_in_full(client, tenants):
    acme, _ = tenants
    _payroll(client, acme)
    loan = _active_loan(client, acme)
    exit_ = _exit(client, acme)

    proposal = _propose(client, acme, exit_["id"])
    line = _line(proposal, "LOAN")
    assert line["amount_paise"] == 1_00_000_00
    assert line["source_id"] == loan["id"]


def test_a_settlement_can_be_negative(client, tenants):
    """A leaver with a large loan owes the company money. Clamping that to zero
    writes a debt off without anybody deciding to."""
    acme, _ = tenants
    _payroll(client, acme, gross=20_000_00)
    _active_loan(client, acme, amount=5_00_000_00, instalments=24)
    exit_ = _exit(client, acme)

    proposal = _propose(client, acme, exit_["id"])
    assert proposal["net_payable_paise"] < 0


# --------------------------------------------------------------------------- #
# Tax is context, not a line
# --------------------------------------------------------------------------- #


def test_income_tax_is_never_a_line_and_the_warning_always_says_so(client, tenants):
    acme, _ = tenants
    _payroll(client, acme)
    exit_ = _exit(client, acme)

    proposal = _propose(client, acme, exit_["id"])
    assert "TDS" not in _codes(proposal)
    assert any("Income tax on the settlement is not computed" in w
               for w in proposal["warnings"])


# --------------------------------------------------------------------------- #
# Accepting
# --------------------------------------------------------------------------- #


def test_accepting_writes_the_lines_and_the_three_numbers(client, tenants):
    acme, _ = tenants
    _payroll(client, acme, gross=60_000_00)
    exit_ = _exit(client, acme)
    proposal = _propose(client, acme, exit_["id"])

    response = client.post(
        f"/api/v1/offboarding/requests/{exit_['id']}/settlement/accept",
        headers=acme.headers(),
    )
    assert response.status_code == 200, response.text
    fnf = response.json()

    assert fnf["status"] == "draft"
    assert fnf["gross_dues_paise"] == proposal["gross_dues_paise"]
    assert fnf["net_payable_paise"] == proposal["net_payable_paise"]
    assert [line["code"] for line in fnf["lines"]] == _codes(proposal)
    assert fnf["computed_at"] is not None
    # The flag that tells a reader nobody typed these in.
    assert fnf["is_manually_entered"] is False


def test_accepting_twice_replaces_rather_than_appends(client, tenants):
    """A merge would leave a loan line for a loan that has since been repaid —
    the same argument payroll's compute makes about being a replace."""
    acme, _ = tenants
    _payroll(client, acme)
    exit_ = _exit(client, acme)

    first = client.post(
        f"/api/v1/offboarding/requests/{exit_['id']}/settlement/accept",
        headers=acme.headers()).json()
    second = client.post(
        f"/api/v1/offboarding/requests/{exit_['id']}/settlement/accept",
        headers=acme.headers()).json()

    assert first["id"] == second["id"]
    assert len(second["lines"]) == len(first["lines"])


def test_accepting_recomputes_rather_than_trusting_a_stale_view(client, tenants):
    """The proposal the browser is holding may predate a loan being repaid."""
    acme, _ = tenants
    _payroll(client, acme)
    loan = _active_loan(client, acme)
    exit_ = _exit(client, acme)

    before = _propose(client, acme, exit_["id"])
    assert "LOAN" in _codes(before)

    settled = client.post(f"/api/v1/loans/{loan['id']}/settle",
                          json={"reference": "UTR-1", "paid_on": "2026-06-20"},
                          headers=acme.headers())
    assert settled.status_code == 200, settled.text

    fnf = client.post(
        f"/api/v1/offboarding/requests/{exit_['id']}/settlement/accept",
        headers=acme.headers()).json()
    assert "LOAN" not in [line["code"] for line in fnf["lines"]]


def test_an_approved_settlement_cannot_be_recomputed(client, tenants):
    """The eighth freeze in this system. A settlement somebody has been paid
    against is evidence, not a working figure."""
    acme, _ = tenants
    _payroll(client, acme)
    exit_ = _exit(client, acme)

    client.post(f"/api/v1/offboarding/requests/{exit_['id']}/settlement/accept",
                headers=acme.headers())
    client.patch(f"/api/v1/offboarding/requests/{exit_['id']}/fnf",
                 json={"status": "approved"}, headers=acme.headers())

    response = client.post(
        f"/api/v1/offboarding/requests/{exit_['id']}/settlement/accept",
        headers=acme.headers())
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "settlement_frozen"


def test_a_typed_in_settlement_still_reads_as_manually_entered(client, tenants):
    """The old route is not deprecated. A negotiated figure is a real thing and
    the flag has to keep telling them apart."""
    acme, _ = tenants
    exit_ = _exit(client, acme)

    fnf = client.post(
        f"/api/v1/offboarding/requests/{exit_['id']}/fnf",
        json={"gross_dues_paise": 50_000_00, "deductions_paise": 0,
              "net_payable_paise": 50_000_00, "notes": "agreed with the CFO"},
        headers=acme.headers()).json()

    assert fnf["is_manually_entered"] is True
    assert fnf["computed_at"] is None
    assert fnf["lines"] == []
