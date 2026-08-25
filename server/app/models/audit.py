from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, JSON, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDMixin


class AuditLog(UUIDMixin, TimestampMixin, Base):
    """Who changed policy and who looked at whose screenshots.

    Required by most works-council / GDPR reviews: the monitoring system must
    itself be auditable.
    """

    __tablename__ = "audit_logs"

    # Nullable for platform-scope actions. Every tenant action still carries its
    # org and every tenant-facing query filters on one, so a NULL here cannot
    # widen anyone's view — it is the only way an operator changing something
    # global, like where all outbound mail goes, is auditable at all rather than
    # simply unrecorded.
    org_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=True, index=True
    )
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    action: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    target_type: Mapped[str | None] = mapped_column(String(40), nullable=True)
    target_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    detail: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
