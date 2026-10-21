"""Request/response contracts for the asset register and its custody ledger.

Three audiences, three shapes, and mixing them up is the mistake to avoid:

* ``AssetOut`` is the admin register row. It carries the *current* holder
  inline (``current_holder_name``), derived server-side, so the console's asset
  table never has to join assignments back onto assets in the browser.
* ``AssetAssignmentOut`` is one line of custody history, past or present.
* ``MyAssetOut`` is the employee's read-only "what am I holding" row. It
  deliberately omits ``purchase_date`` and the return-side notes: what the
  company paid for a laptop is procurement's business, and the condition note
  written when it comes back is written *about* the employee, not *for* them.

The enum-ish fields are validated with regexes rather than by importing the
model enums, because schemas in this codebase never import models — but the
patterns must stay in step with ``app.models.assets.AssetCategory`` and
``AssetStatus``.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, Field

from app.schemas.common import ORMModel

# Any lower-case slug: the console suggests the ``AssetCategory`` values but a
# company may track anything it owns, so the category is open-ended.
CATEGORY_PATTERN = r"^[a-z0-9_]{1,40}$"
CYCLE_PATTERN = r"^(none|monthly|quarterly|half_yearly|yearly|two_years|three_years)$"
STATUS_PATTERN = r"^(available|assigned|under_repair|retired)$"


class AssetIn(BaseModel):
    """Create or edit a register entry.

    ``status`` is settable so an asset can be booked in already broken or
    already written off, but it is *not* how an asset becomes ``assigned`` —
    that only happens by opening an assignment, so that the status and the
    custody ledger can never tell two different stories.
    """

    asset_tag: str = Field(min_length=1, max_length=64)
    category: str = Field(default="other", pattern=CATEGORY_PATTERN)
    serial_number: str | None = Field(default=None, max_length=120)
    purchase_date: date | None = None
    status: str = Field(default="available", pattern=r"^(available|under_repair|retired)$")

    name: str | None = Field(default=None, max_length=160)
    brand: str | None = Field(default=None, max_length=120)
    model_name: str | None = Field(default=None, max_length=120)
    vendor: str | None = Field(default=None, max_length=160)
    invoice_number: str | None = Field(default=None, max_length=80)
    purchase_cost_paise: int | None = Field(default=None, ge=0)
    location: str | None = Field(default=None, max_length=160)
    warranty_expiry: date | None = None
    renewal_date: date | None = None
    renewal_cycle: str = Field(default="none", pattern=CYCLE_PATTERN)
    renewal_cost_paise: int | None = Field(default=None, ge=0)
    reminder_days: int = Field(default=30, ge=0, le=365)
    auto_renew: bool = False
    notes: str | None = Field(default=None, max_length=4000)


class AssetOut(ORMModel):
    id: uuid.UUID
    asset_tag: str
    category: str
    serial_number: str | None = None
    purchase_date: date | None = None
    status: str
    created_at: datetime

    name: str | None = None
    brand: str | None = None
    model_name: str | None = None
    vendor: str | None = None
    invoice_number: str | None = None
    purchase_cost_paise: int | None = None
    location: str | None = None
    warranty_expiry: date | None = None
    renewal_date: date | None = None
    renewal_cycle: str = "none"
    renewal_cost_paise: int | None = None
    reminder_days: int = 30
    auto_renew: bool = False
    notes: str | None = None

    # Derived from renewal_date against today: none | ok | upcoming | due | overdue.
    # Computed server-side so every screen agrees on what "due" means.
    renewal_state: str = "none"
    days_to_renewal: int | None = None
    warranty_state: str = "none"

    # Derived from the one open assignment, so the register table needs no
    # client-side join. All four are None together when nobody holds the asset.
    current_holder_id: uuid.UUID | None = None
    current_holder_name: str | None = None
    current_assignment_id: uuid.UUID | None = None
    assigned_at: datetime | None = None


class AssetAssignmentIn(BaseModel):
    """Hand an asset to someone.

    The server rejects this when the asset already has an open assignment; the
    database rejects it too, via the partial unique index, so a race between two
    admins clicking "assign" at once loses cleanly instead of double-issuing.
    """

    asset_id: uuid.UUID
    user_id: uuid.UUID
    # Optional so the common case is a bare assign, present so HR can record a
    # handover that physically happened last week.
    assigned_at: datetime | None = None
    assigned_condition_note: str | None = Field(default=None, max_length=2000)


class AssetReturnIn(BaseModel):
    """Close the open assignment on an asset.

    ``resulting_status`` exists because "returned" and "available again" are not
    the same event: a laptop handed back with a cracked screen must land in
    ``under_repair``, and without this the admin would have to remember a second
    edit that nothing prompts them to make.
    """

    returned_at: datetime | None = None
    returned_condition_note: str | None = Field(default=None, max_length=2000)
    resulting_status: str = Field(
        default="available", pattern=r"^(available|under_repair|retired)$"
    )


class AssetAssignmentOut(ORMModel):
    id: uuid.UUID
    asset_id: uuid.UUID
    user_id: uuid.UUID
    assigned_at: datetime
    returned_at: datetime | None = None
    assigned_condition_note: str | None = None
    returned_condition_note: str | None = None
    is_open: bool = False

    # Derived, so a history table needs no client-side joins.
    user_name: str | None = None
    asset_tag: str | None = None
    asset_category: str | None = None


class MyAssetOut(ORMModel):
    """One row of the employee's own read-only asset list."""

    assignment_id: uuid.UUID
    asset_id: uuid.UUID
    asset_tag: str
    name: str | None = None
    category: str
    serial_number: str | None = None
    assigned_at: datetime
    # Shown to the holder on purpose: the condition recorded at handover is the
    # thing they will be asked about at return, so they should be able to read
    # it the whole time they hold the asset.
    assigned_condition_note: str | None = None


class AssetRenewIn(BaseModel):
    """Record a renewal.

    ``next_due`` may be left out when the asset has a cycle; the server then
    moves the due date forward by one cycle from the *previous due date*, not
    from today, so renewing a week late does not quietly shift every future
    renewal by a week. ``stop_tracking`` ends renewals for good (subscription
    cancelled, licence not renewed).
    """

    renewed_on: date | None = None
    next_due: date | None = None
    cost_paise: int | None = Field(default=None, ge=0)
    reference: str | None = Field(default=None, max_length=120)
    note: str | None = Field(default=None, max_length=2000)
    stop_tracking: bool = False


class AssetRenewalOut(ORMModel):
    id: uuid.UUID
    asset_id: uuid.UUID
    renewed_on: date
    previous_due: date | None = None
    next_due: date | None = None
    cost_paise: int | None = None
    reference: str | None = None
    note: str | None = None
    renewed_by_name: str | None = None
    asset_tag: str | None = None
    asset_name: str | None = None
    created_at: datetime


class CountRow(BaseModel):
    key: str
    count: int
    value_paise: int = 0


class HolderRow(BaseModel):
    user_id: uuid.UUID
    name: str
    email: str | None = None
    count: int
    value_paise: int = 0


class AssetDashboardOut(BaseModel):
    """Everything the asset dashboard shows, in one round trip."""

    total: int
    active: int
    total_value_paise: int
    by_status: dict[str, int]
    by_category: list[CountRow]
    assigned: int
    holders: int
    renewals_tracked: int
    renewals_overdue: int
    renewals_due: int
    renewals_upcoming: int
    renewal_cost_due_paise: int
    renewal_cost_90d_paise: int
    warranty_expiring: int
    warranty_expired: int
    attention: list[AssetOut]
    top_holders: list[HolderRow]
    recent_renewals: list[AssetRenewalOut]
