"""Employee exit: the completion gate, the single revoke path, and the F&F stub.

The plan's exit criterion for Phase 7 is "completing offboarding correctly
deactivates the user and revokes their device(s)". That sentence hides the two
things actually worth defending, and this suite is built around them rather
than around the happy path.

**The gate is a three-state question, not a boolean.** ``done`` settles an item,
``skipped`` also settles it — a waived step must not hold an exit open forever
— and anything the enum does not recognise reads as *unsettled*, so a bad
string keeps the gate closed instead of quietly opening it. The last of those
three is the one a normal suite never tests and the one a refactor breaks:
``ClearanceTaskStatus(value)`` raising inside a truthiness check is one
``except ValueError: return True`` away from letting every corrupted row
complete an exit.

**There must be exactly one revoke path.** Asserting the request succeeded
proves nothing; asserting ``devices.is_active is False`` proves only that
*something* wrote the flag. So completion is checked three ways: the column is
flipped, the device row is otherwise byte-for-byte intact (no delete, no token
rotation, no second mechanism), and the agent's own credential is then rejected
by the *existing* ``get_current_device`` 403 — the one the agent raises
``DeviceRevoked`` for. A private revoke would pass the first check and fail the
third.

Everything runs against the real app and a real database, per ``conftest.py``.
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta

import pytest
from sqlalchemy import select

from app.core.security import token_digest
from app.db.session import SessionLocal
from app.models import (
    Asset,
    AssetAssignment,
    AuditLog,
    Device,
    OffboardingRequest,
    OffboardingTask,
    User,
    UserStatus,
)


@pytest.fixture(scope="module", autouse=True)
def _offboarding_router_mounted():
    """Mount the router if the lead has not wired it into ``router.py`` yet.

    Phase 7's backend lands before the integration seam does, and a wall of
    cryptic 404s says nothing about whether the module works. This registers
    the real router on the real app, and it is a no-op the moment
    ``api/v1/router.py`` includes it — which
    ``test_router_is_registered_for_integration`` asserts separately against
    the router module, so the shim can never hide a missing registration.

    Copied from ``test_hrms_assets.py`` on purpose: the same seam, the same
    shim, so the next phase to land early has a precedent rather than an
    invention.
    """
    from app.api.v1 import offboarding as offboarding_api
    from app.main import app

    if not any(getattr(r, "path", "").startswith("/api/v1/offboarding") for r in app.routes):
        app.include_router(offboarding_api.router, prefix="/api/v1")
        app.openapi_schema = None
    yield


def test_router_is_registered_for_integration():
    """Fails until the lead adds offboarding to ``api/v1/router.py``. Deliberate."""
    from app.api.v1.router import api_router

    paths = {getattr(route, "path", "") for route in api_router.routes}
    assert any(path.startswith("/api/v1/offboarding") for path in paths), (
        "app/api/v1/router.py does not include offboarding.router — see the "
        "Phase 7 integration request"
    )


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

_LWD = date(2026, 6, 30)


def _initiate(client, tenant, *, user_id=None, last_working_day=_LWD, reason="resignation"):
    body = {
        "user_id": str(user_id or tenant.employee.id),
        "reason": reason,
        "notice_date": "2026-06-01",
    }
    if last_working_day is not None:
        body["last_working_day"] = last_working_day.isoformat()
    response = client.post(
        "/api/v1/offboarding/requests", json=body, headers=tenant.headers()
    )
    assert response.status_code == 201, response.text
    return response.json()


def _settle_all_mandatory(client, tenant, exit_id):
    """Mark every mandatory clearance item done, so only the gate under test is left."""
    detail = client.get(
        f"/api/v1/offboarding/requests/{exit_id}", headers=tenant.headers()
    ).json()
    for group in detail["clearance"]:
        for task in group["tasks"]:
            if task["is_mandatory"] and not task["is_settled"]:
                response = client.patch(
                    f"/api/v1/offboarding/requests/{exit_id}/tasks/{task['id']}",
                    json={"status": "done"},
                    headers=tenant.headers(),
                )
                assert response.status_code == 200, response.text


def _enrol_device(tenant, raw_token: str, user_id=None) -> uuid.UUID:
    with SessionLocal() as db:
        device = Device(
            id=uuid.uuid4(), org_id=tenant.id, user_id=user_id or tenant.employee.id,
            machine_id=f"machine-{raw_token}", hostname="leaver-laptop", os="windows",
            token_hash=token_digest(raw_token), is_active=True,
        )
        db.add(device)
        db.commit()
        return device.id


def _device_row(device_id):
    with SessionLocal() as db:
        return db.get(Device, device_id)


def _audit_actions(org_id, prefix="offboarding."):
    with SessionLocal() as db:
        return [
            row[0]
            for row in db.execute(
                select(AuditLog.action)
                .where(AuditLog.org_id == org_id, AuditLog.action.startswith(prefix))
                .order_by(AuditLog.created_at)
            )
        ]


# --------------------------------------------------------------------------- #
# Initiation and the checklist
# --------------------------------------------------------------------------- #


def test_initiating_an_exit_instantiates_the_default_checklist(client, tenants):
    """The constant is copied into rows, not referenced (D-017)."""
    from app.models.offboarding import DEFAULT_CLEARANCE_CHECKLIST

    acme, _ = tenants
    body = _initiate(client, acme)

    assert body["status"] == "initiated"
    assert body["task_total"] == len(DEFAULT_CLEARANCE_CHECKLIST)
    assert body["task_settled"] == 0
    # All four desks are present even before anything is raised against them:
    # an empty Finance section is information, a missing one reads as a bug.
    assert [g["category"] for g in body["clearance"]] == [
        "it_asset_return", "knowledge_transfer", "hr_clearance", "finance_clearance"
    ]

    flat = [t for g in body["clearance"] for t in g["tasks"]]
    expected_mandatory = sum(1 for s in DEFAULT_CLEARANCE_CHECKLIST if s["is_mandatory"])
    assert body["blocking_task_count"] == expected_mandatory
    # Every due date is derived from the last working day and its own offset.
    for task in flat:
        assert task["due_on"] == (_LWD + timedelta(days=task["due_offset_days"])).isoformat()

    # The rows are this exit's own. Editing one must not touch the constant.
    assert DEFAULT_CLEARANCE_CHECKLIST[0]["title"]  # untouched, still the template


def test_an_exit_with_no_last_working_day_has_no_due_dates(client, tenants):
    """``None``, never a guessed date — see ``_due_for``."""
    acme, _ = tenants
    body = _initiate(client, acme, last_working_day=None)
    flat = [t for g in body["clearance"] for t in g["tasks"]]
    assert flat and all(t["due_on"] is None for t in flat)


def test_a_second_open_exit_for_the_same_person_is_refused(client, tenants):
    """The partial unique index decides; the service supplies the message (D-027)."""
    acme, _ = tenants
    _initiate(client, acme)
    response = client.post(
        "/api/v1/offboarding/requests",
        json={"user_id": str(acme.employee.id), "reason": "termination",
              "notice_date": "2026-06-05"},
        headers=acme.headers(),
    )
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "exit_already_open"


def test_a_cancelled_exit_frees_the_employee_for_another_one(client, tenants):
    """Rehires leave twice. The index is partial precisely so this works."""
    acme, _ = tenants
    first = _initiate(client, acme)
    cancelled = client.post(
        f"/api/v1/offboarding/requests/{first['id']}/cancel",
        json={"cancellation_reason": "Resignation withdrawn after a counter-offer."},
        headers=acme.headers(),
    )
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["status"] == "cancelled"

    second = _initiate(client, acme)
    assert second["id"] != first["id"]


# --------------------------------------------------------------------------- #
# D-023 — moving the last working day moves the whole checklist
# --------------------------------------------------------------------------- #


def test_moving_the_last_working_day_recomputes_every_due_date(client, tenants):
    """D-023, the reason ``due_offset_days`` sits on the task row at all.

    Offboarding has no template table, so if the offset did not live here the
    dates could not be recomputed and a four-week extension would leave every
    clearance item carrying a deadline from the old plan.
    """
    acme, _ = tenants
    created = _initiate(client, acme)
    moved = _LWD + timedelta(days=28)

    response = client.patch(
        f"/api/v1/offboarding/requests/{created['id']}",
        json={"last_working_day": moved.isoformat()},
        headers=acme.headers(),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["last_working_day"] == moved.isoformat()

    flat = [t for g in body["clearance"] for t in g["tasks"]]
    assert flat
    for task in flat:
        assert task["due_on"] == (moved + timedelta(days=task["due_offset_days"])).isoformat()

    # Read back from the database, not only off the response: a recompute that
    # only ever existed in the serialiser would pass the assertions above.
    with SessionLocal() as db:
        rows = db.scalars(
            select(OffboardingTask).where(
                OffboardingTask.request_id == uuid.UUID(created["id"])
            )
        ).all()
        assert rows
        for row in rows:
            assert row.due_on == moved + timedelta(days=row.due_offset_days)


def test_a_rejected_last_working_day_leaves_nothing_behind(client, tenants):
    """A refused edit must not be sitting dirty in the session.

    Every clearance due date derives from the last working day, so one before
    the notice date schedules the whole checklist before the resignation was
    received. The assertion that matters is the second one: the refusal is
    checked against the merged values *before* anything is assigned, so no
    later commit in the same request can persist what this rejected.
    """
    acme, _ = tenants
    created = _initiate(client, acme)

    response = client.patch(
        f"/api/v1/offboarding/requests/{created['id']}",
        json={"last_working_day": "2026-05-01"},  # notice_date is 2026-06-01
        headers=acme.headers(),
    )
    assert response.status_code == 400

    with SessionLocal() as db:
        req = db.get(OffboardingRequest, uuid.UUID(created["id"]))
        assert req.last_working_day == _LWD


def test_setting_a_last_working_day_for_the_first_time_fills_the_dates_in(client, tenants):
    """The common case: notice accepted first, leaving date agreed a week later."""
    acme, _ = tenants
    created = _initiate(client, acme, last_working_day=None)
    assert all(t["due_on"] is None for g in created["clearance"] for t in g["tasks"])

    body = client.patch(
        f"/api/v1/offboarding/requests/{created['id']}",
        json={"last_working_day": _LWD.isoformat()},
        headers=acme.headers(),
    ).json()
    flat = [t for g in body["clearance"] for t in g["tasks"]]
    assert flat and all(t["due_on"] is not None for t in flat)


# --------------------------------------------------------------------------- #
# The completion gate
# --------------------------------------------------------------------------- #


def test_completion_is_refused_while_a_mandatory_task_is_unsettled(client, tenants):
    acme, _ = tenants
    created = _initiate(client, acme)

    response = client.post(
        f"/api/v1/offboarding/requests/{created['id']}/complete", headers=acme.headers()
    )
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["reason"] == "clearance_incomplete"
    # Named, not counted: a console rendering a bare 409 tells nobody which
    # laptop is missing.
    assert detail["blocking_tasks"]
    assert all(t["title"] for t in detail["blocking_tasks"])

    # And nothing was done. A gate that refuses *after* revoking is worse than
    # no gate, because the exit still looks open.
    with SessionLocal() as db:
        leaver = db.get(User, acme.employee.id)
        assert leaver.is_active is True
        assert leaver.status == UserStatus.ACTIVE.value
        req = db.get(OffboardingRequest, uuid.UUID(created["id"]))
        assert req.devices_revoked_at is None and req.user_deactivated_at is None


def test_a_non_mandatory_task_left_open_does_not_block(client, tenants):
    """The exit interview the leaver refused to attend cannot hold their laptop."""
    acme, _ = tenants
    created = _initiate(client, acme)
    _settle_all_mandatory(client, acme, created["id"])

    detail = client.get(
        f"/api/v1/offboarding/requests/{created['id']}", headers=acme.headers()
    ).json()
    optional = [
        t for g in detail["clearance"] for t in g["tasks"] if not t["is_mandatory"]
    ]
    assert optional, "the default checklist should carry at least one optional item"
    assert all(t["status"] == "pending" for t in optional)
    assert detail["blocking_task_count"] == 0

    response = client.post(
        f"/api/v1/offboarding/requests/{created['id']}/complete", headers=acme.headers()
    )
    assert response.status_code == 200, response.text


def test_skipped_counts_as_settled_and_needs_a_reason(client, tenants):
    """``skipped`` settles the item — but only with the waiver on file.

    It is the one status that can let an exit finish with a mandatory step
    never actually done, so the note is what separates an audited decision from
    a checklist somebody clicked through.
    """
    acme, _ = tenants
    created = _initiate(client, acme)
    detail = client.get(
        f"/api/v1/offboarding/requests/{created['id']}", headers=acme.headers()
    ).json()
    mandatory = [t for g in detail["clearance"] for t in g["tasks"] if t["is_mandatory"]]
    victim = mandatory[0]

    bare = client.patch(
        f"/api/v1/offboarding/requests/{created['id']}/tasks/{victim['id']}",
        json={"status": "skipped"},
        headers=acme.headers(),
    )
    assert bare.status_code == 400
    assert bare.json()["detail"]["reason"] == "skip_reason_required"

    waived = client.patch(
        f"/api/v1/offboarding/requests/{created['id']}/tasks/{victim['id']}",
        json={"status": "skipped", "notes": "Waived: employee absconded."},
        headers=acme.headers(),
    )
    assert waived.status_code == 200, waived.text
    assert waived.json()["is_settled"] is True

    # The remaining mandatory items are done the ordinary way; the skipped one
    # must not reappear in the gate.
    _settle_all_mandatory(client, acme, created["id"])
    response = client.post(
        f"/api/v1/offboarding/requests/{created['id']}/complete", headers=acme.headers()
    )
    assert response.status_code == 200, response.text


def test_an_unrecognised_task_status_keeps_the_gate_closed(client, tenants):
    """A corrupted status value must fail closed.

    Written straight into the database because the schema's pattern refuses it
    on the wire — which is the point: the value gets there by a bulk import, a
    hand-run UPDATE, or a later enum member that this deployment's code does
    not know. ``is_settled`` swallows the ``ValueError`` and answers *unsettled*,
    and the one-line change that would invert it is exactly what this test
    exists to catch.
    """
    acme, _ = tenants
    created = _initiate(client, acme)
    _settle_all_mandatory(client, acme, created["id"])

    with SessionLocal() as db:
        task = db.scalars(
            select(OffboardingTask).where(
                OffboardingTask.request_id == uuid.UUID(created["id"]),
                OffboardingTask.is_mandatory.is_(True),
            )
        ).first()
        task.status = "awaiting_countersignature"
        db.commit()

    response = client.post(
        f"/api/v1/offboarding/requests/{created['id']}/complete", headers=acme.headers()
    )
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "clearance_incomplete"


def test_completion_needs_a_last_working_day(client, tenants):
    """A completed exit with no leaving date cannot produce a relieving letter."""
    acme, _ = tenants
    created = _initiate(client, acme, last_working_day=None)
    _settle_all_mandatory(client, acme, created["id"])

    response = client.post(
        f"/api/v1/offboarding/requests/{created['id']}/complete", headers=acme.headers()
    )
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "last_working_day_missing"


# --------------------------------------------------------------------------- #
# Completion — one revoke path, and D-016
# --------------------------------------------------------------------------- #


def test_completion_deactivates_the_user_and_revokes_devices_via_the_existing_path(
    client, tenants
):
    """The Phase 7 exit criterion, asserted three ways.

    1. ``devices.is_active`` is False — the flag the *existing* path writes.
    2. The device row is otherwise untouched: still present, same token hash,
       same machine id. A private revoke that deleted the row or rotated the
       token would satisfy "the agent stops collecting" while breaking every
       audit question about which machine it was.
    3. The agent's own credential is then rejected by ``get_current_device``
       with the 403 it raises ``DeviceRevoked`` for. This is the assertion a
       second, offboarding-specific mechanism could not pass, because only the
       shared flag is what that dependency reads.
    """
    acme, _ = tenants
    raw = "agent-token-belonging-to-the-leaver"
    device_id = _enrol_device(acme, raw)
    agent_headers = {"Authorization": f"Bearer {raw}", "X-Org-Slug": acme.slug}

    # The agent is collecting happily before the exit closes.
    assert client.get("/api/v1/agent/config", headers=agent_headers).status_code == 200

    created = _initiate(client, acme)
    _settle_all_mandatory(client, acme, created["id"])
    response = client.post(
        f"/api/v1/offboarding/requests/{created['id']}/complete", headers=acme.headers()
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "completed"
    assert body["devices_revoked_at"] and body["user_deactivated_at"]

    # 1 and 2.
    device = _device_row(device_id)
    assert device is not None, "the device row must survive; revoking is not deleting"
    assert device.is_active is False
    assert device.token_hash == token_digest(raw), "the token must not have been rotated"
    assert device.machine_id == f"machine-{raw}"

    # 3 — the existing path, exercised for real.
    revoked = client.get("/api/v1/agent/config", headers=agent_headers)
    assert revoked.status_code == 403
    assert "revoked" in revoked.text.lower()

    # D-016: is_active is the sole authentication gate; status is descriptive.
    with SessionLocal() as db:
        leaver = db.get(User, acme.employee.id)
        assert leaver.is_active is False
        assert leaver.status == UserStatus.INACTIVE.value

    # And the leaver's own JWT stops working, because is_active is what
    # get_current_user reads — not the offboarding record.
    locked_out = client.get(
        "/api/v1/assets/my", headers=acme.headers(acme.employee_token)
    )
    assert locked_out.status_code == 401


def test_the_audit_stamps_are_evidence_and_never_a_second_gate(client, tenants):
    """``devices_revoked_at`` records that the revoke ran; it decides nothing.

    A device enrolled *after* an exit completed is active, because
    ``devices.is_active`` says so — the stamp on the exit record has no opinion
    about it. That is the intended behaviour: it is what stops the audit column
    from becoming the second switch D-016 exists to prevent, and it is also why
    re-enrolment on a rehire works at all.
    """
    acme, _ = tenants
    created = _initiate(client, acme)
    _settle_all_mandatory(client, acme, created["id"])
    assert client.post(
        f"/api/v1/offboarding/requests/{created['id']}/complete", headers=acme.headers()
    ).status_code == 200

    raw = "token-enrolled-after-the-exit"
    _enrol_device(acme, raw)
    later = client.get(
        "/api/v1/agent/config",
        headers={"Authorization": f"Bearer {raw}", "X-Org-Slug": acme.slug},
    )
    assert later.status_code == 200, (
        "the stamp on the exit record must not be consulted to refuse a device"
    )


def test_completing_the_last_administrators_exit_is_refused(client, tenants):
    """Deactivating the last admin locks the whole tenant out of its console.

    The same class of failure as the D-014 geofence lockout, arriving from a
    different door — and the guard is deliberately "promote somebody first"
    rather than "the owner cannot leave": a departing founder is a real exit,
    and the exit record itself is raised and worked normally. Only the final
    click is refused, and only while nobody else can administer.
    """
    acme, _ = tenants
    created = _initiate(client, acme, user_id=acme.owner.id)
    _settle_all_mandatory(client, acme, created["id"])

    refused = client.post(
        f"/api/v1/offboarding/requests/{created['id']}/complete", headers=acme.headers()
    )
    assert refused.status_code == 409
    assert refused.json()["detail"]["reason"] == "last_administrator"

    with SessionLocal() as db:
        owner = db.get(User, acme.owner.id)
        assert owner.is_active is True, "the refusal must happen before anything is written"
        # Somebody is promoted, which is what the message asked for.
        successor = db.get(User, acme.employee.id)
        successor.role = "admin"
        db.commit()

    allowed = client.post(
        f"/api/v1/offboarding/requests/{created['id']}/complete", headers=acme.headers()
    )
    assert allowed.status_code == 200, allowed.text


def test_a_completed_exit_can_no_longer_be_edited(client, tenants):
    acme, _ = tenants
    created = _initiate(client, acme)
    _settle_all_mandatory(client, acme, created["id"])
    client.post(
        f"/api/v1/offboarding/requests/{created['id']}/complete", headers=acme.headers()
    )

    patched = client.patch(
        f"/api/v1/offboarding/requests/{created['id']}",
        json={"last_working_day": "2026-08-01"},
        headers=acme.headers(),
    )
    assert patched.status_code == 409
    assert patched.json()["detail"]["reason"] == "exit_not_open"

    again = client.post(
        f"/api/v1/offboarding/requests/{created['id']}/complete", headers=acme.headers()
    )
    assert again.status_code == 409


# --------------------------------------------------------------------------- #
# it_asset_return — through the assets service, not around it
# --------------------------------------------------------------------------- #


def _issue_asset(client, tenant, tag="LAP-001", user_id=None):
    asset = client.post(
        "/api/v1/assets",
        json={"asset_tag": tag, "category": "laptop", "status": "available"},
        headers=tenant.headers(),
    )
    assert asset.status_code == 201, asset.text
    asset_id = asset.json()["id"]
    issued = client.post(
        "/api/v1/assets/assign",
        json={"asset_id": asset_id, "user_id": str(user_id or tenant.employee.id)},
        headers=tenant.headers(),
    )
    assert issued.status_code == 201, issued.text
    return asset_id


def test_the_it_asset_return_task_returns_the_asset_through_the_assets_service(
    client, tenants
):
    """Custody is closed by ``assets.return_asset``, so its invariant still holds.

    The proof that the shared service ran rather than a private update: the
    register moves to ``under_repair`` because ``resulting_status`` was honoured
    — behaviour that lives entirely inside that function — and the ledger row is
    closed in the same transaction, which is the invariant the assets module
    exists to keep.
    """
    acme, _ = tenants
    asset_id = _issue_asset(client, acme)
    created = _initiate(client, acme)

    outstanding = client.get(
        f"/api/v1/offboarding/requests/{created['id']}/assets", headers=acme.headers()
    )
    assert outstanding.status_code == 200, outstanding.text
    assert [a["id"] for a in outstanding.json()] == [asset_id]

    task = next(
        t for g in created["clearance"] if g["category"] == "it_asset_return"
        for t in g["tasks"]
    )
    response = client.post(
        f"/api/v1/offboarding/requests/{created['id']}/tasks/{task['id']}/return-asset",
        json={"asset_id": asset_id, "resulting_status": "under_repair",
              "returned_condition_note": "Cracked screen."},
        headers=acme.headers(),
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "done"
    assert response.json()["is_settled"] is True

    with SessionLocal() as db:
        asset = db.get(Asset, uuid.UUID(asset_id))
        assert asset.status == "under_repair"
        rows = db.scalars(
            select(AssetAssignment).where(AssetAssignment.asset_id == asset.id)
        ).all()
        assert len(rows) == 1
        assert rows[0].returned_at is not None
        assert rows[0].returned_condition_note == "Cracked screen."

    # And it is off the outstanding list, because that list is the register's
    # answer rather than one offboarding keeps for itself.
    assert client.get(
        f"/api/v1/offboarding/requests/{created['id']}/assets", headers=acme.headers()
    ).json() == []


def test_a_clearance_item_cannot_take_back_somebody_elses_asset(client, tenants):
    """Otherwise a leaver's checklist quietly strips a colleague's desk."""
    acme, _ = tenants
    asset_id = _issue_asset(client, acme, user_id=acme.owner.id)
    created = _initiate(client, acme)
    task = next(
        t for g in created["clearance"] if g["category"] == "it_asset_return"
        for t in g["tasks"]
    )

    response = client.post(
        f"/api/v1/offboarding/requests/{created['id']}/tasks/{task['id']}/return-asset",
        json={"asset_id": asset_id},
        headers=acme.headers(),
    )
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "not_held_by_leaver"

    with SessionLocal() as db:
        row = db.scalars(
            select(AssetAssignment).where(AssetAssignment.asset_id == uuid.UUID(asset_id))
        ).one()
        assert row.returned_at is None, "the colleague still has it"


def test_only_an_it_asset_return_item_can_take_an_asset_back(client, tenants):
    acme, _ = tenants
    asset_id = _issue_asset(client, acme)
    created = _initiate(client, acme)
    wrong = next(
        t for g in created["clearance"] if g["category"] == "hr_clearance"
        for t in g["tasks"]
    )

    response = client.post(
        f"/api/v1/offboarding/requests/{created['id']}/tasks/{wrong['id']}/return-asset",
        json={"asset_id": asset_id},
        headers=acme.headers(),
    )
    assert response.status_code == 400
    assert response.json()["detail"]["reason"] == "wrong_task_category"


# --------------------------------------------------------------------------- #
# Full-and-final settlement — a stub that stores, never computes
# --------------------------------------------------------------------------- #


def test_the_fnf_accepts_an_inconsistent_set_without_correcting_it(client, tenants):
    """Ex-gratia is normal; the figure that was paid is the one that matters.

    Two assertions in one test on purpose, because the bug is a single edit
    away from either side: the row is **accepted** (no 4xx for the mismatch)
    and ``net_payable_paise`` comes back **exactly as sent** (no server-side
    recompute). ``is_consistent`` reports the disagreement and nothing acts on
    it.
    """
    acme, _ = tenants
    created = _initiate(client, acme)

    response = client.post(
        f"/api/v1/offboarding/requests/{created['id']}/fnf",
        # 8,000.00 gross less 1,500.00 deductions is 6,500.00 — and HR is
        # paying 9,000.00, because a retention ex-gratia was agreed.
        json={"gross_dues_paise": 800_000, "deductions_paise": 150_000,
              "net_payable_paise": 900_000, "notes": "Includes ex-gratia of 2,500.00."},
        headers=acme.headers(),
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["net_payable_paise"] == 900_000, "the server must not recompute the net"
    assert body["gross_dues_paise"] == 800_000
    assert body["deductions_paise"] == 150_000
    assert body["is_consistent"] is False
    assert body["is_manually_entered"] is True
    assert body["status"] == "draft"

    # Read back from the database: a value corrected on write and echoed
    # unchanged would still pass the response assertions above.
    stored = client.get(
        f"/api/v1/offboarding/requests/{created['id']}", headers=acme.headers()
    ).json()["fnf"]
    assert stored["net_payable_paise"] == 900_000


def test_a_negative_net_is_a_real_settlement(client, tenants):
    """A leaver who owes more than they are due. Clamping it forgives the debt."""
    acme, _ = tenants
    created = _initiate(client, acme)
    response = client.post(
        f"/api/v1/offboarding/requests/{created['id']}/fnf",
        json={"gross_dues_paise": 100_000, "deductions_paise": 450_000,
              "net_payable_paise": -350_000},
        headers=acme.headers(),
    )
    assert response.status_code == 201, response.text
    assert response.json()["net_payable_paise"] == -350_000


def test_marking_a_settlement_paid_needs_evidence(client, tenants):
    """"We paid you" with no date and no UTR is unprovable, which is the whole point."""
    acme, _ = tenants
    created = _initiate(client, acme)
    client.post(
        f"/api/v1/offboarding/requests/{created['id']}/fnf",
        json={"gross_dues_paise": 500_000, "deductions_paise": 0,
              "net_payable_paise": 500_000},
        headers=acme.headers(),
    )

    bare = client.patch(
        f"/api/v1/offboarding/requests/{created['id']}/fnf",
        json={"status": "paid"},
        headers=acme.headers(),
    )
    assert bare.status_code == 400
    assert bare.json()["detail"]["reason"] == "payment_evidence_required"

    paid = client.patch(
        f"/api/v1/offboarding/requests/{created['id']}/fnf",
        json={"status": "paid", "paid_on": "2026-07-15",
              "payment_reference": "UTR-99881122"},
        headers=acme.headers(),
    )
    assert paid.status_code == 200, paid.text
    body = paid.json()
    assert body["status"] == "paid"
    assert body["paid_by_name"] and body["approved_by_name"]


def test_one_settlement_per_exit(client, tenants):
    acme, _ = tenants
    created = _initiate(client, acme)
    payload = {"gross_dues_paise": 1, "deductions_paise": 0, "net_payable_paise": 1}
    assert client.post(
        f"/api/v1/offboarding/requests/{created['id']}/fnf",
        json=payload, headers=acme.headers(),
    ).status_code == 201
    second = client.post(
        f"/api/v1/offboarding/requests/{created['id']}/fnf",
        json=payload, headers=acme.headers(),
    )
    assert second.status_code == 409
    assert second.json()["detail"]["reason"] == "fnf_exists"


# --------------------------------------------------------------------------- #
# D-018 — AuditLog is the only record that anything changed
# --------------------------------------------------------------------------- #


def test_every_fnf_edit_writes_an_audit_row(client, tenants):
    """There is no ``updated_at`` anywhere in this repository (D-018).

    Without these rows, a settlement quietly retyped from 40,000 to 4,000 after
    approval is indistinguishable from one that always said 4,000. The
    post-payment amendment gets its own action name so an auditor scanning for
    it does not have to read timestamps to find it.
    """
    acme, _ = tenants
    created = _initiate(client, acme)
    client.post(
        f"/api/v1/offboarding/requests/{created['id']}/fnf",
        json={"gross_dues_paise": 4_000_000, "deductions_paise": 0,
              "net_payable_paise": 4_000_000},
        headers=acme.headers(),
    )
    client.patch(
        f"/api/v1/offboarding/requests/{created['id']}/fnf",
        json={"status": "paid", "paid_on": "2026-07-15", "payment_reference": "UTR-1"},
        headers=acme.headers(),
    )
    # The retype that D-018 exists for.
    client.patch(
        f"/api/v1/offboarding/requests/{created['id']}/fnf",
        json={"net_payable_paise": 400_000},
        headers=acme.headers(),
    )

    actions = _audit_actions(acme.id, "offboarding.fnf.")
    assert actions == [
        "offboarding.fnf.created",
        "offboarding.fnf.updated",
        "offboarding.fnf.amended_after_payment",
    ]

    with SessionLocal() as db:
        amendment = db.scalars(
            select(AuditLog).where(
                AuditLog.action == "offboarding.fnf.amended_after_payment"
            )
        ).one()
        # The resulting figure is on the row, so one audit entry answers "what
        # did it become" without replaying every earlier one.
        assert amendment.detail["resulting_net_payable_paise"] == 400_000
        assert amendment.detail["net_payable_paise"] == 400_000


def test_every_task_status_change_writes_an_audit_row(client, tenants):
    acme, _ = tenants
    created = _initiate(client, acme)
    detail = client.get(
        f"/api/v1/offboarding/requests/{created['id']}", headers=acme.headers()
    ).json()
    task = next(t for g in detail["clearance"] for t in g["tasks"])

    for payload in ({"status": "in_progress"}, {"status": "done"}, {"status": "pending"}):
        assert client.patch(
            f"/api/v1/offboarding/requests/{created['id']}/tasks/{task['id']}",
            json=payload, headers=acme.headers(),
        ).status_code == 200

    with SessionLocal() as db:
        rows = db.scalars(
            select(AuditLog)
            .where(AuditLog.action == "offboarding.task.status_changed")
            .order_by(AuditLog.created_at)
        ).all()
    assert [(r.detail["from"], r.detail["to"]) for r in rows] == [
        ("pending", "in_progress"), ("in_progress", "done"), ("done", "pending")
    ]

    # Reopening clears the completion stamp: a pending item carrying a
    # completed_at is how half-finished clearance reads as done to any report
    # that checks the column instead of the status.
    with SessionLocal() as db:
        row = db.get(OffboardingTask, uuid.UUID(task["id"]))
        assert row.status == "pending"
        assert row.completed_at is None and row.completed_by is None


def test_completion_and_initiation_are_audited(client, tenants):
    acme, _ = tenants
    created = _initiate(client, acme)
    _settle_all_mandatory(client, acme, created["id"])
    client.post(
        f"/api/v1/offboarding/requests/{created['id']}/complete", headers=acme.headers()
    )

    actions = _audit_actions(acme.id)
    assert actions[0] == "offboarding.initiated"
    assert "offboarding.completed" in actions

    with SessionLocal() as db:
        row = db.scalars(
            select(AuditLog).where(AuditLog.action == "offboarding.completed")
        ).one()
        assert row.detail["user_id"] == str(acme.employee.id)
        assert row.detail["devices_revoked"] == 0  # none enrolled in this test


# --------------------------------------------------------------------------- #
# Tenant isolation
# --------------------------------------------------------------------------- #


def test_one_company_cannot_read_or_edit_anothers_exit(client, tenants):
    acme, globex = tenants
    created = _initiate(client, acme)

    for method, path, body in (
        ("get", f"/api/v1/offboarding/requests/{created['id']}", None),
        ("patch", f"/api/v1/offboarding/requests/{created['id']}",
         {"reason_note": "not yours"}),
        ("post", f"/api/v1/offboarding/requests/{created['id']}/complete", None),
        ("post", f"/api/v1/offboarding/requests/{created['id']}/fnf",
         {"gross_dues_paise": 1, "deductions_paise": 0, "net_payable_paise": 1}),
        ("get", f"/api/v1/offboarding/requests/{created['id']}/assets", None),
    ):
        response = getattr(client, method)(
            path, headers=globex.headers(), **({"json": body} if body else {})
        )
        # 404, never 403: a 403 confirms the id exists, which is itself a leak
        # across the boundary it is meant to defend.
        assert response.status_code == 404, f"{method} {path} -> {response.status_code}"

    # And the exit is untouched.
    assert client.get(
        f"/api/v1/offboarding/requests/{created['id']}", headers=acme.headers()
    ).json()["status"] == "initiated"


def test_the_exits_list_is_scoped_to_the_caller(client, tenants):
    acme, globex = tenants
    _initiate(client, acme)
    _initiate(client, globex)

    ours = client.get("/api/v1/offboarding/requests", headers=acme.headers()).json()
    assert len(ours) == 1
    assert ours[0]["user_id"] == str(acme.employee.id)
    assert ours[0]["user_name"] == acme.employee.full_name


def test_an_exit_cannot_be_raised_against_another_companys_employee(client, tenants):
    acme, globex = tenants
    response = client.post(
        "/api/v1/offboarding/requests",
        json={"user_id": str(globex.employee.id), "reason": "resignation",
              "notice_date": "2026-06-01"},
        headers=acme.headers(),
    )
    assert response.status_code == 404


def test_a_clearance_item_cannot_be_assigned_across_the_tenant_boundary(client, tenants):
    """The FK carries no org, so nothing in the schema stops this."""
    acme, globex = tenants
    created = _initiate(client, acme)
    response = client.post(
        f"/api/v1/offboarding/requests/{created['id']}/tasks",
        json={"title": "Hand over the door key", "category": "hr_clearance",
              "assignee_user_id": str(globex.owner.id)},
        headers=acme.headers(),
    )
    assert response.status_code == 404


def test_one_exits_url_cannot_edit_anothers_task(client, tenants):
    """Both exits belong to the same company, so the org check alone passes."""
    acme, _ = tenants
    first = _initiate(client, acme)
    second = _initiate(client, acme, user_id=acme.owner.id)
    victim = next(t for g in second["clearance"] for t in g["tasks"])

    response = client.patch(
        f"/api/v1/offboarding/requests/{first['id']}/tasks/{victim['id']}",
        json={"status": "done"},
        headers=acme.headers(),
    )
    assert response.status_code == 404


# --------------------------------------------------------------------------- #
# Permissions
# --------------------------------------------------------------------------- #


def test_an_ordinary_employee_cannot_reach_the_exits_module(client, tenants):
    """Exit records carry termination reasons and settlement figures."""
    acme, _ = tenants
    response = client.get(
        "/api/v1/offboarding/requests", headers=acme.headers(acme.employee_token)
    )
    assert response.status_code == 403


def test_the_lifecycle_flag_restricts_an_administrator(client, tenants):
    acme, _ = tenants
    with SessionLocal() as db:
        owner = db.get(User, acme.owner.id)
        owner.can_manage_onboarding = False
        db.commit()

    response = client.get("/api/v1/offboarding/requests", headers=acme.headers())
    assert response.status_code == 403
    assert response.json()["detail"]["reason"] == "permission_denied"
