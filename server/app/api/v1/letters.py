"""Letters: templates, drafts, issuing, revoking, and employee self-service.

Thin, like every router here. Each handler settles who is asking, calls
``app.services.letters``, and turns a ``LetterError`` into a typed response.

Two things that are genuinely this file's business.

**Self-service is separate routes, not a flag on the administrator ones.**
``GET /requestable`` and ``POST /request`` take no ``user_id`` at all: the
subject is the authenticated caller, so "request a letter about a colleague" has
no code path rather than being policed by an ``if``. The same argument
regularization makes about on-behalf filing.

**The printable letter is served as HTML from its own route.** Not embedded in
the JSON. It is the artefact — the thing somebody prints, or saves as PDF from
the browser — and serving it as a document means the permission check runs on
every fetch of it, the same reason a screenshot is never handed out as a
storage key.
"""

from __future__ import annotations

import uuid
from typing import NoReturn

from fastapi import APIRouter, HTTPException, Query, Request, Response, status

from app.api.deps import CurrentUser, DbSession
from app.models import IssuedLetter, LetterStatus, User
from app.schemas.letters import (
    DraftIn,
    IssueIn,
    LetterDraftUpdate,
    LetterOut,
    LetterRequestIn,
    MergeFieldOut,
    PreviewOut,
    RequestableTemplateOut,
    RevokeIn,
    TemplateIn,
    TemplateOut,
    TemplateUpdate,
)
from app.services import letters as svc
from app.services import lettermerge

router = APIRouter(prefix="/letters", tags=["letters"])


def _fail(error: svc.LetterError) -> NoReturn:
    raise HTTPException(
        error.status_code, detail={"reason": error.code, "message": error.message}
    )


def _names(db, org_id: uuid.UUID, rows) -> dict[uuid.UUID, str]:
    """Display names for exactly the people these rows mention."""
    wanted: set[uuid.UUID] = set()
    for row in rows:
        wanted.update(
            value
            for value in (row.user_id, row.issued_by, row.revoked_by, row.requested_by)
            if value is not None
        )
    if not wanted:
        return {}
    from sqlalchemy import select

    return {
        r[0]: r[1]
        for r in db.execute(
            select(User.id, User.full_name).where(User.org_id == org_id, User.id.in_(wanted))
        )
    }


def _out(row: IssuedLetter, names: dict[uuid.UUID, str]) -> LetterOut:
    out = LetterOut.model_validate(row)
    out.user_name = names.get(row.user_id)
    out.issued_by_name = names.get(row.issued_by)
    out.revoked_by_name = names.get(row.revoked_by)
    out.requested_by_name = names.get(row.requested_by)
    out.is_filed = row.document_id is not None
    return out


def _template_out(row) -> TemplateOut:
    out = TemplateOut.model_validate(row)
    out.unknown_fields = list(lettermerge.unknown_tokens(row.body))
    return out


# --------------------------------------------------------------------------- #
# Merge fields and templates
# --------------------------------------------------------------------------- #


@router.get("/fields", response_model=list[MergeFieldOut])
def merge_fields(viewer: CurrentUser) -> list[dict]:
    """Every token a template may use.

    Static, and served from the registry rather than hardcoded in the editor —
    a field the server cannot resolve must not be offered as a choice.
    """
    return lettermerge.as_dicts()


@router.get("/requestable", response_model=list[RequestableTemplateOut])
def requestable_templates(viewer: CurrentUser, db: DbSession):
    """Letters this employee may ask for. Names only, never bodies."""
    return svc.list_templates(db, viewer, requestable_only=True)


@router.get("/templates", response_model=list[TemplateOut])
def list_templates(
    viewer: CurrentUser, db: DbSession, active_only: bool = False
) -> list[TemplateOut]:
    try:
        svc._require_issuer(viewer)
    except svc.LetterError as error:
        _fail(error)
    return [
        _template_out(row) for row in svc.list_templates(db, viewer, active_only=active_only)
    ]


@router.post("/templates", response_model=TemplateOut, status_code=status.HTTP_201_CREATED)
def create_template(
    payload: TemplateIn, viewer: CurrentUser, request: Request, db: DbSession
) -> TemplateOut:
    try:
        return _template_out(svc.create_template(db, viewer, payload, request=request))
    except svc.LetterError as error:
        _fail(error)


@router.post("/templates/seed", response_model=list[TemplateOut])
def seed_templates(viewer: CurrentUser, request: Request, db: DbSession) -> list[TemplateOut]:
    """Add the five standard letters. Skips any name already present.

    A button rather than something the migration did: a company that already
    wrote its own templates should not find ours appearing beside them.
    """
    try:
        return [_template_out(row) for row in svc.seed_starters(db, viewer, request=request)]
    except svc.LetterError as error:
        _fail(error)


@router.patch("/templates/{template_id}", response_model=TemplateOut)
def update_template(
    template_id: uuid.UUID,
    payload: TemplateUpdate,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
) -> TemplateOut:
    try:
        return _template_out(
            svc.update_template(db, viewer, template_id, payload, request=request)
        )
    except svc.LetterError as error:
        _fail(error)


@router.delete("/templates/{template_id}", status_code=status.HTTP_204_NO_CONTENT,
               response_model=None)
def delete_template(
    template_id: uuid.UUID, viewer: CurrentUser, request: Request, db: DbSession
) -> Response:
    try:
        svc.delete_template(db, viewer, template_id, request=request)
    except svc.LetterError as error:
        _fail(error)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --------------------------------------------------------------------------- #
# Preview
# --------------------------------------------------------------------------- #


@router.get("/preview", response_model=PreviewOut)
def preview(
    viewer: CurrentUser,
    db: DbSession,
    template_id: uuid.UUID = Query(...),
    user_id: uuid.UUID = Query(...),
) -> PreviewOut:
    """What this template produces for this person. Creates nothing.

    Exists so the gaps — an empty confirmation date on a confirmation letter —
    are visible before issuing, which is the only point at which they are cheap
    to fix.
    """
    try:
        rendered = svc.preview(db, viewer, template_id=template_id, user_id=user_id)
    except svc.LetterError as error:
        _fail(error)
    return PreviewOut(
        text=rendered.text, unknown=list(rendered.unknown), empty=list(rendered.empty)
    )


# --------------------------------------------------------------------------- #
# Employee self-service
# --------------------------------------------------------------------------- #


@router.post("/request", response_model=LetterOut, status_code=status.HTTP_201_CREATED)
def request_letter(
    payload: LetterRequestIn, viewer: CurrentUser, request: Request, db: DbSession
) -> LetterOut:
    """Ask for a letter about yourself.

    Produces a draft for HR to issue, never an issued letter — a company's
    letters are not self-serve, only the asking is. No ``user_id`` anywhere on
    this path.
    """
    try:
        row = svc.request_letter(db, viewer, payload, request=request)
    except svc.LetterError as error:
        _fail(error)
    return _out(row, _names(db, viewer.org_id, [row]))


# --------------------------------------------------------------------------- #
# Letters
# --------------------------------------------------------------------------- #


@router.get("", response_model=list[LetterOut])
def list_letters(
    viewer: CurrentUser,
    db: DbSession,
    user_id: uuid.UUID | None = None,
    status_filter: str | None = Query(default=None, alias="status"),
) -> list[LetterOut]:
    """Letters this caller may see.

    An employee gets their own issued letters whatever they ask for — the filter
    narrows rather than the request being refused, because "show me my letters"
    has an obvious correct answer.
    """
    rows = svc.list_letters(db, viewer, user_id=user_id, status=status_filter)
    names = _names(db, viewer.org_id, rows)
    return [_out(row, names) for row in rows]


@router.post("", response_model=LetterOut, status_code=status.HTTP_201_CREATED)
def create_draft(
    payload: DraftIn, viewer: CurrentUser, request: Request, db: DbSession
) -> LetterOut:
    try:
        row = svc.create_draft(db, viewer, payload, request=request)
    except svc.LetterError as error:
        _fail(error)
    return _out(row, _names(db, viewer.org_id, [row]))


@router.get("/{letter_id}", response_model=LetterOut)
def read_letter(letter_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> LetterOut:
    try:
        row = svc.get_letter(db, viewer, letter_id)
    except svc.LetterError as error:
        _fail(error)
    return _out(row, _names(db, viewer.org_id, [row]))


@router.patch("/{letter_id}", response_model=LetterOut)
def update_draft(
    letter_id: uuid.UUID,
    payload: LetterDraftUpdate,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
) -> LetterOut:
    """Edit a draft. Refused once issued — the text is the record."""
    try:
        row = svc.update_draft(db, viewer, letter_id, payload, request=request)
    except svc.LetterError as error:
        _fail(error)
    return _out(row, _names(db, viewer.org_id, [row]))


@router.post("/{letter_id}/issue", response_model=LetterOut)
def issue(
    letter_id: uuid.UUID,
    payload: IssueIn,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
) -> LetterOut:
    """Allocate a reference, freeze the text, file a copy to the employee."""
    try:
        row = svc.issue(db, viewer, letter_id, payload, request=request)
    except svc.LetterError as error:
        _fail(error)
    return _out(row, _names(db, viewer.org_id, [row]))


@router.post("/{letter_id}/revoke", response_model=LetterOut)
def revoke(
    letter_id: uuid.UUID,
    payload: RevokeIn,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
) -> LetterOut:
    """Withdraw an issued letter. Nothing is deleted, including the number."""
    try:
        row = svc.revoke(db, viewer, letter_id, payload, request=request)
    except svc.LetterError as error:
        _fail(error)
    return _out(row, _names(db, viewer.org_id, [row]))


@router.get("/{letter_id}/print", response_model=None)
def print_letter(letter_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> Response:
    """The letter as a printable page.

    HTML with a print stylesheet rather than a PDF: no renderer is installed,
    and the browser's own "Save as PDF" produces the artefact people expect
    without a native dependency. Served from its own route so the permission
    check runs on every fetch.
    """
    try:
        row, html = svc.render_html(db, viewer, letter_id)
    except svc.LetterError as error:
        _fail(error)
    filename = f"{(row.reference_no or 'letter').replace('/', '-')}.html"
    return Response(
        content=html,
        media_type="text/html; charset=utf-8",
        # inline, not attachment: the common action is reading it on screen and
        # then printing, and forcing a download puts a file in the way of that.
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )
