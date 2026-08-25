from __future__ import annotations

import re

from pydantic import BaseModel, EmailStr, Field, field_validator

SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$")


class QuoteRequest(BaseModel):
    plan_id: str = Field(default="standard", pattern=r"^(trial|standard|enterprise)$")
    employees: int = Field(default=1, ge=1, le=100_000)
    billing_cycle: str = Field(default="annual", pattern=r"^(monthly|annual)$")


class CompanyDetails(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    slug: str = Field(min_length=3, max_length=40)
    legal_name: str | None = Field(default=None, max_length=255)
    contact_email: EmailStr
    contact_phone: str | None = Field(default=None, max_length=32)
    address_line1: str | None = Field(default=None, max_length=255)
    city: str | None = Field(default=None, max_length=120)
    state: str | None = Field(default=None, max_length=120)
    postal_code: str | None = Field(default=None, max_length=20)
    country: str = Field(default="IN", min_length=2, max_length=2)
    gstin: str | None = Field(default=None, max_length=20)
    industry: str | None = Field(default=None, max_length=80)
    timezone: str = Field(default="Asia/Kolkata", max_length=64)

    @field_validator("slug")
    @classmethod
    def _check_slug(cls, value: str) -> str:
        slug = value.strip().lower()
        if not SLUG_RE.match(slug):
            raise ValueError(
                "Use 3-40 characters: lowercase letters, numbers and hyphens, "
                "not starting or ending with a hyphen."
            )
        return slug


class AdminDetails(BaseModel):
    full_name: str = Field(min_length=2, max_length=200)
    email: EmailStr
    password: str = Field(min_length=10, max_length=200)
    phone: str | None = Field(default=None, max_length=32)


class SignupRequest(BaseModel):
    company: CompanyDetails
    admin: AdminDetails
    plan_id: str = Field(default="standard", pattern=r"^(standard|enterprise)$")
    employees: int = Field(ge=1, le=100_000)
    billing_cycle: str = Field(default="annual", pattern=r"^(monthly|annual)$")
    accept_terms: bool = False


class TrialSignupRequest(BaseModel):
    company: CompanyDetails
    admin: AdminDetails
    accept_terms: bool = False


class SignupOrderResponse(BaseModel):
    organization_id: str
    slug: str
    subscription_id: str
    order_id: str
    amount: int
    currency: str
    razorpay_key_id: str
    # True when no gateway credentials are configured and the order is local.
    simulated: bool
    quote: dict
    prefill: dict


class ConfirmPaymentRequest(BaseModel):
    razorpay_order_id: str = Field(min_length=8, max_length=64)
    razorpay_payment_id: str = Field(min_length=8, max_length=64)
    razorpay_signature: str = Field(min_length=16, max_length=255)


class SignupCompleteResponse(BaseModel):
    organization_id: str
    slug: str
    login_url: str
    admin_email: str
    plan_name: str
    seats: int
    period_end: str | None = None
    status: str


class SlugCheck(BaseModel):
    slug: str
    available: bool
    reason: str | None = None
    suggestion: str | None = None
