from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Uuid, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDMixin

if TYPE_CHECKING:
    from app.models.user import User


class Device(UUIDMixin, TimestampMixin, Base):
    """One enrolled machine. A user may have several (desktop + laptop)."""

    __tablename__ = "devices"
    __table_args__ = (
        UniqueConstraint("org_id", "machine_id", name="uq_devices_org_machine"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )

    # Stable hardware/install identifier produced by the agent.
    machine_id: Mapped[str] = mapped_column(String(128), nullable=False)
    hostname: Mapped[str] = mapped_column(String(200), nullable=False)
    os: Mapped[str] = mapped_column(String(32), nullable=False)  # windows | darwin | linux
    os_version: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    agent_version: Mapped[str] = mapped_column(String(32), default="", nullable=False)

    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    #: Why screen capture is not working on this machine, or NULL when it is.
    #: Stored as the agent's own sentence rather than a code: the two causes —
    #: a Wayland session and an ungranted macOS permission — have different
    #: fixes, and an admin reading the device list needs the fix, not a flag.
    capture_blocked: Mapped[str | None] = mapped_column(String(300), nullable=True)

    user: Mapped["User"] = relationship(back_populates="devices")


class WorkSession(UUIDMixin, Base):
    """Agent start/stop, used for attendance and login/logout reporting."""

    __tablename__ = "work_sessions"

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    device_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("devices.id", ondelete="CASCADE"), nullable=False, index=True
    )

    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # "clean" when the agent shut down gracefully, "timeout" when the server
    # closed it after the heartbeat stopped.
    end_reason: Mapped[str | None] = mapped_column(String(20), nullable=True)
    duration_s: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
