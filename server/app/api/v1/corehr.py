"""Core HR: the employee master record, the document file, and the directory.

Thin, like every router here. Each handler resolves who is asking and who they
are asking about, calls ``app.services.corehr``, and turns a ``CoreHRError``
into a typed HTTP response. A rule in this file is a bug.

Three things that are genuinely this file's business.

**Personal and employment details are two endpoints, not one.** ``PATCH
/{user_id}`` takes ``EmployeeProfileIn`` and an employee may call it on
themselves; ``PATCH /{user_id}/employment`` takes ``EmploymentIn`` and only an
administrator may call it at all. One endpoint with a role check inside would
mean the request model that accepts a home address also accepts a confirmation
date, and the only thing standing between them would be an ``if`` somebody can
delete. Two models make the escalation unrepresentable.

**Revealing a statutory number is its own route.** Not a ``?reveal=true`` on the
GET. A query parameter would eventually be passed to a list endpoint and return
every PAN in the company in one response; a route that takes exactly one user
and one field name cannot be. It also gives the audit trail one row per number
revealed rather than one per record read, which is the difference between a log
somebody reviews and a log nobody does.

**The directory is open to everyone and returns a different shape.** Not a
filtered profile — a separate model with no date of birth, no address and no
statutory field, so widening the audience cannot widen the disclosure.
"""

from __future__ import annotations

import json
import uuid
from typing import NoReturn

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
    status,
)
from fastapi.responses import FileResponse, RedirectResponse

from app.api.deps import CurrentUser, DbSession
from app.schemas.corehr import (
    ConfirmationIn,
    DirectoryEntryOut,
    DocumentVerifyIn,
    EmployeeDocumentIn,
    EmployeeDocumentOut,
    EmployeeProfileIn,
    EmployeeProfileOut,
    EmploymentIn,
    RevealOut,
)
from app.services import corehr as svc

router = APIRouter(prefix="/people", tags=["core-hr"])


def _fail(error: svc.CoreHRError) -> NoReturn:
    """Turn a service refusal into something the console can branch on.

    The ``reason`` code, not the sentence — the UI offers "ask HR" for
    ``not_permitted`` and "re-enter it" for ``undecryptable``, and matching on
    prose breaks the first time somebody improves the wording.
    """
    raise HTTPException(
        error.status_code, detail={"reason": error.code, "message": error.message}
    )


# --------------------------------------------------------------------------- #
# Directory — every employee, work contact details only
# --------------------------------------------------------------------------- #


@router.get("/directory", response_model=list[DirectoryEntryOut])
def directory(
    viewer: CurrentUser,
    db: DbSession,
    q: str | None = Query(default=None, max_length=120),
    limit: int = Query(default=200, ge=1, le=500),
) -> list[DirectoryEntryOut]:
    """Find a colleague. Open to everyone, by design — see the module docstring.

    Declared before ``/{user_id}`` because FastAPI matches in declaration order
    and ``directory`` would otherwise be parsed as a user id and 422 on every
    request.
    """
    return svc.directory(db, viewer, query=q, limit=limit)


# --------------------------------------------------------------------------- #
# Reports — administrators only, enforced in the service
# --------------------------------------------------------------------------- #


@router.get("/reports/probation-due", response_model=list[EmployeeProfileOut])
def probation_due(
    viewer: CurrentUser,
    db: DbSession,
    within_days: int = Query(default=30, ge=1, le=365),
) -> list[EmployeeProfileOut]:
    """Probations ending soon that nobody has confirmed yet."""
    try:
        return svc.probation_due(db, viewer, within_days=within_days)
    except svc.CoreHRError as error:
        _fail(error)


@router.get("/reports/documents-expiring", response_model=list[EmployeeDocumentOut])
def documents_expiring(
    viewer: CurrentUser,
    db: DbSession,
    within_days: int = Query(default=60, ge=1, le=365),
) -> list[EmployeeDocumentOut]:
    """Visas, contracts and certificates lapsing soon."""
    try:
        return svc.expiring_documents(db, viewer, within_days=within_days)
    except svc.CoreHRError as error:
        _fail(error)


# --------------------------------------------------------------------------- #
# One person's master record
# --------------------------------------------------------------------------- #


@router.get("/me", response_model=EmployeeProfileOut)
def my_profile(viewer: CurrentUser, db: DbSession) -> EmployeeProfileOut:
    """Your own record. No permission involved — it is yours.

    A named route rather than making the console look up its own id and call
    ``/{user_id}``: the common case should not require the client to know who it
    is, and it keeps "my profile" out of the id-shaped path where a typo reaches
    somebody else's 403 instead of a 404.
    """
    try:
        return svc.get_profile(db, viewer, viewer.id)
    except svc.CoreHRError as error:
        _fail(error)


@router.get("/{user_id}", response_model=EmployeeProfileOut)
def read_profile(
    user_id: uuid.UUID, viewer: CurrentUser, db: DbSession
) -> EmployeeProfileOut:
    try:
        return svc.get_profile(db, viewer, user_id)
    except svc.CoreHRError as error:
        _fail(error)


@router.patch("/{user_id}", response_model=EmployeeProfileOut)
def update_profile(
    user_id: uuid.UUID,
    payload: EmployeeProfileIn,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
) -> EmployeeProfileOut:
    """Personal details. Your own, or anybody's if you administer people.

    ``CurrentUser``, not an admin dependency: correcting your own phone number
    is the most common write this module will ever take, and routing it through
    an administrator is how an HRMS earns its reputation.
    """
    try:
        return svc.update_profile(db, viewer, user_id, payload, request=request)
    except svc.CoreHRError as error:
        _fail(error)


@router.patch("/{user_id}/employment", response_model=EmployeeProfileOut)
def update_employment(
    user_id: uuid.UUID,
    payload: EmploymentIn,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
) -> EmployeeProfileOut:
    """Employment type, probation window, background verification. HR only."""
    try:
        return svc.update_employment(db, viewer, user_id, payload, request=request)
    except svc.CoreHRError as error:
        _fail(error)


@router.post("/{user_id}/confirmation", response_model=EmployeeProfileOut)
def set_confirmation(
    user_id: uuid.UUID,
    payload: ConfirmationIn,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
) -> EmployeeProfileOut:
    """Confirm, extend or end a probation. An event, so a POST, not a field."""
    try:
        return svc.set_confirmation(db, viewer, user_id, payload, request=request)
    except svc.CoreHRError as error:
        _fail(error)


@router.post("/{user_id}/reveal/{field}", response_model=RevealOut)
def reveal(
    user_id: uuid.UUID,
    field: str,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
) -> RevealOut:
    """One decrypted statutory value, audited.

    POST rather than GET although it reads nothing: it has a side effect that
    matters (the audit row), and a GET would be prefetched by a browser,
    retried by a proxy and land in an access log with the employee id in the
    path. None of those should be able to happen without someone clicking.
    """
    try:
        return RevealOut(field=field, value=svc.reveal(db, viewer, user_id, field, request=request))
    except svc.CoreHRError as error:
        _fail(error)


# --------------------------------------------------------------------------- #
# Documents
# --------------------------------------------------------------------------- #


@router.get("/{user_id}/documents", response_model=list[EmployeeDocumentOut])
def list_documents(
    user_id: uuid.UUID, viewer: CurrentUser, db: DbSession
) -> list[EmployeeDocumentOut]:
    try:
        return svc.list_documents(db, viewer, user_id)
    except svc.CoreHRError as error:
        _fail(error)


@router.post(
    "/{user_id}/documents",
    response_model=EmployeeDocumentOut,
    status_code=status.HTTP_201_CREATED,
)
async def upload_document(
    user_id: uuid.UUID,
    viewer: CurrentUser,
    db: DbSession,
    request: Request,
    meta: str = Form(..., description="JSON-encoded EmployeeDocumentIn"),
    file: UploadFile = File(...),
) -> EmployeeDocumentOut:
    """Multipart: JSON metadata in ``meta``, the file in ``file``.

    Same shape as the onboarding and screenshot uploads — one JSON blob rather
    than a form field per attribute — so the metadata is validated by a Pydantic
    model and adding a field later does not change the wire format.
    """
    try:
        parsed = EmployeeDocumentIn.model_validate_json(meta)
    except (ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, f"bad meta: {exc}"
        ) from exc

    # One byte past the ceiling, so an oversize upload is refused on its size
    # rather than after the whole thing has been buffered.
    raw = await file.read(svc.MAX_DOCUMENT_BYTES + 1)
    try:
        return svc.upload_document(
            db,
            viewer,
            user_id,
            meta=parsed,
            file_name=file.filename or "",
            content_type=file.content_type or "",
            raw=raw,
            request=request,
        )
    except svc.CoreHRError as error:
        _fail(error)


@router.get("/documents/{document_id}/file", response_model=None)
def download_document(
    document_id: uuid.UUID, viewer: CurrentUser, db: DbSession
) -> Response:
    """The only way to read a stored document.

    The permission check runs here, on every request, which is exactly what
    putting a ``storage_key`` in a response body would have thrown away. Local
    deployments stream the bytes; object storage redirects to a presigned URL
    minted *after* the check and valid for minutes.
    """
    try:
        doc, served = svc.serve_document(db, viewer, document_id)
    except svc.CoreHRError as error:
        _fail(error)

    if served.url:
        # 307 keeps the method and is not cached, which matters because the URL
        # behind it expires.
        return RedirectResponse(served.url, status_code=status.HTTP_307_TEMPORARY_REDIRECT)
    return FileResponse(
        served.path,
        media_type=doc.content_type or "application/octet-stream",
        filename=doc.file_name or None,
    )


@router.post("/documents/{document_id}/verify", response_model=EmployeeDocumentOut)
def verify_document(
    document_id: uuid.UUID,
    payload: DocumentVerifyIn,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
) -> EmployeeDocumentOut:
    try:
        return svc.verify_document(db, viewer, document_id, payload, request=request)
    except svc.CoreHRError as error:
        _fail(error)


@router.delete("/documents/{document_id}", status_code=status.HTTP_204_NO_CONTENT,
               response_model=None)
def delete_document(
    document_id: uuid.UUID, viewer: CurrentUser, request: Request, db: DbSession
) -> Response:
    try:
        svc.delete_document(db, viewer, document_id, request=request)
    except svc.CoreHRError as error:
        _fail(error)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
