from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.models.user import UserStatus


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class LoginRequest(BaseModel):
    # Deliberately not EmailStr: login must not 422 on an address the account
    # actually has. Format is enforced at account creation instead.
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=1, max_length=200)


class TenantInfo(ORMModel):
    id: uuid.UUID
    name: str
    slug: str
    timezone: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    organization: TenantInfo


class UserOut(ORMModel):
    id: uuid.UUID
    email: str
    full_name: str
    role: str
    timezone: str
    is_active: bool
    created_at: datetime
    notice_accepted_at: datetime | None = None

    employee_code: str | None = None
    phone: str | None = None
    joined_on: date | None = None

    department_id: uuid.UUID | None = None
    team_id: uuid.UUID | None = None
    designation_id: uuid.UUID | None = None
    schedule_id: uuid.UUID | None = None
    manager_id: uuid.UUID | None = None

    # Resolved names, so a roster table needs no client-side joins. These come
    # from model properties, not columns.
    team_name: str | None = None
    department_name: str | None = None
    designation_name: str | None = None
    # Permissions restrict within the role; they never grant beyond it. See the
    # note on the columns in app.models.user.
    can_view_screenshots: bool = True
    can_approve_timesheets: bool = True
    can_export_data: bool = True
    can_manage_projects: bool = True
    # HRMS. Same direction as the four above — they restrict, never grant.
    can_approve_leave: bool = True
    can_approve_regularization: bool = True
    can_manage_assets: bool = True
    can_manage_onboarding: bool = True
    can_manage_helpdesk: bool = True
    can_manage_people: bool = True
    can_issue_letters: bool = True
    can_approve_expenses: bool = True
    can_reimburse_expenses: bool = True
    can_approve_loans: bool = True
    can_disburse_loans: bool = True
    #: The one flag here that GRANTS rather than restricts, and so the one that
    #: defaults False. Every other flag narrows a capability the role already
    #: implies; payroll had none to narrow, and defaulting it True would hand a
    #: new administrator every salary in the company. The account owner holds it
    #: implicitly in ``services/payroll.can_manage``, so a workspace can never
    #: lock itself out of its own payroll.
    can_manage_payroll: bool = False
    can_manage_performance: bool = True
    can_manage_engagement: bool = True
    #: Employment lifecycle: pending_setup | active | inactive. Descriptive
    #: only — `is_active` is the authentication gate (D-016). Defaults to
    #: active so an ordinary hire needs no extra field.
    status: str = "active"
    # NULL for every row that existed before the column did. Coerced rather
    # than declared optional so callers always get a list and never have to
    # write `?? []` — and because leaving it strict broke /auth/me for every
    # user at once, which is a logout for the whole product.
    hidden_pages: list[str] = []

    @field_validator("hidden_pages", mode="before")
    @classmethod
    def _none_is_empty(cls, v: object) -> object:
        return v or []

class UserWithKeyOut(UserOut):
    enrollment_key: str


class UserCreate(BaseModel):
    email: EmailStr
    full_name: str = Field(min_length=1, max_length=200)
    password: str | None = Field(default=None, min_length=8, max_length=200)
    role: str = "employee"
    timezone: str = "UTC"
    employee_code: str | None = Field(default=None, max_length=40)
    phone: str | None = Field(default=None, max_length=32)
    joined_on: date | None = None
    department_id: uuid.UUID | None = None
    team_id: uuid.UUID | None = None
    designation_id: uuid.UUID | None = None
    schedule_id: uuid.UUID | None = None
    manager_id: uuid.UUID | None = None
    can_view_screenshots: bool = True
    can_approve_timesheets: bool = True
    can_export_data: bool = True
    can_manage_projects: bool = True
    # HRMS. Same direction as the four above — they restrict, never grant.
    can_approve_leave: bool = True
    can_approve_regularization: bool = True
    can_manage_assets: bool = True
    can_manage_onboarding: bool = True
    can_manage_helpdesk: bool = True
    can_manage_people: bool = True
    can_issue_letters: bool = True
    can_approve_expenses: bool = True
    can_reimburse_expenses: bool = True
    can_approve_loans: bool = True
    can_disburse_loans: bool = True
    #: The one flag here that GRANTS rather than restricts, and so the one that
    #: defaults False. Every other flag narrows a capability the role already
    #: implies; payroll had none to narrow, and defaulting it True would hand a
    #: new administrator every salary in the company. The account owner holds it
    #: implicitly in ``services/payroll.can_manage``, so a workspace can never
    #: lock itself out of its own payroll.
    can_manage_payroll: bool = False
    can_manage_performance: bool = True
    can_manage_engagement: bool = True
    #: Employment lifecycle: pending_setup | active | inactive. Descriptive
    #: only — `is_active` is the authentication gate (D-016). Defaults to
    #: active so an ordinary hire needs no extra field.
    status: str = "active"
    #: Page keys this person may not open. Empty = everything their role reaches.
    hidden_pages: list[str] = []

    @field_validator("status")
    @classmethod
    def _known_status(cls, value):
        """Reject a lifecycle value the product has no meaning for.

        The column is a plain String (matching organizations.status), so nothing
        below this stops a typo becoming a permanent state that no query filters
        on and no screen renders. Validating at the edge is the only place it is
        cheap.
        """
        if value is None:
            return value
        allowed = {s.value for s in UserStatus}
        if value not in allowed:
            raise ValueError(f"status must be one of {sorted(allowed)}")
        return value

class UserUpdate(BaseModel):
    full_name: str | None = Field(default=None, min_length=1, max_length=200)
    role: str | None = None
    timezone: str | None = None
    is_active: bool | None = None
    password: str | None = Field(default=None, min_length=8, max_length=200)
    employee_code: str | None = Field(default=None, max_length=40)
    phone: str | None = Field(default=None, max_length=32)
    joined_on: date | None = None
    department_id: uuid.UUID | None = None
    team_id: uuid.UUID | None = None
    designation_id: uuid.UUID | None = None
    schedule_id: uuid.UUID | None = None
    manager_id: uuid.UUID | None = None
    can_view_screenshots: bool | None = None
    can_approve_timesheets: bool | None = None
    can_export_data: bool | None = None
    can_manage_projects: bool | None = None
    can_approve_leave: bool | None = None
    can_approve_regularization: bool | None = None
    can_manage_assets: bool | None = None
    can_manage_onboarding: bool | None = None
    can_manage_helpdesk: bool | None = None
    can_manage_people: bool | None = None
    can_issue_letters: bool | None = None
    can_approve_expenses: bool | None = None
    can_reimburse_expenses: bool | None = None
    can_approve_loans: bool | None = None
    can_disburse_loans: bool | None = None
    #: Grants rather than restricts — see UserCreate.
    can_manage_payroll: bool | None = None
    can_manage_performance: bool | None = None
    can_manage_engagement: bool | None = None
    status: str | None = None
    hidden_pages: list[str] | None = None

    @field_validator("status")
    @classmethod
    def _known_status(cls, value):
        """Reject a lifecycle value the product has no meaning for.

        The column is a plain String (matching organizations.status), so nothing
        below this stops a typo becoming a permanent state that no query filters
        on and no screen renders. Validating at the edge is the only place it is
        cheap.
        """
        if value is None:
            return value
        allowed = {s.value for s in UserStatus}
        if value not in allowed:
            raise ValueError(f"status must be one of {sorted(allowed)}")
        return value

class OrgSettingsOut(ORMModel):
    screenshot_enabled: bool
    screenshot_interval_s: int
    screenshot_randomize: bool
    screenshot_quality: int
    screenshot_max_width: int
    screenshot_retention_days: int
    blur_screenshots: bool
    capture_all_monitors: bool
    idle_threshold_s: int
    track_urls: bool
    track_window_titles: bool
    activity_retention_days: int
    min_segment_s: int
    sync_interval_s: int
    notice_required: bool
    notice_text: str
    work_day_start: str
    work_day_end: str
    track_outside_hours: bool


class OrgSettingsUpdate(BaseModel):
    screenshot_enabled: bool | None = None
    screenshot_interval_s: int | None = Field(default=None, ge=30, le=86400)
    screenshot_randomize: bool | None = None
    screenshot_quality: int | None = Field(default=None, ge=20, le=95)
    screenshot_max_width: int | None = Field(default=None, ge=320, le=3840)
    screenshot_retention_days: int | None = Field(default=None, ge=1, le=3650)
    blur_screenshots: bool | None = None
    capture_all_monitors: bool | None = None
    idle_threshold_s: int | None = Field(default=None, ge=30, le=3600)
    track_urls: bool | None = None
    track_window_titles: bool | None = None
    activity_retention_days: int | None = Field(default=None, ge=1, le=3650)
    min_segment_s: int | None = Field(default=None, ge=1, le=120)
    sync_interval_s: int | None = Field(default=None, ge=10, le=3600)
    notice_required: bool | None = None
    notice_text: str | None = Field(default=None, max_length=4000)
    work_day_start: str | None = Field(default=None, pattern=r"^\d{2}:\d{2}$")
    work_day_end: str | None = Field(default=None, pattern=r"^\d{2}:\d{2}$")
    track_outside_hours: bool | None = None


class RuleOut(ORMModel):
    id: uuid.UUID
    match_type: str
    pattern: str
    productivity: str
    priority: int
    label: str | None = None


class RuleCreate(BaseModel):
    match_type: str = Field(pattern=r"^(app|domain|title)$")
    pattern: str = Field(min_length=1, max_length=255)
    productivity: str = Field(pattern=r"^(productive|unproductive|neutral)$")
    priority: int = Field(default=0, ge=0, le=1000)
    label: str | None = Field(default=None, max_length=120)


class DeviceOut(ORMModel):
    id: uuid.UUID
    hostname: str
    os: str
    os_version: str
    agent_version: str
    is_active: bool
    last_seen_at: datetime | None = None
    created_at: datetime
    #: Why this machine is not capturing the screen, or None when it is. A
    #: device can be online, current and enrolled and still collect no
    #: screenshots at all, and nothing else in this payload would show it.
    capture_blocked: str | None = None
