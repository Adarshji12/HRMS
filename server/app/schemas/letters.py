"""Request/response shapes for letters.

Two rules, both of which exist because the alternative is a letter that says
something nobody chose:

**No response carries a template's body to an employee.** ``TemplateOut`` is an
administrator's view; ``RequestableTemplateOut`` is what self-service sees, and
it has a name and a type and nothing else. A template body can name any merge
field, so shipping the full list to everyone would tell the whole company what
the company puts in its warning letters.

**A draft's body is editable; an issued letter's is not represented as editable
anywhere.** ``LetterDraftUpdate`` exists and there is no equivalent for an
issued letter — the immutability is in the shape of the API, not only in a check
inside the service.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, Field, field_validator

from app.models.letters import LetterType
from app.schemas.common import ORMModel


class TemplateIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    letter_type: LetterType = LetterType.CUSTOM
    description: str | None = Field(default=None, max_length=400)
    subject: str | None = Field(default=None, max_length=300)
    body: str = Field(min_length=1, max_length=20000)
    signatory_name: str | None = Field(default=None, max_length=160)
    signatory_title: str | None = Field(default=None, max_length=160)
    #: Defaults off. An offer letter is not something anybody requests about
    #: themselves, and defaulting to on would put every new template into the
    #: self-service list the moment it was created.
    employee_requestable: bool = False
    is_active: bool = True

    @field_validator("body", mode="after")
    @classmethod
    def _body_not_blank(cls, value: str) -> str:
        # min_length=1 happily accepts "   ", which stores a letter body that
        # renders to an empty page.
        if not value.strip():
            raise ValueError("the letter body must not be blank")
        return value


class TemplateUpdate(BaseModel):
    """Every field optional — a template is edited one part at a time."""

    name: str | None = Field(default=None, min_length=1, max_length=160)
    letter_type: LetterType | None = None
    description: str | None = Field(default=None, max_length=400)
    subject: str | None = Field(default=None, max_length=300)
    body: str | None = Field(default=None, min_length=1, max_length=20000)
    signatory_name: str | None = Field(default=None, max_length=160)
    signatory_title: str | None = Field(default=None, max_length=160)
    employee_requestable: bool | None = None
    is_active: bool | None = None

    @field_validator("body", mode="after")
    @classmethod
    def _body_not_blank(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("the letter body must not be blank")
        return value


class TemplateOut(ORMModel):
    id: uuid.UUID
    org_id: uuid.UUID
    name: str
    letter_type: str
    description: str | None = None
    subject: str | None = None
    body: str
    signatory_name: str | None = None
    signatory_title: str | None = None
    employee_requestable: bool = False
    is_active: bool = True
    created_at: datetime
    #: Tokens this body uses that are not in the registry. Empty on a saved
    #: template — the service refuses to save one with unknown fields — but
    #: carried anyway so the editor can show the problem before the save.
    unknown_fields: list[str] = []


class RequestableTemplateOut(ORMModel):
    """What an employee sees in the "request a letter" list. No body."""

    id: uuid.UUID
    name: str
    letter_type: str
    description: str | None = None


class MergeFieldOut(BaseModel):
    token: str
    label: str
    example: str
    group: str


class PreviewOut(BaseModel):
    """What a template produces for one person, before anything is created."""

    text: str
    #: A typo in the template. The console should refuse to issue on this.
    unknown: list[str] = []
    #: Registered fields that resolved to nothing because that person's record
    #: is incomplete. A warning — a letter for somebody with no work location is
    #: still a valid letter.
    empty: list[str] = []


class DraftIn(BaseModel):
    template_id: uuid.UUID
    user_id: uuid.UUID


class LetterDraftUpdate(BaseModel):
    """Edit this one letter's wording without touching the template.

    Deliberately has no counterpart for an issued letter. The immutability is
    part of the API's shape rather than only a check in the service.
    """

    subject: str | None = Field(default=None, max_length=300)
    body: str | None = Field(default=None, min_length=1, max_length=20000)
    signatory_name: str | None = Field(default=None, max_length=160)
    signatory_title: str | None = Field(default=None, max_length=160)


class IssueIn(BaseModel):
    #: Optional, and backdating is allowed on purpose: a letter is often signed
    #: on the day it is dated rather than the day somebody gets round to
    #: recording it. The audit row carries the real timestamp either way.
    issued_on: date | None = None


class RevokeIn(BaseModel):
    reason: str = Field(min_length=1, max_length=2000)


class LetterRequestIn(BaseModel):
    """An employee asking for a letter about themselves.

    No ``user_id``. The subject is the authenticated caller and nothing else —
    "request a letter about a colleague" should not be expressible.
    """

    template_id: uuid.UUID
    note: str | None = Field(default=None, max_length=2000)


class LetterOut(ORMModel):
    id: uuid.UUID
    org_id: uuid.UUID
    user_id: uuid.UUID
    template_id: uuid.UUID | None = None
    letter_type: str
    template_name: str | None = None
    reference_no: str | None = None
    subject: str | None = None
    body: str
    signatory_name: str | None = None
    signatory_title: str | None = None
    status: str
    issued_on: date | None = None
    revoked_at: datetime | None = None
    revoked_reason: str | None = None
    request_note: str | None = None
    created_at: datetime

    #: Derived, so no client joins.
    user_name: str | None = None
    issued_by_name: str | None = None
    revoked_by_name: str | None = None
    requested_by_name: str | None = None
    #: Whether a copy reached the employee's permanent document file. Filing is
    #: a side effect that is allowed to fail, so a screen has to be able to say
    #: "issued but not filed" rather than implying both always happen.
    is_filed: bool = False
