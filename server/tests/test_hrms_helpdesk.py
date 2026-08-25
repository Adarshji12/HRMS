"""Helpdesk — and specifically, what the helpdesk must never say.

The phase criterion is "HR can respond with an internal note the employee never
sees". Every other assertion in this file is scaffolding around that one, plus
the second half of it that is easier to miss: **an employee must not be told
that an internal note exists**. A ticket detail that says "12 comments" while
rendering 4 has disclosed eight private notes about the person reading it, and
it has done so through a field nobody thinks of as sensitive.

So the disclosure tests assert on absence, not just on content: no internal
body, and no count that implies one. Asserting only that the note's text is
missing would pass against a payload that leaks the count.

The third disclosure surface is the ``source_module`` / ``source_ref`` back-link
(D-019). It has no foreign key, so both halves are hostile input, and the
failure mode is an existence oracle rather than a leak of content: post one
ticket per guessed UUID and read back whether the link resolved. The tests
below therefore assert that "you may not see that row" and "that row does not
exist" produce byte-identical answers, and that an unknown module name is a
rendered-unavailable link rather than a KeyError.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

import pytest
from pydantic import ValidationError
from sqlalchemy import select

from app.core.security import create_access_token, generate_enrollment_key, hash_password
from app.db.session import SessionLocal
from app.models import (
    HelpdeskComment,
    HelpdeskTicket,
    NotificationLog,
    RegularizationRequest,
    User,
)
from app.schemas.helpdesk import PublicCommentOut

BASE = "/api/v1/helpdesk"


@pytest.fixture(scope="module", autouse=True)
def _helpdesk_router_mounted():
    """Mount the router if the lead has not wired it into ``router.py`` yet.

    Phase 9's backend lands before the integration seam does, and a suite that
    is entirely 404s has verified nothing about whether the module works. This
    registers the real router on the real app, and is a no-op the moment
    ``api/v1/router.py`` includes it. ``test_router_is_registered_for_integration``
    checks the seam separately against the router module, so this shim can
    never hide a missing registration.
    """
    from app.api.v1 import helpdesk as helpdesk_api
    from app.main import app

    if not any(getattr(r, "path", "").startswith("/api/v1/helpdesk") for r in app.routes):
        app.include_router(helpdesk_api.router, prefix="/api/v1")
        app.openapi_schema = None
    yield


def test_router_is_registered_for_integration():
    """Fails until the lead adds helpdesk to ``api/v1/router.py``. Deliberate."""
    from app.api.v1.router import api_router

    paths = {getattr(route, "path", "") for route in api_router.routes}
    assert any(path.startswith("/api/v1/helpdesk") for path in paths), (
        "app/api/v1/router.py does not include helpdesk.router — see the Phase 9 "
        "integration request"
    )


# --------------------------------------------------------------------------- #
# Cast
# --------------------------------------------------------------------------- #


class Person:
    def __init__(self, user: User, slug: str) -> None:
        self.id = user.id
        self.email = user.email
        self.token = create_access_token(
            str(user.id), {"typ": "user", "org": str(user.org_id), "role": user.role}
        )
        self.slug = slug

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}", "X-Org-Slug": self.slug}


@pytest.fixture
def cast(tenants):
    """Acme's helpdesk: an HR admin, a manager, two employees, Globex's owner.

    Two employees, always, for the same reason ``tenants`` insists on two
    companies: a single employee cannot express "may Alice read Bob's
    grievance", which is the question this module exists to answer.

    ``mgr`` is there for the second half of that question, which D-026 exists
    for: a manager is helpdesk staff by default, so "may a colleague who is not
    HR read Bob's grievance" is the case a fixture with only an admin cannot
    express at all.
    """
    acme, globex = tenants
    with SessionLocal() as db:
        def make(org_id, slug, email, role, name):
            user = User(
                id=uuid.uuid4(), org_id=org_id, email=email, full_name=name, role=role,
                password_hash=hash_password("correct-horse-battery"), is_active=True,
                enrollment_key=generate_enrollment_key(),
            )
            db.add(user)
            db.flush()
            return Person(user, slug)

        hr = make(acme.id, acme.slug, "hr@acme.test", "admin", "Acme HR")
        mgr = make(acme.id, acme.slug, "mgr@acme.test", "manager", "Acme Manager")
        alice = make(acme.id, acme.slug, "alice@acme.test", "employee", "Alice Employee")
        bob = make(acme.id, acme.slug, "bob@acme.test", "employee", "Bob Employee")
        db.commit()

    return {
        "hr": hr,
        "mgr": mgr,
        "alice": alice,
        "bob": bob,
        "owner": Person(_reload(acme.owner.id), acme.slug),
        "other_owner": Person(_reload(globex.owner.id), globex.slug),
        "acme": acme,
        "globex": globex,
    }


def _reload(user_id: uuid.UUID) -> User:
    with SessionLocal() as db:
        return db.get(User, user_id)


def _raise_ticket(client, person: Person, **extra) -> dict:
    body = {"subject": "Payslip is wrong", "description": "March net pay looks short."}
    body.update(extra)
    response = client.post(f"{BASE}/tickets", json=body, headers=person.headers)
    assert response.status_code == 201, response.text
    return response.json()


def _set_flag(user_id: uuid.UUID, value: bool) -> None:
    with SessionLocal() as db:
        db.get(User, user_id).can_manage_helpdesk = value
        db.commit()


# --------------------------------------------------------------------------- #
# The disclosure boundary
# --------------------------------------------------------------------------- #


def test_employee_never_receives_an_internal_note(client, cast):
    ticket = _raise_ticket(client, cast["alice"])

    reply = client.post(
        f"{BASE}/staff/tickets/{ticket['id']}/comments",
        json={"body": "We are looking into it.", "is_internal": False},
        headers=cast["hr"].headers,
    )
    assert reply.status_code == 201, reply.text
    note = client.post(
        f"{BASE}/staff/tickets/{ticket['id']}/comments",
        json={"body": "Third complaint this quarter, loop in legal.", "is_internal": True},
        headers=cast["hr"].headers,
    )
    assert note.status_code == 201, note.text

    seen = client.get(f"{BASE}/tickets/{ticket['id']}", headers=cast["alice"].headers)
    assert seen.status_code == 200, seen.text
    body = seen.json()

    bodies = [c["body"] for c in body["comments"]]
    assert bodies == ["We are looking into it."]
    assert all(c["is_internal"] is False for c in body["comments"])
    assert "legal" not in seen.text


def test_employee_is_not_told_that_an_internal_note_exists(client, cast):
    """The second half of the boundary, and the one a content-only test misses.

    Four visible comments under a "12 comments" header discloses that eight
    notes about the reader exist. The counts live only on the staff schemas, so
    the assertion is that the keys are absent from the payload entirely — not
    that they happen to be small.
    """
    ticket = _raise_ticket(client, cast["alice"])
    for i in range(3):
        client.post(
            f"{BASE}/staff/tickets/{ticket['id']}/comments",
            json={"body": f"note {i}", "is_internal": True},
            headers=cast["hr"].headers,
        )

    detail = client.get(f"{BASE}/tickets/{ticket['id']}", headers=cast["alice"].headers).json()
    assert detail["comments"] == []
    assert "comment_count" not in detail
    assert "internal_comment_count" not in detail

    listed = client.get(f"{BASE}/tickets", headers=cast["alice"].headers).json()
    assert len(listed) == 1
    assert "comment_count" not in listed[0]
    assert "internal_comment_count" not in listed[0]


def test_staff_see_both_bodies_and_both_counts(client, cast):
    ticket = _raise_ticket(client, cast["alice"])
    client.post(
        f"{BASE}/staff/tickets/{ticket['id']}/comments",
        json={"body": "We are looking into it.", "is_internal": False},
        headers=cast["hr"].headers,
    )
    client.post(
        f"{BASE}/staff/tickets/{ticket['id']}/comments",
        json={"body": "Loop in legal.", "is_internal": True},
        headers=cast["hr"].headers,
    )

    detail = client.get(
        f"{BASE}/staff/tickets/{ticket['id']}", headers=cast["hr"].headers
    )
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert [c["body"] for c in body["comments"]] == ["We are looking into it.", "Loop in legal."]
    assert [c["is_internal"] for c in body["comments"]] == [False, True]
    assert body["comment_count"] == 2
    assert body["internal_comment_count"] == 1

    queue = client.get(f"{BASE}/staff/tickets", headers=cast["hr"].headers).json()
    row = next(r for r in queue if r["id"] == ticket["id"])
    assert (row["comment_count"], row["internal_comment_count"]) == (2, 1)


def test_the_employee_facing_type_refuses_an_internal_row(client, cast):
    """The enforcement itself, exercised directly rather than through a handler.

    ``PublicCommentOut.is_internal`` is ``Literal[False]``: a handler that
    reaches for the wrong type raises instead of disclosing. This test exists
    so that "fix the Literal to bool to make something pass" fails here, at the
    boundary, with a name that says what was broken.
    """
    ticket = _raise_ticket(client, cast["alice"])
    client.post(
        f"{BASE}/staff/tickets/{ticket['id']}/comments",
        json={"body": "private", "is_internal": True},
        headers=cast["hr"].headers,
    )
    with SessionLocal() as db:
        row = db.scalar(
            select(HelpdeskComment).where(HelpdeskComment.ticket_id == uuid.UUID(ticket["id"]))
        )
        assert row.is_internal is True
        with pytest.raises(ValidationError):
            PublicCommentOut.model_validate(row)


def test_an_employee_cannot_read_another_employees_ticket(client, cast):
    """404, not 403. A 403 confirms the ticket exists, which is half a grievance."""
    bobs = _raise_ticket(client, cast["bob"], subject="Grievance about my manager")

    for path in (f"{BASE}/tickets/{bobs['id']}", f"{BASE}/tickets/{bobs['id']}/source"):
        response = client.get(path, headers=cast["alice"].headers)
        assert response.status_code == 404, (path, response.text)

    posted = client.post(
        f"{BASE}/tickets/{bobs['id']}/comments",
        json={"body": "me too"},
        headers=cast["alice"].headers,
    )
    assert posted.status_code == 404

    mine = client.get(f"{BASE}/tickets", headers=cast["alice"].headers).json()
    assert mine == []


def test_an_employee_cannot_author_an_internal_note(client, cast):
    """``CommentIn`` forbids extras, so the field is a 422 rather than dropped.

    Silently ignoring it would be the more forgiving API and the worse one: the
    employee would believe they had written a private note.
    """
    ticket = _raise_ticket(client, cast["alice"])
    response = client.post(
        f"{BASE}/tickets/{ticket['id']}/comments",
        json={"body": "secret", "is_internal": True},
        headers=cast["alice"].headers,
    )
    assert response.status_code == 422, response.text

    with SessionLocal() as db:
        assert db.scalar(select(HelpdeskComment.id)) is None


def test_an_employee_cannot_reach_the_staff_surface(client, cast):
    ticket = _raise_ticket(client, cast["alice"])
    for method, path, payload in (
        ("get", f"{BASE}/staff/tickets", None),
        ("get", f"{BASE}/staff/tickets/{ticket['id']}", None),
        ("post", f"{BASE}/staff/tickets/{ticket['id']}/comments",
         {"body": "x", "is_internal": True}),
    ):
        call = getattr(client, method)
        response = call(path, json=payload, headers=cast["alice"].headers) if payload else call(
            path, headers=cast["alice"].headers
        )
        assert response.status_code == 403, (path, response.text)


# --------------------------------------------------------------------------- #
# D-026 — working the helpdesk is not the same right as reading its notes
#
# The case these exist for is the ordinary one: a grievance filed *about* a
# manager, sitting in a queue that manager can open. Before D-026 the schema
# split was airtight against the employee and wide open to that manager, which
# is the sort of hole that survives review precisely because every test above
# passes with it still in place.
# --------------------------------------------------------------------------- #


def _thread(client, cast, ticket_id):
    """A public reply and an internal note, written by HR, on one ticket."""
    for body, internal in (("We are looking into it.", False), ("Loop in legal.", True)):
        posted = client.post(
            f"{BASE}/staff/tickets/{ticket_id}/comments",
            json={"body": body, "is_internal": internal},
            headers=cast["hr"].headers,
        )
        assert posted.status_code == 201, posted.text


def test_a_staff_manager_who_is_not_the_assignee_gets_the_redacted_shape(client, cast):
    """The hole D-026 closes, asserted from the manager's own session.

    Not a 403: refusing would confirm there is something to refuse, and a
    manager triaging the queue has a legitimate reason to read the public
    thread. They get the thread, minus the notes, minus any key that would
    reveal notes exist.
    """
    ticket = _raise_ticket(client, cast["bob"], subject="Grievance about my manager")
    _thread(client, cast, ticket["id"])

    seen = client.get(f"{BASE}/staff/tickets/{ticket['id']}", headers=cast["mgr"].headers)
    assert seen.status_code == 200, seen.text
    body = seen.json()

    assert [c["body"] for c in body["comments"]] == ["We are looking into it."]
    assert all(c["is_internal"] is False for c in body["comments"])
    assert "legal" not in seen.text
    # Absence, not a small number. A confident 0 teaches them as much as a 1.
    assert "comment_count" not in body
    assert "internal_comment_count" not in body


def test_the_assignee_sees_internal_notes(client, cast):
    """Someone has to be able to work a ticket without being an admin.

    Taking the ticket is the act that claims it, and it is visible on the row
    rather than buried in a config table.
    """
    ticket = _raise_ticket(client, cast["bob"])
    _thread(client, cast, ticket["id"])

    before = client.get(f"{BASE}/staff/tickets/{ticket['id']}", headers=cast["mgr"].headers).json()
    assert "comment_count" not in before

    assigned = client.post(
        f"{BASE}/staff/tickets/{ticket['id']}/assign",
        json={"assignee_id": str(cast["mgr"].id)},
        headers=cast["hr"].headers,
    )
    assert assigned.status_code == 200, assigned.text

    after = client.get(f"{BASE}/staff/tickets/{ticket['id']}", headers=cast["mgr"].headers).json()
    assert [c["body"] for c in after["comments"]] == ["We are looking into it.", "Loop in legal."]
    assert after["comment_count"] == 2
    assert after["internal_comment_count"] == 1


def test_an_admin_sees_internal_notes_without_being_assigned(client, cast):
    """HR is who the notes belong to, so no assignment is needed."""
    ticket = _raise_ticket(client, cast["bob"])
    _thread(client, cast, ticket["id"])

    body = client.get(f"{BASE}/staff/tickets/{ticket['id']}", headers=cast["hr"].headers).json()
    assert body["assigned_to"] is None
    assert body["internal_comment_count"] == 1
    assert any(c["is_internal"] for c in body["comments"])


def test_an_unassigned_ticket_is_admin_only(client, cast):
    """Fails closed. ``assigned_to`` is NULL and NULL matches nobody.

    An untaken ticket is exactly the one nobody has claimed responsibility for,
    so it is the wrong one to make readable by default.
    """
    ticket = _raise_ticket(client, cast["bob"])
    _thread(client, cast, ticket["id"])
    body = client.get(f"{BASE}/staff/tickets/{ticket['id']}", headers=cast["mgr"].headers).json()
    assert body["assigned_to"] is None
    assert "internal_comment_count" not in body


def test_a_non_assignee_manager_cannot_post_an_internal_note(client, cast):
    """You may only author what you could read back.

    Refusing the *write* is safe in a way refusing the read would not be: the
    caller already knows what they tried to write, so the 403 discloses nothing
    about the ticket.
    """
    ticket = _raise_ticket(client, cast["bob"])

    refused = client.post(
        f"{BASE}/staff/tickets/{ticket['id']}/comments",
        json={"body": "she is difficult", "is_internal": True},
        headers=cast["mgr"].headers,
    )
    assert refused.status_code == 403, refused.text
    assert refused.json()["detail"]["reason"] == "permission_denied"

    with SessionLocal() as db:
        assert db.scalar(select(HelpdeskComment.id)) is None

    # A public reply still works: triage must not require the notes right, or
    # every queue in the product becomes admin-only in practice.
    public = client.post(
        f"{BASE}/staff/tickets/{ticket['id']}/comments",
        json={"body": "Looking into this now.", "is_internal": False},
        headers=cast["mgr"].headers,
    )
    assert public.status_code == 201, public.text


def test_the_queue_hides_counts_row_by_row(client, cast):
    """One page, two shapes, and that is correct rather than untidy.

    Returning one shape throughout and zeroing the counts on the rows they may
    not read would assert "no internal notes" about a ticket that has one.
    """
    mine = _raise_ticket(client, cast["alice"], subject="Mine")
    theirs = _raise_ticket(client, cast["bob"], subject="Theirs")
    for ticket_id in (mine["id"], theirs["id"]):
        client.post(
            f"{BASE}/staff/tickets/{ticket_id}/comments",
            json={"body": "note", "is_internal": True},
            headers=cast["hr"].headers,
        )
    client.post(
        f"{BASE}/staff/tickets/{mine['id']}/assign",
        json={"assignee_id": str(cast["mgr"].id)},
        headers=cast["hr"].headers,
    )

    rows = {
        r["subject"]: r
        for r in client.get(f"{BASE}/staff/tickets", headers=cast["mgr"].headers).json()
    }
    assert set(rows) == {"Mine", "Theirs"}
    assert rows["Mine"]["internal_comment_count"] == 1
    assert "internal_comment_count" not in rows["Theirs"]
    assert "comment_count" not in rows["Theirs"]


def test_a_staff_write_does_not_echo_back_the_counts(client, cast):
    """The leak that comes back through the door marked "write".

    Every mutation echoes the ticket, so each one is a read path. Guarding only
    the GETs would let a manager learn the note count by changing a priority.
    """
    ticket = _raise_ticket(client, cast["bob"])
    client.post(
        f"{BASE}/staff/tickets/{ticket['id']}/comments",
        json={"body": "note", "is_internal": True},
        headers=cast["hr"].headers,
    )

    for response in (
        client.patch(f"{BASE}/staff/tickets/{ticket['id']}",
                     json={"priority": "high"}, headers=cast["mgr"].headers),
        client.post(f"{BASE}/staff/tickets/{ticket['id']}/resolve", headers=cast["mgr"].headers),
        client.post(f"{BASE}/staff/tickets/{ticket['id']}/reopen", headers=cast["mgr"].headers),
        client.post(f"{BASE}/staff/tickets/{ticket['id']}/close", headers=cast["mgr"].headers),
    ):
        assert response.status_code == 200, response.text
        assert "comment_count" not in response.json()
        assert "internal_comment_count" not in response.json()


def test_assigning_a_ticket_to_yourself_hands_back_the_entitled_shape(client, cast):
    """The documented degradation: a shared queue assigns before working.

    Worth asserting because it is the workflow D-026 leans on. If taking a
    ticket did not immediately grant the right, the ruling would be a wall
    rather than a door.
    """
    ticket = _raise_ticket(client, cast["bob"])
    client.post(
        f"{BASE}/staff/tickets/{ticket['id']}/comments",
        json={"body": "note", "is_internal": True},
        headers=cast["hr"].headers,
    )
    taken = client.post(
        f"{BASE}/staff/tickets/{ticket['id']}/assign",
        json={"assignee_id": str(cast["mgr"].id)},
        headers=cast["mgr"].headers,
    )
    assert taken.status_code == 200, taken.text
    assert taken.json()["internal_comment_count"] == 1


def test_unassigning_takes_the_right_back_again(client, cast):
    """The right follows ``assigned_to``, so handing the ticket on ends it."""
    ticket = _raise_ticket(client, cast["bob"])
    client.post(
        f"{BASE}/staff/tickets/{ticket['id']}/assign",
        json={"assignee_id": str(cast["mgr"].id)},
        headers=cast["hr"].headers,
    )
    client.post(
        f"{BASE}/staff/tickets/{ticket['id']}/comments",
        json={"body": "note", "is_internal": True},
        headers=cast["mgr"].headers,
    )
    held = client.get(f"{BASE}/staff/tickets/{ticket['id']}", headers=cast["mgr"].headers).json()
    assert held["internal_comment_count"] == 1

    client.post(
        f"{BASE}/staff/tickets/{ticket['id']}/assign",
        json={"assignee_id": None},
        headers=cast["hr"].headers,
    )
    after = client.get(f"{BASE}/staff/tickets/{ticket['id']}", headers=cast["mgr"].headers).json()
    assert "internal_comment_count" not in after
    assert all(c["is_internal"] is False for c in after["comments"])


# --------------------------------------------------------------------------- #
# can_manage_helpdesk — the flag restricts, it never grants
# --------------------------------------------------------------------------- #


def test_flag_off_cannot_assign_or_post_an_internal_note(client, cast):
    ticket = _raise_ticket(client, cast["alice"])
    _set_flag(cast["hr"].id, False)

    assign = client.post(
        f"{BASE}/staff/tickets/{ticket['id']}/assign",
        json={"assignee_id": str(cast["hr"].id)},
        headers=cast["hr"].headers,
    )
    assert assign.status_code == 403, assign.text
    assert assign.json()["detail"]["reason"] == "permission_denied"

    note = client.post(
        f"{BASE}/staff/tickets/{ticket['id']}/comments",
        json={"body": "private", "is_internal": True},
        headers=cast["hr"].headers,
    )
    assert note.status_code == 403

    with SessionLocal() as db:
        assert db.scalar(select(HelpdeskComment.id)) is None
        assert db.get(HelpdeskTicket, uuid.UUID(ticket["id"])).assigned_to is None


def test_the_flag_on_an_employee_grants_nothing(client, cast):
    """It defaults to True for everybody, so this is the everyday configuration.

    If the flag could grant, every employee in the product would already be
    reading every grievance.
    """
    assert client.get(f"{BASE}/staff/tickets", headers=cast["alice"].headers).status_code == 403


def test_a_ticket_cannot_be_assigned_to_someone_the_flag_excludes(client, cast):
    """Assignment is an access decision wearing a workflow decision's clothes.

    Being the assignee is how a person starts reading internal notes, so a user
    the flag excludes must not become one by the side door.
    """
    ticket = _raise_ticket(client, cast["alice"])

    to_employee = client.post(
        f"{BASE}/staff/tickets/{ticket['id']}/assign",
        json={"assignee_id": str(cast["alice"].id)},
        headers=cast["hr"].headers,
    )
    assert to_employee.status_code == 409, to_employee.text
    assert to_employee.json()["detail"]["reason"] == "assignee_not_helpdesk_staff"

    _set_flag(cast["owner"].id, False)
    to_excluded_staff = client.post(
        f"{BASE}/staff/tickets/{ticket['id']}/assign",
        json={"assignee_id": str(cast["owner"].id)},
        headers=cast["hr"].headers,
    )
    assert to_excluded_staff.status_code == 409, to_excluded_staff.text


def test_category_routing_never_widens_access(client, cast):
    """A category pointed at ``employee`` routes to nobody, not to an employee."""
    created = client.post(
        f"{BASE}/categories",
        json={"name": "Self service", "default_assignee_role": "employee"},
        headers=cast["hr"].headers,
    )
    assert created.status_code == 201, created.text
    ticket = _raise_ticket(client, cast["alice"], category_id=created.json()["id"])
    assert ticket["assigned_to"] is None


def test_category_routing_picks_a_permitted_owner(client, cast):
    created = client.post(
        f"{BASE}/categories",
        json={"name": "Payroll", "default_assignee_role": "admin"},
        headers=cast["hr"].headers,
    )
    ticket = _raise_ticket(client, cast["alice"], category_id=created.json()["id"])
    assert ticket["assigned_to"] == str(cast["hr"].id)
    assert ticket["assigned_to_name"] == "Acme HR"
    assert ticket["category_name"] == "Payroll"


# --------------------------------------------------------------------------- #
# Categories
# --------------------------------------------------------------------------- #


def test_employees_see_category_names_but_not_volumes(client, cast):
    """Names are needed to file a ticket. "Grievance: 14 open" is not."""
    created = client.post(
        f"{BASE}/categories", json={"name": "Grievance"}, headers=cast["hr"].headers
    ).json()
    _raise_ticket(client, cast["alice"], category_id=created["id"])
    _raise_ticket(client, cast["bob"], category_id=created["id"])

    for_employee = client.get(f"{BASE}/categories", headers=cast["alice"].headers).json()
    assert [c["name"] for c in for_employee] == ["Grievance"]
    assert for_employee[0]["ticket_count"] == 0
    assert for_employee[0]["open_ticket_count"] == 0

    for_staff = client.get(f"{BASE}/categories", headers=cast["hr"].headers).json()
    assert for_staff[0]["ticket_count"] == 2
    assert for_staff[0]["open_ticket_count"] == 2


def test_category_crud(client, cast):
    created = client.post(
        f"{BASE}/categories",
        json={"name": "IT access", "description": "Laptops and logins"},
        headers=cast["hr"].headers,
    )
    assert created.status_code == 201, created.text
    category_id = created.json()["id"]

    duplicate = client.post(
        f"{BASE}/categories", json={"name": "IT access"}, headers=cast["hr"].headers
    )
    assert duplicate.status_code == 409

    renamed = client.patch(
        f"{BASE}/categories/{category_id}",
        json={"name": "IT & access", "is_active": False},
        headers=cast["hr"].headers,
    )
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "IT & access"

    # Inactive categories drop out of the default list but stay addressable.
    assert client.get(f"{BASE}/categories", headers=cast["hr"].headers).json() == []
    assert len(
        client.get(
            f"{BASE}/categories?include_inactive=true", headers=cast["hr"].headers
        ).json()
    ) == 1

    assert client.delete(
        f"{BASE}/categories/{category_id}", headers=cast["hr"].headers
    ).status_code == 204


def test_a_category_with_history_is_deactivated_not_deleted(client, cast):
    """The FK is SET NULL, so deleting would quietly erase what tickets were about."""
    created = client.post(
        f"{BASE}/categories", json={"name": "Payroll"}, headers=cast["hr"].headers
    ).json()
    _raise_ticket(client, cast["alice"], category_id=created["id"])

    refused = client.delete(f"{BASE}/categories/{created['id']}", headers=cast["hr"].headers)
    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"]["reason"] == "category_in_use"


# --------------------------------------------------------------------------- #
# Lifecycle and the two timestamps
# --------------------------------------------------------------------------- #


def test_reopen_clears_resolved_at(client, cast):
    """``resolved_at`` means "when the fix that currently stands was delivered".

    If a reopen left the old stamp behind it would mean "the first time someone
    tried", and every mean-time-to-resolution figure computed from it would be
    a fiction that flatters the helpdesk.
    """
    ticket = _raise_ticket(client, cast["alice"])
    resolved = client.post(
        f"{BASE}/staff/tickets/{ticket['id']}/resolve", headers=cast["hr"].headers
    ).json()
    assert resolved["status"] == "resolved"
    assert resolved["resolved_at"] is not None

    reopened = client.post(
        f"{BASE}/staff/tickets/{ticket['id']}/reopen", headers=cast["hr"].headers
    ).json()
    assert reopened["status"] == "open"
    assert reopened["resolved_at"] is None
    assert reopened["closed_at"] is None

    with SessionLocal() as db:
        row = db.get(HelpdeskTicket, uuid.UUID(ticket["id"]))
        assert row.resolved_at is None and row.closed_at is None


def test_the_raiser_can_reject_a_fix_but_not_reopen_a_closed_ticket(client, cast):
    """``resolved`` is not terminal; ``closed`` is. That distinction is the point."""
    ticket = _raise_ticket(client, cast["alice"])
    client.post(f"{BASE}/staff/tickets/{ticket['id']}/resolve", headers=cast["hr"].headers)

    reopened = client.post(f"{BASE}/tickets/{ticket['id']}/reopen", headers=cast["alice"].headers)
    assert reopened.status_code == 200, reopened.text
    assert reopened.json()["resolved_at"] is None

    client.post(f"{BASE}/staff/tickets/{ticket['id']}/close", headers=cast["hr"].headers)
    again = client.post(f"{BASE}/tickets/{ticket['id']}/reopen", headers=cast["alice"].headers)
    assert again.status_code == 409
    assert again.json()["detail"]["reason"] == "not_reopenable"


def test_closing_without_resolving_leaves_resolved_at_null(client, cast):
    """The whole reason ``closed_at`` is a second column.

    Stamping ``resolved_at`` on a withdrawn ticket would book a fix nobody
    delivered into the one number a helpdesk exists to move.
    """
    ticket = _raise_ticket(client, cast["alice"])
    closed = client.post(f"{BASE}/tickets/{ticket['id']}/close", headers=cast["alice"].headers)
    assert closed.status_code == 200, closed.text
    assert closed.json()["status"] == "closed"
    assert closed.json()["closed_at"] is not None
    assert closed.json()["resolved_at"] is None

    # And the closed thread is shut to the employee, who would otherwise be
    # typing into a conversation nobody is watching.
    reply = client.post(
        f"{BASE}/tickets/{ticket['id']}/comments",
        json={"body": "actually..."},
        headers=cast["alice"].headers,
    )
    assert reply.status_code == 409
    assert reply.json()["detail"]["reason"] == "ticket_closed"


def test_staff_update_stamps_the_timestamps_the_client_cannot_set(client, cast):
    ticket = _raise_ticket(client, cast["alice"])
    response = client.patch(
        f"{BASE}/staff/tickets/{ticket['id']}",
        json={
            "status": "resolved",
            "priority": "urgent",
            # Not fields on TicketUpdateIn. They must be ignored, never applied.
            "resolved_at": "2000-01-01T00:00:00Z",
            "closed_at": "2000-01-01T00:00:00Z",
            "source_module": "regularization",
            "source_ref": str(uuid.uuid4()),
        },
        headers=cast["hr"].headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["priority"] == "urgent"
    assert body["resolved_at"] is not None
    assert not body["resolved_at"].startswith("2000")
    assert body["closed_at"] is None
    # Provenance is set once at creation and is not an editable property.
    assert body["source_module"] is None
    assert body["source_ref"] is None


# --------------------------------------------------------------------------- #
# D-019 — the back-link must not become an existence oracle
# --------------------------------------------------------------------------- #


def _regularization_for(user_id: uuid.UUID, org_id: uuid.UUID) -> uuid.UUID:
    with SessionLocal() as db:
        row = RegularizationRequest(
            id=uuid.uuid4(), org_id=org_id, user_id=user_id, date=date(2026, 3, 14),
            requested_check_in=datetime(2026, 3, 14, 9, 15, tzinfo=timezone.utc),
            reason="Forgot to punch in.", created_by_user_id=user_id,
        )
        db.add(row)
        db.commit()
        return row.id


def _ticket_with_source(org_id, raiser_id, module, ref) -> uuid.UUID:
    """Write the ticket directly, bypassing the API's write-time check.

    Deliberate: the read path has to stay safe for rows the write path never
    saw — a seeder, a bulk import, or a ref that was legitimate when it was
    written and stopped being so when the employee changed teams.
    """
    with SessionLocal() as db:
        ticket = HelpdeskTicket(
            id=uuid.uuid4(), org_id=org_id, raised_by=raiser_id,
            subject="Dispute", description="Please look again.",
            status="open", priority="normal", source_module=module, source_ref=ref,
        )
        db.add(ticket)
        db.commit()
        return ticket.id


def test_a_verified_source_link_resolves_with_a_label(client, cast):
    reg_id = _regularization_for(cast["alice"].id, cast["acme"].id)
    ticket = _raise_ticket(
        client, cast["alice"], source_module="regularization", source_ref=str(reg_id)
    )
    assert ticket["source_module"] == "regularization"

    link = client.get(f"{BASE}/tickets/{ticket['id']}/source", headers=cast["alice"].headers)
    assert link.status_code == 200, link.text
    assert link.json() == {
        "module": "regularization",
        "ref": str(reg_id),
        "available": True,
        "label": "Attendance correction for 2026-03-14",
    }


def test_an_unauthorised_ref_is_indistinguishable_from_a_dangling_one(client, cast):
    """The oracle test. Two answers that must be byte-identical.

    If "you may not see that row" ever differs from "that row does not exist",
    an attacker enumerates ids one ticket at a time and reads the answer off
    the rendered link. The ref is a pointer, not a grant, so both are simply
    unavailable and neither says why.
    """
    bobs_reg = _regularization_for(cast["bob"].id, cast["acme"].id)
    unauthorised = _ticket_with_source(
        cast["acme"].id, cast["alice"].id, "regularization", bobs_reg
    )
    dangling = _ticket_with_source(
        cast["acme"].id, cast["alice"].id, "regularization", uuid.uuid4()
    )

    def link_for(ticket_id):
        response = client.get(f"{BASE}/tickets/{ticket_id}/source", headers=cast["alice"].headers)
        assert response.status_code == 200, response.text
        body = response.json()
        return {k: v for k, v in body.items() if k != "ref"}

    assert link_for(unauthorised) == link_for(dangling)
    assert link_for(dangling) == {
        "module": "regularization",
        "available": False,
        "label": None,
    }


def test_an_unknown_source_module_does_not_raise(client_raising, cast):
    """A renamed module, or a deployment without that feature. Not a KeyError.

    ``client_raising`` on purpose: a 500 here should surface as a traceback
    naming the dispatch, not as a status code that looks like a deliberate
    refusal.
    """
    ticket_id = _ticket_with_source(
        cast["acme"].id, cast["alice"].id, "quantum_flux", uuid.uuid4()
    )
    response = client_raising.get(
        f"{BASE}/tickets/{ticket_id}/source", headers=cast["alice"].headers
    )
    assert response.status_code == 200, response.text
    assert response.json()["available"] is False
    assert response.json()["label"] is None

    detail = client_raising.get(f"{BASE}/tickets/{ticket_id}", headers=cast["alice"].headers)
    assert detail.status_code == 200
    assert detail.json()["source_module"] == "quantum_flux"


def test_a_ticket_with_no_source_link_renders_as_unavailable(client, cast):
    ticket = _raise_ticket(client, cast["alice"])
    link = client.get(f"{BASE}/tickets/{ticket['id']}/source", headers=cast["alice"].headers)
    assert link.json() == {"module": None, "ref": None, "available": False, "label": None}


def test_an_unverifiable_ref_is_refused_at_write_time(client, cast):
    """The oracle is closed at the write, not only at the read.

    A ticket that was stored and then reported as unavailable would still have
    answered the attacker's question. Both refusals carry the same message:
    "unknown module" is safe to name because it carries no id, but "not yours"
    and "does not exist" must not be told apart.
    """
    bobs_reg = _regularization_for(cast["bob"].id, cast["acme"].id)

    not_mine = client.post(
        f"{BASE}/tickets",
        json={
            "subject": "probe", "description": "probe",
            "source_module": "regularization", "source_ref": str(bobs_reg),
        },
        headers=cast["alice"].headers,
    )
    assert not_mine.status_code == 422, not_mine.text
    assert not_mine.json()["detail"]["reason"] == "source_not_verifiable"

    nonexistent = client.post(
        f"{BASE}/tickets",
        json={
            "subject": "probe", "description": "probe",
            "source_module": "regularization", "source_ref": str(uuid.uuid4()),
        },
        headers=cast["alice"].headers,
    )
    assert nonexistent.status_code == 422
    assert nonexistent.json()["detail"] == not_mine.json()["detail"]

    unknown_module = client.post(
        f"{BASE}/tickets",
        json={
            "subject": "probe", "description": "probe",
            "source_module": "quantum_flux", "source_ref": str(uuid.uuid4()),
        },
        headers=cast["alice"].headers,
    )
    assert unknown_module.status_code == 422
    assert unknown_module.json()["detail"] == not_mine.json()["detail"]

    with SessionLocal() as db:
        assert db.scalar(select(HelpdeskTicket.id)) is None


def test_a_half_filled_source_pair_is_a_422_not_a_500(client, cast):
    """Mirrors ``ck_helpdesk_tickets_source_pair`` at the edge, with a field name."""
    response = client.post(
        f"{BASE}/tickets",
        json={"subject": "x", "description": "y", "source_ref": str(uuid.uuid4())},
        headers=cast["alice"].headers,
    )
    assert response.status_code == 422


# --------------------------------------------------------------------------- #
# Alerts — through the one door
# --------------------------------------------------------------------------- #


def _alerts(kind: str) -> list[NotificationLog]:
    with SessionLocal() as db:
        return list(
            db.scalars(select(NotificationLog).where(NotificationLog.kind == kind)).all()
        )


def test_assignment_and_resolution_go_through_dispatch(client, cast):
    ticket = _raise_ticket(client, cast["alice"])
    client.post(
        f"{BASE}/staff/tickets/{ticket['id']}/assign",
        json={"assignee_id": str(cast["hr"].id)},
        headers=cast["owner"].headers,
    )
    assigned = _alerts("ticket_assigned")
    assert [a.user_id for a in assigned] == [cast["hr"].id]

    client.post(f"{BASE}/staff/tickets/{ticket['id']}/resolve", headers=cast["hr"].headers)
    resolved = _alerts("ticket_resolved")
    assert [a.user_id for a in resolved] == [cast["alice"].id]


def test_resolving_again_after_a_reopen_alerts_again(client, cast):
    """The dedupe key carries ``resolved_at``, which a reopen clears.

    Keying on the ticket id alone would silence the second resolution, and the
    person waiting on it would never be told the fix had landed.
    """
    ticket = _raise_ticket(client, cast["alice"])
    client.post(f"{BASE}/staff/tickets/{ticket['id']}/resolve", headers=cast["hr"].headers)
    client.post(f"{BASE}/staff/tickets/{ticket['id']}/reopen", headers=cast["hr"].headers)
    client.post(f"{BASE}/staff/tickets/{ticket['id']}/resolve", headers=cast["hr"].headers)

    keys = {a.dedupe_key for a in _alerts("ticket_resolved")}
    assert len(keys) == 2


def test_nobody_is_emailed_about_their_own_action(client, cast):
    """An HR user assigning a ticket to themselves does not need telling."""
    ticket = _raise_ticket(client, cast["alice"])
    client.post(
        f"{BASE}/staff/tickets/{ticket['id']}/assign",
        json={"assignee_id": str(cast["hr"].id)},
        headers=cast["hr"].headers,
    )
    assert _alerts("ticket_assigned") == []


# --------------------------------------------------------------------------- #
# Tenancy
# --------------------------------------------------------------------------- #


def test_tenant_isolation(client, cast):
    """Every helpdesk query is org-scoped, on both surfaces.

    Two independent gates already stand between these tenants — the token
    carries its org and ``get_current_user`` refuses a mismatch — so this is
    asserting the third: that a handler which somehow got past both still
    cannot read the row.
    """
    acme_ticket = _raise_ticket(client, cast["alice"])
    client.post(
        f"{BASE}/staff/tickets/{acme_ticket['id']}/comments",
        json={"body": "internal", "is_internal": True},
        headers=cast["hr"].headers,
    )
    client.post(f"{BASE}/categories", json={"name": "Acme only"}, headers=cast["hr"].headers)

    other = cast["other_owner"].headers
    assert client.get(f"{BASE}/staff/tickets/{acme_ticket['id']}", headers=other).status_code == 404
    assert client.get(f"{BASE}/tickets/{acme_ticket['id']}", headers=other).status_code == 404
    assert client.get(f"{BASE}/staff/tickets", headers=other).json() == []
    assert client.get(f"{BASE}/categories", headers=other).json() == []

    patched = client.patch(
        f"{BASE}/staff/tickets/{acme_ticket['id']}",
        json={"status": "closed"},
        headers=other,
    )
    assert patched.status_code == 404
    with SessionLocal() as db:
        assert db.get(HelpdeskTicket, uuid.UUID(acme_ticket["id"])).status == "open"


def test_a_category_from_another_tenant_cannot_be_used(client, cast):
    created = client.post(
        f"{BASE}/categories", json={"name": "Globex only"},
        headers=cast["other_owner"].headers,
    ).json()

    response = client.post(
        f"{BASE}/tickets",
        json={"subject": "x", "description": "y", "category_id": created["id"]},
        headers=cast["alice"].headers,
    )
    assert response.status_code == 404, response.text


def test_a_source_row_in_another_tenant_is_never_verifiable(client, cast):
    """Same answer as a dangling ref, for the same reason.

    The cross-tenant case is the one where "denied" versus "gone" would be a
    breach rather than an annoyance: it would confirm the id exists somewhere.
    """
    globex_owner_id = cast["other_owner"].id
    foreign_reg = _regularization_for(globex_owner_id, cast["globex"].id)

    refused = client.post(
        f"{BASE}/tickets",
        json={
            "subject": "x", "description": "y",
            "source_module": "regularization", "source_ref": str(foreign_reg),
        },
        headers=cast["alice"].headers,
    )
    assert refused.status_code == 422
    assert refused.json()["detail"]["reason"] == "source_not_verifiable"

    ticket_id = _ticket_with_source(
        cast["acme"].id, cast["alice"].id, "regularization", foreign_reg
    )
    link = client.get(f"{BASE}/tickets/{ticket_id}/source", headers=cast["alice"].headers).json()
    assert link["available"] is False and link["label"] is None
