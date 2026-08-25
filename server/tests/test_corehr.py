"""Core HR — the master record, its permission model, and the document file.

What this file is really testing is the access model, because that is where the
damage lives. A bug in the address field is a wrong address; a bug in
``can_view`` is every employee's Aadhaar readable by every colleague.

The four rules, each with a test that fails if it is loosened:

1. Your own record is always yours, with no permission flag consulted.
2. An ordinary employee cannot read anybody else's, **including their own
   manager's reports** — line management is not a reason to hold somebody's
   bank details, and this is the one module where the reporting hierarchy
   deliberately grants nothing.
3. The employment half is administrator-only, even for the subject.
4. Statutory numbers are masked in every list and get, and revealing one is a
   separate, audited call.
"""

from __future__ import annotations

import io
import json
from datetime import date, timedelta

from sqlalchemy import select

from app.db.session import SessionLocal
from app.models import AuditLog, EmployeeProfile, User


def _profile_row(user_id):
    with SessionLocal() as db:
        return db.get(EmployeeProfile, user_id)


def _audit_actions(org_id, prefix: str = "corehr.") -> list[str]:
    with SessionLocal() as db:
        return [
            row.action
            for row in db.scalars(
                select(AuditLog)
                .where(AuditLog.org_id == org_id, AuditLog.action.like(f"{prefix}%"))
                .order_by(AuditLog.created_at)
            )
        ]


def _upload(client, tenant, user_id, *, token=None, meta=None, content=b"a scan"):
    body = {"doc_type": "pan_card", "title": "PAN"} | (meta or {})
    return client.post(
        f"/api/v1/people/{user_id}/documents",
        data={"meta": json.dumps(body)},
        files={"file": ("pan.pdf", io.BytesIO(content), "application/pdf")},
        headers=tenant.headers(token),
    )


# --------------------------------------------------------------------------- #
# Reading your own record
# --------------------------------------------------------------------------- #


def test_reading_a_profile_writes_nothing(client, tenants):
    """An empty record reads as empty; it is not conjured into existence.

    A GET that inserts fails on a read replica, turns an idle console poll into
    write load, and creates a row for every person an administrator merely
    browsed past. The row appears on the first actual write, below.
    """
    acme, _ = tenants
    assert _profile_row(acme.employee.id) is None

    body = client.get(
        "/api/v1/people/me", headers=acme.headers(acme.employee_token)
    ).json()

    assert body["user_id"] == str(acme.employee.id)
    assert body["full_name"] == acme.employee.full_name
    # Not "probation": every account that exists when this ships belongs to
    # someone already working here.
    assert body["confirmation_status"] == "not_applicable"
    assert body["has_pan"] is False
    assert _profile_row(acme.employee.id) is None

    client.patch(
        f"/api/v1/people/{acme.employee.id}",
        json={"blood_group": "O+"},
        headers=acme.headers(acme.employee_token),
    )
    assert _profile_row(acme.employee.id) is not None


def test_an_employee_may_edit_their_own_personal_details(client, tenants):
    acme, _ = tenants
    response = client.patch(
        f"/api/v1/people/{acme.employee.id}",
        json={"alternate_phone": "+91 98200 11111", "blood_group": "O+"},
        headers=acme.headers(acme.employee_token),
    )
    assert response.status_code == 200
    assert response.json()["alternate_phone"] == "+91 98200 11111"
    assert response.json()["can_edit_personal"] is True
    # Their own record, but not their own probation.
    assert response.json()["can_edit_employment"] is False


def test_a_partial_patch_does_not_wipe_the_fields_it_omits(client, tenants):
    acme, _ = tenants
    headers = acme.headers(acme.employee_token)
    client.patch(
        f"/api/v1/people/{acme.employee.id}",
        json={"blood_group": "O+", "nationality": "Indian"},
        headers=headers,
    )
    # The address form submits only its own fields. If exclude_unset were not
    # honoured, this second call would null the two above.
    body = client.patch(
        f"/api/v1/people/{acme.employee.id}",
        json={"current_city": "Pune"},
        headers=headers,
    ).json()
    assert body["current_city"] == "Pune"
    assert body["blood_group"] == "O+"
    assert body["nationality"] == "Indian"


def test_blank_string_clears_rather_than_storing_empty(client, tenants):
    acme, _ = tenants
    headers = acme.headers(acme.employee_token)
    client.patch(
        f"/api/v1/people/{acme.employee.id}", json={"blood_group": "O+"}, headers=headers
    )
    body = client.patch(
        f"/api/v1/people/{acme.employee.id}", json={"blood_group": "   "}, headers=headers
    ).json()
    assert body["blood_group"] is None


# --------------------------------------------------------------------------- #
# Reading somebody else's
# --------------------------------------------------------------------------- #


def test_an_employee_cannot_read_a_colleague(client, tenants):
    acme, _ = tenants
    response = client.get(
        f"/api/v1/people/{acme.owner.id}", headers=acme.headers(acme.employee_token)
    )
    assert response.status_code == 403
    assert response.json()["detail"]["reason"] == "not_permitted"


def test_a_manager_cannot_read_their_own_report(client, tenants):
    """The hierarchy grants nothing here, unlike every other module.

    A manager approves this person's leave and sees their activity. That is not
    a reason to hold their Aadhaar, and if this test ever starts failing because
    someone "made it consistent with the other modules", the consistency is the
    bug.
    """
    acme, _ = tenants
    with SessionLocal() as db:
        manager = db.get(User, acme.owner.id)
        report = db.get(User, acme.employee.id)
        report.manager_id = manager.id
        manager.role = "manager"
        db.commit()

    response = client.get(
        f"/api/v1/people/{acme.employee.id}", headers=acme.headers()
    )
    assert response.status_code == 403


def test_an_owner_may_read_anybody(client, tenants):
    acme, _ = tenants
    body = client.get(
        f"/api/v1/people/{acme.employee.id}", headers=acme.headers()
    ).json()
    assert body["user_id"] == str(acme.employee.id)
    assert body["can_edit_employment"] is True


def test_the_people_flag_restricts_an_owner(client, tenants):
    """Flags restrict; they never grant. Clearing it takes the capability away
    from the one role that would otherwise have it."""
    acme, _ = tenants
    with SessionLocal() as db:
        db.get(User, acme.owner.id).can_manage_people = False
        db.commit()

    assert client.get(
        f"/api/v1/people/{acme.employee.id}", headers=acme.headers()
    ).status_code == 403
    # Their own record is untouched by the flag — it is theirs.
    assert client.get("/api/v1/people/me", headers=acme.headers()).status_code == 200


def test_a_cross_tenant_read_is_404_not_403(client, tenants):
    """403 would confirm the id exists somewhere, which is itself a leak."""
    acme, globex = tenants
    response = client.get(
        f"/api/v1/people/{globex.employee.id}", headers=acme.headers()
    )
    assert response.status_code == 404


# --------------------------------------------------------------------------- #
# Employment and confirmation
# --------------------------------------------------------------------------- #


def test_an_employee_cannot_set_their_own_employment(client, tenants):
    acme, _ = tenants
    response = client.patch(
        f"/api/v1/people/{acme.employee.id}/employment",
        json={"employment_type": "full_time", "probation_months": 0},
        headers=acme.headers(acme.employee_token),
    )
    assert response.status_code == 403


def test_an_employee_cannot_confirm_themselves(client, tenants):
    acme, _ = tenants
    response = client.post(
        f"/api/v1/people/{acme.employee.id}/confirmation",
        json={"status": "confirmed"},
        headers=acme.headers(acme.employee_token),
    )
    assert response.status_code == 403


def test_confirming_stamps_a_date_and_audits_the_transition(client, tenants):
    acme, _ = tenants
    client.patch(
        f"/api/v1/people/{acme.employee.id}/employment",
        json={"probation_months": 6, "probation_end_on": "2026-09-01"},
        headers=acme.headers(),
    )
    client.post(
        f"/api/v1/people/{acme.employee.id}/confirmation",
        json={"status": "probation"},
        headers=acme.headers(),
    )
    body = client.post(
        f"/api/v1/people/{acme.employee.id}/confirmation",
        json={"status": "confirmed", "effective_on": "2026-09-01", "note": "Signed off"},
        headers=acme.headers(),
    ).json()

    assert body["confirmation_status"] == "confirmed"
    # A confirmation with no date cannot be cited by the letter announcing it.
    assert body["confirmed_on"] == "2026-09-01"
    assert "corehr.confirmation_changed" in _audit_actions(acme.id)


def test_extending_probation_clears_a_previous_confirmation_date(client, tenants):
    """Otherwise the record reads as both confirmed and still on probation."""
    acme, _ = tenants
    client.post(
        f"/api/v1/people/{acme.employee.id}/confirmation",
        json={"status": "confirmed", "effective_on": "2026-08-01"},
        headers=acme.headers(),
    )
    body = client.post(
        f"/api/v1/people/{acme.employee.id}/confirmation",
        json={"status": "extended", "effective_on": "2026-11-30"},
        headers=acme.headers(),
    ).json()
    assert body["confirmation_status"] == "extended"
    assert body["confirmed_on"] is None
    assert body["probation_end_on"] == "2026-11-30"


def test_probation_due_report_lists_only_the_unconfirmed(client, tenants):
    acme, _ = tenants
    soon = (date.today() + timedelta(days=10)).isoformat()
    for person in (acme.employee, acme.owner):
        client.patch(
            f"/api/v1/people/{person.id}/employment",
            json={"probation_end_on": soon},
            headers=acme.headers(),
        )
        client.post(
            f"/api/v1/people/{person.id}/confirmation",
            json={"status": "probation"},
            headers=acme.headers(),
        )
    client.post(
        f"/api/v1/people/{acme.owner.id}/confirmation",
        json={"status": "confirmed"},
        headers=acme.headers(),
    )

    rows = client.get(
        "/api/v1/people/reports/probation-due?within_days=30", headers=acme.headers()
    ).json()
    ids = {row["user_id"] for row in rows}
    assert str(acme.employee.id) in ids
    assert str(acme.owner.id) not in ids


# --------------------------------------------------------------------------- #
# Statutory identity: encrypted, masked, revealed deliberately
# --------------------------------------------------------------------------- #


def test_pan_is_masked_in_the_response_and_ciphertext_in_the_column(client, tenants):
    acme, _ = tenants
    body = client.patch(
        f"/api/v1/people/{acme.employee.id}",
        json={"pan": "abcde1234f"},
        headers=acme.headers(acme.employee_token),
    ).json()

    # Canonicalised on the way in: payroll files this, and a lowercase PAN on a
    # return is a rejected return.
    assert body["pan_masked"].endswith("234F")
    assert "ABCDE1234F" not in json.dumps(body)
    assert body["has_pan"] is True

    row = _profile_row(acme.employee.id)
    assert row.pan_enc is not None
    # The plaintext must not be in the column, in any casing.
    assert "ABCDE1234F" not in row.pan_enc


def test_malformed_statutory_numbers_are_refused(client, tenants):
    acme, _ = tenants
    headers = acme.headers(acme.employee_token)
    for field, value in (
        ("pan", "NOTAPAN"),
        ("aadhaar", "12345"),
        ("uan", "abc"),
        ("bank_ifsc", "XX1234567890"),
    ):
        response = client.patch(
            f"/api/v1/people/{acme.employee.id}", json={field: value}, headers=headers
        )
        assert response.status_code == 422, field


def test_aadhaar_accepts_spacing_and_stores_digits(client, tenants):
    acme, _ = tenants
    client.patch(
        f"/api/v1/people/{acme.employee.id}",
        json={"aadhaar": "1234 5678 9012"},
        headers=acme.headers(acme.employee_token),
    )
    revealed = client.post(
        f"/api/v1/people/{acme.employee.id}/reveal/aadhaar",
        headers=acme.headers(acme.employee_token),
    ).json()
    assert revealed["value"] == "123456789012"


def test_revealing_is_audited_and_permission_checked(client, tenants):
    acme, _ = tenants
    client.patch(
        f"/api/v1/people/{acme.employee.id}",
        json={"pan": "ABCDE1234F"},
        headers=acme.headers(acme.employee_token),
    )

    # A colleague cannot, even knowing the id.
    with SessionLocal() as db:
        other = User(
            id=__import__("uuid").uuid4(),
            org_id=acme.id,
            email="third@acme.test",
            full_name="Third Person",
            role="employee",
            is_active=True,
            enrollment_key="k" * 24,
        )
        db.add(other)
        db.commit()
        from app.core.security import create_access_token

        other_token = create_access_token(
            str(other.id), {"typ": "user", "org": str(acme.id), "role": "employee"}
        )

    assert client.post(
        f"/api/v1/people/{acme.employee.id}/reveal/pan",
        headers=acme.headers(other_token),
    ).status_code == 403

    body = client.post(
        f"/api/v1/people/{acme.employee.id}/reveal/pan", headers=acme.headers()
    ).json()
    assert body["value"] == "ABCDE1234F"
    assert "corehr.sensitive_revealed" in _audit_actions(acme.id)


def test_revealing_an_unset_field_is_404_not_empty_string(client, tenants):
    """An empty string on screen reads as "not set" and sends HR to re-collect
    a document that is already on file."""
    acme, _ = tenants
    response = client.post(
        f"/api/v1/people/{acme.employee.id}/reveal/pan", headers=acme.headers()
    )
    assert response.status_code == 404
    assert response.json()["detail"]["reason"] == "not_set"


def test_an_unknown_reveal_field_is_refused(client, tenants):
    acme, _ = tenants
    response = client.post(
        f"/api/v1/people/{acme.employee.id}/reveal/password_hash", headers=acme.headers()
    )
    assert response.status_code == 422


def test_the_audit_row_never_carries_the_value(client, tenants):
    acme, _ = tenants
    client.patch(
        f"/api/v1/people/{acme.employee.id}",
        json={"pan": "ABCDE1234F"},
        headers=acme.headers(acme.employee_token),
    )
    with SessionLocal() as db:
        rows = list(
            db.scalars(
                select(AuditLog).where(
                    AuditLog.org_id == acme.id, AuditLog.action == "corehr.profile_updated"
                )
            )
        )
    assert rows
    for row in rows:
        blob = json.dumps(row.detail or {})
        # Field names yes, values never — the log must not become a second,
        # unencrypted copy of the thing we bothered to encrypt.
        assert "pan" in blob
        assert "ABCDE1234F" not in blob


# --------------------------------------------------------------------------- #
# Documents
# --------------------------------------------------------------------------- #


def test_upload_list_and_download_a_document(client, tenants):
    acme, _ = tenants
    created = _upload(client, acme, acme.employee.id, token=acme.employee_token)
    assert created.status_code == 201
    doc = created.json()
    assert doc["doc_type"] == "pan_card"
    assert doc["file_size"] == len(b"a scan")
    # The key never leaves the server: a client holding it would not need the
    # permission check on the download route.
    assert "storage_key" not in doc

    listed = client.get(
        f"/api/v1/people/{acme.employee.id}/documents",
        headers=acme.headers(acme.employee_token),
    ).json()
    assert [row["id"] for row in listed] == [doc["id"]]

    fetched = client.get(
        f"/api/v1/people/documents/{doc['id']}/file",
        headers=acme.headers(acme.employee_token),
    )
    assert fetched.status_code == 200
    assert fetched.content == b"a scan"


def test_a_colleague_cannot_download_a_document(client, tenants):
    acme, _ = tenants
    doc = _upload(client, acme, acme.employee.id, token=acme.employee_token).json()
    with SessionLocal() as db:
        db.get(User, acme.owner.id).can_manage_people = False
        db.commit()
    response = client.get(
        f"/api/v1/people/documents/{doc['id']}/file", headers=acme.headers()
    )
    assert response.status_code == 403


def test_an_employee_cannot_verify_or_delete_their_own_document(client, tenants):
    """Verification means somebody at the company looked at the original, and
    deletion of one's own signed acknowledgement is what a file exists to
    prevent."""
    acme, _ = tenants
    doc = _upload(client, acme, acme.employee.id, token=acme.employee_token).json()
    headers = acme.headers(acme.employee_token)

    assert client.post(
        f"/api/v1/people/documents/{doc['id']}/verify", json={"is_verified": True},
        headers=headers,
    ).status_code == 403
    assert client.delete(
        f"/api/v1/people/documents/{doc['id']}", headers=headers
    ).status_code == 403


def test_an_administrator_verifies_and_deletes(client, tenants):
    acme, _ = tenants
    doc = _upload(client, acme, acme.employee.id, token=acme.employee_token).json()

    verified = client.post(
        f"/api/v1/people/documents/{doc['id']}/verify",
        json={"is_verified": True},
        headers=acme.headers(),
    ).json()
    assert verified["is_verified"] is True
    assert verified["verified_by_name"] == acme.owner.full_name

    assert client.delete(
        f"/api/v1/people/documents/{doc['id']}", headers=acme.headers()
    ).status_code == 204
    assert client.get(
        f"/api/v1/people/{acme.employee.id}/documents",
        headers=acme.headers(acme.employee_token),
    ).json() == []


def test_expiry_is_reported_in_days_and_bad_dates_refused(client, tenants):
    acme, _ = tenants
    expires = (date.today() + timedelta(days=20)).isoformat()
    doc = _upload(
        client, acme, acme.employee.id, token=acme.employee_token,
        meta={"doc_type": "passport", "issued_on": "2020-01-01", "expires_on": expires},
    ).json()
    assert doc["days_to_expiry"] == 20

    bad = _upload(
        client, acme, acme.employee.id, token=acme.employee_token,
        meta={"doc_type": "visa", "issued_on": "2026-01-01", "expires_on": "2025-01-01"},
    )
    assert bad.status_code == 422
    assert bad.json()["detail"]["reason"] == "bad_dates"


def test_expiring_report_is_administrator_only(client, tenants):
    acme, _ = tenants
    _upload(
        client, acme, acme.employee.id, token=acme.employee_token,
        meta={"doc_type": "visa", "expires_on": (date.today() + timedelta(days=5)).isoformat()},
    )
    assert client.get(
        "/api/v1/people/reports/documents-expiring",
        headers=acme.headers(acme.employee_token),
    ).status_code == 403

    rows = client.get(
        "/api/v1/people/reports/documents-expiring?within_days=30", headers=acme.headers()
    ).json()
    assert len(rows) == 1
    assert rows[0]["user_name"] == acme.employee.full_name


def test_documents_do_not_cross_tenants(client, tenants):
    acme, globex = tenants
    doc = _upload(client, acme, acme.employee.id, token=acme.employee_token).json()
    assert client.get(
        f"/api/v1/people/documents/{doc['id']}/file", headers=globex.headers()
    ).status_code == 404


# --------------------------------------------------------------------------- #
# Directory
# --------------------------------------------------------------------------- #


def test_the_directory_is_open_but_carries_nothing_sensitive(client, tenants):
    acme, _ = tenants
    client.patch(
        f"/api/v1/people/{acme.employee.id}",
        json={"pan": "ABCDE1234F", "date_of_birth": "1990-05-05",
              "current_address": "12 Residency Road"},
        headers=acme.headers(acme.employee_token),
    )

    rows = client.get(
        "/api/v1/people/directory", headers=acme.headers(acme.employee_token)
    ).json()
    assert {row["full_name"] for row in rows} == {
        acme.owner.full_name, acme.employee.full_name
    }
    blob = json.dumps(rows)
    # The shape is the safety, not the audience: widening who may call this
    # cannot widen what it discloses.
    for leak in ("ABCDE1234F", "1990-05-05", "Residency Road"):
        assert leak not in blob
    assert "date_of_birth" not in rows[0]
    assert "pan_masked" not in rows[0]


def test_the_directory_searches_and_stays_in_its_tenant(client, tenants):
    acme, globex = tenants
    rows = client.get(
        f"/api/v1/people/directory?q={acme.employee.full_name.split()[0]}",
        headers=acme.headers(acme.employee_token),
    ).json()
    assert rows and all(row["user_id"] != str(globex.employee.id) for row in rows)


# --------------------------------------------------------------------------- #
# Module gating
# --------------------------------------------------------------------------- #


def test_core_hr_is_gated_like_every_other_module(client, tenants, platform_token):
    acme, _ = tenants
    client.put(
        f"/api/v1/platform/companies/{acme.id}/modules",
        json={"grants": [{"key": "core_hr", "enabled": False}]},
        headers={"Authorization": f"Bearer {platform_token}"},
    )
    response = client.get("/api/v1/people/me", headers=acme.headers())
    assert response.status_code == 402
    assert response.json()["detail"]["module"] == "core_hr"
