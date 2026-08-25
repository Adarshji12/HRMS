"""Core HR — the employee master record and the lifetime document file.

Two tables, and the reason there are two rather than a pile of columns on
``users``:

**``employee_profiles`` is one-to-one with ``users``, not merged into it.**
``users`` is read on every single authenticated request — the token resolves to
a row, and that row carries the role and the permission flags every dependency
checks. Widening it by forty mostly-null personal columns would put an
employee's home address and bank details into the working set of every heartbeat
the desktop agent sends. The split also draws the permission line where it
belongs: reading a `User` is ordinary, reading an `EmployeeProfile` is not.

**``employee_documents`` is separate from ``onboarding_documents``.** They look
alike and are not the same thing. An onboarding document belongs to a checklist:
it exists to be collected once, it is verified against a task, and when the
checklist is archived it goes with it. An employee document belongs to the
*person* and outlives every checklist, contract and manager they will have —
a PAN card, a degree certificate, a signed policy acknowledgement, a visa with
an expiry date somebody has to chase. Filing the second kind into the first
means a hire's ID proof disappears the day HR tidies up their joining
checklist.

Statutory identity numbers are encrypted at rest (``core.crypto``) and masked on
the way out. See ``services/corehr`` for who may see a full value; the model's
job is only to make sure the plaintext is never what sits in the column.
"""

from __future__ import annotations

import enum
import uuid
from datetime import date, datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDMixin

if TYPE_CHECKING:
    from app.models.user import User


class EmploymentType(str, enum.Enum):
    FULL_TIME = "full_time"
    PART_TIME = "part_time"
    CONTRACT = "contract"
    INTERN = "intern"
    CONSULTANT = "consultant"


class ConfirmationStatus(str, enum.Enum):
    """Where someone stands against their probation.

    ``NOT_APPLICABLE`` is the default and is not a synonym for "on probation".
    Every profile that exists when this ships belongs to someone already
    working here, and defaulting them to ``PROBATION`` would put the entire
    workforce on a confirmation report on day one.
    """

    NOT_APPLICABLE = "not_applicable"
    PROBATION = "probation"
    CONFIRMED = "confirmed"
    EXTENDED = "extended"
    TERMINATED = "terminated"


class Gender(str, enum.Enum):
    FEMALE = "female"
    MALE = "male"
    OTHER = "other"
    #: Distinct from the field being NULL. NULL means nobody has filled the form
    #: in; this means the person was asked and declined, which is an answer HR
    #: must not keep re-asking for.
    UNDISCLOSED = "undisclosed"


class MaritalStatus(str, enum.Enum):
    SINGLE = "single"
    MARRIED = "married"
    DIVORCED = "divorced"
    WIDOWED = "widowed"
    OTHER = "other"


class EmployeeProfile(TimestampMixin, Base):
    """One row per employee, holding everything ``users`` deliberately does not.

    Keyed on ``user_id`` rather than carrying its own id: it is one-to-one with
    a user and always reached through one, so a separate primary key would only
    create the possibility of two profiles for one person.
    """

    __tablename__ = "employee_profiles"

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    # Denormalised from users.org_id so every query in this module can filter on
    # the tenant without a join. Every other HRMS table does the same; a module
    # that has to remember to join before it is safe is one that eventually
    # forgets.
    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )

    # --- personal ------------------------------------------------------------
    date_of_birth: Mapped[date | None] = mapped_column(Date, nullable=True)
    gender: Mapped[str | None] = mapped_column(String(16), nullable=True)
    marital_status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    blood_group: Mapped[str | None] = mapped_column(String(8), nullable=True)
    nationality: Mapped[str | None] = mapped_column(String(60), nullable=True)
    # A personal address, kept apart from users.email: the work address stops
    # working the day someone leaves, which is the day payroll most needs to
    # reach them about their Form 16.
    personal_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    alternate_phone: Mapped[str | None] = mapped_column(String(32), nullable=True)

    # --- addresses -----------------------------------------------------------
    # Two of them, because they genuinely differ for a large share of staff and
    # statutory paperwork asks for the permanent one specifically.
    current_address: Mapped[str | None] = mapped_column(Text, nullable=True)
    current_city: Mapped[str | None] = mapped_column(String(120), nullable=True)
    current_state: Mapped[str | None] = mapped_column(String(120), nullable=True)
    current_postal_code: Mapped[str | None] = mapped_column(String(20), nullable=True)
    current_country: Mapped[str | None] = mapped_column(String(2), nullable=True)

    permanent_address: Mapped[str | None] = mapped_column(Text, nullable=True)
    permanent_city: Mapped[str | None] = mapped_column(String(120), nullable=True)
    permanent_state: Mapped[str | None] = mapped_column(String(120), nullable=True)
    permanent_postal_code: Mapped[str | None] = mapped_column(String(20), nullable=True)
    permanent_country: Mapped[str | None] = mapped_column(String(2), nullable=True)

    # --- emergency contact ---------------------------------------------------
    emergency_name: Mapped[str | None] = mapped_column(String(160), nullable=True)
    emergency_relationship: Mapped[str | None] = mapped_column(String(60), nullable=True)
    emergency_phone: Mapped[str | None] = mapped_column(String(32), nullable=True)

    # --- statutory identity, encrypted ---------------------------------------
    #
    # Ciphertext, always. The `_enc` suffix is on the column name so that a
    # query written in a hurry reads wrong ("why is pan_enc a base64 blob") long
    # before it reaches a screen, rather than looking plausible and shipping.
    #
    # Aadhaar in particular: UIDAI's rules restrict what may be stored and
    # displayed, so the full value is encrypted, the API masks it by default,
    # and only the people who administer payroll can ask for the whole thing.
    pan_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    aadhaar_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    uan: Mapped[str | None] = mapped_column(String(24), nullable=True)
    pf_number: Mapped[str | None] = mapped_column(String(40), nullable=True)
    esi_number: Mapped[str | None] = mapped_column(String(40), nullable=True)

    #: Whether PF and ESI apply to *this person*, overriding the company
    #: default. Tri-state on purpose: NULL means "follow the company", which is
    #: the answer for almost everybody. A boolean defaulting False would exclude
    #: the whole workforce the day the column is added; defaulting True would
    #: enrol the directors and the international contractors who must not be.
    pf_applicable: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    esi_applicable: Mapped[bool | None] = mapped_column(Boolean, nullable=True)

    # --- bank, for salary credit ---------------------------------------------
    bank_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    bank_branch: Mapped[str | None] = mapped_column(String(120), nullable=True)
    bank_ifsc: Mapped[str | None] = mapped_column(String(16), nullable=True)
    bank_account_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    bank_account_name: Mapped[str | None] = mapped_column(String(160), nullable=True)

    # --- employment ----------------------------------------------------------
    #
    # `joined_on` deliberately stays on `users`: attendance, leave accrual and
    # tenure already read it there, and a second copy here would be the one that
    # drifts.
    employment_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    work_location: Mapped[str | None] = mapped_column(String(120), nullable=True)
    probation_months: Mapped[int | None] = mapped_column(Integer, nullable=True)
    probation_end_on: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)
    confirmation_status: Mapped[str] = mapped_column(
        String(20), default=ConfirmationStatus.NOT_APPLICABLE.value, nullable=False, index=True
    )
    confirmed_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    # Days of notice the contract requires. Nullable rather than defaulted:
    # "we have not recorded it" and "none required" are different, and a
    # settlement that silently recovers thirty days' pay against a default
    # nobody set is a settlement that gets disputed. The proposal says it is
    # missing instead of guessing.
    notice_period_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    confirmation_note: Mapped[str | None] = mapped_column(Text, nullable=True)

    # --- background verification --------------------------------------------
    bgv_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
    bgv_completed_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    bgv_agency: Mapped[str | None] = mapped_column(String(120), nullable=True)
    bgv_note: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Who last touched the record, for the audit trail's benefit. The AuditLog
    # row is the durable history; this is the cheap answer to "is this current"
    # that a profile screen can render without a second query.
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    user: Mapped["User"] = relationship(foreign_keys=[user_id], back_populates="profile")


class EmployeeDocument(UUIDMixin, TimestampMixin, Base):
    """A file that belongs to a person for as long as they are on the books."""

    __tablename__ = "employee_documents"
    __table_args__ = (
        # The two queries this table actually serves: one person's file, and
        # "what expires soon" across the company.
        Index("ix_employee_documents_user", "org_id", "user_id", "doc_type"),
        Index("ix_employee_documents_expiry", "org_id", "expires_on"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )

    doc_type: Mapped[str] = mapped_column(String(60), nullable=False)
    title: Mapped[str | None] = mapped_column(String(200), nullable=True)

    storage_key: Mapped[str] = mapped_column(String(500), nullable=False)
    file_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    content_type: Mapped[str | None] = mapped_column(String(120), nullable=True)
    file_size: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    issued_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    # Indexed above: a passport or work visa lapsing without anyone noticing is
    # the failure this column exists to prevent, and the report that prevents it
    # scans on exactly this.
    expires_on: Mapped[date | None] = mapped_column(Date, nullable=True)

    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    is_verified: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    verified_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
