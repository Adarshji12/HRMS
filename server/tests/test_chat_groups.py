"""Group channels and message attachments.

The tests here are chosen for the failures that would actually hurt:

* somebody reading a group they were never added to, or kept reading one they
  were removed from,
* an attachment reachable by anybody who has the message id,
* a file type that runs when a browser opens it,
* and a group becoming unadministrable the day its creator leaves, which is the
  bug the `created_by IS NULL` fallback exists to prevent.
"""

from __future__ import annotations

import io
import uuid

import pytest

from app.db.session import SessionLocal
from app.models import ChatChannel, User


def _channels(client, tenant, token=None) -> list[dict]:
    response = client.get("/api/v1/chat/channels", headers=tenant.headers(token))
    assert response.status_code == 200, response.text
    return response.json()


def _third_person(tenant) -> User:
    """A third colleague, so "add somebody" has somebody to add."""
    from app.core.security import generate_enrollment_key, hash_password

    with SessionLocal() as db:
        person = User(
            id=uuid.uuid4(), org_id=tenant.id, email=f"third@{tenant.slug}.test",
            full_name="Third Person", role="employee",
            password_hash=hash_password("correct-horse-battery"), is_active=True,
            enrollment_key=generate_enrollment_key(),
        )
        db.add(person)
        db.commit()
        db.refresh(person)
        return person


@pytest.fixture
def acme(tenants):
    return tenants[0]


@pytest.fixture
def globex(tenants):
    return tenants[1]


def _make_group(client, tenant, members, name="Launch team") -> dict:
    response = client.post(
        "/api/v1/chat/groups",
        json={"name": name, "user_ids": [str(m) for m in members]},
        headers=tenant.headers(),
    )
    assert response.status_code == 201, response.text
    return response.json()


# --------------------------------------------------------------------------- #
# Creating and reading
# --------------------------------------------------------------------------- #


def test_a_group_holds_its_creator_and_the_people_named(client, acme):
    group = _make_group(client, acme, [acme.employee.id])
    assert group["kind"] == "group"
    assert group["title"] == "Launch team"
    assert group["members"] == 2
    assert group["can_administer"] is True

    # Both sides see it in their own rail.
    assert any(c["id"] == group["id"] for c in _channels(client, acme))
    assert any(
        c["id"] == group["id"] for c in _channels(client, acme, acme.employee_token)
    )


def test_a_member_who_did_not_create_it_cannot_administer_it(client, acme):
    group = _make_group(client, acme, [acme.employee.id])
    theirs = next(
        c for c in _channels(client, acme, acme.employee_token) if c["id"] == group["id"]
    )
    assert theirs["can_administer"] is False

    refused = client.post(
        f"/api/v1/chat/channels/{group['id']}/members",
        json={"user_ids": [str(acme.owner.id)]},
        headers=acme.headers(acme.employee_token),
    )
    assert refused.status_code == 403
    assert refused.json()["detail"]["reason"] == "not_group_admin"


def test_a_group_needs_a_name_and_at_least_one_colleague(client, acme):
    assert client.post(
        "/api/v1/chat/groups",
        json={"name": "", "user_ids": [str(acme.employee.id)]},
        headers=acme.headers(),
    ).status_code == 422
    assert client.post(
        "/api/v1/chat/groups", json={"name": "Nobody", "user_ids": []},
        headers=acme.headers(),
    ).status_code == 422


def test_a_group_cannot_reach_into_another_tenant(client, acme, globex):
    """The id of somebody in another company is silently not a member."""
    refused = client.post(
        "/api/v1/chat/groups",
        json={"name": "Cross-company", "user_ids": [str(globex.employee.id)]},
        headers=acme.headers(),
    )
    assert refused.status_code == 422
    assert refused.json()["detail"]["reason"] == "no_members"


def test_a_stranger_cannot_read_or_post_to_a_group(client, acme):
    third = _third_person(acme)
    group = _make_group(client, acme, [acme.employee.id])

    from app.core.security import create_access_token

    token = create_access_token(
        str(third.id), {"typ": "user", "org": str(acme.id), "role": "employee"}
    )
    # 404, not 403: answering "forbidden" confirms the group exists.
    assert client.get(
        f"/api/v1/chat/channels/{group['id']}/messages", headers=acme.headers(token)
    ).status_code == 404
    assert client.post(
        f"/api/v1/chat/channels/{group['id']}/messages",
        json={"body": "hello"}, headers=acme.headers(token),
    ).status_code == 404


# --------------------------------------------------------------------------- #
# Membership
# --------------------------------------------------------------------------- #


def test_adding_and_removing_members(client, acme):
    third = _third_person(acme)
    group = _make_group(client, acme, [acme.employee.id])

    added = client.post(
        f"/api/v1/chat/channels/{group['id']}/members",
        json={"user_ids": [str(third.id)]},
        headers=acme.headers(),
    )
    assert added.status_code == 200
    assert [row["full_name"] for row in added.json()] == ["Third Person"]

    members = client.get(
        f"/api/v1/chat/channels/{group['id']}/members", headers=acme.headers()
    ).json()
    assert len(members) == 3
    assert sum(1 for m in members if m["is_admin"]) == 1

    removed = client.delete(
        f"/api/v1/chat/channels/{group['id']}/members/{third.id}", headers=acme.headers()
    )
    assert removed.status_code == 204
    assert len(client.get(
        f"/api/v1/chat/channels/{group['id']}/members", headers=acme.headers()
    ).json()) == 2


def test_adding_somebody_twice_is_not_an_error(client, acme):
    """Adding five people of whom one was already there is a success."""
    group = _make_group(client, acme, [acme.employee.id])
    again = client.post(
        f"/api/v1/chat/channels/{group['id']}/members",
        json={"user_ids": [str(acme.employee.id)]},
        headers=acme.headers(),
    )
    assert again.status_code == 200 and again.json() == []


def test_a_removed_member_loses_the_channel_immediately(client, acme):
    group = _make_group(client, acme, [acme.employee.id])
    client.post(
        f"/api/v1/chat/channels/{group['id']}/messages",
        json={"body": "internal"}, headers=acme.headers(),
    )
    client.delete(
        f"/api/v1/chat/channels/{group['id']}/members/{acme.employee.id}",
        headers=acme.headers(),
    )
    assert not any(
        c["id"] == group["id"] for c in _channels(client, acme, acme.employee_token)
    )
    assert client.get(
        f"/api/v1/chat/channels/{group['id']}/messages",
        headers=acme.headers(acme.employee_token),
    ).status_code == 404


def test_anybody_may_remove_themselves(client, acme):
    group = _make_group(client, acme, [acme.employee.id])
    left = client.delete(
        f"/api/v1/chat/channels/{group['id']}/members/{acme.employee.id}",
        headers=acme.headers(acme.employee_token),
    )
    assert left.status_code == 204


def test_a_group_whose_creator_is_gone_is_run_by_its_members(client, acme):
    """The fallback that stops a group freezing when somebody resigns."""
    group = _make_group(client, acme, [acme.employee.id])
    with SessionLocal() as db:
        row = db.get(ChatChannel, uuid.UUID(group["id"]))
        row.created_by = None
        db.commit()

    theirs = next(
        c for c in _channels(client, acme, acme.employee_token) if c["id"] == group["id"]
    )
    assert theirs["can_administer"] is True

    third = _third_person(acme)
    assert client.post(
        f"/api/v1/chat/channels/{group['id']}/members",
        json={"user_ids": [str(third.id)]},
        headers=acme.headers(acme.employee_token),
    ).status_code == 200


def test_the_derived_channels_cannot_have_their_membership_edited(client, acme):
    """A team channel follows the org chart and nothing else."""
    channels = _channels(client, acme)
    derived = [c for c in channels if c["kind"] in ("team", "department")]
    if not derived:
        pytest.skip("this fixture's users have no team or department")
    refused = client.delete(
        f"/api/v1/chat/channels/{derived[0]['id']}/members/{acme.owner.id}",
        headers=acme.headers(),
    )
    assert refused.status_code == 422
    assert refused.json()["detail"]["reason"] == "not_a_group"


def test_renaming_a_group(client, acme):
    group = _make_group(client, acme, [acme.employee.id])
    renamed = client.patch(
        f"/api/v1/chat/channels/{group['id']}",
        json={"name": "Launch team — phase 2"},
        headers=acme.headers(),
    )
    assert renamed.status_code == 200
    assert renamed.json()["title"] == "Launch team — phase 2"


# --------------------------------------------------------------------------- #
# Attachments
# --------------------------------------------------------------------------- #

PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06"
    b"\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05"
    b"\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)


def _send_file(client, tenant, channel_id, *, name="shot.png", ctype="image/png",
               data=PNG, body="", token=None):
    return client.post(
        f"/api/v1/chat/channels/{channel_id}/attachments",
        files={"file": (name, io.BytesIO(data), ctype)},
        data={"body": body},
        headers={k: v for k, v in tenant.headers(token).items() if k != "Content-Type"},
    )


def test_sending_a_file_with_no_caption(client, acme):
    group = _make_group(client, acme, [acme.employee.id])
    sent = _send_file(client, acme, group["id"])
    assert sent.status_code == 201, sent.text
    message = sent.json()
    # An attachment with no caption is an ordinary thing to send.
    assert message["body"] == ""
    assert message["attachment_name"] == "shot.png"
    assert message["attachment_inline"] is True
    assert message["attachment_size"] == len(PNG)
    # The storage key is never handed to a client.
    assert "attachment_key" not in message


def test_a_caption_rides_with_the_file(client, acme):
    group = _make_group(client, acme, [acme.employee.id])
    message = _send_file(client, acme, group["id"], body="here it is").json()
    assert message["body"] == "here it is"
    assert message["attachment_name"] == "shot.png"


def test_a_message_with_neither_text_nor_file_is_refused(client, acme):
    group = _make_group(client, acme, [acme.employee.id])
    refused = client.post(
        f"/api/v1/chat/channels/{group['id']}/messages",
        json={"body": "   "}, headers=acme.headers(),
    )
    assert refused.status_code == 422


def test_a_member_can_download_and_a_stranger_cannot(client, acme):
    third = _third_person(acme)
    group = _make_group(client, acme, [acme.employee.id])
    message = _send_file(client, acme, group["id"]).json()
    path = f"/api/v1/chat/messages/{message['id']}/attachment"

    got = client.get(path, headers=acme.headers(acme.employee_token))
    assert got.status_code == 200
    assert got.content == PNG
    # Never served inline, even for an image: an uploaded file rendered on the
    # console's own origin is script running as the console.
    assert got.headers["content-disposition"].startswith("attachment")

    from app.core.security import create_access_token

    token = create_access_token(
        str(third.id), {"typ": "user", "org": str(acme.id), "role": "employee"}
    )
    assert client.get(path, headers=acme.headers(token)).status_code == 404


def test_the_download_is_refused_after_the_reader_leaves_the_group(client, acme):
    """The membership check runs on every download, not only at send time."""
    group = _make_group(client, acme, [acme.employee.id])
    message = _send_file(client, acme, group["id"]).json()
    path = f"/api/v1/chat/messages/{message['id']}/attachment"
    assert client.get(path, headers=acme.headers(acme.employee_token)).status_code == 200

    client.delete(
        f"/api/v1/chat/channels/{group['id']}/members/{acme.employee.id}",
        headers=acme.headers(),
    )
    assert client.get(path, headers=acme.headers(acme.employee_token)).status_code == 404


def test_another_tenant_cannot_download(client, acme, globex):
    group = _make_group(client, acme, [acme.employee.id])
    message = _send_file(client, acme, group["id"]).json()
    assert client.get(
        f"/api/v1/chat/messages/{message['id']}/attachment", headers=globex.headers()
    ).status_code == 404


def test_deleting_a_message_takes_its_file_with_it(client, acme):
    group = _make_group(client, acme, [acme.employee.id])
    message = _send_file(client, acme, group["id"]).json()
    client.delete(f"/api/v1/chat/messages/{message['id']}", headers=acme.headers())

    gone = client.get(
        f"/api/v1/chat/messages/{message['id']}/attachment", headers=acme.headers()
    )
    assert gone.status_code == 404


def test_an_executable_is_refused(client, acme):
    """The allow-list, which is the point of having one."""
    group = _make_group(client, acme, [acme.employee.id])
    refused = _send_file(
        client, acme, group["id"],
        name="payroll.exe", ctype="application/x-msdownload", data=b"MZ\x90\x00",
    )
    assert refused.status_code == 422
    assert refused.json()["detail"]["reason"] == "type_not_allowed"


def test_an_html_file_is_refused(client, acme):
    """text/html is the one that would run on this console's own origin."""
    group = _make_group(client, acme, [acme.employee.id])
    refused = _send_file(
        client, acme, group["id"],
        name="note.html", ctype="text/html", data=b"<script>alert(1)</script>",
    )
    assert refused.status_code == 422


def test_an_empty_file_is_refused(client, acme):
    group = _make_group(client, acme, [acme.employee.id])
    refused = _send_file(client, acme, group["id"], data=b"")
    assert refused.status_code == 422
    assert refused.json()["detail"]["reason"] == "empty_upload"


def test_an_oversize_file_is_refused(client, acme):
    from app.services.chat import MAX_ATTACHMENT_BYTES

    group = _make_group(client, acme, [acme.employee.id])
    refused = _send_file(
        client, acme, group["id"],
        name="big.pdf", ctype="application/pdf",
        data=b"%PDF-" + b"0" * MAX_ATTACHMENT_BYTES,
    )
    assert refused.status_code == 413


def test_a_pdf_is_accepted_but_not_drawn_inline(client, acme):
    group = _make_group(client, acme, [acme.employee.id])
    message = _send_file(
        client, acme, group["id"], name="terms.pdf", ctype="application/pdf",
        data=b"%PDF-1.4 minimal",
    ).json()
    assert message["attachment_type"] == "application/pdf"
    assert message["attachment_inline"] is False


def test_the_channel_preview_names_a_file_rather_than_going_blank(client, acme):
    group = _make_group(client, acme, [acme.employee.id])
    _send_file(client, acme, group["id"])
    row = next(c for c in _channels(client, acme) if c["id"] == group["id"])
    assert row["last_message_preview"] == "📎 shot.png"
