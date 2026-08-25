"""Expense claims — the money rules and the state machine.

This module moves money, so the tests are weighted towards the four things that
would cost somebody real rupees:

1. **The total is server-computed.** A client cannot state a total, and the
   total always equals the sum of the lines.
2. **Submitting freezes the lines.** A manager who approved ₹4,000 must not
   find the claim now says ₹40,000.
3. **Nobody approves their own claim, and nobody both approves and pays.**
4. **Approved is not paid.** They are separate transitions with separate
   permissions, because "approved but unpaid" is the state every employee
   chases.

Amounts are integer paise throughout — ₹250.00 is `25000`.
"""

from __future__ import annotations

import io
from datetime import date, timedelta

from sqlalchemy import select

from app.db.session import SessionLocal
from app.models import ExpenseClaim, ExpenseLine, User


def _category(client, tenant, **overrides):
    body = {"name": "Travel", "requires_receipt": False} | overrides
    response = client.post("/api/v1/expenses/categories", json=body, headers=tenant.headers())
    assert response.status_code == 201, response.text
    return response.json()


def _claim(client, tenant, token=None, **overrides):
    body = {"title": "August travel"} | overrides
    response = client.post("/api/v1/expenses", json=body, headers=tenant.headers(token))
    assert response.status_code == 201, response.text
    return response.json()


def _line(client, tenant, claim_id, category_id, *, amount=25000, token=None, **overrides):
    body = {
        "category_id": category_id,
        "spent_on": date.today().isoformat(),
        "description": "Taxi to airport",
        "amount": amount,
    } | overrides
    response = client.post(
        f"/api/v1/expenses/{claim_id}/lines", json=body, headers=tenant.headers(token)
    )
    return response


def _receipt(client, tenant, line_id, token=None):
    return client.post(
        f"/api/v1/expenses/lines/{line_id}/receipt",
        files={"file": ("receipt.pdf", io.BytesIO(b"a receipt"), "application/pdf")},
        headers=tenant.headers(token),
    )


def _manager(tenant):
    """A real manager account with the tenant's employee reporting to them.

    A third user rather than demoting the owner. Demoting was the first attempt
    and it silently broke every test that also needed a category, because a
    manager cannot create one — an artificial fixture producing an artificial
    failure. A separate account is also what the hierarchy actually looks like.
    """
    import uuid as _uuid

    from app.core.security import create_access_token, generate_enrollment_key, hash_password

    with SessionLocal() as db:
        manager = User(
            id=_uuid.uuid4(),
            org_id=tenant.id,
            email=f"manager-{_uuid.uuid4().hex[:6]}@{tenant.slug}.test",
            full_name="Team Manager",
            role="manager",
            password_hash=hash_password("correct-horse-battery"),
            is_active=True,
            enrollment_key=generate_enrollment_key(),
        )
        db.add(manager)
        db.flush()
        db.get(User, tenant.employee.id).manager_id = manager.id
        db.commit()
        return manager.id, create_access_token(
            str(manager.id), {"typ": "user", "org": str(tenant.id), "role": "manager"}
        )


# --------------------------------------------------------------------------- #
# Categories
# --------------------------------------------------------------------------- #


def test_categories_are_admin_managed_but_readable_by_everyone(client, tenants):
    """You cannot file a claim without knowing what the company reimburses."""
    acme, _ = tenants
    _category(client, acme)
    assert client.get(
        "/api/v1/expenses/categories", headers=acme.headers(acme.employee_token)
    ).status_code == 200
    assert client.post(
        "/api/v1/expenses/categories",
        json={"name": "Mine"},
        headers=acme.headers(acme.employee_token),
    ).status_code == 403


def test_duplicate_category_names_are_refused_with_a_readable_message(client, tenants):
    acme, _ = tenants
    _category(client, acme, name="Travel")
    response = client.post(
        "/api/v1/expenses/categories", json={"name": "travel"}, headers=acme.headers()
    )
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "duplicate_name"


def test_a_zero_cap_is_refused_because_it_would_block_everything(client, tenants):
    acme, _ = tenants
    response = client.post(
        "/api/v1/expenses/categories",
        json={"name": "Odd", "max_amount": 0},
        headers=acme.headers(),
    )
    assert response.status_code == 422


# --------------------------------------------------------------------------- #
# The total
# --------------------------------------------------------------------------- #


def test_the_total_is_the_sum_of_the_lines_and_never_client_supplied(client, tenants):
    acme, _ = tenants
    category = _category(client, acme)
    claim = _claim(client, acme, acme.employee_token,
                   **{"total_amount": 999_999})  # ignored: not on the model
    assert claim["total_amount"] == 0

    detail = _line(client, acme, claim["id"], category["id"], amount=25000,
                   token=acme.employee_token).json()
    assert detail["total_amount"] == 25000

    detail = _line(client, acme, claim["id"], category["id"], amount=17550,
                   token=acme.employee_token, description="Hotel").json()
    assert detail["total_amount"] == 42550
    assert detail["line_count"] == 2


def test_deleting_a_line_recomputes_the_total(client, tenants):
    acme, _ = tenants
    category = _category(client, acme)
    claim = _claim(client, acme, acme.employee_token)
    first = _line(client, acme, claim["id"], category["id"], amount=10000,
                  token=acme.employee_token).json()
    _line(client, acme, claim["id"], category["id"], amount=5000,
          token=acme.employee_token, description="Bus")

    line_id = first["lines"][0]["id"]
    after = client.delete(
        f"/api/v1/expenses/lines/{line_id}", headers=acme.headers(acme.employee_token)
    ).json()
    assert after["total_amount"] == 5000
    assert after["line_count"] == 1


def test_editing_a_line_recomputes_the_total(client, tenants):
    acme, _ = tenants
    category = _category(client, acme)
    claim = _claim(client, acme, acme.employee_token)
    detail = _line(client, acme, claim["id"], category["id"], amount=10000,
                   token=acme.employee_token).json()
    line_id = detail["lines"][0]["id"]

    updated = client.patch(
        f"/api/v1/expenses/lines/{line_id}",
        json={"amount": 33300},
        headers=acme.headers(acme.employee_token),
    ).json()
    assert updated["total_amount"] == 33300


def test_a_zero_or_negative_line_is_refused(client, tenants):
    acme, _ = tenants
    category = _category(client, acme)
    claim = _claim(client, acme, acme.employee_token)
    for amount in (0, -500):
        assert _line(client, acme, claim["id"], category["id"], amount=amount,
                     token=acme.employee_token).status_code == 422


# --------------------------------------------------------------------------- #
# Line validation
# --------------------------------------------------------------------------- #


def test_a_future_or_ancient_expense_is_refused(client, tenants):
    acme, _ = tenants
    category = _category(client, acme)
    claim = _claim(client, acme, acme.employee_token)

    future = _line(client, acme, claim["id"], category["id"],
                   token=acme.employee_token,
                   spent_on=(date.today() + timedelta(days=1)).isoformat())
    assert future.status_code == 422
    assert future.json()["detail"]["reason"] == "future_date"

    ancient = _line(client, acme, claim["id"], category["id"],
                    token=acme.employee_token,
                    spent_on=(date.today() - timedelta(days=400)).isoformat())
    assert ancient.status_code == 422
    assert ancient.json()["detail"]["reason"] == "too_old"


def test_a_line_over_its_category_cap_is_refused(client, tenants):
    acme, _ = tenants
    category = _category(client, acme, name="Meals", max_amount=50000)
    claim = _claim(client, acme, acme.employee_token)

    assert _line(client, acme, claim["id"], category["id"], amount=50000,
                 token=acme.employee_token).status_code == 201
    over = _line(client, acme, claim["id"], category["id"], amount=50001,
                 token=acme.employee_token, description="Dinner")
    assert over.status_code == 422
    assert over.json()["detail"]["reason"] == "over_category_limit"


def test_editing_only_the_amount_is_still_checked_against_the_cap(client, tenants):
    """The merged values are validated, not just the incoming ones."""
    acme, _ = tenants
    category = _category(client, acme, name="Meals", max_amount=50000)
    claim = _claim(client, acme, acme.employee_token)
    detail = _line(client, acme, claim["id"], category["id"], amount=10000,
                   token=acme.employee_token).json()
    line_id = detail["lines"][0]["id"]

    response = client.patch(
        f"/api/v1/expenses/lines/{line_id}",
        json={"amount": 90000},
        headers=acme.headers(acme.employee_token),
    )
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "over_category_limit"


def test_an_inactive_category_cannot_be_claimed_against(client, tenants):
    acme, _ = tenants
    category = _category(client, acme)
    client.patch(
        f"/api/v1/expenses/categories/{category['id']}",
        json={"is_active": False},
        headers=acme.headers(),
    )
    claim = _claim(client, acme, acme.employee_token)
    response = _line(client, acme, claim["id"], category["id"], token=acme.employee_token)
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "category_inactive"


# --------------------------------------------------------------------------- #
# Receipts
# --------------------------------------------------------------------------- #


def test_a_receipt_is_required_where_the_category_says_so(client, tenants):
    acme, _ = tenants
    category = _category(client, acme, name="Equipment", requires_receipt=True)
    claim = _claim(client, acme, acme.employee_token)
    detail = _line(client, acme, claim["id"], category["id"],
                   token=acme.employee_token).json()
    assert detail["lines"][0]["receipt_required"] is True
    assert detail["lines"][0]["has_receipt"] is False

    refused = client.post(
        f"/api/v1/expenses/{claim['id']}/submit", headers=acme.headers(acme.employee_token)
    )
    assert refused.status_code == 422
    assert refused.json()["detail"]["reason"] == "receipt_required"

    assert _receipt(client, acme, detail["lines"][0]["id"],
                    acme.employee_token).status_code == 200
    assert client.post(
        f"/api/v1/expenses/{claim['id']}/submit", headers=acme.headers(acme.employee_token)
    ).status_code == 200


def test_a_receipt_is_downloadable_and_its_key_never_leaves_the_server(client, tenants):
    acme, _ = tenants
    category = _category(client, acme)
    claim = _claim(client, acme, acme.employee_token)
    detail = _line(client, acme, claim["id"], category["id"],
                   token=acme.employee_token).json()
    line_id = detail["lines"][0]["id"]
    line = _receipt(client, acme, line_id, acme.employee_token).json()
    assert "receipt_key" not in line

    fetched = client.get(
        f"/api/v1/expenses/lines/{line_id}/receipt",
        headers=acme.headers(acme.employee_token),
    )
    assert fetched.status_code == 200
    assert fetched.content == b"a receipt"


def test_attaching_a_second_receipt_replaces_the_first(client, tenants):
    """A line is one expense; two receipts on it means two lines."""
    acme, _ = tenants
    category = _category(client, acme)
    claim = _claim(client, acme, acme.employee_token)
    detail = _line(client, acme, claim["id"], category["id"],
                   token=acme.employee_token).json()
    line_id = detail["lines"][0]["id"]

    _receipt(client, acme, line_id, acme.employee_token)
    client.post(
        f"/api/v1/expenses/lines/{line_id}/receipt",
        files={"file": ("newer.pdf", io.BytesIO(b"the corrected receipt"),
                        "application/pdf")},
        headers=acme.headers(acme.employee_token),
    )
    fetched = client.get(
        f"/api/v1/expenses/lines/{line_id}/receipt",
        headers=acme.headers(acme.employee_token),
    )
    assert fetched.content == b"the corrected receipt"


# --------------------------------------------------------------------------- #
# Submission freezes the lines
# --------------------------------------------------------------------------- #


def test_submitting_freezes_the_lines(client, tenants):
    """A manager who approved one figure must not find it changed underneath."""
    acme, _ = tenants
    category = _category(client, acme)
    claim = _claim(client, acme, acme.employee_token)
    detail = _line(client, acme, claim["id"], category["id"], amount=400000,
                   token=acme.employee_token).json()
    line_id = detail["lines"][0]["id"]

    client.post(f"/api/v1/expenses/{claim['id']}/submit",
                headers=acme.headers(acme.employee_token))

    for attempt in (
        client.patch(f"/api/v1/expenses/lines/{line_id}", json={"amount": 4_000_000},
                     headers=acme.headers(acme.employee_token)),
        client.delete(f"/api/v1/expenses/lines/{line_id}",
                      headers=acme.headers(acme.employee_token)),
        _line(client, acme, claim["id"], category["id"], token=acme.employee_token,
              description="Sneaky extra"),
        client.patch(f"/api/v1/expenses/{claim['id']}", json={"title": "Rewritten"},
                     headers=acme.headers(acme.employee_token)),
    ):
        assert attempt.status_code == 409, attempt.text
        assert attempt.json()["detail"]["reason"] == "not_editable"

    after = client.get(f"/api/v1/expenses/{claim['id']}",
                       headers=acme.headers(acme.employee_token)).json()
    assert after["total_amount"] == 400000


def test_an_empty_claim_cannot_be_submitted(client, tenants):
    acme, _ = tenants
    claim = _claim(client, acme, acme.employee_token)
    response = client.post(
        f"/api/v1/expenses/{claim['id']}/submit", headers=acme.headers(acme.employee_token)
    )
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "no_lines"


def test_a_draft_can_be_deleted_but_a_submitted_claim_cannot(client, tenants):
    acme, _ = tenants
    category = _category(client, acme)
    first = _claim(client, acme, acme.employee_token)
    assert client.delete(
        f"/api/v1/expenses/{first['id']}", headers=acme.headers(acme.employee_token)
    ).status_code == 204

    second = _claim(client, acme, acme.employee_token, title="Second")
    _line(client, acme, second["id"], category["id"], token=acme.employee_token)
    client.post(f"/api/v1/expenses/{second['id']}/submit",
                headers=acme.headers(acme.employee_token))
    assert client.delete(
        f"/api/v1/expenses/{second['id']}", headers=acme.headers(acme.employee_token)
    ).status_code == 409


# --------------------------------------------------------------------------- #
# Approval
# --------------------------------------------------------------------------- #


def _submitted(client, tenant, *, amount=250000):
    category = _category(client, tenant)
    claim = _claim(client, tenant, tenant.employee_token)
    _line(client, tenant, claim["id"], category["id"], amount=amount,
          token=tenant.employee_token)
    return client.post(
        f"/api/v1/expenses/{claim['id']}/submit", headers=tenant.headers(tenant.employee_token)
    ).json()


def test_an_approver_approves_and_the_amount_is_captured(client, tenants):
    acme, _ = tenants
    claim = _submitted(client, acme, amount=250000)
    approved = client.post(
        f"/api/v1/expenses/{claim['id']}/review",
        json={"status": "approved"},
        headers=acme.headers(),
    ).json()
    assert approved["status"] == "approved"
    assert approved["approved_amount"] == 250000
    assert approved["reviewer_name"] == acme.owner.full_name


def test_a_rejection_needs_a_reason(client, tenants):
    acme, _ = tenants
    claim = _submitted(client, acme)
    blank = client.post(
        f"/api/v1/expenses/{claim['id']}/review",
        json={"status": "rejected", "review_note": "   "},
        headers=acme.headers(),
    )
    assert blank.status_code == 422
    assert blank.json()["detail"]["reason"] == "note_required"

    ok = client.post(
        f"/api/v1/expenses/{claim['id']}/review",
        json={"status": "rejected", "review_note": "No receipt for the hotel"},
        headers=acme.headers(),
    )
    assert ok.status_code == 200
    assert ok.json()["status"] == "rejected"


def test_nobody_approves_their_own_claim(client, tenants):
    """Not even an owner. Somebody else signs off your spending."""
    acme, _ = tenants
    category = _category(client, acme)
    claim = _claim(client, acme)  # owner's own claim
    _line(client, acme, claim["id"], category["id"])
    client.post(f"/api/v1/expenses/{claim['id']}/submit", headers=acme.headers())

    response = client.post(
        f"/api/v1/expenses/{claim['id']}/review",
        json={"status": "approved"},
        headers=acme.headers(),
    )
    assert response.status_code == 403
    assert response.json()["detail"]["reason"] == "self_review"


def test_an_employee_cannot_approve(client, tenants):
    acme, _ = tenants
    claim = _submitted(client, acme)
    response = client.post(
        f"/api/v1/expenses/{claim['id']}/review",
        json={"status": "approved"},
        headers=acme.headers(acme.employee_token),
    )
    assert response.status_code == 403


def test_a_decided_claim_cannot_be_decided_again(client, tenants):
    acme, _ = tenants
    claim = _submitted(client, acme)
    client.post(f"/api/v1/expenses/{claim['id']}/review",
                json={"status": "approved"}, headers=acme.headers())
    again = client.post(f"/api/v1/expenses/{claim['id']}/review",
                        json={"status": "rejected", "review_note": "changed my mind"},
                        headers=acme.headers())
    assert again.status_code == 409
    assert again.json()["detail"]["reason"] == "not_submitted"


def test_the_review_queue_excludes_your_own_and_stays_in_scope(client, tenants):
    acme, _ = tenants
    theirs = _submitted(client, acme)
    _, manager_token = _manager(acme)

    # The manager's own claim must not appear — deciding it always fails, so
    # showing it in the queue is an action that cannot succeed.
    category_id = client.get("/api/v1/expenses/categories",
                             headers=acme.headers()).json()[0]["id"]
    mine = _claim(client, acme, manager_token, title="Manager's own")
    _line(client, acme, mine["id"], category_id, token=manager_token)
    client.post(f"/api/v1/expenses/{mine['id']}/submit",
                headers=acme.headers(manager_token))

    queue = client.get("/api/v1/expenses/review",
                       headers=acme.headers(manager_token)).json()
    ids = {row["id"] for row in queue}
    assert theirs["id"] in ids
    assert mine["id"] not in ids


# --------------------------------------------------------------------------- #
# Reimbursement
# --------------------------------------------------------------------------- #


def test_approved_is_not_paid(client, tenants):
    """"Approved but unpaid" is the state every employee chases; it has to be
    representable rather than collapsed into approval."""
    acme, _ = tenants
    claim = _submitted(client, acme)
    approved = client.post(f"/api/v1/expenses/{claim['id']}/review",
                           json={"status": "approved"}, headers=acme.headers()).json()
    assert approved["reimbursed_at"] is None

    queue = client.get("/api/v1/expenses/payments", headers=acme.headers()).json()
    assert [row["id"] for row in queue] == [claim["id"]]

    paid = client.post(
        f"/api/v1/expenses/{claim['id']}/reimburse",
        json={"payment_reference": "UTR123456"},
        headers=acme.headers(),
    ).json()
    assert paid["status"] == "reimbursed"
    assert paid["payment_reference"] == "UTR123456"
    assert client.get("/api/v1/expenses/payments", headers=acme.headers()).json() == []


def test_an_unapproved_claim_cannot_be_paid(client, tenants):
    acme, _ = tenants
    claim = _submitted(client, acme)
    response = client.post(
        f"/api/v1/expenses/{claim['id']}/reimburse", json={}, headers=acme.headers()
    )
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "not_approved"


def test_a_manager_may_approve_but_not_pay(client, tenants):
    """Segregation: approving your team's spend and recording it as paid are
    different jobs."""
    acme, _ = tenants
    claim = _submitted(client, acme)
    _, manager_token = _manager(acme)

    assert client.post(
        f"/api/v1/expenses/{claim['id']}/review", json={"status": "approved"},
        headers=acme.headers(manager_token),
    ).status_code == 200
    response = client.post(f"/api/v1/expenses/{claim['id']}/reimburse", json={},
                           headers=acme.headers(manager_token))
    assert response.status_code == 403
    assert response.json()["detail"]["reason"] == "not_permitted"


def test_the_reimburse_flag_restricts_an_owner(client, tenants):
    acme, _ = tenants
    claim = _submitted(client, acme)
    client.post(f"/api/v1/expenses/{claim['id']}/review",
                json={"status": "approved"}, headers=acme.headers())
    with SessionLocal() as db:
        db.get(User, acme.owner.id).can_reimburse_expenses = False
        db.commit()
    assert client.post(f"/api/v1/expenses/{claim['id']}/reimburse", json={},
                       headers=acme.headers()).status_code == 403


def test_a_paid_claim_cannot_be_cancelled(client, tenants):
    """The money has moved; the correction for that is a recovery, not an edit."""
    acme, _ = tenants
    claim = _submitted(client, acme)
    client.post(f"/api/v1/expenses/{claim['id']}/review",
                json={"status": "approved"}, headers=acme.headers())
    client.post(f"/api/v1/expenses/{claim['id']}/reimburse", json={},
                headers=acme.headers())
    response = client.post(f"/api/v1/expenses/{claim['id']}/cancel",
                           headers=acme.headers(acme.employee_token))
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "not_cancellable"


# --------------------------------------------------------------------------- #
# Visibility
# --------------------------------------------------------------------------- #


def test_an_employee_sees_only_their_own_claims(client, tenants):
    acme, _ = tenants
    category = _category(client, acme)
    owners = _claim(client, acme, title="Owner's claim")
    _line(client, acme, owners["id"], category["id"])
    mine = _claim(client, acme, acme.employee_token, title="Mine")

    rows = client.get("/api/v1/expenses", headers=acme.headers(acme.employee_token)).json()
    assert [row["id"] for row in rows] == [mine["id"]]
    assert client.get(
        f"/api/v1/expenses/{owners['id']}", headers=acme.headers(acme.employee_token)
    ).status_code == 403


def test_a_manager_sees_their_reports_claims(client, tenants):
    acme, _ = tenants
    claim = _submitted(client, acme)
    _, manager_token = _manager(acme)
    rows = client.get("/api/v1/expenses", headers=acme.headers(manager_token)).json()
    assert claim["id"] in {row["id"] for row in rows}


def test_claims_do_not_cross_tenants(client, tenants):
    acme, globex = tenants
    claim = _submitted(client, acme)
    assert client.get(
        f"/api/v1/expenses/{claim['id']}", headers=globex.headers()
    ).status_code == 404
    assert client.get("/api/v1/expenses", headers=globex.headers()).json() == []


def test_filing_on_behalf_records_both_people(client, tenants):
    acme, _ = tenants
    claim = client.post(
        "/api/v1/expenses",
        json={"title": "Filed by HR", "user_id": str(acme.employee.id)},
        headers=acme.headers(),
    ).json()
    assert claim["user_id"] == str(acme.employee.id)
    assert claim["created_by_name"] == acme.owner.full_name


def test_an_employee_cannot_file_for_a_colleague(client, tenants):
    acme, _ = tenants
    response = client.post(
        "/api/v1/expenses",
        json={"title": "Not mine", "user_id": str(acme.owner.id)},
        headers=acme.headers(acme.employee_token),
    )
    assert response.status_code == 403


# --------------------------------------------------------------------------- #
# Summary and gating
# --------------------------------------------------------------------------- #


def test_the_summary_reports_what_is_owed(client, tenants):
    acme, _ = tenants
    claim = _submitted(client, acme, amount=125000)
    client.post(f"/api/v1/expenses/{claim['id']}/review",
                json={"status": "approved"}, headers=acme.headers())

    body = client.get("/api/v1/expenses/summary", headers=acme.headers()).json()
    assert body["outstanding_amount"] == 125000
    assert body["outstanding_count"] == 1
    assert body["awaiting_review"] == 0


def test_capability_flags_arrive_resolved_on_the_claim(client, tenants):
    """The console renders from these rather than re-deriving the rule."""
    acme, _ = tenants
    claim = _submitted(client, acme)

    as_employee = client.get(
        f"/api/v1/expenses/{claim['id']}", headers=acme.headers(acme.employee_token)
    ).json()
    assert as_employee["can_edit"] is False
    assert as_employee["can_review"] is False
    assert as_employee["can_cancel"] is True

    as_owner = client.get(
        f"/api/v1/expenses/{claim['id']}", headers=acme.headers()
    ).json()
    assert as_owner["can_review"] is True
    assert as_owner["can_reimburse"] is False  # not approved yet


def test_expenses_are_gated_like_every_other_module(client, tenants, platform_token):
    acme, _ = tenants
    client.put(
        f"/api/v1/platform/companies/{acme.id}/modules",
        json={"grants": [{"key": "expenses", "enabled": False}]},
        headers={"Authorization": f"Bearer {platform_token}"},
    )
    response = client.get("/api/v1/expenses", headers=acme.headers())
    assert response.status_code == 402
    assert response.json()["detail"]["module"] == "expenses"
