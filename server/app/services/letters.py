"""Letter rules: templates, drafts, issuing, revoking, filing.

The three that matter, and why:

**Issuing freezes the text.** A draft re-renders on every read — the point of a
draft is to see what today's facts produce. Issuing renders once and stores the
result, and nothing afterwards can change it. An experience letter that quietly
updated itself when somebody's designation changed would rewrite a document a
consulate already holds. Same rule, same reason, as ``timesheet_approvals``
freezing its totals.

**A reference number is allocated at issue, never before.** It is the thing that
distinguishes "the company issued this" from "somebody opened a preview". The
allocation races — two administrators issuing at once — and is handled by a
unique constraint plus a bounded retry rather than a lock, because the losing
side simply takes the next number and a table lock on every issue is a poor
trade for an event that happens a few times a day.

**An issued letter is filed into the employee's permanent documents.** So it
turns up where somebody looks for it, next to their contract, rather than only
in a letters screen they have to know exists. Filing is a side effect: it must
never fail the issue, exactly as promoting an onboarding document must never
fail the verification.

Revoking does not delete anything. Withdrawing a letter is a new fact about it,
not permission to pretend it never said what it said — the body stays, the
filed document stays, and the status records what happened.
"""

from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timezone

from fastapi import Request
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import audit
from app.models import (
    EmployeeProfile,
    IssuedLetter,
    LetterStatus,
    LetterTemplate,
    LetterType,
    Organization,
    Role,
    User,
)
from app.services import corehr, lettermerge

log = logging.getLogger(__name__)

#: How many times to retry a reference-number collision before giving up. Three
#: is generous: a collision needs two administrators issuing in the same
#: millisecond, and a fourth attempt would mean something is wrong that
#: retrying will not fix.
_REFERENCE_ATTEMPTS = 3


class LetterError(Exception):
    """A rule said no, with a code the console can branch on."""

    def __init__(self, code: str, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _now() -> datetime:
    return datetime.now(timezone.utc)


def can_issue(viewer: User) -> bool:
    """Role first, flag second — the flag restricts what the role allows."""
    return viewer.role in (Role.OWNER.value, Role.ADMIN.value) and viewer.can_issue_letters


def _require_issuer(viewer: User) -> None:
    if not can_issue(viewer):
        raise LetterError(
            "not_permitted", "Only an administrator may manage letters.", 403
        )


# --------------------------------------------------------------------------- #
# Templates
# --------------------------------------------------------------------------- #


def get_template(db: Session, org_id: uuid.UUID, template_id: uuid.UUID) -> LetterTemplate:
    row = db.get(LetterTemplate, template_id)
    if row is None or row.org_id != org_id:
        # 404 rather than 403 on a cross-tenant miss — a 403 confirms the id
        # exists somewhere.
        raise LetterError("template_not_found", "Letter template not found", 404)
    return row


def list_templates(
    db: Session, viewer: User, *, active_only: bool = False, requestable_only: bool = False
) -> list[LetterTemplate]:
    """Templates for this company.

    ``requestable_only`` is what an employee's self-service list uses, and it is
    the only view of this table an employee gets. A template body can name any
    merge field, so exposing the full list would tell everybody what the company
    puts in its warning letters.
    """
    statement = select(LetterTemplate).where(LetterTemplate.org_id == viewer.org_id)
    if active_only or requestable_only:
        statement = statement.where(LetterTemplate.is_active.is_(True))
    if requestable_only:
        statement = statement.where(LetterTemplate.employee_requestable.is_(True))
    return list(db.scalars(statement.order_by(LetterTemplate.name)))


def _validate_body(body: str) -> None:
    """Refuse a template with a token that will never resolve.

    Checked at save time, not only at issue: the person who can fix
    ``{{employee.name}}`` is the one editing the template, not the one issuing a
    letter from it three weeks later and wondering why it says that.
    """
    unknown = lettermerge.unknown_tokens(body)
    if unknown:
        raise LetterError(
            "unknown_fields",
            "These merge fields do not exist: " + ", ".join(f"{{{{{t}}}}}" for t in unknown),
        )


def create_template(
    db: Session, viewer: User, payload, *, request: Request | None = None
) -> LetterTemplate:
    _require_issuer(viewer)
    _validate_body(payload.body)

    row = LetterTemplate(
        org_id=viewer.org_id,
        name=payload.name.strip(),
        letter_type=payload.letter_type.value,
        description=(payload.description or "").strip() or None,
        subject=(payload.subject or "").strip() or None,
        body=payload.body,
        signatory_name=(payload.signatory_name or "").strip() or None,
        signatory_title=(payload.signatory_title or "").strip() or None,
        employee_requestable=payload.employee_requestable,
        is_active=payload.is_active,
        created_by=viewer.id,
    )
    db.add(row)
    audit(db, org_id=viewer.org_id, actor=viewer, action="letters.template_created",
          request=request, target_type="letter_template", target_id=str(row.id),
          detail={"name": row.name, "type": row.letter_type})
    db.commit()
    db.refresh(row)
    return row


def update_template(
    db: Session,
    viewer: User,
    template_id: uuid.UUID,
    payload,
    *,
    request: Request | None = None,
) -> LetterTemplate:
    """Edit a template.

    Editing changes what the *next* letter says and nothing about the last one.
    That is not a limitation to work around — it is the guarantee that makes an
    issued letter worth anything.
    """
    _require_issuer(viewer)
    row = get_template(db, viewer.org_id, template_id)

    changes = payload.model_dump(exclude_unset=True)
    if "body" in changes:
        _validate_body(changes["body"])

    touched = []
    for field, value in changes.items():
        stored = value.value if hasattr(value, "value") else value
        if isinstance(stored, str) and field != "body":
            stored = stored.strip() or None
        if getattr(row, field, None) != stored:
            setattr(row, field, stored)
            touched.append(field)

    if touched:
        audit(db, org_id=viewer.org_id, actor=viewer, action="letters.template_updated",
              request=request, target_type="letter_template", target_id=str(row.id),
              detail={"fields": sorted(touched)})
        db.commit()
        db.refresh(row)
    return row


def delete_template(
    db: Session, viewer: User, template_id: uuid.UUID, *, request: Request | None = None
) -> None:
    """Remove a template. Letters already issued from it are untouched.

    The FK is SET NULL for exactly this: those letters are records of what the
    company told somebody, and they keep their own copy of the body and the
    template's name.
    """
    _require_issuer(viewer)
    row = get_template(db, viewer.org_id, template_id)
    name = row.name
    db.delete(row)
    audit(db, org_id=viewer.org_id, actor=viewer, action="letters.template_deleted",
          request=request, target_type="letter_template", target_id=str(template_id),
          detail={"name": name})
    db.commit()


# --------------------------------------------------------------------------- #
# Rendering
# --------------------------------------------------------------------------- #


def _subject_and_profile(db: Session, org_id: uuid.UUID, user_id: uuid.UUID):
    subject = db.get(User, user_id)
    if subject is None or subject.org_id != org_id:
        raise LetterError("employee_not_found", "Employee not found", 404)
    return subject, db.get(EmployeeProfile, user_id)


def preview(
    db: Session,
    viewer: User,
    *,
    template_id: uuid.UUID,
    user_id: uuid.UUID,
) -> lettermerge.Rendered:
    """What this template produces for this person, right now.

    Reads nothing and writes nothing. It exists so an administrator can see the
    gaps — an empty ``{{employee.confirmed_on}}`` on a confirmation letter —
    *before* issuing, which is the only point at which they are cheap to fix.
    """
    _require_issuer(viewer)
    template = get_template(db, viewer.org_id, template_id)
    subject, profile = _subject_and_profile(db, viewer.org_id, user_id)
    org = db.get(Organization, viewer.org_id)
    context = lettermerge.context_for(
        db, org=org, subject=subject, profile=profile,
        reference="(allocated on issue)", issued_on=date.today(),
    )
    return lettermerge.render(template.body, context)


def _next_reference(db: Session, org: Organization, on: date) -> str:
    """``ACME/HR/2026/0007``.

    The prefix comes from the slug so a letter identifies its issuer at a
    glance. The counter is per organisation per year and is derived by counting
    rather than kept in a column: a counter column is one more thing to get out
    of step with the rows it counts, and this table is small enough that the
    count is free.
    """
    prefix = (org.slug or "org").upper()[:12]
    year = on.year
    used = db.scalar(
        select(func.count(IssuedLetter.id)).where(
            IssuedLetter.org_id == org.id,
            IssuedLetter.reference_no.is_not(None),
            func.substr(IssuedLetter.reference_no, -9, 4) == str(year),
        )
    ) or 0
    return f"{prefix}/HR/{year}/{used + 1:04d}"


def create_draft(
    db: Session,
    viewer: User,
    payload,
    *,
    request: Request | None = None,
) -> IssuedLetter:
    """Render a template for one person and keep it as a draft.

    The body is rendered and stored even in draft, so an administrator can edit
    the wording of this one letter without touching the template every other
    letter uses. Re-rendering happens only when they explicitly ask for it.
    """
    _require_issuer(viewer)
    template = get_template(db, viewer.org_id, payload.template_id)
    subject, profile = _subject_and_profile(db, viewer.org_id, payload.user_id)
    org = db.get(Organization, viewer.org_id)

    rendered = lettermerge.render(
        template.body,
        lettermerge.context_for(
            db, org=org, subject=subject, profile=profile,
            reference="", issued_on=date.today(),
        ),
    )

    row = IssuedLetter(
        org_id=viewer.org_id,
        user_id=subject.id,
        template_id=template.id,
        letter_type=template.letter_type,
        template_name=template.name,
        subject=template.subject,
        body=rendered.text,
        signatory_name=template.signatory_name,
        signatory_title=template.signatory_title,
        status=LetterStatus.DRAFT.value,
    )
    db.add(row)
    audit(db, org_id=viewer.org_id, actor=viewer, action="letters.draft_created",
          request=request, target_type="issued_letter", target_id=str(row.id),
          detail={"for": str(subject.id), "type": row.letter_type,
                  "template": template.name})
    db.commit()
    db.refresh(row)
    return row


def update_draft(
    db: Session,
    viewer: User,
    letter_id: uuid.UUID,
    payload,
    *,
    request: Request | None = None,
) -> IssuedLetter:
    """Edit a draft's wording. Refused once issued."""
    _require_issuer(viewer)
    row = get_letter(db, viewer, letter_id)
    if row.status != LetterStatus.DRAFT.value:
        raise LetterError(
            "already_issued",
            "An issued letter cannot be edited. Revoke it and issue a new one.",
            409,
        )

    changes = payload.model_dump(exclude_unset=True)
    for field, value in changes.items():
        setattr(row, field, value)
    audit(db, org_id=viewer.org_id, actor=viewer, action="letters.draft_updated",
          request=request, target_type="issued_letter", target_id=str(row.id),
          detail={"for": str(row.user_id), "fields": sorted(changes)})
    db.commit()
    db.refresh(row)
    return row


# --------------------------------------------------------------------------- #
# Issuing
# --------------------------------------------------------------------------- #


def _as_html(row: IssuedLetter, org: Organization) -> bytes:
    """The filed artefact.

    HTML, not PDF, and that is a deliberate limit rather than an oversight: no
    PDF renderer is installed, and adding one (weasyprint needs native libraries;
    reportlab needs a layout written by hand) is a large dependency for something
    every browser already does well from a print stylesheet. The document is
    stored as a self-contained page with print styles, so "Save as PDF" from the
    browser produces the artefact people expect.

    Escaped, because the body contains employee-supplied text — an address with
    an angle bracket in it must not become markup.
    """
    from html import escape

    paragraphs = "\n".join(
        f"<p>{escape(block).replace(chr(10), '<br>')}</p>"
        for block in row.body.split("\n\n")
        if block.strip()
    )
    signature = ""
    if row.signatory_name:
        signature = (
            f'<div class="sign"><div class="sign-name">{escape(row.signatory_name)}</div>'
            f'<div class="sign-title">{escape(row.signatory_title or "")}</div></div>'
        )
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><title>{escape(row.subject or row.letter_type)}</title>
<style>
  body {{ font: 12pt/1.6 Georgia, serif; color: #111; max-width: 720px;
         margin: 40px auto; padding: 0 24px; }}
  .head {{ display: flex; justify-content: space-between; align-items: baseline;
          border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 28px; }}
  .org {{ font-size: 16pt; font-weight: 700; }}
  .meta {{ font-size: 10pt; color: #555; text-align: right; }}
  h1 {{ font-size: 13pt; text-transform: uppercase; letter-spacing: .08em;
       text-align: center; margin: 0 0 24px; }}
  p {{ margin: 0 0 14px; text-align: justify; }}
  .sign {{ margin-top: 48px; }}
  .sign-name {{ font-weight: 700; }}
  .sign-title {{ font-size: 10pt; color: #555; }}
  /* The whole reason this is HTML: the browser's own PDF export. */
  @media print {{ body {{ margin: 0; max-width: none; }} }}
</style></head><body>
<div class="head">
  <div class="org">{escape(org.legal_name or org.name or "")}</div>
  <div class="meta">{escape(row.reference_no or "")}<br>
    {escape(row.issued_on.isoformat() if row.issued_on else "")}</div>
</div>
<h1>{escape(row.subject or row.letter_type.replace("_", " "))}</h1>
{paragraphs}
{signature}
</body></html>""".encode("utf-8")


def _file_copy(db: Session, row: IssuedLetter, org: Organization, actor: User) -> None:
    """Put the issued letter into the employee's permanent document record.

    Wrapped so a storage failure cannot fail the issue. The letter is issued
    either way — it has a reference number and a frozen body, which is what
    makes it real — and a missing filed copy is a nuisance rather than a
    correctness problem.
    """
    try:
        doc = corehr.file_bytes(
            db,
            org_id=row.org_id,
            user_id=row.user_id,
            doc_type=f"letter_{row.letter_type}",
            title=row.subject or (row.template_name or "Letter"),
            raw=_as_html(row, org),
            file_name=f"{(row.reference_no or 'letter').replace('/', '-')}.html",
            content_type="text/html",
            actor=actor,
            marker=f"issued_letter:{row.id}",
        )
    except Exception:  # noqa: BLE001 - filing must never fail the issue
        log.exception("could not file issued letter %s", row.id)
        return
    if doc is not None:
        row.document_id = doc.id


def issue(
    db: Session,
    viewer: User,
    letter_id: uuid.UUID,
    payload=None,
    *,
    request: Request | None = None,
) -> IssuedLetter:
    """Allocate a reference, freeze the text, file a copy.

    After this the body is immutable. The retry loop handles two administrators
    issuing at the same moment: the unique constraint rejects the loser, the
    session is rolled back to a usable state, and the count is taken again.
    """
    _require_issuer(viewer)
    row = get_letter(db, viewer, letter_id)
    if row.status == LetterStatus.ISSUED.value:
        raise LetterError("already_issued", "This letter has already been issued.", 409)
    if row.status == LetterStatus.REVOKED.value:
        raise LetterError(
            "revoked",
            "A revoked letter cannot be re-issued. Create a new one.",
            409,
        )

    org = db.get(Organization, viewer.org_id)
    issued_on = (payload.issued_on if payload and payload.issued_on else None) or date.today()

    for attempt in range(_REFERENCE_ATTEMPTS):
        row.reference_no = _next_reference(db, org, issued_on)
        row.status = LetterStatus.ISSUED.value
        row.issued_on = issued_on
        row.issued_by = viewer.id
        try:
            db.flush()
            break
        except IntegrityError:
            # Rolled back before anything else touches the session: SQLAlchemy
            # refuses to continue after a failed flush, and without this the
            # retry would fail on a PendingRollbackError instead of the
            # collision it is meant to handle.
            db.rollback()
            row = get_letter(db, viewer, letter_id)
            if attempt == _REFERENCE_ATTEMPTS - 1:
                raise LetterError(
                    "reference_collision",
                    "Could not allocate a reference number. Try again.",
                    409,
                ) from None

    # After the number exists, so the filed copy carries it on the page.
    _file_copy(db, row, org, viewer)

    audit(db, org_id=viewer.org_id, actor=viewer, action="letters.issued",
          request=request, target_type="issued_letter", target_id=str(row.id),
          detail={"for": str(row.user_id), "type": row.letter_type,
                  "reference": row.reference_no})
    db.commit()
    db.refresh(row)
    return row


def revoke(
    db: Session,
    viewer: User,
    letter_id: uuid.UUID,
    payload,
    *,
    request: Request | None = None,
) -> IssuedLetter:
    """Withdraw an issued letter.

    Nothing is deleted — not the body, not the filed document, not the reference
    number. Revoking is a new fact about the letter, and a company that can make
    a letter it issued disappear has an audit trail worth nothing. The reference
    number is *not* released either: reusing it would make two different letters
    share an identifier.
    """
    _require_issuer(viewer)
    row = get_letter(db, viewer, letter_id)
    if row.status != LetterStatus.ISSUED.value:
        raise LetterError("not_issued", "Only an issued letter can be revoked.", 409)
    if not (payload.reason or "").strip():
        raise LetterError(
            "reason_required",
            "Say why it is being withdrawn — the record is what the reason is for.",
        )

    row.status = LetterStatus.REVOKED.value
    row.revoked_at = _now()
    row.revoked_by = viewer.id
    row.revoked_reason = payload.reason.strip()

    audit(db, org_id=viewer.org_id, actor=viewer, action="letters.revoked",
          request=request, target_type="issued_letter", target_id=str(row.id),
          detail={"for": str(row.user_id), "reference": row.reference_no,
                  "reason": row.revoked_reason})
    db.commit()
    db.refresh(row)
    return row


# --------------------------------------------------------------------------- #
# Reading
# --------------------------------------------------------------------------- #


def get_letter(db: Session, viewer: User, letter_id: uuid.UUID) -> IssuedLetter:
    """One letter, if this caller may see it.

    An employee may read a letter *issued to them*, and only once it has been
    issued: a draft is HR working out what to say, and showing somebody the
    draft of their own warning letter is not a feature.
    """
    row = db.get(IssuedLetter, letter_id)
    if row is None or row.org_id != viewer.org_id:
        raise LetterError("not_found", "Letter not found", 404)
    if can_issue(viewer):
        return row
    if row.user_id == viewer.id and row.status != LetterStatus.DRAFT.value:
        return row
    raise LetterError("not_permitted", "You may not view this letter.", 403)


def list_letters(
    db: Session,
    viewer: User,
    *,
    user_id: uuid.UUID | None = None,
    status: str | None = None,
) -> list[IssuedLetter]:
    """Letters, scoped to what the caller may see.

    An employee always gets their own issued letters regardless of what they
    ask for — the filter is narrowed rather than the request refused, because
    "show me letters" from an employee is a reasonable request with an obvious
    correct answer.
    """
    statement = select(IssuedLetter).where(IssuedLetter.org_id == viewer.org_id)
    if can_issue(viewer):
        if user_id is not None:
            statement = statement.where(IssuedLetter.user_id == user_id)
    else:
        statement = statement.where(
            IssuedLetter.user_id == viewer.id,
            IssuedLetter.status != LetterStatus.DRAFT.value,
        )
    if status:
        statement = statement.where(IssuedLetter.status == status)
    return list(db.scalars(statement.order_by(IssuedLetter.created_at.desc())))


def render_html(db: Session, viewer: User, letter_id: uuid.UUID) -> tuple[IssuedLetter, bytes]:
    """The printable page for one letter."""
    row = get_letter(db, viewer, letter_id)
    org = db.get(Organization, viewer.org_id)
    return row, _as_html(row, org)


# --------------------------------------------------------------------------- #
# Employee self-service
# --------------------------------------------------------------------------- #


def request_letter(
    db: Session,
    viewer: User,
    payload,
    *,
    request: Request | None = None,
) -> IssuedLetter:
    """An employee asking for a letter about themselves.

    Creates a draft for HR to review and issue, never an issued letter. The
    subject is the authenticated caller and nothing else — there is no
    ``user_id`` on this path, because "request a letter about a colleague" is
    not a thing that should be expressible.

    Only templates marked ``employee_requestable`` can be asked for. Without
    that flag every template would be self-service, including the warning
    letters.
    """
    template = get_template(db, viewer.org_id, payload.template_id)
    if not (template.is_active and template.employee_requestable):
        raise LetterError(
            "not_requestable",
            "That letter cannot be requested. Ask HR directly.",
            403,
        )

    subject, profile = _subject_and_profile(db, viewer.org_id, viewer.id)
    org = db.get(Organization, viewer.org_id)
    rendered = lettermerge.render(
        template.body,
        lettermerge.context_for(
            db, org=org, subject=subject, profile=profile,
            reference="", issued_on=date.today(),
        ),
    )

    row = IssuedLetter(
        org_id=viewer.org_id,
        user_id=viewer.id,
        template_id=template.id,
        letter_type=template.letter_type,
        template_name=template.name,
        subject=template.subject,
        body=rendered.text,
        signatory_name=template.signatory_name,
        signatory_title=template.signatory_title,
        status=LetterStatus.DRAFT.value,
        requested_by=viewer.id,
        request_note=(payload.note or "").strip() or None,
    )
    db.add(row)
    audit(db, org_id=viewer.org_id, actor=viewer, action="letters.requested",
          request=request, target_type="issued_letter", target_id=str(row.id),
          detail={"for": str(viewer.id), "type": row.letter_type})
    db.commit()
    db.refresh(row)
    return row


# --------------------------------------------------------------------------- #
# Starter templates
# --------------------------------------------------------------------------- #

#: Seeded on request, not automatically. A company that already wrote its own
#: templates should not find five of ours appearing beside them, and a company
#: starting out should not have to write an experience letter from scratch to
#: discover what merge fields exist.
STARTERS: tuple[dict, ...] = (
    {
        "name": "Appointment letter",
        "letter_type": LetterType.APPOINTMENT,
        "subject": "Letter of Appointment",
        "body": (
            "Dear {{employee.full_name}},\n\n"
            "We are pleased to confirm your appointment as {{employee.designation}} "
            "in the {{employee.department}} department at {{org.name}}, with effect "
            "from {{employee.joined_on}}.\n\n"
            "You will be based at {{employee.work_location}} and will report to "
            "{{employee.manager}}. Your employment is governed by the terms set out "
            "in your offer of employment and by company policy as amended from time "
            "to time.\n\n"
            "We look forward to working with you.\n\n"
            "Yours sincerely,"
        ),
    },
    {
        "name": "Confirmation of employment",
        "letter_type": LetterType.CONFIRMATION,
        "subject": "Confirmation of Employment",
        "body": (
            "Dear {{employee.full_name}},\n\n"
            "Following the successful completion of your probationary period, we are "
            "pleased to confirm your employment as {{employee.designation}} at "
            "{{org.name}} with effect from {{employee.confirmed_on}}.\n\n"
            "All other terms and conditions of your employment remain unchanged.\n\n"
            "Congratulations, and thank you for your contribution.\n\n"
            "Yours sincerely,"
        ),
    },
    {
        "name": "Experience letter",
        "letter_type": LetterType.EXPERIENCE,
        "subject": "To Whom It May Concern",
        "body": (
            "This is to certify that {{employee.full_name}} was employed with "
            "{{org.legal_name}} from {{employee.joined_on}}, most recently holding "
            "the position of {{employee.designation}} in the "
            "{{employee.department}} department.\n\n"
            "During their tenure we found them to be diligent and professional in "
            "the discharge of their responsibilities.\n\n"
            "This certificate is issued at the request of the employee.\n\n"
            "For {{org.legal_name}},"
        ),
        "employee_requestable": True,
    },
    {
        "name": "Employment / address proof",
        "letter_type": LetterType.ADDRESS_PROOF,
        "subject": "To Whom It May Concern",
        "body": (
            "This is to certify that {{employee.full_name}} "
            "(Employee Code {{employee.employee_code}}) is currently employed with "
            "{{org.legal_name}} as {{employee.designation}}, and has been with the "
            "company since {{employee.joined_on}}.\n\n"
            "As per our records their address is:\n"
            "{{employee.address}}, {{employee.city}}, {{employee.state}} "
            "{{employee.postal_code}}.\n\n"
            "This letter is issued at the request of the employee for the purpose "
            "of verification and carries no financial obligation on the part of the "
            "company.\n\n"
            "For {{org.legal_name}},"
        ),
        "employee_requestable": True,
    },
    {
        "name": "Relieving letter",
        "letter_type": LetterType.RELIEVING,
        "subject": "Relieving Letter",
        "body": (
            "Dear {{employee.full_name}},\n\n"
            "This is to confirm that you have been relieved from your duties as "
            "{{employee.designation}} at {{org.legal_name}}, and that you have "
            "completed all formalities required of you.\n\n"
            "We confirm that there are no dues outstanding against you as at the "
            "date of this letter.\n\n"
            "We wish you every success in your future endeavours.\n\n"
            "For {{org.legal_name}},"
        ),
    },
)


def seed_starters(
    db: Session, viewer: User, *, request: Request | None = None
) -> list[LetterTemplate]:
    """Add the standard five, skipping any name that already exists.

    Idempotent on the name so pressing the button twice does not produce ten
    templates — the likeliest way this gets used is somebody clicking it, not
    seeing where the templates went, and clicking again.
    """
    _require_issuer(viewer)
    existing = {
        name.lower()
        for name in db.scalars(
            select(LetterTemplate.name).where(LetterTemplate.org_id == viewer.org_id)
        )
    }
    made: list[LetterTemplate] = []
    for starter in STARTERS:
        if starter["name"].lower() in existing:
            continue
        row = LetterTemplate(
            org_id=viewer.org_id,
            name=starter["name"],
            letter_type=starter["letter_type"].value,
            subject=starter["subject"],
            body=starter["body"],
            employee_requestable=starter.get("employee_requestable", False),
            created_by=viewer.id,
        )
        db.add(row)
        made.append(row)

    if made:
        audit(db, org_id=viewer.org_id, actor=viewer, action="letters.starters_seeded",
              request=request, target_type="letter_template", target_id=None,
              detail={"added": [r.name for r in made]})
        db.commit()
        for row in made:
            db.refresh(row)
    return made
