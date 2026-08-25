"""Request/response shapes for leave management.

Two conventions run through this file and are worth stating once.

**Quantities cross the wire as integer milli-days**, matching the columns and
matching the way money already crosses as integer paise — the console renders
``1750`` as "1.75 days" and multiplies back on the way in. Accepting a float
"days" field would put binary rounding on the boundary of a number people are
paid against, and the first ``0.1 + 0.2`` in a leave balance is a support
ticket that ends in a spreadsheet. ``*Out`` schemas additionally carry a
``*_days`` float purely so the console does not have to divide; nothing may be
computed from it.

**A balance is never a bare number.** :class:`LeaveBalanceOut` exposes all four
stored components alongside the derived figures, so the UI can show *why* a
balance is what it is — and so a manual correction is visible in the payload
rather than folded invisibly into a total. See ``app.models.leave`` for the
reasoning behind the schema.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, Field, model_validator

from app.schemas.common import ORMModel

# Mirrors app.models.leave.MILLI_DAYS_PER_DAY. Duplicated rather than imported
# so the schema layer stays free of a model import, which is the existing
# arrangement in every other schemas module.
_MILLI_DAYS_PER_DAY = 1000

# A year's worth of leave in milli-days, used as the sanity ceiling on every
# quantity a human types. Not a policy limit — policy lives in leave_types —
# just the bound past which the input is a typo or an attack.
_MAX_QUANTITY = 366 * _MILLI_DAYS_PER_DAY


# --------------------------------------------------------------------------- #
# Org-level leave settings
# --------------------------------------------------------------------------- #


class LeaveSettingsIn(BaseModel):
    """Per-tenant leave policy that is not per leave type.

    Deliberately not folded into ``OrgSettingsUpdate``: that is the agent's
    heartbeat contract, and none of this is anything an agent reads.
    """

    #: 1 = January, 4 = the April-March year most Indian orgs run. This is the
    #: month LeaveBalance.year *opens* in — year 2026 with a value of 4 means
    #: April 2026 to March 2027.
    leave_year_start_month: int = Field(default=1, ge=1, le=12)
    #: 0 means **unlimited**, not "none" — see the column comment. Capped at 50
    #: to match the ceiling on OptionalHolidayOptInIn.holiday_ids.
    optional_holiday_quota: int = Field(default=0, ge=0, le=50)


class LeaveSettingsOut(ORMModel):
    """Always resolvable, even for an org with no stored row.

    An org that never opened Leave Settings has no ``leave_settings`` row, and
    that is a legal state meaning "the defaults" — so this schema is served from
    resolved values, not straight off a row that may not exist. ``is_configured``
    tells the console whether it is showing a saved policy or the fallback, which
    is the difference between "your admin chose January" and "nobody has looked
    at this yet".
    """

    org_id: uuid.UUID
    leave_year_start_month: int
    optional_holiday_quota: int
    #: False when no row exists and the values above are the defaults.
    is_configured: bool = False
    #: Derived so the console does not reimplement the 0-means-unlimited rule
    #: and get it backwards.
    optional_holidays_are_unlimited: bool = True


# --------------------------------------------------------------------------- #
# Leave types
# --------------------------------------------------------------------------- #


class LeaveTypeIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    code: str | None = Field(default=None, max_length=16)
    description: str | None = Field(default=None, max_length=2000)
    is_paid: bool = True
    accrual_type: str = Field(default="monthly", pattern=r"^(monthly|yearly|none)$")
    accrual_rate_milli_days: int = Field(default=0, ge=0, le=_MAX_QUANTITY)
    #: 0 = uncapped.
    max_balance_milli_days: int = Field(default=0, ge=0, le=_MAX_QUANTITY)
    #: 0 = use-it-or-lose-it. For "carry everything" set carry_forward_all.
    carry_forward_limit_milli_days: int = Field(default=0, ge=0, le=_MAX_QUANTITY)
    carry_forward_all: bool = False
    min_notice_days: int = Field(default=0, ge=0, le=365)
    requires_approval: bool = True
    allow_half_day: bool = True
    is_comp_off: bool = False
    #: Whether an unused balance is paid out at exit. False by default — see
    #: the column comment: over-paying a settlement is the expensive mistake.
    is_encashable: bool = False
    is_active: bool = True

    @model_validator(mode="after")
    def _accrual_rate_matches_type(self) -> "LeaveTypeIn":
        # A monthly/yearly type with a zero rate accrues nothing forever and
        # looks, to the employee staring at a stuck balance, exactly like a bug
        # in the accrual job. Make the admin say `none` if that is the intent.
        if self.accrual_type in ("monthly", "yearly") and self.accrual_rate_milli_days <= 0:
            raise ValueError(
                "accrual_rate_milli_days must be positive for a monthly or yearly "
                "accrual type; use accrual_type='none' for manually granted leave"
            )
        return self


class LeaveTypeOut(ORMModel):
    id: uuid.UUID
    name: str
    code: str | None = None
    description: str | None = None
    is_paid: bool
    accrual_type: str
    accrual_rate_milli_days: int
    max_balance_milli_days: int
    carry_forward_limit_milli_days: int
    carry_forward_all: bool
    min_notice_days: int
    requires_approval: bool
    allow_half_day: bool
    is_comp_off: bool
    is_encashable: bool
    is_active: bool
    #: Display convenience only — see the module docstring.
    accrual_rate_days: float = 0.0


# --------------------------------------------------------------------------- #
# Balances
# --------------------------------------------------------------------------- #


class LeaveBalanceOut(ORMModel):
    """One employee's balance for one leave type in one policy year.

    Every stored component is on the wire. That is the point of the table: a
    client that only ever renders ``balance_milli_days`` is free to, but the
    fact that HR added two days by hand is right there next to it, and the
    Leave Balance report can show the breakdown without a second endpoint.
    """

    id: uuid.UUID
    user_id: uuid.UUID
    leave_type_id: uuid.UUID
    year: int

    # --- the stored components, never collapsed ------------------------------
    opening_milli_days: int
    accrued_milli_days: int
    used_milli_days: int
    #: Signed. Negative is a legitimate downward correction.
    adjusted_milli_days: int

    # --- derived, computed from the components at read time ------------------
    #: opening + accrued - used + adjusted. Model property, not a column.
    balance_milli_days: int
    #: opening + accrued + adjusted — everything granted, before anything taken.
    entitled_milli_days: int

    #: Milli-days locked up by applications that are submitted but not yet
    #: decided. Filled by the service from a query, not stored: a pending
    #: application has not debited `used` yet, and an employee who can see the
    #: undebited balance will apply for it twice.
    pending_milli_days: int = 0

    #: What the employee may actually apply for right now: balance minus
    #: pending. This is the number the apply form must validate against, and
    #: the reason `balance_milli_days` alone is never enough.
    available_milli_days: int = 0

    #: Display convenience only — see the module docstring.
    balance_days: float = 0.0
    available_days: float = 0.0

    # Derived display fields so the console never has to join.
    user_name: str | None = None
    leave_type_name: str | None = None
    leave_type_code: str | None = None
    is_paid: bool = True

    #: Attribution of the last manual correction, so the UI can explain a
    #: non-zero `adjusted` without a trip to the audit log.
    adjusted_reason: str | None = None
    adjusted_by_user_id: uuid.UUID | None = None
    adjusted_at: datetime | None = None


class LeaveBalanceAdjustIn(BaseModel):
    """A manual correction to one balance.

    The delta is signed and the reason is mandatory. Neither is negotiable: a
    correction without a reason is exactly the silent overwrite the component
    model exists to prevent, and an endpoint that takes an absolute new balance
    instead of a delta cannot distinguish "grant two days" from "clobber
    whatever the accrual job did while I had the form open".
    """

    user_id: uuid.UUID
    leave_type_id: uuid.UUID
    year: int = Field(ge=2000, le=2200)
    delta_milli_days: int = Field(ge=-_MAX_QUANTITY, le=_MAX_QUANTITY)
    reason: str = Field(min_length=3, max_length=500)

    @model_validator(mode="after")
    def _delta_is_not_zero(self) -> "LeaveBalanceAdjustIn":
        if self.delta_milli_days == 0:
            raise ValueError("delta_milli_days must not be zero")
        return self


# --------------------------------------------------------------------------- #
# Applications
# --------------------------------------------------------------------------- #


class LeaveApplyIn(BaseModel):
    """An employee applying for leave.

    Note what is *absent*: there is no duration field. The number of days a
    range consumes depends on the holiday calendar and the employee's working
    days, so it is computed server-side and frozen onto the row. Accepting it
    from the client would let anyone spend a five-day holiday for one day of
    balance.
    """

    leave_type_id: uuid.UUID
    start_date: date
    end_date: date
    is_half_day: bool = False
    half_day_session: str | None = Field(default=None, pattern=r"^(first_half|second_half)$")
    reason: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def _range_and_half_day_agree(self) -> "LeaveApplyIn":
        if self.end_date < self.start_date:
            raise ValueError("end_date must not be before start_date")
        if self.is_half_day:
            # Half of a multi-day range is not a thing anyone means. Rejecting
            # it here keeps the service from having to invent an answer.
            if self.start_date != self.end_date:
                raise ValueError("a half-day application must cover a single day")
            if self.half_day_session is None:
                raise ValueError("half_day_session is required when is_half_day is set")
        elif self.half_day_session is not None:
            raise ValueError("half_day_session is only valid when is_half_day is set")
        return self


class LeaveApplicationOut(ORMModel):
    id: uuid.UUID
    user_id: uuid.UUID
    leave_type_id: uuid.UUID
    start_date: date
    end_date: date
    is_half_day: bool
    half_day_session: str | None = None
    #: Frozen at apply time; what approval debits and cancellation credits back.
    duration_milli_days: int
    duration_days: float = 0.0
    reason: str | None = None
    status: str
    applied_at: datetime
    reviewed_at: datetime | None = None
    reviewed_by_user_id: uuid.UUID | None = None
    review_note: str | None = None
    cancelled_at: datetime | None = None
    #: Non-null once the balance debit has landed. Surfaced because a row that
    #: is approved but undebited is a bug worth being able to see from the
    #: outside rather than only in the database.
    debited_at: datetime | None = None

    # Derived display fields so the console never has to join.
    user_name: str | None = None
    leave_type_name: str | None = None
    reviewed_by_name: str | None = None
    #: Balance the employee has left in this type right now, so the approval
    #: queue can show a manager that saying yes takes someone negative.
    balance_after_milli_days: int | None = None


class LeaveDecisionIn(BaseModel):
    """A manager approving or rejecting one application."""

    approve: bool
    note: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def _rejection_needs_a_reason(self) -> "LeaveDecisionIn":
        # An unexplained rejection generates a helpdesk ticket every time, and
        # the employee is entitled to the reason anyway.
        if not self.approve and not (self.note or "").strip():
            raise ValueError("a rejection must carry a note explaining it")
        return self


class LeaveCancelIn(BaseModel):
    """An employee withdrawing their own application.

    Separate from a rejection because the balance consequence differs: a
    cancellation of an already-approved leave has to credit `used` back, a
    rejection never debited it in the first place.
    """

    reason: str | None = Field(default=None, max_length=2000)


# --------------------------------------------------------------------------- #
# Holidays
# --------------------------------------------------------------------------- #


class HolidayIn(BaseModel):
    #: Named holiday_date, not date, to match the column — see the model.
    holiday_date: date
    name: str = Field(min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=2000)
    is_optional: bool = False
    is_active: bool = True


class HolidayOut(ORMModel):
    id: uuid.UUID
    holiday_date: date
    name: str
    description: str | None = None
    is_optional: bool
    is_active: bool
    #: For an optional holiday, whether the requesting employee has opted in.
    #: Always false for a mandatory holiday, where opting in is meaningless —
    #: the day is off for everyone.
    opted_in: bool = False
    #: How many employees opted in. Admin calendar view only; None elsewhere,
    #: because computing it per employee request is a pointless aggregate.
    opt_in_count: int | None = None


class OptionalHolidayOptInIn(BaseModel):
    """The employee's full set of optional-holiday choices, sent as a whole.

    A replace-the-set payload rather than add/remove endpoints, because the
    policy is "pick N of these" and validating N against a set the client sends
    piecemeal means every partial state has to be legal on its way to a legal
    final one.

    The 50 below is a payload sanity bound, not the policy limit. The real limit
    is ``leave_settings.optional_holiday_quota`` and it is checked in the service
    — where 0 means unlimited — because a per-org number cannot be a static
    Field constraint.
    """

    holiday_ids: list[uuid.UUID] = Field(default_factory=list, max_length=50)


class OptionalHolidayOptInOut(ORMModel):
    id: uuid.UUID
    user_id: uuid.UUID
    holiday_id: uuid.UUID
    created_at: datetime
    holiday_date: date | None = None
    holiday_name: str | None = None


# --------------------------------------------------------------------------- #
# Comp-off
# --------------------------------------------------------------------------- #


class CompOffCreditIn(BaseModel):
    """Granting one comp-off credit. Admin/manager action, never self-service."""

    user_id: uuid.UUID
    earned_date: date
    reason: str | None = Field(default=None, max_length=1000)
    credit_milli_days: int = Field(default=_MILLI_DAYS_PER_DAY, gt=0, le=_MILLI_DAYS_PER_DAY)
    #: Omit to let the service apply COMP_OFF_DEFAULT_EXPIRY_DAYS from config.
    #: Passed explicitly only when a manager negotiates a different window.
    expires_at: date | None = None

    @model_validator(mode="after")
    def _expiry_is_after_earning(self) -> "CompOffCreditIn":
        if self.expires_at is not None and self.expires_at <= self.earned_date:
            raise ValueError("expires_at must be after earned_date")
        return self


class CompOffCreditOut(ORMModel):
    id: uuid.UUID
    user_id: uuid.UUID
    earned_date: date
    reason: str | None = None
    credit_milli_days: int
    credit_days: float = 0.0
    expires_at: date
    #: Stamped by the comp_off_expiry job. Do not treat as authoritative — see
    #: the column comment; `is_expired` below is the answer to render.
    expired_at: datetime | None = None
    used_in_application_id: uuid.UUID | None = None
    granted_by_user_id: uuid.UUID | None = None

    # Derived display fields so the console never has to join.
    user_name: str | None = None
    granted_by_name: str | None = None
    #: Computed against today, not read from expired_at, so a night the job did
    #: not run cannot present a dead credit as spendable.
    is_expired: bool = False
    is_used: bool = False
