from __future__ import annotations

import uuid

import re

from pydantic import BaseModel, Field, field_validator

from app.schemas.common import ORMModel


class DepartmentIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    code: str | None = Field(default=None, max_length=32)
    description: str | None = Field(default=None, max_length=2000)
    parent_id: uuid.UUID | None = None
    head_user_id: uuid.UUID | None = None
    # PATCH replaces the whole record, so an omitted flag means active — the
    # older forms that never sent it keep behaving as they did.
    is_active: bool = True


class DepartmentOut(ORMModel):
    id: uuid.UUID
    name: str
    code: str | None = None
    description: str | None = None
    parent_id: uuid.UUID | None = None
    head_user_id: uuid.UUID | None = None
    is_active: bool
    # Derived, so a table needs no client-side joins.
    head_name: str | None = None
    team_count: int = 0
    member_count: int = 0


class TeamIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    department_id: uuid.UUID | None = None
    manager_user_id: uuid.UUID | None = None


class TeamOut(ORMModel):
    id: uuid.UUID
    name: str
    description: str | None = None
    department_id: uuid.UUID | None = None
    manager_user_id: uuid.UUID | None = None
    is_active: bool
    department_name: str | None = None
    manager_name: str | None = None
    member_count: int = 0


class DesignationIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    # 1 is the most senior; larger numbers sit further down the ladder.
    level: int = Field(default=1, ge=1, le=100)
    #: A few letters for the title. Blank is stored as none; kept upper case.
    code: str | None = Field(default=None, max_length=12)
    department_id: uuid.UUID | None = None
    is_active: bool = True

    @field_validator("code")
    @classmethod
    def _tidy_code(cls, value: str | None) -> str | None:
        value = (value or "").strip().upper()
        return value or None


class DesignationOut(ORMModel):
    id: uuid.UUID
    name: str
    code: str | None = None
    level: int
    department_id: uuid.UUID | None = None
    department_name: str | None = None
    is_active: bool
    member_count: int = 0


class ScheduleIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    start_time: str = Field(default="09:00", pattern=r"^\d{2}:\d{2}$")
    end_time: str = Field(default="18:00", pattern=r"^\d{2}:\d{2}$")
    working_days: int = Field(default=0b0011111, ge=0, le=0b1111111)
    break_minutes: int = Field(default=60, ge=0, le=480)
    overtime_after_minutes: int = Field(default=480, ge=60, le=1440)
    is_default: bool = False


class ScheduleOut(ORMModel):
    id: uuid.UUID
    name: str
    start_time: str
    end_time: str
    working_days: int
    break_minutes: int
    overtime_after_minutes: int
    is_default: bool
    expected_minutes: int
    member_count: int = 0


class AssignRequest(BaseModel):
    """Bulk move — used by the roster's multi-select."""

    user_ids: list[uuid.UUID] = Field(min_length=1, max_length=500)
    department_id: uuid.UUID | None = None
    team_id: uuid.UUID | None = None
    designation_id: uuid.UUID | None = None
    schedule_id: uuid.UUID | None = None
    manager_id: uuid.UUID | None = None
    # Explicit clears, since None already means "leave unchanged".
    clear_team: bool = False
    clear_department: bool = False
    clear_manager: bool = False


_EMAIL = re.compile(r"^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]{2,}$")


def _blank_to_none(value: str | None) -> str | None:
    value = (value or "").strip()
    return value or None


class BranchIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    code: str | None = Field(default=None, max_length=12)
    address: str | None = Field(default=None, max_length=500)
    country: str | None = Field(default=None, max_length=80)
    state: str | None = Field(default=None, max_length=120)
    district: str | None = Field(default=None, max_length=120)
    city: str | None = Field(default=None, max_length=120)
    pincode: str | None = Field(default=None, max_length=12)
    phone: str | None = Field(default=None, max_length=32)
    email: str | None = Field(default=None, max_length=254)
    is_head_office: bool = False
    is_active: bool = True

    @field_validator("address", "country", "state", "district", "city", "pincode", "phone", "email")
    @classmethod
    def _blank_is_none(cls, value: str | None) -> str | None:
        return _blank_to_none(value)

    @field_validator("code")
    @classmethod
    def _tidy_code(cls, value: str | None) -> str | None:
        value = (value or "").strip().upper()
        return value or None

    @field_validator("email")
    @classmethod
    def _an_address(cls, value: str | None) -> str | None:
        if value is not None and not _EMAIL.match(value):
            raise ValueError("Enter a valid email address")
        return value


class BranchOut(ORMModel):
    id: uuid.UUID
    name: str
    code: str | None = None
    address: str | None = None
    country: str | None = None
    state: str | None = None
    district: str | None = None
    city: str | None = None
    pincode: str | None = None
    phone: str | None = None
    email: str | None = None
    is_head_office: bool
    is_active: bool
    #: Locations that belong to this branch.
    location_count: int = 0
