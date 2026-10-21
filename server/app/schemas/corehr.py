"""Request/response shapes for the employee master record.

The one thing to get right here: **no response model carries a decrypted
statutory number by default.** ``EmployeeProfileOut`` exposes ``pan_masked``,
never ``pan``. Revealing a full value is a separate endpoint with its own
permission and its own audit row, so a full PAN cannot reach a screen by
somebody adding a field to a serialiser and not noticing what it did.

The second: identity is never taken from a body. ``EmployeeProfileIn`` has no
``user_id`` and no ``updated_by`` — the subject comes from the path and the
editor from the authenticated caller, the same rule regularization and leave
already follow.
"""

from __future__ import annotations

import re
import uuid
from datetime import date, datetime

from pydantic import BaseModel, EmailStr, Field, field_validator

from app.models.corehr import (
    AttendanceType,
    ConfirmationStatus,
    EmploymentType,
    Gender,
    MaritalStatus,
)
from app.schemas.common import ORMModel

# Format checks, not existence checks. A well-formed PAN can still be somebody
# else's, and only the tax department can say otherwise — but a typo caught at
# entry is a typo that never reaches a payroll filing, where the correction is a
# revised return rather than an edit.
PAN_RE = re.compile(r"^[A-Z]{5}[0-9]{4}[A-Z]$")
AADHAAR_RE = re.compile(r"^[0-9]{12}$")
IFSC_RE = re.compile(r"^[A-Z]{4}0[A-Z0-9]{6}$")
UAN_RE = re.compile(r"^[0-9]{12}$")


def _clean(value: str | None) -> str | None:
    """Trim, and turn blank into None.

    Blank-to-None matters more than it looks: a form that posts every field
    every time would otherwise write ``""`` over a real PAN, and ``""`` is not
    distinguishable from "cleared on purpose" once it is in the column.
    """
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


class EmployeeProfileIn(BaseModel):
    """A partial update of one person's master record.

    Every field is optional and ``exclude_unset`` decides what is written, so
    the personal-details form and the payroll-details form can each submit their
    own half without the other's fields arriving as null and wiping them.
    """

    date_of_birth: date | None = None
    gender: Gender | None = None
    marital_status: MaritalStatus | None = None
    blood_group: str | None = Field(default=None, max_length=8)
    nationality: str | None = Field(default=None, max_length=60)
    father_name: str | None = Field(default=None, max_length=160)
    personal_email: EmailStr | None = None
    alternate_phone: str | None = Field(default=None, max_length=32)

    current_address: str | None = Field(default=None, max_length=1000)
    current_city: str | None = Field(default=None, max_length=120)
    current_state: str | None = Field(default=None, max_length=120)
    current_postal_code: str | None = Field(default=None, max_length=20)
    current_country: str | None = Field(default=None, min_length=2, max_length=2)

    permanent_address: str | None = Field(default=None, max_length=1000)
    permanent_city: str | None = Field(default=None, max_length=120)
    permanent_state: str | None = Field(default=None, max_length=120)
    permanent_postal_code: str | None = Field(default=None, max_length=20)
    permanent_country: str | None = Field(default=None, min_length=2, max_length=2)

    emergency_name: str | None = Field(default=None, max_length=160)
    emergency_relationship: str | None = Field(default=None, max_length=60)
    emergency_phone: str | None = Field(default=None, max_length=32)

    # Plaintext in, ciphertext at rest. The service encrypts; nothing else does,
    # so there is one place to check that it happens.
    pan: str | None = Field(default=None, max_length=10)
    # 20, not 12: people type "1234 5678 9012" and the validator below strips
    # the spacing. A bound of 12 would 422 the most natural way to enter it,
    # before the normaliser ever ran.
    aadhaar: str | None = Field(default=None, max_length=20)
    uan: str | None = Field(default=None, max_length=24)
    pf_number: str | None = Field(default=None, max_length=40)
    esi_number: str | None = Field(default=None, max_length=40)

    bank_name: str | None = Field(default=None, max_length=120)
    bank_branch: str | None = Field(default=None, max_length=120)
    bank_ifsc: str | None = Field(default=None, max_length=16)
    bank_account: str | None = Field(default=None, max_length=32)
    bank_account_name: str | None = Field(default=None, max_length=160)

    @field_validator("pan", mode="after")
    @classmethod
    def _pan(cls, value: str | None) -> str | None:
        value = _clean(value)
        if value is None:
            return None
        # Uppercased before matching rather than matched case-insensitively:
        # what gets stored has to be canonical, because payroll files it and a
        # lowercase PAN on a return is a rejected return.
        value = value.upper()
        if not PAN_RE.match(value):
            raise ValueError("PAN must look like ABCDE1234F")
        return value

    @field_validator("aadhaar", mode="after")
    @classmethod
    def _aadhaar(cls, value: str | None) -> str | None:
        value = _clean(value)
        if value is None:
            return None
        digits = re.sub(r"[\s-]", "", value)
        if not AADHAAR_RE.match(digits):
            raise ValueError("Aadhaar must be 12 digits")
        return digits

    @field_validator("uan", mode="after")
    @classmethod
    def _uan(cls, value: str | None) -> str | None:
        value = _clean(value)
        if value is None:
            return None
        if not UAN_RE.match(value):
            raise ValueError("UAN must be 12 digits")
        return value

    @field_validator("bank_ifsc", mode="after")
    @classmethod
    def _ifsc(cls, value: str | None) -> str | None:
        value = _clean(value)
        if value is None:
            return None
        value = value.upper()
        if not IFSC_RE.match(value):
            raise ValueError("IFSC must look like HDFC0001234")
        return value

    @field_validator(
        "blood_group", "nationality", "alternate_phone",
        "current_address", "current_city", "current_state", "current_postal_code",
        "permanent_address", "permanent_city", "permanent_state", "permanent_postal_code",
        "emergency_name", "emergency_relationship", "emergency_phone",
        "pf_number", "esi_number", "bank_name", "bank_branch",
        "bank_account", "bank_account_name",
        mode="after",
    )
    @classmethod
    def _tidy(cls, value: str | None) -> str | None:
        return _clean(value)

    @field_validator("current_country", "permanent_country", mode="after")
    @classmethod
    def _country(cls, value: str | None) -> str | None:
        value = _clean(value)
        return value.upper() if value else None


class EmploymentIn(BaseModel):
    """The employment half — HR's to set, never the employee's.

    Separate from ``EmployeeProfileIn`` because the permission differs, and a
    single model would mean the endpoint that lets someone edit their own
    address also accepts a confirmation date. Two models make that
    unrepresentable rather than guarded by an ``if``.
    """

    employment_type: EmploymentType | None = None
    work_location: str | None = Field(default=None, max_length=120)
    attendance_type: AttendanceType | None = None
    grade: str | None = Field(default=None, max_length=40)
    probation_months: int | None = Field(default=None, ge=0, le=36)
    #: Days of contractual notice. Null means "not recorded", which a
    #: settlement reports rather than treating as zero — see
    #: ``services/settlement``.
    notice_period_days: int | None = Field(default=None, ge=0, le=365)
    probation_end_on: date | None = None
    bgv_status: str | None = Field(default=None, max_length=20)
    bgv_completed_on: date | None = None
    bgv_agency: str | None = Field(default=None, max_length=120)
    bgv_note: str | None = Field(default=None, max_length=2000)


class ConfirmationIn(BaseModel):
    """Move somebody's probation to its next state.

    Its own model, and its own endpoint, because confirmation is an event with
    consequences (it ends probation, it is what a confirmation letter cites) and
    not a field edit. Folding it into the employment PATCH would make it
    invisible in the audit trail among twenty other columns.
    """

    status: ConfirmationStatus
    effective_on: date | None = None
    note: str | None = Field(default=None, max_length=2000)


class EmployeeProfileOut(ORMModel):
    """One master record, with every sensitive value masked.

    ``pan_masked`` rather than ``pan``, and no ``aadhaar`` field at all in the
    unmasked sense — a caller who genuinely needs the full number asks the
    reveal endpoint for it, which checks a permission and writes an audit row.
    Getting this wrong is not a display bug; it is thousands of identity numbers
    in a browser cache.
    """

    user_id: uuid.UUID
    org_id: uuid.UUID

    full_name: str | None = None
    email: str | None = None
    employee_code: str | None = None
    joined_on: date | None = None
    designation: str | None = None
    department: str | None = None
    team: str | None = None
    manager_name: str | None = None
    status: str | None = None

    date_of_birth: date | None = None
    gender: str | None = None
    marital_status: str | None = None
    blood_group: str | None = None
    nationality: str | None = None
    father_name: str | None = None
    personal_email: str | None = None
    alternate_phone: str | None = None

    current_address: str | None = None
    current_city: str | None = None
    current_state: str | None = None
    current_postal_code: str | None = None
    current_country: str | None = None

    permanent_address: str | None = None
    permanent_city: str | None = None
    permanent_state: str | None = None
    permanent_postal_code: str | None = None
    permanent_country: str | None = None

    emergency_name: str | None = None
    emergency_relationship: str | None = None
    emergency_phone: str | None = None

    pan_masked: str | None = None
    aadhaar_masked: str | None = None
    uan: str | None = None
    pf_number: str | None = None
    esi_number: str | None = None
    #: So a form can show "PAN on file" without the number, and can tell that
    #: apart from "nobody has entered one".
    has_pan: bool = False
    has_aadhaar: bool = False
    has_bank_account: bool = False

    bank_name: str | None = None
    bank_branch: str | None = None
    bank_ifsc: str | None = None
    bank_account_masked: str | None = None
    bank_account_name: str | None = None

    employment_type: str | None = None
    work_location: str | None = None
    attendance_type: str | None = None
    grade: str | None = None
    probation_months: int | None = None
    notice_period_days: int | None = None
    probation_end_on: date | None = None
    confirmation_status: str = ConfirmationStatus.NOT_APPLICABLE.value
    confirmed_on: date | None = None
    confirmation_note: str | None = None

    bgv_status: str | None = None
    bgv_completed_on: date | None = None
    bgv_agency: str | None = None
    bgv_note: str | None = None

    updated_by_name: str | None = None
    updated_at: datetime | None = None

    #: What the *caller* may do with this record, resolved server-side. The
    #: console renders from this instead of re-deriving the rule from a role and
    #: a flag, because two implementations of one permission rule diverge and
    #: the UI's copy is the one nobody tests.
    can_edit_personal: bool = False
    can_edit_employment: bool = False
    can_reveal: bool = False


class RevealOut(BaseModel):
    """One decrypted value, handed over deliberately."""

    field: str
    value: str


class EmployeeDocumentIn(BaseModel):
    doc_type: str = Field(min_length=1, max_length=60)
    title: str | None = Field(default=None, max_length=200)
    issued_on: date | None = None
    expires_on: date | None = None
    note: str | None = Field(default=None, max_length=2000)


class EmployeeDocumentOut(ORMModel):
    id: uuid.UUID
    org_id: uuid.UUID
    user_id: uuid.UUID
    doc_type: str
    title: str | None = None
    file_name: str | None = None
    content_type: str | None = None
    file_size: int = 0
    issued_on: date | None = None
    expires_on: date | None = None
    is_verified: bool = False
    verified_at: datetime | None = None
    note: str | None = None
    created_at: datetime

    # Deliberately absent: storage_key. A client that has the key does not need
    # the permission check on the download route, which is the whole point of
    # having one.
    uploaded_by_name: str | None = None
    verified_by_name: str | None = None
    user_name: str | None = None
    #: Days until expiry; negative means already lapsed. Computed server-side so
    #: "expiring soon" means the same thing on the list, the dashboard tile and
    #: the report, instead of three date subtractions in three places.
    days_to_expiry: int | None = None


class DocumentVerifyIn(BaseModel):
    is_verified: bool = True
    note: str | None = Field(default=None, max_length=2000)


class DirectoryEntryOut(BaseModel):
    """A colleague, as anyone in the company may see them.

    Work contact details only. No date of birth, no address, no statutory
    anything — a directory that leaks the master record is the master record
    with extra steps.
    """

    user_id: uuid.UUID
    full_name: str
    email: str
    phone: str | None = None
    employee_code: str | None = None
    designation: str | None = None
    department: str | None = None
    team: str | None = None
    manager_name: str | None = None
    work_location: str | None = None
    status: str | None = None
