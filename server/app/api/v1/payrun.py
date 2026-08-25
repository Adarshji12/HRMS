"""Pay runs and payslips.

Thin, like every router here. Each handler settles who is asking, calls
``app.services.payrun``, and turns a ``PayRunError`` into a typed response.

Three things that are genuinely this file's business.

**Compute, approve and pay are three endpoints, not a status PATCH.** Each does
something materially different — building rows, freezing them, and moving money
elsewhere — and a single ``PATCH {status}`` would make "mark it paid" reachable
by anybody who could edit a note.

**A run's detail says who was skipped.** Employees with no salary structure for
the period are left out of the run, which is right — a ₹0 payslip reads as a
decision — but silence about it is not, so the detail carries the list.

**Payslips are read from two routes with different rules.** ``/payslips/mine``
consults no permission and returns only approved or paid runs; the run's own
listing needs the payroll capability. A draft payslip is a working figure that
may be recomputed twice before anybody signs it.
"""

from __future__ import annotations

import uuid
from datetime import date
from typing import NoReturn

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession
from app.models import PayRun, Payslip, PayslipLine, SalaryStructure, User
from app.schemas.payrun import (
    ComputeIn,
    PaidIn,
    PayslipLineOut,
    PayslipOut,
    RunDetailOut,
    RunIn,
    RunOut,
)
from app.services import payrun as svc
from app.services import payroll as structure_svc

router = APIRouter(prefix="/payruns", tags=["payroll-runs"])


def _fail(error: svc.PayRunError) -> NoReturn:
    raise HTTPException(
        error.status_code, detail={"reason": error.code, "message": error.message}
    )


def _names(db, org_id: uuid.UUID, ids) -> dict[uuid.UUID, tuple[str, str | None]]:
    wanted = {value for value in ids if value is not None}
    if not wanted:
        return {}
    return {
        row[0]: (row[1], row[2])
        for row in db.execute(
            select(User.id, User.full_name, User.employee_code).where(
                User.org_id == org_id, User.id.in_(wanted)
            )
        )
    }


def _run_out(run: PayRun, viewer: User, names: dict) -> RunOut:
    out = RunOut.model_validate(run)
    out.period_label = run.period_label
    out.computed_by_name = names.get(run.computed_by, (None, None))[0]
    out.approved_by_name = names.get(run.approved_by, (None, None))[0]
    out.paid_by_name = names.get(run.paid_by, (None, None))[0]

    manages = svc.can_manage(viewer)
    state = run.status_enum
    out.can_compute = manages and state.is_recomputable
    out.can_approve = manages and state.value == "computed" and run.employee_count > 0
    out.can_pay = manages and state.value == "approved"
    out.can_cancel = manages and state.value not in ("paid", "cancelled")
    return out


def _payslip_out(payslip: Payslip, names: dict, *, with_lines: bool = True) -> PayslipOut:
    out = PayslipOut.model_validate(payslip)
    name, code = names.get(payslip.user_id, (None, None))
    out.user_name = name
    out.employee_code = code
    out.period_label = payslip.run.period_label if payslip.run else None
    out.run_status = payslip.run.status if payslip.run else None
    out.lines = (
        [PayslipLineOut.model_validate(line) for line in payslip.lines]
        if with_lines else []
    )
    return out


# --------------------------------------------------------------------------- #
# Employee self-service — before /{run_id} so it is not parsed as an id
# --------------------------------------------------------------------------- #


@router.get("/payslips/mine", response_model=list[PayslipOut])
def my_payslips(viewer: CurrentUser, db: DbSession) -> list[PayslipOut]:
    """Your own payslips, from approved and paid runs only.

    No permission consulted — a person is entitled to their own payslip. Drafts
    are excluded because a working figure that may be recomputed twice before
    anybody signs it is worse than nothing.
    """
    rows = svc.my_payslips(db, viewer)
    names = _names(db, viewer.org_id, [viewer.id])
    return [_payslip_out(row, names) for row in rows]


@router.get("/payslips/{payslip_id}", response_model=PayslipOut)
def read_payslip(
    payslip_id: uuid.UUID, viewer: CurrentUser, db: DbSession
) -> PayslipOut:
    try:
        row = svc.get_payslip(db, viewer, payslip_id)
    except svc.PayRunError as error:
        _fail(error)
    return _payslip_out(row, _names(db, viewer.org_id, [row.user_id]))


# --------------------------------------------------------------------------- #
# Runs
# --------------------------------------------------------------------------- #


@router.get("", response_model=list[RunOut])
def list_runs(viewer: CurrentUser, db: DbSession) -> list[RunOut]:
    try:
        rows = svc.list_runs(db, viewer)
    except svc.PayRunError as error:
        _fail(error)
    names = _names(
        db, viewer.org_id,
        [value for row in rows for value in (row.computed_by, row.approved_by, row.paid_by)],
    )
    return [_run_out(row, viewer, names) for row in rows]


@router.post("", response_model=RunOut, status_code=status.HTTP_201_CREATED)
def create_run(
    payload: RunIn, viewer: CurrentUser, request: Request, db: DbSession
) -> RunOut:
    try:
        run = svc.create_run(db, viewer, payload, request=request)
    except svc.PayRunError as error:
        _fail(error)
    return _run_out(run, viewer, {})


@router.get("/{run_id}", response_model=RunDetailOut)
def read_run(run_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> RunDetailOut:
    try:
        run = svc.get_run(db, viewer, run_id)
        payslips = svc.payslips_for_run(db, viewer, run_id)
    except svc.PayRunError as error:
        _fail(error)

    names = _names(
        db, viewer.org_id,
        [p.user_id for p in payslips] + [run.computed_by, run.approved_by, run.paid_by],
    )
    base = _run_out(run, viewer, names)
    out = RunDetailOut(**base.model_dump())
    # Lines omitted from the run listing: a hundred payslips with ten lines each
    # is a megabyte of JSON to render a table of totals.
    out.payslips = [_payslip_out(p, names, with_lines=False) for p in payslips]

    # Who the run left out, and why. Skipping is right; silence about it is not.
    covered = {p.user_id for p in payslips}
    import calendar as _calendar

    period_end = date(
        run.period_year, run.period_month,
        _calendar.monthrange(run.period_year, run.period_month)[1],
    )
    for employee in db.scalars(
        select(User).where(
            User.org_id == viewer.org_id,
            User.is_active.is_(True),
            User.id.not_in(covered or {uuid.uuid4()}),
        ).order_by(User.full_name)
    ):
        if employee.joined_on and employee.joined_on > period_end:
            continue
        if structure_svc.structure_on(db, viewer.org_id, employee.id, period_end):
            continue
        out.skipped.append({
            "user_id": str(employee.id),
            "full_name": employee.full_name,
            "reason": "no salary structure for this period",
        })
    return out


@router.post("/{run_id}/compute", response_model=RunDetailOut)
def compute(
    run_id: uuid.UUID,
    payload: ComputeIn,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
) -> RunDetailOut:
    """Build every payslip, replacing whatever a previous compute left.

    A replace rather than a merge: merging keeps a payslip for somebody who has
    since left and a line for a loan that closed.
    """
    try:
        svc.compute(
            db, viewer, run_id,
            overrides={o.user_id: o.lop_milli_days for o in payload.overrides},
            request=request,
        )
    except svc.PayRunError as error:
        _fail(error)
    return read_run(run_id, viewer, db)


@router.post("/{run_id}/approve", response_model=RunOut)
def approve(
    run_id: uuid.UUID, viewer: CurrentUser, request: Request, db: DbSession
) -> RunOut:
    """Sign off the figures. Nothing recomputes afterwards."""
    try:
        run = svc.approve(db, viewer, run_id, request=request)
    except svc.PayRunError as error:
        _fail(error)
    return _run_out(run, viewer, _names(db, viewer.org_id, [run.approved_by]))


@router.post("/{run_id}/pay", response_model=RunOut)
def mark_paid(
    run_id: uuid.UUID,
    payload: PaidIn,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
) -> RunOut:
    """Record that salaries went out, and settle what that implies.

    Loan instalments become paid and expense claims reimbursed — here rather
    than at approval, because both are statements that money moved.
    """
    try:
        run = svc.mark_paid(db, viewer, run_id, payload, request=request)
    except svc.PayRunError as error:
        _fail(error)
    return _run_out(run, viewer, _names(db, viewer.org_id, [run.paid_by]))


@router.post("/{run_id}/cancel", response_model=RunOut)
def cancel(
    run_id: uuid.UUID, viewer: CurrentUser, request: Request, db: DbSession
) -> RunOut:
    """Abandon an unpaid run. Its payslips go with it."""
    try:
        run = svc.cancel(db, viewer, run_id, request=request)
    except svc.PayRunError as error:
        _fail(error)
    return _run_out(run, viewer, {})
