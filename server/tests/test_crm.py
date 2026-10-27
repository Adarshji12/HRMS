"""CRM: the pipeline, the money, and the tenant boundary.

The tests here are chosen for the failures that would actually hurt:

* one company reading another's leads, customers or quotations,
* an employee reading a colleague's pipeline (the module is called "My Leads"),
* quotation arithmetic — the totals a customer checks, and the CGST/SGST versus
  IGST decision that a wrong answer turns into a tax problem,
* the denormalised ``next_follow_up_at``, which is fast precisely because it is
  written by hand and therefore the thing most likely to drift,
* and conversion, which must happen exactly once.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest


def _iso(when: datetime) -> str:
    return when.astimezone(timezone.utc).isoformat()


@pytest.fixture
def acme(tenants):
    return tenants[0]


@pytest.fixture
def globex(tenants):
    return tenants[1]


def _masters(client, tenant, kind: str) -> list[dict]:
    response = client.get(f"/api/v1/crm/masters/{kind}", headers=tenant.headers())
    assert response.status_code == 200, response.text
    return response.json()


def _new_lead(client, tenant, **overrides) -> dict:
    payload = {"name": "Rohit Sharma", "mobile": "919000000001", **overrides}
    response = client.post("/api/v1/crm/leads", json=payload, headers=tenant.headers())
    assert response.status_code == 201, response.text
    return response.json()


# --------------------------------------------------------------------------- #
# Masters and seeding
# --------------------------------------------------------------------------- #


def test_masters_seed_on_first_read(client, acme):
    statuses = _masters(client, acme, "statuses")
    assert [s["name"] for s in statuses][:2] == ["Pending", "Contacted"]
    assert sum(1 for s in statuses if s["behaviour"] == "default") == 1
    assert _masters(client, acme, "visit-types")
    assert _masters(client, acme, "dispositions")
    # India's states arrive with their GST codes, which is what decides the tax
    # split on a quotation.
    states = _masters(client, acme, "states")
    assert any(s["name"] == "Maharashtra" and s["gst_code"] == "27" for s in states)


def test_seeding_is_idempotent(client, acme):
    first = _masters(client, acme, "statuses")
    second = _masters(client, acme, "statuses")
    assert len(first) == len(second)


def test_master_delete_refused_while_in_use(client, acme):
    statuses = _masters(client, acme, "statuses")
    pending = next(s for s in statuses if s["behaviour"] == "default")
    _new_lead(client, acme)

    response = client.delete(
        f"/api/v1/crm/masters/statuses/{pending['id']}", headers=acme.headers()
    )
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "master_in_use"


def test_employee_may_read_masters_but_not_write_them(client, acme):
    assert client.get(
        "/api/v1/crm/masters/sources", headers=acme.headers(acme.employee_token)
    ).status_code == 200
    denied = client.post(
        "/api/v1/crm/masters/sources",
        json={"name": "Exhibition"},
        headers=acme.headers(acme.employee_token),
    )
    assert denied.status_code == 403


# --------------------------------------------------------------------------- #
# Leads
# --------------------------------------------------------------------------- #


def test_new_lead_lands_on_the_default_stage_and_gets_a_code(client, acme):
    lead = _new_lead(client, acme)
    assert lead["status_name"] == "Pending"
    assert lead["code"] and len(lead["code"]) >= 6
    # Blank WhatsApp means "same as mobile" — the console offers exactly that.
    assert lead["whatsapp"] == lead["mobile"]


def test_lead_codes_are_unique_within_a_workspace(client, acme):
    codes = {_new_lead(client, acme, mobile=f"91900000{i:04d}")["code"] for i in range(12)}
    assert len(codes) == 12


def test_leads_are_scoped_to_the_tenant(client, acme, globex):
    _new_lead(client, acme, name="Acme Prospect")
    _new_lead(client, globex, name="Globex Prospect", mobile="919000000002")

    rows = client.get("/api/v1/crm/leads", headers=acme.headers()).json()["rows"]
    assert [r["name"] for r in rows] == ["Acme Prospect"]


def test_one_tenant_cannot_read_anothers_lead(client, acme, globex):
    lead = _new_lead(client, acme)
    response = client.get(f"/api/v1/crm/leads/{lead['id']}", headers=globex.headers())
    # 404, not 403: a 403 would confirm the id exists somewhere.
    assert response.status_code == 404


def test_an_employee_sees_only_their_own_pipeline(client, acme):
    mine = _new_lead(client, acme, name="Mine", owner_id=str(acme.employee.id))
    _new_lead(client, acme, name="Somebody else's", mobile="919000000003",
              owner_id=str(acme.owner.id))

    rows = client.get(
        "/api/v1/crm/leads", headers=acme.headers(acme.employee_token)
    ).json()["rows"]
    names = {r["name"] for r in rows}
    assert "Mine" in names
    assert "Somebody else's" not in names
    assert client.get(
        f"/api/v1/crm/leads/{mine['id']}", headers=acme.headers(acme.employee_token)
    ).status_code == 200


def test_unassigned_leads_stay_visible_to_everyone(client, acme):
    """The unassigned pool is work waiting to be picked up, not somebody's."""
    _new_lead(client, acme, name="Nobody's yet")
    rows = client.get(
        "/api/v1/crm/leads", headers=acme.headers(acme.employee_token)
    ).json()["rows"]
    assert [r["name"] for r in rows] == ["Nobody's yet"]


def test_status_move_is_recorded_on_the_timeline(client, acme):
    lead = _new_lead(client, acme)
    qualified = next(s for s in _masters(client, acme, "statuses") if s["name"] == "Qualified")

    moved = client.post(
        f"/api/v1/crm/leads/{lead['id']}/status",
        json={"status_id": qualified["id"], "note": "Budget confirmed"},
        headers=acme.headers(),
    )
    assert moved.status_code == 200
    detail = client.get(f"/api/v1/crm/leads/{lead['id']}", headers=acme.headers()).json()
    entries = [a["body"] for a in detail["activities"]]
    assert any("Pending → Qualified" in e and "Budget confirmed" in e for e in entries)


def test_bulk_assign_moves_ownership(client, acme):
    ids = [_new_lead(client, acme, mobile=f"91911100{i:04d}")["id"] for i in range(3)]
    response = client.post(
        "/api/v1/crm/leads/assign",
        json={"lead_ids": ids, "owner_id": str(acme.employee.id)},
        headers=acme.headers(),
    )
    assert response.json() == {"moved": 3}
    rows = client.get("/api/v1/crm/leads", headers=acme.headers()).json()["rows"]
    assert {r["owner_id"] for r in rows} == {str(acme.employee.id)}


def test_import_skips_duplicates_by_mobile(client, acme):
    _new_lead(client, acme, mobile="919000000010")
    result = client.post(
        "/api/v1/crm/leads/import",
        json={
            "rows": [
                {"name": "Already here", "mobile": "919000000010"},
                {"name": "New one", "mobile": "919000000011", "source": "Exhibition"},
            ],
            "skip_duplicates": True,
        },
        headers=acme.headers(),
    ).json()
    assert result == {"created": 1, "skipped": 1, "errors": []}
    # An unknown source is created rather than dropped; an unknown status is not.
    assert any(s["name"] == "Exhibition" for s in _masters(client, acme, "sources"))


def test_export_returns_csv_for_the_same_scope(client, acme):
    _new_lead(client, acme, name="Exportable")
    response = client.get("/api/v1/crm/leads/export", headers=acme.headers())
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert "Exportable" in response.text


# --------------------------------------------------------------------------- #
# Follow-ups and the denormalised column
# --------------------------------------------------------------------------- #


def test_follow_up_writes_and_clears_next_follow_up_at(client, acme):
    lead = _new_lead(client, acme)
    due = datetime.now(timezone.utc) + timedelta(days=1)

    created = client.post(
        "/api/v1/crm/follow-ups",
        json={"lead_id": lead["id"], "due_at": _iso(due), "purpose": "Send pricing"},
        headers=acme.headers(),
    )
    assert created.status_code == 201

    after = client.get(f"/api/v1/crm/leads/{lead['id']}", headers=acme.headers()).json()
    assert after["next_follow_up_at"] is not None

    client.post(
        f"/api/v1/crm/follow-ups/{created.json()['id']}/complete",
        json={"outcome": "Sent"},
        headers=acme.headers(),
    )
    cleared = client.get(f"/api/v1/crm/leads/{lead['id']}", headers=acme.headers()).json()
    assert cleared["next_follow_up_at"] is None


def test_earliest_pending_follow_up_wins(client, acme):
    lead = _new_lead(client, acme)
    later = datetime.now(timezone.utc) + timedelta(days=5)
    sooner = datetime.now(timezone.utc) + timedelta(days=2)
    for due in (later, sooner):
        client.post(
            "/api/v1/crm/follow-ups",
            json={"lead_id": lead["id"], "due_at": _iso(due)},
            headers=acme.headers(),
        )
    row = client.get(f"/api/v1/crm/leads/{lead['id']}", headers=acme.headers()).json()
    assert row["next_follow_up_at"].startswith(sooner.date().isoformat())


def test_completing_a_follow_up_can_book_the_next_one(client, acme):
    lead = _new_lead(client, acme)
    first = client.post(
        "/api/v1/crm/follow-ups",
        json={"lead_id": lead["id"], "due_at": _iso(datetime.now(timezone.utc))},
        headers=acme.headers(),
    ).json()
    next_due = datetime.now(timezone.utc) + timedelta(days=3)
    client.post(
        f"/api/v1/crm/follow-ups/{first['id']}/complete",
        json={"outcome": "Spoke", "next_due_at": _iso(next_due), "next_purpose": "Close"},
        headers=acme.headers(),
    )
    pending = client.get(
        "/api/v1/crm/follow-ups?status=pending", headers=acme.headers()
    ).json()
    assert [p["purpose"] for p in pending] == ["Close"]


def test_a_terminal_stage_cancels_outstanding_follow_ups(client, acme):
    lead = _new_lead(client, acme)
    client.post(
        "/api/v1/crm/follow-ups",
        json={"lead_id": lead["id"], "due_at": _iso(datetime.now(timezone.utc))},
        headers=acme.headers(),
    )
    lost = next(s for s in _masters(client, acme, "statuses") if s["behaviour"] == "lost")
    client.post(
        f"/api/v1/crm/leads/{lead['id']}/status",
        json={"status_id": lost["id"], "note": "Went with a competitor"},
        headers=acme.headers(),
    )
    assert client.get("/api/v1/crm/follow-ups?status=pending", headers=acme.headers()).json() == []
    row = client.get(f"/api/v1/crm/leads/{lead['id']}", headers=acme.headers()).json()
    assert row["lost_reason"] == "Went with a competitor"
    assert row["next_follow_up_at"] is None


def test_overdue_is_computed_server_side(client, acme):
    lead = _new_lead(client, acme)
    client.post(
        "/api/v1/crm/follow-ups",
        json={
            "lead_id": lead["id"],
            "due_at": _iso(datetime.now(timezone.utc) - timedelta(days=2)),
        },
        headers=acme.headers(),
    )
    rows = client.get("/api/v1/crm/follow-ups?window=overdue", headers=acme.headers()).json()
    assert len(rows) == 1 and rows[0]["is_overdue"] is True


# --------------------------------------------------------------------------- #
# Conversion
# --------------------------------------------------------------------------- #


def test_conversion_creates_a_customer_and_marks_the_lead_won(client, acme):
    lead = _new_lead(client, acme, company="Sharma Traders")
    response = client.post(
        f"/api/v1/crm/leads/{lead['id']}/convert",
        json={
            "plan": {
                "product_name": "Bizinteract",
                "plan_name": "Enterprise",
                "start_on": date.today().isoformat(),
                "amount": "25000.00",
            }
        },
        headers=acme.headers(),
    )
    assert response.status_code == 201
    customer = response.json()
    assert customer["name"] == lead["name"]
    assert customer["converted_from_lead_id"] == lead["id"]
    assert customer["primary_plan"]["product_name"] == "Bizinteract"

    after = client.get(f"/api/v1/crm/leads/{lead['id']}", headers=acme.headers()).json()
    assert after["customer_id"] == customer["id"]
    assert after["status_behaviour"] == "won"


def test_a_lead_converts_only_once(client, acme):
    lead = _new_lead(client, acme)
    assert client.post(
        f"/api/v1/crm/leads/{lead['id']}/convert", json={}, headers=acme.headers()
    ).status_code == 201
    second = client.post(
        f"/api/v1/crm/leads/{lead['id']}/convert", json={}, headers=acme.headers()
    )
    assert second.status_code == 409
    assert second.json()["detail"]["reason"] == "already_converted"


def test_a_converted_lead_cannot_be_deleted(client, acme):
    lead = _new_lead(client, acme)
    client.post(f"/api/v1/crm/leads/{lead['id']}/convert", json={}, headers=acme.headers())
    response = client.delete(f"/api/v1/crm/leads/{lead['id']}", headers=acme.headers())
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "lead_converted"


# --------------------------------------------------------------------------- #
# Customers, support and visits
# --------------------------------------------------------------------------- #


def _customer(client, tenant, **overrides) -> dict:
    payload = {"name": "Advotalk", "mobile": "919599322060", **overrides}
    response = client.post("/api/v1/crm/customers", json=payload, headers=tenant.headers())
    assert response.status_code == 201, response.text
    return response.json()


def test_customer_codes_are_generated_and_unique(client, acme):
    first, second = _customer(client, acme), _customer(client, acme, mobile="919599322061")
    assert first["code"] != second["code"]
    clash = client.post(
        "/api/v1/crm/customers",
        json={"name": "Duplicate", "mobile": "919599322062", "code": first["code"]},
        headers=acme.headers(),
    )
    assert clash.status_code == 409


def test_renewal_window_filters_the_customer_list(client, acme):
    customer = _customer(client, acme)
    client.post(
        f"/api/v1/crm/customers/{customer['id']}/plans",
        json={
            "product_name": "Bizinteract",
            "start_on": date.today().isoformat(),
            "renewal_on": (date.today() + timedelta(days=10)).isoformat(),
            "amount": "1000",
        },
        headers=acme.headers(),
    )
    due = client.get("/api/v1/crm/customers?renewal=due", headers=acme.headers()).json()
    assert [c["id"] for c in due] == [customer["id"]]
    assert client.get("/api/v1/crm/customers?renewal=expired", headers=acme.headers()).json() == []


def test_plan_end_date_comes_from_the_plan_duration(client, acme):
    product = client.post(
        "/api/v1/crm/masters/products",
        json={"name": "Bizinteract", "rate": "25000", "gst_percent": "18"},
        headers=acme.headers(),
    ).json()
    plan = client.post(
        "/api/v1/crm/masters/plans",
        json={"name": "Annual", "product_id": product["id"], "duration_days": 365,
              "price": "25000"},
        headers=acme.headers(),
    ).json()
    customer = _customer(client, acme)
    row = client.post(
        f"/api/v1/crm/customers/{customer['id']}/plans",
        json={
            "product_id": product["id"], "plan_id": plan["id"],
            "start_on": "2026-01-01", "amount": "25000",
        },
        headers=acme.headers(),
    ).json()
    assert row["end_on"] == "2027-01-01"
    # Renewal defaults to the end date rather than being left empty — an
    # unscheduled renewal is one that gets noticed after it lapses.
    assert row["renewal_on"] == "2027-01-01"


def test_logging_a_call_can_book_a_follow_up(client, acme):
    customer = _customer(client, acme)
    dispositions = _masters(client, acme, "dispositions")
    resolved = next(d for d in dispositions if d["closes_interaction"])
    due = datetime.now(timezone.utc) + timedelta(days=1)

    logged = client.post(
        "/api/v1/crm/interactions",
        json={
            "customer_id": customer["id"], "direction": "inbound",
            "disposition_id": resolved["id"], "remarks": "Asked about renewal",
            "follow_up_at": _iso(due), "follow_up_purpose": "Renewal quote",
        },
        headers=acme.headers(),
    )
    assert logged.status_code == 201
    body = logged.json()
    # A disposition that means "done" closes the call unless told otherwise.
    assert body["status"] == "closed"
    assert body["follow_up_id"]
    assert body["ticket_no"].startswith("TKT-")

    summary = client.get("/api/v1/crm/interactions/summary", headers=acme.headers()).json()
    assert summary["logged_today"] == 1 and summary["closed"] == 1


def test_visit_lifecycle_and_numbering(client, acme):
    customer = _customer(client, acme)
    service = next(v for v in _masters(client, acme, "visit-types") if v["name"] == "Service Visit")
    visit = client.post(
        "/api/v1/crm/visits",
        json={
            "customer_id": customer["id"], "visit_type_id": service["id"],
            "scheduled_at": _iso(datetime.now(timezone.utc) + timedelta(days=1)),
            "purpose": "Quarterly service",
        },
        headers=acme.headers(),
    )
    assert visit.status_code == 201
    row = visit.json()
    assert row["visit_no"] == "VST-0001"
    assert row["status"] == "scheduled"
    # A blank address falls back to the customer's, resolved at read time.
    assert row["mobile"] == customer["mobile"]

    started = client.post(
        f"/api/v1/crm/visits/{row['id']}/start", json={}, headers=acme.headers()
    ).json()
    assert started["status"] == "in_progress"

    closed = client.post(
        f"/api/v1/crm/visits/{row['id']}/close",
        json={"outcome": "Filter replaced"},
        headers=acme.headers(),
    ).json()
    assert closed["status"] == "completed" and closed["duration_minutes"] is not None


def test_a_visit_type_that_requires_otp_refuses_a_bare_check_in(client, acme):
    customer = _customer(client, acme)
    collection = next(v for v in _masters(client, acme, "visit-types") if v["requires_otp"])
    visit = client.post(
        "/api/v1/crm/visits",
        json={
            "customer_id": customer["id"], "visit_type_id": collection["id"],
            "scheduled_at": _iso(datetime.now(timezone.utc)),
        },
        headers=acme.headers(),
    ).json()

    blocked = client.post(f"/api/v1/crm/visits/{visit['id']}/start", json={},
                          headers=acme.headers())
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["reason"] == "otp_not_issued"

    otp = client.post(f"/api/v1/crm/visits/{visit['id']}/otp", headers=acme.headers()).json()["otp"]
    wrong = client.post(
        f"/api/v1/crm/visits/{visit['id']}/start", json={"otp": "000000"}, headers=acme.headers()
    )
    assert wrong.status_code == 403

    right = client.post(
        f"/api/v1/crm/visits/{visit['id']}/start", json={"otp": otp}, headers=acme.headers()
    ).json()
    assert right["status"] == "in_progress" and right["otp_verified"] is True


# --------------------------------------------------------------------------- #
# Quotations — the arithmetic
# --------------------------------------------------------------------------- #


def _quotation(client, tenant, lines, **overrides) -> dict:
    payload = {
        "quote_date": date.today().isoformat(),
        "customer_name": "Advotalk",
        "lines": lines,
        **overrides,
    }
    response = client.post("/api/v1/crm/quotations", json=payload, headers=tenant.headers())
    assert response.status_code == 201, response.text
    return response.json()


def test_line_totals_and_gst_split_within_the_state(client, acme):
    quote = _quotation(
        client, acme,
        [{"name": "Bizinteract Enterprise", "quantity": "2", "rate": "10000",
          "discount": "10", "discount_is_percent": True, "gst_percent": "18"}],
    )
    line = quote["lines"][0]
    # 2 × 10000 = 20000, less 10% = 18000 taxable, 18% GST = 3240.
    assert line["taxable_value"] == "18000.00"
    assert line["tax_amount"] == "3240.00"
    assert quote["grand_total"] == "21240.00"
    # No company state configured in the fixture, so this is treated as
    # intra-state — the common case, and visible on the document either way.
    assert quote["is_interstate"] is False
    assert quote["cgst"] == "1620.00" and quote["sgst"] == "1620.00"
    assert quote["igst"] == "0.00"


def test_igst_when_the_place_of_supply_differs(client, acme):
    client.put(
        "/api/v1/org/company",
        json={"state": "Maharashtra"},
        headers=acme.headers(),
    )
    quote = _quotation(
        client, acme,
        [{"name": "Consulting", "quantity": "1", "rate": "1000", "gst_percent": "18"}],
        state="Karnataka",
    )
    assert quote["is_interstate"] is True
    assert quote["igst"] == "180.00"
    assert quote["cgst"] == "0.00" and quote["sgst"] == "0.00"


def test_cgst_and_sgst_always_sum_to_the_tax_charged(client, acme):
    """An odd number of paise must not vanish in the halving."""
    quote = _quotation(
        client, acme,
        [{"name": "Odd", "quantity": "1", "rate": "99.99", "gst_percent": "5"}],
    )
    total_tax = float(quote["cgst"]) + float(quote["sgst"])
    assert round(total_tax, 2) == round(float(quote["lines"][0]["tax_amount"]), 2)


def test_a_discount_larger_than_the_line_is_clamped(client, acme):
    quote = _quotation(
        client, acme,
        [{"name": "Freebie", "quantity": "1", "rate": "500", "discount": "900",
          "discount_is_percent": False, "gst_percent": "18"}],
    )
    assert quote["lines"][0]["taxable_value"] == "0.00"
    assert quote["grand_total"] == "0.00"


def test_quotation_numbers_are_sequential_per_year(client, acme):
    first = _quotation(client, acme, [], quote_date="2026-04-01")
    second = _quotation(client, acme, [], quote_date="2026-05-01")
    next_year = _quotation(client, acme, [], quote_date="2027-01-05")
    assert first["number"] == "QT-2026-0001"
    assert second["number"] == "QT-2026-0002"
    assert next_year["number"] == "QT-2027-0001"


def test_valid_until_defaults_from_settings(client, acme):
    quote = _quotation(client, acme, [], quote_date="2026-09-01")
    # 15 days is the shipped default.
    assert quote["valid_until"] == "2026-09-16"


def test_an_answered_quotation_cannot_be_edited(client, acme):
    quote = _quotation(client, acme, [{"name": "Thing", "rate": "100"}])
    client.post(
        f"/api/v1/crm/quotations/{quote['id']}/status",
        json={"status": "accepted"},
        headers=acme.headers(),
    )
    blocked = client.put(
        f"/api/v1/crm/quotations/{quote['id']}",
        json={"quote_date": date.today().isoformat(), "lines": []},
        headers=acme.headers(),
    )
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["reason"] == "quotation_decided"


def test_duplicate_copies_the_lines_into_a_fresh_draft(client, acme):
    original = _quotation(
        client, acme, [{"name": "Bizinteract", "quantity": "1", "rate": "1000", "gst_percent": "18"}]
    )
    copy = client.post(
        f"/api/v1/crm/quotations/{original['id']}/duplicate", headers=acme.headers()
    ).json()
    assert copy["number"] != original["number"]
    assert copy["status"] == "draft"
    assert [line["name"] for line in copy["lines"]] == ["Bizinteract"]


def test_only_a_draft_can_be_deleted(client, acme):
    quote = _quotation(client, acme, [])
    client.post(
        f"/api/v1/crm/quotations/{quote['id']}/status",
        json={"status": "sent"},
        headers=acme.headers(),
    )
    refused = client.delete(f"/api/v1/crm/quotations/{quote['id']}", headers=acme.headers())
    assert refused.status_code == 409


def test_quotations_do_not_cross_the_tenant_boundary(client, acme, globex):
    quote = _quotation(client, acme, [])
    assert client.get(
        f"/api/v1/crm/quotations/{quote['id']}", headers=globex.headers()
    ).status_code == 404
    assert client.get("/api/v1/crm/quotations", headers=globex.headers()).json() == []


# --------------------------------------------------------------------------- #
# Dashboard
# --------------------------------------------------------------------------- #


def test_dashboard_counts_and_funnel(client, acme):
    for i in range(3):
        _new_lead(client, acme, mobile=f"91922200{i:04d}")
    converted = _new_lead(client, acme, mobile="919222009999")
    client.post(f"/api/v1/crm/leads/{converted['id']}/convert", json={}, headers=acme.headers())

    data = client.get("/api/v1/crm/dashboard", headers=acme.headers()).json()
    assert data["total_leads"] == 4
    assert data["converted_leads"] == 1
    assert data["conversion_rate"] == 25.0
    # Every day in the range is present, including the quiet ones.
    assert len(data["trend"]) == 30
    assert sum(point["new_leads"] for point in data["trend"]) == 4
    funnel = {stage["name"]: stage["count"] for stage in data["funnel"]}
    assert funnel["Pending"] == 3 and funnel["Won"] == 1
    assert any(owner["name"] == "Unassigned" for owner in data["owners"])


def test_dashboard_is_scoped_to_the_tenant(client, acme, globex):
    _new_lead(client, acme)
    data = client.get("/api/v1/crm/dashboard", headers=globex.headers()).json()
    assert data["total_leads"] == 0 and data["total_leads_all_time"] == 0


# --------------------------------------------------------------------------- #
# Reminders and public intake
# --------------------------------------------------------------------------- #


def test_reminder_wizard_saves_recipients_and_counts_sends(client, acme):
    reminder = client.post(
        "/api/v1/crm/reminders",
        json={
            "name": "Morning batch reminder",
            "message": "Your session starts at 7:00 am.",
            "audience": "list",
            "start_on": date.today().isoformat(),
            "end_on": (date.today() + timedelta(days=6)).isoformat(),
            "send_time": "10:00",
            "recipients": [
                {"name": "A", "mobile": "919000000021"},
                {"name": "B", "mobile": "919000000022"},
                # A repeated number is one person, not two messages.
                {"name": "B again", "mobile": "919000000022"},
            ],
        },
        headers=acme.headers(),
    )
    assert reminder.status_code == 201
    body = reminder.json()
    assert body["recipient_count"] == 2
    assert body["scheduled_sends"] == 7
    assert body["is_active"] is False  # a saved draft never sends


def test_weekday_filter_rejects_a_javascript_sunday(client, acme):
    response = client.post(
        "/api/v1/crm/reminders",
        json={"name": "Bad", "start_on": date.today().isoformat(), "weekdays": [0, 3]},
        headers=acme.headers(),
    )
    assert response.status_code == 422


def test_intake_is_closed_until_it_is_switched_on(client, acme):
    settings = client.get("/api/v1/crm/settings", headers=acme.headers()).json()
    assert settings["intake_url"] is None
    assert client.post(
        "/api/v1/crm/intake/anything",
        json={"name": "Walk-in", "mobile": "919000000031"},
        headers={"X-Org-Slug": acme.slug},
    ).status_code == 404


def test_intake_captures_a_lead_and_ignores_a_repeat(client, acme):
    client.put("/api/v1/crm/settings", json={"intake_enabled": True}, headers=acme.headers())
    url = client.get("/api/v1/crm/settings", headers=acme.headers()).json()["intake_url"]
    assert url
    path = url.split("/api/v1", 1)[1]

    payload = {"name": "Meta Lead", "mobile": "+91 90000-00041", "campaign": "Diwali offer"}
    first = client.post(f"/api/v1{path}", json=payload, headers={"X-Org-Slug": acme.slug})
    assert first.status_code == 200 and first.json()["ok"] is True

    # Meta redelivers. The second call must succeed and must not double the
    # pipeline — an error status there disables the whole subscription.
    second = client.post(f"/api/v1{path}", json=payload, headers={"X-Org-Slug": acme.slug})
    assert second.status_code == 200
    assert second.json()["lead_code"] == first.json()["lead_code"]

    rows = client.get("/api/v1/crm/leads", headers=acme.headers()).json()["rows"]
    assert len(rows) == 1
    assert rows[0]["mobile"] == "+919000000041"
    assert rows[0]["source_name"] == "Meta Ads"


def test_a_rotated_token_invalidates_the_old_capture_url(client, acme):
    client.put("/api/v1/crm/settings", json={"intake_enabled": True}, headers=acme.headers())
    old = client.get("/api/v1/crm/settings", headers=acme.headers()).json()["intake_url"]
    client.post("/api/v1/crm/settings/intake-token", headers=acme.headers())
    path = old.split("/api/v1", 1)[1]
    assert client.post(
        f"/api/v1{path}",
        json={"name": "Stale", "mobile": "919000000051"},
        headers={"X-Org-Slug": acme.slug},
    ).status_code == 404


def test_list_filters_by_industry_and_state(client, acme):
    industries = _masters(client, acme, "industries")
    states = _masters(client, acme, "states")
    assert len(industries) >= 2 and len(states) >= 2
    _new_lead(client, acme, mobile="919000000101",
              industry_id=industries[0]["id"], state_id=states[0]["id"])
    _new_lead(client, acme, mobile="919000000102",
              industry_id=industries[1]["id"], state_id=states[1]["id"])

    def count(**params) -> int:
        response = client.get("/api/v1/crm/leads", params=params, headers=acme.headers())
        assert response.status_code == 200, response.text
        return response.json()["total"]

    assert count() == 2
    assert count(industry_id=industries[0]["id"]) == 1
    assert count(state_id=states[1]["id"]) == 1
    assert count(industry_id=industries[0]["id"], state_id=states[1]["id"]) == 0
