"""Wire format between the desktop agent and the server."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from app.schemas.common import OrgSettingsOut


class DeviceInfo(BaseModel):
    machine_id: str = Field(min_length=4, max_length=128)
    hostname: str = Field(min_length=1, max_length=200)
    os: str = Field(pattern=r"^(windows|darwin|linux)$")
    os_version: str = Field(default="", max_length=120)
    agent_version: str = Field(default="", max_length=32)
    accept_notice: bool = False


class EnrollRequest(DeviceInfo):
    enrollment_key: str = Field(min_length=4, max_length=32)


class AgentLoginRequest(DeviceInfo):
    """Employee signs in once; the agent keeps only the device token.

    The password is never stored by the agent and never leaves this request —
    an agent that held reusable credentials would turn one stolen laptop into
    access to the whole dashboard.
    """

    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=1, max_length=200)


class EnrollResponse(BaseModel):
    device_id: uuid.UUID
    device_token: str
    user_id: uuid.UUID
    user_name: str
    user_email: str = ""
    org_name: str
    org_slug: str = ""
    config: OrgSettingsOut


class SegmentIn(BaseModel):
    """One contiguous run of focus, already collapsed by the agent."""

    client_uid: str = Field(min_length=8, max_length=64)
    started_at: datetime
    ended_at: datetime
    active_s: int = Field(ge=0, le=86400)
    idle_s: int = Field(ge=0, le=86400)
    app_name: str = Field(default="", max_length=200)
    app_exec: str = Field(default="", max_length=200)
    window_title: str = Field(default="", max_length=2000)
    is_browser: bool = False
    browser: str | None = Field(default=None, max_length=40)
    url_domain: str | None = Field(default=None, max_length=255)
    url_full: str | None = Field(default=None, max_length=2000)
    is_idle: bool = False

    # Set when the employee picked a project in the agent tray. Beats any
    # server-side pattern rule — see services/attribution.py.
    project_id: uuid.UUID | None = None
    task_id: uuid.UUID | None = None

    # Share of sampled seconds with keyboard or mouse input. Derived from
    # last-input timestamps, not a keyboard hook — no keystroke content exists
    # anywhere in this system.
    input_activity_pct: int = Field(default=0, ge=0, le=100)

    # Developer context, where the platform can supply it.
    repo_name: str | None = Field(default=None, max_length=200)
    branch_name: str | None = Field(default=None, max_length=200)
    file_path: str | None = Field(default=None, max_length=2000)

    @field_validator("started_at", "ended_at")
    @classmethod
    def _require_tz(cls, v: datetime) -> datetime:
        if v.tzinfo is None:
            raise ValueError("timestamps must carry a UTC offset")
        return v


class ActivityBatch(BaseModel):
    segments: list[SegmentIn] = Field(default_factory=list, max_length=500)


class IngestAck(BaseModel):
    accepted: list[str]
    rejected: dict[str, str] = Field(default_factory=dict)


class HeartbeatRequest(BaseModel):
    agent_version: str = Field(default="", max_length=32)
    queued_items: int = 0
    #: Why this machine cannot capture the screen, in the agent's words, or
    #: None when it can. Sent on every heartbeat so the dashboard reflects the
    #: machine's state now rather than whatever it reported at startup.
    capture_blocked: str | None = Field(default=None, max_length=300)


class HeartbeatResponse(BaseModel):
    server_time: datetime
    config: OrgSettingsOut
    # Set when the admin deactivates the device; the agent stops and wipes its
    # local spool rather than continuing to collect.
    revoked: bool = False


class SessionStartRequest(BaseModel):
    started_at: datetime


class SessionEndRequest(BaseModel):
    ended_at: datetime


class ScreenshotMeta(BaseModel):
    client_uid: str = Field(min_length=8, max_length=64)
    captured_at: datetime
    app_name: str = Field(default="", max_length=200)
    # The executable name is what app rules match on ("code.exe" -> productive).
    # Without it a screenshot can only be classified by URL/title, so every
    # capture in a non-browser app fell through to neutral — out of step with
    # the activity segment for the very same moment, which does get app_exec.
    app_exec: str = Field(default="", max_length=200)
    window_title: str = Field(default="", max_length=2000)
    url_domain: str | None = Field(default=None, max_length=255)
    monitor_count: int = Field(default=1, ge=1, le=8)
    activity_pct: int = Field(default=0, ge=0, le=100)
