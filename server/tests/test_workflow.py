"""The decision kernel, and the drift it was built to make visible.

Six things in this system are approved by somebody, and until this module they
each answered the same three questions on their own: may you decide twice, may
you decide your own, and must a rejection carry a reason. They did not all give
the same answers, and two of them enforced the rules in the router rather than
the service, which meant the rule applied to one caller and not to the next.

What these tests defend:

1. **The policy table is the specification.** A test reads each flow's declared
   policy and asserts the running system behaves that way, so a policy edited
   without the flow following it fails here rather than in production.
2. **A decided record is a record.** Every flow refuses a second decision —
   including timesheets, which is new: approving one twice used to silently
   re-freeze a different set of minutes over the first sign-off.
3. **The owner exemption is deliberate, not accidental.** An owner may approve
   their own leave (in a two-person company nobody else can) and may not approve
   their own expense claim (somebody else signs off spending). Both are asserted
   so neither can drift into the other.
4. **The rules are in the service.** Leave and timesheets checked self-review in
   the router; those tests now go through the service's own guard.

Two tenants, always.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from sqlalchemy import select

from app.db.session import SessionLocal
from app.core.security import create_access_token
from app.models import AuditLog
from app.services import workflow


# --------------------------------------------------------------------------- #
# The policy table itself
# --------------------------------------------------------------------------- #


def test_every_policy_is_internally_coherent():
    """Cheap, and it catches the copy-paste error that a six-entry table invites
    — a flow whose approved state is also listed as one that awaits a decision,
    which would let an approval be re-approved forever."""
    for kind, policy in workflow.POLICIES.items():
        assert policy.kind == kind
        assert policy.pending, f"{kind} has no state that awaits a decision"
        assert policy.approved not in policy.pending, (
            f"{kind} lists its approved state as still awaiting a decision"
        )
        assert policy.audit_action, f"{kind} writes no audit action"
        assert policy.label and not policy.label.endswith("."), kind


def test_the_owner_exemption_differs_by_flow_on_purpose():
    """The single most likely thing to be "tidied" into consistency by somebody
    who has not read why. Money and time off are not the same question."""
    assert workflow.LEAVE.self_review is workflow.SelfReview.OWNER_MAY
    assert workflow.TIMESHEET.self_review is workflow.SelfReview.OWNER_MAY
    assert workflow.REGULARIZATION.self_review is workflow.SelfReview.OWNER_MAY
    # Somebody else signs off your spending, even if you own the company.
    assert workflow.EXPENSE.self_review is workflow.SelfReview.FORBIDDEN
    assert workflow.LOAN.self_review is workflow.SelfReview.FORBIDDEN


def test_leave_is_the_one_flow_that_does_not_demand_a_reason():
    """Not an oversight being enshrined — a difference being recorded. Moving a
    rule is not the moment to invent one, and this test is where somebody who
    decides to change it will find out that it was deliberate."""
    assert workflow.LEAVE.reason_on_reject is False
    for policy in (workflow.TIMESHEET, workflow.REGULARIZATION,
                   workflow.EXPENSE, workflow.LOAN):
        assert policy.reason_on_reject is True, policy.kind


def test_the_settlement_is_in_the_table_but_not_driven_by_the_kernel():
    """Being in the policy table and being decidable are different things. A
    settlement is amended, not decided — no `reviewed_at`, no rejection — but a
    draft one really is waiting for somebody, so it belongs in the queue."""
    assert workflow.SETTLEMENT.decidable is False
    assert all(p.decidable for k, p in workflow.POLICIES.items() if k != "settlement")

    record = _Record(status="draft")
    with pytest.raises(RuntimeError, match="not driven by workflow.decide"):
        workflow.decide(None, policy=workflow.SETTLEMENT, record=record,
                        reviewer=None, approve=True)


def test_the_stale_code_is_three_different_strings_and_that_is_recorded():
    """`already_decided`, `not_submitted` and `not_pending` all mean "this is
    not awaiting a decision". They are on the wire and clients key on them, so
    they stay; the point of the policy table is that the inconsistency is now
    visible in one place instead of spread over five files."""
    assert workflow.LEAVE.stale_code == "already_decided"
    assert workflow.REGULARIZATION.stale_code == "already_decided"
    assert workflow.EXPENSE.stale_code == "not_submitted"
    assert workflow.LOAN.stale_code == "not_pending"


# --------------------------------------------------------------------------- #
# The guards, unit level
# --------------------------------------------------------------------------- #


class _Record:
    """The smallest thing the kernel will accept — it reads by attribute name,
    which is exactly what lets one kernel serve five differently-named tables."""

    def __init__(self, status="pending", user_id=None):
        self.status = status
        self.user_id = user_id
        self.reviewed_at = None
        self.reviewed_by_user_id = None
        self.review_note = None


def test_a_decided_record_is_refused_with_its_own_flows_code():
    for policy, status in (
        (workflow.LEAVE, "approved"),
        (workflow.EXPENSE, "reimbursed"),
        (workflow.LOAN, "rejected"),
    ):
        with pytest.raises(workflow.WorkflowError) as caught:
            workflow.ensure_pending(policy, _Record(status=status))
        assert caught.value.code == policy.stale_code
        assert caught.value.status_code == 409


def test_a_rejection_without_a_reason_is_refused_where_the_flow_says_so():
    with pytest.raises(workflow.WorkflowError) as caught:
        workflow.ensure_reason(workflow.EXPENSE, approve=False, note="   ")
    assert caught.value.code == "note_required"

    # Leave has never required one.
    assert workflow.ensure_reason(workflow.LEAVE, approve=False, note=None) is None
    # And an approval never needs one, anywhere.
    assert workflow.ensure_reason(workflow.EXPENSE, approve=True, note=None) is None


def test_a_note_is_normalised_the_same_way_everywhere():
    """An empty string and None meant the same thing in five services, each of
    which spelled the conversion itself. One of them would eventually not."""
    assert workflow.ensure_reason(workflow.LOAN, approve=True, note="  ") is None
    assert workflow.ensure_reason(workflow.LOAN, approve=True, note=" ok ") == "ok"


# --------------------------------------------------------------------------- #
# Through the real HTTP surface
# --------------------------------------------------------------------------- #


def _manager(tenant):
    """A real manager account, not the owner demoted.

    The owner is exempt from the very rule under test, so testing it on them
    would assert nothing — and demoting the owner takes away the permissions the
    rest of the setup needs. The same reasoning `test_expenses._manager` gives.
    """
    import uuid as _uuid

    from app.core.security import generate_enrollment_key, hash_password
    from app.models import User

    with SessionLocal() as db:
        manager = User(
            id=_uuid.uuid4(), org_id=tenant.id,
            email=f"manager-{_uuid.uuid4().hex[:6]}@{tenant.slug}.test",
            full_name="Team Manager", role="manager",
            password_hash=hash_password("correct-horse-battery"),
            is_active=True, enrollment_key=generate_enrollment_key(),
        )
        db.add(manager)
        db.commit()
        return manager.id, create_access_token(
            str(manager.id), {"typ": "user", "org": str(tenant.id), "role": "manager"})


def _leave_type(client, tenant):
    return client.post(
        "/api/v1/leave/types",
        json={"name": "Earned Leave", "code": "EL", "accrual_type": "none"},
        headers=tenant.headers(),
    ).json()


def _grant(client, tenant, leave_type, user_id, days=5):
    client.post(
        "/api/v1/leave/balances/adjust",
        json={"user_id": str(user_id), "leave_type_id": leave_type["id"],
              "year": date.today().year, "delta_milli_days": days * 1000,
              "reason": "opening balance"},
        headers=tenant.headers(),
    )


def _apply(client, tenant, leave_type, *, token=None, start=None):
    start = start or date.today() + timedelta(days=7)
    response = client.post(
        "/api/v1/leave/applications",
        json={"leave_type_id": leave_type["id"], "start_date": start.isoformat(),
              "end_date": start.isoformat(), "reason": "personal"},
        headers=tenant.headers(token or tenant.employee_token),
    )
    assert response.status_code in (200, 201), response.text
    return response.json()


def test_an_owner_may_decide_their_own_leave(client, tenants):
    """In a two-person company nobody else can, and an owner who cannot take
    leave is not a policy anybody chose."""
    acme, _ = tenants
    leave_type = _leave_type(client, acme)
    _grant(client, acme, leave_type, acme.owner.id)
    application = _apply(client, acme, leave_type, token=acme.owner_token)

    response = client.post(
        f"/api/v1/leave/applications/{application['id']}/decision",
        json={"approve": True}, headers=acme.headers(),
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "approved"


def test_a_manager_may_not_decide_their_own_leave(client, tenants):
    """The guard used to live in the router, so it applied to one route and to
    nothing else that decided a leave application. It is in the service now."""
    acme, _ = tenants
    manager_id, token = _manager(acme)

    leave_type = _leave_type(client, acme)
    _grant(client, acme, leave_type, manager_id)
    application = _apply(client, acme, leave_type, token=token)

    response = client.post(
        f"/api/v1/leave/applications/{application['id']}/decision",
        json={"approve": True}, headers=acme.headers(token),
    )
    assert response.status_code == 403
    assert response.json()["detail"]["reason"] == "self_review"


def test_a_leave_application_cannot_be_decided_twice(client, tenants):
    acme, _ = tenants
    leave_type = _leave_type(client, acme)
    _grant(client, acme, leave_type, acme.employee.id)
    application = _apply(client, acme, leave_type)

    first = client.post(
        f"/api/v1/leave/applications/{application['id']}/decision",
        json={"approve": True}, headers=acme.headers())
    assert first.status_code == 200

    second = client.post(
        f"/api/v1/leave/applications/{application['id']}/decision",
        json={"approve": False, "note": "changed my mind"}, headers=acme.headers())
    assert second.status_code == 409
    assert second.json()["detail"]["reason"] == "already_decided"


# --------------------------------------------------------------------------- #
# Timesheets — the flow that had no coverage, and therefore no guard
# --------------------------------------------------------------------------- #


def _approve_timesheet(client, tenant, *, user_id=None, note=None, token=None):
    return client.post(
        f"/api/v1/timesheets/{user_id or tenant.employee.id}/approve",
        params={"day": date.today().isoformat(), "period": "weekly"},
        json={"note": note}, headers=tenant.headers(token),
    )


def _reject_timesheet(client, tenant, *, user_id=None, note="fix your entries", token=None):
    return client.post(
        f"/api/v1/timesheets/{user_id or tenant.employee.id}/reject",
        params={"day": date.today().isoformat(), "period": "weekly"},
        json={"note": note}, headers=tenant.headers(token),
    )


def test_a_timesheet_cannot_be_approved_twice(client, tenants):
    """**New behaviour, and the bug this refactor was worth doing for.** The
    second approval rebuilt the sheet and re-froze whatever the totals were by
    then, overwriting the figures payroll may already have run against — with
    no record that the first decision had ever been made."""
    acme, _ = tenants
    assert _approve_timesheet(client, acme).status_code == 200

    again = _approve_timesheet(client, acme)
    assert again.status_code == 409
    assert again.json()["detail"]["reason"] == "already_approved"


def test_a_returned_timesheet_can_be_approved_after_corrections(client, tenants):
    """The other half of the guard. "Only an approved one is closed" has to mean
    a rejected period is still workable, or returning one for changes would end
    the conversation instead of continuing it."""
    acme, _ = tenants
    assert _reject_timesheet(client, acme).status_code == 200
    assert _approve_timesheet(client, acme).status_code == 200


def test_returning_a_timesheet_needs_a_reason(client, tenants):
    acme, _ = tenants
    response = _reject_timesheet(client, acme, note=None)
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "note_required"


def test_an_owner_may_approve_their_own_timesheet(client, tenants):
    acme, _ = tenants
    response = _approve_timesheet(client, acme, user_id=acme.owner.id)
    assert response.status_code == 200


def test_a_timesheet_decision_is_audited_with_the_action_it_always_wrote(client, tenants):
    """Timesheets are the one flow whose log already distinguished the two
    outcomes. Collapsing that to match the others would break the queries a
    company has written against it."""
    acme, _ = tenants
    _approve_timesheet(client, acme)
    with SessionLocal() as db:
        actions = set(db.scalars(
            select(AuditLog.action).where(
                AuditLog.org_id == acme.id,
                AuditLog.action.startswith("timesheet."),
            )
        ))
    assert "timesheet.approved" in actions


def test_another_tenants_timesheet_cannot_be_approved(client, tenants):
    acme, globex = tenants
    response = _approve_timesheet(client, acme, user_id=globex.employee.id)
    assert response.status_code in (403, 404)
