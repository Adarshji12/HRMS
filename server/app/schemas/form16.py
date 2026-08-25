"""Request/response shapes for Form 16 and the year-end reconciliation.

**All money is integer paise.**

`ReconciliationOut` and `Form16Out` carry the same figures on purpose: the first
is what the year *currently* adds up to and moves as March payroll is corrected;
the second is what was frozen onto a certificate. Naming them the same makes the
comparison obvious, and keeping them as separate models makes it impossible to
render one where the other belongs.

**No response carries a full PAN.** `employee_pan_masked` is what the row holds;
the full number is rendered onto the certificate itself, from the encrypted value
via Core HR's decryption, and never enters a JSON payload a browser might cache.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, Field

from app.schemas.common import ORMModel


class IssueIn(BaseModel):
    financial_year: int = Field(ge=2000, le=2100)
    note: str | None = Field(default=None, max_length=2000)


class ReconciliationOut(BaseModel):
    """What a year adds up to right now — recomputed on every read."""

    user_id: uuid.UUID
    user_name: str
    financial_year: int
    year_label: str
    #: True when the year's slabs were carried forward rather than legislated.
    provisional: bool = False
    #: How many months of approved payroll this covers. A mid-year joiner has
    #: fewer, and a reconciliation that implied a full year would be wrong.
    months_covered: int

    gross_salary: int
    standard_deduction: int
    professional_tax: int
    chapter_via: int
    taxable_income: int
    total_tax: int
    tds_deducted: int
    #: Positive: still owed, and March must take it. Negative: over-deducted —
    #: payroll cannot refund TDS, so the employee claims it on their return.
    balance: int
    employee_pf: int
    employer_pf: int
    regime: str
    age_band: str
    #: Whether a certificate has already been issued for the year.
    issued: bool = False
    currency: str = "INR"


class Form16Out(ORMModel):
    """A frozen certificate. Every figure was copied at issue."""

    id: uuid.UUID
    org_id: uuid.UUID
    user_id: uuid.UUID
    financial_year: int
    #: 1 for the original. A correction is revision 2 with its own reference.
    revision: int
    reference_no: str
    status: str

    gross_salary: int
    standard_deduction: int
    professional_tax: int
    chapter_via: int
    taxable_income: int
    tax_before_rebate: int
    rebate: int
    surcharge: int
    cess: int
    total_tax: int
    tds_deducted: int
    balance: int
    employer_pf: int
    employee_pf: int

    regime: str
    age_band: str
    months_covered: int

    employee_name: str | None = None
    #: Masked. The full number appears only on the rendered certificate.
    employee_pan_masked: str | None = None
    designation: str | None = None
    employer_name: str | None = None

    issued_on: date
    #: Whether the filed copy reached the employee's document record. Filing is
    #: a side effect allowed to fail, so a screen must be able to say so.
    document_id: uuid.UUID | None = None
    note: str | None = None
    created_at: datetime
    currency: str = "INR"
