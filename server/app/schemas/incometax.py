"""Request/response shapes for investment declarations and tax estimates.

**Amounts are integer paise.** ₹1,50,000 is `15_000_000`.

**No request body carries a verified amount from the employee's side**, and no
administrator body carries a regime. Those are the two asymmetries the whole
module rests on: HR verifies figures it did not enter, and the employee elects a
regime nobody else can change.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from app.models.incometax import Regime
from app.schemas.common import ORMModel

#: ₹1 crore in paise. A sanity bound on any single claim, to catch rupees typed
#: as paise rather than to express a rule — the statutory caps do that.
MAX_CLAIM = 1_000_000_000


class RegimeIn(BaseModel):
    regime: Regime


class ItemIn(BaseModel):
    #: "80C", "80D", "24B". Free text against a known list rather than an enum:
    #: sections are added by Finance Acts and an unrecognised one is summed
    #: rather than refused.
    section: str = Field(min_length=1, max_length=24)
    label: str | None = Field(default=None, max_length=200)
    declared_amount: int = Field(ge=0, le=MAX_CLAIM)
    note: str | None = Field(default=None, max_length=2000)

    @field_validator("section", mode="after")
    @classmethod
    def _section(cls, value: str) -> str:
        cleaned = value.strip().upper()
        if not cleaned.replace("_", "").isalnum():
            raise ValueError("a section may contain letters, digits and underscores")
        return cleaned


class ProofIn(BaseModel):
    """Points a claim at a document already in the employee's Core HR file.

    A document id rather than a file: the upload happens through Core HR, which
    owns storage and permission. Two upload paths for one person's documents is
    two places to get it wrong.
    """

    document_id: uuid.UUID


class VerifyIn(BaseModel):
    #: Defaults to the declared amount when accepting. Less is the ordinary
    #: case: declared ₹1,50,000 in April, produced receipts for ₹1,10,000.
    verified_amount: int | None = Field(default=None, ge=0, le=MAX_CLAIM)
    reject: bool = False
    note: str | None = Field(default=None, max_length=2000)


class CloseIn(BaseModel):
    #: Reopening exists because somebody always produces a receipt the day after
    #: the deadline.
    reopen: bool = False
    note: str | None = Field(default=None, max_length=2000)


class ItemOut(ORMModel):
    id: uuid.UUID
    declaration_id: uuid.UUID
    section: str
    label: str | None = None
    declared_amount: int
    #: Null means nobody has checked — different from zero, which means checked
    #: and nothing stood up.
    verified_amount: int | None = None
    status: str
    document_id: uuid.UUID | None = None
    note: str | None = None
    #: What payroll is using right now: verified if there is one, declared if
    #: not, zero if rejected. Computed server-side so the screen and the pay run
    #: cannot disagree.
    effective_amount: int = 0
    #: The statutory cap for this section, when there is one, so the form can
    #: say "₹1,50,000 of ₹3,00,000 declared will count".
    cap: int | None = None


class DeclarationOut(ORMModel):
    id: uuid.UUID
    org_id: uuid.UUID
    user_id: uuid.UUID
    financial_year: int
    regime: str
    status: str
    submitted_at: datetime | None = None
    verified_at: datetime | None = None
    note: str | None = None
    created_at: datetime

    user_name: str | None = None
    verified_by_name: str | None = None
    year_label: str = ""
    #: True when the year's slabs were carried forward rather than legislated.
    #: Surfaced so a screen can say so rather than implying certainty.
    provisional: bool = False
    items: list[ItemOut] = []

    #: Resolved server-side, like every other module here.
    can_edit: bool = False
    can_verify: bool = False


class BreakdownOut(BaseModel):
    """Every intermediate figure, because an estimate has to be checkable."""

    gross_income: int
    standard_deduction: int
    chapter_via: int
    professional_tax: int
    taxable_income: int
    tax_before_rebate: int
    rebate: int
    surcharge: int
    cess: int
    total_tax: int
    regime: str
    slab_working: list[tuple[str, int, int]] = []


class EstimateOut(BaseModel):
    """Both regimes, always — the comparison is the point of the choice."""

    chosen: str
    financial_year: int
    year_label: str
    provisional: bool
    annual_income: int
    old: BreakdownOut
    new: BreakdownOut
