"""Schemas for CRM opportunities and the requirement-type master."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from pydantic import Field, field_validator

from app.schemas.common import ORMModel
from app.schemas.crm import CrmBase, MasterOut, NamedIn


class RequirementTypeOut(MasterOut):
    sort_order: int = 0


class RequirementTypeIn(NamedIn):
    name: str = Field(min_length=1, max_length=80)
    sort_order: int = Field(default=0, ge=0, le=999)


class AttachmentOut(ORMModel):
    """What the console may know about a stored file — never its storage key."""

    name: str
    size: int | None = None


class OpportunityIn(CrmBase):
    title: str = Field(min_length=1, max_length=200)
    customer_id: uuid.UUID | None = None
    expected_revenue: Decimal = Field(default=Decimal("0"), ge=0, max_digits=14, decimal_places=2)
    probability: int = Field(default=0, ge=0, le=100)
    expected_closing: date | None = None
    priority: int = Field(default=0, ge=0, le=3)
    tags: list[str] = Field(default_factory=list, max_length=20)
    requirement_type_id: uuid.UUID | None = None
    oem_id: uuid.UUID | None = None
    raw_cost: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=2)
    team_id: uuid.UUID | None = None
    is_mail_send: bool = False
    #: Ticked on the form: send the costsheet to the approvers. Unticking
    #: withdraws it. Whatever they then decide is theirs to set, not the form's.
    send_costsheet_for_approval: bool = False
    notes: str | None = Field(default=None, max_length=4000)

    @field_validator("tags", mode="before")
    @classmethod
    def _clean_tags(cls, value):
        # Trimmed, blanks dropped, repeats collapsed (case-insensitively) with
        # the first spelling kept: "Urgent, urgent ," is one tag.
        if value is None:
            return []
        seen: set[str] = set()
        cleaned: list[str] = []
        for tag in value:
            text = str(tag).strip()[:40]
            if text and text.lower() not in seen:
                seen.add(text.lower())
                cleaned.append(text)
        return cleaned

    @field_validator("notes", mode="before")
    @classmethod
    def _blank_notes(cls, value):
        return None if value is None or str(value).strip() == "" else value


class CostsheetDecisionIn(CrmBase):
    decision: str = Field(pattern=r"^(approved|rejected)$")


class OpportunityOut(ORMModel):
    id: uuid.UUID
    lead_id: uuid.UUID
    lead_code: str | None = None
    lead_name: str | None = None
    title: str
    customer_id: uuid.UUID | None = None
    customer_name: str | None = None
    expected_revenue: Decimal
    probability: int
    expected_closing: date | None = None
    priority: int
    tags: list[str] = []
    requirement_type_id: uuid.UUID | None = None
    requirement_type_name: str | None = None
    oem_id: uuid.UUID | None = None
    oem_name: str | None = None
    raw_cost: Decimal | None = None
    #: Revenue less raw cost, and that as a share of revenue. Worked out on the
    #: way out, not stored: a stored margin is a second number that goes stale
    #: the moment either input is edited.
    margin: Decimal | None = None
    margin_percent: Decimal | None = None
    team_id: uuid.UUID | None = None
    team_name: str | None = None
    is_mail_send: bool = False
    costsheet_status: str = "none"
    notes: str | None = None
    #: The lead's owner — the opportunity's salesperson.
    owner_id: uuid.UUID | None = None
    owner_name: str | None = None
    costsheet: AttachmentOut | None = None
    quotation: AttachmentOut | None = None
    created_at: datetime
