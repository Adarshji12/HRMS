from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, Field

from app.schemas.common import ORMModel


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    code: str | None = Field(default=None, max_length=40)
    description: str | None = Field(default=None, max_length=4000)
    client_name: str | None = Field(default=None, max_length=200)
    status: str = Field(default="active", pattern=r"^(active|on_hold|completed|archived)$")
    is_billable: bool = True
    # Rupees on the wire, paise in the database. The UI should never have to
    # know about minor units, and the server should never store floats.
    hourly_rate_rupees: float = Field(default=0, ge=0, le=1_000_000)
    budget_hours: float = Field(default=0, ge=0, le=1_000_000)
    start_on: date | None = None
    end_on: date | None = None
    manager_user_id: uuid.UUID | None = None
    department_id: uuid.UUID | None = None
    color: str | None = Field(default=None, max_length=16)


class ProjectOut(ORMModel):
    id: uuid.UUID
    name: str
    code: str | None = None
    description: str | None = None
    client_name: str | None = None
    status: str
    is_billable: bool
    hourly_rate: int
    budget_minutes: int
    start_on: date | None = None
    end_on: date | None = None
    manager_user_id: uuid.UUID | None = None
    department_id: uuid.UUID | None = None
    color: str | None = None
    created_at: datetime

    manager_name: str | None = None
    member_count: int = 0
    task_count: int = 0
    open_task_count: int = 0
    tracked_seconds: int = 0
    billable_seconds: int = 0

    @property
    def budget_hours(self) -> float:
        return round(self.budget_minutes / 60, 2)


class MemberIn(BaseModel):
    user_id: uuid.UUID
    role: str = Field(default="member", pattern=r"^(member|lead)$")
    hourly_rate_rupees: float = Field(default=0, ge=0, le=1_000_000)


class MemberOut(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    full_name: str
    email: str
    role: str
    hourly_rate: int
    tracked_seconds: int = 0


class TaskIn(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    description: str | None = Field(default=None, max_length=4000)
    status: str = Field(default="todo", pattern=r"^(todo|in_progress|blocked|done)$")
    assignee_user_id: uuid.UUID | None = None
    estimate_hours: float = Field(default=0, ge=0, le=100_000)
    due_on: date | None = None
    is_billable: bool | None = None


class TaskOut(ORMModel):
    id: uuid.UUID
    project_id: uuid.UUID
    title: str
    description: str | None = None
    status: str
    assignee_user_id: uuid.UUID | None = None
    estimate_minutes: int
    due_on: date | None = None
    is_billable: bool | None = None
    created_at: datetime

    assignee_name: str | None = None
    tracked_seconds: int = 0


class ProjectRuleIn(BaseModel):
    project_id: uuid.UUID
    task_id: uuid.UUID | None = None
    match_type: str = Field(pattern=r"^(app|domain|title|repo)$")
    pattern: str = Field(min_length=1, max_length=255)
    priority: int = Field(default=0, ge=0, le=1000)


class ProjectRuleOut(ORMModel):
    id: uuid.UUID
    project_id: uuid.UUID
    task_id: uuid.UUID | None = None
    match_type: str
    pattern: str
    priority: int
    project_name: str | None = None


class AttributeRequest(BaseModel):
    """Manual assignment of already-recorded time."""

    segment_ids: list[uuid.UUID] = Field(min_length=1, max_length=1000)
    project_id: uuid.UUID | None = None
    task_id: uuid.UUID | None = None
