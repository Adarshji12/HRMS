"""HR settings: company-wide HR defaults that are not any one module's policy.

One row per organisation, created on first read. Attendance, leave, payroll
and expenses keep their own settings tables; this holds what belongs to HR as
a whole — how employee IDs are numbered, and the defaults and warning windows
the hire form and the HR dashboard read.
"""

from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, Integer, String, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDMixin


class HrSettings(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "hr_settings"
    __table_args__ = (UniqueConstraint("org_id", name="uq_hr_settings_org"),)

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )

    # --- employee ID format --------------------------------------------------
    #: ``EMP`` + ``-`` + ``0007``. A blank prefix gives plain numbers.
    emp_code_prefix: Mapped[str] = mapped_column(String(12), default="EMP", nullable=False)
    emp_code_separator: Mapped[str] = mapped_column(String(3), default="-", nullable=False)
    #: Zero padding. 0 turns padding off.
    emp_code_digits: Mapped[int] = mapped_column(Integer, default=4, nullable=False)
    #: The number the next minted code will carry. Bumped every time a code
    #: is minted; settable so a company migrating in can continue its series.
    emp_code_next: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    # --- defaults and reminders ----------------------------------------------
    default_probation_months: Mapped[int] = mapped_column(Integer, default=6, nullable=False)
    default_notice_days: Mapped[int] = mapped_column(Integer, default=30, nullable=False)
    #: How far ahead "probation ending" is flagged on the HR dashboard.
    probation_warn_days: Mapped[int] = mapped_column(Integer, default=30, nullable=False)
    #: How far ahead "document expiring" is flagged on the HR dashboard.
    document_warn_days: Mapped[int] = mapped_column(Integer, default=60, nullable=False)
