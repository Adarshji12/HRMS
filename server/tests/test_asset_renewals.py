"""Asset details, renewal tracking and the asset dashboard.

The renewal rules worth pinning down: the next due date rolls forward from the
*previous due date* (renewing late must not shift every later renewal), a
one-off expiry with no cycle demands an explicit next date, and the dashboard's
overdue / due / upcoming buckets agree with each asset's own reminder window.
"""

from __future__ import annotations

from datetime import date, timedelta

from app.services.assets import add_months


def _create(client, tenant, **body):
    payload = {"asset_tag": "AST-1", "category": "laptop", **body}
    response = client.post("/api/v1/assets", json=payload, headers=tenant.headers())
    assert response.status_code == 201, response.text
    return response.json()


def test_add_months_clamps_to_month_end():
    assert add_months(date(2026, 1, 31), 1) == date(2026, 2, 28)
    assert add_months(date(2024, 1, 31), 1) == date(2024, 2, 29)
    assert add_months(date(2026, 11, 15), 3) == date(2027, 2, 15)
    assert add_months(date(2026, 5, 10), 12) == date(2027, 5, 10)


def test_full_detail_form_round_trips(client, tenants):
    acme, _ = tenants
    created = _create(
        client, acme,
        asset_tag="LIC-M365",
        category="software_license",
        name="Microsoft 365 E3",
        brand="Microsoft",
        vendor="Redington",
        invoice_number="INV-778",
        purchase_cost_paise=1_250_000,
        location="Head office",
        warranty_expiry="2027-01-01",
        renewal_date="2027-04-01",
        renewal_cycle="yearly",
        renewal_cost_paise=1_300_000,
        reminder_days=45,
        notes="25 seats",
    )
    assert created["name"] == "Microsoft 365 E3"
    assert created["category"] == "software_license"
    assert created["renewal_cycle"] == "yearly"
    assert created["reminder_days"] == 45
    assert created["purchase_cost_paise"] == 1_250_000


def test_any_category_slug_is_accepted_but_junk_is_not(client, tenants):
    acme, _ = tenants
    _create(client, acme, asset_tag="VEH-1", category="delivery_van")
    bad = client.post(
        "/api/v1/assets",
        json={"asset_tag": "X-1", "category": "Not A Slug!"},
        headers=acme.headers(),
    )
    assert bad.status_code == 422


def test_renewal_state_buckets(client, tenants):
    acme, _ = tenants
    today = date.today()
    overdue = _create(client, acme, asset_tag="R-OVER",
                      renewal_date=(today - timedelta(days=3)).isoformat())
    due = _create(client, acme, asset_tag="R-DUE", reminder_days=30,
                  renewal_date=(today + timedelta(days=10)).isoformat())
    upcoming = _create(client, acme, asset_tag="R-UP", reminder_days=15,
                       renewal_date=(today + timedelta(days=40)).isoformat())
    ok = _create(client, acme, asset_tag="R-OK",
                 renewal_date=(today + timedelta(days=200)).isoformat())
    untracked = _create(client, acme, asset_tag="R-NONE")

    assert overdue["renewal_state"] == "overdue"
    assert due["renewal_state"] == "due"
    assert upcoming["renewal_state"] == "upcoming"
    assert ok["renewal_state"] == "ok"
    assert untracked["renewal_state"] == "none"

    dash = client.get("/api/v1/assets/dashboard", headers=acme.headers()).json()
    assert dash["renewals_overdue"] == 1
    assert dash["renewals_due"] == 1
    assert dash["renewals_upcoming"] == 1
    assert dash["renewals_tracked"] == 4
    # Most urgent first.
    assert [a["asset_tag"] for a in dash["attention"]] == ["R-OVER", "R-DUE", "R-UP"]


def test_renew_rolls_forward_from_previous_due_date(client, tenants):
    acme, _ = tenants
    asset = _create(client, acme, asset_tag="DOM-1", category="domain_hosting",
                    renewal_date="2026-03-01", renewal_cycle="yearly",
                    renewal_cost_paise=99_900)
    # Renewed a week late: the next due is still 1 March, not 8 March.
    response = client.post(f"/api/v1/assets/{asset['id']}/renew",
                           json={"renewed_on": "2026-03-08", "reference": "TXN-1"},
                           headers=acme.headers())
    assert response.status_code == 200, response.text
    assert response.json()["renewal_date"] == "2027-03-01"

    history = client.get(f"/api/v1/assets/{asset['id']}/renewals",
                         headers=acme.headers()).json()
    assert len(history) == 1
    assert history[0]["previous_due"] == "2026-03-01"
    assert history[0]["next_due"] == "2027-03-01"
    # The cost defaults to the asset's standing renewal cost.
    assert history[0]["cost_paise"] == 99_900


def test_renew_without_cycle_needs_next_date(client, tenants):
    acme, _ = tenants
    asset = _create(client, acme, asset_tag="INS-1", category="insurance",
                    renewal_date="2026-11-01")
    refused = client.post(f"/api/v1/assets/{asset['id']}/renew", json={},
                          headers=acme.headers())
    assert refused.status_code == 400

    accepted = client.post(f"/api/v1/assets/{asset['id']}/renew",
                           json={"next_due": "2027-11-01", "cost_paise": 500_000},
                           headers=acme.headers())
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["renewal_date"] == "2027-11-01"
    assert accepted.json()["renewal_cost_paise"] == 500_000


def test_stop_tracking_clears_due_date(client, tenants):
    acme, _ = tenants
    asset = _create(client, acme, asset_tag="SUB-1", category="subscription",
                    renewal_date="2026-11-01", renewal_cycle="monthly")
    response = client.post(f"/api/v1/assets/{asset['id']}/renew",
                           json={"stop_tracking": True}, headers=acme.headers())
    assert response.status_code == 200
    assert response.json()["renewal_date"] is None
    assert response.json()["renewal_state"] == "none"


def test_dashboard_counts_holders(client, tenants):
    acme, _ = tenants
    a = _create(client, acme, asset_tag="LAP-A", purchase_cost_paise=5_000_000)
    _create(client, acme, asset_tag="LAP-B", purchase_cost_paise=3_000_000)
    assigned = client.post(
        "/api/v1/assets/assign",
        json={"asset_id": a["id"], "user_id": str(acme.employee.id)},
        headers=acme.headers(),
    )
    assert assigned.status_code == 201, assigned.text

    dash = client.get("/api/v1/assets/dashboard", headers=acme.headers()).json()
    assert dash["total"] == 2
    assert dash["assigned"] == 1
    assert dash["holders"] == 1
    assert dash["total_value_paise"] == 8_000_000
    assert dash["top_holders"][0]["user_id"] == str(acme.employee.id)
    assert dash["top_holders"][0]["count"] == 1


def test_renewals_are_tenant_isolated(client, tenants):
    acme, globex = tenants
    asset = _create(client, acme, asset_tag="ISO-1", renewal_date="2026-12-01",
                    renewal_cycle="yearly")
    response = client.post(f"/api/v1/assets/{asset['id']}/renew", json={},
                           headers=globex.headers())
    assert response.status_code == 404
    assert client.get("/api/v1/assets/renewals", headers=globex.headers()).json() == []
