"""Sales targets and incentives: the rule, the targets, approval, and the payslip line."""

from __future__ import annotations

import uuid as _uuid
from datetime import datetime, timezone

from app.db.session import SessionLocal
from app.models import CrmCustomer, SalesIncentive
from tests.test_payrun import _catalogue, _computed, _run, _salary
from tests.test_chains import _person

YEAR, MONTH = 2026, 6


def _rule(client, tenant, **over):
    body = {"is_enabled": True, "default_target": 2, "incentive_paise": 500000, "achievement": "full",
            "requires_approval": True, **over}
    r = client.put("/api/v1/incentives/rule", json=body, headers=tenant.headers())
    assert r.status_code == 200, r.text
    return r.json()


def _customers(tenant, user_id, n, *, year=YEAR, month=MONTH):
    with SessionLocal() as db:
        for i in range(n):
            row = CrmCustomer(org_id=tenant.id, name=f"Customer {i}-{_uuid.uuid4().hex[:4]}",
                              code=_uuid.uuid4().hex[:8], mobile="9000000000", manager_id=user_id)
            row.created_at = datetime(year, month, 10, tzinfo=timezone.utc)
            db.add(row)
        db.commit()


def _evaluate(client, tenant):
    r = client.post("/api/v1/incentives/evaluate", json={"year": YEAR, "month": MONTH}, headers=tenant.headers())
    assert r.status_code == 200, r.text
    return r.json()


def test_the_rule_is_off_until_it_is_saved_and_only_an_admin_sets_it(client, tenants):
    acme, _ = tenants
    assert client.get("/api/v1/incentives/rule", headers=acme.headers()).json()["is_enabled"] is False
    assert _rule(client, acme)["incentive_paise"] == 500000
    refused = client.put("/api/v1/incentives/rule", json={"is_enabled": False}, headers=acme.headers(acme.employee_token))
    assert refused.status_code == 403
    assert client.put("/api/v1/incentives/rule", json={"achievement": "sometimes"}, headers=acme.headers()).status_code == 422


def test_nothing_is_earned_below_the_target_and_everything_at_it(client, tenants):
    acme, _ = tenants
    _rule(client, acme)
    _customers(acme, acme.employee.id, 1)
    rows = client.get(f"/api/v1/incentives/targets?year={YEAR}&month={MONTH}", headers=acme.headers()).json()
    mine = next(r for r in rows if r["user_id"] == str(acme.employee.id))
    assert (mine["target"], mine["achieved"], mine["earned"]) == (2, 1, 0)
    assert _evaluate(client, acme) == []

    _customers(acme, acme.employee.id, 1)
    raised = _evaluate(client, acme)
    assert len(raised) == 1 and raised[0]["amount"] == 500000 and raised[0]["status"] == "pending"
    assert len(_evaluate(client, acme)) == 1, "evaluating again raises nothing new"


def test_prorata_pays_in_proportion_and_a_set_target_overrides_the_default(client, tenants):
    acme, _ = tenants
    _rule(client, acme, achievement="prorata", default_target=10)
    _customers(acme, acme.employee.id, 3)
    client.put("/api/v1/incentives/targets", headers=acme.headers(), json={
        "year": YEAR, "month": MONTH, "targets": [{"user_id": str(acme.employee.id), "target": 4}]})
    raised = _evaluate(client, acme)
    assert raised[0]["target"] == 4 and raised[0]["amount"] == 375000     # 3 of 4 of 5,000


def test_a_manager_approves_and_nobody_approves_their_own(client, tenants):
    acme, _ = tenants
    manager_id, manager_token = _person(acme, "Manager")
    with SessionLocal() as db:
        from app.models import User
        db.get(User, acme.employee.id).manager_id = manager_id
        db.commit()
    _rule(client, acme)
    _customers(acme, acme.employee.id, 2)
    incentive = _evaluate(client, acme)[0]

    own = client.post(f"/api/v1/incentives/{incentive['id']}/decision", json={"approve": True},
                      headers=acme.headers(acme.employee_token))
    assert own.status_code in (403, 422), "the person it is for cannot approve it"

    stranger_id, stranger_token = _person(acme, "Stranger")
    assert client.post(f"/api/v1/incentives/{incentive['id']}/decision", json={"approve": True},
                       headers=acme.headers(stranger_token)).status_code == 403

    done = client.post(f"/api/v1/incentives/{incentive['id']}/decision", json={"approve": True},
                       headers=acme.headers(manager_token))
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "approved"


def test_with_approval_off_an_incentive_is_approved_when_raised(client, tenants):
    acme, _ = tenants
    _rule(client, acme, requires_approval=False)
    _customers(acme, acme.employee.id, 2)
    assert _evaluate(client, acme)[0]["status"] == "approved"


def test_an_approved_incentive_reaches_the_payslip_and_is_marked_paid(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _salary(client, acme, acme.employee.id, catalogue, gross=5000000)
    _rule(client, acme, requires_approval=False)
    _customers(acme, acme.employee.id, 2)
    incentive = _evaluate(client, acme)[0]

    run = _run(client, acme, month=MONTH)
    body = _computed(client, acme, run["id"])
    slip = body["payslips"][0]
    assert slip["gross"] == 5000000 + 500000
    detail = client.get(f"/api/v1/payruns/payslips/{slip['id']}", headers=acme.headers()).json()
    line = next(row for row in detail["lines"] if row["source"] == "incentive")
    assert line["amount"] == 500000 and line["source_id"] == incentive["id"] and line["name"] == "Sales incentive"

    client.post(f"/api/v1/payruns/{run['id']}/approve", headers=acme.headers())
    client.post(f"/api/v1/payruns/{run['id']}/pay", json={"paid_on": "2026-07-01"}, headers=acme.headers())
    with SessionLocal() as db:
        assert db.get(SalesIncentive, _uuid.UUID(incentive["id"])).status == "paid"


def test_the_payroll_cycle_days_and_tds_switch_round_trip(client, tenants):
    acme, _ = tenants
    cfg = client.get("/api/v1/statutory/config", headers=acme.headers())
    assert cfg.status_code == 200
    base = {"cycle_close_day": 25, "salary_paid_day": 5, "tds_enabled": False, "pf_enabled": True}
    saved = client.put("/api/v1/statutory/config", json=base, headers=acme.headers())
    assert saved.status_code == 200, saved.text
    got = saved.json()
    assert (got["cycle_close_day"], got["salary_paid_day"], got["tds_enabled"]) == (25, 5, False)
    assert client.put("/api/v1/statutory/config", json={**base, "salary_paid_day": 31}, headers=acme.headers()).status_code == 422


def test_amount_for_sales_percent_and_minimum():
    from app.models import SalesIncentiveSettings
    from app.services.incentives import amount_for

    pct = SalesIncentiveSettings(incentive_type="percent", incentive_paise=500, achievement="full", min_percent=80)
    assert amount_for(pct, 100_000, 99_999) == 0
    assert amount_for(pct, 100_000, 120_000) == 600_000  # 5% of Rs.1,20,000 = Rs.6,000 in paise
    pct.achievement = "min"
    assert amount_for(pct, 100_000, 80_000) == 400_000
    assert amount_for(pct, 100_000, 79_000) == 0
    fixed = SalesIncentiveSettings(incentive_type="fixed", incentive_paise=500_000, achievement="min", min_percent=80)
    assert amount_for(fixed, 10, 8) == 500_000 and amount_for(fixed, 10, 7) == 0
