"""Request/response shapes for expense claims.

**Amounts are integer paise in every direction.** No float ever crosses this
boundary — a rupee amount as a float is a rounding error waiting to become a
reimbursement somebody has to chase. The console formats for display; the wire
carries integers.

**No request body carries a total.** ``ClaimIn`` has no ``total_amount`` and
``ClaimUpdate`` cannot set one: the total is summed from the lines server-side.
A total the client sends is a total the client can lie about, and the lie is
money.

**No request body carries an identity for a decision.** ``ReviewIn`` has no
``reviewed_by``, ``ReimburseIn`` has no ``reimbursed_by``. Both come from the
authenticated caller, so a decision cannot be signed as somebody else.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, Field, field_validator

from app.models.expenses import ClaimStatus
from app.schemas.common import ORMModel

#: A hard ceiling on any single line, in paise — ₹10,00,000. Not a policy, a
#: sanity bound: it catches the rupees-typed-as-paise mistake (and its inverse)
#: at the boundary rather than after somebody approves a claim two orders of
#: magnitude out.
MAX_LINE_PAISE = 100_000_000


class CategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=400)
    requires_receipt: bool = True
    #: Paise. None means no ceiling — deliberately not 0, which would refuse
    #: every claim in the category.
    max_amount: int | None = Field(default=None, gt=0, le=MAX_LINE_PAISE)
    is_active: bool = True


class CategoryUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=400)
    requires_receipt: bool | None = None
    max_amount: int | None = Field(default=None, gt=0, le=MAX_LINE_PAISE)
    is_active: bool | None = None


class CategoryOut(ORMModel):
    id: uuid.UUID
    org_id: uuid.UUID
    name: str
    description: str | None = None
    requires_receipt: bool
    max_amount: int | None = None
    is_active: bool
    #: So the settings screen can explain why a category cannot be deleted
    #: before the attempt fails on a foreign key.
    line_count: int = 0


class ClaimIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    note: str | None = Field(default=None, max_length=4000)
    project_id: uuid.UUID | None = None
    #: Present only for filing on somebody's behalf, which needs the approver
    #: permission. Absent means "me" — the ordinary case, and the one an
    #: employee's console never sends.
    user_id: uuid.UUID | None = None


class ClaimUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    note: str | None = Field(default=None, max_length=4000)
    project_id: uuid.UUID | None = None


class LineIn(BaseModel):
    category_id: uuid.UUID
    spent_on: date
    description: str = Field(min_length=1, max_length=300)
    merchant: str | None = Field(default=None, max_length=160)
    #: Paise, strictly positive. A zero-amount line is a note, not an expense.
    amount: int = Field(gt=0, le=MAX_LINE_PAISE)

    @field_validator("description", mode="after")
    @classmethod
    def _described(cls, value: str) -> str:
        # min_length=1 accepts "   ", which is a line a reviewer cannot assess.
        if not value.strip():
            raise ValueError("say what the expense was for")
        return value


class LineUpdate(BaseModel):
    category_id: uuid.UUID | None = None
    spent_on: date | None = None
    description: str | None = Field(default=None, min_length=1, max_length=300)
    merchant: str | None = Field(default=None, max_length=160)
    amount: int | None = Field(default=None, gt=0, le=MAX_LINE_PAISE)


class LineOut(ORMModel):
    id: uuid.UUID
    claim_id: uuid.UUID
    category_id: uuid.UUID
    spent_on: date
    description: str
    merchant: str | None = None
    amount: int
    receipt_name: str | None = None
    receipt_type: str | None = None
    receipt_size: int = 0
    created_at: datetime

    # Deliberately absent: receipt_key. A client holding the key would not need
    # the permission check on the download route, which is the whole point of
    # having one.
    category_name: str | None = None
    has_receipt: bool = False
    #: Whether this line's category demands one, so the UI can mark the gap
    #: before submission is refused.
    receipt_required: bool = False


class ReviewIn(BaseModel):
    #: Approve or reject only. ``submitted`` is not an accepted input:
    #: un-deciding a claim is not a decision, it is the erasure of one.
    status: str = Field(pattern=r"^(approved|rejected)$")
    review_note: str | None = Field(default=None, max_length=2000)


class ReimburseIn(BaseModel):
    #: A UTR, a payroll cycle, a cheque number — whatever finance can trace it
    #: by. Free text because every company answers this differently.
    payment_reference: str | None = Field(default=None, max_length=120)


class ClaimOut(ORMModel):
    id: uuid.UUID
    org_id: uuid.UUID
    user_id: uuid.UUID
    title: str
    note: str | None = None
    project_id: uuid.UUID | None = None
    status: str
    total_amount: int
    currency: str = "INR"
    approved_amount: int | None = None
    submitted_at: datetime | None = None
    reviewed_at: datetime | None = None
    review_note: str | None = None
    reimbursed_at: datetime | None = None
    payment_reference: str | None = None
    created_at: datetime

    #: Derived, so no client joins.
    user_name: str | None = None
    reviewer_name: str | None = None
    reimbursed_by_name: str | None = None
    created_by_name: str | None = None
    project_name: str | None = None
    line_count: int = 0

    #: What the caller may do with this claim, resolved server-side. The console
    #: renders from these rather than re-deriving the rule from a role and three
    #: flags — the UI's copy of a permission rule is the one nobody tests.
    can_edit: bool = False
    can_submit: bool = False
    can_review: bool = False
    can_reimburse: bool = False
    can_cancel: bool = False


class ClaimDetailOut(ClaimOut):
    lines: list[LineOut] = []


class SummaryOut(BaseModel):
    by_status: dict[str, dict] = {}
    #: Approved but not yet paid — what somebody is owed right now.
    outstanding_amount: int = 0
    outstanding_count: int = 0
    awaiting_review: int = 0
    currency: str = "INR"
