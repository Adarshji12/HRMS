"""Payroll checkpoint 1 — the structure resolver, effective dating, and access.

Salary is the one figure colleagues compare with each other, so the tests are
weighted towards five things:

1. **Components resolve to gross, exactly**, and an over-allocation is an error
   somebody sees rather than a negative allowance absorbing it.
2. **A revision is a new row**, and the timeline it produces has no gaps and no
   overlaps — including when a correction is backdated *between* two existing
   revisions.
3. **A structure keeps its own snapshot** of the catalogue, so editing a
   component changes the next structure and nothing about the last.
4. **Access is the narrowest in the product.** Own salary always; anybody
   else's needs `can_manage_payroll`, which an owner has implicitly and a
   manager never does.
5. **The statutory flags carry through** to the structure, because the next
   checkpoint reads exactly those.

Amounts are integer paise, monthly. ₹50,000 is `5000000`.
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import select

from app.db.session import SessionLocal
from app.models import PayComponent, SalaryStructure, User
from app.services import payroll as svc


def _component(client, tenant, **overrides):
    body = {"code": "BASIC", "name": "Basic", "calculation": "percent_of_gross",
            "rate_bps": 4000, "is_basic": True, "is_pf_wage": True,
            "sort_order": 10} | overrides
    return client.post("/api/v1/payroll/components", json=body, headers=tenant.headers())


def _catalogue(client, tenant) -> dict[str, dict]:
    """The four-component structure most Indian companies actually use."""
    made = {}
    for body in (
        {"code": "BASIC", "name": "Basic", "calculation": "percent_of_gross",
         "rate_bps": 4000, "is_basic": True, "is_pf_wage": True, "sort_order": 10},
        # Every flag is spelled out on these three. `_component`'s default body
        # describes BASIC, so anything left unset here is inherited from it --
        # which silently made HRA a second basic component *and* a PF wage. A
        # fixture that merges over a meaningful default is one that lies about
        # what it created.
        {"code": "HRA", "name": "House Rent Allowance", "is_basic": False,
         "is_pf_wage": False, "calculation": "percent_of_basic",
         "rate_bps": 5000, "sort_order": 20},
        {"code": "CONV", "name": "Conveyance", "calculation": "fixed",
         "is_basic": False, "is_pf_wage": False, "rate_bps": 0, "sort_order": 30},
        {"code": "SPL", "name": "Special Allowance", "calculation": "balance",
         "is_basic": False, "is_pf_wage": False, "rate_bps": 0, "sort_order": 90},
    ):
        response = _component(client, tenant, **body)
        assert response.status_code == 201, response.text
        made[body["code"]] = response.json()
    return made


def _structure(client, tenant, user_id, catalogue, *, gross=5000000,
               effective="2026-04-01", conv=160000, **overrides):
    body = {
        "effective_from": effective,
        "gross_monthly": gross,
        "components": [
            {"component_id": catalogue["BASIC"]["id"]},
            {"component_id": catalogue["HRA"]["id"]},
            {"component_id": catalogue["CONV"]["id"], "amount": conv},
            {"component_id": catalogue["SPL"]["id"]},
        ],
    } | overrides
    return client.post(f"/api/v1/payroll/{user_id}", json=body, headers=tenant.headers())


def _grant_payroll(user_id: str) -> None:
    with SessionLocal() as db:
        db.get(User, user_id).can_manage_payroll = True
        db.commit()


# --------------------------------------------------------------------------- #
# 1. The resolver
# --------------------------------------------------------------------------- #


def test_components_resolve_to_gross_exactly(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    body = _structure(client, acme, acme.employee.id, catalogue,
                      gross=5000000, conv=160000).json()

    by_code = {line["code"]: line["amount"] for line in body["components"]}
    assert by_code["BASIC"] == 2000000        # 40% of gross
    assert by_code["HRA"] == 1000000          # 50% of basic
    assert by_code["CONV"] == 160000          # stated
    assert by_code["SPL"] == 1840000          # the remainder
    assert sum(by_code.values()) == 5000000
    assert body["annual_gross"] == 60000000


def test_the_balance_absorbs_rounding_so_the_total_never_drifts(client, tenants):
    """An odd gross with percentage components is where a naive implementation
    loses a paise."""
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    for gross in (3333333, 1000001, 7777777, 999999):
        body = _structure(client, acme, acme.employee.id, catalogue,
                          gross=gross, conv=100,
                          effective=f"2020-{(gross % 12) + 1:02d}-01").json()
        assert sum(line["amount"] for line in body["components"]) == gross, gross


def test_over_allocating_is_an_error_not_a_negative_allowance(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    response = _structure(client, acme, acme.employee.id, catalogue,
                          gross=1000000, conv=900000)
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "over_gross"


def test_without_a_balance_component_the_amounts_must_already_add_up(client, tenants):
    acme, _ = tenants
    _component(client, acme, code="BASIC", name="Basic", calculation="fixed",
               is_basic=True, is_pf_wage=True, sort_order=10)
    basic = client.get("/api/v1/payroll/components", headers=acme.headers()).json()[0]

    short = client.post(
        f"/api/v1/payroll/{acme.employee.id}",
        json={"effective_from": "2026-04-01", "gross_monthly": 5000000,
              "components": [{"component_id": basic["id"], "amount": 2000000}]},
        headers=acme.headers(),
    )
    assert short.status_code == 422
    assert short.json()["detail"]["reason"] == "does_not_balance"

    exact = client.post(
        f"/api/v1/payroll/{acme.employee.id}",
        json={"effective_from": "2026-04-01", "gross_monthly": 5000000,
              "components": [{"component_id": basic["id"], "amount": 5000000}]},
        headers=acme.headers(),
    )
    assert exact.status_code == 201


def test_a_fixed_component_without_an_amount_is_refused(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    response = client.post(
        f"/api/v1/payroll/{acme.employee.id}",
        json={"effective_from": "2026-04-01", "gross_monthly": 5000000,
              "components": [
                  {"component_id": catalogue["BASIC"]["id"]},
                  {"component_id": catalogue["CONV"]["id"]},   # no amount
                  {"component_id": catalogue["SPL"]["id"]},
              ]},
        headers=acme.headers(),
    )
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "amount_required"


def test_percent_of_basic_without_a_basic_component_is_refused(client, tenants):
    acme, _ = tenants
    _component(client, acme, code="HRA", name="HRA",
               calculation="percent_of_basic", rate_bps=5000, is_basic=False)
    _component(client, acme, code="SPL", name="Special", calculation="balance",
               is_basic=False, sort_order=90)
    rows = {c["code"]: c for c in
            client.get("/api/v1/payroll/components", headers=acme.headers()).json()}

    response = client.post(
        f"/api/v1/payroll/{acme.employee.id}",
        json={"effective_from": "2026-04-01", "gross_monthly": 5000000,
              "components": [{"component_id": rows["HRA"]["id"]},
                             {"component_id": rows["SPL"]["id"]}]},
        headers=acme.headers(),
    )
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "no_basic"


def test_preview_resolves_without_saving(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    body = client.post(
        "/api/v1/payroll/preview",
        json={"gross_monthly": 5000000,
              "components": [
                  {"component_id": catalogue["BASIC"]["id"]},
                  {"component_id": catalogue["HRA"]["id"]},
                  {"component_id": catalogue["CONV"]["id"], "amount": 160000},
                  {"component_id": catalogue["SPL"]["id"]},
              ]},
        headers=acme.headers(),
    ).json()
    assert sum(line["amount"] for line in body["components"]) == 5000000
    with SessionLocal() as db:
        assert db.scalars(select(SalaryStructure)).all() == []


# --------------------------------------------------------------------------- #
# 2. The catalogue's own rules
# --------------------------------------------------------------------------- #


def test_only_one_component_may_absorb_the_balance(client, tenants):
    acme, _ = tenants
    _component(client, acme, code="SPL", name="Special", calculation="balance",
               is_basic=False)
    second = _component(client, acme, code="OTHER", name="Other",
                        calculation="balance", is_basic=False)
    assert second.status_code == 409
    assert second.json()["detail"]["reason"] == "balance_exists"


def test_only_one_component_may_be_basic(client, tenants):
    acme, _ = tenants
    _component(client, acme)
    second = _component(client, acme, code="BASIC2", name="Basic two")
    assert second.status_code == 409
    assert second.json()["detail"]["reason"] == "basic_exists"


def test_basic_cannot_be_a_percentage_of_itself(client, tenants):
    acme, _ = tenants
    response = _component(client, acme, calculation="percent_of_basic",
                          rate_bps=5000, is_basic=True)
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "basic_self_reference"


def test_a_percentage_component_needs_a_rate(client, tenants):
    acme, _ = tenants
    response = _component(client, acme, code="HRA", name="HRA", is_basic=False,
                          calculation="percent_of_basic", rate_bps=0)
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "rate_required"


def test_duplicate_codes_are_refused_and_codes_are_canonicalised(client, tenants):
    acme, _ = tenants
    first = _component(client, acme, code="  basic  ").json()
    assert first["code"] == "BASIC"
    assert _component(client, acme, code="basic").status_code == 409


def test_a_code_with_punctuation_is_refused(client, tenants):
    """It ends up in payroll exports and accounting mappings."""
    acme, _ = tenants
    assert _component(client, acme, code="BA,SIC").status_code == 422


# --------------------------------------------------------------------------- #
# 3. Effective dating
# --------------------------------------------------------------------------- #


def test_a_revision_closes_the_previous_one_the_day_before(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _structure(client, acme, acme.employee.id, catalogue,
               gross=5000000, effective="2026-04-01")
    _structure(client, acme, acme.employee.id, catalogue,
               gross=6000000, effective="2026-10-01", reason="Annual revision")

    rows = client.get(f"/api/v1/payroll/{acme.employee.id}",
                      headers=acme.headers()).json()
    # Newest first.
    assert [row["effective_from"] for row in rows] == ["2026-10-01", "2026-04-01"]
    assert rows[0]["effective_to"] is None
    assert rows[0]["is_current"] is True
    # No gap, no overlap.
    assert rows[1]["effective_to"] == "2026-09-30"
    assert rows[1]["is_current"] is False


def test_a_backdated_correction_recloses_the_whole_timeline(client, tenants):
    """Patching only the immediately previous row would leave the one after it
    claiming a period it no longer covers."""
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _structure(client, acme, acme.employee.id, catalogue, effective="2026-01-01")
    _structure(client, acme, acme.employee.id, catalogue, effective="2026-12-01")
    # Inserted between the two.
    _structure(client, acme, acme.employee.id, catalogue, effective="2026-06-01")

    rows = sorted(
        client.get(f"/api/v1/payroll/{acme.employee.id}", headers=acme.headers()).json(),
        key=lambda row: row["effective_from"],
    )
    assert [(r["effective_from"], r["effective_to"]) for r in rows] == [
        ("2026-01-01", "2026-05-31"),
        ("2026-06-01", "2026-11-30"),
        ("2026-12-01", None),
    ]


def test_two_structures_cannot_start_on_the_same_day(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _structure(client, acme, acme.employee.id, catalogue, effective="2026-04-01")
    again = _structure(client, acme, acme.employee.id, catalogue,
                       effective="2026-04-01", gross=6000000)
    assert again.status_code == 409
    assert again.json()["detail"]["reason"] == "duplicate_effective_date"


def test_structure_on_a_date_answers_what_a_pay_run_will_ask(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _structure(client, acme, acme.employee.id, catalogue,
               gross=5000000, effective="2026-04-01")
    _structure(client, acme, acme.employee.id, catalogue,
               gross=6000000, effective="2026-10-01")

    for on, expected in (
        ("2026-04-01", 5000000),
        ("2026-09-30", 5000000),
        ("2026-10-01", 6000000),
        ("2027-03-31", 6000000),
    ):
        body = client.get(f"/api/v1/payroll/{acme.employee.id}/on/{on}",
                          headers=acme.headers()).json()
        assert body["gross_monthly"] == expected, on

    # Before the first revision there is nothing in force, and that is a real
    # answer rather than an error.
    assert client.get(f"/api/v1/payroll/{acme.employee.id}/on/2026-01-01",
                      headers=acme.headers()).json() is None


def test_deleting_a_revision_recloses_around_the_gap(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _structure(client, acme, acme.employee.id, catalogue, effective="2026-01-01")
    middle = _structure(client, acme, acme.employee.id, catalogue,
                        effective="2026-06-01").json()
    _structure(client, acme, acme.employee.id, catalogue, effective="2026-12-01")

    assert client.delete(f"/api/v1/payroll/structures/{middle['id']}",
                         headers=acme.headers()).status_code == 204

    rows = sorted(
        client.get(f"/api/v1/payroll/{acme.employee.id}", headers=acme.headers()).json(),
        key=lambda row: row["effective_from"],
    )
    assert [(r["effective_from"], r["effective_to"]) for r in rows] == [
        ("2026-01-01", "2026-11-30"),
        ("2026-12-01", None),
    ]


# --------------------------------------------------------------------------- #
# 4. The snapshot
# --------------------------------------------------------------------------- #


def test_editing_a_component_does_not_change_an_existing_structure(client, tenants):
    """A payslip reprinted next year has to explain itself the way it did then."""
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    before = _structure(client, acme, acme.employee.id, catalogue).json()
    hra_before = next(c for c in before["components"] if c["code"] == "HRA")

    client.patch(
        f"/api/v1/payroll/components/{catalogue['HRA']['id']}",
        json={"rate_bps": 2000, "name": "HRA (revised)"},
        headers=acme.headers(),
    )

    after = client.get(f"/api/v1/payroll/{acme.employee.id}",
                       headers=acme.headers()).json()[0]
    hra_after = next(c for c in after["components"] if c["code"] == "HRA")
    assert hra_after["amount"] == hra_before["amount"]
    # The rule and the name are snapshotted too, not just the figure.
    assert hra_after["rate_bps"] == 5000
    assert hra_after["name"] == "House Rent Allowance"


def test_a_component_in_use_cannot_be_deleted_at_the_database_level(client, tenants):
    """It is part of somebody's pay history; deactivating retires one."""
    import sqlalchemy.exc

    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _structure(client, acme, acme.employee.id, catalogue)

    with SessionLocal() as db:
        row = db.get(PayComponent, __import__("uuid").UUID(catalogue["HRA"]["id"]))
        db.delete(row)
        try:
            db.commit()
            refused = False
        except sqlalchemy.exc.IntegrityError:
            refused = True
    assert refused


def test_statutory_flags_carry_through_to_the_structure(client, tenants):
    """The next checkpoint reads exactly these."""
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    body = _structure(client, acme, acme.employee.id, catalogue,
                      gross=5000000, conv=160000).json()

    # Only BASIC was flagged as a PF wage.
    assert body["pf_wage_monthly"] == 2000000
    # Everything defaults to an ESI wage and to taxable.
    assert body["esi_wage_monthly"] == 5000000
    assert body["taxable_monthly"] == 5000000


# --------------------------------------------------------------------------- #
# 5. Access
# --------------------------------------------------------------------------- #


def test_an_employee_sees_their_own_salary_and_nobody_elses(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _structure(client, acme, acme.employee.id, catalogue)

    mine = client.get("/api/v1/payroll/me",
                      headers=acme.headers(acme.employee_token)).json()
    assert len(mine) == 1
    assert mine[0]["gross_monthly"] == 5000000

    assert client.get(f"/api/v1/payroll/{acme.owner.id}",
                      headers=acme.headers(acme.employee_token)).status_code == 403
    assert client.get("/api/v1/payroll/components",
                      headers=acme.headers(acme.employee_token)).status_code == 403


def test_an_administrator_needs_the_flag_but_an_owner_does_not(client, tenants):
    """The flag defaults false so applying the migration hands nobody every
    salary; the owner is exempt so a workspace cannot lock itself out."""
    acme, _ = tenants
    with SessionLocal() as db:
        owner = db.get(User, acme.owner.id)
        assert owner.can_manage_payroll is False
        db.commit()
    # Owner works regardless.
    assert client.get("/api/v1/payroll/components", headers=acme.headers()).status_code == 200

    with SessionLocal() as db:
        db.get(User, acme.owner.id).role = "admin"
        db.commit()
    assert client.get("/api/v1/payroll/components", headers=acme.headers()).status_code == 403

    _grant_payroll(acme.owner.id)
    assert client.get("/api/v1/payroll/components", headers=acme.headers()).status_code == 200


def test_a_manager_never_sees_a_reports_salary(client, tenants):
    """Approving somebody's leave and their expenses is not a reason to know
    what they earn."""
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _structure(client, acme, acme.employee.id, catalogue)
    with SessionLocal() as db:
        manager = db.get(User, acme.owner.id)
        manager.role = "manager"
        manager.can_manage_payroll = True   # even with the flag
        db.get(User, acme.employee.id).manager_id = manager.id
        db.commit()

    assert client.get(f"/api/v1/payroll/{acme.employee.id}",
                      headers=acme.headers()).status_code == 403


def test_salaries_do_not_cross_tenants(client, tenants):
    acme, globex = tenants
    catalogue = _catalogue(client, acme)
    _structure(client, acme, acme.employee.id, catalogue)
    assert client.get(f"/api/v1/payroll/{acme.employee.id}",
                      headers=globex.headers()).status_code == 404


def test_the_uncovered_report_lists_gaps_and_carries_no_amounts(client, tenants):
    acme, _ = tenants
    catalogue = _catalogue(client, acme)
    _structure(client, acme, acme.employee.id, catalogue)

    rows = client.get("/api/v1/payroll/uncovered", headers=acme.headers()).json()
    ids = {row["user_id"] for row in rows}
    assert str(acme.owner.id) in ids
    assert str(acme.employee.id) not in ids
    assert "gross_monthly" not in rows[0]
    assert "amount" not in rows[0]

    assert client.get("/api/v1/payroll/uncovered",
                      headers=acme.headers(acme.employee_token)).status_code == 403


def test_payroll_is_gated_like_every_other_module(client, tenants, platform_token):
    acme, _ = tenants
    client.put(
        f"/api/v1/platform/companies/{acme.id}/modules",
        json={"grants": [{"key": "payroll", "enabled": False}]},
        headers={"Authorization": f"Bearer {platform_token}"},
    )
    response = client.get("/api/v1/payroll/me", headers=acme.headers())
    assert response.status_code == 402
    assert response.json()["detail"]["module"] == "payroll"


# --------------------------------------------------------------------------- #
# The resolver, unit-level
# --------------------------------------------------------------------------- #


def test_bps_rounds_half_up():
    assert svc._bps_of(1000000, 4000) == 400000
    # 33.335% of 1000000 paise = 333350 exactly at the half.
    assert svc._bps_of(1000000, 3334) == 333400
    assert svc._bps_of(0, 5000) == 0
