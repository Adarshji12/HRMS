"""Payroll outputs: register, bank file, statutory returns, payslip documents.

Kept apart from ``api/v1/payrun`` because that file already carries the run's
lifecycle and this is what comes *out* of a completed one. Same prefix, so the
routes read as belonging to a run, which they do.

Two things that are genuinely this file's business.

**Everything here returns a file, not JSON** — except the register, which is
returned both ways: on screen it is a table somebody reads, and as CSV it is a
spreadsheet somebody reconciles. One endpoint each rather than a `?format=`
switch, because the two have genuinely different shapes.

**The bank file is the most sensitive thing this system produces.** It decrypts
account numbers. It is audited on every generation in the service, and it is a
POST rather than a GET for the same reason revealing a PAN is: a GET would be
prefetched, retried by a proxy, and land in an access log.
"""

from __future__ import annotations

import uuid
from typing import NoReturn

from fastapi import APIRouter, HTTPException, Request, Response, status

from app.api.deps import CurrentUser, DbSession
from app.schemas.payoutputs import FiledOut, RegisterOut, RegisterRowOut
from app.services import payoutputs as svc

router = APIRouter(prefix="/payruns", tags=["payroll-outputs"])


def _fail(error: svc.OutputError) -> NoReturn:
    raise HTTPException(
        error.status_code, detail={"reason": error.code, "message": error.message}
    )


def _csv(payload: bytes, filename: str) -> Response:
    return Response(
        content=payload,
        media_type="text/csv; charset=utf-8",
        # attachment, not inline: these are files somebody opens in a
        # spreadsheet or uploads to a portal, not pages they read.
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# --------------------------------------------------------------------------- #
# Register
# --------------------------------------------------------------------------- #


@router.get("/{run_id}/register", response_model=RegisterOut)
def register(run_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> RegisterOut:
    """The month on one page, as data for the screen."""
    try:
        reg = svc.register(db, viewer, run_id)
    except svc.OutputError as error:
        _fail(error)

    def row_out(row) -> RegisterRowOut:
        return RegisterRowOut(
            user_id=row.user_id, name=row.name, employee_code=row.employee_code,
            payable_days=row.payable_days, month_days=row.month_days,
            earnings=row.earnings, deductions=row.deductions,
            employer=row.employer, gross=row.gross,
            total_deductions=row.total_deductions, net=row.net,
            employer_total=row.employer_total,
        )

    return RegisterOut(
        run_id=reg.run_id, period=reg.period, status=reg.status,
        pay_date=reg.pay_date,
        earning_codes=reg.earning_codes, deduction_codes=reg.deduction_codes,
        employer_codes=reg.employer_codes,
        rows=[row_out(row) for row in reg.rows],
        totals=row_out(reg.totals),
        discrepancies=reg.discrepancies,
    )


@router.get("/{run_id}/register.csv", response_model=None)
def register_csv(run_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> Response:
    """The same register as a spreadsheet, in rupees rather than paise."""
    try:
        reg = svc.register(db, viewer, run_id)
        payload = svc.register_csv(reg)
    except svc.OutputError as error:
        _fail(error)
    return _csv(payload, f"payroll-register-{reg.period.replace(' ', '-')}.csv")


# --------------------------------------------------------------------------- #
# Bank file
# --------------------------------------------------------------------------- #


@router.post("/{run_id}/bank-file", response_model=None)
def bank_file(
    run_id: uuid.UUID, viewer: CurrentUser, request: Request, db: DbSession
) -> Response:
    """Net pay with account details, for upload to the bank.

    A POST although it reads nothing: it decrypts every bank account on the run
    and writes an audit row, and a GET would be prefetched by a browser, retried
    by a proxy, and logged. The same argument Core HR's PAN reveal makes.
    """
    try:
        payload = svc.bank_file(db, viewer, run_id, request=request)
        run = svc._get_run(db, viewer, run_id)
    except svc.OutputError as error:
        _fail(error)
    return _csv(payload, f"bank-transfer-{svc.period_label(run).replace(' ', '-')}.csv")


# --------------------------------------------------------------------------- #
# Statutory filings
# --------------------------------------------------------------------------- #


@router.get("/{run_id}/pf-ecr", response_model=None)
def pf_ecr(run_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> Response:
    """The EPFO return, in whole rupees.

    A starting point an operator adapts to their portal version, not a claim
    that it uploads unmodified — the header says which field is which.
    """
    try:
        payload = svc.pf_ecr(db, viewer, run_id)
        run = svc._get_run(db, viewer, run_id)
    except svc.OutputError as error:
        _fail(error)
    return Response(
        content=payload,
        media_type="text/plain; charset=utf-8",
        headers={
            "Content-Disposition":
                f'attachment; filename="pf-ecr-{run.period_label}.txt"'
        },
    )


@router.get("/{run_id}/esi-return", response_model=None)
def esi_return(run_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> Response:
    """The ESIC monthly contribution file."""
    try:
        payload = svc.esi_return(db, viewer, run_id)
        run = svc._get_run(db, viewer, run_id)
    except svc.OutputError as error:
        _fail(error)
    return _csv(payload, f"esi-{run.period_label}.csv")


# --------------------------------------------------------------------------- #
# Payslip documents
# --------------------------------------------------------------------------- #


@router.post("/{run_id}/file-payslips", response_model=FiledOut)
def file_payslips(
    run_id: uuid.UUID, viewer: CurrentUser, request: Request, db: DbSession
) -> FiledOut:
    """Put a copy of every payslip into its employee's document record.

    Idempotent: running it twice does not give anybody two payslips for one
    month.
    """
    try:
        filed = svc.file_payslips(db, viewer, run_id, request=request)
    except svc.OutputError as error:
        _fail(error)
    return FiledOut(filed=filed)


@router.get("/payslips/{payslip_id}/print", response_model=None)
def print_payslip(
    payslip_id: uuid.UUID, viewer: CurrentUser, db: DbSession
) -> Response:
    """One payslip as a printable page.

    Works on a draft as well as a frozen run — seeing what a draft produces is
    the point of reviewing one. *Filing* it is what requires approval.
    """
    try:
        slip, payload = svc.render_payslip(db, viewer, payslip_id)
    except svc.OutputError as error:
        _fail(error)
    return Response(
        content=payload,
        media_type="text/html; charset=utf-8",
        headers={
            "Content-Disposition":
                f'inline; filename="payslip-{slip.run.period_label}.html"'
        },
    )
