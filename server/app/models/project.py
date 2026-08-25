"""Projects, tasks and how tracked time gets attributed to them.

Attribution has three sources, in priority order:

1. **Manual** — someone assigned the time explicitly. Never overwritten.
2. **Active selection** — the employee picked a project in the agent tray, so
   everything captured while it was active belongs to that project.
3. **Rules** — an app, domain or window-title pattern maps to a project (a git
   repository name, a Jira project key, a client's web app).

Rules are last because they guess. A guess must never silently replace a human's
answer, so ``ActivitySegment.project_source`` records which of the three set the
value and the reconciliation job only ever upgrades toward manual.
"""

from __future__ import annotations

import enum
import uuid
from datetime import date
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    Date,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    Uuid,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDMixin

if TYPE_CHECKING:
    from app.models.user import User


class ProjectStatus(str, enum.Enum):
    ACTIVE = "active"
    ON_HOLD = "on_hold"
    COMPLETED = "completed"
    ARCHIVED = "archived"

    @property
    def accepts_time(self) -> bool:
        return self in (ProjectStatus.ACTIVE, ProjectStatus.ON_HOLD)


class TaskStatus(str, enum.Enum):
    TODO = "todo"
    IN_PROGRESS = "in_progress"
    BLOCKED = "blocked"
    DONE = "done"


class ProjectSource(str, enum.Enum):
    MANUAL = "manual"
    SELECTION = "selection"
    RULE = "rule"

    @property
    def rank(self) -> int:
        """Higher wins. Used to stop a rule overwriting a human's answer."""
        return {"rule": 1, "selection": 2, "manual": 3}[self.value]


class Project(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "projects"
    __table_args__ = (
        UniqueConstraint("org_id", "code", name="uq_project_org_code"),
        Index("ix_projects_org_status", "org_id", "status"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    # Short handle used in reports and rule matching, e.g. "ACME-WEB".
    code: Mapped[str | None] = mapped_column(String(40), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    client_name: Mapped[str | None] = mapped_column(String(200), nullable=True)

    status: Mapped[str] = mapped_column(
        String(20), default=ProjectStatus.ACTIVE.value, nullable=False
    )
    is_billable: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    # Paise per hour. Integer money — see app.core.plans for why.
    hourly_rate: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    budget_minutes: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    start_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    end_on: Mapped[date | None] = mapped_column(Date, nullable=True)

    manager_user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    department_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("departments.id", ondelete="SET NULL"), nullable=True
    )
    color: Mapped[str | None] = mapped_column(String(16), nullable=True)

    members: Mapped[list["ProjectMember"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    tasks: Mapped[list["Task"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    rules: Mapped[list["ProjectRule"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )

    @property
    def status_enum(self) -> ProjectStatus:
        try:
            return ProjectStatus(self.status)
        except ValueError:
            return ProjectStatus.ARCHIVED


class ProjectMember(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "project_members"
    __table_args__ = (UniqueConstraint("project_id", "user_id", name="uq_member_project_user"),)

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # "member" | "lead". Not the org role — a junior can lead one project.
    role: Mapped[str] = mapped_column(String(20), default="member", nullable=False)
    # Overrides the project rate for this person. 0 means "use the project's".
    hourly_rate: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    project: Mapped["Project"] = relationship(back_populates="members")
    user: Mapped["User"] = relationship()


class Task(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "tasks"
    __table_args__ = (Index("ix_tasks_project_status", "project_id", "status"),)

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default=TaskStatus.TODO.value, nullable=False)
    assignee_user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    estimate_minutes: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    due_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    # Falls back to the project's flag when null, so a task only overrides
    # billability when someone deliberately says so.
    is_billable: Mapped[bool | None] = mapped_column(Boolean, nullable=True)

    project: Mapped["Project"] = relationship(back_populates="tasks")


class ProjectRule(UUIDMixin, TimestampMixin, Base):
    """Auto-attribution pattern: app, domain, window title or git repository."""

    __tablename__ = "project_rules"
    __table_args__ = (
        UniqueConstraint("org_id", "match_type", "pattern", name="uq_projrule_org_type_pattern"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    task_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True
    )
    # app | domain | title | repo
    match_type: Mapped[str] = mapped_column(String(16), nullable=False)
    pattern: Mapped[str] = mapped_column(String(255), nullable=False)
    priority: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    project: Mapped["Project"] = relationship(back_populates="rules")
