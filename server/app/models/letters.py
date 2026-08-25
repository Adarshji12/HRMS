"""HR letters — the templates, and the letters actually issued from them.

Two tables, and the important thing about the second one:

**An issued letter stores its own rendered text.** Not a template id and a
promise to re-render. A letter is a statement about facts as they stood on the
day it was signed — "Priya Sharma, Senior Engineer, joined 3 August 2026" — and
those facts change. Re-rendering an experience letter after somebody's
designation is updated would silently rewrite a document a bank or a consulate
already holds. Same argument as ``timesheet_approvals`` freezing its totals: the
number that was signed off must not move.

So the template is editable and the issued letter is not. Editing a template
changes what the *next* letter says and nothing about the last one, and deleting
a template leaves every letter issued from it intact and readable.

The issued letter is also filed into the employee's permanent document record
(``employee_documents``) so it turns up where somebody would look for it —
alongside their contract and their ID proof, rather than only in a letters
screen they have to know exists.
"""

from __future__ import annotations

import enum
import uuid
from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDMixin


class LetterType(str, enum.Enum):
    """What a letter is for.

    Not free text: the type drives which letters an employee may request, which
    ones a report counts, and the default reference prefix. ``CUSTOM`` is the
    escape hatch for the letter nobody anticipated, and it exists so that the
    other values can stay meaningful rather than being stretched.
    """

    OFFER = "offer"
    APPOINTMENT = "appointment"
    CONFIRMATION = "confirmation"
    PROBATION_EXTENSION = "probation_extension"
    EXPERIENCE = "experience"
    RELIEVING = "relieving"
    SALARY_CERTIFICATE = "salary_certificate"
    ADDRESS_PROOF = "address_proof"
    WARNING = "warning"
    CUSTOM = "custom"


class LetterStatus(str, enum.Enum):
    """A letter's life.

    ``DRAFT`` re-renders on every read, because the point of a draft is to see
    what the current facts produce. ``ISSUED`` is frozen. ``REVOKED`` is still
    frozen and still readable — withdrawing a letter is a new fact about it, not
    permission to pretend it never said what it said.
    """

    DRAFT = "draft"
    ISSUED = "issued"
    REVOKED = "revoked"


class LetterTemplate(UUIDMixin, TimestampMixin, Base):
    """A reusable body with ``{{merge.fields}}`` in it."""

    __tablename__ = "letter_templates"
    __table_args__ = (
        Index("ix_letter_templates_org_type", "org_id", "letter_type"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    letter_type: Mapped[str] = mapped_column(
        String(32), default=LetterType.CUSTOM.value, nullable=False
    )
    description: Mapped[str | None] = mapped_column(String(400), nullable=True)

    subject: Mapped[str | None] = mapped_column(String(300), nullable=True)
    #: The body, with merge tokens intact. Plain text with blank-line
    #: paragraphs, not HTML: a customer pasting from a word processor brings
    #: markup nobody can style consistently, and the renderer wraps paragraphs
    #: into the letterhead itself.
    body: Mapped[str] = mapped_column(Text, nullable=False)

    #: Appears above the signature block. Kept on the template rather than the
    #: organisation because a warning letter and an offer letter are signed by
    #: different people.
    signatory_name: Mapped[str | None] = mapped_column(String(160), nullable=True)
    signatory_title: Mapped[str | None] = mapped_column(String(160), nullable=True)

    #: Employees may request a letter of this type themselves. Off by default:
    #: an offer letter is not something anybody requests about themselves, and a
    #: default of "on" would put every template in the self-service list the
    #: moment it was created.
    employee_requestable: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )

    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )


class IssuedLetter(UUIDMixin, TimestampMixin, Base):
    """One letter, for one person, frozen at the moment it was issued."""

    __tablename__ = "issued_letters"
    __table_args__ = (
        # Per organisation, not global: two companies both numbering from
        # ACME/HR/2026/0001 is fine and expected.
        UniqueConstraint("org_id", "reference_no", name="uq_issued_letters_reference"),
        Index("ix_issued_letters_user", "org_id", "user_id", "letter_type"),
        Index("ix_issued_letters_status", "org_id", "status"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    #: SET NULL, not CASCADE. Deleting a template must not delete the letters
    #: issued from it — those are records of what the company told somebody.
    template_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("letter_templates.id", ondelete="SET NULL"), nullable=True
    )

    #: Copied from the template rather than joined, for the same reason the body
    #: is: the template can be edited or deleted, and this letter's type is part
    #: of what it *was*.
    letter_type: Mapped[str] = mapped_column(String(32), nullable=False)
    template_name: Mapped[str | None] = mapped_column(String(160), nullable=True)

    #: NULL while a draft. Allocated at issue, which is what makes the number
    #: mean "this letter was actually issued" rather than "somebody opened a
    #: preview".
    reference_no: Mapped[str | None] = mapped_column(String(60), nullable=True)

    subject: Mapped[str | None] = mapped_column(String(300), nullable=True)
    #: The frozen text. See the module docstring — this is the whole design.
    body: Mapped[str] = mapped_column(Text, nullable=False)
    signatory_name: Mapped[str | None] = mapped_column(String(160), nullable=True)
    signatory_title: Mapped[str | None] = mapped_column(String(160), nullable=True)

    status: Mapped[str] = mapped_column(
        String(16), default=LetterStatus.DRAFT.value, nullable=False
    )
    issued_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    issued_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    revoked_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    #: The copy filed into the employee's permanent document record. Nullable
    #: because filing is a side effect that must not be able to fail the issue —
    #: same posture as promoting an onboarding document.
    document_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("employee_documents.id", ondelete="SET NULL"), nullable=True
    )

    #: Set when an employee asked for this letter rather than HR originating it.
    requested_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    request_note: Mapped[str | None] = mapped_column(Text, nullable=True)
