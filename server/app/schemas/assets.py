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

CATEGORY_PATTERN = r"^(laptop|monitor|sim|id_card|other)$"
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


class AssetOut(ORMModel):
    id: uuid.UUID
    asset_tag: str
    category: str
    serial_number: str | None = None
    purchase_date: date | None = None
    status: str
    created_at: datetime

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
    category: str
    serial_number: str | None = None
    assigned_at: datetime
    # Shown to the holder on purpose: the condition recorded at handover is the
    # thing they will be asked about at return, so they should be able to read
    # it the whole time they hold the asset.
    assigned_condition_note: str | None = None
