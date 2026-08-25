from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    Uuid,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDMixin


class Productivity(str, enum.Enum):
    PRODUCTIVE = "productive"
    UNPRODUCTIVE = "unproductive"
    NEUTRAL = "neutral"


class MatchType(str, enum.Enum):
    APP = "app"          # matches the executable name, e.g. "code.exe"
    DOMAIN = "domain"    # matches the URL host, e.g. "youtube.com"
    TITLE = "title"      # substring of the window title


class ActivitySegment(UUIDMixin, Base):
    """A contiguous run of focus on one (app, title, url) triple.

    The agent collapses per-second samples into segments before upload, so one
    row is typically seconds-to-minutes of usage rather than one row per sample.
    """

    __tablename__ = "activity_segments"
    __table_args__ = (
        # Ingest is idempotent: a retried batch after a half-failed upload
        # collides here instead of double-counting time.
        UniqueConstraint("device_id", "client_uid", name="uq_segment_device_client_uid"),
        Index("ix_segments_user_started", "user_id", "started_at"),
        Index("ix_segments_org_started", "org_id", "started_at"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    device_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("devices.id", ondelete="CASCADE"), nullable=False
    )

    client_uid: Mapped[str] = mapped_column(String(64), nullable=False)

    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ended_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    duration_s: Mapped[int] = mapped_column(Integer, nullable=False)
    active_s: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    idle_s: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    app_name: Mapped[str] = mapped_column(String(200), default="", nullable=False, index=True)
    app_exec: Mapped[str] = mapped_column(String(200), default="", nullable=False)
    window_title: Mapped[str] = mapped_column(Text, default="", nullable=False)

    is_browser: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    browser: Mapped[str | None] = mapped_column(String(40), nullable=True)
    url_domain: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    url_full: Mapped[str | None] = mapped_column(Text, nullable=True)

    productivity: Mapped[str] = mapped_column(
        String(16), default=Productivity.NEUTRAL.value, nullable=False, index=True
    )
    # True when the whole segment was idle time (screensaver, away from desk).
    is_idle: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # --- project attribution -------------------------------------------------
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="SET NULL"), nullable=True, index=True
    )
    task_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True
    )
    # manual | selection | rule. Records who decided, so re-running the rule
    # engine can never overwrite a human's answer. See models/project.py.
    project_source: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # Resolved at attribution time from the project/task billable flags, then
    # frozen: changing a project to non-billable must not silently rewrite
    # invoices that were already raised from last month's numbers.
    is_billable: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # Percentage of sampled seconds with keyboard or mouse input. Distinct from
    # active_s, which only asks whether the idle threshold was crossed: a
    # segment can be 100% "active" while barely touched (reading a document).
    # server_default, not just default: `default=` is applied by Python on
    # insert, so ALTER TABLE ADD COLUMN ... NOT NULL has nothing to backfill
    # existing rows with and the migration fails on any non-empty table.
    input_activity_pct: Mapped[int] = mapped_column(
        Integer, default=0, server_default=text("0"), nullable=False
    )

    # --- developer context ---------------------------------------------------
    # Populated by the agent from the editor's window title and the working
    # directory's git metadata; both are nullable because neither is reliably
    # available outside an IDE.
    repo_name: Mapped[str | None] = mapped_column(String(200), nullable=True, index=True)
    branch_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    file_path: Mapped[str | None] = mapped_column(Text, nullable=True)


class ProductivityRule(UUIDMixin, TimestampMixin, Base):
    """Classification rule. Highest ``priority`` wins; ties break on specificity
    (longer pattern first), so "mail.google.com" beats "google.com"."""

    __tablename__ = "productivity_rules"
    __table_args__ = (
        UniqueConstraint("org_id", "match_type", "pattern", name="uq_rule_org_type_pattern"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    match_type: Mapped[str] = mapped_column(String(16), nullable=False)
    pattern: Mapped[str] = mapped_column(String(255), nullable=False)
    productivity: Mapped[str] = mapped_column(String(16), nullable=False)
    priority: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    label: Mapped[str | None] = mapped_column(String(120), nullable=True)
