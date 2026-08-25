"""Core HR rules: who may read whose master record, and what they may see.

Written as a sibling of ``services/regularization`` and ``services/leave``, and
it borrows their two conventions: a typed error carrying a code the console can
branch on, and every rule in here rather than in a handler.

The access model, which is the whole of this module's difficulty:

* **Your own record is always yours.** Reading and editing your own personal
  details consults no permission flag at all. An HR system whose staff cannot
  correct their own phone number generates a ticket per person per year.
* **Somebody else's record needs two things**: a role that sees other people
  (``can_view_team`` scope via the hierarchy, or administrator) *and* the
  ``can_manage_people`` flag. Flags restrict, they never grant — so this narrows
  HR and administrators and can never widen an employee.
* **The employment half is HR's alone.** Employment type, probation,
  confirmation and background verification are not editable by the subject, and
  the split is enforced by two different request models rather than by an ``if``
  inside one handler.
* **Statutory numbers are never returned in full by a list or a get.** They are
  masked, and revealing one is a separate call that checks a permission and
  writes an audit row naming the field. Somebody adding a column to a serialiser
  therefore cannot leak a thousand PANs by accident.

A note on what is *not* here. There is no "HR role". The product's roles are
owner / manager / employee, and this module composes the existing hierarchy
service with one new flag rather than inventing a fourth role that every other
module would then have to learn about.
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import Request
from sqlalchemy import Select, func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import audit
from app.core.dates import add_months
from app.core.crypto import decrypt_secret, encrypt_secret, mask_tail
from app.models import (
    ConfirmationStatus,
    Department,
    Designation,
    EmployeeDocument,
    EmployeeProfile,
    Role,
    Team,
    User,
)
from app.schemas.corehr import (
    ConfirmationIn,
    DirectoryEntryOut,
    EmployeeDocumentOut,
    EmployeeProfileOut,
    EmploymentIn,
)
from app.services import storage

log = logging.getLogger(__name__)

#: Same ceiling as an onboarding document, for the same reason: it is the size
#: of a phone photograph of an A4 page, which is what almost every upload here
#: actually is.
MAX_DOCUMENT_BYTES = 15 * 1024 * 1024

_SAFE_SUFFIX = re.compile(r"^\.[A-Za-z0-9]{1,8}$")

#: The encrypted columns, mapped to the plaintext field name a caller uses. One
#: table so the reveal endpoint, the writer and the masker cannot disagree about
#: which fields are sensitive — a fourth encrypted column added to only two of
#: the three is the bug this prevents.
SENSITIVE: dict[str, str] = {
    "pan": "pan_enc",
    "aadhaar": "aadhaar_enc",
    "bank_account": "bank_account_enc",
}


class CoreHRError(Exception):
    """A rule said no, with a code the console can branch on."""

    def __init__(self, code: str, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _suffix_for(file_name: str) -> str:
    suffix = ("." + file_name.rsplit(".", 1)[-1]) if "." in file_name else ""
    return suffix if _SAFE_SUFFIX.match(suffix) else ""


# --------------------------------------------------------------------------- #
# Who may see whom
# --------------------------------------------------------------------------- #


def is_people_admin(viewer: User) -> bool:
    """May this person administer *other people's* master records.

    Role first, flag second — the flag restricts what the role already allows,
    so it is checked after, never instead. An employee with the flag on (which
    is the default for everyone) still fails the role check.
    """
    return viewer.role in (Role.OWNER.value, Role.ADMIN.value) and viewer.can_manage_people


def can_view(db: Session, viewer: User, subject_id: uuid.UUID) -> bool:
    """Own record always; anyone else only with the people-admin capability.

    Deliberately *not* the hierarchy. A manager can see their reports' activity
    and approve their leave, and that is a different question from reading their
    home address, bank account and marital status. Line management is not a
    reason to hold somebody's Aadhaar, so this is the one place in the product
    where a manager's reporting subtree buys them nothing.
    """
    if viewer.id == subject_id:
        return True
    return is_people_admin(viewer)


def ensure_subject(db: Session, viewer: User, subject_id: uuid.UUID) -> User:
    """Resolve the person being read, or refuse.

    404 on a cross-tenant id rather than 403: a 403 confirms the id exists
    somewhere, which is a disclosure across the tenant boundary. Same posture as
    every other module here.
    """
    subject = db.get(User, subject_id)
    if subject is None or subject.org_id != viewer.org_id:
        raise CoreHRError("employee_not_found", "Employee not found", 404)
    if not can_view(db, viewer, subject.id):
        raise CoreHRError(
            "not_permitted",
            "You may only view your own record.",
            403,
        )
    return subject


# --------------------------------------------------------------------------- #
# Reading
# --------------------------------------------------------------------------- #


def get_or_create_profile(db: Session, subject: User) -> EmployeeProfile:
    """The profile row, made on demand. **Writers only.**

    Created lazily rather than backfilled by the migration so that applying it
    gives every existing employee an *empty* record instead of a wrong one —
    there is no correct value to invent for a confirmation status or a
    nationality, and a table full of guesses is worse than a table of nulls.

    Flushed, not committed: the caller owns the transaction, and committing here
    would end one that the audit row is meant to share.
    """
    profile = db.get(EmployeeProfile, subject.id)
    if profile is None:
        profile = EmployeeProfile(user_id=subject.id, org_id=subject.org_id)
        db.add(profile)
        db.flush()
    return profile


def profile_for_read(db: Session, subject: User) -> EmployeeProfile:
    """The profile row, or an unsaved stand-in with the same defaults.

    Deliberately does **not** write. A GET that inserts is a GET that fails on a
    read replica, that turns an idle console poll into write load, and that
    quietly creates a row for every person an administrator merely browsed past.
    An employee who has never filled anything in has no profile row, and the
    honest representation of that is an empty one — not one conjured into
    existence by having been looked at.

    The stand-in is never added to the session, so nothing persists until an
    actual write comes through ``get_or_create_profile``.
    """
    profile = db.get(EmployeeProfile, subject.id)
    if profile is not None:
        return profile
    return EmployeeProfile(
        user_id=subject.id,
        org_id=subject.org_id,
        confirmation_status=ConfirmationStatus.NOT_APPLICABLE.value,
    )


def _placement(db: Session, subject: User) -> dict:
    """Designation / department / team / manager names for one person."""
    names: dict[str, str | None] = {
        "designation": None,
        "department": None,
        "team": None,
        "manager_name": None,
    }
    if subject.designation_id:
        row = db.get(Designation, subject.designation_id)
        names["designation"] = row.name if row else None
    if subject.department_id:
        row = db.get(Department, subject.department_id)
        names["department"] = row.name if row else None
    if subject.team_id:
        row = db.get(Team, subject.team_id)
        names["team"] = row.name if row else None
    if subject.manager_id:
        row = db.get(User, subject.manager_id)
        names["manager_name"] = row.full_name if row else None
    return names


def to_out(
    db: Session, viewer: User, subject: User, profile: EmployeeProfile
) -> EmployeeProfileOut:
    """One profile, masked, with the caller's own capabilities resolved onto it.

    The capability booleans are computed here rather than in the console because
    two implementations of one permission rule diverge, and the UI's copy is the
    one nobody writes a test for.
    """
    out = EmployeeProfileOut.model_validate(profile)

    out.full_name = subject.full_name
    out.email = subject.email
    out.employee_code = subject.employee_code
    out.joined_on = subject.joined_on
    out.status = subject.status
    for key, value in _placement(db, subject).items():
        setattr(out, key, value)

    # Masked, always. The plaintext leaves this server only through `reveal`.
    pan = decrypt_secret(profile.pan_enc, label="PAN")
    aadhaar = decrypt_secret(profile.aadhaar_enc, label="Aadhaar")
    account = decrypt_secret(profile.bank_account_enc, label="bank account")
    out.pan_masked = mask_tail(pan)
    out.aadhaar_masked = mask_tail(aadhaar)
    out.bank_account_masked = mask_tail(account)
    # `has_*` reads the column, not the decrypted value: a row whose SECRET_KEY
    # changed decrypts to "" but is still a stored value, and reporting it as
    # absent would send HR off to re-collect a document they already hold.
    out.has_pan = profile.pan_enc is not None
    out.has_aadhaar = profile.aadhaar_enc is not None
    out.has_bank_account = profile.bank_account_enc is not None

    if profile.updated_by:
        editor = db.get(User, profile.updated_by)
        out.updated_by_name = editor.full_name if editor else None

    own = viewer.id == subject.id
    admin = is_people_admin(viewer)
    out.can_edit_personal = own or admin
    # Never `own`: nobody confirms their own probation or signs off their own
    # background check.
    out.can_edit_employment = admin
    out.can_reveal = admin or own
    return out


def get_profile(db: Session, viewer: User, subject_id: uuid.UUID) -> EmployeeProfileOut:
    subject = ensure_subject(db, viewer, subject_id)
    return to_out(db, viewer, subject, profile_for_read(db, subject))


# --------------------------------------------------------------------------- #
# Writing
# --------------------------------------------------------------------------- #


def update_profile(
    db: Session,
    viewer: User,
    subject_id: uuid.UUID,
    payload,
    *,
    request: Request | None = None,
) -> EmployeeProfileOut:
    """Patch the personal half of a record.

    ``exclude_unset`` is what makes this a patch rather than a replace: the
    address form and the bank form each submit their own fields, and a model
    dump including unset ones would have the second wipe the first.

    The audit row names the fields that changed and never their values. "Who
    changed this PAN" has to be answerable; the log is not the place to keep a
    second, unencrypted copy of it.
    """
    subject = ensure_subject(db, viewer, subject_id)
    if not (viewer.id == subject.id or is_people_admin(viewer)):
        raise CoreHRError("not_permitted", "You may not edit this record.", 403)

    profile = get_or_create_profile(db, subject)
    changes = payload.model_dump(exclude_unset=True)
    touched: list[str] = []

    for field, value in changes.items():
        if field in SENSITIVE:
            column = SENSITIVE[field]
            encrypted = encrypt_secret(value) if value else None
            if getattr(profile, column) != encrypted:
                setattr(profile, column, encrypted)
                touched.append(field)
            continue
        # Enums arrive as members; the column is a plain string.
        stored = value.value if hasattr(value, "value") else value
        if getattr(profile, field, None) != stored:
            setattr(profile, field, stored)
            touched.append(field)

    if not touched:
        return to_out(db, viewer, subject, profile)

    profile.updated_by = viewer.id
    audit(
        db,
        org_id=viewer.org_id,
        actor=viewer,
        action="corehr.profile_updated",
        request=request,
        target_type="employee_profile",
        target_id=str(subject.id),
        detail={
            "for": str(subject.id),
            "fields": sorted(touched),
            "self": viewer.id == subject.id,
            # Names only. Never values — see the docstring.
            "sensitive": sorted(f for f in touched if f in SENSITIVE),
        },
    )
    db.commit()
    db.refresh(profile)
    return to_out(db, viewer, subject, profile)


def update_employment(
    db: Session,
    viewer: User,
    subject_id: uuid.UUID,
    payload: EmploymentIn,
    *,
    request: Request | None = None,
) -> EmployeeProfileOut:
    """Patch the employment half. People-admins only, including on themselves."""
    if not is_people_admin(viewer):
        raise CoreHRError(
            "not_permitted", "Only an administrator may edit employment details.", 403
        )
    subject = ensure_subject(db, viewer, subject_id)
    profile = get_or_create_profile(db, subject)

    changes = payload.model_dump(exclude_unset=True)
    touched = []
    for field, value in changes.items():
        stored = value.value if hasattr(value, "value") else value
        if getattr(profile, field, None) != stored:
            setattr(profile, field, stored)
            touched.append(field)

    if not touched:
        return to_out(db, viewer, subject, profile)

    profile.updated_by = viewer.id
    audit(db, org_id=viewer.org_id, actor=viewer, action="corehr.employment_updated",
          request=request, target_type="employee_profile", target_id=str(subject.id),
          detail={"for": str(subject.id), "fields": sorted(touched)})
    db.commit()
    db.refresh(profile)
    return to_out(db, viewer, subject, profile)


def set_confirmation(
    db: Session,
    viewer: User,
    subject_id: uuid.UUID,
    payload: ConfirmationIn,
    *,
    request: Request | None = None,
) -> EmployeeProfileOut:
    """Move somebody's probation to its next state.

    Its own operation rather than a field on the employment patch, because it is
    an event: a confirmation letter cites its date, and payroll may key a salary
    revision off it. Buried among twenty columns in a generic PATCH it would be
    invisible in the audit trail, which is the one place anyone will look when
    asked "when exactly was she confirmed".
    """
    if not is_people_admin(viewer):
        raise CoreHRError(
            "not_permitted", "Only an administrator may confirm an employee.", 403
        )
    subject = ensure_subject(db, viewer, subject_id)
    profile = get_or_create_profile(db, subject)

    previous = profile.confirmation_status
    profile.confirmation_status = payload.status.value
    if payload.status is ConfirmationStatus.CONFIRMED:
        # Defaults to today rather than staying null: a confirmation with no
        # date cannot be cited by the letter that announces it.
        profile.confirmed_on = payload.effective_on or date.today()
    elif payload.status is ConfirmationStatus.EXTENDED:
        # An extension moves the probation end, and clears any confirmation date
        # a previous pass had set — otherwise the record reads as both confirmed
        # and still on probation.
        profile.confirmed_on = None
        if payload.effective_on:
            profile.probation_end_on = payload.effective_on
    else:
        profile.confirmed_on = None

    if payload.note is not None:
        profile.confirmation_note = payload.note.strip() or None
    profile.updated_by = viewer.id

    audit(db, org_id=viewer.org_id, actor=viewer, action="corehr.confirmation_changed",
          request=request, target_type="employee_profile", target_id=str(subject.id),
          detail={
              "for": str(subject.id),
              "from": previous,
              "to": profile.confirmation_status,
              "effective_on": payload.effective_on.isoformat() if payload.effective_on else None,
              "note": payload.note,
          })
    db.commit()
    db.refresh(profile)
    return to_out(db, viewer, subject, profile)


# --------------------------------------------------------------------------- #
# Revealing an encrypted value
# --------------------------------------------------------------------------- #


def reveal(
    db: Session,
    viewer: User,
    subject_id: uuid.UUID,
    field: str,
    *,
    request: Request | None = None,
) -> str:
    """Hand over one decrypted statutory value, and record that it happened.

    A separate call rather than a query parameter on the profile GET. Two
    reasons, and the second is the important one: a parameter would be trivially
    added to a list endpoint and dump every PAN in the company, and an audit row
    per *record read* is noise nobody reviews, while an audit row per *number
    revealed* is a short list somebody will actually read.
    """
    subject = ensure_subject(db, viewer, subject_id)
    if field not in SENSITIVE:
        raise CoreHRError("unknown_field", f"{field} is not a revealable field.")
    if not (is_people_admin(viewer) or viewer.id == subject.id):
        raise CoreHRError("not_permitted", "You may not view this value.", 403)

    profile = db.get(EmployeeProfile, subject.id)
    token = getattr(profile, SENSITIVE[field], None) if profile else None
    if not token:
        raise CoreHRError("not_set", f"No {field} on file for this employee.", 404)

    value = decrypt_secret(token, label=field)
    if not value:
        # Decryption failed, which in practice means SECRET_KEY changed. Say so
        # rather than returning "" — an empty string on screen reads as "not
        # set" and sends HR to re-collect a document that is already on file.
        raise CoreHRError(
            "undecryptable",
            f"The stored {field} cannot be read. It must be re-entered.",
            409,
        )

    audit(db, org_id=viewer.org_id, actor=viewer, action="corehr.sensitive_revealed",
          request=request, target_type="employee_profile", target_id=str(subject.id),
          detail={"for": str(subject.id), "field": field, "self": viewer.id == subject.id})
    db.commit()
    return value


# --------------------------------------------------------------------------- #
# Lifecycle hooks — what other modules call when something happens to a person
# --------------------------------------------------------------------------- #
#
# These live here rather than in onboarding.py and offboarding.py because
# `employee_profiles` and `employee_documents` are this module's tables. A
# module that reaches into another's tables has to be edited every time the
# other's rules change; a named function is a contract that can be kept.
#
# All three are deliberately forgiving. They run inside somebody else's
# transaction, at the end of an operation that has already succeeded, and none
# of them is the point of that operation — onboarding completing must not fail
# because a probation date could not be computed.


def promote_document(
    db: Session,
    *,
    org_id: uuid.UUID,
    user_id: uuid.UUID,
    doc_type: str,
    title: str | None,
    source_key: str,
    file_name: str | None,
    content_type: str | None,
    actor: User,
    source_kind: str,
    source_id: uuid.UUID,
) -> EmployeeDocument | None:
    """Copy a document out of a time-boxed process into the permanent file.

    The problem this solves: a hire uploads their PAN card against an onboarding
    task. That row belongs to the checklist and is deleted with it, taking the
    bytes along (``onboarding.delete_document`` removes the object too). Months
    later HR archives the checklist and the company no longer holds the ID proof
    it collected.

    **The bytes are copied, not shared.** Pointing both rows at one storage key
    would be cheaper and is wrong for exactly that reason: deleting the
    onboarding document would leave the permanent row pointing at nothing, and a
    document that cannot be opened is worse than one never filed, because the
    file *says* it is there.

    Idempotent on the provenance marker. Verification can be toggled off and on
    again, and a second copy of the same passport in somebody's permanent file
    is the kind of mess nobody goes back and tidies.

    Returns the new row, or None when there was nothing to do — already
    promoted, or the source bytes are unreadable. Never raises: promotion is a
    side effect of verification, and a storage hiccup must not make the
    verification itself fail.
    """
    marker = f"{source_kind}:{source_id}"
    try:
        raw = storage.read(source_key)
    except (FileNotFoundError, storage.StorageError):
        log.warning(
            "could not promote %s %s for user %s: source bytes unreadable",
            source_kind, source_id, user_id,
        )
        return None

    doc = file_bytes(
        db,
        org_id=org_id,
        user_id=user_id,
        doc_type=doc_type,
        title=title,
        raw=raw,
        file_name=file_name,
        content_type=content_type,
        actor=actor,
        marker=marker,
    )
    if doc is not None:
        audit(db, org_id=org_id, actor=actor, action="corehr.document_promoted",
              target_type="employee_document", target_id=str(doc.id),
              detail={"for": str(user_id), "doc_type": doc.doc_type, "from": marker})
    return doc


def file_bytes(
    db: Session,
    *,
    org_id: uuid.UUID,
    user_id: uuid.UUID,
    doc_type: str,
    title: str | None,
    raw: bytes,
    file_name: str | None,
    content_type: str | None,
    actor: User,
    marker: str,
) -> EmployeeDocument | None:
    """Write bytes into somebody's permanent document file.

    The one path that creates an ``EmployeeDocument`` from content the system
    generated or copied, as opposed to one a person uploaded. Two callers so far
    — a promoted onboarding document and an issued letter — and they must agree
    about idempotency and key layout, which they will not if each writes its own
    seven lines.

    ``marker`` is the provenance string, stored in ``note``, and it doubles as
    the idempotency key: ``onboarding_document:<id>``, ``issued_letter:<id>``.
    Filing the same source twice returns None rather than making a duplicate,
    because a second copy of the same passport in somebody's file is the kind of
    mess nobody goes back and tidies.

    Returns None on a storage failure rather than raising. Every caller here is
    filing as a *side effect* of an operation that already succeeded, and a
    storage hiccup must not undo the verification or the issue that triggered it.
    """
    existing = db.scalar(
        select(EmployeeDocument).where(
            EmployeeDocument.org_id == org_id,
            EmployeeDocument.user_id == user_id,
            EmployeeDocument.note == marker,
        )
    )
    if existing is not None:
        return None

    doc_id = uuid.uuid4()
    key = storage.build_key(
        org_id, user_id, _now(), doc_id, suffix=_suffix_for(file_name or "")
    )
    try:
        size = storage.backend().put(key, raw, content_type or "application/octet-stream")
    except storage.StorageError:
        log.exception("could not store filed document for user %s", user_id)
        return None

    doc = EmployeeDocument(
        id=doc_id,
        org_id=org_id,
        user_id=user_id,
        doc_type=(doc_type or "other").strip()[:60],
        title=title or None,
        storage_key=key,
        file_name=(file_name or "")[:255] or None,
        content_type=(content_type or "")[:120] or None,
        file_size=size,
        uploaded_by=actor.id,
        note=marker,
    )
    db.add(doc)
    db.flush()
    return doc


def start_probation(
    db: Session,
    *,
    subject: User,
    actor: User,
    joined_on: date | None = None,
) -> None:
    """Put somebody on probation once their onboarding is done.

    Without this nothing ever moves ``confirmation_status`` off
    ``not_applicable``, so the probation-due report stays empty in real use and
    a probation quietly lapses into a confirmation nobody granted.

    Only moves a record that is still ``not_applicable``. Somebody already
    confirmed, extended or terminated has had a decision made about them, and a
    checklist ticked afterwards — a reopened task, a rehire's second instance —
    must not rewind it.

    The end date is computed only when HR has set ``probation_months``.
    Inventing a default (three months? six?) would put a date on a report that
    nobody chose and everybody would then trust.
    """
    profile = get_or_create_profile(db, subject)
    if profile.confirmation_status != ConfirmationStatus.NOT_APPLICABLE.value:
        return

    profile.confirmation_status = ConfirmationStatus.PROBATION.value
    start = joined_on or subject.joined_on
    if profile.probation_end_on is None and profile.probation_months and start:
        profile.probation_end_on = add_months(start, profile.probation_months)
    profile.updated_by = actor.id

    audit(db, org_id=subject.org_id, actor=actor, action="corehr.probation_started",
          target_type="employee_profile", target_id=str(subject.id),
          detail={
              "for": str(subject.id),
              "ends": profile.probation_end_on.isoformat()
              if profile.probation_end_on else None,
          })


def mark_exited(db: Session, *, subject: User, actor: User) -> None:
    """Close out a master record when somebody leaves.

    Without it a departed employee's profile still reads "Confirmed", which was
    true of the day they left and is misleading on every screen after it.

    ``TERMINATED`` here means "the confirmation lifecycle has ended", not that
    they were dismissed. Offboarding owns the reason for leaving; this column
    only records that the lifecycle stopped.
    """
    profile = get_or_create_profile(db, subject)
    if profile.confirmation_status == ConfirmationStatus.TERMINATED.value:
        return
    previous = profile.confirmation_status
    profile.confirmation_status = ConfirmationStatus.TERMINATED.value
    profile.updated_by = actor.id
    audit(db, org_id=subject.org_id, actor=actor, action="corehr.exit_recorded",
          target_type="employee_profile", target_id=str(subject.id),
          detail={"for": str(subject.id), "from": previous})


# --------------------------------------------------------------------------- #
# Documents
# --------------------------------------------------------------------------- #


def _doc_names(db: Session, org_id: uuid.UUID, rows) -> dict[uuid.UUID, str]:
    wanted: set[uuid.UUID] = set()
    for row in rows:
        wanted.update(
            v for v in (row.user_id, row.uploaded_by, row.verified_by) if v is not None
        )
    if not wanted:
        return {}
    return {
        r[0]: r[1]
        for r in db.execute(
            select(User.id, User.full_name).where(User.org_id == org_id, User.id.in_(wanted))
        )
    }


def _doc_out(row: EmployeeDocument, names: dict[uuid.UUID, str]) -> EmployeeDocumentOut:
    out = EmployeeDocumentOut.model_validate(row)
    out.user_name = names.get(row.user_id)
    out.uploaded_by_name = names.get(row.uploaded_by)
    out.verified_by_name = names.get(row.verified_by)
    if row.expires_on is not None:
        # Server-side so "expiring soon" means one thing across the list, the
        # dashboard tile and the report, rather than three date subtractions
        # written three times.
        out.days_to_expiry = (row.expires_on - date.today()).days
    return out


def list_documents(
    db: Session, viewer: User, subject_id: uuid.UUID
) -> list[EmployeeDocumentOut]:
    subject = ensure_subject(db, viewer, subject_id)
    rows = list(
        db.scalars(
            select(EmployeeDocument)
            .where(
                EmployeeDocument.org_id == viewer.org_id,
                EmployeeDocument.user_id == subject.id,
            )
            .order_by(EmployeeDocument.created_at.desc())
        )
    )
    names = _doc_names(db, viewer.org_id, rows)
    return [_doc_out(row, names) for row in rows]


def upload_document(
    db: Session,
    viewer: User,
    subject_id: uuid.UUID,
    *,
    meta,
    file_name: str,
    content_type: str,
    raw: bytes,
    request: Request | None = None,
) -> EmployeeDocumentOut:
    """Store a file against a person's permanent record."""
    subject = ensure_subject(db, viewer, subject_id)
    if not (viewer.id == subject.id or is_people_admin(viewer)):
        raise CoreHRError("not_permitted", "You may not add documents to this record.", 403)
    if not raw:
        raise CoreHRError("empty_upload", "The file is empty.")
    if len(raw) > MAX_DOCUMENT_BYTES:
        raise CoreHRError(
            "too_large",
            f"Documents are limited to {MAX_DOCUMENT_BYTES // (1024 * 1024)} MB.",
            413,
        )
    if meta.expires_on and meta.issued_on and meta.expires_on < meta.issued_on:
        raise CoreHRError("bad_dates", "The expiry date is before the issue date.")

    doc_id = uuid.uuid4()
    key = storage.build_key(
        viewer.org_id, subject.id, _now(), doc_id, suffix=_suffix_for(file_name)
    )
    try:
        size = storage.backend().put(key, raw, content_type or "application/octet-stream")
    except storage.StorageError as exc:
        # No row when the object did not store: a document row pointing at
        # nothing reads as "we hold this" on every screen that counts them.
        raise CoreHRError("storage_failed", f"Could not store the document: {exc}", 503) from exc

    doc = EmployeeDocument(
        id=doc_id,
        org_id=viewer.org_id,
        user_id=subject.id,
        doc_type=meta.doc_type.strip(),
        title=(meta.title or "").strip() or None,
        storage_key=key,
        file_name=(file_name or "")[:255],
        content_type=(content_type or "")[:120],
        file_size=size,
        issued_on=meta.issued_on,
        expires_on=meta.expires_on,
        note=(meta.note or "").strip() or None,
        uploaded_by=viewer.id,
    )
    db.add(doc)
    audit(db, org_id=viewer.org_id, actor=viewer, action="corehr.document_uploaded",
          request=request, target_type="employee_document", target_id=str(doc.id),
          detail={"for": str(subject.id), "doc_type": doc.doc_type})
    db.commit()
    db.refresh(doc)
    return _doc_out(doc, _doc_names(db, viewer.org_id, [doc]))


def get_document(db: Session, viewer: User, document_id: uuid.UUID) -> EmployeeDocument:
    row = db.get(EmployeeDocument, document_id)
    if row is None or row.org_id != viewer.org_id:
        raise CoreHRError("not_found", "Document not found", 404)
    # The same read rule as the profile it hangs off: your own, or a
    # people-admin's. Checked here rather than at the route so the download and
    # the delete cannot drift apart from the list.
    if not can_view(db, viewer, row.user_id):
        raise CoreHRError("not_permitted", "You may not view this document.", 403)
    return row


def serve_document(db: Session, viewer: User, document_id: uuid.UUID):
    doc = get_document(db, viewer, document_id)
    try:
        return doc, storage.serve(doc.storage_key)
    except (FileNotFoundError, storage.StorageError):
        raise CoreHRError("data_missing", "The stored file is missing.", 404) from None


def verify_document(
    db: Session,
    viewer: User,
    document_id: uuid.UUID,
    payload,
    *,
    request: Request | None = None,
) -> EmployeeDocumentOut:
    """Mark a document checked, or un-check it. People-admins only.

    Not the subject: verification means "somebody at this company looked at the
    original", and a person verifying their own upload is the one signature the
    whole field exists to prevent.
    """
    if not is_people_admin(viewer):
        raise CoreHRError("not_permitted", "Only an administrator may verify a document.", 403)
    doc = get_document(db, viewer, document_id)

    doc.is_verified = payload.is_verified
    doc.verified_by = viewer.id if payload.is_verified else None
    doc.verified_at = _now() if payload.is_verified else None
    if payload.note is not None:
        doc.note = payload.note.strip() or None

    audit(db, org_id=viewer.org_id, actor=viewer, action="corehr.document_verified",
          request=request, target_type="employee_document", target_id=str(doc.id),
          detail={"for": str(doc.user_id), "verified": doc.is_verified})
    db.commit()
    db.refresh(doc)
    return _doc_out(doc, _doc_names(db, viewer.org_id, [doc]))


def delete_document(
    db: Session, viewer: User, document_id: uuid.UUID, *, request: Request | None = None
) -> None:
    """Remove a document and its stored bytes. People-admins only.

    Not the subject, deliberately: an employee deleting their own signed policy
    acknowledgement after the fact is exactly what a document file exists to
    make impossible.
    """
    if not is_people_admin(viewer):
        raise CoreHRError("not_permitted", "Only an administrator may delete a document.", 403)
    doc = get_document(db, viewer, document_id)
    key, subject_id, doc_type = doc.storage_key, doc.user_id, doc.doc_type

    db.delete(doc)
    audit(db, org_id=viewer.org_id, actor=viewer, action="corehr.document_deleted",
          request=request, target_type="employee_document", target_id=str(document_id),
          detail={"for": str(subject_id), "doc_type": doc_type})
    db.commit()
    # After the commit: a failed object delete must not roll back the row, or a
    # retry loops forever on a file the backend has already lost.
    storage.delete(key)


def expiring_documents(
    db: Session, viewer: User, within_days: int = 60
) -> list[EmployeeDocumentOut]:
    """Documents lapsing soon, across everyone this caller may see.

    People-admins only, because the answer spans the whole company. The index
    ``ix_employee_documents_expiry`` exists for exactly this scan.
    """
    if not is_people_admin(viewer):
        raise CoreHRError("not_permitted", "Only an administrator may read this report.", 403)
    horizon = date.today() + timedelta(days=within_days)
    rows = list(
        db.scalars(
            select(EmployeeDocument)
            .where(
                EmployeeDocument.org_id == viewer.org_id,
                EmployeeDocument.expires_on.is_not(None),
                EmployeeDocument.expires_on <= horizon,
            )
            .order_by(EmployeeDocument.expires_on)
        )
    )
    names = _doc_names(db, viewer.org_id, rows)
    return [_doc_out(row, names) for row in rows]


# --------------------------------------------------------------------------- #
# Directory and roster
# --------------------------------------------------------------------------- #


def directory(
    db: Session, viewer: User, query: str | None = None, limit: int = 200
) -> list[DirectoryEntryOut]:
    """Everyone at this company, as work contact details only.

    Open to every employee on purpose — finding a colleague's extension is what
    a directory is for, and gating it behind a permission means a company-wide
    tool nobody can use. What keeps that safe is the *shape* of the response:
    ``DirectoryEntryOut`` carries no date of birth, no address and no statutory
    field, so widening the audience cannot widen the disclosure.
    """
    statement: Select = (
        select(User, EmployeeProfile)
        .outerjoin(EmployeeProfile, EmployeeProfile.user_id == User.id)
        .where(User.org_id == viewer.org_id, User.is_active.is_(True))
    )
    if query:
        needle = f"%{query.strip().lower()}%"
        statement = statement.where(
            or_(
                func.lower(User.full_name).like(needle),
                func.lower(User.email).like(needle),
                func.lower(func.coalesce(User.employee_code, "")).like(needle),
            )
        )
    statement = statement.order_by(User.full_name).limit(min(limit, 500))

    rows = list(db.execute(statement))
    placement_cache: dict[uuid.UUID, dict] = {}
    entries: list[DirectoryEntryOut] = []
    for user, profile in rows:
        if user.id not in placement_cache:
            placement_cache[user.id] = _placement(db, user)
        names = placement_cache[user.id]
        entries.append(
            DirectoryEntryOut(
                user_id=user.id,
                full_name=user.full_name,
                email=user.email,
                phone=user.phone,
                employee_code=user.employee_code,
                designation=names["designation"],
                department=names["department"],
                team=names["team"],
                manager_name=names["manager_name"],
                work_location=profile.work_location if profile else None,
                status=user.status,
            )
        )
    return entries


def probation_due(db: Session, viewer: User, within_days: int = 30) -> list[EmployeeProfileOut]:
    """People whose probation ends soon and who are not confirmed yet.

    The report that makes the confirmation field worth having: a probation that
    quietly lapses becomes a confirmation nobody granted and a letter nobody
    sent.
    """
    if not is_people_admin(viewer):
        raise CoreHRError("not_permitted", "Only an administrator may read this report.", 403)
    horizon = date.today() + timedelta(days=within_days)
    rows = list(
        db.scalars(
            select(EmployeeProfile)
            .where(
                EmployeeProfile.org_id == viewer.org_id,
                EmployeeProfile.probation_end_on.is_not(None),
                EmployeeProfile.probation_end_on <= horizon,
                EmployeeProfile.confirmation_status.in_(
                    (ConfirmationStatus.PROBATION.value, ConfirmationStatus.EXTENDED.value)
                ),
            )
            .order_by(EmployeeProfile.probation_end_on)
        )
    )
    out: list[EmployeeProfileOut] = []
    for profile in rows:
        subject = db.get(User, profile.user_id)
        if subject is not None:
            out.append(to_out(db, viewer, subject, profile))
    return out
