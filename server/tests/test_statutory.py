"""Payroll checkpoint 3 — PF, ESI, professional tax and LWF.

Statutory rules are the part of payroll that gets checked against a printed
circular, so most of this file is arithmetic against figures worked by hand:

* PF at 12% of ₹15,000 is ₹1,800, and the employer's ₹1,800 splits into ₹1,249.50
  pension and ₹550.50 EPF — which must add back exactly.
* ESI is a **threshold**, not a ceiling: at ₹21,000 it stops entirely, and below
  it both sides pay on the whole wage.
* Professional tax is a slab table on **salary** gross, so a reimbursement must
  not push somebody into a higher band.

The rest defends the wiring: the wage bases come from the component flags, a
per-employee override beats the company default, and turning statutory on does
not retrospectively change an approved run.

Amounts are integer paise; rates are basis points.
"""

from __future__ import annotations

from app.db.session import SessionLocal
from app.models import EmployeeProfile, User
from app.services import statutory as svc


class Config:
    """The Indian defaults, as a plain object for the pure-function tests."""

    pf_enabled = True
    pf_employee_rate_bps = 1200
    pf_employer_rate_bps = 1200
    pf_pension_rate_bps = 833
    pf_wage_ceiling = 1_500_000
    pf_cap_at_ceiling = True
    pf_pension_cap_at_ceiling = True
    esi_enabled = True
    esi_employee_rate_bps = 75
    esi_employer_rate_bps = 325
    esi_wage_threshold = 2_100_000
    pt_enabled = False
    pt_state = None
    lwf_enabled = False
    lwf_employee_amount = 0
    lwf_employer_amount = 0
    lwf_month = None


class Slab:
    def __init__(self, min_gross, max_gross, amount, month=None, label=None):
        self.min_gross = min_gross
        self.max_gross = max_gross
        self.amount = amount
        self.applies_in_month = month
        self.label = label


def _by_code(lines) -> dict[str, int]:
    return {line.code: line.amount for line in lines}


# --------------------------------------------------------------------------- #
# PF
# --------------------------------------------------------------------------- #


def test_pf_is_capped_at_the_ceiling_and_the_employer_split_adds_back():
    """₹20,000 basic, capped at ₹15,000: 12% is ₹1,800 each side, and the
    employer's ₹1,800 is ₹1,249.50 pension plus ₹550.50 EPF."""
    result = svc.compute(Config(), pf_wage=2_000_000, esi_wage=5_000_000,
                         pt_gross=5_000_000, month=6)
    employee = _by_code(result.employee_lines)
    employer = _by_code(result.employer_lines)

    assert employee["PF"] == 180_000
    assert employer["EPS"] == 124_950
    assert employer["EPF"] == 55_050
    # The split must never disagree with the total it came from.
    assert employer["EPS"] + employer["EPF"] == 180_000
    assert result.employer_total == 180_000
    # The line says the ceiling was applied, so a payslip can explain why the
    # figure is not 12% of what the person actually earns.
    pf_detail = next(line.detail for line in result.employee_lines if line.code == "PF")
    assert "capped" in pf_detail


def test_pf_on_full_wages_when_the_company_does_not_cap():
    """Contributing above the ceiling is equally legitimate, so it is a switch."""
    config = Config()
    config.pf_cap_at_ceiling = False
    result = svc.compute(config, pf_wage=2_000_000, esi_wage=0,
                         pt_gross=2_000_000, month=6)
    employee = _by_code(result.employee_lines)
    employer = _by_code(result.employer_lines)

    assert employee["PF"] == 240_000                 # 12% of 20,000
    # The pension slice stays capped even though EPF is not — that is how the
    # scheme works, and it is why they are two switches.
    assert employer["EPS"] == 124_950                # 8.33% of 15,000
    assert employer["EPS"] + employer["EPF"] == 240_000


def test_pf_below_the_ceiling_uses_the_actual_wage():
    result = svc.compute(Config(), pf_wage=1_200_000, esi_wage=0,
                         pt_gross=1_200_000, month=6)
    assert _by_code(result.employee_lines)["PF"] == 144_000    # 12% of 12,000


def test_pf_off_produces_nothing():
    config = Config()
    config.pf_enabled = False
    result = svc.compute(config, pf_wage=2_000_000, esi_wage=0,
                         pt_gross=2_000_000, month=6)
    assert "PF" not in _by_code(result.employee_lines)


# --------------------------------------------------------------------------- #
# ESI
# --------------------------------------------------------------------------- #


def test_esi_applies_below_the_threshold_on_the_whole_wage():
    """No ceiling, unlike PF — the mistake somebody makes once."""
    result = svc.compute(Config(), pf_wage=0, esi_wage=1_800_000,
                         pt_gross=1_800_000, month=6)
    assert _by_code(result.employee_lines)["ESI"] == 13_500     # 0.75% of 18,000
    assert _by_code(result.employer_lines)["ESI_ER"] == 58_500  # 3.25% of 18,000


def test_esi_stops_entirely_at_the_threshold():
    for wage, applies in ((2_099_900, True), (2_100_000, False), (5_000_000, False)):
        result = svc.compute(Config(), pf_wage=0, esi_wage=wage,
                             pt_gross=wage, month=6)
        assert ("ESI" in _by_code(result.employee_lines)) is applies, wage


# --------------------------------------------------------------------------- #
# Professional tax
# --------------------------------------------------------------------------- #


def test_professional_tax_reads_the_slab_table():
    config = Config()
    config.pt_enabled = True
    slabs = [
        Slab(0, 1_499_999, 0, label="Below 15,000"),
        Slab(1_500_000, 2_499_999, 20_000, label="15,000–25,000"),
        Slab(2_500_000, None, 30_000, label="Above 25,000"),
    ]
    for gross, expected in ((1_000_000, 0), (2_000_000, 20_000), (9_000_000, 30_000)):
        result = svc.compute(config, pf_wage=0, esi_wage=0, pt_gross=gross,
                             month=6, pt_slabs=slabs)
        assert _by_code(result.employee_lines).get("PT", 0) == expected, gross


def test_a_month_specific_slab_beats_the_general_one():
    """Several states charge differently in one month — Maharashtra's February
    is the well-known one, and a config that cannot say so forces an annual
    manual correction."""
    config = Config()
    config.pt_enabled = True
    slabs = [
        Slab(0, None, 20_000, label="Usual"),
        Slab(0, None, 30_000, month=2, label="February"),
    ]
    june = svc.compute(config, pf_wage=0, esi_wage=0, pt_gross=5_000_000,
                       month=6, pt_slabs=slabs)
    february = svc.compute(config, pf_wage=0, esi_wage=0, pt_gross=5_000_000,
                           month=2, pt_slabs=slabs)
    assert _by_code(june.employee_lines)["PT"] == 20_000
    assert _by_code(february.employee_lines)["PT"] == 30_000


def test_a_gross_outside_every_slab_deducts_nothing_rather_than_guessing():
    """An incomplete slab table is a configuration problem somebody must see."""
    config = Config()
    config.pt_enabled = True
    slabs = [Slab(1_500_000, 2_000_000, 20_000)]
    result = svc.compute(config, pf_wage=0, esi_wage=0, pt_gross=9_000_000,
                         month=6, pt_slabs=slabs)
    assert "PT" not in _by_code(result.employee_lines)


# --------------------------------------------------------------------------- #
# LWF
# --------------------------------------------------------------------------- #


def test_lwf_is_deducted_only_in_its_month():
    config = Config()
    config.lwf_enabled = True
    config.lwf_employee_amount = 2_000
    config.lwf_employer_amount = 4_000
    config.lwf_month = 6

    june = svc.compute(config, pf_wage=0, esi_wage=0, pt_gross=0, month=6)
    july = svc.compute(config, pf_wage=0, esi_wage=0, pt_gross=0, month=7)
    assert _by_code(june.employee_lines)["LWF"] == 2_000
    assert _by_code(june.employer_lines)["LWF_ER"] == 4_000
    assert "LWF" not in _by_code(july.employee_lines)


def test_lwf_with_no_month_applies_every_month():
    config = Config()
    config.lwf_enabled = True
    config.lwf_employee_amount = 500
    config.lwf_month = None
    for month in (1, 6, 12):
        result = svc.compute(config, pf_wage=0, esi_wage=0, pt_gross=0, month=month)
        assert _by_code(result.employee_lines)["LWF"] == 500


def test_no_config_at_all_computes_nothing():
    result = svc.compute(None, pf_wage=5_000_000, esi_wage=5_000_000,
                         pt_gross=5_000_000, month=6)
    assert result.employee_total == 0
    assert result.employer_total == 0


# --------------------------------------------------------------------------- #
# The configuration API
# --------------------------------------------------------------------------- #


def _config(client, tenant, **overrides):
    body = {"pf_enabled": True, "esi_enabled": True} | overrides
    return client.put("/api/v1/statutory/config", json=body, headers=tenant.headers())


def test_the_config_starts_absent_and_is_created_on_first_write(client, tenants):
    """Null rather than a defaults-filled object: "never configured" and
    "configured to the defaults" are different states."""
    acme, _ = tenants
    assert client.get("/api/v1/statutory/config", headers=acme.headers()).json() is None

    body = _config(client, acme).json()
    assert body["pf_enabled"] is True
    assert body["pf_wage_ceiling"] == 1_500_000
    assert body["pf_pension_rate_bps"] == 833

    again = client.get("/api/v1/statutory/config", headers=acme.headers()).json()
    assert again["id"] == body["id"]


def test_a_pension_rate_above_the_employer_share_is_refused(client, tenants):
    """A clamp silently producing zero EPF is worse than refusing a
    configuration nobody meant to enter."""
    acme, _ = tenants
    response = _config(client, acme, pf_employer_rate_bps=1200,
                       pf_pension_rate_bps=1500)
    assert response.status_code == 422


def test_overlapping_slabs_are_refused(client, tenants):
    """Two bands claiming one gross is not a configuration."""
    acme, _ = tenants
    _config(client, acme, pt_enabled=True)
    first = client.post("/api/v1/statutory/slabs",
                        json={"min_gross": 0, "max_gross": 2_000_000, "amount": 20_000},
                        headers=acme.headers())
    assert first.status_code == 201

    clash = client.post("/api/v1/statutory/slabs",
                        json={"min_gross": 1_500_000, "max_gross": 3_000_000,
                              "amount": 30_000},
                        headers=acme.headers())
    assert clash.status_code == 409
    assert clash.json()["detail"]["reason"] == "overlapping_slab"

    # A different month is a different table and may overlap freely.
    other_month = client.post("/api/v1/statutory/slabs",
                              json={"min_gross": 0, "max_gross": 2_000_000,
                                    "amount": 30_000, "applies_in_month": 2},
                              headers=acme.headers())
    assert other_month.status_code == 201


def test_preview_runs_the_same_function_a_pay_run_will(client, tenants):
    acme, _ = tenants
    _config(client, acme)
    body = client.post("/api/v1/statutory/preview",
                       json={"pf_wage": 2_000_000, "esi_wage": 5_000_000,
                             "gross": 5_000_000, "month": 6},
                       headers=acme.headers()).json()
    assert {line["code"] for line in body["employee_lines"]} == {"PF"}
    assert body["employee_total"] == 180_000
    assert body["employer_total"] == 180_000


def test_statutory_config_needs_the_payroll_capability(client, tenants):
    acme, _ = tenants
    for call in (
        client.get("/api/v1/statutory/config", headers=acme.headers(acme.employee_token)),
        client.put("/api/v1/statutory/config", json={},
                   headers=acme.headers(acme.employee_token)),
        client.get("/api/v1/statutory/slabs", headers=acme.headers(acme.employee_token)),
    ):
        assert call.status_code == 403


# --------------------------------------------------------------------------- #
# On a real payslip
# --------------------------------------------------------------------------- #


def _payroll_ready(client, tenant, *, gross=5_000_000):
    """Catalogue with BASIC flagged as the only PF wage, and a salary."""
    made = {}
    for body in (
        {"code": "BASIC", "name": "Basic", "calculation": "percent_of_gross",
         "rate_bps": 4000, "is_basic": True, "is_pf_wage": True,
         "is_esi_wage": True, "sort_order": 10},
        {"code": "HRA", "name": "HRA", "is_basic": False, "is_pf_wage": False,
         "is_esi_wage": True, "calculation": "percent_of_basic", "rate_bps": 5000,
         "sort_order": 20},
        {"code": "SPL", "name": "Special Allowance", "calculation": "balance",
         "is_basic": False, "is_pf_wage": False, "is_esi_wage": True,
         "rate_bps": 0, "sort_order": 90},
    ):
        response = client.post("/api/v1/payroll/components", json=body,
                               headers=tenant.headers())
        assert response.status_code == 201, response.text
        made[body["code"]] = response.json()

    client.post(
        f"/api/v1/payroll/{tenant.employee.id}",
        json={"effective_from": "2026-01-01", "gross_monthly": gross,
              "components": [{"component_id": made[c]["id"]}
                             for c in ("BASIC", "HRA", "SPL")]},
        headers=tenant.headers(),
    )
    return made


def _run_and_compute(client, tenant, month=6):
    run = client.post("/api/v1/payruns",
                      json={"period_year": 2026, "period_month": month},
                      headers=tenant.headers()).json()
    body = client.post(f"/api/v1/payruns/{run['id']}/compute", json={"overrides": []},
                       headers=tenant.headers()).json()
    return run, body


def test_a_payslip_carries_the_statutory_lines_and_the_employer_share(client, tenants):
    acme, _ = tenants
    _payroll_ready(client, acme, gross=5_000_000)
    _config(client, acme)

    _, body = _run_and_compute(client, acme)
    slip = body["payslips"][0]
    detail = client.get(f"/api/v1/payruns/payslips/{slip['id']}",
                        headers=acme.headers()).json()

    codes = {line["code"]: line for line in detail["lines"]}
    # BASIC is 40% of 50,000 = 20,000, capped at 15,000 → 1,800.
    assert codes["PF"]["amount"] == 180_000
    assert codes["PF"]["kind"] == "deduction"
    # ESI wage is the whole 50,000, which is above the threshold.
    assert "ESI" not in codes

    # Employer lines are a third kind, so they touch neither gross nor net.
    assert codes["EPS"]["kind"] == "employer"
    assert codes["EPF"]["kind"] == "employer"
    assert detail["gross"] == 5_000_000
    assert detail["total_deductions"] == 180_000
    assert detail["net"] == 4_820_000
    assert detail["employer_contributions"] == 180_000


def test_a_reimbursement_does_not_raise_the_statutory_bases(client, tenants):
    """Reimbursing somebody's taxi fare must not raise their PF, their ESI or
    their professional-tax band."""
    acme, _ = tenants
    _payroll_ready(client, acme, gross=1_800_000)   # low enough for ESI
    _config(client, acme, pt_enabled=True)
    client.post("/api/v1/statutory/slabs",
                json={"min_gross": 0, "max_gross": 1_900_000, "amount": 20_000},
                headers=acme.headers())
    client.post("/api/v1/statutory/slabs",
                json={"min_gross": 1_900_001, "max_gross": None, "amount": 30_000},
                headers=acme.headers())

    category = client.post("/api/v1/expenses/categories",
                           json={"name": "Travel", "requires_receipt": False},
                           headers=acme.headers()).json()
    claim = client.post("/api/v1/expenses", json={"title": "Client visit"},
                        headers=acme.headers(acme.employee_token)).json()
    client.post(f"/api/v1/expenses/{claim['id']}/lines",
                json={"category_id": category["id"], "spent_on": "2026-06-05",
                      "description": "Taxi", "amount": 500_000},
                headers=acme.headers(acme.employee_token))
    client.post(f"/api/v1/expenses/{claim['id']}/submit",
                headers=acme.headers(acme.employee_token))
    client.post(f"/api/v1/expenses/{claim['id']}/review",
                json={"status": "approved"}, headers=acme.headers())

    _, body = _run_and_compute(client, acme)
    slip = body["payslips"][0]
    detail = client.get(f"/api/v1/payruns/payslips/{slip['id']}",
                        headers=acme.headers()).json()
    codes = {line["code"]: line["amount"] for line in detail["lines"]}

    # Gross includes the ₹5,000 reimbursement...
    assert detail["gross"] == 2_300_000
    # ...but ESI is computed on the ₹18,000 salary, and still applies.
    assert codes["ESI"] == 13_500
    # ...and PT stays in the lower band rather than jumping to 300.
    assert codes["PT"] == 20_000


def test_a_per_employee_override_beats_the_company_setting(client, tenants):
    """A director or an international contractor is why these exist."""
    acme, _ = tenants
    _payroll_ready(client, acme, gross=5_000_000)
    _config(client, acme)

    with SessionLocal() as db:
        profile = db.get(EmployeeProfile, acme.employee.id)
        if profile is None:
            profile = EmployeeProfile(user_id=acme.employee.id, org_id=acme.id)
            db.add(profile)
        profile.pf_applicable = False
        db.commit()

    _, body = _run_and_compute(client, acme)
    detail = client.get(
        f"/api/v1/payruns/payslips/{body['payslips'][0]['id']}",
        headers=acme.headers(),
    ).json()
    assert "PF" not in {line["code"] for line in detail["lines"]}
    assert detail["total_deductions"] == 0


def test_turning_statutory_on_does_not_change_an_approved_run(client, tenants):
    """The freeze holds against a configuration change, not only against a
    recompute button."""
    acme, _ = tenants
    _payroll_ready(client, acme, gross=5_000_000)
    run, body = _run_and_compute(client, acme)
    assert body["payslips"][0]["total_deductions"] == 0

    client.post(f"/api/v1/payruns/{run['id']}/approve", headers=acme.headers())
    _config(client, acme)

    after = client.get(f"/api/v1/payruns/{run['id']}", headers=acme.headers()).json()
    assert after["payslips"][0]["total_deductions"] == 0
    assert after["total_net"] == 5_000_000
