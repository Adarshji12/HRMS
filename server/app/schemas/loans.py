"""Request/response shapes for loans and advances.

**Amounts are integer paise; the rate is integer basis points.** No float
crosses this boundary in either direction — a rate as a float picks up an error
on its way into an interest calculation, and 12% as `0.12` is the kind of value
that ends up applied twice.

**No response carries a stored outstanding balance**, because there isn't one.
`outstanding_amount` on `LoanOut` is computed per request from the unpaid
instalments. A field that looks like a column but is derived is worth saying out
loud, because the temptation to "cache it for performance" is what makes a
balance drift from its own ledger.

**No request body carries an identity for a decision.** `ReviewIn` has no
`reviewed_by`, `DisburseIn` has no `disbursed_by`, `RepaymentIn` has no
`recorded_by`. All three come from the authenticated caller.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, Field, field_validator

from app.models.loans import LoanType
from app.schemas.common import ORMModel

#: ₹50,00,000 in paise. A sanity bound, not policy: it catches rupees typed as
#: paise (and the inverse) at the boundary rather than after somebody sanctions
#: a loan two orders of magnitude out.
MAX_PRINCIPAL_PAISE = 500_000_000

#: 100% per annum. Above this is a typo, not a rate.
MAX_RATE_BPS = 10_000


class LoanRequestIn(BaseModel):
    loan_type: LoanType = LoanType.SALARY_ADVANCE
    #: Paise.
    principal: int = Field(gt=0, le=MAX_PRINCIPAL_PAISE)
    instalment_count: int = Field(gt=0, le=120)
    #: Basis points. 0 — an interest-free advance — is the common case and the
    #: default, and it short-circuits the interest calculation entirely.
    interest_rate_bps: int = Field(default=0, ge=0, le=MAX_RATE_BPS)
    purpose: str | None = Field(default=None, max_length=2000)
    #: Present only when an administrator files for somebody else. Absent means
    #: "me" — the ordinary case, and the one an employee's console never sends.
    user_id: uuid.UUID | None = None


class ReviewIn(BaseModel):
    #: Sanction or refuse only. ``requested`` is not an accepted input:
    #: un-deciding a request is not a decision, it is the erasure of one.
    status: str = Field(pattern=r"^(approved|rejected)$")
    review_note: str | None = Field(default=None, max_length=2000)
    #: Sanctioning less than was asked for is routine. More is refused by the
    #: service — lending above the request is not an approval.
    approved_principal: int | None = Field(default=None, gt=0, le=MAX_PRINCIPAL_PAISE)
    #: Rescheduling at sanction time, e.g. six instalments instead of three.
    instalment_count: int | None = Field(default=None, gt=0, le=120)


class DisburseIn(BaseModel):
    #: Defaults to today. Backdating is allowed: money often leaves before
    #: anybody records it, and the audit row carries the real timestamp anyway.
    disbursed_on: date | None = None
    #: Defaults to the month *after* disbursement. Deducting in the same month
    #: the advance was paid out is almost never what was agreed.
    first_due_on: date | None = None
    reference: str | None = Field(default=None, max_length=120)


class RepaymentIn(BaseModel):
    #: Defaults to the scheduled amount. A part-payment is a real event and is
    #: recorded as one rather than being refused or rounded up.
    paid_amount: int | None = Field(default=None, gt=0, le=MAX_PRINCIPAL_PAISE)
    paid_on: date | None = None
    reference: str | None = Field(default=None, max_length=120)
    #: Waive instead of collect. Requires a note — a written-down amount needs a
    #: reason on the record.
    waive: bool = False
    note: str | None = Field(default=None, max_length=2000)


class SettleIn(BaseModel):
    paid_on: date | None = None
    reference: str | None = Field(default=None, max_length=120)


class WriteOffIn(BaseModel):
    note: str = Field(min_length=1, max_length=2000)

    @field_validator("note", mode="after")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("a write-off needs a reason on the record")
        return value


class InstalmentOut(ORMModel):
    id: uuid.UUID
    loan_id: uuid.UUID
    sequence: int
    due_on: date
    amount: int
    status: str
    paid_amount: int | None = None
    paid_on: date | None = None
    reference: str | None = None
    note: str | None = None

    recorded_by_name: str | None = None
    #: Pending and past its month. Computed server-side so "overdue" means one
    #: thing on the ledger, the tile and the report.
    is_overdue: bool = False


class LoanOut(ORMModel):
    id: uuid.UUID
    org_id: uuid.UUID
    user_id: uuid.UUID
    loan_type: str
    principal: int
    approved_principal: int | None = None
    instalment_count: int
    interest_rate_bps: int
    purpose: str | None = None
    status: str
    requested_on: date
    reviewed_at: datetime | None = None
    review_note: str | None = None
    disbursed_on: date | None = None
    disbursement_reference: str | None = None
    closed_on: date | None = None
    closure_note: str | None = None
    created_at: datetime

    #: Derived, so no client joins.
    user_name: str | None = None
    reviewer_name: str | None = None
    disbursed_by_name: str | None = None
    #: Present only when somebody else filed the request.
    created_by_name: str | None = None

    #: Computed per request from the instalments — there is no such column. See
    #: the module docstring.
    total_repayable: int = 0
    outstanding_amount: int = 0
    repaid_amount: int = 0
    instalments_paid: int = 0
    instalments_total: int = 0
    next_due_on: date | None = None
    currency: str = "INR"

    #: What the caller may do, resolved server-side. The console renders from
    #: these rather than re-deriving the rule from a role and two flags.
    can_review: bool = False
    can_disburse: bool = False
    can_record_repayment: bool = False
    can_cancel: bool = False
    can_write_off: bool = False


class LoanDetailOut(LoanOut):
    instalments: list[InstalmentOut] = []


class SummaryOut(BaseModel):
    by_status: dict[str, int] = {}
    #: What is still owed — to the company, or by this employee.
    outstanding_amount: int = 0
    repaid_amount: int = 0
    active_count: int = 0
    awaiting_decision: int = 0
    currency: str = "INR"


class DeductionRowOut(BaseModel):
    """One line of what payroll would deduct in a given month."""

    instalment_id: uuid.UUID
    loan_id: uuid.UUID
    user_id: uuid.UUID
    user_name: str | None = None
    loan_type: str
    sequence: int
    instalment_count: int
    due_on: date
    amount: int
