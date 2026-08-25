from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from app.schemas.common import ORMModel


class PlatformLoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=1, max_length=200)


class PlatformAdminOut(ORMModel):
    id: uuid.UUID
    email: str
    full_name: str
    is_active: bool
    last_login_at: datetime | None = None
    must_change_password: bool


class PlatformTokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    admin: PlatformAdminOut


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=12, max_length=200)


class SubscriptionOut(ORMModel):
    id: uuid.UUID
    plan_id: str
    billing_cycle: str
    seats: int
    status: str
    base_amount: int
    seat_amount: int
    tax_amount: int
    total_amount: int
    currency: str
    period_start: datetime | None = None
    period_end: datetime | None = None
    activated_at: datetime | None = None
    canceled_at: datetime | None = None
    notes: str | None = None
    created_at: datetime


class PaymentOut(ORMModel):
    id: uuid.UUID
    provider: str
    order_id: str
    payment_id: str | None = None
    amount: int
    currency: str
    status: str
    method: str | None = None
    error_description: str | None = None
    paid_at: datetime | None = None
    created_at: datetime


class CompanyRow(BaseModel):
    id: uuid.UUID
    name: str
    slug: str
    status: str
    timezone: str
    contact_email: str | None = None
    contact_phone: str | None = None
    created_at: datetime

    admin_name: str | None = None
    admin_email: str | None = None

    plan_id: str
    plan_name: str
    subscription_status: str
    billing_cycle: str | None = None
    period_start: datetime | None = None
    period_end: datetime | None = None
    days_remaining: int | None = None
    payment_status: str

    seat_limit: int
    seats_used: int
    employees_online: int


class CompanyDetail(CompanyRow):
    legal_name: str | None = None
    gstin: str | None = None
    city: str | None = None
    state: str | None = None
    country: str
    suspended_reason: str | None = None
    usage: dict
    subscriptions: list[SubscriptionOut]
    payments: list[PaymentOut]
    recent_activity: list[dict]


class SuspendRequest(BaseModel):
    reason: str = Field(min_length=3, max_length=500)


class SubscriptionOverride(BaseModel):
    """Super Admin adjustment. Every field optional; only what is sent changes."""

    # A slug, validated against the catalogue by the handler rather than by a
    # regex here: the three built-ins are no longer the only plans that exist,
    # and a pattern listing them would reject every plan an operator adds.
    plan_id: str | None = Field(default=None, min_length=2, max_length=32)
    seats: int | None = Field(default=None, ge=1, le=100_000)
    status: str | None = Field(
        default=None,
        pattern=r"^(trialing|pending_payment|active|past_due|expired|canceled|suspended)$",
    )
    extend_days: int | None = Field(default=None, ge=1, le=3650)
    notes: str | None = Field(default=None, max_length=2000)


class PlatformStats(BaseModel):
    companies_total: int
    companies_active: int
    companies_suspended: int
    companies_trialing: int
    employees_total: int
    employees_online: int
    revenue_active_paise: int
    subscriptions_expiring_30d: int
