"""Payroll checkpoint 1: pay components and salary structures.

Thin, like every router here. Each handler settles who is asking, calls
``app.services.payroll``, and turns a ``PayrollError`` into a typed response.

Three things that are genuinely this file's business.

**``/me`` is a separate route from ``/{user_id}``.** Reading your own salary
consults no permission at all — a person is entitled to know what they are paid —
and a named route keeps that path out of the id-shaped one, where a typo lands on
somebody else's 403 rather than a 404.

**Preview is a POST that saves nothing.** Resolving a structure needs the whole
component list, which does not fit sensibly in a query string; and the answer an
administrator needs before committing is "do these percentages add up", which is
exactly what a preview shows and a failed save does not.

**There is no endpoint that returns everybody's salary.** ``/uncovered`` returns
the people *without* a structure, which is what setting the module up needs, and
it deliberately carries no amounts. A list-everyone-with-pay endpoint is one
mis-scoped query away from being the worst data leak in the product.
"""

from __future__ import annotations

import uuid
from datetime import date
from typing import NoReturn

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from sqlalchemy import func, select

from app.api.deps import CurrentUser, DbSession
from app.models import SalaryStructure, SalaryStructureComponent, User
from app.schemas.payroll import (
    ComponentIn,
    ComponentOut,
    ComponentUpdate,
    PreviewIn,
    PreviewOut,
    StructureComponentOut,
    StructureIn,
    StructureOut,
    UncoveredOut,
)
from app.services import payroll as svc

router = APIRouter(prefix="/payroll", tags=["payroll"])


def _fail(error: svc.PayrollError) -> NoReturn:
    raise HTTPException(
        error.status_code, detail={"reason": error.code, "message": error.message}
    )


def _names(db, org_id: uuid.UUID, rows) -> dict[uuid.UUID, str]:
    wanted = {
        value
        for row in rows
        for value in (row.user_id, row.created_by)
        if value is not None
    }
    if not wanted:
        return {}
    return {
        r[0]: r[1]
        for r in db.execute(
            select(User.id, User.full_name).where(User.org_id == org_id, User.id.in_(wanted))
        )
    }


def _structure_out(row: SalaryStructure, names: dict) -> StructureOut:
    out = StructureOut.model_validate(row)
    out.user_name = names.get(row.user_id)
    out.created_by_name = names.get(row.created_by)
    out.components = [
        StructureComponentOut.model_validate(line) for line in row.components
    ]
    # Derived at the edge. Twelve months, not 365/30 — a salary is stated
    # monthly and an annual figure is twelve of them, whatever the calendar does.
    out.annual_gross = row.gross_monthly * 12
    earnings = [line for line in row.components if line.kind == "earning"]
    out.pf_wage_monthly = sum(line.amount for line in earnings if line.is_pf_wage)
    out.esi_wage_monthly = sum(line.amount for line in earnings if line.is_esi_wage)
    out.taxable_monthly = sum(line.amount for line in earnings if line.is_taxable)
    out.is_current = row.effective_to is None
    return out


# --------------------------------------------------------------------------- #
# Components
# --------------------------------------------------------------------------- #


@router.get("/components", response_model=list[ComponentOut])
def list_components(
    viewer: CurrentUser, db: DbSession, active_only: bool = False
) -> list[ComponentOut]:
    """The catalogue. Payroll managers only.

    Not open to everyone the way expense categories are: a component list with
    its percentages is most of a company's salary design, and it is the sort of
    thing colleagues reverse-engineer each other's pay from.
    """
    try:
        svc._require_manager(viewer)
    except svc.PayrollError as error:
        _fail(error)

    rows = svc.list_components(db, viewer.org_id, active_only=active_only)
    usage = {
        r[0]: int(r[1])
        for r in db.execute(
            select(SalaryStructureComponent.component_id,
                   func.count(SalaryStructureComponent.id))
            .where(SalaryStructureComponent.org_id == viewer.org_id)
            .group_by(SalaryStructureComponent.component_id)
        )
    }
    out = []
    for row in rows:
        item = ComponentOut.model_validate(row)
        item.usage_count = usage.get(row.id, 0)
        out.append(item)
    return out


@router.post("/components", response_model=ComponentOut,
             status_code=status.HTTP_201_CREATED)
def create_component(
    payload: ComponentIn, viewer: CurrentUser, request: Request, db: DbSession
) -> ComponentOut:
    try:
        return ComponentOut.model_validate(
            svc.create_component(db, viewer, payload, request=request)
        )
    except svc.PayrollError as error:
        _fail(error)


@router.patch("/components/{component_id}", response_model=ComponentOut)
def update_component(
    component_id: uuid.UUID,
    payload: ComponentUpdate,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
) -> ComponentOut:
    """Edit the catalogue. Existing structures keep their own snapshot."""
    try:
        return ComponentOut.model_validate(
            svc.update_component(db, viewer, component_id, payload, request=request)
        )
    except svc.PayrollError as error:
        _fail(error)


# --------------------------------------------------------------------------- #
# Preview and reports — before /{user_id} so they are not parsed as ids
# --------------------------------------------------------------------------- #


@router.post("/preview", response_model=PreviewOut)
def preview(
    payload: PreviewIn, viewer: CurrentUser, db: DbSession
) -> PreviewOut:
    """Resolve a structure without saving it.

    The question this answers — "do these percentages add up to gross" — is the
    one an administrator needs before committing, and a failed save answers it
    less usefully than a table showing where the money went.
    """
    try:
        svc._require_manager(viewer)
        catalogue = svc.list_components(db, viewer.org_id, active_only=True)
        chosen_ids = {line.component_id for line in payload.components}
        chosen = [c for c in catalogue if c.id in chosen_ids]
        if len(chosen) != len(chosen_ids):
            raise svc.PayrollError("component_not_found", "Unknown pay component.", 404)
        lines = svc.resolve(
            chosen,
            gross_monthly=payload.gross_monthly,
            fixed_amounts={
                line.component_id: line.amount
                for line in payload.components
                if line.amount is not None
            },
        )
    except svc.PayrollError as error:
        _fail(error)

    out = PreviewOut(gross_monthly=payload.gross_monthly)
    out.components = [
        StructureComponentOut(
            id=component.id, component_id=component.id, code=component.code,
            name=component.name, kind=component.kind,
            calculation=component.calculation, rate_bps=component.rate_bps,
            amount=amount, is_pf_wage=component.is_pf_wage,
            is_esi_wage=component.is_esi_wage, is_taxable=component.is_taxable,
            sort_order=component.sort_order,
        )
        for component, amount in lines
    ]
    out.pf_wage_monthly = sum(c.amount for c in out.components if c.is_pf_wage)
    out.esi_wage_monthly = sum(c.amount for c in out.components if c.is_esi_wage)
    out.taxable_monthly = sum(c.amount for c in out.components if c.is_taxable)
    return out


@router.get("/uncovered", response_model=list[UncoveredOut])
def uncovered(viewer: CurrentUser, db: DbSession) -> list[UncoveredOut]:
    """Active employees with no salary structure.

    Carries no amounts, deliberately — it is a list of gaps, not of pay.
    """
    try:
        rows = svc.uncovered(db, viewer)
    except svc.PayrollError as error:
        _fail(error)
    return [
        UncoveredOut(
            user_id=row.id, full_name=row.full_name, email=row.email,
            employee_code=row.employee_code, joined_on=row.joined_on,
        )
        for row in rows
    ]


@router.get("/me", response_model=list[StructureOut])
def my_structures(viewer: CurrentUser, db: DbSession) -> list[StructureOut]:
    """Your own salary history. No permission consulted — it is yours."""
    rows = svc.structures_for(db, viewer.org_id, viewer.id)
    names = _names(db, viewer.org_id, rows)
    return [_structure_out(row, names) for row in rows]


# --------------------------------------------------------------------------- #
# One person's structures
# --------------------------------------------------------------------------- #


@router.get("/{user_id}", response_model=list[StructureOut])
def read_structures(
    user_id: uuid.UUID, viewer: CurrentUser, db: DbSession
) -> list[StructureOut]:
    try:
        subject = svc.readable(db, viewer, user_id)
    except svc.PayrollError as error:
        _fail(error)
    rows = svc.structures_for(db, viewer.org_id, subject.id)
    names = _names(db, viewer.org_id, rows)
    return [_structure_out(row, names) for row in rows]


@router.get("/{user_id}/on/{on}", response_model=StructureOut | None)
def structure_on(
    user_id: uuid.UUID, on: date, viewer: CurrentUser, db: DbSession
) -> StructureOut | None:
    """What was in force on a given day — the query a pay run will make.

    Exposed now, before pay runs exist, so the effective-dating is proven
    against its real consumer rather than an assumption about one.
    """
    try:
        subject = svc.readable(db, viewer, user_id)
    except svc.PayrollError as error:
        _fail(error)
    row = svc.structure_on(db, viewer.org_id, subject.id, on)
    if row is None:
        return None
    return _structure_out(row, _names(db, viewer.org_id, [row]))


@router.post("/{user_id}", response_model=StructureOut,
             status_code=status.HTTP_201_CREATED)
def set_structure(
    user_id: uuid.UUID,
    payload: StructureIn,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
) -> StructureOut:
    """Record a new salary, effective from a date. Never an edit of an old one."""
    try:
        row = svc.set_structure(db, viewer, user_id, payload, request=request)
    except svc.PayrollError as error:
        _fail(error)
    return _structure_out(row, _names(db, viewer.org_id, [row]))


@router.delete("/structures/{structure_id}", status_code=status.HTTP_204_NO_CONTENT,
               response_model=None)
def delete_structure(
    structure_id: uuid.UUID, viewer: CurrentUser, request: Request, db: DbSession
) -> Response:
    """Remove a revision, and re-close the timeline around the gap it leaves."""
    try:
        svc.delete_structure(db, viewer, structure_id, request=request)
    except svc.PayrollError as error:
        _fail(error)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
