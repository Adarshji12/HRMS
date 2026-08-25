"""Letters — templates, the merge engine, and the freeze-on-issue rule.

What this file is really defending:

1. **An issued letter never changes.** Editing the template, or the person's
   designation, must not alter a letter already in somebody's hands. This is the
   whole point of the feature and the easiest thing to break by "improving" the
   render path.
2. **The merge engine cannot be made to evaluate anything.** No expressions, and
   a value containing `{{...}}` stays text rather than becoming a token on a
   second pass.
3. **Statutory numbers are not mergeable.** Core HR encrypts them, masks them
   and audits every reveal; a merge field would bypass all three at once.
4. **Self-service can only ask about yourself, and only for the templates HR
   marked askable.** Otherwise every employee can generate their own warning
   letter.
"""

from __future__ import annotations

import uuid
from datetime import date

from sqlalchemy import select

from app.db.session import SessionLocal
from app.models import EmployeeDocument, IssuedLetter, LetterTemplate, User
from app.services import lettermerge


def _template(client, tenant, **overrides):
    body = {
        "name": "Experience letter",
        "letter_type": "experience",
        "subject": "To Whom It May Concern",
        "body": "This certifies {{employee.full_name}}, {{employee.designation}}, "
                "at {{org.name}} since {{employee.joined_on}}.",
    } | overrides
    response = client.post("/api/v1/letters/templates", json=body, headers=tenant.headers())
    assert response.status_code == 201, response.text
    return response.json()


def _draft(client, tenant, template_id, user_id):
    response = client.post(
        "/api/v1/letters",
        json={"template_id": template_id, "user_id": str(user_id)},
        headers=tenant.headers(),
    )
    assert response.status_code == 201, response.text
    return response.json()


def _place(user_id, *, designation="Senior Engineer", joined=date(2024, 8, 3)):
    """Give somebody a designation and a joining date to merge in."""
    from app.models import Designation

    with SessionLocal() as db:
        user = db.get(User, user_id)
        row = db.scalar(
            select(Designation).where(
                Designation.org_id == user.org_id, Designation.name == designation
            )
        )
        if row is None:
            row = Designation(org_id=user.org_id, name=designation)
            db.add(row)
            db.flush()
        user.designation_id = row.id
        user.joined_on = joined
        db.commit()


# --------------------------------------------------------------------------- #
# The merge engine, in isolation
# --------------------------------------------------------------------------- #


def test_statutory_numbers_are_not_mergeable():
    """Core HR encrypts PAN, masks it, and audits every reveal. A merge field
    would defeat all three, and every letter issued from such a template would
    carry a decrypted identity number with no audit row anywhere."""
    # Matched on the field name after the dot, not as a substring: "esi" is a
    # substring of "designation", and a substring check here reports a leak that
    # is not one while missing the shape of the real risk.
    names = {field.token.rsplit(".", 1)[-1] for field in lettermerge.FIELDS}
    forbidden = {
        "pan", "aadhaar", "bank_account", "bank_ifsc", "uan",
        "esi_number", "pf_number", "date_of_birth", "marital_status",
    }
    assert not (names & forbidden), sorted(names & forbidden)


def test_rendering_is_a_single_pass():
    """A value containing a token must stay text.

    Otherwise an employee could put `{{org.gstin}}` in their own address field
    and have it expand in a letter — self-service template injection.
    """
    out = lettermerge.render(
        "Address: {{employee.address}}", {"employee.address": "{{org.gstin}}"}
    )
    assert out.text == "Address: {{org.gstin}}"


def test_unknown_tokens_are_reported_not_blanked():
    """"Dear ," reaching a new hire is worse than refusing to issue."""
    out = lettermerge.render("Dear {{employee.name}},", {})
    assert out.unknown == ("employee.name",)
    assert "{{employee.name}}" in out.text


def test_dates_render_for_humans_not_as_iso():
    # A letter is read by a person, and often by a bank or a consulate.
    assert lettermerge._human_date(date(2026, 8, 3)) == "3 August 2026"
    assert lettermerge._human_date(None) == ""


# --------------------------------------------------------------------------- #
# Templates
# --------------------------------------------------------------------------- #


def test_a_template_with_a_bad_field_is_refused_at_save(client, tenants):
    """The person who can fix the typo is the one editing the template, not the
    one issuing from it three weeks later."""
    acme, _ = tenants
    response = client.post(
        "/api/v1/letters/templates",
        json={"name": "Broken", "body": "Dear {{employee.name}},"},
        headers=acme.headers(),
    )
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "unknown_fields"


def test_a_blank_body_is_refused(client, tenants):
    acme, _ = tenants
    response = client.post(
        "/api/v1/letters/templates",
        json={"name": "Empty", "body": "     "},
        headers=acme.headers(),
    )
    assert response.status_code == 422


def test_an_employee_cannot_manage_templates(client, tenants):
    acme, _ = tenants
    assert client.get(
        "/api/v1/letters/templates", headers=acme.headers(acme.employee_token)
    ).status_code == 403
    assert client.post(
        "/api/v1/letters/templates",
        json={"name": "Mine", "body": "hello"},
        headers=acme.headers(acme.employee_token),
    ).status_code == 403


def test_the_letters_flag_restricts_an_owner(client, tenants):
    acme, _ = tenants
    with SessionLocal() as db:
        db.get(User, acme.owner.id).can_issue_letters = False
        db.commit()
    assert client.get(
        "/api/v1/letters/templates", headers=acme.headers()
    ).status_code == 403


def test_seeding_starters_is_idempotent(client, tenants):
    acme, _ = tenants
    first = client.post("/api/v1/letters/templates/seed", headers=acme.headers()).json()
    assert len(first) == len(__import__("app.services.letters", fromlist=["x"]).STARTERS)
    second = client.post("/api/v1/letters/templates/seed", headers=acme.headers()).json()
    assert second == []

    all_templates = client.get("/api/v1/letters/templates", headers=acme.headers()).json()
    assert len(all_templates) == len(first)
    # Every seeded body must itself be valid against the registry, or the
    # starters would ship the very error the validator rejects.
    for template in all_templates:
        assert template["unknown_fields"] == []


# --------------------------------------------------------------------------- #
# Preview
# --------------------------------------------------------------------------- #


def test_preview_merges_and_reports_gaps(client, tenants):
    acme, _ = tenants
    _place(acme.employee.id)
    template = _template(
        client, acme,
        body="{{employee.full_name}} — {{employee.designation}} — "
             "{{employee.work_location}}",
    )
    body = client.get(
        f"/api/v1/letters/preview?template_id={template['id']}&user_id={acme.employee.id}",
        headers=acme.headers(),
    ).json()

    assert acme.employee.full_name in body["text"]
    assert "Senior Engineer" in body["text"]
    # Nobody set a work location; a warning, not an error.
    assert body["empty"] == ["employee.work_location"]
    assert body["unknown"] == []


def test_preview_creates_nothing(client, tenants):
    acme, _ = tenants
    template = _template(client, acme)
    client.get(
        f"/api/v1/letters/preview?template_id={template['id']}&user_id={acme.employee.id}",
        headers=acme.headers(),
    )
    with SessionLocal() as db:
        assert db.scalars(select(IssuedLetter)).all() == []


# --------------------------------------------------------------------------- #
# Issuing and the freeze
# --------------------------------------------------------------------------- #


def test_issuing_allocates_a_reference_and_freezes_the_text(client, tenants):
    acme, _ = tenants
    _place(acme.employee.id)
    template = _template(client, acme)
    draft = _draft(client, acme, template["id"], acme.employee.id)

    assert draft["status"] == "draft"
    assert draft["reference_no"] is None

    issued = client.post(
        f"/api/v1/letters/{draft['id']}/issue",
        json={"issued_on": "2026-08-24"},
        headers=acme.headers(),
    ).json()

    assert issued["status"] == "issued"
    assert issued["reference_no"] == "ACME/HR/2026/0001"
    assert issued["issued_on"] == "2026-08-24"
    frozen = issued["body"]

    # Now change both the template and the underlying fact.
    client.patch(
        f"/api/v1/letters/templates/{template['id']}",
        json={"body": "Completely different wording."},
        headers=acme.headers(),
    )
    _place(acme.employee.id, designation="Principal Engineer")

    after = client.get(f"/api/v1/letters/{issued['id']}", headers=acme.headers()).json()
    assert after["body"] == frozen
    assert "Senior Engineer" in after["body"]
    assert "Principal" not in after["body"]


def test_references_increment_per_organisation(client, tenants):
    acme, globex = tenants
    for tenant in (acme, globex):
        template = _template(client, tenant)
        for _ in range(2):
            draft = _draft(client, tenant, template["id"], tenant.employee.id)
            client.post(
                f"/api/v1/letters/{draft['id']}/issue", json={}, headers=tenant.headers()
            )

    with SessionLocal() as db:
        acme_refs = sorted(
            db.scalars(
                select(IssuedLetter.reference_no).where(IssuedLetter.org_id == acme.id)
            )
        )
        globex_refs = sorted(
            db.scalars(
                select(IssuedLetter.reference_no).where(IssuedLetter.org_id == globex.id)
            )
        )
    year = date.today().year
    # Two companies both numbering from 0001 is expected, not a collision.
    assert acme_refs == [f"ACME/HR/{year}/0001", f"ACME/HR/{year}/0002"]
    assert globex_refs == [f"GLOBEX/HR/{year}/0001", f"GLOBEX/HR/{year}/0002"]


def test_an_issued_letter_cannot_be_edited_or_re_issued(client, tenants):
    acme, _ = tenants
    template = _template(client, acme)
    draft = _draft(client, acme, template["id"], acme.employee.id)
    client.post(f"/api/v1/letters/{draft['id']}/issue", json={}, headers=acme.headers())

    edited = client.patch(
        f"/api/v1/letters/{draft['id']}",
        json={"body": "Rewritten after the fact."},
        headers=acme.headers(),
    )
    assert edited.status_code == 409
    assert edited.json()["detail"]["reason"] == "already_issued"

    again = client.post(
        f"/api/v1/letters/{draft['id']}/issue", json={}, headers=acme.headers()
    )
    assert again.status_code == 409


def test_a_draft_can_be_reworded_before_issue(client, tenants):
    acme, _ = tenants
    template = _template(client, acme)
    draft = _draft(client, acme, template["id"], acme.employee.id)
    updated = client.patch(
        f"/api/v1/letters/{draft['id']}",
        json={"body": "Bespoke wording for this one person."},
        headers=acme.headers(),
    ).json()
    assert updated["body"] == "Bespoke wording for this one person."
    # And the template is untouched.
    assert client.get(
        f"/api/v1/letters/templates", headers=acme.headers()
    ).json()[0]["body"].startswith("This certifies")


# --------------------------------------------------------------------------- #
# Filing into the permanent record
# --------------------------------------------------------------------------- #


def test_issuing_files_a_copy_into_the_employee_documents(client, tenants):
    acme, _ = tenants
    _place(acme.employee.id)
    template = _template(client, acme)
    draft = _draft(client, acme, template["id"], acme.employee.id)
    issued = client.post(
        f"/api/v1/letters/{draft['id']}/issue", json={}, headers=acme.headers()
    ).json()

    assert issued["is_filed"] is True

    docs = client.get(
        f"/api/v1/people/{acme.employee.id}/documents", headers=acme.headers()
    ).json()
    assert len(docs) == 1
    assert docs[0]["doc_type"] == "letter_experience"
    # It turns up next to their contract and ID proof, which is where somebody
    # actually looks for it.
    fetched = client.get(
        f"/api/v1/people/documents/{docs[0]['id']}/file", headers=acme.headers()
    )
    assert fetched.status_code == 200
    assert acme.employee.full_name.encode() in fetched.content


def test_the_printable_page_escapes_employee_text(client, tenants):
    """An address containing markup must not become markup."""
    acme, _ = tenants
    client.patch(
        f"/api/v1/people/{acme.employee.id}",
        json={"current_address": "<script>alert(1)</script>"},
        headers=acme.headers(),
    )
    template = _template(client, acme, body="Lives at {{employee.address}}.")
    draft = _draft(client, acme, template["id"], acme.employee.id)
    client.post(f"/api/v1/letters/{draft['id']}/issue", json={}, headers=acme.headers())

    page = client.get(f"/api/v1/letters/{draft['id']}/print", headers=acme.headers())
    assert page.status_code == 200
    assert "<script>" not in page.text
    assert "&lt;script&gt;" in page.text


# --------------------------------------------------------------------------- #
# Revoking
# --------------------------------------------------------------------------- #


def test_revoking_keeps_the_letter_the_number_and_the_document(client, tenants):
    """A company that can make a letter it issued disappear has an audit trail
    worth nothing."""
    acme, _ = tenants
    template = _template(client, acme)
    draft = _draft(client, acme, template["id"], acme.employee.id)
    issued = client.post(
        f"/api/v1/letters/{draft['id']}/issue", json={}, headers=acme.headers()
    ).json()

    revoked = client.post(
        f"/api/v1/letters/{draft['id']}/revoke",
        json={"reason": "Superseded by a corrected letter"},
        headers=acme.headers(),
    ).json()

    assert revoked["status"] == "revoked"
    assert revoked["reference_no"] == issued["reference_no"]
    assert revoked["body"] == issued["body"]
    assert revoked["revoked_reason"] == "Superseded by a corrected letter"
    # The filed copy survives too.
    assert len(client.get(
        f"/api/v1/people/{acme.employee.id}/documents", headers=acme.headers()
    ).json()) == 1


def test_revoking_needs_a_reason_and_a_revoked_letter_cannot_be_reissued(client, tenants):
    acme, _ = tenants
    template = _template(client, acme)
    draft = _draft(client, acme, template["id"], acme.employee.id)
    client.post(f"/api/v1/letters/{draft['id']}/issue", json={}, headers=acme.headers())

    blank = client.post(
        f"/api/v1/letters/{draft['id']}/revoke", json={"reason": "   "},
        headers=acme.headers(),
    )
    assert blank.status_code == 422

    client.post(
        f"/api/v1/letters/{draft['id']}/revoke", json={"reason": "Issued in error"},
        headers=acme.headers(),
    )
    again = client.post(
        f"/api/v1/letters/{draft['id']}/issue", json={}, headers=acme.headers()
    )
    assert again.status_code == 409
    assert again.json()["detail"]["reason"] == "revoked"


def test_a_draft_cannot_be_revoked(client, tenants):
    acme, _ = tenants
    template = _template(client, acme)
    draft = _draft(client, acme, template["id"], acme.employee.id)
    response = client.post(
        f"/api/v1/letters/{draft['id']}/revoke", json={"reason": "no"},
        headers=acme.headers(),
    )
    assert response.status_code == 409


# --------------------------------------------------------------------------- #
# Employee self-service
# --------------------------------------------------------------------------- #


def test_an_employee_sees_only_requestable_templates_and_no_bodies(client, tenants):
    acme, _ = tenants
    _template(client, acme, name="Warning letter", letter_type="warning",
              body="Formal warning to {{employee.full_name}}.")
    _template(client, acme, name="Address proof", letter_type="address_proof",
              body="{{employee.full_name}} lives at {{employee.address}}.",
              employee_requestable=True)

    rows = client.get(
        "/api/v1/letters/requestable", headers=acme.headers(acme.employee_token)
    ).json()
    assert [row["name"] for row in rows] == ["Address proof"]
    # No body, ever: a template body would tell the whole company what the
    # company puts in its warning letters.
    assert "body" not in rows[0]


def test_requesting_produces_a_draft_for_hr_not_an_issued_letter(client, tenants):
    acme, _ = tenants
    template = _template(client, acme, employee_requestable=True)
    requested = client.post(
        "/api/v1/letters/request",
        json={"template_id": template["id"], "note": "For a visa application"},
        headers=acme.headers(acme.employee_token),
    ).json()

    assert requested["status"] == "draft"
    assert requested["user_id"] == str(acme.employee.id)
    assert requested["requested_by_name"] == acme.employee.full_name
    assert requested["reference_no"] is None


def test_a_non_requestable_template_cannot_be_requested(client, tenants):
    acme, _ = tenants
    template = _template(client, acme, name="Warning", letter_type="warning",
                         body="Warning to {{employee.full_name}}.")
    response = client.post(
        "/api/v1/letters/request",
        json={"template_id": template["id"]},
        headers=acme.headers(acme.employee_token),
    )
    assert response.status_code == 403
    assert response.json()["detail"]["reason"] == "not_requestable"


def test_an_employee_reads_their_issued_letters_but_not_their_drafts(client, tenants):
    """A draft is HR working out what to say. Showing somebody the draft of
    their own warning letter is not a feature."""
    acme, _ = tenants
    template = _template(client, acme)
    draft = _draft(client, acme, template["id"], acme.employee.id)

    assert client.get(
        f"/api/v1/letters/{draft['id']}", headers=acme.headers(acme.employee_token)
    ).status_code == 403
    assert client.get(
        "/api/v1/letters", headers=acme.headers(acme.employee_token)
    ).json() == []

    client.post(f"/api/v1/letters/{draft['id']}/issue", json={}, headers=acme.headers())

    assert client.get(
        f"/api/v1/letters/{draft['id']}", headers=acme.headers(acme.employee_token)
    ).status_code == 200
    mine = client.get(
        "/api/v1/letters", headers=acme.headers(acme.employee_token)
    ).json()
    assert [row["id"] for row in mine] == [draft["id"]]


def test_an_employee_cannot_read_a_colleagues_letter(client, tenants):
    acme, _ = tenants
    template = _template(client, acme)
    draft = _draft(client, acme, template["id"], acme.owner.id)
    client.post(f"/api/v1/letters/{draft['id']}/issue", json={}, headers=acme.headers())

    assert client.get(
        f"/api/v1/letters/{draft['id']}", headers=acme.headers(acme.employee_token)
    ).status_code == 403
    assert client.get(
        f"/api/v1/letters/{draft['id']}/print", headers=acme.headers(acme.employee_token)
    ).status_code == 403


# --------------------------------------------------------------------------- #
# Tenancy and deletion
# --------------------------------------------------------------------------- #


def test_letters_do_not_cross_tenants(client, tenants):
    acme, globex = tenants
    template = _template(client, acme)
    draft = _draft(client, acme, template["id"], acme.employee.id)
    client.post(f"/api/v1/letters/{draft['id']}/issue", json={}, headers=acme.headers())

    assert client.get(
        f"/api/v1/letters/{draft['id']}", headers=globex.headers()
    ).status_code == 404
    assert client.get(
        f"/api/v1/letters/templates/{template['id']}", headers=globex.headers()
    ).status_code in (404, 405)


def test_deleting_a_template_leaves_its_letters_readable(client, tenants):
    """Those letters are records of what the company told somebody."""
    acme, _ = tenants
    _place(acme.employee.id)
    template = _template(client, acme)
    draft = _draft(client, acme, template["id"], acme.employee.id)
    issued = client.post(
        f"/api/v1/letters/{draft['id']}/issue", json={}, headers=acme.headers()
    ).json()

    assert client.delete(
        f"/api/v1/letters/templates/{template['id']}", headers=acme.headers()
    ).status_code == 204

    after = client.get(f"/api/v1/letters/{draft['id']}", headers=acme.headers()).json()
    assert after["body"] == issued["body"]
    assert after["template_id"] is None
    # The name survives on the letter, so it still says what it was.
    assert after["template_name"] == "Experience letter"


def test_letters_are_gated_like_every_other_module(client, tenants, platform_token):
    acme, _ = tenants
    client.put(
        f"/api/v1/platform/companies/{acme.id}/modules",
        json={"grants": [{"key": "letters", "enabled": False}]},
        headers={"Authorization": f"Bearer {platform_token}"},
    )
    response = client.get("/api/v1/letters/templates", headers=acme.headers())
    assert response.status_code == 402
    assert response.json()["detail"]["module"] == "letters"
