"""Timesheets: manual time entries and period approval.

A timesheet is **not** a stored copy of hours. Worked time is derived from
``ActivitySegment`` (what the agent captured) plus ``TimeEntry`` (what a person
typed in for work the agent could not see — a client meeting, a phone call, a
day on site). Storing a third, summed copy would drift the moment either source
changed, and reconciling it afterwards is guesswork.

What *is* stored is the **approval**: a manager's sign-off on a period, with the
totals frozen at the moment they approved. That snapshot exists precisely
because it must not move when the underlying data is later corrected — payroll
was run against the number that was on screen.
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
    Integer,
    String,
    Text,
    Uuid,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDMixin


class EntrySource(str, enum.Enum):
    MANUAL = "manual"   # typed in after the fact
    TIMER = "timer"     # started and stopped in the app


class ApprovalStatus(str, enum.Enum):
    DRAFT = "draft"
    SUBMITTED = "submitted"
    APPROVED = "approved"
    REJECTED = "rejected"

    @property
    def is_locked(self) -> bool:
        """Whether the employee may still change entries in the period."""
        return self in (ApprovalStatus.SUBMITTED, ApprovalStatus.APPROVED)


class TimeEntry(UUIDMixin, TimestampMixin, Base):
    """Time a person recorded by hand, for work the agent never saw."""

    __tablename__ = "time_entries"
    __table_args__ = (
        Index("ix_time_entries_user_day", "user_id", "entry_date"),
        Index("ix_time_entries_org_day", "org_id", "entry_date"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="SET NULL"), nullable=True, index=True
    )
    task_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True
    )

    # The calendar day this belongs to, in the employee's timezone. Stored
    # separately from the timestamps so a day's total is a simple equality
    # filter rather than a timezone-shifted range on every query.
    entry_date: Mapped[date] = mapped_column(Date, nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    minutes: Mapped[int] = mapped_column(Integer, nullable=False)

    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_billable: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    source: Mapped[str] = mapped_column(String(16), default=EntrySource.MANUAL.value, nullable=False)

    # Who typed it. A manager filling in for someone is legitimate and must be
    # visible, so this is not assumed to equal user_id.
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )


class TimesheetApproval(UUIDMixin, TimestampMixin, Base):
    """One employee's sign-off state for one period."""

    __tablename__ = "timesheet_approvals"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "period_start", "period_type", name="uq_approval_user_period"
        ),
        Index("ix_approvals_org_period", "org_id", "period_start"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )

    period_type: Mapped[str] = mapped_column(String(10), default="weekly", nullable=False)
    period_start: Mapped[date] = mapped_column(Date, nullable=False)
    period_end: Mapped[date] = mapped_column(Date, nullable=False)

    status: Mapped[str] = mapped_column(
        String(16), default=ApprovalStatus.DRAFT.value, nullable=False, index=True
    )
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reviewed_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Frozen at approval. Deliberately duplicated from the derived totals: this
    # is the number payroll was run against, and it must not move when a
    # segment is later corrected or a retention job deletes old activity.
    approved_worked_minutes: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    approved_billable_minutes: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    approved_overtime_minutes: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    @property
    def status_enum(self) -> ApprovalStatus:
        try:
            return ApprovalStatus(self.status)
        except ValueError:
            return ApprovalStatus.DRAFT
