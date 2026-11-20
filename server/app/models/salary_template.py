"""A reusable salary template: which pay components a grade is paid on.

Amounts still come from the components' own rules and the CTC typed per person; the template only
chooses the set of earnings, so two grades can differ in shape without duplicating components.
"""

from __future__ import annotations

import uuid

from sqlalchemy import JSON, Boolean, ForeignKey, String, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDMixin


class SalaryTemplate(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "salary_templates"
    __table_args__ = (UniqueConstraint("org_id", "name", name="uq_salary_templates_name"),)

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    component_ids: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    #: component id -> {"calculation": ..., "rate_bps": ...}: the template's own rule for it.
    rules: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
