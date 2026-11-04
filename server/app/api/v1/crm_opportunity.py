"""CRM opportunity routes. Mounted under ``/crm`` beside the main CRM router."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, File, Query, Request, Response, UploadFile, status
from fastapi.responses import FileResponse, RedirectResponse

from app.api.deps import CurrentUser, DbSession
from app.schemas import crm_opportunity as S
from app.services import crm_opportunity as svc

router = APIRouter(prefix="/crm", tags=["crm"])


@router.get("/opportunities", response_model=list[S.OpportunityOut])
def list_all_opportunities(
    viewer: CurrentUser,
    db: DbSession,
    costsheet_status: str | None = Query(
        default=None, pattern=r"^(requested|pending|approved|rejected)$"
    ),
) -> list[S.OpportunityOut]:
    """Every opportunity this person may see. ``costsheet_status=requested`` is
    the approvals table on the Employee screen: everything sent for a decision."""
    return svc.list_all(db, viewer, costsheet_status=costsheet_status)


@router.post("/opportunities/{opportunity_id}/costsheet-decision", response_model=S.OpportunityOut)
def decide_costsheet(
    opportunity_id: uuid.UUID,
    payload: S.CostsheetDecisionIn,
    viewer: CurrentUser,
    db: DbSession,
    request: Request,
) -> S.OpportunityOut:
    return svc.decide_costsheet(db, viewer, opportunity_id, payload.decision, request=request)


@router.get("/leads/{lead_id}/opportunities", response_model=list[S.OpportunityOut])
def list_opportunities(
    lead_id: uuid.UUID, viewer: CurrentUser, db: DbSession
) -> list[S.OpportunityOut]:
    return svc.list_for_lead(db, viewer, lead_id)


@router.post(
    "/leads/{lead_id}/opportunities",
    response_model=S.OpportunityOut,
    status_code=status.HTTP_201_CREATED,
)
def create_opportunity(
    lead_id: uuid.UUID,
    payload: S.OpportunityIn,
    viewer: CurrentUser,
    db: DbSession,
    request: Request,
) -> S.OpportunityOut:
    return svc.create(db, viewer, lead_id, payload, request=request)


@router.put("/opportunities/{opportunity_id}", response_model=S.OpportunityOut)
def update_opportunity(
    opportunity_id: uuid.UUID,
    payload: S.OpportunityIn,
    viewer: CurrentUser,
    db: DbSession,
    request: Request,
) -> S.OpportunityOut:
    return svc.update(db, viewer, opportunity_id, payload, request=request)


@router.delete(
    "/opportunities/{opportunity_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
def delete_opportunity(
    opportunity_id: uuid.UUID, viewer: CurrentUser, db: DbSession, request: Request
) -> None:
    svc.delete(db, viewer, opportunity_id, request=request)


@router.post("/opportunities/{opportunity_id}/files/{which}", response_model=S.OpportunityOut)
async def upload_opportunity_file(
    opportunity_id: uuid.UUID,
    which: str,
    viewer: CurrentUser,
    db: DbSession,
    request: Request,
    file: UploadFile = File(...),
) -> S.OpportunityOut:
    # One byte past the ceiling, so an oversize upload is refused on its size
    # rather than after the whole thing is buffered.
    raw = await file.read(svc.MAX_ATTACHMENT_BYTES + 1)
    return svc.attach(
        db, viewer, opportunity_id, which,
        file_name=file.filename or "", content_type=file.content_type or "",
        raw=raw, request=request,
    )


@router.delete("/opportunities/{opportunity_id}/files/{which}", response_model=S.OpportunityOut)
def remove_opportunity_file(
    opportunity_id: uuid.UUID, which: str, viewer: CurrentUser, db: DbSession, request: Request
) -> S.OpportunityOut:
    return svc.clear_attachment(db, viewer, opportunity_id, which, request=request)


@router.get("/opportunities/{opportunity_id}/files/{which}", response_model=None)
def download_opportunity_file(
    opportunity_id: uuid.UUID, which: str, viewer: CurrentUser, db: DbSession
) -> Response:
    """The only way to read a stored file: the permission check runs on every
    request, which a storage key in a response body would have skipped."""
    row, served = svc.serve_attachment(db, viewer, opportunity_id, which)
    if served.url:
        return RedirectResponse(served.url, status_code=status.HTTP_307_TEMPORARY_REDIRECT)
    return FileResponse(
        served.path,
        media_type=getattr(row, f"{which}_type") or "application/octet-stream",
        filename=getattr(row, f"{which}_name") or None,
    )
