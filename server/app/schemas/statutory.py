"""Request/response shapes for statutory configuration.

**Rates are integer basis points; amounts are integer paise.** Neither becomes a
float. 12% is `1200`, and a rate expressed as `0.12` is the value that ends up
applied twice.

`pf_enabled` and `esi_enabled` default **false** on the way in as well as in the
column. A company that has not thought about statutory deductions must not have
them appear on payslips because a form defaulted them on.
"""

from __future__ import annotations

import uuid

from pydantic import BaseModel, Field, model_validator

from app.schemas.common import ORMModel


class StatutoryConfigIn(BaseModel):
    pf_enabled: bool = False
    pf_employee_rate_bps: int = Field(default=1200, ge=0, le=10_000)
    pf_employer_rate_bps: int = Field(default=1200, ge=0, le=10_000)
    #: The slice of the employer share that goes to the pension scheme. An ECR
    #: filing needs it separately, so it is configured rather than assumed.
    pf_pension_rate_bps: int = Field(default=833, ge=0, le=10_000)
    #: Paise a month. ₹15,000 as it stands.
    pf_wage_ceiling: int = Field(default=1_500_000, ge=0, le=100_000_000)
    pf_cap_at_ceiling: bool = True
    pf_pension_cap_at_ceiling: bool = True

    esi_enabled: bool = False
    esi_employee_rate_bps: int = Field(default=75, ge=0, le=10_000)
    esi_employer_rate_bps: int = Field(default=325, ge=0, le=10_000)
    esi_wage_threshold: int = Field(default=2_100_000, ge=0, le=100_000_000)

    pt_enabled: bool = False
    pt_state: str | None = Field(default=None, max_length=80)

    lwf_enabled: bool = False
    lwf_employee_amount: int = Field(default=0, ge=0, le=1_000_000)
    lwf_employer_amount: int = Field(default=0, ge=0, le=1_000_000)
    #: 1–12, or null for every month.
    lwf_month: int | None = Field(default=None, ge=1, le=12)

    # --- Exit settlement -----------------------------------------------------
    # None of this affects a monthly payslip; it is read only when somebody
    # leaves. See ``services/settlement``.
    #: Off by default. Gratuity is due only after five years, and a large number
    #: appearing in a settlement unasked is not a good default.
    gratuity_enabled: bool = False
    #: The Payment of Gratuity Act's own figures: fifteen days' wages per
    #: completed year, divided by 26 notional working days, capped at
    #: ₹20,00,000. Configurable because some contracts are more generous.
    gratuity_days_per_year: int = Field(default=15, ge=0, le=90)
    gratuity_month_days: int = Field(default=26, ge=1, le=31)
    gratuity_ceiling: int = Field(default=200_000_000, ge=0, le=1_000_000_000)
    #: 26 and 30 are both common and differ by 15%, which is too big a gap to
    #: guess at.
    encashment_month_days: int = Field(default=26, ge=1, le=31)
    #: True: encash on basic. False: on gross.
    encashment_on_basic: bool = True

    @model_validator(mode="after")
    def _pension_within_employer(self) -> "StatutoryConfigIn":
        # The pension slice comes out of the employer's share. A rate above it
        # would make EPF negative, which the computation clamps — but a clamp
        # silently producing zero EPF is worse than refusing a configuration
        # nobody meant to enter.
        if self.pf_pension_rate_bps > self.pf_employer_rate_bps:
            raise ValueError(
                "the pension rate is part of the employer share and cannot exceed it"
            )
        return self


class StatutoryConfigOut(ORMModel):
    id: uuid.UUID
    org_id: uuid.UUID
    pf_enabled: bool
    pf_employee_rate_bps: int
    pf_employer_rate_bps: int
    pf_pension_rate_bps: int
    pf_wage_ceiling: int
    pf_cap_at_ceiling: bool
    pf_pension_cap_at_ceiling: bool
    esi_enabled: bool
    esi_employee_rate_bps: int
    esi_employer_rate_bps: int
    esi_wage_threshold: int
    pt_enabled: bool
    pt_state: str | None = None
    lwf_enabled: bool
    lwf_employee_amount: int
    lwf_employer_amount: int
    lwf_month: int | None = None

    gratuity_enabled: bool = False
    gratuity_days_per_year: int = 15
    gratuity_month_days: int = 26
    gratuity_ceiling: int = 200_000_000
    encashment_month_days: int = 26
    encashment_on_basic: bool = True
    #: How many PT slabs are configured, so the screen can warn that PT is on
    #: with an empty table — which deducts nothing and looks like a bug.
    pt_slab_count: int = 0


class SlabIn(BaseModel):
    #: Paise, inclusive.
    min_gross: int = Field(ge=0, le=1_000_000_000)
    #: Paise, inclusive. Null for the top band.
    max_gross: int | None = Field(default=None, ge=0, le=1_000_000_000)
    amount: int = Field(ge=0, le=10_000_000)
    #: 1–12, or null for every month. A month-specific slab wins over a general
    #: one covering the same band.
    applies_in_month: int | None = Field(default=None, ge=1, le=12)
    label: str | None = Field(default=None, max_length=120)

    @model_validator(mode="after")
    def _range_is_sane(self) -> "SlabIn":
        if self.max_gross is not None and self.max_gross < self.min_gross:
            raise ValueError("the upper bound is below the lower one")
        return self


class SlabOut(ORMModel):
    id: uuid.UUID
    org_id: uuid.UUID
    min_gross: int
    max_gross: int | None = None
    amount: int
    applies_in_month: int | None = None
    label: str | None = None


class PreviewIn(BaseModel):
    """What would be deducted at a given wage — the config's own smoke test."""

    pf_wage: int = Field(ge=0, le=1_000_000_000)
    esi_wage: int = Field(ge=0, le=1_000_000_000)
    gross: int = Field(ge=0, le=1_000_000_000)
    month: int = Field(default=1, ge=1, le=12)


class PreviewLineOut(BaseModel):
    code: str
    name: str
    amount: int
    source: str
    detail: str | None = None


class PreviewOut(BaseModel):
    employee_lines: list[PreviewLineOut] = []
    employer_lines: list[PreviewLineOut] = []
    employee_total: int = 0
    employer_total: int = 0
