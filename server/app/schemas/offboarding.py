"""Wire contracts for the exit workflow.

Two conventions worth knowing before you read further.

**Money is paise on the wire, not rupees.** ``ProjectIn`` takes
``hourly_rate_rupees`` as a float and converts; the F&F schemas deliberately do
not follow it. A project rate is a configuration number, but a settlement figure
is the last money a company owes a person, and a float round-trip through JSON
is a rounding dispute waiting to be filed. The HR console multiplies by 100
before it posts, and everything from there down is an integer. Nothing in this
module accepts a float.

**The regex patterns below are the enums in ``app.models.offboarding`` written
out by hand.** Schemas in this codebase never import models, so the two have to
be kept in step manually; the enum classes are the source of truth and these
patterns follow them. If you add a value there, add it here.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, Field

from app.schemas.common import ORMModel
from app.schemas.settlement import FnfLineOut

# Mirrors of OffboardingReason / OffboardingStatus / ClearanceCategory /
# ClearanceTaskStatus / ClearanceOwnerRole / FnfStatus. See the module docstring.
REASON_PATTERN = r"^(resignation|termination|end_of_contract)$"
REQUEST_STATUS_PATTERN = r"^(initiated|in_progress|completed|cancelled)$"
CATEGORY_PATTERN = r"^(it_asset_return|knowledge_transfer|hr_clearance|finance_clearance)$"
TASK_STATUS_PATTERN = r"^(pending|in_progress|done|skipped)$"
OWNER_ROLE_PATTERN = r"^(hr|manager|it|employee)$"
FNF_STATUS_PATTERN = r"^(draft|approved|paid|cancelled)$"


# --- offboarding requests ---------------------------------------------------


class OffboardingRequestIn(BaseModel):
    user_id: uuid.UUID
    reason: str = Field(pattern=REASON_PATTERN)
    reason_note: str | None = Field(default=None, max_length=4000)
    notice_date: date
    # Optional at creation: the last day is negotiated after the resignation is
    # accepted far more often than it is known on day one. See the column note.
    last_working_day: date | None = None


class OffboardingRequestUpdate(BaseModel):
    """Every field optional -- an exit is edited one detail at a time.

    ``status`` is not here on purpose. Moving an exit to ``completed`` revokes
    devices and deactivates a person; that is a service action behind its own
    endpoint, not something a PATCH body should be able to do by accident.
    """

    reason: str | None = Field(default=None, pattern=REASON_PATTERN)
    reason_note: str | None = Field(default=None, max_length=4000)
    notice_date: date | None = None
    last_working_day: date | None = None


class OffboardingCancelIn(BaseModel):
    """Withdrawn resignations need a reason on file; cancellation is not delete."""

    cancellation_reason: str = Field(min_length=1, max_length=4000)


class OffboardingRequestOut(ORMModel):
    id: uuid.UUID
    org_id: uuid.UUID
    user_id: uuid.UUID
    initiated_by: uuid.UUID | None = None
    reason: str
    reason_note: str | None = None
    notice_date: date
    last_working_day: date | None = None
    status: str
    completed_at: datetime | None = None
    completed_by: uuid.UUID | None = None
    cancelled_at: datetime | None = None
    cancellation_reason: str | None = None
    # Evidence that completion actually did the two irreversible things, for
    # the console's exit record. Never used to decide access -- see the model.
    devices_revoked_at: datetime | None = None
    user_deactivated_at: datetime | None = None
    created_at: datetime

    # Resolved names so the exits table needs no client-side joins.
    user_name: str | None = None
    user_email: str | None = None
    employee_code: str | None = None
    department_name: str | None = None
    designation_name: str | None = None
    manager_name: str | None = None
    initiated_by_name: str | None = None

    # Checklist progress, so the pipeline view can render a bar without
    # fetching every task for every row.
    task_total: int = 0
    task_settled: int = 0
    # Mandatory items still open. Non-zero means completion must be refused,
    # and it is the one number an HR admin scans the list for.
    blocking_task_count: int = 0
    fnf_status: str | None = None


# --- clearance tasks --------------------------------------------------------


class OffboardingTaskIn(BaseModel):
    """Adding a clearance item to an existing exit, or overriding a defaulted one."""

    title: str = Field(min_length=1, max_length=300)
    description: str | None = Field(default=None, max_length=4000)
    category: str = Field(pattern=CATEGORY_PATTERN)
    owner_role: str = Field(default="hr", pattern=OWNER_ROLE_PATTERN)
    assignee_user_id: uuid.UUID | None = None
    is_mandatory: bool = True
    # Relative to last_working_day; negative is "before the last day". Bounded
    # so a typo cannot schedule clearance a decade out and quietly never fire.
    due_offset_days: int = Field(default=0, ge=-365, le=365)
    sort_order: int = Field(default=0, ge=0, le=10_000)


class OffboardingTaskUpdate(BaseModel):
    """Ticking an item off, reassigning it, or recording why it was waived."""

    title: str | None = Field(default=None, min_length=1, max_length=300)
    description: str | None = Field(default=None, max_length=4000)
    status: str | None = Field(default=None, pattern=TASK_STATUS_PATTERN)
    owner_role: str | None = Field(default=None, pattern=OWNER_ROLE_PATTERN)
    assignee_user_id: uuid.UUID | None = None
    is_mandatory: bool | None = None
    due_offset_days: int | None = Field(default=None, ge=-365, le=365)
    due_on: date | None = None
    sort_order: int | None = Field(default=None, ge=0, le=10_000)
    # The audit half of a skip: "waived, employee absconded" belongs here, and
    # the service should require it before accepting status = skipped.
    notes: str | None = Field(default=None, max_length=4000)


class OffboardingTaskOut(ORMModel):
    id: uuid.UUID
    request_id: uuid.UUID
    title: str
    description: str | None = None
    category: str
    owner_role: str
    assignee_user_id: uuid.UUID | None = None
    status: str
    is_mandatory: bool
    due_offset_days: int
    due_on: date | None = None
    sort_order: int
    completed_by: uuid.UUID | None = None
    completed_at: datetime | None = None
    notes: str | None = None
    created_at: datetime

    assignee_name: str | None = None
    completed_by_name: str | None = None
    # Done or consciously skipped. Sent rather than inferred client-side so the
    # console and the completion gate can never disagree about what "settled"
    # means.
    is_settled: bool = False


class ClearanceGroupOut(BaseModel):
    """One clearance desk's items, for the per-exit checklist view.

    The tasks are grouped server-side because the four categories are a fixed,
    ordered set with their own completion semantics -- a client regrouping a
    flat list would have to re-derive that, and would eventually get it wrong.
    """

    category: str
    task_total: int = 0
    task_settled: int = 0
    blocking_task_count: int = 0
    tasks: list[OffboardingTaskOut] = []


# --- full-and-final settlement (manual entry) -------------------------------


class OffboardingFnfIn(BaseModel):
    """The three numbers an HR admin types in.

    Nothing computes these and nothing validates them against payroll, because
    there is no payroll -- see ``app.models.offboarding``. ``net_payable_paise``
    is accepted as given and is not checked against gross minus deductions; the
    server reports the mismatch, it does not overrule it.
    """

    # Paise, integers. ge=0 on the first two: a negative gross or a negative
    # deduction always means a sign was entered in the wrong box.
    gross_dues_paise: int = Field(default=0, ge=0, le=100_000_000_000)
    deductions_paise: int = Field(default=0, ge=0, le=100_000_000_000)
    # Net *can* be negative -- a leaver who owes the company more than they are
    # due (unreturned advance, notice-period shortfall) is a real settlement,
    # and clamping it at zero would silently forgive the debt.
    net_payable_paise: int = Field(default=0, ge=-100_000_000_000, le=100_000_000_000)
    currency: str = Field(default="INR", pattern=r"^[A-Z]{3}$")
    notes: str | None = Field(default=None, max_length=8000)


class OffboardingFnfUpdate(BaseModel):
    gross_dues_paise: int | None = Field(default=None, ge=0, le=100_000_000_000)
    deductions_paise: int | None = Field(default=None, ge=0, le=100_000_000_000)
    net_payable_paise: int | None = Field(
        default=None, ge=-100_000_000_000, le=100_000_000_000
    )
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    status: str | None = Field(default=None, pattern=FNF_STATUS_PATTERN)
    notes: str | None = Field(default=None, max_length=8000)
    # Supplied when status moves to paid. The service should refuse "paid"
    # without both: a settlement with no date and no reference cannot be
    # evidenced later, which is the only reason this table exists.
    paid_on: date | None = None
    payment_reference: str | None = Field(default=None, max_length=120)


class OffboardingFnfOut(ORMModel):
    id: uuid.UUID
    request_id: uuid.UUID
    gross_dues_paise: int
    deductions_paise: int
    net_payable_paise: int
    currency: str
    status: str
    notes: str | None = None
    prepared_by: uuid.UUID | None = None
    approved_by: uuid.UUID | None = None
    approved_at: datetime | None = None
    paid_on: date | None = None
    payment_reference: str | None = None
    paid_by: uuid.UUID | None = None
    created_at: datetime

    prepared_by_name: str | None = None
    approved_by_name: str | None = None
    paid_by_name: str | None = None
    # False when net != gross - deductions. A warning for the UI, never an
    # error: the numbers are allowed to disagree, but nobody should be able to
    # save one by accident without seeing that they do.
    is_consistent: bool = True
    # Null when the three numbers were typed in rather than computed from a
    # proposal. Every settlement written before payroll existed has it null,
    # which is accurate rather than a gap.
    computed_at: datetime | None = None
    # The itemisation, when there is one. Empty on a typed-in settlement — and
    # that emptiness is the honest answer to "what was this made of".
    lines: list["FnfLineOut"] = []
    # True when nobody computed this, which is what `computed_at` being null
    # means. Kept as its own field because it is the thing a reader needs to
    # notice, not a null they have to interpret.
    is_manually_entered: bool = True


# --- the per-exit detail payload --------------------------------------------


class OffboardingDetailOut(OffboardingRequestOut):
    """One exit, everything about it, one request.

    Extends the list row rather than redefining it so the console never has to
    reconcile two shapes of the same record.
    """

    # Always all four categories, in a fixed order, including the ones with no
    # tasks -- an empty Finance clearance section is information ("nobody has
    # raised anything") and a missing one reads as a bug.
    clearance: list[ClearanceGroupOut] = []
    # None until an HR admin creates it. Absent is not zero: "no settlement
    # recorded yet" and "settlement of nothing" are different answers to give
    # someone chasing their money.
    fnf: OffboardingFnfOut | None = None
