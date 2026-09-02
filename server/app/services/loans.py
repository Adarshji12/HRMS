"""Loan rules: sanctioning, disbursing, and the repayment ledger.

The four that matter:

**The schedule sums to the total repayable, exactly.** ``build_schedule`` spreads
the remainder one paise at a time rather than rounding each instalment, so
twelve instalments of ₹833.33 against a ₹10,000 principal do not quietly lose
four paise — and nobody ends up owing a balance of 4 that no instalment covers.
There is a test that asserts the sum for every count from 1 to 60.

**The schedule is built at disbursement, not approval.** Approval is a promise;
the first deduction month depends on when the money actually left. A schedule
built early is anchored to a month that turns out to be wrong, and one that has
to be rebuilt is one that can be rebuilt after somebody has already paid against
it — which the unique constraint on ``(loan_id, sequence)`` exists to stop.

**Outstanding is derived.** Sum of the unpaid instalments, computed on read. A
stored copy is a second number to drift from the rows it summarises. Deliberately
the opposite of ``expense_claims.total_amount``, which is stored *because*
approval freezes it.

**Reading somebody's loan needs the people-admin capability, not line
management.** Whether a colleague borrowed money from the company is not
something a manager needs to know to manage them — the same judgement Core HR
makes about a home address, and the opposite of expenses, where a manager
approving a taxi fare obviously must see it.
"""

from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timezone

from fastapi import Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import audit
from app.core.dates import add_months
from app.services import chains, workflow
from app.models import (
    InstalmentStatus,
    Loan,
    LoanInstalment,
    LoanStatus,
    Role,
    User,
)

log = logging.getLogger(__name__)

#: The longest schedule the model's check constraint allows. Ten years is far
#: beyond anything an employer-issued advance needs, and the bound exists to
#: catch a typo (120 months entered as 1200) rather than to express policy.
MAX_INSTALMENTS = 120


class LoanError(Exception):
    """A rule said no, with a code the console can branch on."""

    def __init__(self, code: str, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------- #
# Money
# --------------------------------------------------------------------------- #


def total_repayable(principal: int, instalment_count: int, interest_rate_bps: int) -> int:
    """Principal plus simple interest, in paise.

    **Simple interest on the original principal**, pro-rated over the schedule's
    length — not reducing balance. That is a real limitation and it is stated
    rather than hidden: reducing-balance interest needs an amortisation table and
    a decision about what happens when an instalment is missed, and neither is
    worth inventing for a feature whose common case is an interest-free salary
    advance (``interest_rate_bps == 0``, which short-circuits to the principal).

    Rounded half-up at the end, once, on the whole interest figure. Rounding per
    instalment is what produces a schedule that does not add up.
    """
    if interest_rate_bps <= 0:
        return principal
    # bps of principal per annum, for instalment_count months.
    interest = principal * interest_rate_bps * instalment_count
    # 10_000 bps per unit, 12 months per year. Integer arithmetic throughout;
    # the only rounding is this division, and it happens once.
    denominator = 10_000 * 12
    return principal + (interest + denominator // 2) // denominator


def split_amount(total: int, parts: int) -> list[int]:
    """``total`` divided into ``parts``, summing to exactly ``total``.

    The remainder is spread one paise at a time across the *earliest*
    instalments rather than dumped on the last. Two reasons: every instalment
    then differs from every other by at most one paise, so the employee sees a
    predictable figure; and a final instalment inflated by the remainder is the
    one people query, because it is the one that does not match what they were
    told.
    """
    if parts <= 0:
        raise ValueError("parts must be positive")
    base, remainder = divmod(total, parts)
    return [base + (1 if index < remainder else 0) for index in range(parts)]


def build_schedule(
    *, total: int, count: int, first_due: date
) -> list[tuple[int, date, int]]:
    """``(sequence, due_on, amount)`` for each instalment.

    Due dates are the first of each month, stepping with ``core.dates.add_months``
    so a first due date of 31 January does not produce an exception in February.
    Stored as the first of the month because a deduction happens in a pay cycle,
    not on a particular day, and a day-of-month would imply a precision payroll
    does not have.
    """
    anchor = first_due.replace(day=1)
    amounts = split_amount(total, count)
    return [
        (index + 1, add_months(anchor, index), amount)
        for index, amount in enumerate(amounts)
    ]


def outstanding(db: Session, loan_id: uuid.UUID) -> int:
    """Sum of the unpaid instalments. Derived, never stored."""
    return int(
        db.scalar(
            select(func.coalesce(func.sum(LoanInstalment.amount), 0)).where(
                LoanInstalment.loan_id == loan_id,
                LoanInstalment.status == InstalmentStatus.PENDING.value,
            )
        )
        or 0
    )


def repaid(db: Session, loan_id: uuid.UUID) -> int:
    """What has actually been recovered — paid instalments only.

    Waived instalments are excluded on purpose: they settle the schedule but the
    money never arrived, and reporting a written-down amount as recovered would
    overstate collections.
    """
    return int(
        db.scalar(
            select(func.coalesce(func.sum(LoanInstalment.paid_amount), 0)).where(
                LoanInstalment.loan_id == loan_id,
                LoanInstalment.status == InstalmentStatus.PAID.value,
            )
        )
        or 0
    )


# --------------------------------------------------------------------------- #
# Permissions
# --------------------------------------------------------------------------- #


def can_approve(viewer: User) -> bool:
    """Sanction a loan. Administrators only — not managers.

    Deliberately narrower than expense approval. Approving a colleague's taxi
    fare is line management; committing the company to lend money is not, and
    the role check is where that distinction lives rather than in a comment.
    """
    return viewer.role in (Role.OWNER.value, Role.ADMIN.value) and viewer.can_approve_loans


def can_disburse(viewer: User) -> bool:
    """Pay out a sanctioned loan and record repayments against it."""
    return viewer.role in (Role.OWNER.value, Role.ADMIN.value) and viewer.can_disburse_loans


def is_administrator(viewer: User) -> bool:
    """May see other people's loans at all."""
    return can_approve(viewer) or can_disburse(viewer)


def get_loan(db: Session, viewer: User, loan_id: uuid.UUID) -> Loan:
    """One loan, if this caller may see it.

    404 across a tenant boundary; 403 inside it. A 403 on a cross-tenant id
    would confirm the id exists somewhere.
    """
    row = db.get(Loan, loan_id)
    if row is None or row.org_id != viewer.org_id:
        raise LoanError("not_found", "Loan not found", 404)
    if row.user_id == viewer.id or is_administrator(viewer):
        return row
    raise LoanError("not_permitted", "You may not view this loan.", 403)


# --------------------------------------------------------------------------- #
# Requesting
# --------------------------------------------------------------------------- #


def request(
    db: Session, viewer: User, payload, *, request_obj: Request | None = None
) -> Loan:
    """Ask for a loan. Your own unless an administrator files for somebody.

    One open request per type at a time. Not a policy engine — the real problem
    it solves is somebody clicking submit twice and finance seeing two
    identical requests with no way to tell which is the real one. A *disbursed*
    loan of the same type does not block a new request, because taking a second
    advance while repaying the first is an ordinary thing to want.
    """
    subject = viewer
    on_behalf = False
    if payload.user_id is not None and payload.user_id != viewer.id:
        if not is_administrator(viewer):
            raise LoanError("not_permitted", "You may only request for yourself.", 403)
        subject = db.get(User, payload.user_id)
        if subject is None or subject.org_id != viewer.org_id:
            raise LoanError("employee_not_found", "Employee not found", 404)
        on_behalf = True

    pending = db.scalar(
        select(Loan).where(
            Loan.org_id == viewer.org_id,
            Loan.user_id == subject.id,
            Loan.loan_type == payload.loan_type.value,
            Loan.status.in_(
                (LoanStatus.REQUESTED.value, LoanStatus.APPROVED.value)
            ),
        )
    )
    if pending is not None:
        raise LoanError(
            "request_pending",
            "There is already an open request of this type. Wait for it to be "
            "decided, or cancel it first.",
            409,
        )

    row = Loan(
        org_id=viewer.org_id,
        user_id=subject.id,
        created_by_user_id=viewer.id,
        loan_type=payload.loan_type.value,
        principal=payload.principal,
        instalment_count=payload.instalment_count,
        interest_rate_bps=payload.interest_rate_bps,
        purpose=(payload.purpose or "").strip() or None,
        status=LoanStatus.REQUESTED.value,
        requested_on=date.today(),
    )
    db.add(row)
    db.flush()
    # A chain begins when the request does, not when somebody first looks at
    # it: written lazily, its first rung would be consumed by whoever happened
    # to open the queue. Does nothing when this flow has no chain configured,
    # which is most companies.
    chains.start_for(db, kind="loan", record_id=row.id, subject=subject, record=row)
    audit(db, org_id=viewer.org_id, actor=viewer, action="loans.requested",
          request=request_obj, target_type="loan", target_id=str(row.id),
          detail={"for": str(subject.id), "on_behalf": on_behalf,
                  "type": row.loan_type, "principal": row.principal,
                  "instalments": row.instalment_count})
    db.commit()
    db.refresh(row)
    return row


def cancel(
    db: Session, viewer: User, loan_id: uuid.UUID, *, request_obj: Request | None = None
) -> Loan:
    """Withdraw a request before the money moves.

    Allowed while ``requested`` or ``approved`` — an approved-but-undisbursed
    loan is still just a promise, and an employee who no longer needs it should
    be able to say so. Once disbursed there is a balance, and the way out of a
    balance is repayment or a write-off, not a cancel.
    """
    loan = get_loan(db, viewer, loan_id)
    if loan.user_id != viewer.id and not is_administrator(viewer):
        raise LoanError("not_permitted", "This is not your loan.", 403)
    if loan.status_enum not in (LoanStatus.REQUESTED, LoanStatus.APPROVED):
        raise LoanError(
            "not_cancellable",
            f"A {loan.status} loan cannot be cancelled.",
            409,
        )

    loan.status = LoanStatus.CANCELLED.value
    audit(db, org_id=viewer.org_id, actor=viewer, action="loans.cancelled",
          request=request_obj, target_type="loan", target_id=str(loan.id),
          detail={"for": str(loan.user_id)})
    db.commit()
    db.refresh(loan)
    return loan


# --------------------------------------------------------------------------- #
# Sanctioning
# --------------------------------------------------------------------------- #


def review(
    db: Session,
    viewer: User,
    loan_id: uuid.UUID,
    payload,
    *,
    request_obj: Request | None = None,
) -> Loan:
    """Sanction or refuse a request.

    ``approved_principal`` may be lower than what was asked for — approving a
    smaller amount is routine — and it is a separate column so the request
    survives intact. It may not be *higher*: lending more than somebody asked
    for is not an approval, and if it is genuinely intended it should be a new
    request that says so.
    """
    if not can_approve(viewer):
        raise LoanError("not_permitted", "You may not sanction loans.", 403)
    loan = get_loan(db, viewer, loan_id)
    approve = payload.status == LoanStatus.APPROVED.value

    def sanction() -> None:
        """What is being sanctioned — this flow's business, not the kernel's.

        Runs before the loan is stamped, so a refused amount leaves the request
        undecided rather than approved-and-wrong.
        """
        sanctioned = payload.approved_principal or loan.principal
        if sanctioned > loan.principal:
            raise LoanError(
                "over_request",
                "You cannot sanction more than was requested.",
            )
        if sanctioned <= 0:
            raise LoanError("zero_principal", "A sanctioned amount must be positive.")
        loan.approved_principal = sanctioned
        if payload.instalment_count is not None:
            if not 0 < payload.instalment_count <= MAX_INSTALMENTS:
                raise LoanError(
                    "bad_instalments",
                    f"Instalments must be between 1 and {MAX_INSTALMENTS}.",
                )
            loan.instalment_count = payload.instalment_count

    # Not-pending, self-review, reason-on-refusal, the stamp and the audit row
    # are the kernel's. `workflow.LOAN` is where this flow's answers live, next
    # to the other five flows'.
    workflow.decide(
        db, policy=workflow.LOAN, record=loan, reviewer=viewer,
        approve=approve, note=payload.review_note, request=request_obj,
        on_approve=sanction,
        detail={"requested": loan.principal,
                "sanctioned": loan.approved_principal,
                "instalments": loan.instalment_count},
    )
    db.commit()
    db.refresh(loan)
    return loan


# --------------------------------------------------------------------------- #
# Disbursing — where the schedule is created
# --------------------------------------------------------------------------- #


def disburse(
    db: Session,
    viewer: User,
    loan_id: uuid.UUID,
    payload,
    *,
    request_obj: Request | None = None,
) -> Loan:
    """Record the money leaving, and build the repayment schedule.

    The schedule is created here and nowhere else. ``first_due_on`` defaults to
    the month *after* disbursement: deducting in the same month the advance was
    paid out is almost never what was agreed, and defaulting to it would produce
    a first deduction the employee did not expect.

    Idempotent by refusal rather than by silence: a loan already active raises,
    because a second disbursement of the same loan is either a duplicate payment
    or a schedule about to be rebuilt underneath existing repayments.
    """
    if not can_disburse(viewer):
        raise LoanError("not_permitted", "You may not disburse loans.", 403)
    loan = get_loan(db, viewer, loan_id)

    if loan.status_enum is not LoanStatus.APPROVED:
        raise LoanError(
            "not_approved",
            f"This loan is {loan.status}; only a sanctioned loan can be disbursed.",
            409,
        )

    principal = loan.approved_principal or loan.principal
    total = total_repayable(principal, loan.instalment_count, loan.interest_rate_bps)
    disbursed_on = payload.disbursed_on or date.today()
    first_due = payload.first_due_on or add_months(disbursed_on.replace(day=1), 1)

    for sequence, due_on, amount in build_schedule(
        total=total, count=loan.instalment_count, first_due=first_due
    ):
        db.add(
            LoanInstalment(
                org_id=loan.org_id,
                loan_id=loan.id,
                sequence=sequence,
                due_on=due_on,
                amount=amount,
                status=InstalmentStatus.PENDING.value,
            )
        )

    loan.status = LoanStatus.ACTIVE.value
    loan.disbursed_on = disbursed_on
    loan.disbursed_by = viewer.id
    loan.disbursement_reference = (payload.reference or "").strip() or None

    audit(db, org_id=viewer.org_id, actor=viewer, action="loans.disbursed",
          request=request_obj, target_type="loan", target_id=str(loan.id),
          detail={"for": str(loan.user_id), "principal": principal,
                  "total_repayable": total, "instalments": loan.instalment_count,
                  "first_due": first_due.isoformat(),
                  "reference": loan.disbursement_reference})
    db.commit()
    db.refresh(loan)
    return loan


# --------------------------------------------------------------------------- #
# Repayment
# --------------------------------------------------------------------------- #


def _maybe_close(db: Session, loan: Loan, *, actor: User) -> bool:
    """Close the loan when nothing is pending. Returns whether it closed.

    Automatic, so nobody has to remember and no report has to guess. Checked
    after every instalment mutation rather than on a schedule, because the state
    "fully repaid but still listed as active" is exactly what an employee
    disputes.
    """
    remaining = db.scalar(
        select(func.count(LoanInstalment.id)).where(
            LoanInstalment.loan_id == loan.id,
            LoanInstalment.status == InstalmentStatus.PENDING.value,
        )
    ) or 0
    if remaining:
        return False
    loan.status = LoanStatus.CLOSED.value
    loan.closed_on = date.today()
    audit(db, org_id=loan.org_id, actor=actor, action="loans.closed",
          target_type="loan", target_id=str(loan.id),
          detail={"for": str(loan.user_id)})
    return True


def get_instalment(db: Session, viewer: User, instalment_id: uuid.UUID) -> LoanInstalment:
    row = db.get(LoanInstalment, instalment_id)
    if row is None or row.org_id != viewer.org_id:
        raise LoanError("instalment_not_found", "Instalment not found", 404)
    # Authorised through its loan, so the instalment routes cannot drift from
    # the loan's own rule.
    get_loan(db, viewer, row.loan_id)
    return row


def record_repayment(
    db: Session,
    viewer: User,
    instalment_id: uuid.UUID,
    payload,
    *,
    request_obj: Request | None = None,
) -> Loan:
    """Mark one instalment paid, or waived.

    ``paid_amount`` defaults to the scheduled figure but may differ: a
    part-payment is a real event, and forcing it to equal the schedule would mean
    either refusing it or recording something untrue. What it must not do is
    silently change what is still owed — the instalment closes either way, and a
    shortfall is visible as ``paid_amount < amount`` rather than reopening the
    row.
    """
    if not can_disburse(viewer):
        raise LoanError("not_permitted", "You may not record repayments.", 403)
    instalment = get_instalment(db, viewer, instalment_id)
    loan = db.get(Loan, instalment.loan_id)

    if loan.status_enum is not LoanStatus.ACTIVE:
        raise LoanError(
            "loan_not_active",
            f"This loan is {loan.status}; repayments apply to an active loan.",
            409,
        )
    if instalment.status_enum.is_settled:
        raise LoanError(
            "already_settled",
            f"Instalment {instalment.sequence} is already {instalment.status}.",
            409,
        )
    if payload.waive and not (payload.note or "").strip():
        raise LoanError(
            "note_required",
            "Say why it is being waived — a written-down amount needs a reason on "
            "the record.",
        )

    if payload.waive:
        instalment.status = InstalmentStatus.WAIVED.value
        # No paid_amount: nothing arrived. Keeping it null is what stops a
        # waiver being counted as money recovered.
        instalment.paid_amount = None
    else:
        instalment.status = InstalmentStatus.PAID.value
        instalment.paid_amount = (
            payload.paid_amount if payload.paid_amount is not None else instalment.amount
        )
    instalment.paid_on = payload.paid_on or date.today()
    instalment.recorded_by = viewer.id
    instalment.reference = (payload.reference or "").strip() or None
    instalment.note = (payload.note or "").strip() or None
    db.flush()

    closed = _maybe_close(db, loan, actor=viewer)
    audit(db, org_id=viewer.org_id, actor=viewer,
          action="loans.instalment_waived" if payload.waive else "loans.repayment_recorded",
          request=request_obj, target_type="loan_instalment", target_id=str(instalment.id),
          detail={"for": str(loan.user_id), "loan_id": str(loan.id),
                  "sequence": instalment.sequence, "amount": instalment.amount,
                  "paid": instalment.paid_amount, "closed_loan": closed,
                  "reference": instalment.reference})
    db.commit()
    db.refresh(loan)
    return loan


def settle_early(
    db: Session,
    viewer: User,
    loan_id: uuid.UUID,
    payload,
    *,
    request_obj: Request | None = None,
) -> Loan:
    """Close out every remaining instalment in one payment.

    Each instalment is still marked individually rather than the loan being
    stamped closed with a lump sum. The ledger has to keep saying what was owed
    per month; a single "settled" flag would leave the schedule half-pending
    forever and every per-month report wrong.
    """
    if not can_disburse(viewer):
        raise LoanError("not_permitted", "You may not record repayments.", 403)
    loan = get_loan(db, viewer, loan_id)
    if loan.status_enum is not LoanStatus.ACTIVE:
        raise LoanError("loan_not_active", f"This loan is {loan.status}.", 409)

    pending = list(
        db.scalars(
            select(LoanInstalment)
            .where(
                LoanInstalment.loan_id == loan.id,
                LoanInstalment.status == InstalmentStatus.PENDING.value,
            )
            .order_by(LoanInstalment.sequence)
        )
    )
    if not pending:
        raise LoanError("nothing_outstanding", "Nothing is outstanding on this loan.", 409)

    paid_on = payload.paid_on or date.today()
    total = 0
    for instalment in pending:
        instalment.status = InstalmentStatus.PAID.value
        instalment.paid_amount = instalment.amount
        instalment.paid_on = paid_on
        instalment.recorded_by = viewer.id
        instalment.reference = (payload.reference or "").strip() or None
        instalment.note = "Early settlement"
        total += instalment.amount
    db.flush()

    _maybe_close(db, loan, actor=viewer)
    loan.closure_note = "Settled early"
    audit(db, org_id=viewer.org_id, actor=viewer, action="loans.settled_early",
          request=request_obj, target_type="loan", target_id=str(loan.id),
          detail={"for": str(loan.user_id), "instalments": len(pending),
                  "amount": total, "reference": (payload.reference or "").strip() or None})
    db.commit()
    db.refresh(loan)
    return loan


def write_off(
    db: Session,
    viewer: User,
    loan_id: uuid.UUID,
    payload,
    *,
    request_obj: Request | None = None,
) -> Loan:
    """Give up on recovering the balance.

    Kept distinct from ``CLOSED`` because the money was forgiven rather than
    repaid, and that difference matters to accounting and to any future lending
    decision. The instalments are waived rather than deleted — what was owed is
    part of the record of what happened.
    """
    if not can_approve(viewer):
        raise LoanError(
            "not_permitted", "Only a sanctioning administrator may write off a loan.", 403
        )
    loan = get_loan(db, viewer, loan_id)
    if loan.status_enum is not LoanStatus.ACTIVE:
        raise LoanError("loan_not_active", f"This loan is {loan.status}.", 409)
    if not (payload.note or "").strip():
        raise LoanError("note_required", "A write-off needs a reason on the record.")

    written = 0
    for instalment in db.scalars(
        select(LoanInstalment).where(
            LoanInstalment.loan_id == loan.id,
            LoanInstalment.status == InstalmentStatus.PENDING.value,
        )
    ):
        instalment.status = InstalmentStatus.WAIVED.value
        instalment.paid_on = date.today()
        instalment.recorded_by = viewer.id
        instalment.note = payload.note.strip()
        written += instalment.amount

    loan.status = LoanStatus.WRITTEN_OFF.value
    loan.closed_on = date.today()
    loan.closure_note = payload.note.strip()

    audit(db, org_id=viewer.org_id, actor=viewer, action="loans.written_off",
          request=request_obj, target_type="loan", target_id=str(loan.id),
          detail={"for": str(loan.user_id), "amount": written,
                  "reason": loan.closure_note})
    db.commit()
    db.refresh(loan)
    return loan


# --------------------------------------------------------------------------- #
# Reading
# --------------------------------------------------------------------------- #


def list_loans(
    db: Session,
    viewer: User,
    *,
    mine: bool = False,
    user_id: uuid.UUID | None = None,
    status: str | None = None,
) -> list[Loan]:
    """Loans this caller may see.

    An employee gets their own, always. Everybody else's needs the administrator
    capability — see the module docstring on why line management buys nothing
    here.
    """
    statement = select(Loan).where(Loan.org_id == viewer.org_id)
    if mine or not is_administrator(viewer):
        statement = statement.where(Loan.user_id == viewer.id)
    elif user_id is not None:
        statement = statement.where(Loan.user_id == user_id)
    if status:
        statement = statement.where(Loan.status == status)
    return list(db.scalars(statement.order_by(Loan.requested_on.desc(), Loan.created_at.desc())))


def due_schedule(db: Session, viewer: User, *, month: date | None = None) -> list[LoanInstalment]:
    """Instalments due in one month across the company — what payroll deducts.

    The reason ``ix_loan_instalments_due`` exists. This is the query a pay run
    will make once payroll lands, and it is built now so the ledger is proven
    against it before anything depends on it.
    """
    if not can_disburse(viewer):
        raise LoanError("not_permitted", "You may not read the deduction schedule.", 403)
    anchor = (month or date.today()).replace(day=1)
    return list(
        db.scalars(
            select(LoanInstalment)
            .join(Loan, Loan.id == LoanInstalment.loan_id)
            .where(
                LoanInstalment.org_id == viewer.org_id,
                LoanInstalment.due_on == anchor,
                LoanInstalment.status == InstalmentStatus.PENDING.value,
                Loan.status == LoanStatus.ACTIVE.value,
            )
            .order_by(LoanInstalment.due_on)
        )
    )


def summary(db: Session, viewer: User, *, user_id: uuid.UUID | None = None) -> dict:
    """Totals for the tiles: sanctioned, outstanding, recovered.

    ``outstanding`` is the number that matters — what the company is still owed,
    or what this employee still owes, depending on who is asking.
    """
    scope = select(Loan.id).where(Loan.org_id == viewer.org_id)
    subject = user_id if user_id is not None else (
        None if is_administrator(viewer) else viewer.id
    )
    if subject is not None:
        scope = scope.where(Loan.user_id == subject)

    loan_ids = [row for row in db.scalars(scope)]
    if not loan_ids:
        return {
            "by_status": {}, "outstanding_amount": 0, "repaid_amount": 0,
            "active_count": 0, "awaiting_decision": 0, "currency": "INR",
        }

    by_status = {
        row[0]: int(row[1])
        for row in db.execute(
            select(Loan.status, func.count(Loan.id))
            .where(Loan.id.in_(loan_ids))
            .group_by(Loan.status)
        )
    }
    outstanding_total = int(
        db.scalar(
            select(func.coalesce(func.sum(LoanInstalment.amount), 0)).where(
                LoanInstalment.loan_id.in_(loan_ids),
                LoanInstalment.status == InstalmentStatus.PENDING.value,
            )
        ) or 0
    )
    repaid_total = int(
        db.scalar(
            select(func.coalesce(func.sum(LoanInstalment.paid_amount), 0)).where(
                LoanInstalment.loan_id.in_(loan_ids),
                LoanInstalment.status == InstalmentStatus.PAID.value,
            )
        ) or 0
    )
    return {
        "by_status": by_status,
        "outstanding_amount": outstanding_total,
        "repaid_amount": repaid_total,
        "active_count": by_status.get(LoanStatus.ACTIVE.value, 0),
        "awaiting_decision": by_status.get(LoanStatus.REQUESTED.value, 0),
        "currency": "INR",
    }
