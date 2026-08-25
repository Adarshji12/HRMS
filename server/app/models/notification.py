from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDMixin


class NotificationLog(UUIDMixin, TimestampMixin, Base):
    """Every message this system has decided to send, and whether it left.

    The unique constraint IS the de-duplication. Most alerts here are derived
    from a *condition* that stays true — a timesheet is pending until someone
    approves it, a trial is ending for fourteen days — so a runner that fires
    every fifteen minutes would re-send the same mail ninety-six times a day
    without it. Pushing that into the database rather than application logic
    means two runners racing cannot both win.

    ``dedupe_key`` carries the value, not just the subject: "trial:2" is a
    different key from "trial:3", so the reminder legitimately fires again when
    the number changes, and never otherwise.
    """

    __tablename__ = "notification_log"
    __table_args__ = (
        UniqueConstraint(
            "org_id", "user_id", "kind", "dedupe_key", name="uq_notification_log_dedupe"
        ),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    dedupe_key: Mapped[str] = mapped_column(String(120), nullable=False)
    channel: Mapped[str] = mapped_column(String(16), nullable=False, default="email")
    subject: Mapped[str] = mapped_column(String(300), nullable=False, default="")

    # "sent" once SMTP accepted it, "logged" when SMTP is unconfigured and the
    # body went to the log instead, "failed" when the handshake broke. Recorded
    # rather than discarded so "did the alert go out?" is answerable months
    # later, which is the first question asked after an incident like an agent
    # that stopped reporting.
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="sent")
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class NotificationPreference(UUIDMixin, TimestampMixin, Base):
    """A person's opt-out for one alert kind.

    Absence means "use the kind's default", so a new alert type does not need a
    backfill row per user, and a user who has never touched their preferences
    still gets what the product considers essential.

    Not every kind is opt-outable. Security and compliance messages — a device
    enrolled against your name, the monitoring notice you have not accepted —
    stay on regardless; see ``Kind.optional`` in app.services.notifications.
    """

    __tablename__ = "notification_prefs"
    __table_args__ = (
        UniqueConstraint("user_id", "kind", name="uq_notification_prefs_user_kind"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(String(40), nullable=False)
    email_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
