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
    CrmLeadStatus,
    CrmItemCompany,
    CrmLead,
    CrmOpportunity,
    CrmRequirementType,
    Team,
    User,
)
from app.models.crm import StatusBehaviour
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
        stage=row.stage,
        lost_reason=row.lost_reason,
        costsheet_status=row.costsheet_status,
        notes=row.notes,
        owner_id=lead.owner_id if lead else None,
        owner_name=owner.full_name if owner else None,
        costsheet=_attachment(row, "costsheet"),
        quotation=_attachment(row, "quotation"),
        created_at=row.created_at,
    )


APPROVALS_MENU = "/approvals"


def costsheet_grant(viewer: User) -> bool | None:
    """What Roles & Permission says about the Costsheet tab of Approvals.

    ``True`` / ``False`` when the person's role has Approvals and ticks (or unticks) that
    tab, ``None`` when it does not say (an unrestricted role, no Approvals, or a role saved
    before tabs existed) - in which case the older rule applies: managers and
    administrators approve.
    """
    role = viewer.org_role
    if viewer.role_enum.value == "owner":
        return None
    if role is None or role.menu_rights is None:
        return None
    row = role.menu_rights.get(APPROVALS_MENU)
    if row is None or not row.get("access") or "tab_costsheet" not in row:
        return None
    return bool(row["tab_costsheet"])


def may_approve_costsheets(viewer: User) -> bool:
    grant = costsheet_grant(viewer)
    return viewer.sees_others if grant is None else grant


def _get(db: Session, viewer: User, opportunity_id: uuid.UUID, *, as_approver: bool = False) -> CrmOpportunity:
    row = db.get(CrmOpportunity, opportunity_id)
    if row is None or row.org_id != viewer.org_id:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Opportunity not found")
    # A person the role names as a costsheet approver decides every costsheet, not
    # only those on leads they own; anyone else is held to the lead's own scope.
    if as_approver and costsheet_grant(viewer) is True:
        return row
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
    if costsheet_status == "requested":
        grant = costsheet_grant(viewer)
        if grant is False:
            raise _refuse("Your role does not include the Costsheet tab of Approvals.", "permission_denied", 403)
        if grant is True:
            scope = None  # an approver the role names sees the whole queue
    if scope is not None:
        query = query.where(or_(CrmLead.owner_id.is_(None), CrmLead.owner_id.in_(scope)))
    if costsheet_status == "requested":
        # Anything that was sent: waiting, approved or rejected.
        query = query.where(CrmOpportunity.costsheet_status != "none")
    elif costsheet_status is not None:
        query = query.where(CrmOpportunity.costsheet_status == costsheet_status)
    rows = db.scalars(query.order_by(CrmOpportunity.created_at.desc()).limit(limit)).all()
    return [to_out(db, row) for row in rows]


#: What each stage means for the chance of winning. Moving a deal sets it, so
#: the column totals can be read as a forecast; a figure typed by hand holds
#: until the next move.
STAGE_PROBABILITY = {"qualified": 10, "proposal": 40, "commit": 80, "won": 100, "lost": 0}


def _transition(row: CrmOpportunity, stage: str, reason: str | None) -> bool:
    """Put the opportunity in a stage. Returns whether the stage changed."""
    reason = (reason or "").strip() or None
    if stage == row.stage:
        if stage == "lost" and reason:
            row.lost_reason = reason
        return False
    if stage == "lost" and not reason:
        raise _refuse("Say why this deal was lost.", "lost_reason_required", 422)
    row.lost_reason = reason if stage == "lost" else None
    row.stage = stage
    row.probability = STAGE_PROBABILITY[stage]
    return True


def _sync_lead(db: Session, viewer: User, row: CrmOpportunity) -> None:
    """Won and Lost close the lead as well; leaving them reopens it.

    Without this the board and the lead disagree: a deal in Won on a lead still
    shown as open. Reopening goes to the first in-progress stage the workspace has.
    """
    lead = db.get(CrmLead, row.lead_id)
    if lead is None:
        return
    current = lead.status.behaviour if lead.status else None
    wanted = {"won": StatusBehaviour.WON.value, "lost": StatusBehaviour.LOST.value}.get(row.stage)
    if wanted is not None:
        if current == wanted:
            if wanted == StatusBehaviour.LOST.value and row.lost_reason:
                lead.lost_reason = row.lost_reason
                db.commit()
            return
        behaviours = [wanted]
    else:
        if current not in (StatusBehaviour.WON.value, StatusBehaviour.LOST.value):
            return
        behaviours = [StatusBehaviour.IN_PROGRESS.value, StatusBehaviour.DEFAULT.value]
    for behaviour in behaviours:
        target = db.scalars(
            select(CrmLeadStatus)
            .where(
                CrmLeadStatus.org_id == row.org_id,
                CrmLeadStatus.behaviour == behaviour,
                CrmLeadStatus.is_active.is_(True),
            )
            .order_by(CrmLeadStatus.sort_order)
        ).first()
        if target is not None:
            crm_svc.move_status(
                db, viewer, lead.id,
                crm_svc.S.LeadStatusMove(
                    status_id=target.id,
                    note=row.lost_reason if wanted == StatusBehaviour.LOST.value else None,
                ),
            )
            return


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
    if payload.stage:
        if row.stage is None and payload.stage == "qualified":
            row.stage = "qualified"  # a new deal keeps the probability typed on the form
        else:
            _transition(row, payload.stage, payload.lost_reason)


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
    if db.scalar(
        select(CrmOpportunity.id).where(
            CrmOpportunity.org_id == viewer.org_id, CrmOpportunity.lead_id == lead.id
        )
    ):
        raise _refuse(
            "This lead already has an opportunity. Edit that one instead.", "already_exists", 409
        )
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
    if row.stage in ("won", "lost"):
        _sync_lead(db, viewer, row)
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
    before = row.stage
    _apply(row, payload)
    audit(db, org_id=viewer.org_id, actor=viewer, action="crm.opportunity_updated",
          request=request, target_type="crm_opportunity", target_id=str(row.id))
    db.commit()
    db.refresh(row)
    if row.stage != before:
        _sync_lead(db, viewer, row)
    return to_out(db, row)


def set_stage(
    db: Session,
    viewer: User,
    opportunity_id: uuid.UUID,
    stage: str,
    lost_reason: str | None = None,
    *,
    request: Request | None = None,
) -> S.OpportunityOut:
    """Move an opportunity along the pipeline board (or to Lost).

    The probability follows the stage, and Won / Lost close the lead with it.
    """
    row = _get(db, viewer, opportunity_id)
    previous = row.stage
    if _transition(row, stage, lost_reason):
        lead = db.get(CrmLead, row.lead_id)
        if lead is not None:
            crm_svc._log(db, lead, viewer, "note", f"Opportunity {row.title}: {previous} → {stage}")
        audit(db, org_id=viewer.org_id, actor=viewer, action="crm.opportunity_stage",
              request=request, target_type="crm_opportunity", target_id=str(row.id),
              detail={"from": previous, "to": stage, "lost_reason": row.lost_reason})
        db.commit()
        db.refresh(row)
        _sync_lead(db, viewer, row)
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
    if not may_approve_costsheets(viewer):
        raise _refuse(
            "Only someone whose role includes the Costsheet tab of Approvals, or a manager or administrator, can approve or reject a costsheet.",
            "permission_denied",
            403,
        )
    row = _get(db, viewer, opportunity_id, as_approver=True)
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
