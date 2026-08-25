"""Investment declarations, the regime choice, and the tax estimate.

Thin. The arithmetic is in ``services/incometax`` (pure) and the rules in
``services/declarations``.

Two things that are genuinely this file's business.

**The regime endpoint has no administrator path.** Electing old or new is the
employee's choice with consequences they own, so there is no route an HR user
can reach it through — not a guarded one, none.

**The estimate returns both regimes.** An employee looking at one number cannot
make the comparison the choice exists for, and this is the screen that stops
somebody electing the old regime and losing money by it.
"""

from __future__ import annotations

import uuid
from typing import NoReturn

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession
from app.core import taxslabs
from app.models import TaxDeclaration, User
from app.schemas.incometax import (
    BreakdownOut,
    CloseIn,
    DeclarationOut,
    EstimateOut,
    ItemIn,
    ItemOut,
    ProofIn,
    RegimeIn,
    VerifyIn,
)
from app.services import declarations as svc
from app.services import incometax as tax_svc

router = APIRouter(prefix="/tax", tags=["payroll-tax"])


def _fail(error: svc.DeclarationError) -> NoReturn:
    raise HTTPException(
        error.status_code, detail={"reason": error.code, "message": error.message}
    )


def _item_out(item) -> ItemOut:
    out = ItemOut.model_validate(item)
    out.effective_amount = item.effective_amount
    out.cap = tax_svc.SECTION_CAPS.get(item.section)
    return out


def _out(db, viewer: User, row: TaxDeclaration) -> DeclarationOut:
    out = DeclarationOut.model_validate(row)
    names = {
        r[0]: r[1]
        for r in db.execute(
            select(User.id, User.full_name).where(
                User.id.in_({row.user_id, row.verified_by} - {None})
            )
        )
    }
    out.user_name = names.get(row.user_id)
    out.verified_by_name = names.get(row.verified_by)
    out.year_label = taxslabs.year_label(row.financial_year)
    out.provisional = taxslabs.is_provisional(row.financial_year)
    out.items = [_item_out(item) for item in row.items]
    out.can_edit = row.user_id == viewer.id and row.is_editable
    out.can_verify = svc.can_verify(viewer)
    return out


def _breakdown_out(breakdown) -> BreakdownOut:
    return BreakdownOut(
        gross_income=breakdown.gross_income,
        standard_deduction=breakdown.standard_deduction,
        chapter_via=breakdown.chapter_via,
        professional_tax=breakdown.professional_tax,
        taxable_income=breakdown.taxable_income,
        tax_before_rebate=breakdown.tax_before_rebate,
        rebate=breakdown.rebate,
        surcharge=breakdown.surcharge,
        cess=breakdown.cess,
        total_tax=breakdown.total_tax,
        regime=breakdown.regime,
        slab_working=[list(row) for row in breakdown.slab_working],
    )


# --------------------------------------------------------------------------- #
# The declaration
# --------------------------------------------------------------------------- #


@router.get("/declaration", response_model=DeclarationOut)
def my_declaration(
    viewer: CurrentUser,
    db: DbSession,
    financial_year: int | None = Query(default=None, ge=2000, le=2100),
) -> DeclarationOut:
    """Your own, for a year — created empty on first open.

    The new regime is the default, matching the default in law. An empty
    declaration is the honest starting state rather than a 404 for a thing
    everybody has.
    """
    year = financial_year or svc.current_financial_year()
    try:
        row = svc.get_or_create(db, viewer, viewer.id, year)
    except svc.DeclarationError as error:
        _fail(error)
    return _out(db, viewer, row)


@router.get("/declaration/{user_id}", response_model=DeclarationOut)
def read_declaration(
    user_id: uuid.UUID,
    viewer: CurrentUser,
    db: DbSession,
    financial_year: int | None = Query(default=None, ge=2000, le=2100),
) -> DeclarationOut:
    year = financial_year or svc.current_financial_year()
    try:
        row = svc.get_or_create(db, viewer, user_id, year)
    except svc.DeclarationError as error:
        _fail(error)
    return _out(db, viewer, row)


@router.get("/declarations", response_model=list[DeclarationOut])
def list_declarations(
    viewer: CurrentUser,
    db: DbSession,
    financial_year: int | None = Query(default=None, ge=2000, le=2100),
) -> list[DeclarationOut]:
    """Everybody's, for verification. Payroll capability only."""
    if not svc.can_verify(viewer):
        _fail(svc.DeclarationError(
            "not_permitted", "You may not verify declarations.", 403
        ))
    year = financial_year or svc.current_financial_year()
    rows = db.scalars(
        select(TaxDeclaration).where(
            TaxDeclaration.org_id == viewer.org_id,
            TaxDeclaration.financial_year == year,
        )
    )
    return [_out(db, viewer, row) for row in rows]


@router.post("/declaration/{declaration_id}/regime", response_model=DeclarationOut)
def set_regime(
    declaration_id: uuid.UUID,
    payload: RegimeIn,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
) -> DeclarationOut:
    """Elect the old or the new regime. The employee's alone."""
    try:
        row = svc.set_regime(db, viewer, declaration_id, payload.regime.value,
                             request=request)
    except svc.DeclarationError as error:
        _fail(error)
    return _out(db, viewer, row)


@router.post("/declaration/{declaration_id}/items", response_model=DeclarationOut)
def upsert_item(
    declaration_id: uuid.UUID,
    payload: ItemIn,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
) -> DeclarationOut:
    """Add or revise one claim. Upserts on the section."""
    try:
        svc.upsert_item(db, viewer, declaration_id, payload, request=request)
        row = svc.get(db, viewer, declaration_id)
    except svc.DeclarationError as error:
        _fail(error)
    return _out(db, viewer, row)


@router.delete("/items/{item_id}", response_model=DeclarationOut)
def delete_item(
    item_id: uuid.UUID, viewer: CurrentUser, request: Request, db: DbSession
) -> DeclarationOut:
    from app.models import TaxDeclarationItem

    item = db.get(TaxDeclarationItem, item_id)
    if item is None or item.org_id != viewer.org_id:
        _fail(svc.DeclarationError("item_not_found", "Claim not found", 404))
    declaration_id = item.declaration_id
    try:
        svc.delete_item(db, viewer, item_id, request=request)
        row = svc.get(db, viewer, declaration_id)
    except svc.DeclarationError as error:
        _fail(error)
    return _out(db, viewer, row)


@router.post("/items/{item_id}/proof", response_model=DeclarationOut)
def attach_proof(
    item_id: uuid.UUID,
    payload: ProofIn,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
) -> DeclarationOut:
    """Point a claim at a document already in your Core HR file."""
    try:
        item = svc.attach_proof(db, viewer, item_id, payload.document_id,
                                request=request)
        row = svc.get(db, viewer, item.declaration_id)
    except svc.DeclarationError as error:
        _fail(error)
    return _out(db, viewer, row)


@router.post("/declaration/{declaration_id}/submit", response_model=DeclarationOut)
def submit(
    declaration_id: uuid.UUID, viewer: CurrentUser, request: Request, db: DbSession
) -> DeclarationOut:
    """Tell payroll to start honouring it. Still editable afterwards."""
    try:
        row = svc.submit(db, viewer, declaration_id, request=request)
    except svc.DeclarationError as error:
        _fail(error)
    return _out(db, viewer, row)


# --------------------------------------------------------------------------- #
# Verification
# --------------------------------------------------------------------------- #


@router.post("/items/{item_id}/verify", response_model=DeclarationOut)
def verify_item(
    item_id: uuid.UUID,
    payload: VerifyIn,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
) -> DeclarationOut:
    """Record what a proof actually evidences. Payroll capability only."""
    try:
        item = svc.verify_item(db, viewer, item_id, payload, request=request)
        row = svc.get(db, viewer, item.declaration_id)
    except svc.DeclarationError as error:
        _fail(error)
    return _out(db, viewer, row)


@router.post("/declaration/{declaration_id}/close", response_model=DeclarationOut)
def close(
    declaration_id: uuid.UUID,
    payload: CloseIn,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
) -> DeclarationOut:
    """Mark it verified, or reopen it."""
    try:
        row = svc.close(db, viewer, declaration_id, payload, request=request)
    except svc.DeclarationError as error:
        _fail(error)
    return _out(db, viewer, row)


# --------------------------------------------------------------------------- #
# Estimate
# --------------------------------------------------------------------------- #


@router.get("/declaration/{declaration_id}/estimate", response_model=EstimateOut)
def estimate(
    declaration_id: uuid.UUID,
    viewer: CurrentUser,
    db: DbSession,
    annual_income: int = Query(..., ge=0, le=10_000_000_000),
) -> EstimateOut:
    """Both regimes at a given annual income.

    ``annual_income`` is a query parameter rather than derived from the salary
    structure, so an employee can ask "what if" — and because the structure may
    not exist yet for somebody who has just joined.
    """
    try:
        result = svc.estimate(db, viewer, declaration_id, annual_income=annual_income)
    except svc.DeclarationError as error:
        _fail(error)
    except taxslabs.UnknownYear as exc:
        _fail(svc.DeclarationError("no_tax_slabs", str(exc), 409))
    return EstimateOut(
        chosen=result["chosen"],
        financial_year=result["financial_year"],
        year_label=result["year_label"],
        provisional=result["provisional"],
        annual_income=result["annual_income"],
        old=_breakdown_out(result["old"]),
        new=_breakdown_out(result["new"]),
    )
