from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDMixin


class MailSettings(UUIDMixin, TimestampMixin, Base):
    """An outbound mail connector — one per workspace, plus one platform default.

    ``org_id`` NULL is the platform default. It is not decoration: signup and
    password-reset mail has to go out before the organisation it concerns
    exists, or while its owner has not configured anything, and there has to be
    something to send it with.

    Resolution is workspace first, platform second. A company that sets its own
    SMTP gets mail from its own domain — which is the point, since the people
    receiving it are its own staff and mail from a stranger's domain is what
    spam filters and employees both distrust.

    The password is Fernet ciphertext, never plaintext. A third-party credential
    sitting readable in a table that gets dumped to staging, backed up to object
    storage and read by anyone with database access is how one breach becomes
    two.
    """

    __tablename__ = "mail_settings"
    __table_args__ = (
        # One connector per workspace. SQLite and Postgres both treat NULLs as
        # distinct in a UNIQUE index, so this does not constrain the platform
        # row; that one is kept single by get_or_create looking for org_id IS NULL.
        UniqueConstraint("org_id", name="uq_mail_settings_org"),
    )

    #: NULL = the platform default, used when a workspace has not set its own.
    org_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=True, index=True
    )

    smtp_host: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    smtp_port: Mapped[int] = mapped_column(Integer, nullable=False, default=587)
    smtp_user: Mapped[str] = mapped_column(String(255), nullable=False, default="")

    # Fernet ciphertext, never the password. A plaintext third-party credential
    # in a table that gets dumped into staging, backed up to object storage and
    # read by anyone with database access is the kind of thing that turns one
    # breach into two.
    smtp_password_enc: Mapped[str | None] = mapped_column(Text, nullable=True)

    smtp_use_tls: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    email_from: Mapped[str] = mapped_column(String(255), nullable=False, default="")

    #: Set by the "send test" button, so the screen can show whether the saved
    #: settings have ever actually delivered anything rather than only that they
    #: were syntactically accepted.
    last_test_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_test_to: Mapped[str | None] = mapped_column(String(255), nullable=True)
    last_test_ok: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    last_test_error: Mapped[str | None] = mapped_column(Text, nullable=True)
