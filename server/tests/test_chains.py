"""Multi-level approval chains.

The most important test in this file is the boring one:
``test_no_configured_chain_behaves_exactly_as_before``. Seven flows and 1,400
tests depend on single-level approval still working untouched, and chains are
opt-in precisely so that stays true. Everything else here is the new behaviour.

What these defend:

1. **No chain means no change.** No step rows, no extra state, the original
   permission rules.
2. **An intermediate approval does not approve anything.** The record stays
   pending and — the expensive one — the side effect does not run. Debiting a
   leave balance at level one of three spends it against a decision nobody has
   finished making.
3. **A rejection at any level is terminal.** A chain that loops back on
   rejection is one where nobody can say whether a request was refused or is
   still going.
4. **A level that resolves to nobody is unassigned, not skipped.** Skipping it
   approves through a gate that was supposed to exist.
5. **Editing the configuration does not rewrite a chain in flight.**
6. Two tenants, always.
"""

from __future__ import annotations

import uuid as _uuid
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select

from app.core.security import create_access_token, generate_enrollment_key, hash_password
from app.db.session import SessionLocal
from app.models import Department, User
from app.models.workflowlevels import StepStatus, WorkflowStep


def _person(tenant, name, *, manager_id=None, **flags):
    with SessionLocal() as db:
        row = User(
            id=_uuid.uuid4(), org_id=tenant.id,
            email=f"{name.lower()}-{_uuid.uuid4().hex[:5]}@{tenant.slug}.test",
            full_name=name, role="manager",
            password_hash=hash_password("correct-horse-battery"),
            is_active=True, enrollment_key=generate_enrollment_key(),
            manager_id=manager_id, **flags,
        )
        db.add(row)
        db.commit()
        return row.id, create_access_token(
            str(row.id), {"typ": "user", "org": str(tenant.id), "role": "manager"})


def _reports_to(tenant, manager_id):
    with SessionLocal() as db:
        db.get(User, tenant.employee.id).manager_id = manager_id
        db.commit()


def _chain(client, tenant, kind, levels, department_id=None):
    params = {"department_id": str(department_id)} if department_id else {}
    response = client.put(f"/api/v1/workflow/levels/{kind}", json={"levels": levels},
                          params=params, headers=tenant.headers())
    assert response.status_code == 200, response.text
    return response.json()


def _category(client, tenant):
    return client.post("/api/v1/expenses/categories",
                       json={"name": "Travel", "requires_receipt": False},
                       headers=tenant.headers()).json()


def _claim(client, tenant, *, amount=250000, token=None):
    category = _category(client, tenant)
    claim = client.post("/api/v1/expenses", json={"title": "Client visit"},
                        headers=tenant.headers(token or tenant.employee_token)).json()
    client.post(f"/api/v1/expenses/{claim['id']}/lines",
                json={"category_id": category["id"], "spent_on": date.today().isoformat(),
                      "amount": amount, "description": "Flight"},
                headers=tenant.headers(token or tenant.employee_token))
    submitted = client.post(f"/api/v1/expenses/{claim['id']}/submit", json={},
                            headers=tenant.headers(token or tenant.employee_token))
    assert submitted.status_code == 200, submitted.text
    return claim


def _review(client, tenant, claim_id, token, *, approve=True, note="ok"):
    return client.post(f"/api/v1/expenses/{claim_id}/review",
                       json={"status": "approved" if approve else "rejected",
                             "review_note": note},
                       headers=tenant.headers(token))


def _steps(record_id):
    with SessionLocal() as db:
        return list(db.scalars(
            select(WorkflowStep)
            .where(WorkflowStep.record_id == _uuid.UUID(record_id))
            .order_by(WorkflowStep.level)))


# --------------------------------------------------------------------------- #
# The guarantee everything else rests on
# --------------------------------------------------------------------------- #


def test_no_configured_chain_behaves_exactly_as_before(client, tenants):
    """The most important test here. Seven flows and 1,400 tests depend on
    single-level approval still working untouched, and chains are opt-in
    precisely so that stays true."""
    acme, _ = tenants
    claim = _claim(client, acme)

    assert _steps(claim["id"]) == [], "a chainless flow must write no steps"

    decided = _review(client, acme, claim["id"], acme.owner_token)
    assert decided.status_code == 200, decided.text
    assert decided.json()["status"] == "approved"


def test_an_empty_chain_removes_routing(client, tenants):
    """Setting a chain and then clearing it must return the flow to exactly
    where it started, not to a broken half-state."""
    acme, _ = tenants
    manager_id, _token = _person(acme, "Manager")
    _reports_to(acme, manager_id)
    _chain(client, acme, "expense", [{"reviewer_rule": "reporting_manager"}])
    _chain(client, acme, "expense", [])

    claim = _claim(client, acme)
    assert _steps(claim["id"]) == []
    assert _review(client, acme, claim["id"], acme.owner_token).status_code == 200


# --------------------------------------------------------------------------- #
# Walking a chain
# --------------------------------------------------------------------------- #


def test_an_intermediate_approval_leaves_the_record_pending(client, tenants):
    """It has not been approved — it has been approved *by one person*."""
    acme, _ = tenants
    manager_id, manager_token = _person(acme, "Manager", can_approve_expenses=True)
    finance_id, finance_token = _person(acme, "Finance", can_approve_expenses=True)
    _reports_to(acme, manager_id)
    _chain(client, acme, "expense", [
        {"reviewer_rule": "reporting_manager"},
        {"reviewer_rule": "named_user", "reviewer_user_id": str(finance_id)},
    ])
    claim = _claim(client, acme)

    first = _review(client, acme, claim["id"], manager_token)
    assert first.status_code == 200, first.text
    # Still submitted. The chain moved; the claim did not.
    assert first.json()["status"] == "submitted"

    steps = _steps(claim["id"])
    assert [s.status for s in steps] == [StepStatus.APPROVED.value, StepStatus.PENDING.value]

    second = _review(client, acme, claim["id"], finance_token)
    assert second.status_code == 200, second.text
    assert second.json()["status"] == "approved"


def test_the_side_effect_runs_only_on_the_final_approval(client, tenants):
    """The expensive one. `approved_amount` is the figure signed off, written by
    the flow's own `on_approve`; if the kernel ran that at level one, a claim
    half-way through a chain would carry a signed-off figure nobody signed."""
    acme, _ = tenants
    manager_id, manager_token = _person(acme, "Manager", can_approve_expenses=True)
    finance_id, finance_token = _person(acme, "Finance", can_approve_expenses=True)
    _reports_to(acme, manager_id)
    _chain(client, acme, "expense", [
        {"reviewer_rule": "reporting_manager"},
        {"reviewer_rule": "named_user", "reviewer_user_id": str(finance_id)},
    ])
    claim = _claim(client, acme)

    _review(client, acme, claim["id"], manager_token)
    mid = client.get(f"/api/v1/expenses/{claim['id']}", headers=acme.headers()).json()
    assert mid["approved_amount"] is None, "signed off before anybody finished deciding"

    _review(client, acme, claim["id"], finance_token)
    done = client.get(f"/api/v1/expenses/{claim['id']}", headers=acme.headers()).json()
    assert done["approved_amount"] == 250000


def test_a_later_reviewer_out_of_scope_is_refused_by_the_module_first(client, tenants):
    """Two gates, and the order is deliberate. `is_current_reviewer` widens
    visibility only for the rung a record is *waiting on*, so somebody standing
    at level 2 is still out of scope by the expenses module's own rule and never
    reaches the chain's own refusal. The narrower gate answering first is the
    correct layering — the chain grants access, it does not bypass anything."""
    acme, _ = tenants
    manager_id, _mt = _person(acme, "Manager", can_approve_expenses=True)
    finance_id, finance_token = _person(acme, "Finance", can_approve_expenses=True)
    _reports_to(acme, manager_id)
    _chain(client, acme, "expense", [
        {"reviewer_rule": "named_user", "reviewer_user_id": str(manager_id)},
        {"reviewer_rule": "named_user", "reviewer_user_id": str(finance_id)},
    ])
    claim = _claim(client, acme)

    early = _review(client, acme, claim["id"], finance_token)
    assert early.status_code == 403
    assert early.json()["detail"]["reason"] == "out_of_scope"


def test_somebody_in_scope_at_the_wrong_rung_is_refused_by_the_chain(client, tenants):
    """The chain's own refusal, reached once the module's scope rule has passed.
    The manager can see their report's claim by line management alone, so the
    only thing left to stop them acting is the chain saying it is not their
    turn."""
    acme, _ = tenants
    manager_id, manager_token = _person(acme, "Manager", can_approve_expenses=True)
    finance_id, _ft = _person(acme, "Finance", can_approve_expenses=True)
    _reports_to(acme, manager_id)
    # Finance first, the manager second — so the manager is in scope but early.
    _chain(client, acme, "expense", [
        {"reviewer_rule": "named_user", "reviewer_user_id": str(finance_id)},
        {"reviewer_rule": "reporting_manager"},
    ])
    claim = _claim(client, acme)

    early = _review(client, acme, claim["id"], manager_token)
    assert early.status_code == 403
    assert early.json()["detail"]["reason"] == "not_your_step"
    assert "level 1 of 2" in early.json()["detail"]["message"]


def test_a_rejection_at_any_level_is_terminal(client, tenants):
    """A chain that loops back on rejection is one where nobody can say whether
    a request was refused or is still going."""
    acme, _ = tenants
    manager_id, manager_token = _person(acme, "Manager", can_approve_expenses=True)
    finance_id, _ = _person(acme, "Finance", can_approve_expenses=True)
    _reports_to(acme, manager_id)
    _chain(client, acme, "expense", [
        {"reviewer_rule": "reporting_manager"},
        {"reviewer_rule": "named_user", "reviewer_user_id": str(finance_id)},
    ])
    claim = _claim(client, acme)

    refused = _review(client, acme, claim["id"], manager_token, approve=False,
                      note="Not this quarter")
    assert refused.status_code == 200
    assert refused.json()["status"] == "rejected"

    steps = _steps(claim["id"])
    assert steps[0].status == StepStatus.REJECTED.value
    # The second rung never starts. It is not pending-forever, it simply never
    # began — `started_at` is the evidence.
    assert steps[1].started_at is None


def test_an_owner_can_unstick_a_chain(client, tenants):
    """A chain whose named reviewer has left would otherwise deadlock with no
    way out except editing the database. The audit row records who actually
    acted, so this is visible rather than indistinguishable from the level
    working."""
    acme, _ = tenants
    ghost_id, _ = _person(acme, "Ghost", can_approve_expenses=True)
    _chain(client, acme, "expense", [
        {"reviewer_rule": "named_user", "reviewer_user_id": str(ghost_id)},
    ])
    claim = _claim(client, acme)

    assert _review(client, acme, claim["id"], acme.owner_token).status_code == 200


# --------------------------------------------------------------------------- #
# Resolution
# --------------------------------------------------------------------------- #


def test_a_level_that_resolves_to_nobody_is_unassigned_not_skipped(client, tenants):
    """Skipping it would approve through a gate that was supposed to exist."""
    acme, _ = tenants
    # The employee reports to nobody, so `reporting_manager` finds no one.
    _chain(client, acme, "expense", [{"reviewer_rule": "reporting_manager"}])
    claim = _claim(client, acme)

    steps = _steps(claim["id"])
    assert len(steps) == 1
    assert steps[0].reviewer_user_id is None
    assert steps[0].status == StepStatus.PENDING.value, "an unresolved level still gates"


def test_a_level_resolving_to_the_requester_is_skipped(client, tenants):
    """Common at the top of a tree, where the department head's own claim routes
    to the department head. Asking somebody to approve their own request is not
    a gate, and the kernel would refuse it anyway."""
    acme, _ = tenants
    with SessionLocal() as db:
        department = Department(
            id=_uuid.uuid4(), org_id=acme.id, name="Engineering",
            head_user_id=acme.employee.id,
        )
        db.add(department)
        db.get(User, acme.employee.id).department_id = department.id
        db.commit()

    _chain(client, acme, "expense", [{"reviewer_rule": "department_head"}])
    claim = _claim(client, acme)

    steps = _steps(claim["id"])
    assert steps[0].status == StepStatus.SKIPPED.value
    assert "requester" in (steps[0].note or "")


def test_a_department_chain_replaces_the_company_one(client, tenants):
    """Not extends. A chain half inherited and half local is one nobody can read
    off the screen."""
    acme, _ = tenants
    with SessionLocal() as db:
        department = Department(id=_uuid.uuid4(), org_id=acme.id, name="Sales")
        db.add(department)
        db.commit()
        department_id = department.id

    _chain(client, acme, "expense", [
        {"reviewer_rule": "reporting_manager"},
        {"reviewer_rule": "reporting_manager"},
        {"reviewer_rule": "reporting_manager"},
    ])
    _chain(client, acme, "expense", [{"reviewer_rule": "reporting_manager"}],
           department_id=department_id)

    effective = client.get("/api/v1/workflow/levels/expense/effective",
                           params={"department_id": str(department_id)},
                           headers=acme.headers()).json()
    assert len(effective) == 1, "the department chain replaces, not extends"

    company = client.get("/api/v1/workflow/levels/expense/effective",
                         headers=acme.headers()).json()
    assert len(company) == 3


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #


def test_editing_the_config_does_not_rewrite_a_chain_in_flight(client, tenants):
    """The split between configuration and history, which is the whole design.
    A step somebody approved last Tuesday silently becoming a different step is
    the failure the two tables exist to prevent."""
    acme, _ = tenants
    manager_id, manager_token = _person(acme, "Manager", can_approve_expenses=True)
    _reports_to(acme, manager_id)
    _chain(client, acme, "expense", [{"reviewer_rule": "reporting_manager"}])
    claim = _claim(client, acme)
    assert len(_steps(claim["id"])) == 1

    # Three levels now — but not for this claim.
    _chain(client, acme, "expense", [
        {"reviewer_rule": "reporting_manager"},
        {"reviewer_rule": "reporting_manager"},
        {"reviewer_rule": "reporting_manager"},
    ])
    assert len(_steps(claim["id"])) == 1, "an in-flight chain was rewritten"
    assert _review(client, acme, claim["id"], manager_token).json()["status"] == "approved"


def test_a_chain_longer_than_five_levels_is_refused(client, tenants):
    acme, _ = tenants
    response = client.put("/api/v1/workflow/levels/expense",
                          json={"levels": [{"reviewer_rule": "reporting_manager"}] * 6},
                          headers=acme.headers())
    # Refused by the schema's own bound before the service is reached, which is
    # the cheaper of the two gates. The service keeps its check for callers that
    # are not this router.
    assert response.status_code == 422


def test_escalation_needs_somewhere_to_escalate_to(client, tenants):
    acme, _ = tenants
    response = client.put(
        "/api/v1/workflow/levels/expense",
        json={"levels": [{"reviewer_rule": "reporting_manager",
                          "escalate_after_days": 3}]},
        headers=acme.headers())
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "escalation_point_required"


def test_only_decidable_flows_offer_a_chain(client, tenants):
    """Read from the kernel's policy table, so a flow it cannot drive never
    offers a chain nobody could walk."""
    acme, _ = tenants
    kinds = client.get("/api/v1/workflow/kinds", headers=acme.headers()).json()
    assert "expense" in kinds and "leave" in kinds
    assert "settlement" not in kinds


def test_another_tenants_chain_is_invisible(client, tenants):
    acme, globex = tenants
    _chain(client, globex, "expense", [{"reviewer_rule": "reporting_manager"}])
    assert client.get("/api/v1/workflow/levels/expense",
                      headers=acme.headers()).json() == []


# --------------------------------------------------------------------------- #
# The sweep
# --------------------------------------------------------------------------- #


def _age_step(record_id, days):
    with SessionLocal() as db:
        step = db.scalar(select(WorkflowStep).where(
            WorkflowStep.record_id == _uuid.UUID(record_id),
            WorkflowStep.status == StepStatus.PENDING.value))
        step.started_at = datetime.now(timezone.utc) - timedelta(days=days)
        db.commit()


def test_a_stale_level_escalates_to_its_escalation_point(client, tenants):
    """Reassigned, not closed: the rung still needs deciding, by somebody else.
    Marking it done and moving on would approve through a gate nobody passed."""
    acme, _ = tenants
    manager_id, _ = _person(acme, "Manager", can_approve_expenses=True)
    boss_id, boss_token = _person(acme, "Boss", can_approve_expenses=True)
    _reports_to(acme, manager_id)
    _chain(client, acme, "expense", [
        {"reviewer_rule": "reporting_manager", "escalate_after_days": 3,
         "escalate_to_user_id": str(boss_id)},
    ])
    claim = _claim(client, acme)
    _age_step(claim["id"], 4)

    swept = client.post("/api/v1/workflow/sweep", headers=acme.headers()).json()
    assert swept["escalated"] == 1

    steps = _steps(claim["id"])
    assert steps[0].status == StepStatus.PENDING.value, "still needs deciding"
    assert steps[0].reviewer_user_id == boss_id
    assert _review(client, acme, claim["id"], boss_token).status_code == 200


def test_auto_forward_moves_to_the_next_level(client, tenants):
    acme, _ = tenants
    manager_id, _ = _person(acme, "Manager", can_approve_expenses=True)
    finance_id, finance_token = _person(acme, "Finance", can_approve_expenses=True)
    _reports_to(acme, manager_id)
    _chain(client, acme, "expense", [
        {"reviewer_rule": "reporting_manager", "auto_forward_days": 2},
        {"reviewer_rule": "named_user", "reviewer_user_id": str(finance_id)},
    ])
    claim = _claim(client, acme)
    _age_step(claim["id"], 3)

    swept = client.post("/api/v1/workflow/sweep", headers=acme.headers()).json()
    assert swept["auto_forwarded"] == 1

    steps = _steps(claim["id"])
    assert steps[0].status == StepStatus.ESCALATED.value
    assert steps[1].started_at is not None
    assert _review(client, acme, claim["id"], finance_token).json()["status"] == "approved"


def test_a_fresh_level_is_left_alone(client, tenants):
    acme, _ = tenants
    manager_id, _ = _person(acme, "Manager", can_approve_expenses=True)
    _reports_to(acme, manager_id)
    _chain(client, acme, "expense", [
        {"reviewer_rule": "reporting_manager", "auto_forward_days": 5},
    ])
    _claim(client, acme)

    swept = client.post("/api/v1/workflow/sweep", headers=acme.headers()).json()
    assert swept == {"escalated": 0, "auto_forwarded": 0}


# --------------------------------------------------------------------------- #
# Reading a record's journey
# --------------------------------------------------------------------------- #


def test_the_requester_can_see_where_their_claim_has_got_to(client, tenants):
    """The question the whole feature exists to answer. A step row carries who
    reviewed and when and nothing else, so there is nothing here to gate."""
    acme, _ = tenants
    manager_id, manager_token = _person(acme, "Manager", can_approve_expenses=True)
    finance_id, _ = _person(acme, "Finance", can_approve_expenses=True)
    _reports_to(acme, manager_id)
    _chain(client, acme, "expense", [
        {"reviewer_rule": "reporting_manager"},
        {"reviewer_rule": "named_user", "reviewer_user_id": str(finance_id)},
    ])
    claim = _claim(client, acme)
    _review(client, acme, claim["id"], manager_token)

    seen = client.get(f"/api/v1/workflow/records/{claim['id']}",
                      headers=acme.headers(acme.employee_token)).json()
    assert seen["total"] == 2
    assert seen["current_level"] == 2
    assert seen["steps"][0]["status"] == "approved"
    assert seen["steps"][0]["acted_by_name"] == "Manager"
    assert seen["steps"][1]["reviewer_name"] == "Finance"


# --------------------------------------------------------------------------- #
# The regression this work uncovered
# --------------------------------------------------------------------------- #


def test_a_leave_type_needing_no_approval_still_works(client, tenants):
    """Not a chain test. The workflow refactor deleted `leave._approve` while
    leaving its one caller — the auto-approve path for a declaration-style leave
    type — pointing at a name that no longer existed. Nothing covered it, so
    1,400 passing tests said nothing about a `NameError` waiting for the first
    company that runs sick leave as a declaration."""
    acme, _ = tenants
    leave_type = client.post(
        "/api/v1/leave/types",
        json={"name": "Sick Leave", "code": "SL", "accrual_type": "none",
              "requires_approval": False},
        headers=acme.headers()).json()
    client.post("/api/v1/leave/balances/adjust",
                json={"user_id": str(acme.employee.id),
                      "leave_type_id": leave_type["id"], "year": date.today().year,
                      "delta_milli_days": 5000, "reason": "opening balance"},
                headers=acme.headers())

    # Pushed to the next Monday: the range validator refuses a span that is
    # entirely weekly-offs, and "five days from now" is a weekend two times in
    # seven.
    ahead = date.today() + timedelta(days=5)
    ahead += timedelta(days=(7 - ahead.weekday()) % 7)
    start = ahead.isoformat()
    applied = client.post(
        "/api/v1/leave/applications",
        json={"leave_type_id": leave_type["id"], "start_date": start,
              "end_date": start, "reason": "unwell"},
        headers=acme.headers(acme.employee_token))
    assert applied.status_code in (200, 201), applied.text
    assert applied.json()["status"] == "approved"
