"""Request/response shapes for pay runs and payslips.

**Amounts are integer paise. Line amounts are always positive**, with ``kind``
deciding the sign — a signed amount means every consumer has to remember which
convention it is in, and eventually one does not.

**No request body carries a total or a computed line.** A run's totals and a
payslip's lines are produced by ``services/payrun.compute`` and never accepted
from a caller. The only figure a caller may supply is a loss-of-pay override,
which is explicitly named as an override rather than being merged into the
derived value.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, Field

from app.schemas.common import ORMModel


class RunIn(BaseModel):
    period_year: int = Field(ge=2000, le=2100)
    period_month: int = Field(ge=1, le=12)
    #: When salaries are credited. Distinct from the period — March's payroll is
    #: commonly paid on 1 April, and payslips and bank files key on this.
    pay_date: date | None = None
    notes: str | None = Field(default=None, max_length=2000)


class LopOverride(BaseModel):
    user_id: uuid.UUID
    #: Milli-days, leave's own unit: 1000 is one day, 500 a half day. No
    #: conversion happens at the boundary between the two modules.
    lop_milli_days: int = Field(ge=0, le=31_000)


class ComputeIn(BaseModel):
    """Loss-of-pay figures the leave module cannot know about.

    Named ``overrides`` rather than ``lop`` because that is what they are: the
    derived figure is replaced, and the payslip records that a human decided.
    """

    overrides: list[LopOverride] = Field(default_factory=list, max_length=2000)


class PaidIn(BaseModel):
    paid_on: date | None = None
    payment_reference: str | None = Field(default=None, max_length=120)


class PayslipLineOut(ORMModel):
    id: uuid.UUID
    kind: str
    code: str
    name: str
    amount: int
    source: str
    #: Points into whichever table ``source`` names — a loan instalment, an
    #: expense claim, a pay component.
    source_id: uuid.UUID | None = None
    detail: str | None = None
    sort_order: int


class PayslipOut(ORMModel):
    id: uuid.UUID
    org_id: uuid.UUID
    run_id: uuid.UUID
    user_id: uuid.UUID
    structure_id: uuid.UUID | None = None
    lop_milli_days: int
    month_days: int
    payable_days: int
    #: What a full month would have been, before any loss of pay. Kept so a
    #: payslip reads "₹50,000 less two days" rather than only the prorated
    #: figure, which looks like a pay cut.
    full_gross: int
    gross: int
    total_deductions: int
    net: int
    #: What the company paid on top — employer PF, EPS, ESI and LWF. Not
    #: deducted from anybody; it is the other half of cost to company.
    employer_contributions: int = 0
    note: str | None = None
    #: The filed copy in the employee's document record, once the run is frozen
    #: and payslips have been filed. Null until then — which is what the console
    #: reads to tell "not filed yet" from "filed", rather than guessing from the
    #: run's status.
    document_id: uuid.UUID | None = None

    user_name: str | None = None
    employee_code: str | None = None
    period_label: str | None = None
    run_status: str | None = None
    lines: list[PayslipLineOut] = []
    currency: str = "INR"


class RunOut(ORMModel):
    id: uuid.UUID
    org_id: uuid.UUID
    period_year: int
    period_month: int
    status: str
    pay_date: date | None = None
    total_gross: int
    total_deductions: int
    total_net: int
    employee_count: int
    computed_at: datetime | None = None
    approved_at: datetime | None = None
    paid_at: datetime | None = None
    payment_reference: str | None = None
    notes: str | None = None
    created_at: datetime

    period_label: str = ""
    computed_by_name: str | None = None
    approved_by_name: str | None = None
    paid_by_name: str | None = None
    currency: str = "INR"

    #: Resolved server-side. The console renders from these rather than
    #: re-deriving the state machine.
    can_compute: bool = False
    can_approve: bool = False
    can_pay: bool = False
    can_cancel: bool = False


class RunDetailOut(RunOut):
    payslips: list[PayslipOut] = []
    #: People with no salary structure for the period, so the run does not
    #: silently omit them. Skipping is correct — a ₹0 payslip reads as a
    #: decision — but silence about it is not.
    skipped: list[dict] = []
