"""Onboarding: templates, instantiation, tasks, documents, pre-boarding.

The plan's exit criterion for this phase is that a checklist appears and can be
ticked off. That is the easy half. What this suite is actually built around is
the guarantee the whole module rests on and that nothing in the schema can
enforce:

**an instance is a copy of a template, not a reference to one.**

``test_editing_the_template_does_not_touch_an_in_flight_instance`` is that
assertion, and it is deliberately brutal: the template is renamed, reordered,
re-offset, has a row deleted, has a row added, and is finally deleted outright
— after which the hire's checklist must still read exactly as it did when it
was cut. A reference-based implementation passes every other test in this file
and fails only that one, which is why it exists.

Two more failures are asserted here because they are silent rather than loud:

* **Auto-spawn on user creation.** A tenant's first act is importing its
  existing staff. If instantiation were a side effect of creating a ``users``
  row, that import would produce a checklist of overdue tasks per employee and
  nobody would find out until the pipeline view was opened.
* **``storage_key`` in a response body.** Every onboarding response is scanned
  for the literal key, not merely for the field name — a client that holds a
  key holds a capability the download endpoint's permission check can never see
  being used.
"""

from __future__ import annotations

import json
import uuid
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.core.security import create_access_token, generate_enrollment_key, hash_password
from app.db.session import SessionLocal
from app.models import (
    Department,
    OnboardingDocument,
    OnboardingInstance,
    OnboardingTask,
    Organization,
    Subscription,
    User,
    UserStatus,
)
from app.services import onboarding as svc


@pytest.fixture(scope="module", autouse=True)
def _onboarding_router_mounted():
    """Mount the router if the lead has not wired it into ``router.py`` yet.

    The backend lands before the integration seam does, and twenty cryptic 404s
    say nothing about whether the module works. This registers the real router
    on the real app so everything below is exercised for real, and it becomes a
    no-op the moment ``api/v1/router.py`` includes it — which
    ``test_router_is_registered_for_integration`` asserts separately, against
    the router module rather than the app, so this shim can never hide a
    missing registration.
    """
    from app.api.v1 import onboarding as onboarding_api
    from app.main import app

    if not any(getattr(r, "path", "").startswith("/api/v1/onboarding") for r in app.routes):
        app.include_router(onboarding_api.router, prefix="/api/v1")
        app.openapi_schema = None
    yield


def test_router_is_registered_for_integration():
    """Fails until the lead adds onboarding to ``api/v1/router.py``. Deliberate."""
    from app.api.v1.router import api_router

    paths = {getattr(route, "path", "") for route in api_router.routes}
    assert any(path.startswith("/api/v1/onboarding") for path in paths), (
        "app/api/v1/router.py does not include onboarding.router — see the Phase 6 "
        "integration request"
    )


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

TODAY = date.today()


def _template_body(name="Engineering onboarding", department_id=None, tasks=None):
    return {
        "name": name,
        "department_id": str(department_id) if department_id else None,
        "is_active": True,
        "tasks": tasks
        if tasks is not None
        else [
            {
                "title": "Countersign the offer letter",
                "category": "documentation",
                "owner_role": "hr",
                "due_offset_days": -7,
                "sort_order": 1,
                "requires_document": True,
                "doc_type": "offer_letter",
            },
            {
                "title": "Order the laptop",
                "category": "it_setup",
                "owner_role": "it",
                "due_offset_days": -2,
                "sort_order": 2,
            },
            {
                "title": "Read the handbook",
                "category": "training",
                "owner_role": "employee",
                "due_offset_days": 3,
                "sort_order": 3,
            },
        ],
    }


def _make_template(client, tenant, **kwargs):
    resp = client.post(
        "/api/v1/onboarding/templates", json=_template_body(**kwargs), headers=tenant.headers()
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _make_hire(
    tenant,
    *,
    email="newhire@acme.test",
    joined_on: date | None = None,
    status: str = UserStatus.PENDING_SETUP.value,
    with_password: bool = False,
    department_id=None,
) -> uuid.UUID:
    """A pre-boarding ``users`` row: no password, no login, a joining date.

    Created directly rather than through ``POST /admin/employees`` because that
    handler does not currently write ``status`` at all (reported to the lead) —
    and this suite needs the pre-boarding state to exist regardless of which
    door produced it.
    """
    with SessionLocal() as db:
        user = User(
            id=uuid.uuid4(),
            org_id=tenant.id,
            email=email,
            full_name="Nadia Newhire",
            role="employee",
            password_hash=hash_password("correct-horse-battery") if with_password else None,
            # is_active stays True: per D-016 this is the sole authentication
            # gate, and a pre-boarding hire is kept out by having no password,
            # not by a status column. Setting it False here would make the
            # login assertions below prove nothing about `status`.
            is_active=True,
            status=status,
            joined_on=joined_on,
            department_id=department_id,
            enrollment_key=generate_enrollment_key(),
        )
        db.add(user)
        db.commit()
        return user.id


def _token_for(tenant, user_id: uuid.UUID) -> str:
    with SessionLocal() as db:
        user = db.get(User, user_id)
        return create_access_token(
            str(user.id), {"typ": "user", "org": str(user.org_id), "role": user.role}
        )


def _start_instance(client, tenant, user_id, **extra):
    body = {"user_id": str(user_id), **extra}
    resp = client.post("/api/v1/onboarding/instances", json=body, headers=tenant.headers())
    assert resp.status_code == 201, resp.text
    return resp.json()


def _flat_tasks(instance: dict) -> list[dict]:
    return [task for group in instance["groups"] for task in group["tasks"]]


def _by_title(instance: dict) -> dict[str, dict]:
    return {t["title"]: t for t in _flat_tasks(instance)}


# --------------------------------------------------------------------------- #
# Instantiation: the copy, and the dates
# --------------------------------------------------------------------------- #


def test_instantiation_copies_tasks_and_resolves_due_dates(client, tenants):
    """Every blueprint field is duplicated, and the offset becomes a date."""
    acme, _ = tenants
    _make_template(client, acme)
    joining = TODAY + timedelta(days=10)
    hire = _make_hire(acme, joined_on=joining)

    instance = _start_instance(client, acme, hire, joining_date=joining.isoformat())

    tasks = _by_title(instance)
    assert set(tasks) == {
        "Countersign the offer letter",
        "Order the laptop",
        "Read the handbook",
    }
    # due_offset_days resolved against THIS instance's joining_date, once.
    assert tasks["Countersign the offer letter"]["due_date"] == (
        joining - timedelta(days=7)
    ).isoformat()
    assert tasks["Order the laptop"]["due_date"] == (joining - timedelta(days=2)).isoformat()
    assert tasks["Read the handbook"]["due_date"] == (joining + timedelta(days=3)).isoformat()

    # The rest of the blueprint row came across too, not just the title.
    assert tasks["Order the laptop"]["category"] == "it_setup"
    assert tasks["Order the laptop"]["owner_role"] == "it"
    assert tasks["Countersign the offer letter"]["requires_document"] is True
    assert tasks["Countersign the offer letter"]["doc_type"] == "offer_letter"
    assert all(t["status"] == "pending" for t in _flat_tasks(instance))

    # And an offset is nowhere on a live task: that field is the template's.
    assert all("due_offset_days" not in t for t in _flat_tasks(instance))

    # The template's name is snapshotted, not resolved through the FK.
    assert instance["template_name"] == "Engineering onboarding"
    assert instance["total_tasks"] == 3


def test_it_setup_category_survives_instantiation_verbatim(client, tenants):
    """``it_setup`` is load-bearing across a module boundary — Assets keys off it.

    Asserted as a literal string rather than through the enum, because the
    thing that would break the asset module is the *value* changing, and a test
    written against the enum would follow a rename straight past the bug.
    """
    acme, _ = tenants
    _make_template(client, acme)
    hire = _make_hire(acme, joined_on=TODAY)
    instance = _start_instance(client, acme, hire)

    categories = {t["category"] for t in _flat_tasks(instance)}
    assert "it_setup" in categories
    assert {g["category"] for g in instance["groups"]} >= {"it_setup"}


def test_editing_the_template_does_not_touch_an_in_flight_instance(client, tenants):
    """The central guarantee of this module.

    A reference-based implementation passes every other test in this file and
    fails here, which is the whole reason the assertions are this exhaustive.
    """
    acme, _ = tenants
    template = _make_template(client, acme)
    joining = TODAY + timedelta(days=10)
    hire = _make_hire(acme, joined_on=joining)
    instance = _start_instance(client, acme, hire, joining_date=joining.isoformat())
    before = _by_title(instance)

    # Now do everything an HR admin does to a template over a year: rename a
    # task, move an offset, reorder, delete one, add one, retire the template.
    edited = _template_body(
        name="Engineering onboarding v2",
        tasks=[
            {
                "title": "Countersigned offer letter (RENAMED)",
                "category": "compliance",
                "owner_role": "manager",
                "due_offset_days": 90,
                "sort_order": 9,
                "requires_document": False,
            },
            {
                "title": "Brand new task nobody in flight should ever see",
                "category": "other",
                "owner_role": "hr",
                "due_offset_days": 1,
                "sort_order": 1,
            },
        ],
    )
    edited["is_active"] = False
    resp = client.put(
        f"/api/v1/onboarding/templates/{template['id']}", json=edited, headers=acme.headers()
    )
    assert resp.status_code == 200, resp.text

    after = _by_title(
        client.get(
            f"/api/v1/onboarding/instances/{instance['id']}", headers=acme.headers()
        ).json()
    )
    assert after == before, "editing the template rewrote a checklist already in flight"

    # And the blueprint is really gone from underneath it.
    assert (
        client.delete(
            f"/api/v1/onboarding/templates/{template['id']}", headers=acme.headers()
        ).status_code
        == 204
    )
    final = client.get(
        f"/api/v1/onboarding/instances/{instance['id']}", headers=acme.headers()
    ).json()
    assert _by_title(final) == before
    # template_id goes NULL (SET NULL); the snapshotted name is what answers
    # "which checklist did this person get".
    assert final["template_id"] is None
    assert final["template_name"] == "Engineering onboarding"


def test_a_second_hire_gets_the_edited_template(client, tenants):
    """The other half of the same rule: edits DO reach the next hire.

    Without this, "never rewrite an instance" would be satisfied by a template
    editor that silently did nothing at all.
    """
    acme, _ = tenants
    template = _make_template(client, acme)
    first = _make_hire(acme, joined_on=TODAY, email="first@acme.test")
    _start_instance(client, acme, first)

    edited = _template_body(
        tasks=[{"title": "Only task now", "category": "other", "due_offset_days": 0}]
    )
    client.put(
        f"/api/v1/onboarding/templates/{template['id']}", json=edited, headers=acme.headers()
    )

    second = _make_hire(acme, joined_on=TODAY, email="second@acme.test")
    instance = _start_instance(client, acme, second)
    assert list(_by_title(instance)) == ["Only task now"]


def test_department_template_wins_over_the_org_wide_fallback(client, tenants):
    """``department_id IS NULL`` means "every department", not "unassigned"."""
    acme, _ = tenants
    with SessionLocal() as db:
        dept = Department(id=uuid.uuid4(), org_id=acme.id, name="Engineering")
        db.add(dept)
        db.commit()
        dept_id = dept.id

    _make_template(client, acme, name="Everyone", tasks=[
        {"title": "Org-wide task", "category": "other", "due_offset_days": 0}
    ])
    _make_template(client, acme, name="Engineering", department_id=dept_id, tasks=[
        {"title": "Engineering task", "category": "it_setup", "due_offset_days": 0}
    ])

    engineer = _make_hire(acme, joined_on=TODAY, email="eng@acme.test", department_id=dept_id)
    other = _make_hire(acme, joined_on=TODAY, email="other@acme.test")

    assert list(_by_title(_start_instance(client, acme, engineer))) == ["Engineering task"]
    assert list(_by_title(_start_instance(client, acme, other))) == ["Org-wide task"]


# --------------------------------------------------------------------------- #
# Instantiation is explicit, not a side effect of creating a user
# --------------------------------------------------------------------------- #


def _instance_count(org_id) -> int:
    with SessionLocal() as db:
        return len(
            db.scalars(
                select(OnboardingInstance).where(OnboardingInstance.org_id == org_id)
            ).all()
        )


def _grant_seats(org_id, seats: int = 50) -> None:
    """An active subscription, so ``POST /admin/employees`` is reachable.

    The conftest tenants have no subscription row and therefore no seats, which
    makes employee creation 402 before it ever reaches the code this test is
    about. Granted here rather than in conftest because it is this test's
    setup, not everybody's. The organisation's own status has to move too:
    ``Entitlement.dashboard_allowed`` is org status AND subscription status.
    """
    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        db.get(Organization, org_id).status = "active"
        db.add(
            Subscription(
                id=uuid.uuid4(),
                org_id=org_id,
                plan_id="standard",
                billing_cycle="annual",
                seats=seats,
                status="active",
                period_start=now - timedelta(days=1),
                period_end=now + timedelta(days=365),
                activated_at=now,
            )
        )
        db.commit()


def test_bulk_user_creation_does_not_spawn_instances(client, tenants):
    """Importing existing staff must produce zero checklists.

    Through the real employee-creation endpoint, with a template in place that
    matches every one of them and two of the six joining in the *future*, so
    this is not passing by accident — creating a user is simply not what
    creates a checklist.
    """
    acme, _ = tenants
    _grant_seats(acme.id)
    _make_template(client, acme)

    for index in range(6):
        joined = TODAY - timedelta(days=900 + index) if index < 4 else TODAY + timedelta(days=5)
        resp = client.post(
            "/api/v1/admin/employees",
            json={
                "email": f"import{index}@acme-imports.example.com",
                "full_name": f"Imported {index}",
                "role": "employee",
                "joined_on": joined.isoformat(),
            },
            headers=acme.headers(),
        )
        assert resp.status_code == 201, resp.text

    assert _instance_count(acme.id) == 0


def test_the_hook_declines_for_a_historical_joining_date(client, tenants):
    """``maybe_start_for_new_hire`` is the conditional door.

    Two hundred existing staff carry two hundred historical joining dates; the
    hook must return ``None`` for every one of them.
    """
    acme, _ = tenants
    _make_template(client, acme)
    old = _make_hire(acme, joined_on=TODAY - timedelta(days=900), email="old@acme.test")
    soon = _make_hire(acme, joined_on=TODAY + timedelta(days=3), email="soon@acme.test")
    undated = _make_hire(acme, joined_on=None, email="undated@acme.test")

    with SessionLocal() as db:
        assert svc.maybe_start_for_new_hire(db, db.get(User, old)) is None
        assert svc.maybe_start_for_new_hire(db, db.get(User, undated)) is None
        started = svc.maybe_start_for_new_hire(db, db.get(User, soon))
        assert started is not None
        db.commit()

    assert _instance_count(acme.id) == 1


def test_hr_can_start_a_checklist_by_hand_for_a_hire_imported_last_week(client, tenants):
    """The direct door is deliberately unguarded on the date.

    This is the case a date guard on the *only* path would have destroyed: the
    hire is already here, the joining date is in the past, and HR still needs a
    checklist. Due dates resolve against the historical date and read overdue,
    which is correct — they are.
    """
    acme, _ = tenants
    _make_template(client, acme)
    joining = TODAY - timedelta(days=7)
    hire = _make_hire(acme, joined_on=joining, email="lastweek@acme.test")

    instance = _start_instance(client, acme, hire)
    tasks = _by_title(instance)
    assert tasks["Order the laptop"]["due_date"] == (joining - timedelta(days=2)).isoformat()
    assert tasks["Order the laptop"]["is_overdue"] is True
    assert instance["overdue_tasks"] == 3


def test_a_second_open_checklist_is_refused(client, tenants):
    acme, _ = tenants
    _make_template(client, acme)
    hire = _make_hire(acme, joined_on=TODAY)
    _start_instance(client, acme, hire)

    resp = client.post(
        "/api/v1/onboarding/instances", json={"user_id": str(hire)}, headers=acme.headers()
    )
    assert resp.status_code == 409
    assert resp.json()["detail"]["reason"] == "onboarding_already_open"


# --------------------------------------------------------------------------- #
# Pre-boarding — D-016
# --------------------------------------------------------------------------- #


def test_pending_setup_hire_cannot_authenticate_but_has_a_live_checklist(client, tenants):
    """The pre-boarding case, both halves.

    HR runs a checklist for somebody a fortnight before they can log in. The
    hire has no password, so they cannot authenticate — and the checklist is
    fully live regardless.
    """
    acme, _ = tenants
    _make_template(client, acme)
    joining = TODAY + timedelta(days=14)
    hire = _make_hire(acme, joined_on=joining, email="preboard@acme.test")

    login = client.post(
        "/api/v1/auth/login",
        json={"email": "preboard@acme.test", "password": "correct-horse-battery"},
        headers={"X-Org-Slug": acme.slug},
    )
    assert login.status_code == 401

    instance = _start_instance(client, acme, hire, joining_date=joining.isoformat())
    assert instance["status"] == "pending_setup"
    assert instance["total_tasks"] == 3
    # HR can work it before day one — this is the entire point of pre-boarding.
    task = _by_title(instance)["Order the laptop"]
    resp = client.post(
        f"/api/v1/onboarding/tasks/{task['id']}/status",
        json={"status": "done"},
        headers=acme.headers(),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "done"


def test_status_pending_setup_does_not_gate_login(client, tenants):
    """D-016: ``is_active`` is the SOLE authentication gate.

    A hire still marked ``pending_setup`` who has been given a password logs in
    normally. If this ever fails, login has been wired to ``status`` and there
    are now two switches that can disagree about whether somebody may log in —
    which is the exact failure D-016 exists to prevent.
    """
    acme, _ = tenants
    _make_hire(
        acme,
        joined_on=TODAY,
        email="hasapassword@acme.test",
        status=UserStatus.PENDING_SETUP.value,
        with_password=True,
    )
    resp = client.post(
        "/api/v1/auth/login",
        json={"email": "hasapassword@acme.test", "password": "correct-horse-battery"},
        headers={"X-Org-Slug": acme.slug},
    )
    assert resp.status_code == 200, resp.text


def test_the_hire_reads_and_works_their_own_checklist(client, tenants):
    """The plan's exit criterion: HR *and* the new hire can check items off."""
    acme, _ = tenants
    _make_template(client, acme)
    hire = _make_hire(acme, joined_on=TODAY, email="worker@acme.test", with_password=True)
    instance = _start_instance(client, acme, hire)
    hire_headers = acme.headers(_token_for(acme, hire))

    mine = client.get("/api/v1/onboarding/my", headers=hire_headers)
    assert mine.status_code == 200, mine.text
    assert mine.json()["id"] == instance["id"]

    tasks = _by_title(instance)
    own = tasks["Read the handbook"]  # owner_role == "employee"
    resp = client.post(
        f"/api/v1/onboarding/tasks/{own['id']}/status",
        json={"status": "done"},
        headers=hire_headers,
    )
    assert resp.status_code == 200, resp.text

    # ...but not somebody else's sign-off, even on their own checklist.
    hr_owned = tasks["Order the laptop"]  # owner_role == "it"
    refused = client.post(
        f"/api/v1/onboarding/tasks/{hr_owned['id']}/status",
        json={"status": "done"},
        headers=hire_headers,
    )
    assert refused.status_code == 403


def test_an_unrelated_employee_cannot_read_a_hire_checklist(client, tenants):
    acme, _ = tenants
    _make_template(client, acme)
    hire = _make_hire(acme, joined_on=TODAY)
    instance = _start_instance(client, acme, hire)

    resp = client.get(
        f"/api/v1/onboarding/instances/{instance['id']}",
        headers=acme.headers(acme.employee_token),
    )
    assert resp.status_code == 403
    # And the pipeline is not readable by a non-administrator at all.
    assert (
        client.get(
            "/api/v1/onboarding/instances", headers=acme.headers(acme.employee_token)
        ).status_code
        == 403
    )


# --------------------------------------------------------------------------- #
# Task lifecycle
# --------------------------------------------------------------------------- #


def test_completing_every_task_completes_the_checklist(client, tenants):
    acme, _ = tenants
    _make_template(client, acme, tasks=[
        {"title": "One", "category": "other", "due_offset_days": 0},
        {"title": "Two", "category": "other", "due_offset_days": 0},
    ])
    hire = _make_hire(acme, joined_on=TODAY)
    instance = _start_instance(client, acme, hire)
    first, second = _flat_tasks(instance)

    client.post(
        f"/api/v1/onboarding/tasks/{first['id']}/status",
        json={"status": "done"},
        headers=acme.headers(),
    )
    mid = client.get(
        f"/api/v1/onboarding/instances/{instance['id']}", headers=acme.headers()
    ).json()
    assert mid["status"] == "in_progress"
    assert mid["started_at"] is not None
    assert mid["completed_at"] is None

    # A skip closes the checklist too — "not applicable" is a real ending — but
    # it is not counted as work done.
    client.post(
        f"/api/v1/onboarding/tasks/{second['id']}/status",
        json={"status": "skipped", "notes": "Contractor, no handbook"},
        headers=acme.headers(),
    )
    done = client.get(
        f"/api/v1/onboarding/instances/{instance['id']}", headers=acme.headers()
    ).json()
    assert done["status"] == "completed"
    assert done["completed_at"] is not None
    assert (done["completed_tasks"], done["closed_tasks"]) == (1, 2)


def test_a_skip_without_a_reason_is_refused(client, tenants):
    acme, _ = tenants
    _make_template(client, acme)
    hire = _make_hire(acme, joined_on=TODAY)
    instance = _start_instance(client, acme, hire)
    task = _flat_tasks(instance)[0]

    resp = client.post(
        f"/api/v1/onboarding/tasks/{task['id']}/status",
        json={"status": "skipped"},
        headers=acme.headers(),
    )
    assert resp.status_code == 422
    assert resp.json()["detail"]["reason"] == "skip_reason_required"


def test_reopening_a_task_clears_the_attribution_and_reopens_the_checklist(client, tenants):
    acme, _ = tenants
    _make_template(client, acme, tasks=[
        {"title": "Only", "category": "other", "due_offset_days": 0}
    ])
    hire = _make_hire(acme, joined_on=TODAY)
    instance = _start_instance(client, acme, hire)
    task = _flat_tasks(instance)[0]

    closed = client.post(
        f"/api/v1/onboarding/tasks/{task['id']}/status",
        json={"status": "done"},
        headers=acme.headers(),
    ).json()
    assert closed["completed_by"] is not None
    assert closed["completed_by_name"] == "Acme Ltd Owner"

    reopened = client.post(
        f"/api/v1/onboarding/tasks/{task['id']}/status",
        json={"status": "in_progress"},
        headers=acme.headers(),
    ).json()
    assert reopened["completed_by"] is None
    assert reopened["completed_at"] is None

    instance_now = client.get(
        f"/api/v1/onboarding/instances/{instance['id']}", headers=acme.headers()
    ).json()
    assert instance_now["status"] == "in_progress"
    assert instance_now["completed_at"] is None


def test_rescheduling_the_joining_date_moves_open_tasks_only(client, tenants):
    """A completed task's due date is part of the record of what happened."""
    acme, _ = tenants
    _make_template(client, acme)
    joining = TODAY + timedelta(days=10)
    hire = _make_hire(acme, joined_on=joining)
    instance = _start_instance(client, acme, hire, joining_date=joining.isoformat())

    done_task = _by_title(instance)["Order the laptop"]
    original_due = done_task["due_date"]
    client.post(
        f"/api/v1/onboarding/tasks/{done_task['id']}/status",
        json={"status": "done"},
        headers=acme.headers(),
    )

    moved = joining + timedelta(days=5)
    resp = client.patch(
        f"/api/v1/onboarding/instances/{instance['id']}",
        json={"joining_date": moved.isoformat()},
        headers=acme.headers(),
    )
    assert resp.status_code == 200, resp.text
    tasks = _by_title(resp.json())
    assert tasks["Order the laptop"]["due_date"] == original_due
    assert tasks["Read the handbook"]["due_date"] == (moved + timedelta(days=3)).isoformat()


def test_a_document_task_cannot_be_completed_with_nothing_attached(client, tenants):
    acme, _ = tenants
    _make_template(client, acme)
    hire = _make_hire(acme, joined_on=TODAY)
    instance = _start_instance(client, acme, hire)
    task = _by_title(instance)["Countersign the offer letter"]

    resp = client.post(
        f"/api/v1/onboarding/tasks/{task['id']}/status",
        json={"status": "done"},
        headers=acme.headers(),
    )
    assert resp.status_code == 422
    assert resp.json()["detail"]["reason"] == "document_required"


# --------------------------------------------------------------------------- #
# Documents
# --------------------------------------------------------------------------- #

_PDF = b"%PDF-1.4 pretend this is a countersigned offer letter\n%%EOF"


def _upload(client, headers, instance_id, *, doc_type="offer_letter", task_id=None,
            content=_PDF, filename="offer.pdf"):
    meta = {"doc_type": doc_type}
    if task_id:
        meta["task_id"] = str(task_id)
    return client.post(
        f"/api/v1/onboarding/instances/{instance_id}/documents",
        data={"meta": json.dumps(meta)},
        files={"file": (filename, content, "application/pdf")},
        headers=headers,
    )


def test_document_upload_download_round_trip_with_permission_enforced(client, tenants):
    """The hire uploads, the hire and HR download, nobody else does."""
    acme, _ = tenants
    _make_template(client, acme)
    hire = _make_hire(acme, joined_on=TODAY, email="uploader@acme.test", with_password=True)
    instance = _start_instance(client, acme, hire)
    hire_headers = acme.headers(_token_for(acme, hire))
    task = _by_title(instance)["Countersign the offer letter"]

    created = _upload(client, hire_headers, instance["id"], task_id=task["id"])
    assert created.status_code == 201, created.text
    doc = created.json()
    assert doc["file_size"] == len(_PDF)
    assert doc["is_verified"] is False

    # Round trip: the bytes that come back are the bytes that went in.
    mine = client.get(f"/api/v1/onboarding/documents/{doc['id']}/file", headers=hire_headers)
    assert mine.status_code == 200
    assert mine.content == _PDF
    assert client.get(
        f"/api/v1/onboarding/documents/{doc['id']}/file", headers=acme.headers()
    ).content == _PDF

    # An unrelated colleague may not read somebody's ID documents.
    refused = client.get(
        f"/api/v1/onboarding/documents/{doc['id']}/file",
        headers=acme.headers(acme.employee_token),
    )
    assert refused.status_code == 403

    # With the evidence attached, the task closes.
    assert (
        client.post(
            f"/api/v1/onboarding/tasks/{task['id']}/status",
            json={"status": "done"},
            headers=acme.headers(),
        ).status_code
        == 200
    )


def test_storage_key_never_appears_in_any_response_body(client, tenants):
    """Scanned for the key itself, not merely for the field name.

    A client holding a storage key holds a capability that the download
    endpoint's permission check can never see being exercised — and one whose
    neighbours it can enumerate, since the key layout is
    ``<org>/<user>/<day>/<id>``. So the assertion is on the literal value, and
    it covers the upload response, the instance detail, the pipeline list and
    the verify response, because every one of them serialises the row.
    """
    acme, _ = tenants
    _make_template(client, acme)
    hire = _make_hire(acme, joined_on=TODAY)
    instance = _start_instance(client, acme, hire)

    created = _upload(client, acme.headers(), instance["id"])
    doc_id = created.json()["id"]

    with SessionLocal() as db:
        key = db.get(OnboardingDocument, uuid.UUID(doc_id)).storage_key
    assert key, "the document should have a storage key on the row"

    bodies = [
        created.text,
        client.get(
            f"/api/v1/onboarding/instances/{instance['id']}", headers=acme.headers()
        ).text,
        client.get("/api/v1/onboarding/instances", headers=acme.headers()).text,
        client.post(
            f"/api/v1/onboarding/documents/{doc_id}/verify",
            json={"verified": True, "verification_note": "Checked against the original"},
            headers=acme.headers(),
        ).text,
    ]
    for body in bodies:
        assert key not in body, "a storage key leaked into a response body"
        assert "storage_key" not in body
        # The org/user prefix on its own is enough to enumerate a neighbour.
        assert f"{acme.id}/{hire}" not in body


def test_verifying_a_document_is_hr_only_and_reversible(client, tenants):
    """The hire supplies it; somebody else has to say it is genuine."""
    acme, _ = tenants
    _make_template(client, acme)
    hire = _make_hire(acme, joined_on=TODAY, email="verify@acme.test", with_password=True)
    instance = _start_instance(client, acme, hire)
    hire_headers = acme.headers(_token_for(acme, hire))
    doc_id = _upload(client, hire_headers, instance["id"]).json()["id"]

    assert (
        client.post(
            f"/api/v1/onboarding/documents/{doc_id}/verify",
            json={"verified": True},
            headers=hire_headers,
        ).status_code
        == 403
    ), "a hire must not be able to certify their own document"

    verified = client.post(
        f"/api/v1/onboarding/documents/{doc_id}/verify",
        json={"verified": True, "verification_note": "Matches the original"},
        headers=acme.headers(),
    ).json()
    assert verified["is_verified"] is True
    assert verified["verified_by_name"] == "Acme Ltd Owner"

    # Un-verifying clears the verifier too: verified_at is the only signal of
    # "checked", so a name left behind would vouch for nothing.
    undone = client.post(
        f"/api/v1/onboarding/documents/{doc_id}/verify",
        json={"verified": False},
        headers=acme.headers(),
    ).json()
    assert undone["is_verified"] is False
    assert undone["verified_by"] is None


def test_a_document_cannot_be_filed_against_another_hires_task(client, tenants):
    acme, _ = tenants
    _make_template(client, acme)
    first = _make_hire(acme, joined_on=TODAY, email="a@acme.test")
    second = _make_hire(acme, joined_on=TODAY, email="b@acme.test")
    one = _start_instance(client, acme, first)
    two = _start_instance(client, acme, second)
    foreign_task = _flat_tasks(two)[0]["id"]

    resp = _upload(client, acme.headers(), one["id"], task_id=foreign_task)
    assert resp.status_code == 422


def test_deleting_a_document_removes_the_stored_object(client, tenants):
    acme, _ = tenants
    _make_template(client, acme)
    hire = _make_hire(acme, joined_on=TODAY)
    instance = _start_instance(client, acme, hire)
    doc_id = _upload(client, acme.headers(), instance["id"]).json()["id"]

    with SessionLocal() as db:
        key = db.get(OnboardingDocument, uuid.UUID(doc_id)).storage_key

    assert (
        client.delete(
            f"/api/v1/onboarding/documents/{doc_id}", headers=acme.headers()
        ).status_code
        == 204
    )
    from app.services import storage

    with pytest.raises((FileNotFoundError, storage.StorageError)):
        storage.serve(key)


# --------------------------------------------------------------------------- #
# Permission flag and tenant isolation
# --------------------------------------------------------------------------- #


def _drop_flag(user_id: uuid.UUID) -> None:
    with SessionLocal() as db:
        db.get(User, user_id).can_manage_onboarding = False
        db.commit()


def test_can_manage_onboarding_false_is_blocked_everywhere(client, tenants):
    """The flag gates the reads as well as the writes.

    A hire's joining date, their outstanding document list and who their
    manager is are the same data the flag exists to withhold; a read-only leak
    of it is still a leak.
    """
    acme, _ = tenants
    template = _make_template(client, acme)
    hire = _make_hire(acme, joined_on=TODAY)
    instance = _start_instance(client, acme, hire)
    task = _flat_tasks(instance)[0]
    doc_id = _upload(client, acme.headers(), instance["id"]).json()["id"]

    _drop_flag(acme.owner.id)
    headers = acme.headers()

    refused = [
        client.get("/api/v1/onboarding/templates", headers=headers),
        client.post("/api/v1/onboarding/templates", json=_template_body(name="X"),
                    headers=headers),
        client.get(f"/api/v1/onboarding/templates/{template['id']}", headers=headers),
        client.put(f"/api/v1/onboarding/templates/{template['id']}",
                   json=_template_body(), headers=headers),
        client.delete(f"/api/v1/onboarding/templates/{template['id']}", headers=headers),
        client.get("/api/v1/onboarding/instances", headers=headers),
        client.post("/api/v1/onboarding/instances", json={"user_id": str(hire)},
                    headers=headers),
        client.get(f"/api/v1/onboarding/instances/{instance['id']}", headers=headers),
        client.patch(f"/api/v1/onboarding/instances/{instance['id']}",
                     json={"notes": "nope"}, headers=headers),
        client.post(f"/api/v1/onboarding/instances/{instance['id']}/tasks",
                    json={"title": "nope"}, headers=headers),
        client.put(f"/api/v1/onboarding/tasks/{task['id']}",
                   json={"title": "nope"}, headers=headers),
        client.post(f"/api/v1/onboarding/tasks/{task['id']}/status",
                    json={"status": "done"}, headers=headers),
        client.delete(f"/api/v1/onboarding/tasks/{task['id']}", headers=headers),
        client.get(f"/api/v1/onboarding/documents/{doc_id}/file", headers=headers),
        client.post(f"/api/v1/onboarding/documents/{doc_id}/verify",
                    json={"verified": True}, headers=headers),
        client.delete(f"/api/v1/onboarding/documents/{doc_id}", headers=headers),
    ]
    for resp in refused:
        assert resp.status_code == 403, f"{resp.request.method} {resp.request.url}"
        assert resp.json()["detail"]["reason"] == "permission_denied"

    # Nothing was actually done behind the refusals.
    with SessionLocal() as db:
        assert db.get(OnboardingTask, uuid.UUID(task["id"])).status == "pending"
        assert db.get(OnboardingDocument, uuid.UUID(doc_id)) is not None


def test_tenant_isolation(client, tenants):
    """Globex cannot see, read or touch anything of Acme's.

    404 rather than 403 on every cross-tenant miss: a 403 would confirm the id
    exists somewhere, which is itself a disclosure across the boundary.
    """
    acme, globex = tenants
    template = _make_template(client, acme)
    hire = _make_hire(acme, joined_on=TODAY)
    instance = _start_instance(client, acme, hire)
    task = _flat_tasks(instance)[0]
    doc_id = _upload(client, acme.headers(), instance["id"]).json()["id"]

    other = globex.headers()
    for resp in [
        client.get(f"/api/v1/onboarding/templates/{template['id']}", headers=other),
        client.put(f"/api/v1/onboarding/templates/{template['id']}",
                   json=_template_body(), headers=other),
        client.delete(f"/api/v1/onboarding/templates/{template['id']}", headers=other),
        client.get(f"/api/v1/onboarding/instances/{instance['id']}", headers=other),
        client.patch(f"/api/v1/onboarding/instances/{instance['id']}",
                     json={"notes": "mine now"}, headers=other),
        client.post(f"/api/v1/onboarding/instances/{instance['id']}/tasks",
                    json={"title": "mine now"}, headers=other),
        client.put(f"/api/v1/onboarding/tasks/{task['id']}",
                   json={"title": "mine now"}, headers=other),
        client.post(f"/api/v1/onboarding/tasks/{task['id']}/status",
                    json={"status": "done"}, headers=other),
        client.delete(f"/api/v1/onboarding/tasks/{task['id']}", headers=other),
        client.get(f"/api/v1/onboarding/documents/{doc_id}/file", headers=other),
        client.post(f"/api/v1/onboarding/documents/{doc_id}/verify",
                    json={"verified": True}, headers=other),
        client.delete(f"/api/v1/onboarding/documents/{doc_id}", headers=other),
        # Starting a checklist for another tenant's employee.
        client.post("/api/v1/onboarding/instances", json={"user_id": str(hire)},
                    headers=other),
    ]:
        assert resp.status_code == 404, f"{resp.request.method} {resp.request.url}"

    # The lists show nothing of Acme's either.
    assert client.get("/api/v1/onboarding/templates", headers=other).json() == []
    assert client.get("/api/v1/onboarding/instances", headers=other).json() == []

    # And nothing was destroyed on the way past.
    with SessionLocal() as db:
        assert db.get(OnboardingTask, uuid.UUID(task["id"])).status == "pending"
        assert db.get(OnboardingDocument, uuid.UUID(doc_id)) is not None
        assert (
            db.scalar(
                select(OnboardingInstance).where(
                    OnboardingInstance.id == uuid.UUID(instance["id"])
                )
            )
            is not None
        )
