"""Shapes for the payroll register and the filing endpoints.

Only the register has a JSON shape — every other output here is a file, and a
file has no schema beyond its header row.

**Register amounts stay in paise on the wire**, like everywhere else in this
system; the CSV converts to rupees at its own edge because a spreadsheet is read
by a person. Two different edges, two different choices, both deliberate.
"""

from __future__ import annotations

import uuid
from datetime import date

from pydantic import BaseModel


class RegisterRowOut(BaseModel):
    user_id: uuid.UUID
    name: str
    employee_code: str | None = None
    payable_days: int
    month_days: int
    #: Keyed by payslip line code. Sparse — not every employee has every
    #: component, which is why the column order is carried separately.
    earnings: dict[str, int] = {}
    deductions: dict[str, int] = {}
    employer: dict[str, int] = {}
    gross: int = 0
    total_deductions: int = 0
    net: int = 0
    employer_total: int = 0


class RegisterOut(BaseModel):
    run_id: uuid.UUID
    period: str
    status: str
    pay_date: date | None = None
    #: Every code that appears, in payslip order, so the table has stable
    #: columns across employees who do not share every component.
    earning_codes: list[str] = []
    deduction_codes: list[str] = []
    employer_codes: list[str] = []
    rows: list[RegisterRowOut] = []
    totals: RegisterRowOut
    #: Should always be empty. Populated when the totals summed from the payslip
    #: lines disagree with what the run stored — shown rather than hidden,
    #: because a disagreement means something upstream is wrong and the register
    #: is exactly the document somebody is checking.
    discrepancies: list[str] = []
    currency: str = "INR"


class FiledOut(BaseModel):
    """How many payslips were filed. Zero means they already were."""

    filed: int
