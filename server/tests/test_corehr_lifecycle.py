"""The seams between Core HR and the modules either side of it.

Four connections, each of which is invisible until it is missing:

1. **Verifying an onboarding document copies it into the permanent file.**
   Without this, archiving a joining checklist destroys the ID proof the
   company collected and verified — `onboarding.delete_document` removes the
   bytes as well as the row.
2. **Completing onboarding starts probation.** Without it nothing ever moves
   `confirmation_status` off `not_applicable`, so the probation-due report is
   permanently empty and probations lapse into confirmations nobody granted.
3. **Completing offboarding closes the master record.** Without it a departed
   employee's profile still reads "Confirmed".
4. **None of the three may break the operation that triggered them.** They are
   side effects of somebody else's transaction, and a storage hiccup must not
   fail a verification.

The bytes are *copied*, not shared, and there is a test for that specifically:
sharing one storage key between the two rows is the plausible-looking shortcut
that turns "delete the checklist" into "the permanent document opens to
nothing".
"""

from __future__ import annotations

import io
import json
import uuid
from datetime import date

from sqlalchemy import select

from app.db.session import SessionLocal
from app.models import (
    EmployeeDocument,
    EmployeeProfile,
    OnboardingInstance,
    User,
)


def _new_hire(client, tenant, *, joining="2026-08-03"):
    """A checklist with one task and one document slot, via the real API."""
    template = client.post(
        "/api/v1/onboarding/templates",
        json={
            "name": "Standard joiner",
            "tasks": [{"title": "Collect ID proof", "doc_type": "pan_card", "offset_days": 0}],
        },
        headers=tenant.headers(),
    ).json()

    instance = client.post(
        "/api/v1/onboarding/instances",
        json={
            "user_id": str(tenant.employee.id),
            "template_id": template["id"],
            "joining_date": joining,
        },
        headers=tenant.headers(),
    )
    assert instance.status_code in (200, 201), instance.text
    return instance.json()


def _upload(client, tenant, instance_id, *, content=b"pan card scan", doc_type="pan_card"):
    return client.post(
        f"/api/v1/onboarding/instances/{instance_id}/documents",
        data={"meta": json.dumps({"doc_type": doc_type})},
        files={"file": ("pan.pdf", io.BytesIO(content), "application/pdf")},
        headers=tenant.headers(),
    ).json()


def _tasks_of(client, tenant, instance_id) -> list[dict]:
    """The checklist's tasks, flattened out of the grouped detail payload."""
    detail = client.get(
        f"/api/v1/onboarding/instances/{instance_id}", headers=tenant.headers()
    ).json()
    return [task for group in detail.get("groups", []) for task in group.get("tasks", [])]


def _permanent(user_id) -> list[EmployeeDocument]:
    with SessionLocal() as db:
        return list(
            db.scalars(
                select(EmployeeDocument).where(EmployeeDocument.user_id == user_id)
            )
        )


def _profile(user_id) -> EmployeeProfile | None:
    with SessionLocal() as db:
        return db.get(EmployeeProfile, user_id)


# --------------------------------------------------------------------------- #
# 1. Document promotion
# --------------------------------------------------------------------------- #


def test_verifying_an_onboarding_document_files_it_permanently(client, tenants):
    acme, _ = tenants
    instance = _new_hire(client, acme)
    doc = _upload(client, acme, instance["id"])

    # Not on upload — an unverified file can be the wrong one.
    assert _permanent(acme.employee.id) == []

    client.post(
        f"/api/v1/onboarding/documents/{doc['id']}/verify",
        json={"verified": True},
        headers=acme.headers(),
    )

    filed = _permanent(acme.employee.id)
    assert len(filed) == 1
    assert filed[0].doc_type == "pan_card"
    assert filed[0].note == f"onboarding_document:{doc['id']}"

    # And it is readable through Core HR's own download route.
    fetched = client.get(
        f"/api/v1/people/documents/{filed[0].id}/file", headers=acme.headers()
    )
    assert fetched.status_code == 200
    assert fetched.content == b"pan card scan"


def test_the_promoted_copy_owns_its_own_bytes(client, tenants):
    """The point of copying rather than sharing a storage key.

    Deleting the onboarding document removes the object. If the two rows shared
    a key, the permanent document would survive as a row pointing at nothing —
    a file that says it holds an ID proof and opens to an error, which is worse
    than never having filed it.
    """
    acme, _ = tenants
    instance = _new_hire(client, acme)
    doc = _upload(client, acme, instance["id"])
    client.post(
        f"/api/v1/onboarding/documents/{doc['id']}/verify",
        json={"verified": True},
        headers=acme.headers(),
    )
    filed = _permanent(acme.employee.id)[0]

    with SessionLocal() as db:
        from app.models import OnboardingDocument

        source = db.get(OnboardingDocument, uuid.UUID(doc["id"]))
        assert source.storage_key != filed.storage_key

    assert client.delete(
        f"/api/v1/onboarding/documents/{doc['id']}", headers=acme.headers()
    ).status_code in (200, 204)

    still_there = client.get(
        f"/api/v1/people/documents/{filed.id}/file", headers=acme.headers()
    )
    assert still_there.status_code == 200
    assert still_there.content == b"pan card scan"


def test_promotion_is_idempotent_across_verify_toggles(client, tenants):
    acme, _ = tenants
    instance = _new_hire(client, acme)
    doc = _upload(client, acme, instance["id"])

    for verified in (True, False, True):
        client.post(
            f"/api/v1/onboarding/documents/{doc['id']}/verify",
            json={"verified": verified},
            headers=acme.headers(),
        )

    # One copy, not three. A duplicate passport in somebody's file is the kind
    # of mess nobody goes back and tidies.
    assert len(_permanent(acme.employee.id)) == 1


def test_unverifying_does_not_delete_the_permanent_copy(client, tenants):
    """Withdrawing the claim that HR checked it is not the same as deciding the
    company should no longer hold it. Deleting an employee document is an
    administrator action with its own audit row, never a side effect."""
    acme, _ = tenants
    instance = _new_hire(client, acme)
    doc = _upload(client, acme, instance["id"])
    for verified in (True, False):
        client.post(
            f"/api/v1/onboarding/documents/{doc['id']}/verify",
            json={"verified": verified},
            headers=acme.headers(),
        )
    assert len(_permanent(acme.employee.id)) == 1


def test_a_verification_survives_unreadable_source_bytes(client, tenants):
    """Promotion is a side effect. A storage hiccup must not fail the
    verification the user actually asked for."""
    acme, _ = tenants
    instance = _new_hire(client, acme)
    doc = _upload(client, acme, instance["id"])

    with SessionLocal() as db:
        from app.models import OnboardingDocument

        row = db.get(OnboardingDocument, uuid.UUID(doc["id"]))
        row.storage_key = "does/not/exist.pdf"
        db.commit()

    response = client.post(
        f"/api/v1/onboarding/documents/{doc['id']}/verify",
        json={"verified": True},
        headers=acme.headers(),
    )
    assert response.status_code == 200
    assert response.json()["verified_at"] is not None
    assert _permanent(acme.employee.id) == []


# --------------------------------------------------------------------------- #
# 2. Onboarding completion starts probation
# --------------------------------------------------------------------------- #


def test_completing_the_last_task_starts_probation(client, tenants):
    acme, _ = tenants
    client.patch(
        f"/api/v1/people/{acme.employee.id}/employment",
        json={"probation_months": 3},
        headers=acme.headers(),
    )
    instance = _new_hire(client, acme, joining="2026-08-03")

    assert _profile(acme.employee.id).confirmation_status == "not_applicable"

    for task in _tasks_of(client, acme, instance["id"]):
        closed = client.post(
            f"/api/v1/onboarding/tasks/{task['id']}/status",
            json={"status": "done"},
            headers=acme.headers(),
        )
        assert closed.status_code == 200, closed.text

    profile = _profile(acme.employee.id)
    assert profile.confirmation_status == "probation"
    # Three calendar months from the joining date, not from today.
    assert profile.probation_end_on == date(2026, 11, 3)


def test_setting_the_status_by_hand_starts_probation_too(client, tenants):
    """The rare path must behave like the common one — the same hook, called
    from both places a checklist can reach COMPLETED."""
    acme, _ = tenants
    instance = _new_hire(client, acme)
    client.patch(
        f"/api/v1/onboarding/instances/{instance['id']}",
        json={"status": "completed"},
        headers=acme.headers(),
    )
    assert _profile(acme.employee.id).confirmation_status == "probation"


def test_probation_has_no_end_date_when_hr_never_set_a_length(client, tenants):
    """Inventing three months would put a date on a report nobody chose and
    everybody would then trust."""
    acme, _ = tenants
    instance = _new_hire(client, acme)
    client.patch(
        f"/api/v1/onboarding/instances/{instance['id']}",
        json={"status": "completed"},
        headers=acme.headers(),
    )
    profile = _profile(acme.employee.id)
    assert profile.confirmation_status == "probation"
    assert profile.probation_end_on is None


def test_completion_never_rewinds_a_decision_already_made(client, tenants):
    """A reopened task, or a rehire's second checklist, must not un-confirm
    somebody."""
    acme, _ = tenants
    client.post(
        f"/api/v1/people/{acme.employee.id}/confirmation",
        json={"status": "confirmed", "effective_on": "2026-08-01"},
        headers=acme.headers(),
    )
    instance = _new_hire(client, acme)
    client.patch(
        f"/api/v1/onboarding/instances/{instance['id']}",
        json={"status": "completed"},
        headers=acme.headers(),
    )
    profile = _profile(acme.employee.id)
    assert profile.confirmation_status == "confirmed"
    assert profile.confirmed_on == date(2026, 8, 1)


def test_reopening_and_recompleting_does_not_fire_twice(client, tenants):
    acme, _ = tenants
    instance = _new_hire(client, acme)
    for status in ("completed", "in_progress", "completed"):
        client.patch(
            f"/api/v1/onboarding/instances/{instance['id']}",
            json={"status": status},
            headers=acme.headers(),
        )
    # Still probation, and still exactly one probation_started audit row.
    with SessionLocal() as db:
        from app.models import AuditLog

        rows = list(
            db.scalars(
                select(AuditLog).where(
                    AuditLog.org_id == acme.id,
                    AuditLog.action == "corehr.probation_started",
                )
            )
        )
    assert len(rows) == 1


# --------------------------------------------------------------------------- #
# 3. Offboarding closes the record
# --------------------------------------------------------------------------- #


def test_completing_offboarding_marks_the_profile_terminated(client, tenants):
    acme, _ = tenants
    client.post(
        f"/api/v1/people/{acme.employee.id}/confirmation",
        json={"status": "confirmed"},
        headers=acme.headers(),
    )

    request = client.post(
        "/api/v1/offboarding/requests",
        json={
            "user_id": str(acme.employee.id),
            "reason": "resignation",
            "notice_date": "2026-08-31",
            "last_working_day": "2026-09-30",
        },
        headers=acme.headers(),
    )
    assert request.status_code in (200, 201), request.text
    req_id = request.json()["id"]

    detail = client.get(
        f"/api/v1/offboarding/requests/{req_id}", headers=acme.headers()
    ).json()
    for group in detail.get("clearance", []):
        for task in group.get("tasks", []):
            closed = client.patch(
                f"/api/v1/offboarding/requests/{req_id}/tasks/{task['id']}",
                json={"status": "done"},
                headers=acme.headers(),
            )
            assert closed.status_code == 200, closed.text

    completed = client.post(
        f"/api/v1/offboarding/requests/{req_id}/complete",
        json={},
        headers=acme.headers(),
    )
    assert completed.status_code == 200, completed.text
    assert _profile(acme.employee.id).confirmation_status == "terminated"


# --------------------------------------------------------------------------- #
# Tenancy
# --------------------------------------------------------------------------- #


def test_promotion_files_against_the_right_person_and_tenant(client, tenants):
    acme, globex = tenants
    instance = _new_hire(client, acme)
    doc = _upload(client, acme, instance["id"])
    client.post(
        f"/api/v1/onboarding/documents/{doc['id']}/verify",
        json={"verified": True},
        headers=acme.headers(),
    )

    filed = _permanent(acme.employee.id)
    assert len(filed) == 1
    assert filed[0].org_id == acme.id
    # The checklist's subject, not the administrator who verified it.
    assert filed[0].user_id == acme.employee.id
    assert _permanent(globex.employee.id) == []
    assert _permanent(acme.owner.id) == []
