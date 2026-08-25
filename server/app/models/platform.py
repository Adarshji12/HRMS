"""Platform-level (Super Admin) accounts.

Deliberately a separate table from ``users`` rather than a role on it. A
platform operator has no ``org_id``, and every tenant query in this application
filters on one — putting operators in the same table would mean every one of
those filters needed an exception, and an exception in a tenant filter is
exactly how cross-tenant leaks happen.

The separation also means a compromised company admin cannot escalate to
platform access by editing a role column.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDMixin


class PlatformAdmin(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "platform_admins"

    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    full_name: Mapped[str] = mapped_column(String(200), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # True while the account still holds its bootstrap password. Every write
    # endpoint refuses until it is changed, so a deployment cannot be left
    # running on the credentials printed in the setup docs.
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
