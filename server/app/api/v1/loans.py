"""Loans and advances: requesting, sanctioning, disbursing, repaying.

Thin, like every router here. Each handler settles who is asking, calls
``app.services.loans``, and turns a ``LoanError`` into a typed response.

Three things that are genuinely this file's business.

**Sanctioning and disbursing are separate endpoints with separate permissions.**
Approval is a promise; disbursement is a transfer. Collapsing them would make
"sanctioned but not yet paid out" — the state an employee rings up about —
unrepresentable, the same argument expenses makes about approved and reimbursed.

**Repayment is recorded per instalment, not against the loan.** A loan-level
"amount received" would leave the schedule unable to say which month was
covered, which is the only question a loan ledger is ever asked.

**``/deductions`` exists before payroll does.** It is the query a pay run will
make, built and tested now so the ledger is proven against its real consumer
rather than against an assumption about one.
"""

from __future__ import annotations

import uuid
from datetime import date
from typing import NoReturn

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import func, select

from app.api.deps import CurrentUser, DbSession
from app.models import InstalmentStatus, Loan, LoanInstalment, User
from app.schemas.loans import (
    DeductionRowOut,
    DisburseIn,
    InstalmentOut,
    LoanDetailOut,
    LoanOut,
    LoanRequestIn,
    RepaymentIn,
    ReviewIn,
    SettleIn,
    SummaryOut,
    WriteOffIn,
)
from app.services import loans as svc

router = APIRouter(prefix="/loans", tags=["loans"])


def _fail(error: svc.LoanError) -> NoReturn:
    raise HTTPException(
        error.status_code, detail={"reason": error.code, "message": error.message}
    )


# --------------------------------------------------------------------------- #
# Serialisation
# --------------------------------------------------------------------------- #


def _names(db, org_id: uuid.UUID, rows) -> dict[uuid.UUID, str]:
    wanted: set[uuid.UUID] = set()
    for row in rows:
        for value in (
            getattr(row, "user_id", None), getattr(row, "reviewed_by", None),
            getattr(row, "disbursed_by", None), getattr(row, "created_by_user_id", None),
            getattr(row, "recorded_by", None),
        ):
            if value is not None:
                wanted.add(value)
    if not wanted:
        return {}
    return {
        r[0]: r[1]
        for r in db.execute(
            select(User.id, User.full_name).where(User.org_id == org_id, User.id.in_(wanted))
        )
    }


def _totals(db, loan_ids: list[uuid.UUID]) -> dict[uuid.UUID, dict]:
    """Instalment aggregates for many loans in one query each.

    Three grouped queries rather than a query per loan: the list endpoint would
    otherwise be N+1 over a table that grows with every month of every loan.
    """
    if not loan_ids:
        return {}
    totals: dict[uuid.UUID, dict] = {
        loan_id: {
            "total": 0, "outstanding": 0, "repaid": 0,
            "paid_count": 0, "count": 0, "next_due": None,
        }
        for loan_id in loan_ids
    }
    for row in db.execute(
        select(
            LoanInstalment.loan_id,
            func.count(LoanInstalment.id),
            func.coalesce(func.sum(LoanInstalment.amount), 0),
        )
        .where(LoanInstalment.loan_id.in_(loan_ids))
        .group_by(LoanInstalment.loan_id)
    ):
        totals[row[0]]["count"] = int(row[1])
        totals[row[0]]["total"] = int(row[2])

    for row in db.execute(
        select(
            LoanInstalment.loan_id,
            func.coalesce(func.sum(LoanInstalment.amount), 0),
            func.min(LoanInstalment.due_on),
        )
        .where(
            LoanInstalment.loan_id.in_(loan_ids),
            LoanInstalment.status == InstalmentStatus.PENDING.value,
        )
        .group_by(LoanInstalment.loan_id)
    ):
        totals[row[0]]["outstanding"] = int(row[1])
        totals[row[0]]["next_due"] = row[2]

    for row in db.execute(
        select(
            LoanInstalment.loan_id,
            func.count(LoanInstalment.id),
            func.coalesce(func.sum(LoanInstalment.paid_amount), 0),
        )
        .where(
            LoanInstalment.loan_id.in_(loan_ids),
            LoanInstalment.status == InstalmentStatus.PAID.value,
        )
        .group_by(LoanInstalment.loan_id)
    ):
        totals[row[0]]["paid_count"] = int(row[1])
        totals[row[0]]["repaid"] = int(row[2])
    return totals


def _loan_out(loan: Loan, viewer: User, *, names: dict, totals: dict) -> LoanOut:
    out = LoanOut.model_validate(loan)
    out.user_name = names.get(loan.user_id)
    out.reviewer_name = names.get(loan.reviewed_by)
    out.disbursed_by_name = names.get(loan.disbursed_by)
    # Only when somebody else filed it, or every ordinary row grows a redundant
    # "filed by" line repeating the borrower's own name.
    if loan.created_by_user_id and loan.created_by_user_id != loan.user_id:
        out.created_by_name = names.get(loan.created_by_user_id)

    figures = totals.get(loan.id, {})
    # Before disbursement there is no schedule, so the repayable figure is the
    # projection rather than a sum of rows — otherwise a sanctioned loan reads
    # as ₹0 owed, which is true and useless.
    if figures.get("count"):
        out.total_repayable = figures["total"]
    else:
        out.total_repayable = svc.total_repayable(
            loan.approved_principal or loan.principal,
            loan.instalment_count,
            loan.interest_rate_bps,
        )
    out.outstanding_amount = figures.get("outstanding", 0)
    out.repaid_amount = figures.get("repaid", 0)
    out.instalments_paid = figures.get("paid_count", 0)
    out.instalments_total = figures.get("count", 0)
    out.next_due_on = figures.get("next_due")

    state = loan.status_enum
    owns = loan.user_id == viewer.id
    out.can_review = (
        svc.can_approve(viewer) and state.value == "requested" and not owns
    )
    out.can_disburse = svc.can_disburse(viewer) and state.value == "approved"
    out.can_record_repayment = svc.can_disburse(viewer) and state.value == "active"
    out.can_cancel = (owns or svc.is_administrator(viewer)) and state.value in (
        "requested", "approved",
    )
    out.can_write_off = svc.can_approve(viewer) and state.value == "active"
    return out


def _instalment_out(row: LoanInstalment, names: dict) -> InstalmentOut:
    out = InstalmentOut.model_validate(row)
    out.recorded_by_name = names.get(row.recorded_by)
    out.is_overdue = (
        row.status == InstalmentStatus.PENDING.value
        and row.due_on < date.today().replace(day=1)
    )
    return out


def _detail(db, viewer: User, loan: Loan) -> LoanDetailOut:
    names = _names(db, viewer.org_id, [loan] + list(loan.instalments))
    totals = _totals(db, [loan.id])
    base = _loan_out(loan, viewer, names=names, totals=totals)
    out = LoanDetailOut(**base.model_dump())
    out.instalments = [_instalment_out(row, names) for row in loan.instalments]
    return out


def _list_out(db, viewer: User, rows) -> list[LoanOut]:
    names = _names(db, viewer.org_id, rows)
    totals = _totals(db, [row.id for row in rows])
    return [_loan_out(row, viewer, names=names, totals=totals) for row in rows]


# --------------------------------------------------------------------------- #
# Static paths first, so they are not parsed as loan ids
# --------------------------------------------------------------------------- #


@router.get("/summary", response_model=SummaryOut)
def summary(
    viewer: CurrentUser, db: DbSession, user_id: uuid.UUID | None = None
) -> SummaryOut:
    return SummaryOut(**svc.summary(db, viewer, user_id=user_id))


@router.get("/deductions", response_model=list[DeductionRowOut])
def deductions(
    viewer: CurrentUser,
    db: DbSession,
    month: date | None = Query(default=None, description="Any date in the month"),
) -> list[DeductionRowOut]:
    """What payroll would deduct in one month.

    Built before payroll exists, on purpose: this is the query a pay run will
    make, and proving the ledger against its real consumer now is cheaper than
    discovering the schedule cannot answer it later.
    """
    try:
        rows = svc.due_schedule(db, viewer, month=month)
    except svc.LoanError as error:
        _fail(error)

    loans = {
        row.id: row
        for row in db.scalars(
            select(Loan).where(Loan.id.in_({r.loan_id for r in rows} or {uuid.uuid4()}))
        )
    }
    names = _names(db, viewer.org_id, list(loans.values()))
    return [
        DeductionRowOut(
            instalment_id=row.id,
            loan_id=row.loan_id,
            user_id=loans[row.loan_id].user_id,
            user_name=names.get(loans[row.loan_id].user_id),
            loan_type=loans[row.loan_id].loan_type,
            sequence=row.sequence,
            instalment_count=loans[row.loan_id].instalment_count,
            due_on=row.due_on,
            amount=row.amount,
        )
        for row in rows
    ]


# --------------------------------------------------------------------------- #
# Loans
# --------------------------------------------------------------------------- #


@router.get("", response_model=list[LoanOut])
def list_loans(
    viewer: CurrentUser,
    db: DbSession,
    mine: bool = False,
    user_id: uuid.UUID | None = None,
    status_filter: str | None = Query(default=None, alias="status"),
) -> list[LoanOut]:
    return _list_out(
        db, viewer, svc.list_loans(db, viewer, mine=mine, user_id=user_id,
                                   status=status_filter)
    )


@router.post("", response_model=LoanDetailOut, status_code=status.HTTP_201_CREATED)
def request_loan(
    payload: LoanRequestIn, viewer: CurrentUser, request: Request, db: DbSession
) -> LoanDetailOut:
    try:
        return _detail(db, viewer, svc.request(db, viewer, payload, request_obj=request))
    except svc.LoanError as error:
        _fail(error)


@router.get("/{loan_id}", response_model=LoanDetailOut)
def read_loan(loan_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> LoanDetailOut:
    try:
        return _detail(db, viewer, svc.get_loan(db, viewer, loan_id))
    except svc.LoanError as error:
        _fail(error)


@router.post("/{loan_id}/review", response_model=LoanDetailOut)
def review(
    loan_id: uuid.UUID,
    payload: ReviewIn,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
) -> LoanDetailOut:
    """Sanction or refuse. One transition, two outcomes."""
    try:
        return _detail(
            db, viewer, svc.review(db, viewer, loan_id, payload, request_obj=request)
        )
    except svc.LoanError as error:
        _fail(error)


@router.post("/{loan_id}/disburse", response_model=LoanDetailOut)
def disburse(
    loan_id: uuid.UUID,
    payload: DisburseIn,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
) -> LoanDetailOut:
    """Record the money leaving, and build the repayment schedule."""
    try:
        return _detail(
            db, viewer, svc.disburse(db, viewer, loan_id, payload, request_obj=request)
        )
    except svc.LoanError as error:
        _fail(error)


@router.post("/{loan_id}/cancel", response_model=LoanDetailOut)
def cancel(
    loan_id: uuid.UUID, viewer: CurrentUser, request: Request, db: DbSession
) -> LoanDetailOut:
    """Withdraw a request before the money moves."""
    try:
        return _detail(db, viewer, svc.cancel(db, viewer, loan_id, request_obj=request))
    except svc.LoanError as error:
        _fail(error)


@router.post("/{loan_id}/settle", response_model=LoanDetailOut)
def settle_early(
    loan_id: uuid.UUID,
    payload: SettleIn,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
) -> LoanDetailOut:
    """Clear every remaining instalment in one payment."""
    try:
        return _detail(
            db, viewer, svc.settle_early(db, viewer, loan_id, payload, request_obj=request)
        )
    except svc.LoanError as error:
        _fail(error)


@router.post("/{loan_id}/write-off", response_model=LoanDetailOut)
def write_off(
    loan_id: uuid.UUID,
    payload: WriteOffIn,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
) -> LoanDetailOut:
    """Give up on the balance. Distinct from closing it — the money was
    forgiven, not repaid."""
    try:
        return _detail(
            db, viewer, svc.write_off(db, viewer, loan_id, payload, request_obj=request)
        )
    except svc.LoanError as error:
        _fail(error)


# --------------------------------------------------------------------------- #
# Instalments
# --------------------------------------------------------------------------- #


@router.post("/instalments/{instalment_id}/repay", response_model=LoanDetailOut)
def record_repayment(
    instalment_id: uuid.UUID,
    payload: RepaymentIn,
    viewer: CurrentUser,
    request: Request,
    db: DbSession,
) -> LoanDetailOut:
    """Mark one instalment paid, or waived.

    Returns the whole loan rather than the instalment: the outstanding balance
    and possibly the loan's status both change, and a client given only the
    instalment would have to recompute the balance — the one thing this module
    does not let a client do.
    """
    try:
        loan = svc.record_repayment(
            db, viewer, instalment_id, payload, request_obj=request
        )
        return _detail(db, viewer, loan)
    except svc.LoanError as error:
        _fail(error)
