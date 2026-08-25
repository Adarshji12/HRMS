from __future__ import annotations

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
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, UUIDMixin


class Screenshot(UUIDMixin, Base):
    __tablename__ = "screenshots"
    __table_args__ = (
        UniqueConstraint("device_id", "client_uid", name="uq_shot_device_client_uid"),
        Index("ix_shots_user_captured", "user_id", "captured_at"),
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

    # Capture time as reported by the agent — this is what the dashboard shows,
    # not the upload time, which can be hours later after an offline stretch.
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    storage_key: Mapped[str] = mapped_column(String(255), nullable=False)
    thumb_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    width: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    height: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    file_size: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    monitor_count: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    blurred: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # Context at the moment of capture, denormalised so the gallery needs no join.
    app_name: Mapped[str] = mapped_column(String(200), default="", nullable=False)
    window_title: Mapped[str] = mapped_column(Text, default="", nullable=False)
    url_domain: Mapped[str | None] = mapped_column(String(255), nullable=True)
    productivity: Mapped[str] = mapped_column(String(16), default="neutral", nullable=False)
    # Activity percentage over the interval preceding the capture.
    activity_pct: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
