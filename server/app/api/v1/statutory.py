"""Statutory configuration: PF, ESI, professional tax, LWF.

Thin. The arithmetic lives in ``services/statutory`` as a pure function, and
this file reads and writes the configuration it consumes.

Two things that are genuinely this file's business.

**The configuration is a PUT, not a POST-then-PATCH.** There is exactly one row
per company and it either exists or is created on first write; a create/update
pair would need the console to know which it was doing, for a screen that is one
form.

**Preview is a POST that saves nothing.** Statutory rules are the part of
payroll people check against a printed circular, so the config screen can ask
"at ₹50,000, what comes off?" and see the same function a pay run will use —
rather than finding out at month end.
"""

from __future__ import annotations

import uuid
from typing import NoReturn

from fastapi import APIRouter, HTTPException, Request, Response, status
from sqlalchemy import func, select

from app.api.deps import CurrentUser, DbSession, audit
from app.models import ProfessionalTaxSlab, StatutoryConfig
from app.schemas.statutory import (
    PreviewIn,
    PreviewLineOut,
    PreviewOut,
    SlabIn,
    SlabOut,
    StatutoryConfigIn,
    StatutoryConfigOut,
)
from app.services import payroll as payroll_svc
from app.services import statutory as svc

router = APIRouter(prefix="/statutory", tags=["payroll-statutory"])


def _fail(code: str, message: str, status_code: int = 422) -> NoReturn:
    raise HTTPException(status_code, detail={"reason": code, "message": message})


def _require_manager(viewer) -> None:
    """Same capability as salaries — see ``services/payroll.can_manage``.

    Statutory rates are not secret, but they multiply every salary in the
    company, and somebody who may not see a salary has no reason to change what
    is deducted from one.
    """
    if not payroll_svc.can_manage(viewer):
        _fail("not_permitted", "You may not manage payroll.", 403)


def _config_out(db, row: StatutoryConfig) -> StatutoryConfigOut:
    out = StatutoryConfigOut.model_validate(row)
    out.pt_slab_count = int(
        db.scalar(
            select(func.count(ProfessionalTaxSlab.id)).where(
                ProfessionalTaxSlab.org_id == row.org_id
            )
        ) or 0
    )
    return out


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #


@router.get("/config", response_model=StatutoryConfigOut | None)
def read_config(viewer: CurrentUser, db: DbSession) -> StatutoryConfigOut | None:
    """The company's configuration, or null if it has never been set.

    Null rather than a default-filled object: "we have not configured this" and
    "we configured it and it happens to match the defaults" are different
    states, and the screen says something different for each.
    """
    _require_manager(viewer)
    row = db.scalar(
        select(StatutoryConfig).where(StatutoryConfig.org_id == viewer.org_id)
    )
    return _config_out(db, row) if row else None


@router.put("/config", response_model=StatutoryConfigOut)
def write_config(
    payload: StatutoryConfigIn, viewer: CurrentUser, request: Request, db: DbSession
) -> StatutoryConfigOut:
    """Create or replace it. One row per company, so one endpoint."""
    _require_manager(viewer)
    row = db.scalar(
        select(StatutoryConfig).where(StatutoryConfig.org_id == viewer.org_id)
    )
    before = (
        {"pf": row.pf_enabled, "esi": row.esi_enabled, "pt": row.pt_enabled,
         "lwf": row.lwf_enabled}
        if row else None
    )
    if row is None:
        row = StatutoryConfig(org_id=viewer.org_id)
        db.add(row)

    for field, value in payload.model_dump().items():
        setattr(row, field, value.strip() or None if isinstance(value, str) else value)

    audit(db, org_id=viewer.org_id, actor=viewer, action="payroll.statutory_configured",
          request=request, target_type="statutory_config", target_id=str(row.id),
          detail={
              "before": before,
              "after": {"pf": row.pf_enabled, "esi": row.esi_enabled,
                        "pt": row.pt_enabled, "lwf": row.lwf_enabled},
              # The rates too: "why did everybody's PF change in March" is only
              # answerable if the row carries the numbers, not just the switches.
              "pf_employee_rate_bps": row.pf_employee_rate_bps,
              "pf_employer_rate_bps": row.pf_employer_rate_bps,
              "pf_wage_ceiling": row.pf_wage_ceiling,
              "pf_cap_at_ceiling": row.pf_cap_at_ceiling,
              "esi_wage_threshold": row.esi_wage_threshold,
          })
    db.commit()
    db.refresh(row)
    return _config_out(db, row)


# --------------------------------------------------------------------------- #
# Professional tax slabs
# --------------------------------------------------------------------------- #


@router.get("/slabs", response_model=list[SlabOut])
def list_slabs(viewer: CurrentUser, db: DbSession) -> list[SlabOut]:
    _require_manager(viewer)
    return list(
        db.scalars(
            select(ProfessionalTaxSlab)
            .where(ProfessionalTaxSlab.org_id == viewer.org_id)
            .order_by(ProfessionalTaxSlab.min_gross,
                      ProfessionalTaxSlab.applies_in_month)
        )
    )


@router.post("/slabs", response_model=SlabOut, status_code=status.HTTP_201_CREATED)
def create_slab(
    payload: SlabIn, viewer: CurrentUser, request: Request, db: DbSession
) -> SlabOut:
    """Add a band.

    Overlaps within the same month are refused. Two bands claiming one gross is
    not a configuration — the computation would pick whichever the index
    returned first, and the answer would change when a row was edited.
    """
    _require_manager(viewer)
    existing = db.scalars(
        select(ProfessionalTaxSlab).where(
            ProfessionalTaxSlab.org_id == viewer.org_id,
            ProfessionalTaxSlab.applies_in_month.is_(payload.applies_in_month)
            if payload.applies_in_month is None
            else ProfessionalTaxSlab.applies_in_month == payload.applies_in_month,
        )
    )
    top = payload.max_gross
    for slab in existing:
        other_top = slab.max_gross
        overlaps = (
            (top is None or slab.min_gross <= top)
            and (other_top is None or payload.min_gross <= other_top)
        )
        if overlaps:
            _fail(
                "overlapping_slab",
                f"That band overlaps an existing one starting at "
                f"{slab.min_gross / 100:,.2f}.",
                409,
            )

    row = ProfessionalTaxSlab(
        org_id=viewer.org_id,
        min_gross=payload.min_gross,
        max_gross=payload.max_gross,
        amount=payload.amount,
        applies_in_month=payload.applies_in_month,
        label=(payload.label or "").strip() or None,
    )
    db.add(row)
    audit(db, org_id=viewer.org_id, actor=viewer, action="payroll.pt_slab_created",
          request=request, target_type="professional_tax_slab", target_id=str(row.id),
          detail={"min": row.min_gross, "max": row.max_gross,
                  "amount": row.amount, "month": row.applies_in_month})
    db.commit()
    db.refresh(row)
    return SlabOut.model_validate(row)


@router.delete("/slabs/{slab_id}", status_code=status.HTTP_204_NO_CONTENT,
               response_model=None)
def delete_slab(
    slab_id: uuid.UUID, viewer: CurrentUser, request: Request, db: DbSession
) -> Response:
    _require_manager(viewer)
    row = db.get(ProfessionalTaxSlab, slab_id)
    if row is None or row.org_id != viewer.org_id:
        _fail("not_found", "Slab not found", 404)
    db.delete(row)
    audit(db, org_id=viewer.org_id, actor=viewer, action="payroll.pt_slab_deleted",
          request=request, target_type="professional_tax_slab", target_id=str(slab_id),
          detail={"min": row.min_gross, "amount": row.amount})
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --------------------------------------------------------------------------- #
# Preview
# --------------------------------------------------------------------------- #


@router.post("/preview", response_model=PreviewOut)
def preview(payload: PreviewIn, viewer: CurrentUser, db: DbSession) -> PreviewOut:
    """What this configuration deducts at a given wage.

    Runs the same function a pay run runs. Statutory rules are the part of
    payroll people check against a circular, and checking it here is cheaper
    than discovering it at month end.
    """
    _require_manager(viewer)
    config = db.scalar(
        select(StatutoryConfig).where(StatutoryConfig.org_id == viewer.org_id)
    )
    slabs = list(
        db.scalars(
            select(ProfessionalTaxSlab)
            .where(ProfessionalTaxSlab.org_id == viewer.org_id)
            .order_by(ProfessionalTaxSlab.min_gross)
        )
    )
    result = svc.compute(
        config,
        pf_wage=payload.pf_wage,
        esi_wage=payload.esi_wage,
        pt_gross=payload.gross,
        month=payload.month,
        pt_slabs=slabs,
    )
    return PreviewOut(
        employee_lines=[
            PreviewLineOut(code=line.code, name=line.name, amount=line.amount,
                           source=line.source, detail=line.detail)
            for line in result.employee_lines
        ],
        employer_lines=[
            PreviewLineOut(code=line.code, name=line.name, amount=line.amount,
                           source=line.source, detail=line.detail)
            for line in result.employer_lines
        ],
        employee_total=result.employee_total,
        employer_total=result.employer_total,
    )
