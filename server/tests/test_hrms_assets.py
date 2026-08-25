"""Asset register and custody lifecycle.

The exit criterion in the plan is "an asset can't be double-assigned". That is
the *easy* half and the database already enforces it, so a suite that stopped
there would pass while the register quietly lied about who holds what.

What these tests are actually built around is the invariant nothing in the
schema can express: ``assets.status == 'assigned'`` **iff an open assignment
exists**. The partial unique index constrains the ledger alone and has no
opinion about the register column, so the agreement between the two is service
code and nothing else — which means it can only be defended by asserting on
*both* after every state change, including the changes that failed.
``test_status_and_ledger_agree_*`` are that assertion, and the failed-assign
one is the one that catches the realistic bug: a status write that lands
outside the transaction the ledger insert rolls back.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.db.session import SessionLocal
from app.models import Asset, AssetAssignment, User
from app.schemas.assets import AssetAssignmentIn
from app.services import assets as svc


@pytest.fixture(scope="module", autouse=True)
def _assets_router_mounted():
    """Mount the router if the lead has not wired it into ``router.py`` yet.

    Phase 8's backend landed before the integration seam did, and seven cryptic
    404s say nothing about whether the module works. This registers the real
    router on the real app so the behaviour below is exercised for real, and it
    is a no-op the moment ``api/v1/router.py`` includes it — which
    ``test_router_is_registered_for_integration`` asserts separately, so the
    shim can never hide a missing registration.
    """
    from app.api.v1 import assets as assets_api
    from app.main import app

    if not any(getattr(r, "path", "").startswith("/api/v1/assets") for r in app.routes):
        app.include_router(assets_api.router, prefix="/api/v1")
        app.openapi_schema = None
    yield


def test_router_is_registered_for_integration():
    """Fails until the lead adds assets to ``api/v1/router.py``. Deliberate.

    Checked against the router module rather than the app, so the shim above
    cannot satisfy it.
    """
    from app.api.v1.router import api_router

    paths = {getattr(route, "path", "") for route in api_router.routes}
    assert any(path.startswith("/api/v1/assets") for path in paths), (
        "app/api/v1/router.py does not include assets.router — see the Phase 8 "
        "integration request"
    )


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _register_state(asset_id) -> tuple[str, list[uuid.UUID]]:
    """``(assets.status, [user_id of every OPEN ledger row])``, read fresh.

    Both halves in one read, from a session the request never touched, because
    asserting on the API response alone would let a status that was never
    actually committed pass.
    """
    with SessionLocal() as db:
        asset = db.get(Asset, uuid.UUID(str(asset_id)))
        holders = db.scalars(
            select(AssetAssignment.user_id).where(
                AssetAssignment.asset_id == asset.id,
                AssetAssignment.returned_at.is_(None),
            )
        ).all()
        return asset.status, list(holders)


@pytest.fixture
def laptop(client, tenants):
    acme, _ = tenants
    response = client.post(
        "/api/v1/assets",
        json={
            "asset_tag": "LAP-001",
            "category": "laptop",
            "serial_number": "SN-0001",
            "purchase_date": "2024-04-01",
        },
        headers=acme.headers(),
    )
    assert response.status_code == 201, response.text
    return response.json()


def _assign(client, tenant, asset_id, user_id, **extra):
    return client.post(
        "/api/v1/assets/assign",
        json={"asset_id": str(asset_id), "user_id": str(user_id), **extra},
        headers=tenant.headers(),
    )


def _return(client, tenant, asset_id, **extra):
    return client.post(
        f"/api/v1/assets/{asset_id}/return", json=extra, headers=tenant.headers()
    )


# --------------------------------------------------------------------------- #
# The single-open-assignment invariant
# --------------------------------------------------------------------------- #


def test_double_assign_is_rejected(client, tenants, laptop):
    acme, _ = tenants
    assert _assign(client, acme, laptop["id"], acme.employee.id).status_code == 201

    second = _assign(client, acme, laptop["id"], acme.owner.id)
    assert second.status_code == 409, second.text


def test_reassign_after_return_is_accepted(client, tenants, laptop):
    """The half a plain unique index would have broken forever."""
    acme, _ = tenants
    assert _assign(client, acme, laptop["id"], acme.employee.id).status_code == 201
    assert _return(client, acme, laptop["id"]).status_code == 200
    again = _assign(client, acme, laptop["id"], acme.owner.id)
    assert again.status_code == 201, again.text

    history = client.get(
        f"/api/v1/assets/{laptop['id']}/history", headers=acme.headers()
    ).json()
    # Two custody periods, newest first, exactly one of them still open.
    assert [row["is_open"] for row in history] == [True, False]


# --------------------------------------------------------------------------- #
# Status / ledger agreement — the class of bug the stated exit criterion misses
# --------------------------------------------------------------------------- #


def test_status_and_ledger_agree_after_assign_and_return(client, tenants, laptop):
    acme, _ = tenants

    assert _register_state(laptop["id"]) == ("available", [])

    assert _assign(client, acme, laptop["id"], acme.employee.id).status_code == 201
    assert _register_state(laptop["id"]) == ("assigned", [acme.employee.id])

    assert _return(client, acme, laptop["id"]).status_code == 200
    assert _register_state(laptop["id"]) == ("available", [])


def test_status_and_ledger_agree_after_a_failed_assign(client, tenants, laptop):
    """A rejected assign must leave *both* halves exactly as it found them.

    Three different refusals, because they leave the service at three different
    points and only one of them is the double-assign the plan names.
    """
    acme, globex = tenants

    # 1. Refused for an employee outside the org — before anything is written.
    refused = _assign(client, acme, laptop["id"], globex.employee.id)
    assert refused.status_code == 404
    assert _register_state(laptop["id"]) == ("available", [])

    # 2. Refused because the asset is in the repair queue.
    client.patch(
        f"/api/v1/assets/{laptop['id']}",
        json={"asset_tag": "LAP-001", "category": "laptop", "status": "under_repair"},
        headers=acme.headers(),
    )
    refused = _assign(client, acme, laptop["id"], acme.employee.id)
    assert refused.status_code == 409
    assert _register_state(laptop["id"]) == ("under_repair", [])

    # 3. Refused as a double-assign — the register must still name the first
    #    holder, not be left mid-way through naming the second.
    client.patch(
        f"/api/v1/assets/{laptop['id']}",
        json={"asset_tag": "LAP-001", "category": "laptop", "status": "available"},
        headers=acme.headers(),
    )
    assert _assign(client, acme, laptop["id"], acme.employee.id).status_code == 201
    assert _assign(client, acme, laptop["id"], acme.owner.id).status_code == 409
    assert _register_state(laptop["id"]) == ("assigned", [acme.employee.id])


def test_status_rolls_back_when_the_index_rejects_the_ledger_row(
    client, tenants, laptop, monkeypatch
):
    """The race the partial unique index exists for, and the drift it must not leave.

    Two admins click assign at the same moment. The loser read the asset before
    the winner committed, so its session holds a stale ``available`` and its
    pre-check saw no open row — both service-level guards pass on a snapshot
    that is already wrong. The index is the only thing left, and the question
    this test asks is what the register looks like *after* it fires: the status
    write happens before the flush, so if it were not inside the same
    transaction the rollback would leave the asset marked ``assigned`` to
    nobody, or worse, ``assigned`` while pointing at the loser.

    The guard-2 pre-check is patched out rather than raced with, because the
    window it must be inside is microseconds wide and a test that tried to hit
    it by timing would be the flakiest thing in the suite.
    """
    acme, _ = tenants
    asset_id = uuid.UUID(laptop["id"])

    with SessionLocal() as loser, SessionLocal() as winner:
        actor = loser.get(User, acme.owner.id)
        # The loser's stale snapshot: status is `available` at this instant.
        loser_view = loser.get(Asset, asset_id)
        assert loser_view.status == "available"

        # The winner gets there first and commits both halves.
        winner.add(
            AssetAssignment(org_id=acme.id, asset_id=asset_id, user_id=acme.employee.id)
        )
        winner.get(Asset, asset_id).status = "assigned"
        winner.commit()

        monkeypatch.setattr(svc, "open_assignment", lambda *a, **k: None)
        with pytest.raises(HTTPException) as raised:
            svc.assign_asset(
                loser,
                acme.id,
                AssetAssignmentIn(asset_id=asset_id, user_id=acme.owner.id),
                actor=actor,
            )
        assert raised.value.status_code == 409

    # One open row, held by the winner, and a status that agrees with it.
    assert _register_state(asset_id) == ("assigned", [acme.employee.id])


def test_editing_an_assigned_asset_cannot_silently_clear_its_status(
    client, tenants, laptop
):
    """The drift path that looks completely innocent.

    ``AssetIn`` cannot express ``assigned``, so a plain serial-number fix on an
    issued laptop necessarily arrives carrying ``available``. Applying it would
    detach the register from a ledger row that is still open.
    """
    acme, _ = tenants
    assert _assign(client, acme, laptop["id"], acme.employee.id).status_code == 201

    edited = client.patch(
        f"/api/v1/assets/{laptop['id']}",
        json={"asset_tag": "LAP-001", "category": "laptop", "serial_number": "SN-CORRECTED"},
        headers=acme.headers(),
    )
    assert edited.status_code == 200
    assert edited.json()["serial_number"] == "SN-CORRECTED"
    assert _register_state(laptop["id"]) == ("assigned", [acme.employee.id])


# --------------------------------------------------------------------------- #
# Return semantics
# --------------------------------------------------------------------------- #


def test_resulting_status_is_honoured(client, tenants, laptop):
    """A cracked screen goes to the repair queue, not back on the shelf."""
    acme, _ = tenants
    assert _assign(client, acme, laptop["id"], acme.employee.id).status_code == 201

    returned = _return(
        client,
        acme,
        laptop["id"],
        resulting_status="under_repair",
        returned_condition_note="Cracked screen, bottom left",
    )
    assert returned.status_code == 200, returned.text
    assert returned.json()["returned_condition_note"] == "Cracked screen, bottom left"
    assert _register_state(laptop["id"]) == ("under_repair", [])

    # And the point of honouring it: the next joiner cannot be handed it.
    blocked = _assign(client, acme, laptop["id"], acme.owner.id)
    assert blocked.status_code == 409


def test_returning_an_unissued_asset_is_refused(client, tenants, laptop):
    acme, _ = tenants
    refused = _return(client, acme, laptop["id"])
    assert refused.status_code == 409


def test_backdated_assign_overlapping_a_closed_period_is_refused(client, tenants, laptop):
    """The gap the partial index leaves open, closed in the service.

    The index constrains open rows only, so the database is perfectly happy to
    accept a handover backdated into a week the asset demonstrably sat on
    somebody else's desk.
    """
    acme, _ = tenants
    now = datetime.now(timezone.utc)
    assert _assign(
        client,
        acme,
        laptop["id"],
        acme.employee.id,
        assigned_at=(now - timedelta(days=30)).isoformat(),
    ).status_code == 201
    assert _return(
        client, acme, laptop["id"], returned_at=(now - timedelta(days=10)).isoformat()
    ).status_code == 200

    overlapping = _assign(
        client,
        acme,
        laptop["id"],
        acme.owner.id,
        assigned_at=(now - timedelta(days=20)).isoformat(),
    )
    assert overlapping.status_code == 409, overlapping.text

    # Handing it on the day it came back is a normal same-day handover, not an
    # overlap, and must still be accepted.
    ok = _assign(
        client,
        acme,
        laptop["id"],
        acme.owner.id,
        assigned_at=(now - timedelta(days=9)).isoformat(),
    )
    assert ok.status_code == 201, ok.text


# --------------------------------------------------------------------------- #
# The employee-facing view
# --------------------------------------------------------------------------- #


def test_my_assets_withholds_procurement_and_return_side_fields(client, tenants, laptop):
    """The schema boundary, asserted from the wire rather than trusted.

    ``purchase_date`` is checked as present on the admin row first, so this
    proves the field is *withheld* rather than merely absent from the fixture.
    """
    acme, _ = tenants
    assert _assign(
        client,
        acme,
        laptop["id"],
        acme.employee.id,
        assigned_condition_note="Small scratch on the lid",
    ).status_code == 201

    admin_row = client.get(
        f"/api/v1/assets/{laptop['id']}", headers=acme.headers()
    ).json()
    assert admin_row["purchase_date"] == "2024-04-01"

    mine = client.get(
        "/api/v1/assets/my", headers=acme.headers(acme.employee_token)
    )
    assert mine.status_code == 200, mine.text
    rows = mine.json()
    assert len(rows) == 1
    row = rows[0]

    assert "purchase_date" not in row
    assert "returned_condition_note" not in row
    # What the holder *is* entitled to: the item, and the condition recorded at
    # handover, which is what they will be asked about at return.
    assert row["asset_tag"] == "LAP-001"
    assert row["assigned_condition_note"] == "Small scratch on the lid"


def test_my_assets_lists_only_open_custody(client, tenants, laptop):
    acme, _ = tenants
    _assign(client, acme, laptop["id"], acme.employee.id)
    _return(client, acme, laptop["id"], returned_condition_note="Keyboard worn")

    mine = client.get("/api/v1/assets/my", headers=acme.headers(acme.employee_token))
    assert mine.json() == []


def test_an_employee_cannot_read_the_register(client, tenants, laptop):
    acme, _ = tenants
    denied = client.get("/api/v1/assets", headers=acme.headers(acme.employee_token))
    assert denied.status_code == 403


# --------------------------------------------------------------------------- #
# Permission flag
# --------------------------------------------------------------------------- #


def test_can_manage_assets_false_blocks_the_register_but_not_your_own_list(
    client, tenants, laptop
):
    """The flag restricts the register; it is not an account-wide switch.

    Somebody taken off asset administration still has a laptop and still has to
    be able to see what they are holding.
    """
    acme, _ = tenants
    _assign(client, acme, laptop["id"], acme.owner.id)

    with SessionLocal() as db:
        db.get(User, acme.owner.id).can_manage_assets = False
        db.commit()

    assert client.get("/api/v1/assets", headers=acme.headers()).status_code == 403
    assert client.post(
        "/api/v1/assets",
        json={"asset_tag": "LAP-002"},
        headers=acme.headers(),
    ).status_code == 403
    assert _assign(client, acme, laptop["id"], acme.employee.id).status_code == 403
    assert _return(client, acme, laptop["id"]).status_code == 403
    assert client.get(
        f"/api/v1/assets/{laptop['id']}/history", headers=acme.headers()
    ).status_code == 403

    own = client.get("/api/v1/assets/my", headers=acme.headers())
    assert own.status_code == 200
    assert own.json()[0]["asset_tag"] == "LAP-001"

    # Nothing was written on the way to any of those 403s.
    assert _register_state(laptop["id"]) == ("assigned", [acme.owner.id])


# --------------------------------------------------------------------------- #
# Tenancy
# --------------------------------------------------------------------------- #


def test_one_org_cannot_see_or_touch_anothers_assets(client, tenants, laptop):
    acme, globex = tenants
    asset_id = laptop["id"]

    assert client.get("/api/v1/assets", headers=globex.headers()).json() == []

    for response in (
        client.get(f"/api/v1/assets/{asset_id}", headers=globex.headers()),
        client.get(f"/api/v1/assets/{asset_id}/history", headers=globex.headers()),
        _assign(client, globex, asset_id, globex.employee.id),
        _return(client, globex, asset_id),
        client.delete(f"/api/v1/assets/{asset_id}", headers=globex.headers()),
    ):
        assert response.status_code == 404, response.text

    # Nor the reverse direction: an admin cannot issue their own asset to
    # somebody in another company.
    assert _assign(client, acme, asset_id, globex.employee.id).status_code == 404
    assert _register_state(asset_id) == ("available", [])


def test_asset_tags_are_unique_per_org_not_globally(client, tenants, laptop):
    """Two tenants both labelling their first laptop LAP-001 is the normal case."""
    _, globex = tenants
    mine = client.post(
        "/api/v1/assets",
        json={"asset_tag": "LAP-001", "category": "laptop"},
        headers=globex.headers(),
    )
    assert mine.status_code == 201, mine.text


def test_duplicate_tag_within_an_org_is_refused(client, tenants, laptop):
    acme, _ = tenants
    clash = client.post(
        "/api/v1/assets",
        json={"asset_tag": "LAP-001", "category": "laptop"},
        headers=acme.headers(),
    )
    assert clash.status_code == 409


def test_deleting_an_asset_with_custody_history_is_refused(client, tenants, laptop):
    """Cascade would take the ledger with it, which is the record itself."""
    acme, _ = tenants
    _assign(client, acme, laptop["id"], acme.employee.id)
    _return(client, acme, laptop["id"])

    refused = client.delete(f"/api/v1/assets/{laptop['id']}", headers=acme.headers())
    assert refused.status_code == 409

    with SessionLocal() as db:
        assert db.get(Asset, uuid.UUID(laptop["id"])) is not None
