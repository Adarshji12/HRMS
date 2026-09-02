"""Meetings.

On a public Jitsi deployment the room name **is** the credential — there is no
password and no lobby. So the assertions that matter are all about that one
string: it never appears in a listing, it is not derived from anything guessable,
and it is only handed to somebody on the invitee list inside the join window.

The other half is the snapshot rule: an invitee list is taken once at scheduling
and does not follow the team afterwards, which is the opposite of how chat
channels work and the thing most likely to be "fixed" by mistake later.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from app.db.session import SessionLocal
from app.models import Meeting, Team, User


def _team(db, org_id, name="Platform") -> Team:
    row = Team(id=uuid.uuid4(), org_id=org_id, name=name)
    db.add(row)
    db.flush()
    return row


def _iso(when: datetime) -> str:
    return when.astimezone(timezone.utc).isoformat()


def _soon(minutes: int = 5) -> datetime:
    return datetime.now(timezone.utc) + timedelta(minutes=minutes)


# --------------------------------------------------------------------------- #
# The room name
# --------------------------------------------------------------------------- #


def test_room_is_never_in_a_listing_or_detail(client, tenants):
    """The one assertion this whole feature rests on."""
    acme, _ = tenants
    created = client.post(
        "/api/v1/meetings",
        json={"title": "Standup", "starts_at": _iso(_soon()),
              "user_ids": [str(acme.employee.id)]},
        headers=acme.headers(),
    )
    assert created.status_code == 201
    assert "room" not in created.json()

    listed = client.get("/api/v1/meetings", headers=acme.headers()).json()
    assert listed and all("room" not in row for row in listed)

    detail = client.get(
        f"/api/v1/meetings/{created.json()['id']}", headers=acme.headers()
    ).json()
    assert "room" not in detail


def test_room_is_random_not_derived(client, tenants):
    """Two meetings with the same title must not share a room.

    A name built from the title and the date — "acme-standup-2026-09-01" — is
    one a stranger reaches on the first try.
    """
    acme, _ = tenants
    rooms = set()
    for _ in range(3):
        made = client.post(
            "/api/v1/meetings",
            json={"title": "Standup", "starts_at": _iso(_soon()),
                  "user_ids": [str(acme.employee.id)]},
            headers=acme.headers(),
        ).json()
        room = client.post(
            f"/api/v1/meetings/{made['id']}/join", headers=acme.headers()
        ).json()["room"]
        assert "standup" not in room.lower()
        assert "acme" not in room.lower()
        rooms.add(room)
    assert len(rooms) == 3


# --------------------------------------------------------------------------- #
# Who may join
# --------------------------------------------------------------------------- #


def test_uninvited_person_gets_404_not_403(client, tenants):
    """The title alone can say more than anybody meant it to."""
    acme, _ = tenants
    with SessionLocal() as db:
        outsider = User(
            id=uuid.uuid4(), org_id=acme.id, email="out@acme.test", full_name="Outsider",
            role="employee", is_active=True, enrollment_key=uuid.uuid4().hex[:16],
        )
        db.add(outsider)
        db.commit()
        outsider_id = outsider.id

    from app.core.security import create_access_token
    token = create_access_token(
        str(outsider_id), {"typ": "user", "org": str(acme.id), "role": "employee"}
    )

    made = client.post(
        "/api/v1/meetings",
        json={"title": "Pay review", "starts_at": _iso(_soon()),
              "user_ids": [str(acme.employee.id)]},
        headers=acme.headers(),
    ).json()

    assert client.get(
        f"/api/v1/meetings/{made['id']}", headers=acme.headers(token)
    ).status_code == 404
    assert client.post(
        f"/api/v1/meetings/{made['id']}/join", headers=acme.headers(token)
    ).status_code == 404


def test_another_company_cannot_reach_it(client, tenants):
    acme, globex = tenants
    made = client.post(
        "/api/v1/meetings",
        json={"title": "Board", "starts_at": _iso(_soon()),
              "user_ids": [str(acme.employee.id)]},
        headers=acme.headers(),
    ).json()
    assert client.post(
        f"/api/v1/meetings/{made['id']}/join", headers=globex.headers()
    ).status_code == 404


def test_join_window_opens_early_and_closes_late(client, tenants):
    acme, _ = tenants

    # Two hours out: too early, and the listing says so.
    future = client.post(
        "/api/v1/meetings",
        json={"title": "Later", "starts_at": _iso(_soon(120)),
              "user_ids": [str(acme.employee.id)]},
        headers=acme.headers(),
    ).json()
    assert future["can_join"] is False
    refused = client.post(f"/api/v1/meetings/{future['id']}/join", headers=acme.headers())
    assert refused.status_code == 409
    assert refused.json()["detail"]["reason"] == "too_early"

    # Ten minutes out: inside the fifteen-minute early window.
    soon = client.post(
        "/api/v1/meetings",
        json={"title": "Now", "starts_at": _iso(_soon(10)),
              "user_ids": [str(acme.employee.id)]},
        headers=acme.headers(),
    ).json()
    assert soon["can_join"] is True
    assert client.post(
        f"/api/v1/meetings/{soon['id']}/join", headers=acme.headers()
    ).status_code == 200

    # Long finished.
    with SessionLocal() as db:
        row = db.get(Meeting, uuid.UUID(soon["id"]))
        row.starts_at = datetime.now(timezone.utc) - timedelta(days=1)
        db.commit()
    over = client.post(f"/api/v1/meetings/{soon['id']}/join", headers=acme.headers())
    assert over.status_code == 409
    assert over.json()["detail"]["reason"] == "over"


def test_cancelled_meeting_cannot_be_joined(client, tenants):
    acme, _ = tenants
    made = client.post(
        "/api/v1/meetings",
        json={"title": "Scrapped", "starts_at": _iso(_soon(5)),
              "user_ids": [str(acme.employee.id)]},
        headers=acme.headers(),
    ).json()

    cancelled = client.post(f"/api/v1/meetings/{made['id']}/cancel", headers=acme.headers())
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "cancelled"
    # The row and its invitees stay — it is still on everybody's list, marked.
    assert cancelled.json()["invitee_count"] == 2

    blocked = client.post(f"/api/v1/meetings/{made['id']}/join", headers=acme.headers())
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["reason"] == "cancelled"


def test_only_the_host_can_cancel(client, tenants):
    acme, _ = tenants
    made = client.post(
        "/api/v1/meetings",
        json={"title": "Mine", "starts_at": _iso(_soon()),
              "user_ids": [str(acme.employee.id)]},
        headers=acme.headers(),
    ).json()
    refused = client.post(
        f"/api/v1/meetings/{made['id']}/cancel", headers=acme.headers(acme.employee_token)
    )
    assert refused.status_code == 403


# --------------------------------------------------------------------------- #
# The snapshot rule
# --------------------------------------------------------------------------- #


def test_invitees_are_seeded_from_a_team_then_frozen(client, tenants):
    """The opposite of a chat channel, deliberately.

    A meeting is an event: "these people, Thursday". Deriving the list from the
    team would rewrite last month's retrospective every time somebody joined.
    """
    acme, _ = tenants
    with SessionLocal() as db:
        team = _team(db, acme.id)
        for uid in (acme.owner.id, acme.employee.id):
            db.get(User, uid).team_id = team.id
        db.commit()
        team_id = team.id

    made = client.post(
        "/api/v1/meetings",
        json={"title": "Retro", "starts_at": _iso(_soon()), "team_id": str(team_id)},
        headers=acme.headers(),
    ).json()
    assert made["invitee_count"] == 2
    assert made["seeded_from"] == "Platform"

    # Somebody new joins the team afterwards.
    with SessionLocal() as db:
        newcomer = User(
            id=uuid.uuid4(), org_id=acme.id, email="new@acme.test", full_name="New Start",
            role="employee", is_active=True, enrollment_key=uuid.uuid4().hex[:16],
            team_id=team_id,
        )
        db.add(newcomer)
        db.commit()

    # The meeting's list is unchanged. It was a snapshot.
    after = client.get(f"/api/v1/meetings/{made['id']}", headers=acme.headers()).json()
    assert after["invitee_count"] == 2
    assert "New Start" not in [row["user_name"] for row in after["invitees"]]


def test_host_is_always_invited(client, tenants):
    """Scheduling a meeting you cannot join is not a reachable state."""
    acme, _ = tenants
    made = client.post(
        "/api/v1/meetings",
        json={"title": "Solo", "starts_at": _iso(_soon()),
              "user_ids": [str(acme.employee.id)]},
        headers=acme.headers(),
    ).json()
    detail = client.get(f"/api/v1/meetings/{made['id']}", headers=acme.headers()).json()
    assert str(acme.owner.id) in [row["user_id"] for row in detail["invitees"]]


def test_scheduling_needs_somebody(client, tenants):
    acme, _ = tenants
    r = client.post(
        "/api/v1/meetings",
        json={"title": "Nobody", "starts_at": _iso(_soon())},
        headers=acme.headers(),
    )
    assert r.status_code == 422


# --------------------------------------------------------------------------- #
# Attendance
# --------------------------------------------------------------------------- #


def test_attendance_stamps_arrival_once(client, tenants):
    acme, _ = tenants
    made = client.post(
        "/api/v1/meetings",
        json={"title": "Standup", "starts_at": _iso(_soon(2)),
              "user_ids": [str(acme.employee.id)]},
        headers=acme.headers(),
    ).json()

    client.post(f"/api/v1/meetings/{made['id']}/join", headers=acme.headers())
    first = client.get(f"/api/v1/meetings/{made['id']}", headers=acme.headers()).json()
    mine = [r for r in first["invitees"] if r["user_id"] == str(acme.owner.id)][0]
    assert mine["joined_at"] is not None
    assert first["attended_count"] == 1

    # Rejoining after a dropout is not a second arrival.
    client.post(f"/api/v1/meetings/{made['id']}/join", headers=acme.headers())
    again = client.get(f"/api/v1/meetings/{made['id']}", headers=acme.headers()).json()
    assert [r for r in again["invitees"]
            if r["user_id"] == str(acme.owner.id)][0]["joined_at"] == mine["joined_at"]
    assert again["attended_count"] == 1


def test_listing_is_scoped_by_invitation_not_by_company(client, tenants):
    """An administrator is not automatically in everybody's one-to-ones."""
    acme, _ = tenants
    client.post(
        "/api/v1/meetings",
        json={"title": "Private", "starts_at": _iso(_soon()),
              "user_ids": [str(acme.employee.id)]},
        headers=acme.headers(acme.employee_token),
    )
    # The employee hosted it, so only they and nobody else are on it.
    theirs = client.get("/api/v1/meetings", headers=acme.headers(acme.employee_token)).json()
    assert [m["title"] for m in theirs] == ["Private"]
    assert client.get("/api/v1/meetings", headers=acme.headers()).json() == []


def test_domain_falls_back_to_the_server_default(client, tenants):
    from app.core.config import settings

    acme, _ = tenants
    made = client.post(
        "/api/v1/meetings",
        json={"title": "Call", "starts_at": _iso(_soon(2)),
              "user_ids": [str(acme.employee.id)]},
        headers=acme.headers(),
    ).json()
    joined = client.post(
        f"/api/v1/meetings/{made['id']}/join", headers=acme.headers()
    ).json()
    assert joined["domain"] == settings.meeting_domain
    assert joined["display_name"] == "Acme Ltd Owner"
