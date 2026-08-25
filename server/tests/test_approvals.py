"""The unified approvals queue.

The queue reads across five modules, which makes it the most likely place in
this system for a permission to be accidentally widened: it would be easy to
write one that answers "everything pending in this company" and calls it a
manager's queue. So the tests that matter here are the negative ones.

What these defend:

1. **Each flow's own rule decides what it contributes.** A viewer who may not
   approve expense claims sees no expense claims — and still sees their leave
   queue, rather than getting a 403 that kills everything.
2. **Nothing crosses a tenant boundary.**
3. **Un-actionable rows stay out.** An item you could not decide if you clicked
   it is worse than an absent one: it is a button that always fails.
4. **The counts and the queue cannot disagree**, because they run the same
   adapters.
5. **An ordinary employee's queue is empty**, not forbidden. That distinction is
   what lets the console show the page to everybody.
"""

from __future__ import annotations

import uuid as _uuid
from datetime import date, timedelta

from app.core.security import create_access_token, generate_enrollment_key, hash_password
from app.db.session import SessionLocal
from app.models import User


def _manager(tenant, **flags):
    """A real manager with the tenant's employee reporting to them.

    Flags default to False here — the opposite of the User model's default —
    because every test below is about what a *particular* permission does, and a
    fixture that granted everything would make all of them pass.
    """
    permissions = {
        "can_approve_leave": False,
        "can_approve_timesheets": False,
        "can_approve_regularization": False,
        "can_approve_expenses": False,
        "can_approve_loans": False,
    }
    permissions.update(flags)
    with SessionLocal() as db:
        manager = User(
            id=_uuid.uuid4(), org_id=tenant.id,
            email=f"mgr-{_uuid.uuid4().hex[:6]}@{tenant.slug}.test",
            full_name="Team Manager", role="manager",
            password_hash=hash_password("correct-horse-battery"),
            is_active=True, enrollment_key=generate_enrollment_key(),
            **permissions,
        )
        db.add(manager)
        db.flush()
        db.get(User, tenant.employee.id).manager_id = manager.id
        db.commit()
        return manager.id, create_access_token(
            str(manager.id), {"typ": "user", "org": str(tenant.id), "role": "manager"})


def _leave_request(client, tenant):
    leave_type = client.post(
        "/api/v1/leave/types",
        json={"name": "Earned Leave", "code": "EL", "accrual_type": "none"},
        headers=tenant.headers()).json()
    client.post(
        "/api/v1/leave/balances/adjust",
        json={"user_id": str(tenant.employee.id), "leave_type_id": leave_type["id"],
              "year": date.today().year, "delta_milli_days": 5000,
              "reason": "opening balance"},
        headers=tenant.headers())
    start = date.today() + timedelta(days=7)
    return client.post(
        "/api/v1/leave/applications",
        json={"leave_type_id": leave_type["id"], "start_date": start.isoformat(),
              "end_date": start.isoformat(), "reason": "personal"},
        headers=tenant.headers(tenant.employee_token)).json()


def _expense_claim(client, tenant, *, amount=250000):
    category = client.post(
        "/api/v1/expenses/categories",
        json={"name": "Travel", "requires_receipt": False},
        headers=tenant.headers())
    assert category.status_code == 201, category.text
    claim = client.post(
        "/api/v1/expenses", json={"title": "Client visit"},
        headers=tenant.headers(tenant.employee_token))
    assert claim.status_code == 201, claim.text
    claim = claim.json()
    line = client.post(
        f"/api/v1/expenses/{claim['id']}/lines",
        json={"category_id": category.json()["id"],
              "spent_on": date.today().isoformat(),
              "amount": amount, "description": "Flight"},
        headers=tenant.headers(tenant.employee_token))
    assert line.status_code in (200, 201), line.text
    submitted = client.post(f"/api/v1/expenses/{claim['id']}/submit", json={},
                            headers=tenant.headers(tenant.employee_token))
    assert submitted.status_code == 200, submitted.text
    return claim


def _queue(client, tenant, token):
    response = client.get("/api/v1/approvals", headers=tenant.headers(token))
    assert response.status_code == 200, response.text
    return response.json()


# --------------------------------------------------------------------------- #
# What a viewer may see
# --------------------------------------------------------------------------- #


def test_an_ordinary_employee_gets_an_empty_queue_not_a_refusal(client, tenants):
    """Empty and forbidden are different, and the difference is what lets the
    console put this page in everybody's navigation."""
    acme, _ = tenants
    _leave_request(client, acme)

    response = client.get("/api/v1/approvals",
                          headers=acme.headers(acme.employee_token))
    assert response.status_code == 200
    assert response.json() == []


def test_a_flow_a_viewer_cannot_approve_contributes_nothing(client, tenants):
    """The safety argument. A manager with the leave permission and not the
    expense one gets their leave queue and no sight of anybody's spending."""
    acme, _ = tenants
    _leave_request(client, acme)
    _expense_claim(client, acme)
    _, token = _manager(acme, can_approve_leave=True)

    kinds = {item["kind"] for item in _queue(client, acme, token)}
    assert kinds == {"leave"}


def test_one_flow_refusing_does_not_kill_the_whole_queue(client, tenants):
    """A queue that 403s because one of five sources says no is a queue nobody
    can use. The expenses adapter swallows that flow's own refusal — and only
    that one."""
    acme, _ = tenants
    _leave_request(client, acme)
    _expense_claim(client, acme)
    _, token = _manager(acme, can_approve_leave=True, can_approve_expenses=True)

    kinds = {item["kind"] for item in _queue(client, acme, token)}
    assert kinds == {"leave", "expense"}


def test_the_queue_never_crosses_a_tenant_boundary(client, tenants):
    acme, globex = tenants
    _leave_request(client, globex)
    _, token = _manager(acme, can_approve_leave=True)

    assert _queue(client, acme, token) == []


def test_an_owner_sees_what_they_may_decide(client, tenants):
    acme, _ = tenants
    _leave_request(client, acme)
    _expense_claim(client, acme)

    items = _queue(client, acme, acme.owner_token)
    assert {item["kind"] for item in items} >= {"leave", "expense"}


# --------------------------------------------------------------------------- #
# What the rows say
# --------------------------------------------------------------------------- #


def test_an_amount_is_null_where_the_flow_has_no_money(client, tenants):
    """Rendering a leave request as ₹0.00 would be a lie, and a client that had
    to guess which kinds carry money would eventually guess wrong."""
    acme, _ = tenants
    _leave_request(client, acme)
    _expense_claim(client, acme)

    by_kind = {item["kind"]: item for item in _queue(client, acme, acme.owner_token)}
    assert by_kind["leave"]["amount_paise"] is None
    assert by_kind["expense"]["amount_paise"] == 250000


def test_every_row_names_the_person_and_says_how_long_it_has_waited(client, tenants):
    acme, _ = tenants
    _leave_request(client, acme)

    item = _queue(client, acme, acme.owner_token)[0]
    assert item["user_name"] == acme.employee.full_name
    assert item["title"]
    assert item["waiting_days"] >= 0
    assert item["since"]


def test_the_queue_is_oldest_first(client, tenants):
    """A queue sorted newest-first buries the request somebody has been waiting
    a fortnight on — and here it competes with five flows for attention, not
    one."""
    acme, _ = tenants
    _leave_request(client, acme)
    _expense_claim(client, acme)

    items = _queue(client, acme, acme.owner_token)
    assert items == sorted(items, key=lambda i: (i["since"], i["kind"]))


# --------------------------------------------------------------------------- #
# Counts
# --------------------------------------------------------------------------- #


def test_the_counts_agree_with_the_queue(client, tenants):
    """They run the same adapters, so they cannot disagree — and this is the
    test that keeps it that way when somebody optimises one of them."""
    acme, _ = tenants
    _leave_request(client, acme)
    _expense_claim(client, acme)

    items = _queue(client, acme, acme.owner_token)
    counts = client.get("/api/v1/approvals/counts",
                        headers=acme.headers()).json()

    assert counts["total"] == len(items)
    for kind in ("leave", "expense", "loan", "timesheet", "regularization"):
        assert counts[kind] == len([i for i in items if i["kind"] == kind]), kind


def test_counts_are_zero_for_somebody_who_approves_nothing(client, tenants):
    acme, _ = tenants
    _leave_request(client, acme)

    counts = client.get("/api/v1/approvals/counts",
                        headers=acme.headers(acme.employee_token)).json()
    assert counts["total"] == 0
