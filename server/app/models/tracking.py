"""Employee location pings: where a person was, as they chose to share it.

A ping is posted by the person's own browser or phone while they have sharing switched on. The
live map reads the latest one; the route view reads a day's worth in order.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Index, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDMixin


class LocationPing(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "location_pings"
    __table_args__ = (Index("ix_location_pings_user_time", "org_id", "user_id", "recorded_at"),)

    org_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    lat: Mapped[float] = mapped_column(Float, nullable=False)
    lng: Mapped[float] = mapped_column(Float, nullable=False)
    #: Metres, as the device reports it.
    accuracy_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    #: Metres per second, when the device knows it.
    speed_mps: Mapped[float | None] = mapped_column(Float, nullable=True)
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
