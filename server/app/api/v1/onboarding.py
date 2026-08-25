"""Onboarding: checklist templates, per-hire instances, tasks and documents.

Thin by design — every handler resolves permission and hands off to
``app.services.onboarding``. The template-versus-instance rule that is the
whole point of this module lives entirely in the service, because it must hold
for the hook that user creation calls as much as for these endpoints.

**Two audiences, split at the URL.** ``/onboarding/templates`` and
``/onboarding/instances`` are HR's, gated on ``can_manage_onboarding`` via
``deny_unless``; the gate covers the *reads* as well as the writes, because a
hire's document checklist and their joining date are the same data the flag
exists to withhold and a read-only leak of it is still a leak.
``/onboarding/my`` is the new hire's own checklist and is gated on nothing but
being logged in. ``deny_unless`` only ever restricts (see the note on the
columns in ``app.models.user``), so nothing here can grant anybody anything.

**The document endpoints follow the screenshot endpoints exactly.**
``storage_key`` is never in a response body. A client gets
``GET /onboarding/documents/{id}/file``, which re-runs the permission check on
every request and then either streams the bytes or 307s to a short-lived
presigned URL, the same shape ``admin.py`` already serves images with. Handing
a client the key instead would hand it a capability it can replay, and one
whose neighbours it can enumerate.
"""

from __future__ import annotations

import json
import uuid

from fastapi import (
    APIRouter,
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

from app.api.deps import AdminUser, CurrentUser, DbSession, deny_unless
from app.schemas.onboarding import (
    INSTANCE_STATUS_PATTERN,
    OnboardingDocumentIn,
    OnboardingDocumentOut,
    OnboardingDocumentVerifyIn,
    OnboardingInstanceDetailOut,
    OnboardingInstanceIn,
    OnboardingInstanceOut,
    OnboardingInstanceUpdateIn,
    OnboardingTaskIn,
    OnboardingTaskOut,
    OnboardingTaskStatusIn,
    OnboardingTemplateDetailOut,
    OnboardingTemplateIn,
    OnboardingTemplateOut,
)
from app.services import onboarding as svc

router = APIRouter(prefix="/onboarding", tags=["onboarding"])

_MANAGE = svc.MANAGE


# --------------------------------------------------------------------------- #
# Employee-facing
#
# Declared before any "/{...}" path. FastAPI matches routes in declaration
# order, so a literal segment registered after a UUID path parameter is
# unreachable — "my" would be parsed as an instance id and 422 before this
# handler was ever considered. Same reason assets.py puts /assets/my first.
# --------------------------------------------------------------------------- #


@router.get("/my", response_model=OnboardingInstanceDetailOut | None)
def my_onboarding(viewer: CurrentUser, db: DbSession) -> OnboardingInstanceDetailOut | None:
    """The caller's own live checklist, or ``null`` if they have none.

    ``null`` rather than a 404: "you are not being onboarded" is the ordinary
    state for almost everybody in the company, and a page that has to treat the
    normal case as an error renders an error for the normal case.
    """
    return svc.my_instance(db, viewer.org_id, viewer.id)


# --------------------------------------------------------------------------- #
# Templates
# --------------------------------------------------------------------------- #


@router.get("/templates", response_model=list[OnboardingTemplateOut])
def list_templates(
    admin: AdminUser,
    db: DbSession,
    include_inactive: bool = Query(default=True),
) -> list[OnboardingTemplateOut]:
    deny_unless(admin, "can_manage_onboarding", _MANAGE)
    return svc.list_templates(db, admin.org_id, include_inactive=include_inactive)


@router.post(
    "/templates",
    response_model=OnboardingTemplateDetailOut,
    status_code=status.HTTP_201_CREATED,
)
def create_template(
    payload: OnboardingTemplateIn, admin: AdminUser, db: DbSession, request: Request
) -> OnboardingTemplateDetailOut:
    deny_unless(admin, "can_manage_onboarding", _MANAGE)
    return svc.create_template(db, admin.org_id, payload, actor=admin, request=request)


@router.get("/templates/{template_id}", response_model=OnboardingTemplateDetailOut)
def get_template(
    template_id: uuid.UUID, admin: AdminUser, db: DbSession
) -> OnboardingTemplateDetailOut:
    deny_unless(admin, "can_manage_onboarding", _MANAGE)
    return svc.template_detail(db, admin.org_id, template_id)


@router.put("/templates/{template_id}", response_model=OnboardingTemplateDetailOut)
def update_template(
    template_id: uuid.UUID,
    payload: OnboardingTemplateIn,
    admin: AdminUser,
    db: DbSession,
    request: Request,
) -> OnboardingTemplateDetailOut:
    """PUT, not PATCH: the body is the template's whole new state.

    ``tasks`` is the one exception and it is explicit — omitting the key means
    "leave the checklist alone", sending an empty list means "no tasks". A
    template with sixteen rows must not lose them because the list screen
    toggled ``is_active``.
    """
    deny_unless(admin, "can_manage_onboarding", _MANAGE)
    return svc.update_template(
        db, admin.org_id, template_id, payload, actor=admin, request=request
    )


@router.delete(
    "/templates/{template_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None
)
def delete_template(
    template_id: uuid.UUID, admin: AdminUser, db: DbSession, request: Request
) -> None:
    deny_unless(admin, "can_manage_onboarding", _MANAGE)
    svc.delete_template(db, admin.org_id, template_id, actor=admin, request=request)


# --------------------------------------------------------------------------- #
# Instances — the HR pipeline
# --------------------------------------------------------------------------- #


@router.get("/instances", response_model=list[OnboardingInstanceOut])
def list_instances(
    admin: AdminUser,
    db: DbSession,
    status_filter: str | None = Query(
        default=None, alias="status", pattern=INSTANCE_STATUS_PATTERN
    ),
    user_id: uuid.UUID | None = None,
    include_closed: bool = Query(default=False),
) -> list[OnboardingInstanceOut]:
    # Aliased because `status` is also the FastAPI status-code module imported
    # above; same shape projects.py and assets.py use for the same collision.
    deny_unless(admin, "can_manage_onboarding", _MANAGE)
    return svc.list_instances(
        db,
        admin.org_id,
        status_filter=status_filter,
        user_id=user_id,
        include_closed=include_closed,
    )


@router.post(
    "/instances",
    response_model=OnboardingInstanceDetailOut,
    status_code=status.HTTP_201_CREATED,
)
def create_instance(
    payload: OnboardingInstanceIn, admin: AdminUser, db: DbSession, request: Request
) -> OnboardingInstanceDetailOut:
    """Start a checklist for a hire. Explicit, and unguarded on the date.

    This is the door that exists so HR can start onboarding for somebody
    imported last week. The conditional door — the one a user-creation path
    calls, which declines for historical joining dates — is
    ``services.onboarding.maybe_start_for_new_hire`` and is not exposed here.
    """
    deny_unless(admin, "can_manage_onboarding", _MANAGE)
    return svc.create_instance(db, admin.org_id, payload, actor=admin, request=request)


@router.get("/instances/{instance_id}", response_model=OnboardingInstanceDetailOut)
def get_instance(
    instance_id: uuid.UUID, viewer: CurrentUser, db: DbSession
) -> OnboardingInstanceDetailOut:
    """One hire's full checklist.

    ``CurrentUser`` rather than ``AdminUser`` because the hire reads their own
    checklist through this path too; the service decides which of the two the
    caller is and applies the flag only to the administrator route.
    """
    instance = svc.get_instance(db, viewer.org_id, instance_id)
    svc.authorize_instance_read(db, instance, viewer)
    return svc.instance_detail(db, viewer.org_id, instance_id)


@router.patch("/instances/{instance_id}", response_model=OnboardingInstanceDetailOut)
def update_instance(
    instance_id: uuid.UUID,
    payload: OnboardingInstanceUpdateIn,
    admin: AdminUser,
    db: DbSession,
    request: Request,
) -> OnboardingInstanceDetailOut:
    deny_unless(admin, "can_manage_onboarding", _MANAGE)
    return svc.update_instance(
        db, admin.org_id, instance_id, payload, actor=admin, request=request
    )


# --------------------------------------------------------------------------- #
# Tasks
# --------------------------------------------------------------------------- #


@router.post(
    "/instances/{instance_id}/tasks",
    response_model=OnboardingTaskOut,
    status_code=status.HTTP_201_CREATED,
)
def add_task(
    instance_id: uuid.UUID,
    payload: OnboardingTaskIn,
    admin: AdminUser,
    db: DbSession,
    request: Request,
) -> OnboardingTaskOut:
    deny_unless(admin, "can_manage_onboarding", _MANAGE)
    return svc.add_task(db, admin.org_id, instance_id, payload, actor=admin, request=request)


@router.put("/tasks/{task_id}", response_model=OnboardingTaskOut)
def update_task(
    task_id: uuid.UUID,
    payload: OnboardingTaskIn,
    admin: AdminUser,
    db: DbSession,
    request: Request,
) -> OnboardingTaskOut:
    """HR only. Rewriting the task is not the same authority as completing it."""
    deny_unless(admin, "can_manage_onboarding", _MANAGE)
    return svc.update_task(db, admin.org_id, task_id, payload, actor=admin, request=request)


@router.post("/tasks/{task_id}/status", response_model=OnboardingTaskOut)
def set_task_status(
    task_id: uuid.UUID,
    payload: OnboardingTaskStatusIn,
    viewer: CurrentUser,
    db: DbSession,
    request: Request,
) -> OnboardingTaskOut:
    """Tick a task off. HR, the named assignee, or the hire's own items.

    The plan's exit criterion for this phase is that HR *and* the new hire can
    check items off, so this cannot be an admin-only endpoint. The three ways
    in are resolved in ``authorize_task_action``.
    """
    task = svc.get_task(db, viewer.org_id, task_id)
    svc.authorize_task_action(db, task, viewer)
    return svc.set_task_status(db, viewer.org_id, task_id, payload, actor=viewer, request=request)


@router.delete("/tasks/{task_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_task(
    task_id: uuid.UUID, admin: AdminUser, db: DbSession, request: Request
) -> None:
    deny_unless(admin, "can_manage_onboarding", _MANAGE)
    svc.delete_task(db, admin.org_id, task_id, actor=admin, request=request)


# --------------------------------------------------------------------------- #
# Documents
# --------------------------------------------------------------------------- #


@router.post(
    "/instances/{instance_id}/documents",
    response_model=OnboardingDocumentOut,
    status_code=status.HTTP_201_CREATED,
)
async def upload_document(
    instance_id: uuid.UUID,
    viewer: CurrentUser,
    db: DbSession,
    request: Request,
    meta: str = Form(..., description="JSON-encoded OnboardingDocumentIn"),
    file: UploadFile = File(...),
) -> OnboardingDocumentOut:
    """Multipart: JSON metadata in ``meta``, the file in ``file``.

    Same shape the agent's screenshot upload uses — a JSON blob in a form field
    rather than one form field per attribute — so the request is validated by a
    Pydantic model instead of by hand, and adding a field later does not change
    the wire format.

    ``CurrentUser``, not ``AdminUser``: uploading your own PAN card is the
    single most common thing that happens on a checklist, and it is the hire
    who does it. The service's read check decides whose instance this is.
    """
    instance = svc.get_instance(db, viewer.org_id, instance_id)
    svc.authorize_instance_read(db, instance, viewer)
    try:
        parsed = OnboardingDocumentIn.model_validate_json(meta)
    except (ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, f"bad meta: {exc}"
        ) from exc

    # Read one byte past the ceiling so an oversize upload is refused on its
    # size rather than after the whole thing is buffered.
    raw = await file.read(svc.MAX_DOCUMENT_BYTES + 1)
    return svc.upload_document(
        db,
        viewer.org_id,
        instance_id,
        doc_type=parsed.doc_type,
        task_id=parsed.task_id,
        file_name=file.filename or "",
        content_type=file.content_type or "",
        raw=raw,
        actor=viewer,
        request=request,
    )


@router.get("/documents/{document_id}/file", response_model=None)
def download_document(
    document_id: uuid.UUID, viewer: CurrentUser, db: DbSession
) -> Response:
    """The only way to read a stored document.

    The permission check runs here, on every request, which is what a
    ``storage_key`` in a response body would have thrown away. A local
    deployment streams the bytes; an object-storage one redirects to a
    presigned URL minted *after* this check and valid for minutes — the same
    split, for the same reason, as ``admin.py``'s screenshot endpoint.
    """
    doc = svc.get_document(db, viewer.org_id, document_id)
    instance = svc.get_instance(db, viewer.org_id, doc.instance_id)
    svc.authorize_instance_read(db, instance, viewer)

    doc, served = svc.serve_document(db, viewer.org_id, document_id)
    media_type = doc.content_type or "application/octet-stream"
    if served.url:
        # 307 keeps the method and avoids the redirect being cached, which
        # matters because the URL behind it expires.
        return RedirectResponse(served.url, status_code=status.HTTP_307_TEMPORARY_REDIRECT)
    return FileResponse(served.path, media_type=media_type, filename=doc.file_name or None)


@router.post("/documents/{document_id}/verify", response_model=OnboardingDocumentOut)
def verify_document(
    document_id: uuid.UUID,
    payload: OnboardingDocumentVerifyIn,
    admin: AdminUser,
    db: DbSession,
    request: Request,
) -> OnboardingDocumentOut:
    """HR only, unlike upload and download.

    The hire supplies the document; somebody other than the hire has to say it
    is genuine, or the verification asserts nothing at all.
    """
    deny_unless(admin, "can_manage_onboarding", _MANAGE)
    return svc.verify_document(
        db, admin.org_id, document_id, payload, actor=admin, request=request
    )


@router.delete(
    "/documents/{document_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None
)
def delete_document(
    document_id: uuid.UUID, admin: AdminUser, db: DbSession, request: Request
) -> None:
    deny_unless(admin, "can_manage_onboarding", _MANAGE)
    svc.delete_document(db, admin.org_id, document_id, actor=admin, request=request)
