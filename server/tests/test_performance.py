"""Appraisals: cycles, weighted goals, the three turns, and the freeze.

What these tests defend:

1. **The arithmetic is integer and the weights must add up.** A weighted mean
   over weights that do not sum to 100% is a number with no meaning that still
   renders as a rating.
2. **Nobody writes the employee's half but the employee.** An appraisal where
   the manager can rewrite what somebody said about themselves is not one.
3. **Goals cannot move once somebody has rated against them.** Shifting the
   target after the fact is the thing an appraisal system must not permit.
4. **The computed score does not overrule the manager** — but a whole point of
   daylight demands a written reason, because that is the sentence that gets
   challenged.
5. **A finalised review is frozen** — the ninth freeze here.
6. **A rating is not visible until it is shared**, and it is *removed* from the
   payload rather than flagged, because a client that receives a number will
   render it.
7. Two tenants, always.
"""

from __future__ import annotations

import uuid as _uuid
from datetime import date

from app.core.security import create_access_token, generate_enrollment_key, hash_password
from app.db.session import SessionLocal
from app.models import User


# --------------------------------------------------------------------------- #
# Setup
# --------------------------------------------------------------------------- #


def _manager(tenant):
    """A real manager the tenant's employee reports to.

    A third account rather than the owner: the owner is HR here, and a test that
    used them for both halves of a review would never exercise the split.
    """
    with SessionLocal() as db:
        manager = User(
            id=_uuid.uuid4(), org_id=tenant.id,
            email=f"mgr-{_uuid.uuid4().hex[:6]}@{tenant.slug}.test",
            full_name="Team Manager", role="manager",
            password_hash=hash_password("correct-horse-battery"),
            is_active=True, enrollment_key=generate_enrollment_key(),
        )
        db.add(manager)
        db.flush()
        db.get(User, tenant.employee.id).manager_id = manager.id
        db.commit()
        return manager.id, create_access_token(
            str(manager.id), {"typ": "user", "org": str(tenant.id), "role": "manager"})


def _cycle(client, tenant, *, open_it=True, **overrides):
    body = {
        "name": f"FY2026 Annual {_uuid.uuid4().hex[:4]}",
        "period_start": "2025-04-01", "period_end": "2026-03-31",
        "rating_max": 5,
    } | overrides
    response = client.post("/api/v1/performance/cycles", json=body,
                           headers=tenant.headers())
    assert response.status_code == 201, response.text
    cycle = response.json()
    if open_it:
        opened = client.post(f"/api/v1/performance/cycles/{cycle['id']}/status",
                             json={"status": "open"}, headers=tenant.headers())
        assert opened.status_code == 200, opened.text
        cycle = opened.json()
    return cycle


def _open_reviews(client, tenant, cycle_id):
    response = client.post(
        f"/api/v1/performance/cycles/{cycle_id}/open-reviews",
        json={"user_ids": []}, headers=tenant.headers())
    assert response.status_code == 200, response.text
    return response.json()["created"]


def _my_review(client, tenant, cycle_id, token=None):
    response = client.get(f"/api/v1/performance/cycles/{cycle_id}/mine",
                          headers=tenant.headers(token or tenant.employee_token))
    assert response.status_code == 200, response.text
    return response.json()


def _set_goals(client, tenant, cycle_id, user_id, goals):
    return client.put(
        f"/api/v1/performance/cycles/{cycle_id}/goals/{user_id}",
        json={"goals": goals}, headers=tenant.headers())


def _three_goals(client, tenant, cycle_id, user_id):
    """30/50/20 — weights that total 10,000 bps."""
    response = _set_goals(client, tenant, cycle_id, user_id, [
        {"title": "Ship the billing rewrite", "weight_bps": 3000},
        {"title": "Keep p95 under 400ms", "weight_bps": 5000},
        {"title": "Mentor two juniors", "weight_bps": 2000},
    ])
    assert response.status_code == 200, response.text
    return response.json()


def _ready_for_manager(client, tenant, *, ratings=(4, 3, 5)):
    """A cycle, goals, and a submitted self-review. The common starting point."""
    cycle = _cycle(client, tenant)
    _open_reviews(client, tenant, cycle["id"])
    goals = _three_goals(client, tenant, cycle["id"], tenant.employee.id)
    review = _my_review(client, tenant, cycle["id"])
    client.post(
        f"/api/v1/performance/reviews/{review['id']}/self",
        json={"goals": [{"goal_id": g["id"], "rating": r}
                        for g, r in zip(goals, ratings)],
              "comment": "A good year."},
        headers=tenant.headers(tenant.employee_token))
    submitted = client.post(
        f"/api/v1/performance/reviews/{review['id']}/self/submit",
        headers=tenant.headers(tenant.employee_token))
    assert submitted.status_code == 200, submitted.text
    return cycle, goals, submitted.json()


# --------------------------------------------------------------------------- #
# Cycles
# --------------------------------------------------------------------------- #


def test_a_cycle_starts_as_a_draft_and_employees_cannot_see_it(client, tenants):
    """A cycle being built has half its goals set and no dates agreed. An
    employee seeing it would ask about a round that may never run."""
    acme, _ = tenants
    _cycle(client, acme, open_it=False)

    theirs = client.get("/api/v1/performance/cycles",
                        headers=acme.headers(acme.employee_token)).json()
    assert theirs == []
    assert len(client.get("/api/v1/performance/cycles",
                          headers=acme.headers()).json()) == 1


def test_a_closed_cycle_cannot_be_reopened(client, tenants):
    """"We closed it by mistake" is answered by a new cycle, not by unfreezing
    a round somebody's increment was decided from."""
    acme, _ = tenants
    cycle = _cycle(client, acme)
    client.post(f"/api/v1/performance/cycles/{cycle['id']}/status",
                json={"status": "closed"}, headers=acme.headers())

    response = client.post(f"/api/v1/performance/cycles/{cycle['id']}/status",
                           json={"status": "open"}, headers=acme.headers())
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "cycle_closed"


def test_a_partial_label_list_is_refused(client, tenants):
    """A five-point scale with four labels has an unnamed top point, which reads
    as a bug rather than a choice."""
    acme, _ = tenants
    response = client.post(
        "/api/v1/performance/cycles",
        json={"name": "Bad labels", "period_start": "2025-04-01",
              "period_end": "2026-03-31", "rating_max": 5,
              "rating_labels": ["Poor", "Fair", "Good", "Great"]},
        headers=acme.headers())
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "label_count"


def test_opening_reviews_is_idempotent(client, tenants):
    acme, _ = tenants
    cycle = _cycle(client, acme)
    first = _open_reviews(client, acme, cycle["id"])
    assert first >= 2
    assert _open_reviews(client, acme, cycle["id"]) == 0


def test_the_module_gate_actually_bites(client, tenants):
    """Every test above would pass identically if the router were registered
    without its gate — the fixture's company resolves to a plan that allows
    everything. This is the one that would fail if `require_module` were
    dropped from the registration."""
    from tests.test_module_grants import _restrict_plan

    acme, _ = tenants
    _restrict_plan(acme.id, ["attendance"])
    assert client.get("/api/v1/performance/cycles",
                      headers=acme.headers()).status_code == 402


def test_another_tenants_cycle_is_not_found(client, tenants):
    acme, globex = tenants
    theirs = _cycle(client, globex)
    response = client.post(
        f"/api/v1/performance/cycles/{theirs['id']}/status",
        json={"status": "closed"}, headers=acme.headers())
    assert response.status_code == 404


# --------------------------------------------------------------------------- #
# Weights and the score
# --------------------------------------------------------------------------- #


def test_a_goal_set_that_does_not_total_is_refused_with_the_shortfall(client, tenants):
    """Named shortfall, not a bare "invalid": somebody staring at eight goals
    needs to be told they are 5% short."""
    acme, _ = tenants
    cycle = _cycle(client, acme)
    _open_reviews(client, acme, cycle["id"])
    _set_goals(client, acme, cycle["id"], acme.employee.id, [
        {"title": "One", "weight_bps": 5000},
        {"title": "Two", "weight_bps": 4500},
    ])
    review = _my_review(client, acme, cycle["id"])
    goals = client.get(
        f"/api/v1/performance/cycles/{cycle['id']}/goals/{acme.employee.id}",
        headers=acme.headers(acme.employee_token)).json()
    client.post(
        f"/api/v1/performance/reviews/{review['id']}/self",
        json={"goals": [{"goal_id": g["id"], "rating": 3} for g in goals]},
        headers=acme.headers(acme.employee_token))

    response = client.post(
        f"/api/v1/performance/reviews/{review['id']}/self/submit",
        headers=acme.headers(acme.employee_token))
    assert response.status_code == 422
    body = response.json()["detail"]
    assert body["reason"] == "weights_do_not_total"
    assert "95%" in body["message"] and "5%" in body["message"]


def test_the_score_is_the_weighted_mean_in_hundredths(client, tenants):
    """30% × 4 + 50% × 3 + 20% × 5 = 3.7, and the wire carries 370. No float
    touches it — see the service."""
    acme, _ = tenants
    manager_id, manager_token = _manager(acme)
    cycle, goals, review = _ready_for_manager(client, acme)

    saved = client.post(
        f"/api/v1/performance/reviews/{review['id']}/manager",
        json={"goals": [{"goal_id": g["id"], "rating": r}
                        for g, r in zip(goals, (4, 3, 5))],
              "overall_rating": 4},
        headers=acme.headers(manager_token))
    assert saved.status_code == 200, saved.text
    assert saved.json()["live_score_centi"] == 370


def test_an_unrated_goal_does_not_drag_the_mean_toward_zero(client, tenants):
    """"Not rated" and "rated lowest" are different, and the model keeps them
    different — so the weights renormalise over what was actually rated."""
    acme, _ = tenants
    manager_id, manager_token = _manager(acme)
    cycle, goals, review = _ready_for_manager(client, acme)

    saved = client.post(
        f"/api/v1/performance/reviews/{review['id']}/manager",
        # Only the 50%-weighted goal is rated, at 3. The mean of what was rated
        # is 3.00, not 1.50.
        json={"goals": [{"goal_id": goals[1]["id"], "rating": 3}]},
        headers=acme.headers(manager_token))
    assert saved.json()["live_score_centi"] == 300


# --------------------------------------------------------------------------- #
# The three turns
# --------------------------------------------------------------------------- #


def test_only_the_employee_writes_their_own_half(client, tenants):
    """"I did not say that" is unanswerable once somebody else can write it."""
    acme, _ = tenants
    manager_id, manager_token = _manager(acme)
    cycle = _cycle(client, acme)
    _open_reviews(client, acme, cycle["id"])
    review = _my_review(client, acme, cycle["id"])

    for token in (manager_token, acme.owner_token):
        response = client.post(
            f"/api/v1/performance/reviews/{review['id']}/self",
            json={"goals": [], "comment": "Not their words"},
            headers=acme.headers(token))
        assert response.status_code == 403
        assert response.json()["detail"]["reason"] == "not_yours"


def test_goals_cannot_move_once_the_employee_has_submitted(client, tenants):
    """Moving the target after somebody rated themselves against it is the thing
    an appraisal system must not permit."""
    acme, _ = tenants
    cycle, goals, review = _ready_for_manager(client, acme)

    response = _set_goals(client, acme, cycle["id"], acme.employee.id, [
        {"title": "A different target entirely", "weight_bps": 10000},
    ])
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "review_in_progress"


def test_every_goal_must_be_rated_before_submitting(client, tenants):
    acme, _ = tenants
    cycle = _cycle(client, acme)
    _open_reviews(client, acme, cycle["id"])
    goals = _three_goals(client, acme, cycle["id"], acme.employee.id)
    review = _my_review(client, acme, cycle["id"])
    client.post(
        f"/api/v1/performance/reviews/{review['id']}/self",
        json={"goals": [{"goal_id": goals[0]["id"], "rating": 4}]},
        headers=acme.headers(acme.employee_token))

    response = client.post(
        f"/api/v1/performance/reviews/{review['id']}/self/submit",
        headers=acme.headers(acme.employee_token))
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "unrated_goals"


def test_a_rating_outside_the_cycles_scale_is_refused(client, tenants):
    acme, _ = tenants
    cycle = _cycle(client, acme, rating_max=4)
    _open_reviews(client, acme, cycle["id"])
    goals = _three_goals(client, acme, cycle["id"], acme.employee.id)
    review = _my_review(client, acme, cycle["id"])

    response = client.post(
        f"/api/v1/performance/reviews/{review['id']}/self",
        json={"goals": [{"goal_id": goals[0]["id"], "rating": 5}]},
        headers=acme.headers(acme.employee_token))
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "rating_out_of_scale"


def test_a_manager_cannot_write_before_the_employee_has(client, tenants):
    """Only when the cycle asks the employee to write first, which is the
    default — a manager-only cycle is a real thing and turns the flag off."""
    acme, _ = tenants
    manager_id, manager_token = _manager(acme)
    cycle = _cycle(client, acme)
    _open_reviews(client, acme, cycle["id"])
    _three_goals(client, acme, cycle["id"], acme.employee.id)
    review = _my_review(client, acme, cycle["id"])

    response = client.post(
        f"/api/v1/performance/reviews/{review['id']}/manager",
        json={"goals": []}, headers=acme.headers(manager_token))
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "awaiting_self_review"


def test_a_manager_only_cycle_lets_the_manager_write_straight_away(client, tenants):
    acme, _ = tenants
    manager_id, manager_token = _manager(acme)
    cycle = _cycle(client, acme, requires_self_review=False)
    _open_reviews(client, acme, cycle["id"])
    goals = _three_goals(client, acme, cycle["id"], acme.employee.id)
    review = _my_review(client, acme, cycle["id"])

    response = client.post(
        f"/api/v1/performance/reviews/{review['id']}/manager",
        json={"goals": [{"goal_id": goals[0]["id"], "rating": 4}]},
        headers=acme.headers(manager_token))
    assert response.status_code == 200, response.text


# --------------------------------------------------------------------------- #
# The decision, through the kernel
# --------------------------------------------------------------------------- #


def test_returning_a_review_needs_a_reason(client, tenants):
    acme, _ = tenants
    manager_id, manager_token = _manager(acme)
    cycle, goals, review = _ready_for_manager(client, acme)

    response = client.post(
        f"/api/v1/performance/reviews/{review['id']}/decision",
        json={"approve": False}, headers=acme.headers(manager_token))
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "note_required"


def test_a_returned_review_becomes_editable_again(client, tenants):
    """`returned` is a real state, not a synonym for draft: somebody whose
    review comes back needs to know it was looked at."""
    acme, _ = tenants
    manager_id, manager_token = _manager(acme)
    cycle, goals, review = _ready_for_manager(client, acme)

    returned = client.post(
        f"/api/v1/performance/reviews/{review['id']}/decision",
        json={"approve": False, "note": "Add detail on the mentoring goal"},
        headers=acme.headers(manager_token))
    assert returned.status_code == 200, returned.text
    assert returned.json()["status"] == "returned"

    again = client.post(
        f"/api/v1/performance/reviews/{review['id']}/self",
        json={"goals": [], "comment": "More detail."},
        headers=acme.headers(acme.employee_token))
    assert again.status_code == 200


def test_a_manager_must_rate_every_goal_before_passing_it_on(client, tenants):
    acme, _ = tenants
    manager_id, manager_token = _manager(acme)
    cycle, goals, review = _ready_for_manager(client, acme)

    response = client.post(
        f"/api/v1/performance/reviews/{review['id']}/decision",
        json={"approve": True}, headers=acme.headers(manager_token))
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "unrated_goals"


def test_a_review_cannot_be_decided_twice(client, tenants):
    """The kernel's guard, reached through a seventh flow that costs one policy
    entry to get it."""
    acme, _ = tenants
    manager_id, manager_token = _manager(acme)
    cycle, goals, review = _ready_for_manager(client, acme)
    client.post(
        f"/api/v1/performance/reviews/{review['id']}/manager",
        json={"goals": [{"goal_id": g["id"], "rating": 4} for g in goals],
              "overall_rating": 4},
        headers=acme.headers(manager_token))
    first = client.post(f"/api/v1/performance/reviews/{review['id']}/decision",
                        json={"approve": True}, headers=acme.headers(manager_token))
    assert first.status_code == 200

    second = client.post(f"/api/v1/performance/reviews/{review['id']}/decision",
                         json={"approve": True}, headers=acme.headers(manager_token))
    assert second.status_code == 409
    assert second.json()["detail"]["reason"] == "already_decided"


def test_a_pending_review_appears_in_the_managers_approvals_queue(client, tenants):
    """The payoff of the kernel: a seventh flow reaches the unified queue by
    declaring a policy and an adapter, not by anybody remembering to add it to
    a screen."""
    acme, _ = tenants
    manager_id, manager_token = _manager(acme)
    _ready_for_manager(client, acme)

    queue = client.get("/api/v1/approvals",
                       headers=acme.headers(manager_token)).json()
    assert [item["kind"] for item in queue] == ["performance"]
    assert queue[0]["user_name"] == acme.employee.full_name
    # No money in an appraisal, and rendering ₹0.00 would be a lie.
    assert queue[0]["amount_paise"] is None


# --------------------------------------------------------------------------- #
# Finalising and the freeze
# --------------------------------------------------------------------------- #


def _through_to_manager_submitted(client, tenant, manager_token, *, overall=4,
                                  ratings=(4, 3, 5), override_reason=None):
    cycle, goals, review = _ready_for_manager(client, tenant)
    body = {"goals": [{"goal_id": g["id"], "rating": r}
                      for g, r in zip(goals, ratings)],
            "overall_rating": overall}
    if override_reason:
        body["override_reason"] = override_reason
    client.post(f"/api/v1/performance/reviews/{review['id']}/manager",
                json=body, headers=tenant.headers(manager_token))
    client.post(f"/api/v1/performance/reviews/{review['id']}/decision",
                json={"approve": True}, headers=tenant.headers(manager_token))
    return cycle, goals, review


def test_finalising_freezes_the_score_and_the_scale(client, tenants):
    """A "4" without the scale it was given on is a digit, not a rating."""
    acme, _ = tenants
    manager_id, manager_token = _manager(acme)
    cycle, goals, review = _through_to_manager_submitted(client, acme, manager_token)

    final = client.post(f"/api/v1/performance/reviews/{review['id']}/finalise",
                        json={"share": True}, headers=acme.headers())
    assert final.status_code == 200, final.text
    body = final.json()
    assert body["status"] == "finalised"
    assert body["score_centi"] == 370
    assert body["rating_max"] == 5
    assert body["finalised_at"] and body["shared_at"]


def test_a_whole_point_of_daylight_needs_a_written_reason(client, tenants):
    """The most challenged sentence in any appraisal. Somebody should have
    written down why before it is challenged, not after."""
    acme, _ = tenants
    manager_id, manager_token = _manager(acme)
    # Ratings average 2.00; the manager wants to give 4.
    cycle, goals, review = _through_to_manager_submitted(
        client, acme, manager_token, overall=4, ratings=(2, 2, 2))

    refused = client.post(f"/api/v1/performance/reviews/{review['id']}/finalise",
                          json={}, headers=acme.headers())
    assert refused.status_code == 422
    assert refused.json()["detail"]["reason"] == "override_reason_required"
    assert "2.00" in refused.json()["detail"]["message"]


def test_a_reason_lets_the_manager_overrule_the_arithmetic(client, tenants):
    """The computed score is evidence, not the decision."""
    acme, _ = tenants
    manager_id, manager_token = _manager(acme)
    cycle, goals, review = _through_to_manager_submitted(
        client, acme, manager_token, overall=4, ratings=(2, 2, 2),
        override_reason="Carried the incident response single-handed in January.")

    final = client.post(f"/api/v1/performance/reviews/{review['id']}/finalise",
                        json={}, headers=acme.headers())
    assert final.status_code == 200, final.text
    assert final.json()["overall_rating"] == 4
    assert final.json()["score_centi"] == 200


def test_a_finalised_review_cannot_be_rewritten(client, tenants):
    """The ninth freeze. A rating somebody has been told is a record."""
    acme, _ = tenants
    manager_id, manager_token = _manager(acme)
    cycle, goals, review = _through_to_manager_submitted(client, acme, manager_token)
    client.post(f"/api/v1/performance/reviews/{review['id']}/finalise",
                json={}, headers=acme.headers())

    again = client.post(f"/api/v1/performance/reviews/{review['id']}/finalise",
                        json={}, headers=acme.headers())
    assert again.status_code == 409
    assert again.json()["detail"]["reason"] == "already_finalised"

    edit = client.post(
        f"/api/v1/performance/reviews/{review['id']}/manager",
        json={"goals": [{"goal_id": goals[0]["id"], "rating": 1}]},
        headers=acme.headers(manager_token))
    assert edit.status_code == 409
    assert edit.json()["detail"]["reason"] == "frozen"


def test_finalising_needs_an_overall_rating(client, tenants):
    acme, _ = tenants
    manager_id, manager_token = _manager(acme)
    cycle, goals, review = _through_to_manager_submitted(
        client, acme, manager_token, overall=None)

    response = client.post(f"/api/v1/performance/reviews/{review['id']}/finalise",
                           json={}, headers=acme.headers())
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "no_overall_rating"


# --------------------------------------------------------------------------- #
# Visibility
# --------------------------------------------------------------------------- #


def test_an_unshared_rating_is_removed_from_the_employees_payload(client, tenants):
    """Removed, not flagged. A client that receives a number will render it, and
    this is the number the employee has not been told."""
    acme, _ = tenants
    manager_id, manager_token = _manager(acme)
    cycle, goals, review = _through_to_manager_submitted(client, acme, manager_token)
    client.post(f"/api/v1/performance/reviews/{review['id']}/finalise",
                json={"share": False}, headers=acme.headers())

    theirs = _my_review(client, acme, cycle["id"])
    assert theirs["rating_visible"] is False
    assert theirs["overall_rating"] is None
    assert theirs["score_centi"] is None
    assert all(goal["manager_rating"] is None for goal in theirs["goals"])

    # Their manager and HR see it immediately — hiding it from the person who
    # wrote it would be absurd.
    mine = client.get(f"/api/v1/performance/reviews/{review['id']}",
                      headers=acme.headers(manager_token)).json()
    assert mine["overall_rating"] == 4


def test_sharing_releases_the_rating(client, tenants):
    acme, _ = tenants
    manager_id, manager_token = _manager(acme)
    cycle, goals, review = _through_to_manager_submitted(client, acme, manager_token)
    client.post(f"/api/v1/performance/reviews/{review['id']}/finalise",
                json={"share": False}, headers=acme.headers())
    client.post(f"/api/v1/performance/reviews/{review['id']}/share",
                headers=acme.headers())

    theirs = _my_review(client, acme, cycle["id"])
    assert theirs["rating_visible"] is True
    assert theirs["overall_rating"] == 4
    assert theirs["score_centi"] == 370


def test_an_employee_cannot_read_a_colleagues_review(client, tenants):
    acme, _ = tenants
    cycle = _cycle(client, acme)
    _open_reviews(client, acme, cycle["id"])
    owners = client.get(f"/api/v1/performance/cycles/{cycle['id']}/reviews",
                        headers=acme.headers()).json()
    someone_else = next(r for r in owners if r["user_id"] != str(acme.employee.id))

    response = client.get(f"/api/v1/performance/reviews/{someone_else['id']}",
                          headers=acme.headers(acme.employee_token))
    assert response.status_code == 404


# --------------------------------------------------------------------------- #
# Competencies
# --------------------------------------------------------------------------- #


def test_a_competency_name_is_copied_onto_the_rating(client, tenants):
    """Renaming "Ownership" to "Accountability" must not rewrite what somebody
    was rated on three years ago — the same discipline payslip lines use."""
    acme, _ = tenants
    competency = client.post("/api/v1/performance/competencies",
                             json={"name": "Ownership"},
                             headers=acme.headers()).json()
    cycle = _cycle(client, acme)
    _open_reviews(client, acme, cycle["id"])
    _three_goals(client, acme, cycle["id"], acme.employee.id)
    review = _my_review(client, acme, cycle["id"])

    client.post(
        f"/api/v1/performance/reviews/{review['id']}/self",
        json={"goals": [],
              "competencies": [{"competency_id": competency["id"], "rating": 4}]},
        headers=acme.headers(acme.employee_token))
    client.patch(f"/api/v1/performance/competencies/{competency['id']}",
                 json={"name": "Accountability"}, headers=acme.headers())

    body = _my_review(client, acme, cycle["id"])
    assert body["competencies"][0]["competency_name"] == "Ownership"


def test_a_duplicate_competency_name_is_refused(client, tenants):
    """Two competencies with one name make every report ambiguous."""
    acme, _ = tenants
    client.post("/api/v1/performance/competencies", json={"name": "Ownership"},
                headers=acme.headers())
    response = client.post("/api/v1/performance/competencies",
                           json={"name": "Ownership"}, headers=acme.headers())
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "duplicate_name"
