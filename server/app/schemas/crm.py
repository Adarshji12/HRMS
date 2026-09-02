"""Request/response contracts for the CRM module.

Three conventions run through this file and are worth stating once rather than
repeating on forty classes:

1. **Every ``*Out`` row carries its own resolved labels.** ``status_name``,
   ``owner_name``, ``product_name`` and friends are computed server-side from
   the relationship, because the alternative is the console holding six master
   lists in memory and joining them per row — which is how a renamed status
   shows up in one table and not the next.
2. **Every ``*In`` is a full write and every ``*Patch`` is partial.** A patch
   sends only what changed, so two people editing different halves of a lead
   cannot blank each other's work. Absent means "leave it"; ``null`` means
   "clear it", which is why the patch fields are typed with an explicit
   sentinel rather than plain ``| None``  — see ``UNSET``.
3. **Money is ``Decimal``, never ``float``.** The line arithmetic is done in
   the service with ``Decimal`` and quantised to paise; a float here would
   reintroduce the rounding this module exists to get right.

Enum-ish fields validate with regexes rather than importing the model enums,
matching ``app.schemas.assets`` — but the patterns must stay in step with
``app.models.crm``.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.common import ORMModel

STATUS_BEHAVIOUR = r"^(default|in_progress|won|lost)$"
FOLLOWUP_STATUS = r"^(pending|done|cancelled)$"
VISIT_STATUS = r"^(scheduled|in_progress|completed|cancelled)$"
PRIORITY = r"^(low|medium|high|urgent)$"
DIRECTION = r"^(inbound|outbound)$"
INTERACTION_STATUS = r"^(open|closed)$"
CUSTOMER_STATUS = r"^(active|on_hold|expired|churned)$"
PLAN_STATUS = r"^(active|expired|cancelled)$"
PAYMENT_STATUS = r"^(pending|partial|paid)$"
QUOTATION_STATUS = r"^(draft|sent|failed|accepted|rejected|expired)$"
AUDIENCE = r"^(list|leads|customers)$"
ASSIGNMENT_RULE = r"^(unassigned|fixed|round_robin)$"
#: Digits with an optional leading +, 8–20 long. Deliberately loose: this
#: product sells in one country today and the validation must not be the reason
#: it cannot sell in another tomorrow. The console formats; the server stores
#: what it was given.
MOBILE = r"^\+?[0-9][0-9 \-]{7,19}$"
COLOUR = r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$"


def _blank_to_none(value: Any) -> Any:
    """An emptied form field clears the value instead of storing ``""``.

    Every optional string on every form in this module goes through this. The
    failure it prevents is quiet: an empty-string ``company`` is truthy nowhere
    useful but is not NULL either, so ``company or name`` picks "" and a
    quotation prints with a blank party.
    """
    if isinstance(value, str):
        return value.strip() or None
    return value


class CrmBase(BaseModel):
    """Shared validator wiring for the write models."""

    model_config = ConfigDict(str_strip_whitespace=True)


# --------------------------------------------------------------------------- #
# Masters
# --------------------------------------------------------------------------- #


class MasterOut(ORMModel):
    """The shape every simple master answers with.

    One model for sources, industries and the rest, because the console renders
    them all through one table component; anything with real structure (statuses,
    products, plans, geography) has its own type below.
    """

    id: uuid.UUID
    name: str
    is_active: bool = True


class NamedIn(CrmBase):
    name: str = Field(min_length=1, max_length=160)
    is_active: bool = True


class LeadStatusOut(ORMModel):
    id: uuid.UUID
    name: str
    behaviour: str
    colour: str
    sort_order: int
    is_active: bool
    #: How many leads currently sit here. Used by the funnel and to explain a
    #: refused deletion ("42 leads are in this stage") rather than just refusing.
    lead_count: int = 0


class LeadStatusIn(CrmBase):
    name: str = Field(min_length=1, max_length=80)
    behaviour: str = Field(default="in_progress", pattern=STATUS_BEHAVIOUR)
    colour: str = Field(default="#3882F6", pattern=COLOUR)
    sort_order: int = Field(default=0, ge=0, le=999)
    is_active: bool = True


class LeadSourceOut(MasterOut):
    is_intake_default: bool = False


class LeadSourceIn(NamedIn):
    name: str = Field(min_length=1, max_length=80)
    is_intake_default: bool = False


class CountryOut(MasterOut):
    iso2: str | None = None
    dial_code: str | None = None


class CountryIn(NamedIn):
    name: str = Field(min_length=1, max_length=120)
    iso2: str | None = Field(default=None, min_length=2, max_length=2)
    dial_code: str | None = Field(default=None, max_length=8)

    _blank = field_validator("iso2", "dial_code", mode="before")(_blank_to_none)


class StateOut(MasterOut):
    country_id: uuid.UUID
    country_name: str | None = None
    gst_code: str | None = None


class StateIn(NamedIn):
    name: str = Field(min_length=1, max_length=120)
    country_id: uuid.UUID
    gst_code: str | None = Field(default=None, max_length=2)

    _blank = field_validator("gst_code", mode="before")(_blank_to_none)


class CityOut(MasterOut):
    state_id: uuid.UUID
    state_name: str | None = None
    country_id: uuid.UUID | None = None


class CityIn(NamedIn):
    name: str = Field(min_length=1, max_length=120)
    state_id: uuid.UUID


class ProductOut(MasterOut):
    description: str | None = None
    hsn_sac: str | None = None
    unit: str | None = None
    rate: Decimal
    gst_percent: Decimal
    plan_count: int = 0


class ProductIn(NamedIn):
    name: str = Field(min_length=1, max_length=160)
    description: str | None = None
    hsn_sac: str | None = Field(default=None, max_length=16)
    unit: str | None = Field(default=None, max_length=24)
    rate: Decimal = Field(default=Decimal("0"), ge=0, le=Decimal("99999999.99"))
    gst_percent: Decimal = Field(default=Decimal("18"), ge=0, le=100)

    _blank = field_validator("description", "hsn_sac", "unit", mode="before")(_blank_to_none)


class PlanOut(MasterOut):
    product_id: uuid.UUID
    product_name: str | None = None
    duration_days: int | None = None
    price: Decimal
    gst_percent: Decimal | None = None


class PlanIn(NamedIn):
    name: str = Field(min_length=1, max_length=120)
    product_id: uuid.UUID
    #: None means perpetual — a one-off sale with no renewal date.
    duration_days: int | None = Field(default=None, ge=1, le=36500)
    price: Decimal = Field(default=Decimal("0"), ge=0, le=Decimal("99999999.99"))
    gst_percent: Decimal | None = Field(default=None, ge=0, le=100)


class DispositionOut(MasterOut):
    closes_interaction: bool = False
    sort_order: int = 0


class DispositionIn(NamedIn):
    name: str = Field(min_length=1, max_length=120)
    closes_interaction: bool = False
    sort_order: int = Field(default=0, ge=0, le=999)


class VisitTypeOut(MasterOut):
    colour: str
    requires_otp: bool
    sort_order: int


class VisitTypeIn(NamedIn):
    name: str = Field(min_length=1, max_length=120)
    colour: str = Field(default="#3882F6", pattern=COLOUR)
    requires_otp: bool = False
    sort_order: int = Field(default=0, ge=0, le=999)


# --------------------------------------------------------------------------- #
# Settings
# --------------------------------------------------------------------------- #


class CrmSettingsOut(ORMModel):
    assignment_rule: str
    default_owner_id: uuid.UUID | None = None
    assignment_pool: list[uuid.UUID] = []
    intake_enabled: bool
    #: The capture URL, assembled server-side. The raw token is never sent on
    #: its own — there is nothing a caller can do with it that this URL does not
    #: already do, and one field is one place to redact.
    intake_url: str | None = None
    quotation_prefix: str
    quotation_terms: str | None = None
    quotation_validity_days: int
    visit_prefix: str
    ticket_prefix: str
    renewal_window_days: int
    reminders_enabled: bool


class CrmSettingsIn(CrmBase):
    """Partial by construction: only what is sent is written."""

    assignment_rule: str | None = Field(default=None, pattern=ASSIGNMENT_RULE)
    default_owner_id: uuid.UUID | None = None
    assignment_pool: list[uuid.UUID] | None = None
    intake_enabled: bool | None = None
    quotation_prefix: str | None = Field(default=None, min_length=1, max_length=12)
    quotation_terms: str | None = None
    quotation_validity_days: int | None = Field(default=None, ge=1, le=365)
    visit_prefix: str | None = Field(default=None, min_length=1, max_length=12)
    ticket_prefix: str | None = Field(default=None, min_length=1, max_length=12)
    renewal_window_days: int | None = Field(default=None, ge=1, le=365)
    reminders_enabled: bool | None = None


# --------------------------------------------------------------------------- #
# Leads
# --------------------------------------------------------------------------- #


class LeadOut(ORMModel):
    id: uuid.UUID
    code: str
    name: str
    company: str | None = None
    mobile: str
    whatsapp: str | None = None
    email: str | None = None

    status_id: uuid.UUID | None = None
    status_name: str | None = None
    status_colour: str | None = None
    status_behaviour: str | None = None
    source_id: uuid.UUID | None = None
    source_name: str | None = None
    industry_id: uuid.UUID | None = None
    industry_name: str | None = None
    product_id: uuid.UUID | None = None
    product_name: str | None = None

    owner_id: uuid.UUID | None = None
    owner_name: str | None = None

    state_id: uuid.UUID | None = None
    state_name: str | None = None
    city_id: uuid.UUID | None = None
    city_name: str | None = None
    pincode: str | None = None
    address: str | None = None
    notes: str | None = None
    value: Decimal | None = None

    next_follow_up_at: datetime | None = None
    last_contacted_at: datetime | None = None
    customer_id: uuid.UUID | None = None
    converted_at: datetime | None = None
    lost_reason: str | None = None
    created_at: datetime
    updated_at: datetime


class LeadPage(BaseModel):
    """A page of leads plus the totals the console's footer needs.

    Returned instead of a bare list because "1–1 of 1 lead" cannot be derived
    from the page itself, and a second count endpoint would be a second query
    that can disagree with the first.
    """

    rows: list[LeadOut]
    total: int
    page: int
    page_size: int


class LeadIn(CrmBase):
    name: str = Field(min_length=1, max_length=200)
    mobile: str = Field(pattern=MOBILE)
    company: str | None = Field(default=None, max_length=200)
    whatsapp: str | None = Field(default=None, max_length=24)
    email: str | None = Field(default=None, max_length=255)
    status_id: uuid.UUID | None = None
    source_id: uuid.UUID | None = None
    industry_id: uuid.UUID | None = None
    product_id: uuid.UUID | None = None
    owner_id: uuid.UUID | None = None
    state_id: uuid.UUID | None = None
    city_id: uuid.UUID | None = None
    pincode: str | None = Field(default=None, max_length=12)
    address: str | None = None
    notes: str | None = None
    value: Decimal | None = Field(default=None, ge=0, le=Decimal("999999999.99"))

    _blank = field_validator(
        "company", "whatsapp", "email", "pincode", "address", "notes", mode="before"
    )(_blank_to_none)


class LeadPatch(CrmBase):
    """Every field optional. Absent means "leave alone"."""

    name: str | None = Field(default=None, min_length=1, max_length=200)
    mobile: str | None = Field(default=None, pattern=MOBILE)
    company: str | None = Field(default=None, max_length=200)
    whatsapp: str | None = Field(default=None, max_length=24)
    email: str | None = Field(default=None, max_length=255)
    status_id: uuid.UUID | None = None
    source_id: uuid.UUID | None = None
    industry_id: uuid.UUID | None = None
    product_id: uuid.UUID | None = None
    owner_id: uuid.UUID | None = None
    state_id: uuid.UUID | None = None
    city_id: uuid.UUID | None = None
    pincode: str | None = Field(default=None, max_length=12)
    address: str | None = None
    notes: str | None = None
    value: Decimal | None = Field(default=None, ge=0, le=Decimal("999999999.99"))
    lost_reason: str | None = Field(default=None, max_length=300)

    _blank = field_validator(
        "company", "whatsapp", "email", "pincode", "address", "notes", "lost_reason",
        mode="before",
    )(_blank_to_none)


class LeadBulkAssign(CrmBase):
    """Hand a batch of leads to one person. Used by the list's selection bar."""

    lead_ids: list[uuid.UUID] = Field(min_length=1, max_length=500)
    #: ``None`` returns them to the unassigned pool, which is a legitimate move
    #: when somebody leaves.
    owner_id: uuid.UUID | None = None


class LeadStatusMove(CrmBase):
    status_id: uuid.UUID
    #: Recorded on the timeline and, for a lost stage, stored on the lead.
    note: str | None = Field(default=None, max_length=300)


class ActivityOut(ORMModel):
    id: uuid.UUID
    kind: str
    body: str
    actor_id: uuid.UUID | None = None
    actor_name: str | None = None
    created_at: datetime


class ActivityIn(CrmBase):
    body: str = Field(min_length=1)
    kind: Literal["note", "call"] = "note"


class LeadDetailOut(LeadOut):
    """A lead with everything the detail drawer shows, in one round trip."""

    activities: list[ActivityOut] = []
    follow_ups: list["FollowUpOut"] = []
    quotations: list["QuotationRowOut"] = []


class LeadImportRow(CrmBase):
    """One row of a CSV import.

    Masters are matched **by name**, not id: a spreadsheet has "Website" in the
    source column, not a UUID, and requiring ids would make the import unusable
    by the people who actually do imports. Unknown names are created where the
    master allows it and reported where it does not.
    """

    name: str = Field(min_length=1, max_length=200)
    mobile: str = Field(pattern=MOBILE)
    company: str | None = None
    email: str | None = None
    source: str | None = None
    status: str | None = None
    product: str | None = None
    city: str | None = None
    state: str | None = None
    pincode: str | None = None
    address: str | None = None
    notes: str | None = None


class LeadImportIn(CrmBase):
    rows: list[LeadImportRow] = Field(min_length=1, max_length=2000)
    #: Skip a row whose mobile already exists in this workspace. On by default:
    #: re-uploading a sheet with twenty new rows in it is the normal way people
    #: use an importer, and the default should not double the pipeline.
    skip_duplicates: bool = True
    owner_id: uuid.UUID | None = None


class LeadImportResult(BaseModel):
    created: int
    skipped: int
    #: One line per rejected row, naming the row number and the reason.
    errors: list[str] = []


class LeadCaptureIn(CrmBase):
    """The public intake payload — Meta lead ads, a website form, a webhook.

    Deliberately tiny and deliberately forgiving. It is called by systems this
    product does not control, so anything beyond a name and a number is
    optional, and unknown extra keys are ignored rather than rejected: a 422 to
    Meta means a lost lead, not a fixed integration.
    """

    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=200)
    mobile: str = Field(min_length=6, max_length=24)
    email: str | None = Field(default=None, max_length=255)
    company: str | None = Field(default=None, max_length=200)
    city: str | None = Field(default=None, max_length=120)
    #: Campaign or form name. Stored on the timeline, not matched to a master:
    #: a campaign is not a source and inventing a master row per campaign would
    #: turn the source list into a log.
    campaign: str | None = Field(default=None, max_length=200)
    notes: str | None = None


# --------------------------------------------------------------------------- #
# Follow-ups
# --------------------------------------------------------------------------- #


class FollowUpOut(ORMModel):
    id: uuid.UUID
    lead_id: uuid.UUID | None = None
    customer_id: uuid.UUID | None = None
    #: Whichever of the two it hangs off, resolved for the list — a follow-up
    #: row that only says "lead 9f3c…" is a row nobody can action.
    subject_name: str | None = None
    subject_mobile: str | None = None
    subject_kind: str = "lead"
    owner_id: uuid.UUID | None = None
    owner_name: str | None = None
    due_at: datetime
    purpose: str | None = None
    notes: str | None = None
    status: str
    outcome: str | None = None
    completed_at: datetime | None = None
    created_at: datetime
    #: True when it is pending and the due time has passed. Computed server-side
    #: so every screen agrees on what "overdue" means.
    is_overdue: bool = False


class FollowUpIn(CrmBase):
    due_at: datetime
    lead_id: uuid.UUID | None = None
    customer_id: uuid.UUID | None = None
    owner_id: uuid.UUID | None = None
    purpose: str | None = Field(default=None, max_length=300)
    notes: str | None = None


class FollowUpComplete(CrmBase):
    outcome: str | None = None
    #: Book the next one in the same action. The whole reason a follow-up gets
    #: closed without the next being booked is that it costs a second dialog.
    next_due_at: datetime | None = None
    next_purpose: str | None = Field(default=None, max_length=300)
    #: Move the lead on at the same time, if the call decided something.
    status_id: uuid.UUID | None = None


# --------------------------------------------------------------------------- #
# Customers
# --------------------------------------------------------------------------- #


class CustomerPlanOut(ORMModel):
    id: uuid.UUID
    customer_id: uuid.UUID
    product_id: uuid.UUID | None = None
    plan_id: uuid.UUID | None = None
    product_name: str
    plan_name: str | None = None
    start_on: date
    end_on: date | None = None
    renewal_on: date | None = None
    amount: Decimal
    payment_status: str
    status: str
    notes: str | None = None
    #: Days until renewal, negative once it has passed. None when perpetual.
    days_to_renewal: int | None = None


class CustomerPlanIn(CrmBase):
    product_id: uuid.UUID | None = None
    plan_id: uuid.UUID | None = None
    #: Free text is allowed so a plan can be recorded for something that is not
    #: on the master yet — the sale happened whether or not the catalogue caught
    #: up.
    product_name: str | None = Field(default=None, max_length=200)
    plan_name: str | None = Field(default=None, max_length=160)
    start_on: date
    end_on: date | None = None
    renewal_on: date | None = None
    amount: Decimal = Field(default=Decimal("0"), ge=0, le=Decimal("99999999.99"))
    payment_status: str = Field(default="pending", pattern=PAYMENT_STATUS)
    status: str = Field(default="active", pattern=PLAN_STATUS)
    notes: str | None = None


class CustomerOut(ORMModel):
    id: uuid.UUID
    code: str
    name: str
    company: str | None = None
    mobile: str
    whatsapp: str | None = None
    email: str | None = None
    customer_type: str | None = None
    industry_id: uuid.UUID | None = None
    industry_name: str | None = None
    source_id: uuid.UUID | None = None
    source_name: str | None = None
    gstin: str | None = None
    country_id: uuid.UUID | None = None
    state_id: uuid.UUID | None = None
    state_name: str | None = None
    city_id: uuid.UUID | None = None
    city_name: str | None = None
    pincode: str | None = None
    address: str | None = None
    manager_id: uuid.UUID | None = None
    manager_name: str | None = None
    status: str
    notes: str | None = None
    converted_from_lead_id: uuid.UUID | None = None
    created_at: datetime

    #: The plan the list row shows — the one renewing soonest, or the newest if
    #: none renews. Derived, so the table needs no per-row request.
    primary_plan: CustomerPlanOut | None = None
    plan_count: int = 0


class CustomerDetailOut(CustomerOut):
    plans: list[CustomerPlanOut] = []
    interactions: list["InteractionOut"] = []
    visits: list["VisitOut"] = []


class CustomerIn(CrmBase):
    name: str = Field(min_length=1, max_length=200)
    mobile: str = Field(pattern=MOBILE)
    #: The company's own reference. Generated when absent, never overwritten.
    code: str | None = Field(default=None, max_length=40)
    company: str | None = Field(default=None, max_length=200)
    whatsapp: str | None = Field(default=None, max_length=24)
    email: str | None = Field(default=None, max_length=255)
    customer_type: str | None = Field(default=None, max_length=40)
    industry_id: uuid.UUID | None = None
    source_id: uuid.UUID | None = None
    gstin: str | None = Field(default=None, max_length=20)
    country_id: uuid.UUID | None = None
    state_id: uuid.UUID | None = None
    city_id: uuid.UUID | None = None
    pincode: str | None = Field(default=None, max_length=12)
    address: str | None = None
    manager_id: uuid.UUID | None = None
    status: str = Field(default="active", pattern=CUSTOMER_STATUS)
    notes: str | None = None

    _blank = field_validator(
        "code", "company", "whatsapp", "email", "customer_type", "gstin", "pincode",
        "address", "notes", mode="before",
    )(_blank_to_none)


class CustomerPatch(CustomerIn):
    """Same fields, all optional."""

    name: str | None = Field(default=None, min_length=1, max_length=200)
    mobile: str | None = Field(default=None, pattern=MOBILE)
    status: str | None = Field(default=None, pattern=CUSTOMER_STATUS)


class ConvertLeadIn(CrmBase):
    """Turn a lead into a customer.

    The customer fields default from the lead, so an empty body is a valid
    conversion — the salesperson who has just been told "yes" should not have to
    retype a name that is already on the screen.
    """

    code: str | None = Field(default=None, max_length=40)
    manager_id: uuid.UUID | None = None
    customer_type: str | None = Field(default=None, max_length=40)
    gstin: str | None = Field(default=None, max_length=20)
    plan: CustomerPlanIn | None = None


# --------------------------------------------------------------------------- #
# Support desk
# --------------------------------------------------------------------------- #


class InteractionOut(ORMModel):
    id: uuid.UUID
    ticket_no: str
    customer_id: uuid.UUID
    customer_name: str | None = None
    direction: str
    disposition_id: uuid.UUID | None = None
    disposition_name: str | None = None
    status: str
    remarks: str | None = None
    staff_id: uuid.UUID | None = None
    staff_name: str | None = None
    follow_up_id: uuid.UUID | None = None
    follow_up_due_at: datetime | None = None
    closed_at: datetime | None = None
    created_at: datetime


class InteractionIn(CrmBase):
    customer_id: uuid.UUID
    direction: str = Field(pattern=DIRECTION)
    disposition_id: uuid.UUID | None = None
    status: str = Field(default="open", pattern=INTERACTION_STATUS)
    remarks: str | None = None
    #: Booking a follow-up from the call is one checkbox on the desk, so it is
    #: one field here rather than a second request the console has to sequence.
    follow_up_at: datetime | None = None
    follow_up_purpose: str | None = Field(default=None, max_length=300)


class SupportSummary(BaseModel):
    logged_today: int
    open: int
    closed: int


# --------------------------------------------------------------------------- #
# Visits
# --------------------------------------------------------------------------- #


class VisitOut(ORMModel):
    id: uuid.UUID
    visit_no: str
    customer_id: uuid.UUID
    customer_name: str | None = None
    customer_mobile: str | None = None
    visit_type_id: uuid.UUID | None = None
    visit_type_name: str | None = None
    contact_person: str | None = None
    mobile: str | None = None
    address: str | None = None
    priority: str
    purpose: str | None = None
    notes: str | None = None
    assigned_to: uuid.UUID | None = None
    employee_name: str | None = None
    scheduled_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None
    status: str
    outcome: str | None = None
    duration_minutes: int | None = None
    otp_required: bool = False
    otp_verified: bool = False
    created_at: datetime


class VisitIn(CrmBase):
    customer_id: uuid.UUID
    scheduled_at: datetime
    visit_type_id: uuid.UUID | None = None
    contact_person: str | None = Field(default=None, max_length=200)
    mobile: str | None = Field(default=None, max_length=24)
    address: str | None = None
    priority: str = Field(default="medium", pattern=PRIORITY)
    purpose: str | None = None
    notes: str | None = None
    assigned_to: uuid.UUID | None = None

    _blank = field_validator(
        "contact_person", "mobile", "address", "purpose", "notes", mode="before"
    )(_blank_to_none)


class VisitPatch(VisitIn):
    customer_id: uuid.UUID | None = None
    scheduled_at: datetime | None = None
    priority: str | None = Field(default=None, pattern=PRIORITY)
    status: str | None = Field(default=None, pattern=VISIT_STATUS)
    outcome: str | None = None


class VisitCheckIn(CrmBase):
    """Start a visit. The OTP is only required where the visit type asks for it."""

    otp: str | None = Field(default=None, max_length=8)


class VisitCloseIn(CrmBase):
    outcome: str | None = None
    #: Book the next call while standing outside the customer's office, which is
    #: when the salesperson actually knows whether one is needed.
    next_follow_up_at: datetime | None = None


class VisitSummary(BaseModel):
    today: int
    pending: int
    in_progress: int
    completed: int
    overdue: int
    cancelled: int


# --------------------------------------------------------------------------- #
# Quotations
# --------------------------------------------------------------------------- #


class QuotationLineOut(ORMModel):
    id: uuid.UUID
    product_id: uuid.UUID | None = None
    plan_id: uuid.UUID | None = None
    name: str
    description: str | None = None
    hsn_sac: str | None = None
    quantity: Decimal
    rate: Decimal
    discount: Decimal
    discount_is_percent: bool
    gst_percent: Decimal
    taxable_value: Decimal
    tax_amount: Decimal
    amount: Decimal
    sort_order: int


class QuotationLineIn(CrmBase):
    #: Free text, because a quotation legitimately carries a line that is not in
    #: the catalogue ("installation, one site"). Pricing from a product simply
    #: fills these in.
    name: str = Field(min_length=1, max_length=200)
    product_id: uuid.UUID | None = None
    plan_id: uuid.UUID | None = None
    description: str | None = None
    hsn_sac: str | None = Field(default=None, max_length=16)
    quantity: Decimal = Field(default=Decimal("1"), gt=0, le=Decimal("999999"))
    rate: Decimal = Field(default=Decimal("0"), ge=0, le=Decimal("99999999.99"))
    discount: Decimal = Field(default=Decimal("0"), ge=0)
    discount_is_percent: bool = True
    gst_percent: Decimal = Field(default=Decimal("0"), ge=0, le=100)

    _blank = field_validator("description", "hsn_sac", mode="before")(_blank_to_none)


class QuotationRowOut(ORMModel):
    """The list row. Deliberately without lines — a hundred rows is a hundred
    line-sets nobody is looking at."""

    id: uuid.UUID
    number: str
    customer_name: str | None = None
    company: str | None = None
    quote_date: date
    valid_until: date | None = None
    status: str
    grand_total: Decimal
    created_by: uuid.UUID | None = None
    created_by_name: str | None = None
    lead_id: uuid.UUID | None = None
    customer_id: uuid.UUID | None = None
    created_at: datetime


class QuotationOut(QuotationRowOut):
    gstin: str | None = None
    mobile: str | None = None
    whatsapp: str | None = None
    email: str | None = None
    city: str | None = None
    state: str | None = None
    pincode: str | None = None
    billing_address: str | None = None
    shipping_address: str | None = None
    sub_total: Decimal
    discount_total: Decimal
    taxable_value: Decimal
    cgst: Decimal
    sgst: Decimal
    igst: Decimal
    is_interstate: bool
    terms: str | None = None
    notes: str | None = None
    sent_at: datetime | None = None
    decided_at: datetime | None = None
    lines: list[QuotationLineOut] = []


class QuotationIn(CrmBase):
    quote_date: date
    valid_until: date | None = None
    lead_id: uuid.UUID | None = None
    customer_id: uuid.UUID | None = None
    customer_name: str | None = Field(default=None, max_length=200)
    company: str | None = Field(default=None, max_length=200)
    gstin: str | None = Field(default=None, max_length=20)
    mobile: str | None = Field(default=None, max_length=24)
    whatsapp: str | None = Field(default=None, max_length=24)
    email: str | None = Field(default=None, max_length=255)
    city: str | None = Field(default=None, max_length=120)
    state: str | None = Field(default=None, max_length=120)
    pincode: str | None = Field(default=None, max_length=12)
    billing_address: str | None = None
    #: Absent means "same as billing" — see the column comment.
    shipping_address: str | None = None
    terms: str | None = None
    notes: str | None = None
    #: Replaces the whole set on every save. A quotation is edited as a document,
    #: not row by row, and per-line PATCH endpoints would need line ids the
    #: console does not have for rows it has just invented.
    lines: list[QuotationLineIn] = []

    _blank = field_validator(
        "customer_name", "company", "gstin", "mobile", "whatsapp", "email", "city",
        "state", "pincode", "billing_address", "shipping_address", "terms", "notes",
        mode="before",
    )(_blank_to_none)


class QuotationStatusIn(CrmBase):
    status: str = Field(pattern=QUOTATION_STATUS)
    note: str | None = Field(default=None, max_length=300)


class QuotationSummary(BaseModel):
    count: int
    open_value: Decimal
    accepted_value: Decimal
    expired: int


# --------------------------------------------------------------------------- #
# Reminders
# --------------------------------------------------------------------------- #


class ReminderRecipientIn(CrmBase):
    name: str | None = Field(default=None, max_length=200)
    mobile: str = Field(pattern=MOBILE)


class ReminderRecipientOut(ORMModel):
    id: uuid.UUID
    name: str | None = None
    mobile: str


class ReminderRunOut(ORMModel):
    id: uuid.UUID
    reminder_id: uuid.UUID
    reminder_name: str | None = None
    run_on: date
    recipients: int
    sent: int
    failed: int
    note: str | None = None
    created_at: datetime


class ReminderOut(ORMModel):
    id: uuid.UUID
    name: str
    message: str | None = None
    image_url: str | None = None
    template_name: str | None = None
    audience: str
    audience_filter: dict = {}
    start_on: date
    end_on: date | None = None
    send_time: str
    weekdays: list[int] = []
    is_active: bool
    last_run_on: date | None = None
    created_at: datetime
    #: How many people it would go to if it ran now — resolved live for the
    #: lead/customer audiences, counted for a list.
    recipient_count: int = 0
    #: How many sends remain between today and ``end_on``. The wizard footer
    #: shows it so nobody schedules 400 messages by accident.
    scheduled_sends: int = 0
    recipients: list[ReminderRecipientOut] = []


class ReminderIn(CrmBase):
    name: str = Field(min_length=1, max_length=160)
    start_on: date
    message: str | None = None
    image_url: str | None = Field(default=None, max_length=500)
    template_name: str | None = Field(default=None, max_length=160)
    audience: str = Field(default="list", pattern=AUDIENCE)
    audience_filter: dict = {}
    end_on: date | None = None
    send_time: str = Field(default="10:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    weekdays: list[int] = []
    is_active: bool = False
    recipients: list[ReminderRecipientIn] = []

    @field_validator("weekdays")
    @classmethod
    def _iso_weekdays(cls, value: list[int]) -> list[int]:
        """1–7, deduplicated and sorted. Empty means every day.

        Validated rather than trusted because the scheduler branches on this
        list: a 0 in it (a JavaScript ``getDay()`` Sunday, the obvious mistake)
        would match no day at all and the reminder would silently never run.
        """
        cleaned = sorted({int(d) for d in value})
        if any(d < 1 or d > 7 for d in cleaned):
            raise ValueError("weekdays must be ISO day numbers, 1 (Monday) to 7 (Sunday)")
        return cleaned


# --------------------------------------------------------------------------- #
# Dashboard
# --------------------------------------------------------------------------- #


class TrendPoint(BaseModel):
    day: date
    new_leads: int
    converted: int


class FunnelStage(BaseModel):
    status_id: uuid.UUID | None = None
    name: str
    colour: str
    behaviour: str
    count: int
    #: Share of the pipeline, 0–100, already rounded. The console draws the bar
    #: from this rather than dividing by a total it would have to recompute.
    percent: float


class SourceStat(BaseModel):
    name: str
    count: int
    converted: int
    conversion_rate: float


class OwnerStat(BaseModel):
    owner_id: uuid.UUID | None = None
    name: str
    total: int
    converted: int
    pending_follow_ups: int
    conversion_rate: float


class LeadDashboardOut(BaseModel):
    """Everything the dashboard draws, in one call.

    One endpoint rather than eight: the page shows a single moment, and eight
    requests would let the funnel and the tiles disagree about what that moment
    was while they landed.
    """

    total_leads: int
    total_leads_all_time: int
    new_leads: int
    todays_leads: int
    follow_ups_due_today: int
    pending_follow_ups: int
    overdue_follow_ups: int
    qualified_leads: int
    converted_leads: int
    lost_leads: int
    conversion_rate: float
    trend: list[TrendPoint] = []
    funnel: list[FunnelStage] = []
    sources: list[SourceStat] = []
    owners: list[OwnerStat] = []


# Forward references: LeadDetailOut and CustomerDetailOut name types declared
# after them, which Pydantic resolves only when asked.
LeadDetailOut.model_rebuild()
CustomerDetailOut.model_rebuild()
