"""CRM opportunities: the deal on a lead, its margin, its files and the tenant wall."""

from __future__ import annotations

import pytest


@pytest.fixture
def acme(tenants):
    return tenants[0]


@pytest.fixture
def globex(tenants):
    return tenants[1]


def _lead(client, tenant) -> dict:
    response = client.post(
        "/api/v1/crm/leads",
        json={"name": "Rohit Sharma", "mobile": "+919000000001"},
        headers=tenant.headers(),
    )
    assert response.status_code == 201, response.text
    return response.json()


def _opportunity(client, tenant, lead_id: str, **overrides):
    payload = {"title": "Desktop refresh", "expected_revenue": "100000", **overrides}
    return client.post(
        f"/api/v1/crm/leads/{lead_id}/opportunities", json=payload, headers=tenant.headers()
    )


def test_create_works_out_the_margin(client, acme):
    lead = _lead(client, acme)
    response = _opportunity(
        client, acme, lead["id"], raw_cost="80000", probability=30, priority=2,
        tags=["Urgent", " urgent ", "", "Hardware"],
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["margin"] == "20000.00"
    assert body["margin_percent"] == "20.00"
    # Blanks and repeats collapse, the first spelling is kept.
    assert body["tags"] == ["Urgent", "Hardware"]
    assert body["priority"] == 2


def test_margin_is_empty_without_a_cost(client, acme):
    lead = _lead(client, acme)
    body = _opportunity(client, acme, lead["id"]).json()
    assert body["margin"] is None and body["margin_percent"] is None


def test_validation_names_the_problem(client, acme):
    lead = _lead(client, acme)
    assert _opportunity(client, acme, lead["id"], probability=150).status_code == 422
    assert _opportunity(client, acme, lead["id"], title="").status_code == 422
    assert _opportunity(client, acme, lead["id"], expected_revenue="-5").status_code == 422


def test_listing_returns_the_leads_opportunities(client, acme):
    lead = _lead(client, acme)
    _opportunity(client, acme, lead["id"], title="First")
    _opportunity(client, acme, lead["id"], title="Second")
    other = _lead(client, acme)
    listed = client.get(
        f"/api/v1/crm/leads/{lead['id']}/opportunities", headers=acme.headers()
    ).json()
    assert {o["title"] for o in listed} == {"First", "Second"}
    assert client.get(
        f"/api/v1/crm/leads/{other['id']}/opportunities", headers=acme.headers()
    ).json() == []


def test_requirement_types_are_seeded_and_selectable(client, acme):
    kinds = client.get("/api/v1/crm/masters/requirement-types", headers=acme.headers()).json()
    assert kinds and kinds[0]["name"] == "New purchase"
    lead = _lead(client, acme)
    response = _opportunity(client, acme, lead["id"], requirement_type_id=kinds[0]["id"])
    assert response.status_code == 201
    assert response.json()["requirement_type_name"] == "New purchase"
    # In use, so it is deactivated rather than deleted.
    refused = client.delete(
        f"/api/v1/crm/masters/requirement-types/{kinds[0]['id']}", headers=acme.headers()
    )
    assert refused.status_code == 409, refused.text


def test_another_companys_reference_is_refused(client, acme, globex):
    foreign = client.get(
        "/api/v1/crm/masters/requirement-types", headers=globex.headers()
    ).json()[0]
    lead = _lead(client, acme)
    response = _opportunity(client, acme, lead["id"], requirement_type_id=foreign["id"])
    assert response.status_code == 422


def test_another_company_cannot_see_or_change_it(client, acme, globex):
    lead = _lead(client, acme)
    created = _opportunity(client, acme, lead["id"]).json()
    assert client.get(
        f"/api/v1/crm/leads/{lead['id']}/opportunities", headers=globex.headers()
    ).status_code == 404
    assert client.put(
        f"/api/v1/crm/opportunities/{created['id']}",
        json={"title": "Hijacked"},
        headers=globex.headers(),
    ).status_code == 404
    assert client.delete(
        f"/api/v1/crm/opportunities/{created['id']}", headers=globex.headers()
    ).status_code == 404


def test_update_and_delete(client, acme):
    lead = _lead(client, acme)
    created = _opportunity(client, acme, lead["id"]).json()
    updated = client.put(
        f"/api/v1/crm/opportunities/{created['id']}",
        json={"title": "Renamed", "expected_revenue": "50000", "raw_cost": "60000"},
        headers=acme.headers(),
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["title"] == "Renamed"
    # A loss shows as a negative margin rather than being clamped to zero.
    assert updated.json()["margin"] == "-10000.00"
    assert client.delete(
        f"/api/v1/crm/opportunities/{created['id']}", headers=acme.headers()
    ).status_code == 204
    assert client.get(
        f"/api/v1/crm/leads/{lead['id']}/opportunities", headers=acme.headers()
    ).json() == []


def test_attachment_round_trip(client, acme, globex):
    lead = _lead(client, acme)
    created = _opportunity(client, acme, lead["id"]).json()
    url = f"/api/v1/crm/opportunities/{created['id']}/files/costsheet"

    uploaded = client.post(
        url, files={"file": ("cost.xlsx", b"sheet-bytes", "application/octet-stream")},
        headers=acme.headers(),
    )
    assert uploaded.status_code == 200, uploaded.text
    attachment = uploaded.json()["costsheet"]
    assert attachment["name"] == "cost.xlsx" and attachment["size"] == len(b"sheet-bytes")
    # The storage key is never part of the response.
    assert "key" not in uploaded.text

    assert client.get(url, headers=acme.headers()).content == b"sheet-bytes"
    assert client.get(url, headers=globex.headers()).status_code == 404

    cleared = client.delete(url, headers=acme.headers())
    assert cleared.status_code == 200 and cleared.json()["costsheet"] is None
    assert client.get(url, headers=acme.headers()).status_code == 404


def test_unknown_attachment_kind_and_empty_file(client, acme):
    lead = _lead(client, acme)
    created = _opportunity(client, acme, lead["id"]).json()
    base = f"/api/v1/crm/opportunities/{created['id']}/files"
    assert client.post(
        f"{base}/passport", files={"file": ("a.pdf", b"x", "application/pdf")}, headers=acme.headers()
    ).status_code == 404
    assert client.post(
        f"{base}/quotation", files={"file": ("a.pdf", b"", "application/pdf")}, headers=acme.headers()
    ).status_code == 422


def test_an_opportunity_can_be_linked_to_an_existing_customer(client, acme, globex):
    mine = client.post(
        "/api/v1/crm/customers",
        json={"name": "Priya Traders", "mobile": "+919000000055"},
        headers=acme.headers(),
    )
    assert mine.status_code == 201, mine.text
    theirs = client.post(
        "/api/v1/crm/customers",
        json={"name": "Globex Customer", "mobile": "+919000000066"},
        headers=globex.headers(),
    ).json()
    lead = _lead(client, acme)

    linked = _opportunity(client, acme, lead["id"], customer_id=mine.json()["id"])
    assert linked.status_code == 201, linked.text
    assert linked.json()["customer_name"] == "Priya Traders"
    # Optional: a deal for a lead that is not a customer yet carries none.
    assert _opportunity(client, acme, lead["id"]).json()["customer_id"] is None
    # Another company's customer is refused, like any other foreign reference.
    assert _opportunity(client, acme, lead["id"], customer_id=theirs["id"]).status_code == 422


def _decide(client, headers, opportunity_id: str, decision: str):
    return client.post(
        f"/api/v1/crm/opportunities/{opportunity_id}/costsheet-decision",
        json={"decision": decision},
        headers=headers,
    )


def _with_costsheet(client, tenant, **overrides) -> dict:
    lead = _lead(client, tenant)
    created = _opportunity(client, tenant, lead["id"], **overrides).json()
    uploaded = client.post(
        f"/api/v1/crm/opportunities/{created['id']}/files/costsheet",
        files={"file": ("cost.xlsx", b"sheet", "application/octet-stream")},
        headers=tenant.headers(),
    )
    assert uploaded.status_code == 200, uploaded.text
    return uploaded.json()


def test_ticking_the_box_sends_the_costsheet_for_approval(client, acme):
    sent = _with_costsheet(client, acme)
    assert sent["costsheet_status"] == "none"
    updated = client.put(
        f"/api/v1/crm/opportunities/{sent['id']}",
        json={"title": "Desktop refresh", "send_costsheet_for_approval": True},
        headers=acme.headers(),
    )
    assert updated.json()["costsheet_status"] == "pending"
    # Saving again with the box still ticked does not reset a decision.
    assert _decide(client, acme.headers(), sent["id"], "approved").json()["costsheet_status"] == "approved"
    again = client.put(
        f"/api/v1/crm/opportunities/{sent['id']}",
        json={"title": "Desktop refresh", "send_costsheet_for_approval": True},
        headers=acme.headers(),
    )
    assert again.json()["costsheet_status"] == "approved"
    # Unticking withdraws it.
    withdrawn = client.put(
        f"/api/v1/crm/opportunities/{sent['id']}",
        json={"title": "Desktop refresh", "send_costsheet_for_approval": False},
        headers=acme.headers(),
    )
    assert withdrawn.json()["costsheet_status"] == "none"


def test_a_manager_can_approve_and_then_reject(client, acme):
    opp = _with_costsheet(client, acme, send_costsheet_for_approval=True)
    assert opp["costsheet_status"] == "pending"
    assert _decide(client, acme.headers(), opp["id"], "approved").json()["costsheet_status"] == "approved"
    assert _decide(client, acme.headers(), opp["id"], "rejected").json()["costsheet_status"] == "rejected"
    assert _decide(client, acme.headers(), opp["id"], "maybe").status_code == 422


def test_a_costsheet_not_sent_or_without_a_file_cannot_be_decided(client, acme):
    unsent = _with_costsheet(client, acme)
    assert _decide(client, acme.headers(), unsent["id"], "approved").status_code == 409
    lead = _lead(client, acme)
    no_file = _opportunity(client, acme, lead["id"], send_costsheet_for_approval=True).json()
    refused = _decide(client, acme.headers(), no_file["id"], "approved")
    assert refused.status_code == 409 and "Attach the costsheet" in refused.text


def test_a_plain_employee_cannot_decide(client, acme):
    opp = _with_costsheet(client, acme, send_costsheet_for_approval=True)
    refused = _decide(client, acme.headers(acme.employee_token), opp["id"], "approved")
    assert refused.status_code == 403, refused.text
    assert _decide(client, acme.headers(), opp["id"], "approved").status_code == 200


def test_another_company_cannot_decide(client, acme, globex):
    opp = _with_costsheet(client, acme, send_costsheet_for_approval=True)
    assert _decide(client, globex.headers(), opp["id"], "approved").status_code == 404


def test_the_approvals_list_filters_by_status_and_stays_inside_the_company(client, acme, globex):
    pending = _with_costsheet(client, acme, title="Pending deal", send_costsheet_for_approval=True)
    decided = _with_costsheet(client, acme, title="Decided deal", send_costsheet_for_approval=True)
    _decide(client, acme.headers(), decided["id"], "rejected")
    _with_costsheet(client, acme, title="Never sent")
    _with_costsheet(client, globex, title="Theirs", send_costsheet_for_approval=True)

    def titles(status):
        rows = client.get(
            "/api/v1/crm/opportunities", params={"costsheet_status": status}, headers=acme.headers()
        ).json()
        return {r["title"] for r in rows}

    assert titles("requested") == {"Pending deal", "Decided deal"}
    assert titles("pending") == {"Pending deal"}
    assert titles("rejected") == {"Decided deal"}
    assert titles("approved") == set()
    # The table needs the lead's name without a second call.
    rows = client.get(
        "/api/v1/crm/opportunities", params={"costsheet_status": "requested"}, headers=acme.headers()
    ).json()
    assert all(r["lead_name"] == "Rohit Sharma" and r["lead_code"] for r in rows)
    assert client.get(
        "/api/v1/crm/opportunities", params={"costsheet_status": "bogus"}, headers=acme.headers()
    ).status_code == 422
    assert pending["id"]
