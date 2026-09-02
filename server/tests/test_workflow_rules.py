"""Conditional approval routing: a condition, and the chain it selects.

The tests are weighted at the four ways a rule engine is worse than no rule
engine:

1. **It routes the wrong way.** A ₹9,00,000 claim taking the chain written for
   small ones is the failure this feature exists to prevent, so most of these
   tests are "does the right rule win".
2. **It throws.** An unanswerable condition must not take down the submit
   button — a rule referring to a field this flow does not have, an operator
   nobody implemented, a record that was not passed. Every one of those has to
   resolve to *not matched*.
3. **It matches when it cannot decide.** The other direction of the same
   failure, and the more dangerous one: matching on error routes a large claim
   through whichever chain happened to be first.
4. **It rewrites history.** Editing a rule must not change who approves a
   request already in flight.

And one that is not about rules at all: a company that writes none must route
exactly as it did before this existed.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

import pytest

from app.db.session import SessionLocal
from app.models import Department, User, WorkflowLevel, WorkflowRule
from app.services import chains as svc


@pytest.fixture
def acme(tenants):
    return tenants[0]


@pytest.fixture
def globex(tenants):
    return tenants[1]


def _rule(name, *, conditions=None, levels=None, fallback=False, priority=None):
    return {
        "name": name,
        "priority": priority,
        "conditions": conditions or [],
        # `is None`, not `or`: an explicitly empty chain is the point of one
        # of these tests, and `or` would quietly replace it with the default.
        "levels": [{"reviewer_rule": "reporting_manager"}] if levels is None else levels,
        "is_fallback": fallback,
        "is_active": True,
    }


def _save(client, tenant, kind, rules):
    response = client.put(
        f"/api/v1/workflow/rules/{kind}", json={"rules": rules}, headers=tenant.headers()
    )
    assert response.status_code == 200, response.text
    return response.json()


def _preview(client, tenant, kind, values, subject=None):
    body = {"values": values}
    if subject:
        body["subject_user_id"] = str(subject)
    response = client.post(
        f"/api/v1/workflow/rules/{kind}/preview", json=body, headers=tenant.headers()
    )
    assert response.status_code == 200, response.text
    return response.json()


class Record:
    """A stand-in for the thing being approved."""

    def __init__(self, **fields):
        for key, value in fields.items():
            setattr(self, key, value)

    def __getattr__(self, _name):
        return None


# --------------------------------------------------------------------------- #
# The vocabulary
# --------------------------------------------------------------------------- #


def test_each_flow_offers_the_fields_it_actually_has(client, acme):
    expense = client.get("/api/v1/workflow/vocabulary/expense", headers=acme.headers()).json()
    keys = {f["key"] for f in expense["fields"]}
    assert {"amount", "category", "project"} <= keys
    # Every flow can route on who is asking, even when it has no fields of
    # its own.
    assert {"department", "team", "designation", "role"} <= keys

    leave = client.get("/api/v1/workflow/vocabulary/leave", headers=acme.headers()).json()
    leave_keys = {f["key"] for f in leave["fields"]}
    assert {"leave_type", "days", "notice_days"} <= leave_keys
    # A leave application has no amount, and the console must not offer one.
    assert "amount" not in leave_keys


def test_an_unknown_flow_is_refused(client, acme):
    assert client.get(
        "/api/v1/workflow/vocabulary/nonsense", headers=acme.headers()
    ).status_code == 404


# --------------------------------------------------------------------------- #
# Saving
# --------------------------------------------------------------------------- #


def test_rules_are_saved_in_evaluation_order(client, acme):
    saved = _save(client, acme, "expense", [
        _rule("Over 50k", conditions=[{"field": "amount", "op": "gt", "value": 5000000}]),
        _rule("Everything else", fallback=True),
    ])
    assert [row["name"] for row in saved] == ["Over 50k", "Everything else"]
    assert saved[0]["priority"] < saved[1]["priority"] or saved[1]["is_fallback"]


def test_the_fallback_always_sorts_last(client, acme):
    """A fallback that ran first would match everything and make every rule
    below it dead — a misconfiguration nobody would spot from the screen."""
    saved = _save(client, acme, "expense", [
        _rule("Catch all", fallback=True, priority=1),
        _rule("Over 50k", conditions=[{"field": "amount", "op": "gt", "value": 5000000}],
              priority=900),
    ])
    assert [row["name"] for row in saved] == ["Over 50k", "Catch all"]


def test_two_fallbacks_are_refused(client, acme):
    response = client.put(
        "/api/v1/workflow/rules/expense",
        json={"rules": [_rule("A", fallback=True), _rule("B", fallback=True)]},
        headers=acme.headers(),
    )
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "two_fallbacks"


def test_saving_replaces_rather_than_appends(client, acme):
    _save(client, acme, "expense", [_rule("First")])
    saved = _save(client, acme, "expense", [_rule("Second")])
    assert [row["name"] for row in saved] == ["Second"]


def test_a_named_reviewer_with_nobody_named_is_refused(client, acme):
    response = client.put(
        "/api/v1/workflow/rules/expense",
        json={"rules": [_rule("Finance", levels=[{"reviewer_rule": "named_user"}])]},
        headers=acme.headers(),
    )
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "reviewer_required"


def test_rules_are_administrator_only(client, acme):
    assert client.get(
        "/api/v1/workflow/rules/expense", headers=acme.headers(acme.employee_token)
    ).status_code == 403
    assert client.put(
        "/api/v1/workflow/rules/expense", json={"rules": []},
        headers=acme.headers(acme.employee_token),
    ).status_code == 403


def test_one_tenants_rules_are_invisible_to_another(client, acme, globex):
    _save(client, acme, "expense", [_rule("Acme only")])
    assert client.get(
        "/api/v1/workflow/rules/expense", headers=globex.headers()
    ).json() == []


# --------------------------------------------------------------------------- #
# Matching — the part that decides who approves
# --------------------------------------------------------------------------- #


def _match(acme, kind, record, subject_id=None):
    with SessionLocal() as db:
        subject = db.get(User, subject_id or acme.employee.id)
        return svc.match_rule(db, acme.id, kind, record, subject)


def test_an_amount_threshold_picks_the_right_chain(client, acme):
    _save(client, acme, "expense", [
        _rule("Over 50k", conditions=[{"field": "amount", "op": "gt", "value": 5000000}]),
        _rule("Over 10k", conditions=[{"field": "amount", "op": "gt", "value": 1000000}]),
        _rule("Everything else", fallback=True),
    ])

    assert _match(acme, "expense", Record(total_amount=9000000)).name == "Over 50k"
    assert _match(acme, "expense", Record(total_amount=2500000)).name == "Over 10k"
    assert _match(acme, "expense", Record(total_amount=500000)).name == "Everything else"


def test_the_boundary_is_where_the_operator_says(client, acme):
    """`gt` and `gte` differ by exactly one rupee, and that is the difference
    somebody will ask about."""
    _save(client, acme, "expense", [
        _rule("Above", conditions=[{"field": "amount", "op": "gt", "value": 5000000}]),
        _rule("Everything else", fallback=True),
    ])
    assert _match(acme, "expense", Record(total_amount=5000000)).name == "Everything else"
    assert _match(acme, "expense", Record(total_amount=5000001)).name == "Above"

    _save(client, acme, "expense", [
        _rule("At or above", conditions=[{"field": "amount", "op": "gte", "value": 5000000}]),
        _rule("Everything else", fallback=True),
    ])
    assert _match(acme, "expense", Record(total_amount=5000000)).name == "At or above"


def test_clauses_are_anded(client, acme):
    """Two conditions on one rule both have to hold."""
    with SessionLocal() as db:
        department = Department(org_id=acme.id, name="Sales")
        db.add(department)
        db.flush()
        person = db.get(User, acme.employee.id)
        person.department_id = department.id
        db.commit()
        department_id = str(department.id)

    _save(client, acme, "expense", [
        _rule("Big sales claims", conditions=[
            {"field": "amount", "op": "gt", "value": 5000000},
            {"field": "department", "op": "eq", "value": department_id},
        ]),
        _rule("Everything else", fallback=True),
    ])

    # Both hold.
    assert _match(acme, "expense", Record(total_amount=9000000)).name == "Big sales claims"
    # Amount holds, department does not — the owner is in no department.
    assert _match(
        acme, "expense", Record(total_amount=9000000), subject_id=acme.owner.id
    ).name == "Everything else"
    # Department holds, amount does not.
    assert _match(acme, "expense", Record(total_amount=100000)).name == "Everything else"


def test_an_id_written_as_a_string_still_matches(client, acme):
    """Rule values arrive from JSON, so a department id is a string while the
    subject's is a UUID. Comparing them directly is False for every rule anybody
    writes, which would look exactly like "conditions do not work"."""
    with SessionLocal() as db:
        department = Department(org_id=acme.id, name="Engineering")
        db.add(department)
        db.flush()
        person = db.get(User, acme.employee.id)
        person.department_id = department.id
        db.commit()
        department_id = str(department.id)

    _save(client, acme, "expense", [
        _rule("Engineering", conditions=[
            {"field": "department", "op": "eq", "value": department_id},
        ]),
        _rule("Everything else", fallback=True),
    ])
    assert _match(acme, "expense", Record(total_amount=1)).name == "Engineering"


def test_a_multi_valued_field_uses_the_set_operators(client, acme):
    """A claim spanning Travel and Meals is genuinely both, so `eq` has no
    honest answer and `any_of` is the operator that means something."""
    travel, meals = uuid.uuid4(), uuid.uuid4()
    _save(client, acme, "expense", [
        _rule("Has travel", conditions=[
            {"field": "category", "op": "any_of", "value": [str(travel)]},
        ]),
        _rule("Everything else", fallback=True),
    ])

    class Line:
        def __init__(self, category_id):
            self.category_id = category_id

    assert _match(
        acme, "expense", Record(lines=[Line(travel), Line(meals)])
    ).name == "Has travel"
    assert _match(acme, "expense", Record(lines=[Line(meals)])).name == "Everything else"


def test_leave_days_are_compared_in_days_not_milli_days(client, acme):
    """Milli-days are the storage unit and a terrible thing to write a rule in:
    nobody thinks "more than 3000"."""
    _save(client, acme, "leave", [
        _rule("Long leave", conditions=[{"field": "days", "op": "gt", "value": 3}]),
        _rule("Everything else", fallback=True),
    ])
    assert _match(acme, "leave", Record(duration_milli_days=5000)).name == "Long leave"
    assert _match(acme, "leave", Record(duration_milli_days=2000)).name == "Everything else"


def test_notice_is_negative_for_leave_applied_for_after_it_started(client, acme):
    _save(client, acme, "leave", [
        _rule("Backdated", conditions=[{"field": "notice_days", "op": "lt", "value": 0}]),
        _rule("Everything else", fallback=True),
    ])
    late = Record(
        start_date=date(2026, 6, 1),
        applied_at=datetime(2026, 6, 5, tzinfo=timezone.utc),
    )
    early = Record(
        start_date=date(2026, 6, 20),
        applied_at=datetime(2026, 6, 5, tzinfo=timezone.utc),
    )
    assert _match(acme, "leave", late).name == "Backdated"
    assert _match(acme, "leave", early).name == "Everything else"


# --------------------------------------------------------------------------- #
# Failing safely
# --------------------------------------------------------------------------- #


def test_an_unknown_field_does_not_match_and_does_not_raise(client, acme):
    """A rule written for a flow it was later moved off, or a hand-edited row.
    Matching on failure would route a large claim through the first chain."""
    _save(client, acme, "expense", [
        _rule("Nonsense", conditions=[{"field": "not_a_field", "op": "eq", "value": 1}]),
        _rule("Everything else", fallback=True),
    ])
    assert _match(acme, "expense", Record(total_amount=9000000)).name == "Everything else"


def test_a_condition_with_no_record_does_not_match(client, acme):
    """Chains started without the record — an older call site — can still match
    the rules about the requester, and must simply not match the rest."""
    _save(client, acme, "expense", [
        _rule("Over 50k", conditions=[{"field": "amount", "op": "gt", "value": 5000000}]),
        _rule("Everything else", fallback=True),
    ])
    assert _match(acme, "expense", None).name == "Everything else"


def test_a_non_numeric_value_does_not_match(client, acme):
    with SessionLocal() as db:
        rule = WorkflowRule(
            org_id=acme.id, kind="expense", name="Broken",
            conditions=[{"field": "amount", "op": "gt", "value": "lots"}],
            priority=1,
        )
        db.add(rule)
        db.flush()
        db.add(WorkflowLevel(
            org_id=acme.id, kind="expense", rule_id=rule.id, level=1,
            reviewer_rule="reporting_manager",
        ))
        db.add(WorkflowRule(
            org_id=acme.id, kind="expense", name="Everything else",
            conditions=[], priority=900, is_fallback=True,
        ))
        db.commit()

    assert _match(acme, "expense", Record(total_amount=9000000)).name == "Everything else"


def test_with_no_rules_at_all_nothing_matches(client, acme):
    """A company that writes none routes exactly as it did before rules
    existed — the department chain, or single-step approval."""
    assert _match(acme, "expense", Record(total_amount=9000000)) is None


def test_a_rule_with_no_levels_falls_through(client, acme):
    """An empty chain means "no chain" to the kernel, which silently turns a
    routed approval into a single-step one. A half-built rule must not be able
    to switch routing off for everybody it matches."""
    _save(client, acme, "expense", [
        _rule("Half built", conditions=[{"field": "amount", "op": "gt", "value": 1}],
              levels=[]),
    ])
    with SessionLocal() as db:
        subject = db.get(User, acme.employee.id)
        rungs, rule = svc.resolve_chain(
            db, acme.id, "expense", subject, Record(total_amount=9000000)
        )
    assert rule is None
    assert rungs == []


def test_an_inactive_rule_is_skipped_but_still_visible(client, acme):
    _save(client, acme, "expense", [
        {**_rule("Switched off",
                 conditions=[{"field": "amount", "op": "gt", "value": 1}]),
         "is_active": False},
        _rule("Everything else", fallback=True),
    ])
    assert _match(acme, "expense", Record(total_amount=9000000)).name == "Everything else"
    # Still on the screen: a rule that vanished when disabled would look deleted.
    listed = client.get("/api/v1/workflow/rules/expense", headers=acme.headers()).json()
    assert [row["name"] for row in listed] == ["Switched off", "Everything else"]


# --------------------------------------------------------------------------- #
# The plain chain still works
# --------------------------------------------------------------------------- #


def test_rule_levels_do_not_leak_into_the_company_chain(client, acme):
    """Rule rungs carry `department_id = NULL`, exactly like the company-wide
    chain — so without a `rule_id IS NULL` filter, reading the company chain
    would return the union of every rule's levels, and saving it would delete
    them."""
    _save(client, acme, "expense", [
        _rule("Over 50k", conditions=[{"field": "amount", "op": "gt", "value": 5000000}],
              levels=[{"reviewer_rule": "reporting_manager"},
                      {"reviewer_rule": "department_head"}]),
    ])
    company = client.get("/api/v1/workflow/levels/expense", headers=acme.headers()).json()
    assert company == []

    # And saving a company chain leaves the rule's rungs alone.
    client.put(
        "/api/v1/workflow/levels/expense",
        json={"levels": [{"reviewer_rule": "reporting_manager"}]},
        headers=acme.headers(),
    )
    rules = client.get("/api/v1/workflow/rules/expense", headers=acme.headers()).json()
    assert len(rules[0]["levels"]) == 2


def test_a_matched_rule_beats_the_department_chain(client, acme):
    client.put(
        "/api/v1/workflow/levels/expense",
        json={"levels": [{"reviewer_rule": "reporting_manager"}]},
        headers=acme.headers(),
    )
    _save(client, acme, "expense", [
        _rule("Over 50k", conditions=[{"field": "amount", "op": "gt", "value": 5000000}],
              levels=[{"reviewer_rule": "reporting_manager"},
                      {"reviewer_rule": "department_head"},
                      {"reviewer_rule": "named_user", "reviewer_user_id": None}][:2]),
    ])
    with SessionLocal() as db:
        subject = db.get(User, acme.employee.id)
        big, rule = svc.resolve_chain(
            db, acme.id, "expense", subject, Record(total_amount=9000000)
        )
        small, no_rule = svc.resolve_chain(
            db, acme.id, "expense", subject, Record(total_amount=100)
        )
    assert rule is not None and len(big) == 2
    assert no_rule is None and len(small) == 1


# --------------------------------------------------------------------------- #
# Preview
# --------------------------------------------------------------------------- #


def test_preview_answers_which_rule_would_catch_a_request(client, acme):
    _save(client, acme, "expense", [
        _rule("Over 50k", conditions=[{"field": "amount", "op": "gt", "value": 5000000}]),
        _rule("Everything else", fallback=True),
    ])
    assert _preview(client, acme, "expense", {"total_amount": 9000000})["name"] == "Over 50k"
    assert _preview(client, acme, "expense", {"total_amount": 900})["name"] == "Everything else"


def test_preview_answers_null_when_nothing_matches(client, acme):
    _save(client, acme, "expense", [
        _rule("Over 50k", conditions=[{"field": "amount", "op": "gt", "value": 5000000}]),
    ])
    assert _preview(client, acme, "expense", {"total_amount": 900}) is None
