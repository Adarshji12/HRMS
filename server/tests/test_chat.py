"""Team chat.

The assertions worth having are about **who can read what**, because that is the
only way this feature fails badly. A chat bug that loses a message is annoying;
one that shows a team's channel to somebody outside it, or a direct message to a
third person, is the kind that ends a deployment.

So: derived membership actually tracks the org structure, a moved employee loses
access, an inactive one is dropped, and neither the HTTP path nor the socket
ticket will cross a tenant boundary.
"""

from __future__ import annotations

import uuid

from app.db.session import SessionLocal
from app.models import ChatChannel, Department, Team, User


def _team(db, org_id, name="Platform") -> Team:
    row = Team(id=uuid.uuid4(), org_id=org_id, name=name)
    db.add(row)
    db.flush()
    return row


def _department(db, org_id, name="Engineering") -> Department:
    row = Department(id=uuid.uuid4(), org_id=org_id, name=name)
    db.add(row)
    db.flush()
    return row


def _put_on_team(db, user_id, team_id=None, department_id=None) -> None:
    user = db.get(User, user_id)
    if team_id is not None:
        user.team_id = team_id
    if department_id is not None:
        user.department_id = department_id
    db.flush()


# --------------------------------------------------------------------------- #
# Provisioning and membership
# --------------------------------------------------------------------------- #


def test_team_channel_is_provisioned_on_first_listing(client, tenants):
    """No migration seeds channels — the first person to look creates them."""
    acme, _ = tenants
    with SessionLocal() as db:
        team = _team(db, acme.id)
        _put_on_team(db, acme.owner.id, team_id=team.id)
        _put_on_team(db, acme.employee.id, team_id=team.id)
        db.commit()

    body = client.get("/api/v1/chat/channels", headers=acme.headers()).json()
    assert [c["kind"] for c in body] == ["team"]
    assert body[0]["title"] == "Platform"
    # Membership is derived, so it counts both people without anybody having
    # been added to anything.
    assert body[0]["members"] == 2


def test_listing_twice_does_not_create_a_second_channel(client, tenants):
    acme, _ = tenants
    with SessionLocal() as db:
        team = _team(db, acme.id)
        _put_on_team(db, acme.owner.id, team_id=team.id)
        db.commit()

    client.get("/api/v1/chat/channels", headers=acme.headers())
    client.get("/api/v1/chat/channels", headers=acme.headers())
    client.get("/api/v1/chat/channels", headers=acme.headers(acme.employee_token))

    with SessionLocal() as db:
        assert db.query(ChatChannel).filter(ChatChannel.team_id == team.id).count() == 1


def test_person_with_no_team_sees_no_group_channels(client, tenants):
    """Correct rather than empty-by-accident: there is no group to be in yet."""
    acme, _ = tenants
    assert client.get("/api/v1/chat/channels", headers=acme.headers()).json() == []


def test_team_and_department_channels_are_separate(client, tenants):
    acme, _ = tenants
    with SessionLocal() as db:
        team = _team(db, acme.id)
        dept = _department(db, acme.id)
        _put_on_team(db, acme.owner.id, team_id=team.id, department_id=dept.id)
        db.commit()

    kinds = {c["kind"]: c["title"] for c in
             client.get("/api/v1/chat/channels", headers=acme.headers()).json()}
    assert kinds == {"team": "Platform", "department": "Engineering"}


def test_moving_teams_moves_access(client, tenants):
    """The whole point of deriving membership instead of storing it."""
    acme, _ = tenants
    with SessionLocal() as db:
        platform = _team(db, acme.id, "Platform")
        support = _team(db, acme.id, "Support")
        _put_on_team(db, acme.owner.id, team_id=platform.id)
        _put_on_team(db, acme.employee.id, team_id=platform.id)
        db.commit()

    channel_id = client.get(
        "/api/v1/chat/channels", headers=acme.headers()
    ).json()[0]["id"]
    client.post(
        f"/api/v1/chat/channels/{channel_id}/messages",
        json={"body": "morning all"},
        headers=acme.headers(),
    )
    # In the team: can read it.
    assert client.get(
        f"/api/v1/chat/channels/{channel_id}/messages",
        headers=acme.headers(acme.employee_token),
    ).status_code == 200

    with SessionLocal() as db:
        _put_on_team(db, acme.employee.id, team_id=support.id)
        db.commit()

    # Moved off the team: the channel is gone, with no membership row touched.
    assert client.get(
        f"/api/v1/chat/channels/{channel_id}/messages",
        headers=acme.headers(acme.employee_token),
    ).status_code == 404


def test_deactivated_employee_is_not_a_member(client, tenants):
    acme, _ = tenants
    with SessionLocal() as db:
        team = _team(db, acme.id)
        _put_on_team(db, acme.owner.id, team_id=team.id)
        _put_on_team(db, acme.employee.id, team_id=team.id)
        db.commit()

    assert client.get(
        "/api/v1/chat/channels", headers=acme.headers()
    ).json()[0]["members"] == 2

    with SessionLocal() as db:
        db.get(User, acme.employee.id).is_active = False
        db.commit()

    assert client.get(
        "/api/v1/chat/channels", headers=acme.headers()
    ).json()[0]["members"] == 1


# --------------------------------------------------------------------------- #
# Messages
# --------------------------------------------------------------------------- #


def _team_channel(client, tenant):
    with SessionLocal() as db:
        team = _team(db, tenant.id)
        _put_on_team(db, tenant.owner.id, team_id=team.id)
        _put_on_team(db, tenant.employee.id, team_id=team.id)
        db.commit()
    return client.get("/api/v1/chat/channels", headers=tenant.headers()).json()[0]["id"]


def test_post_and_read_a_thread(client, tenants):
    acme, _ = tenants
    channel = _team_channel(client, acme)

    posted = client.post(
        f"/api/v1/chat/channels/{channel}/messages",
        json={"body": "  standup in five  "},
        headers=acme.headers(),
    )
    assert posted.status_code == 201
    # Trimmed, and attributed.
    assert posted.json()["body"] == "standup in five"
    assert posted.json()["user_name"] == "Acme Ltd Owner"

    thread = client.get(
        f"/api/v1/chat/channels/{channel}/messages",
        headers=acme.headers(acme.employee_token),
    ).json()
    assert [m["body"] for m in thread] == ["standup in five"]


def test_empty_message_is_refused(client, tenants):
    acme, _ = tenants
    channel = _team_channel(client, acme)
    r = client.post(
        f"/api/v1/chat/channels/{channel}/messages",
        json={"body": "   "},
        headers=acme.headers(),
    )
    assert r.status_code == 422


def test_unread_counts_and_marking_read(client, tenants):
    acme, _ = tenants
    channel = _team_channel(client, acme)

    for text in ("one", "two"):
        client.post(
            f"/api/v1/chat/channels/{channel}/messages",
            json={"body": text},
            headers=acme.headers(),
        )

    # The author has nothing unread — you have read what you just typed.
    mine = client.get("/api/v1/chat/channels", headers=acme.headers()).json()[0]
    assert mine["unread"] == 0
    assert mine["last_message_preview"] == "two"

    # The colleague has two, having never opened it.
    theirs = client.get(
        "/api/v1/chat/channels", headers=acme.headers(acme.employee_token)
    ).json()[0]
    assert theirs["unread"] == 2

    client.post(f"/api/v1/chat/channels/{channel}/read",
                headers=acme.headers(acme.employee_token))
    after = client.get(
        "/api/v1/chat/channels", headers=acme.headers(acme.employee_token)
    ).json()[0]
    assert after["unread"] == 0


def test_removing_a_message_keeps_its_place_and_blanks_the_body(client, tenants):
    acme, _ = tenants
    channel = _team_channel(client, acme)
    first = client.post(
        f"/api/v1/chat/channels/{channel}/messages",
        json={"body": "sent by mistake"},
        headers=acme.headers(),
    ).json()

    gone = client.delete(f"/api/v1/chat/messages/{first['id']}", headers=acme.headers())
    assert gone.status_code == 200
    assert gone.json()["is_deleted"] is True
    assert gone.json()["body"] == ""

    # Still in the thread, and the text is not served to anybody.
    thread = client.get(
        f"/api/v1/chat/channels/{channel}/messages",
        headers=acme.headers(acme.employee_token),
    ).json()
    assert len(thread) == 1
    assert thread[0]["is_deleted"] is True
    assert thread[0]["body"] == ""


def test_only_the_author_can_remove_a_message(client, tenants):
    """Not managers, not administrators — the owner here IS an administrator."""
    acme, _ = tenants
    channel = _team_channel(client, acme)
    theirs = client.post(
        f"/api/v1/chat/channels/{channel}/messages",
        json={"body": "mine"},
        headers=acme.headers(acme.employee_token),
    ).json()

    assert client.delete(
        f"/api/v1/chat/messages/{theirs['id']}", headers=acme.headers()
    ).status_code == 403


# --------------------------------------------------------------------------- #
# Direct messages
# --------------------------------------------------------------------------- #


def test_direct_channel_is_one_per_pair_whoever_opens_it(client, tenants):
    acme, _ = tenants
    mine = client.post(
        "/api/v1/chat/direct",
        json={"user_id": str(acme.employee.id)},
        headers=acme.headers(),
    ).json()
    theirs = client.post(
        "/api/v1/chat/direct",
        json={"user_id": str(acme.owner.id)},
        headers=acme.headers(acme.employee_token),
    ).json()
    assert mine["id"] == theirs["id"]
    # Named after the other person, so the same row has two titles.
    assert mine["title"] == "Acme Ltd Staff"
    assert theirs["title"] == "Acme Ltd Owner"


def test_a_third_person_cannot_read_a_direct_channel(client, tenants):
    """404, not 403. Confirming it exists is itself the leak."""
    acme, _ = tenants
    with SessionLocal() as db:
        outsider = User(
            id=uuid.uuid4(), org_id=acme.id, email="third@acme.test",
            full_name="Third Wheel", role="employee", is_active=True,
            enrollment_key=uuid.uuid4().hex[:16],
        )
        db.add(outsider)
        db.commit()
        outsider_id = outsider.id

    from app.core.security import create_access_token
    token = create_access_token(
        str(outsider_id), {"typ": "user", "org": str(acme.id), "role": "employee"}
    )

    channel = client.post(
        "/api/v1/chat/direct",
        json={"user_id": str(acme.employee.id)},
        headers=acme.headers(),
    ).json()

    assert client.get(
        f"/api/v1/chat/channels/{channel['id']}/messages", headers=acme.headers(token)
    ).status_code == 404


def test_cannot_direct_message_yourself_or_another_company(client, tenants):
    acme, globex = tenants
    assert client.post(
        "/api/v1/chat/direct", json={"user_id": str(acme.owner.id)}, headers=acme.headers()
    ).status_code == 422
    assert client.post(
        "/api/v1/chat/direct", json={"user_id": str(globex.owner.id)}, headers=acme.headers()
    ).status_code == 404


def test_one_company_cannot_reach_anothers_channel(client, tenants):
    acme, globex = tenants
    channel = _team_channel(client, acme)
    assert client.get(
        f"/api/v1/chat/channels/{channel}/messages", headers=globex.headers()
    ).status_code == 404
    assert client.post(
        f"/api/v1/chat/channels/{channel}/messages",
        json={"body": "hello"},
        headers=globex.headers(),
    ).status_code == 404


# --------------------------------------------------------------------------- #
# The socket
# --------------------------------------------------------------------------- #


def test_ticket_is_short_lived_and_typed(client, tenants):
    """It travels in a URL, so it must not be a session token."""
    from app.core.security import decode_access_token

    acme, _ = tenants
    body = client.post("/api/v1/chat/ticket", headers=acme.headers()).json()
    claims = decode_access_token(body["ticket"])
    assert claims["typ"] == "chat_ws"
    assert claims["sub"] == str(acme.owner.id)
    # Under two minutes of life, against a session measured in hours.
    assert claims["exp"] - claims["iat"] <= 120


def test_socket_refuses_a_session_token(client, tenants):
    """A bearer token must not open the socket — only a ticket does."""
    import pytest
    from starlette.websockets import WebSocketDisconnect

    acme, _ = tenants
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/api/v1/chat/ws?ticket={acme.owner_token}"):
            pass


def test_socket_delivers_a_message_to_a_teammate(client, tenants):
    """The whole point: posting over HTTP arrives live on somebody else's socket."""
    acme, _ = tenants
    channel = _team_channel(client, acme)
    ticket = client.post(
        "/api/v1/chat/ticket", headers=acme.headers(acme.employee_token)
    ).json()["ticket"]

    with client.websocket_connect(f"/api/v1/chat/ws?ticket={ticket}") as socket:
        assert socket.receive_json()["type"] == "ready"
        client.post(
            f"/api/v1/chat/channels/{channel}/messages",
            json={"body": "live"},
            headers=acme.headers(),
        )
        pushed = socket.receive_json()
        assert pushed["type"] == "message"
        assert pushed["message"]["body"] == "live"
        assert pushed["message"]["user_name"] == "Acme Ltd Owner"
