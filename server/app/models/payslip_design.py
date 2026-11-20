"""The company's payslip design: chosen layout, company block, identifiers, images, what prints."""

from __future__ import annotations

import uuid

from sqlalchemy import JSON, ForeignKey, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDMixin


class PayslipDesign(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "payslip_designs"

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, unique=True, index=True
    )
    #: Everything in ``services.payslip_render.DEFAULTS``; images are small re-encoded PNG data URIs.
    data: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
