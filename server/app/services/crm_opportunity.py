"""CRM opportunities: create and edit a deal on a lead, and its two attachments.

Reads are scoped like the lead they belong to: anybody who may open the lead
may see its opportunities, and anybody who may open it may add one. There is no
separate permission, because an opportunity is a part of how a lead is worked,
not a new kind of record somebody else needs to be protected from.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal

from fastapi import HTTPException, Request
from fastapi import status as http_status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api.deps import audit
from app.models import (
    CrmCustomer,
    CrmItemCompany,
    CrmLead,
    CrmOpportunity,
    CrmRequirementType,
    Team,
    User,
)
from app.schemas import crm_opportunity as S
from app.services import crm as crm_svc
from app.services import storage

#: Two attachments per opportunity, and what each is called on the wire.
ATTACHMENTS = ("costsheet", "quotation")

#: A costsheet is a spreadsheet and a quotation a PDF; neither is a photograph.
MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024

_SAFE_SUFFIX = re.compile(r"^\.[A-Za-z0-9]{1,8}$")
_CENT = Decimal("0.01")


def _refuse(message: str, reason: str = "invalid", code: int = 422) -> HTTPException:
    return HTTPException(code, detail={"reason": reason, "message": message})


def _suffix_for(file_name: str) -> str:
    suffix = ("." + file_name.rsplit(".", 1)[-1]) if "." in file_name else ""
    return suffix if _SAFE_SUFFIX.match(suffix) else ""


def _check_references(db: Session, org_id: uuid.UUID, payload: S.OpportunityIn) -> None:
    """Every id on the form must be this workspace's — an id from another
    tenant is a lookup that happens to succeed, not a typo."""
    for model, value, label in (
        (CrmRequirementType, payload.requirement_type_id, "requirement type"),
        (CrmItemCompany, payload.oem_id, "OEM"),
        (Team, payload.team_id, "sales team"),
        (CrmCustomer, payload.customer_id, "customer"),
    ):
        if value is None:
            continue
        row = db.get(model, value)
        if row is None or row.org_id != org_id:
            raise _refuse(f"Choose a valid {label}.")


def _margin(revenue: Decimal, raw_cost: Decimal | None) -> tuple[Decimal | None, Decimal | None]:
    if raw_cost is None:
        return None, None
    margin = (revenue - raw_cost).quantize(_CENT, ROUND_HALF_UP)
    if revenue <= 0:
        return margin, None
    return margin, (margin / revenue * 100).quantize(_CENT, ROUND_HALF_UP)


def _attachment(row: CrmOpportunity, which: str) -> S.AttachmentOut | None:
    if not getattr(row, f"{which}_key"):
        return None
    return S.AttachmentOut(
        name=getattr(row, f"{which}_name") or which, size=getattr(row, f"{which}_size")
    )


def to_out(db: Session, row: CrmOpportunity) -> S.OpportunityOut:
    requirement = db.get(CrmRequirementType, row.requirement_type_id) if row.requirement_type_id else None
    oem = db.get(CrmItemCompany, row.oem_id) if row.oem_id else None
    team = db.get(Team, row.team_id) if row.team_id else None
    customer = db.get(CrmCustomer, row.customer_id) if row.customer_id else None
    lead = db.get(CrmLead, row.lead_id)
    owner = db.get(User, lead.owner_id) if lead and lead.owner_id else None
    margin, margin_percent = _margin(row.expected_revenue, row.raw_cost)
    return S.OpportunityOut(
        id=row.id,
        lead_id=row.lead_id,
        lead_code=lead.code if lead else None,
        lead_name=lead.name if lead else None,
        title=row.title,
        customer_id=row.customer_id,
        customer_name=customer.name if customer else None,
        expected_revenue=row.expected_revenue,
        probability=row.probability,
        expected_closing=row.expected_closing,
        priority=row.priority,
        tags=list(row.tags or []),
        requirement_type_id=row.requirement_type_id,
        requirement_type_name=requirement.name if requirement else None,
        oem_id=row.oem_id,
        oem_name=oem.name if oem else None,
        raw_cost=row.raw_cost,
        margin=margin,
        margin_percent=margin_percent,
        team_id=row.team_id,
        team_name=team.name if team else None,
        is_mail_send=row.is_mail_send,
        costsheet_status=row.costsheet_status,
        notes=row.notes,
        owner_id=lead.owner_id if lead else None,
        owner_name=owner.full_name if owner else None,
        costsheet=_attachment(row, "costsheet"),
        quotation=_attachment(row, "quotation"),
        created_at=row.created_at,
    )


def _get(db: Session, viewer: User, opportunity_id: uuid.UUID) -> CrmOpportunity:
    row = db.get(CrmOpportunity, opportunity_id)
    if row is None or row.org_id != viewer.org_id:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Opportunity not found")
    # Reading the lead applies the same ownership scope the lead itself has.
    crm_svc._readable_lead(db, viewer, row.lead_id)
    return row


def list_for_lead(db: Session, viewer: User, lead_id: uuid.UUID) -> list[S.OpportunityOut]:
    crm_svc._readable_lead(db, viewer, lead_id)
    rows = db.scalars(
        select(CrmOpportunity)
        .where(CrmOpportunity.org_id == viewer.org_id, CrmOpportunity.lead_id == lead_id)
        .order_by(CrmOpportunity.created_at.desc())
    ).all()
    return [to_out(db, row) for row in rows]


def list_all(
    db: Session, viewer: User, *, costsheet_status: str | None = None, limit: int = 500
) -> list[S.OpportunityOut]:
    """Opportunities across every lead the viewer may see, newest first.

    Scoped the way a lead is: somebody who sees only their own pipeline sees
    only the opportunities on it. A lead nobody owns is readable by all, as
    ``_readable_lead`` has it.
    """
    query = (
        select(CrmOpportunity)
        .join(CrmLead, CrmLead.id == CrmOpportunity.lead_id)
        .where(CrmOpportunity.org_id == viewer.org_id)
    )
    scope = crm_svc.visible_owner_ids(db, viewer)
    if scope is not None:
        query = query.where(or_(CrmLead.owner_id.is_(None), CrmLead.owner_id.in_(scope)))
    if costsheet_status == "requested":
        # Anything that was sent: waiting, approved or rejected.
        query = query.where(CrmOpportunity.costsheet_status != "none")
    elif costsheet_status is not None:
        query = query.where(CrmOpportunity.costsheet_status == costsheet_status)
    rows = db.scalars(query.order_by(CrmOpportunity.created_at.desc()).limit(limit)).all()
    return [to_out(db, row) for row in rows]


def _apply(row: CrmOpportunity, payload: S.OpportunityIn) -> None:
    row.title = payload.title
    row.customer_id = payload.customer_id
    row.expected_revenue = payload.expected_revenue
    row.probability = payload.probability
    row.expected_closing = payload.expected_closing
    row.priority = payload.priority
    row.tags = payload.tags
    row.requirement_type_id = payload.requirement_type_id
    row.oem_id = payload.oem_id
    row.raw_cost = payload.raw_cost
    row.team_id = payload.team_id
    row.is_mail_send = payload.is_mail_send
    # The form only sends it or withdraws it. A decision already made stands
    # while the box stays ticked; unticking is the way to take it back.
    if payload.send_costsheet_for_approval:
        # None on a row that has not been flushed yet: the column default only
        # applies at insert, and a new opportunity is exactly when this is ticked.
        if row.costsheet_status in (None, "none"):
            row.costsheet_status = "pending"
    else:
        row.costsheet_status = "none"
    row.notes = payload.notes


def create(
    db: Session,
    viewer: User,
    lead_id: uuid.UUID,
    payload: S.OpportunityIn,
    *,
    request: Request | None = None,
) -> S.OpportunityOut:
    lead = crm_svc._readable_lead(db, viewer, lead_id)
    _check_references(db, viewer.org_id, payload)
    row = CrmOpportunity(org_id=viewer.org_id, lead_id=lead.id, created_by=viewer.id)
    _apply(row, payload)
    db.add(row)
    db.flush()
    crm_svc._log(db, lead, viewer, "note", f"Opportunity created: {row.title}")
    audit(db, org_id=viewer.org_id, actor=viewer, action="crm.opportunity_created",
          request=request, target_type="crm_opportunity", target_id=str(row.id),
          detail={"lead_id": str(lead.id)})
    db.commit()
    db.refresh(row)
    return to_out(db, row)


def update(
    db: Session,
    viewer: User,
    opportunity_id: uuid.UUID,
    payload: S.OpportunityIn,
    *,
    request: Request | None = None,
) -> S.OpportunityOut:
    row = _get(db, viewer, opportunity_id)
    _check_references(db, viewer.org_id, payload)
    _apply(row, payload)
    audit(db, org_id=viewer.org_id, actor=viewer, action="crm.opportunity_updated",
          request=request, target_type="crm_opportunity", target_id=str(row.id))
    db.commit()
    db.refresh(row)
    return to_out(db, row)


def decide_costsheet(
    db: Session,
    viewer: User,
    opportunity_id: uuid.UUID,
    decision: str,
    *,
    request: Request | None = None,
) -> S.OpportunityOut:
    """Approve or reject a costsheet that was sent for approval.

    Not for everybody who can edit the opportunity: a salesperson who could
    approve their own costsheet would make the approval a tick box with extra
    steps. It takes someone who sees other people's work — a manager or an
    administrator, the same people the approvals tab is shown to.
    """
    if not viewer.sees_others:
        raise _refuse(
            "Only a manager or administrator can approve or reject a costsheet.",
            "permission_denied",
            403,
        )
    row = _get(db, viewer, opportunity_id)
    if row.costsheet_status == "none":
        raise _refuse("This costsheet has not been sent for approval.", "not_requested", 409)
    if not row.costsheet_key:
        raise _refuse("Attach the costsheet file before it is approved or rejected.", "no_file", 409)
    previous = row.costsheet_status
    row.costsheet_status = decision
    audit(db, org_id=viewer.org_id, actor=viewer, action=f"crm.costsheet_{decision}",
          request=request, target_type="crm_opportunity", target_id=str(row.id),
          detail={"lead_id": str(row.lead_id), "from": previous})
    db.commit()
    db.refresh(row)
    return to_out(db, row)


def delete(
    db: Session, viewer: User, opportunity_id: uuid.UUID, *, request: Request | None = None
) -> None:
    row = _get(db, viewer, opportunity_id)
    keys = [getattr(row, f"{which}_key") for which in ATTACHMENTS]
    audit(db, org_id=viewer.org_id, actor=viewer, action="crm.opportunity_deleted",
          request=request, target_type="crm_opportunity", target_id=str(row.id),
          detail={"lead_id": str(row.lead_id), "title": row.title})
    db.delete(row)
    db.commit()
    # After the commit, so a failed delete does not orphan a row that still
    # points at a file that is gone.
    for key in keys:
        storage.delete(key)


# --------------------------------------------------------------------------- #
# Attachments
# --------------------------------------------------------------------------- #


def _check_which(which: str) -> None:
    if which not in ATTACHMENTS:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "No such attachment")


def attach(
    db: Session,
    viewer: User,
    opportunity_id: uuid.UUID,
    which: str,
    *,
    file_name: str,
    content_type: str,
    raw: bytes,
    request: Request | None = None,
) -> S.OpportunityOut:
    """Store the costsheet or quotation, replacing any earlier one."""
    _check_which(which)
    row = _get(db, viewer, opportunity_id)
    if not raw:
        raise _refuse("The file is empty.", "empty_upload")
    if len(raw) > MAX_ATTACHMENT_BYTES:
        raise _refuse(
            f"Files are limited to {MAX_ATTACHMENT_BYTES // (1024 * 1024)} MB.", "too_large", 413
        )
    previous = getattr(row, f"{which}_key")
    key = storage.build_key(
        viewer.org_id, viewer.id, datetime.now(timezone.utc), uuid.uuid4(),
        suffix=_suffix_for(file_name),
    )
    try:
        size = storage.backend().put(key, raw, content_type or "application/octet-stream")
    except storage.StorageError as exc:
        raise _refuse(f"Could not store the file: {exc}", "storage_failed", 503) from exc
    setattr(row, f"{which}_key", key)
    setattr(row, f"{which}_name", (file_name or "")[:255] or which)
    setattr(row, f"{which}_type", (content_type or "")[:120] or None)
    setattr(row, f"{which}_size", size)
    audit(db, org_id=viewer.org_id, actor=viewer, action=f"crm.opportunity_{which}_attached",
          request=request, target_type="crm_opportunity", target_id=str(row.id))
    db.commit()
    db.refresh(row)
    if previous and previous != key:
        storage.delete(previous)
    return to_out(db, row)


def clear_attachment(
    db: Session, viewer: User, opportunity_id: uuid.UUID, which: str,
    *, request: Request | None = None,
) -> S.OpportunityOut:
    _check_which(which)
    row = _get(db, viewer, opportunity_id)
    previous = getattr(row, f"{which}_key")
    for suffix in ("key", "name", "type", "size"):
        setattr(row, f"{which}_{suffix}", None)
    audit(db, org_id=viewer.org_id, actor=viewer, action=f"crm.opportunity_{which}_removed",
          request=request, target_type="crm_opportunity", target_id=str(row.id))
    db.commit()
    db.refresh(row)
    storage.delete(previous)
    return to_out(db, row)


def serve_attachment(db: Session, viewer: User, opportunity_id: uuid.UUID, which: str):
    """The file itself, behind the same check as the opportunity."""
    _check_which(which)
    row = _get(db, viewer, opportunity_id)
    key = getattr(row, f"{which}_key")
    if not key:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Nothing attached")
    try:
        return row, storage.serve(key)
    except (FileNotFoundError, storage.StorageError):
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "The stored file is missing") from None
