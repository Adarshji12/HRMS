"""Form 16 and the year-end reconciliation.

Thin. ``services/form16`` does the adding up, the freezing and the rendering.

Two things that are genuinely this file's business.

**Reconciliation and issue are separate endpoints.** Reconciling is what finance
does repeatedly through March, correcting as it goes; issuing freezes a
certificate somebody will file a return against. Collapsing them would make the
safe operation carry the irreversible one.

**The certificate is served as HTML from its own route**, like an issued letter,
so the permission check runs on every fetch and the employee's full PAN — which a
Form 16 needs to be usable — never sits in a JSON payload a browser caches.
"""

from __future__ import annotations

import uuid
from typing import NoReturn

from fastapi import APIRouter, HTTPException, Query, Request, Response, status

from app.api.deps import CurrentUser, DbSession
from app.core import taxslabs
from app.schemas.form16 import (
    Form16Out,
    IssueIn,
    ReconciliationOut,
)
from app.services import declarations as decl_svc
from app.services import form16 as svc

router = APIRouter(prefix="/form16", tags=["payroll-form16"])


def _fail(error: svc.Form16Error) -> NoReturn:
    raise HTTPException(
        error.status_code, detail={"reason": error.code, "message": error.message}
    )


def _reconciliation_out(result: svc.Reconciliation) -> ReconciliationOut:
    breakdown = result.breakdown
    return ReconciliationOut(
        user_id=result.user_id,
        user_name=result.user_name,
        financial_year=result.financial_year,
        year_label=taxslabs.year_label(result.financial_year),
        provisional=taxslabs.is_provisional(result.financial_year),
        months_covered=result.months_covered,
        gross_salary=result.gross_salary,
        standard_deduction=breakdown.standard_deduction,
        professional_tax=result.professional_tax,
        chapter_via=breakdown.chapter_via,
        taxable_income=breakdown.taxable_income,
        total_tax=breakdown.total_tax,
        tds_deducted=result.tds_deducted,
        balance=result.balance,
        employee_pf=result.employee_pf,
        employer_pf=result.employer_pf,
        regime=result.regime,
        age_band=result.age_band,
        issued=result.issued,
    )


@router.get("/reconcile", response_model=list[ReconciliationOut])
def reconcile_all(
    viewer: CurrentUser,
    db: DbSession,
    financial_year: int | None = Query(default=None, ge=2000, le=2100),
) -> list[ReconciliationOut]:
    """Everybody's year, deducted against due. The March working list."""
    year = financial_year or decl_svc.current_financial_year()
    try:
        rows = svc.reconcile_all(db, viewer, year)
    except svc.Form16Error as error:
        _fail(error)
    return [_reconciliation_out(row) for row in rows]


@router.get("/reconcile/{user_id}", response_model=ReconciliationOut)
def reconcile_one(
    user_id: uuid.UUID,
    viewer: CurrentUser,
    db: DbSession,
    financial_year: int | None = Query(default=None, ge=2000, le=2100),
) -> ReconciliationOut:
    year = financial_year or decl_svc.current_financial_year()
    try:
        return _reconciliation_out(svc.reconcile(db, viewer, user_id, year))
    except svc.Form16Error as error:
        _fail(error)


@router.get("/mine", response_model=list[Form16Out])
def my_certificates(viewer: CurrentUser, db: DbSession) -> list[Form16Out]:
    """Your own certificates. No permission consulted — they are yours."""
    try:
        rows = svc.list_for(db, viewer, viewer.id)
    except svc.Form16Error as error:
        _fail(error)
    return [Form16Out.model_validate(row) for row in rows]


@router.get("/employee/{user_id}", response_model=list[Form16Out])
def certificates_for(
    user_id: uuid.UUID, viewer: CurrentUser, db: DbSession
) -> list[Form16Out]:
    try:
        rows = svc.list_for(db, viewer, user_id)
    except svc.Form16Error as error:
        _fail(error)
    return [Form16Out.model_validate(row) for row in rows]


@router.post("/issue/{user_id}", response_model=Form16Out,
             status_code=status.HTTP_201_CREATED)
def issue(
    user_id: uuid.UUID,
    payload: IssueIn,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
) -> Form16Out:
    """Freeze the year into a certificate and file it.

    Issuing again produces revision 2 and supersedes the first, which stays
    readable — somebody may already have filed against it.
    """
    try:
        row = svc.issue(db, viewer, user_id, payload.financial_year,
                        note=payload.note, request=request)
    except svc.Form16Error as error:
        _fail(error)
    return Form16Out.model_validate(row)


@router.get("/{form16_id}/print", response_model=None)
def print_certificate(
    form16_id: uuid.UUID, viewer: CurrentUser, db: DbSession
) -> Response:
    """The certificate as a printable page.

    HTML with a print stylesheet rather than a PDF — the same choice, and the
    same reason, as an issued letter. Served from its own route so the
    permission check runs on every fetch and the full PAN never sits in a
    cacheable JSON payload.
    """
    try:
        row, html = svc.render(db, viewer, form16_id)
    except svc.Form16Error as error:
        _fail(error)
    filename = f"{row.reference_no.replace('/', '-')}.html"
    return Response(
        content=html,
        media_type="text/html; charset=utf-8",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )
