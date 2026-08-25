"""Request/response shapes for salary structures.

**Amounts are integer paise, monthly. Rates are integer basis points.** Neither
becomes a float here. A rate as `0.4` is the value that ends up applied twice.

**No request body carries a resolved component amount for a percentage
component.** `StructureLineIn.amount` is only meaningful for a `fixed`
component; for the others the server computes it. Accepting a stated figure for
"40% of basic" would let a caller submit a number that contradicts the rule
printed beside it on the payslip.

**Annual figures are derived at the edge**, never stored and never accepted.
`annual_gross` on the way out is twelve times the monthly figure; there is no
annual field on the way in, because two stored figures for one salary is two
numbers to disagree.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, Field, field_validator

from app.models.payroll import Calculation, ComponentKind
from app.schemas.common import ORMModel

#: ₹1,00,00,000 a month in paise. A sanity bound to catch rupees typed as paise,
#: not a statement about what anybody should earn.
MAX_MONTHLY_PAISE = 1_000_000_000


class ComponentIn(BaseModel):
    code: str = Field(min_length=1, max_length=24)
    name: str = Field(min_length=1, max_length=120)
    kind: ComponentKind = ComponentKind.EARNING
    calculation: Calculation = Calculation.FIXED
    #: Basis points. 4000 is 40%. Allowed above 10000 because a component can
    #: genuinely exceed what it is a percentage of.
    rate_bps: int = Field(default=0, ge=0, le=1_000_000)
    is_basic: bool = False

    #: The statutory interface. Nothing downstream infers these from a name.
    is_pf_wage: bool = False
    is_esi_wage: bool = True
    is_taxable: bool = True

    sort_order: int = Field(default=100, ge=0, le=10_000)
    is_active: bool = True
    description: str | None = Field(default=None, max_length=400)

    @field_validator("code", mode="after")
    @classmethod
    def _code(cls, value: str) -> str:
        cleaned = value.strip().upper()
        if not cleaned:
            raise ValueError("a component needs a code")
        if not cleaned.replace("_", "").isalnum():
            # It ends up in payroll exports and accounting mappings; punctuation
            # there breaks a CSV somebody else parses.
            raise ValueError("a code may contain letters, digits and underscores only")
        return cleaned


class ComponentUpdate(BaseModel):
    code: str | None = Field(default=None, min_length=1, max_length=24)
    name: str | None = Field(default=None, min_length=1, max_length=120)
    kind: ComponentKind | None = None
    calculation: Calculation | None = None
    rate_bps: int | None = Field(default=None, ge=0, le=1_000_000)
    is_basic: bool | None = None
    is_pf_wage: bool | None = None
    is_esi_wage: bool | None = None
    is_taxable: bool | None = None
    sort_order: int | None = Field(default=None, ge=0, le=10_000)
    is_active: bool | None = None
    description: str | None = Field(default=None, max_length=400)


class ComponentOut(ORMModel):
    id: uuid.UUID
    org_id: uuid.UUID
    code: str
    name: str
    kind: str
    calculation: str
    rate_bps: int
    is_basic: bool
    is_pf_wage: bool
    is_esi_wage: bool
    is_taxable: bool
    sort_order: int
    is_active: bool
    description: str | None = None
    #: How many structures use it — so the settings screen can say why a
    #: component is not deletable before the foreign key says it louder.
    usage_count: int = 0


class StructureLineIn(BaseModel):
    component_id: uuid.UUID
    #: Paise. Required for a ``fixed`` component, ignored for the rest — the
    #: server computes those from the rule.
    amount: int | None = Field(default=None, ge=0, le=MAX_MONTHLY_PAISE)


class StructureIn(BaseModel):
    effective_from: date
    #: Paise per month. The defining input; components resolve to sum to it.
    gross_monthly: int = Field(gt=0, le=MAX_MONTHLY_PAISE)
    components: list[StructureLineIn] = Field(min_length=1, max_length=40)
    reason: str | None = Field(default=None, max_length=2000)


class StructureComponentOut(ORMModel):
    id: uuid.UUID
    component_id: uuid.UUID
    code: str
    name: str
    kind: str
    calculation: str
    rate_bps: int
    amount: int
    is_pf_wage: bool
    is_esi_wage: bool
    is_taxable: bool
    sort_order: int


class StructureOut(ORMModel):
    id: uuid.UUID
    org_id: uuid.UUID
    user_id: uuid.UUID
    effective_from: date
    #: NULL means this is the one currently in force.
    effective_to: date | None = None
    gross_monthly: int
    reason: str | None = None
    created_at: datetime

    user_name: str | None = None
    created_by_name: str | None = None
    components: list[StructureComponentOut] = []

    #: Derived at the edge — twelve times monthly. Not a column.
    annual_gross: int = 0
    #: Sum of components flagged as PF wages, so the statutory checkpoint's
    #: input is visible before that checkpoint exists.
    pf_wage_monthly: int = 0
    esi_wage_monthly: int = 0
    taxable_monthly: int = 0
    is_current: bool = False
    currency: str = "INR"


class PreviewIn(BaseModel):
    """Resolve a structure without saving it.

    Its own model rather than reusing ``StructureIn`` because a preview has no
    effective date and no reason — asking for them before showing somebody
    whether their percentages even add up is the wrong order.
    """

    gross_monthly: int = Field(gt=0, le=MAX_MONTHLY_PAISE)
    components: list[StructureLineIn] = Field(min_length=1, max_length=40)


class PreviewOut(BaseModel):
    gross_monthly: int
    components: list[StructureComponentOut] = []
    pf_wage_monthly: int = 0
    esi_wage_monthly: int = 0
    taxable_monthly: int = 0


class UncoveredOut(BaseModel):
    """An active employee with no salary structure at all."""

    user_id: uuid.UUID
    full_name: str
    email: str
    employee_code: str | None = None
    joined_on: date | None = None
