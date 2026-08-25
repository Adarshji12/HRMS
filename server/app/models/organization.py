from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDMixin

if TYPE_CHECKING:
    from app.models.user import User


class Organization(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "organizations"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    # Also the tenant subdomain: <slug>.<base_domain>.
    slug: Mapped[str] = mapped_column(String(80), unique=True, nullable=False, index=True)
    timezone: Mapped[str] = mapped_column(String(64), default="UTC", nullable=False)

    # --- company details, captured at signup ---------------------------------
    legal_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    contact_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    contact_phone: Mapped[str | None] = mapped_column(String(32), nullable=True)
    address_line1: Mapped[str | None] = mapped_column(String(255), nullable=True)
    address_line2: Mapped[str | None] = mapped_column(String(255), nullable=True)
    city: Mapped[str | None] = mapped_column(String(120), nullable=True)
    state: Mapped[str | None] = mapped_column(String(120), nullable=True)
    postal_code: Mapped[str | None] = mapped_column(String(20), nullable=True)
    country: Mapped[str] = mapped_column(String(2), default="IN", nullable=False)
    gstin: Mapped[str | None] = mapped_column(String(20), nullable=True)
    industry: Mapped[str | None] = mapped_column(String(80), nullable=True)

    # --- platform state, controlled by Super Admin ---------------------------
    # Distinct from subscription status: this is *our* switch, not the
    # customer's billing state. A paid company can be suspended for abuse; an
    # unpaid one can be left active during a grace period.
    status: Mapped[str] = mapped_column(String(24), default="pending_setup", nullable=False,
                                        index=True)
    suspended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    suspended_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Per-company module overrides, layered on top of whatever the plan allows.
    # ``{"payroll": true, "leave": false}`` — a key present forces that answer,
    # a key absent inherits the plan. Tri-state on purpose: two booleans (or a
    # pair of granted/revoked lists) make "inherit" unrepresentable, and the
    # first operator to toggle a switch on and off again would silently pin the
    # company to a value the plan no longer controls.
    #
    # This is the operator's switch, the way ``status`` above is: a customer who
    # negotiated one extra module gets it here, without inventing a bespoke plan
    # for them or editing a plan that other companies are also on.
    module_grants: Mapped[dict] = mapped_column(
        JSON, default=dict, server_default="{}", nullable=False
    )

    users: Mapped[list["User"]] = relationship(back_populates="organization")
    settings: Mapped["OrgSettings"] = relationship(
        back_populates="organization", uselist=False, cascade="all, delete-orphan"
    )


class OrgSettings(TimestampMixin, Base):
    """Per-tenant tracking policy. The agent pulls this on every heartbeat, so a
    change in the dashboard takes effect on the next poll without a redeploy."""

    __tablename__ = "org_settings"

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), primary_key=True
    )

    # --- screenshots ---------------------------------------------------------
    screenshot_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    # Base cadence in seconds. 60 / 300 / 600 / 900 map to the dashboard presets;
    # any other value is a custom interval.
    screenshot_interval_s: Mapped[int] = mapped_column(Integer, default=600, nullable=False)
    # When true the capture fires at a random offset inside each interval window
    # rather than on the boundary, so it cannot be predicted and dodged.
    screenshot_randomize: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    screenshot_quality: Mapped[int] = mapped_column(Integer, default=60, nullable=False)
    screenshot_max_width: Mapped[int] = mapped_column(Integer, default=1600, nullable=False)
    screenshot_retention_days: Mapped[int] = mapped_column(Integer, default=30, nullable=False)
    blur_screenshots: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    capture_all_monitors: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    # --- activity ------------------------------------------------------------
    idle_threshold_s: Mapped[int] = mapped_column(Integer, default=180, nullable=False)
    track_urls: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    track_window_titles: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    activity_retention_days: Mapped[int] = mapped_column(Integer, default=365, nullable=False)
    # Seconds; segments shorter than this are dropped by the agent to avoid
    # flooding the DB with alt-tab noise.
    min_segment_s: Mapped[int] = mapped_column(Integer, default=3, nullable=False)
    sync_interval_s: Mapped[int] = mapped_column(Integer, default=60, nullable=False)

    # --- compliance ----------------------------------------------------------
    notice_required: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    notice_text: Mapped[str] = mapped_column(
        Text,
        default=(
            "This device is monitored by your employer during working hours. "
            "Application usage, visited websites, active/idle time and periodic "
            "screenshots are recorded. Keystroke content is never captured. "
            "Contact your administrator for the full monitoring policy."
        ),
        nullable=False,
    )
    work_day_start: Mapped[str] = mapped_column(String(5), default="09:00", nullable=False)
    work_day_end: Mapped[str] = mapped_column(String(5), default="18:00", nullable=False)
    # Outside working hours the agent idles: no samples, no screenshots.
    track_outside_hours: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    organization: Mapped["Organization"] = relationship(back_populates="settings")
