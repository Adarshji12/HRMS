"""Public company signup.

    company details -> admin details -> plan -> payment -> activation -> login

Runs on the marketing host, so nothing here uses tenant resolution — the tenant
does not exist yet. Everything is public and therefore written defensively:
existence of a slug is the only thing these endpoints will confirm, and an
abandoned signup can be resumed but never hijacked.

**Rate limiting is not implemented here.** Put it in front of this router
(nginx, Cloudflare, or slowapi) before going live, or the endpoints below are a
free way to enumerate slugs and mint junk organisations.
"""

from __future__ import annotations

import logging
import re
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import func, select

from app.api.deps import DbSession, audit
from app.core import ratelimit
from app.core.config import settings
from app.core.plans import PlanId, SubscriptionStatus, plan_for, quote_for
from app.core.security import generate_enrollment_key, hash_password
from app.models import Organization, OrgSettings, Payment, Role, Subscription, User
from app.schemas.signup import (
    ConfirmPaymentRequest,
    QuoteRequest,
    SignupCompleteResponse,
    SignupOrderResponse,
    SignupRequest,
    SlugCheck,
    TrialSignupRequest,
)
from app.services import email, payments, plancatalog
from app.services import subscriptions as subs
from app.services.classifier import seed_default_rules

log = logging.getLogger(__name__)

router = APIRouter(prefix="/signup", tags=["signup"])


# --------------------------------------------------------------------------- #
# Plans, quotes, slug availability
# --------------------------------------------------------------------------- #


@router.get("/plans")
def public_plans(db: DbSession) -> list[dict]:
    """What a visitor may sign up for.

    Read from the catalogue, and filtered to the plans marked public: an
    operator-only plan (a negotiated enterprise rate) is perfectly usable on a
    subscription but has no business being advertised on the pricing page.
    """
    plancatalog.ensure_fresh(db)
    return [
        {
            "id": row.id,
            "name": row.name,
            "description": row.description,
            "base_price_annual": row.base_price_annual,
            "per_employee_month": row.per_employee_month,
            "min_employees": row.min_employees,
            "max_employees": row.max_employees,
            "storage_gb": row.storage_gb,
            "screenshot_interval_min_s": row.min_screenshot_interval_s,
            "screenshot_retention_days": row.max_screenshot_retention_days,
            "features": list(row.features or ()),
        }
        for row in plancatalog.list_plans(db, public_only=True)
    ]


@router.post("/quote")
def quote(payload: QuoteRequest, db: DbSession) -> dict:
    """Price breakdown. Computed server-side so the browser never does money maths."""
    # Re-read the catalogue first, so a price an operator changed this morning
    # is the price quoted this afternoon rather than whatever this worker
    # process happened to cache at boot.
    plancatalog.ensure_fresh(db)
    return quote_for(payload.plan_id, payload.employees, payload.billing_cycle).as_dict()


def _slug_taken(db, slug: str) -> bool:
    return db.scalar(select(Organization.id).where(Organization.slug == slug)) is not None


def _suggest_slug(db, base: str) -> str:
    for suffix in range(2, 60):
        candidate = f"{base[:36]}-{suffix}"
        if not _slug_taken(db, candidate) and candidate not in settings.reserved_slug_set:
            return candidate
    return f"{base[:30]}-{secrets.token_hex(3)}"


@router.get("/check-slug", response_model=SlugCheck)
def check_slug(slug: str, db: DbSession) -> SlugCheck:
    cleaned = re.sub(r"[^a-z0-9-]", "", slug.strip().lower())

    if len(cleaned) < 3:
        return SlugCheck(slug=cleaned, available=False, reason="Too short - use at least 3 characters.")
    if cleaned in settings.reserved_slug_set:
        return SlugCheck(
            slug=cleaned, available=False, reason="This name is reserved.",
            suggestion=_suggest_slug(db, cleaned),
        )
    if _slug_taken(db, cleaned):
        return SlugCheck(
            slug=cleaned, available=False, reason="Already taken.",
            suggestion=_suggest_slug(db, cleaned),
        )
    return SlugCheck(slug=cleaned, available=True)


# --------------------------------------------------------------------------- #
# Signup
# --------------------------------------------------------------------------- #


def _reject_reserved(slug: str) -> None:
    if slug in settings.reserved_slug_set:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"reason": "slug_reserved", "message": "That workspace name is reserved."},
        )


def _create_org(db, payload_company, admin_details, status_value: str) -> tuple[Organization, User]:
    org = Organization(
        name=payload_company.name.strip(),
        slug=payload_company.slug,
        timezone=payload_company.timezone,
        legal_name=payload_company.legal_name,
        contact_email=str(payload_company.contact_email).lower(),
        contact_phone=payload_company.contact_phone,
        address_line1=payload_company.address_line1,
        city=payload_company.city,
        state=payload_company.state,
        postal_code=payload_company.postal_code,
        country=payload_company.country.upper(),
        gstin=payload_company.gstin,
        industry=payload_company.industry,
        status=status_value,
    )
    db.add(org)
    db.flush()

    db.add(OrgSettings(org_id=org.id))
    seed_default_rules(db, org.id)

    owner = User(
        org_id=org.id,
        email=str(admin_details.email).lower(),
        full_name=admin_details.full_name.strip(),
        role=Role.OWNER.value,
        timezone=payload_company.timezone,
        password_hash=hash_password(admin_details.password),
        enrollment_key=generate_enrollment_key(),
        # Held inactive until payment lands, so an abandoned checkout cannot
        # leave a usable login behind.
        is_active=status_value == "active",
    )
    db.add(owner)
    db.flush()
    return org, owner


def _resume_or_reject(db, slug: str, admin_email: str) -> Organization | None:
    """Allow an abandoned signup to be retried, but only by the same person.

    Without this, a customer who closed the payment window is permanently locked
    out of their own workspace name. The email check is what stops it becoming a
    way to take over someone else's pending signup.
    """
    org = db.scalar(select(Organization).where(Organization.slug == slug))
    if org is None:
        return None
    if org.status != "pending_setup":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"reason": "slug_taken", "message": "That workspace name is already in use."},
        )
    owner = db.scalar(
        select(User).where(User.org_id == org.id, User.role == Role.OWNER.value)
    )
    if owner is None or owner.email != admin_email:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"reason": "slug_taken", "message": "That workspace name is already in use."},
        )
    return org


@router.post("/start", response_model=SignupOrderResponse, status_code=status.HTTP_201_CREATED)
def start_signup(payload: SignupRequest, request: Request, db: DbSession) -> SignupOrderResponse:
    # Creating organisations is expensive and irreversible enough that an
    # unthrottled endpoint is a resource-exhaustion tool as much as a signup.
    ratelimit.enforce(request, "signup", ratelimit.SIGNUP)
    if not payload.accept_terms:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"reason": "terms_not_accepted",
                    "message": "The terms of service must be accepted."},
        )

    _reject_reserved(payload.company.slug)
    admin_email = str(payload.admin.email).lower()

    plancatalog.ensure_fresh(db)
    quote = quote_for(payload.plan_id, payload.employees, payload.billing_cycle)
    if quote.employees != payload.employees:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "reason": "employees_out_of_range",
                "message": (
                    f"{quote.plan.name} supports {quote.plan.min_employees}-"
                    f"{quote.plan.max_employees} employees."
                ),
            },
        )

    org = _resume_or_reject(db, payload.company.slug, admin_email)
    if org is None:
        org, owner = _create_org(db, payload.company, payload.admin, "pending_setup")
    else:
        owner = db.scalar(select(User).where(User.org_id == org.id, User.role == Role.OWNER.value))
        # A resumed signup may have changed plan or headcount; refresh the
        # password too, since the customer just typed it again.
        owner.password_hash = hash_password(payload.admin.password)
        owner.full_name = payload.admin.full_name.strip()

    subscription = Subscription(
        org_id=org.id,
        plan_id=quote.plan.id,
        billing_cycle=quote.cycle.value,
        seats=quote.employees,
        status=SubscriptionStatus.PENDING_PAYMENT.value,
        base_amount=quote.base_amount,
        seat_amount=quote.seat_amount,
        tax_amount=quote.tax_amount,
        total_amount=quote.total,
    )
    db.add(subscription)
    db.flush()

    try:
        order = payments.create_order(
            amount=quote.total,
            receipt=f"sub_{subscription.id.hex[:24]}",
            notes={"org_slug": org.slug, "plan": quote.plan.id,
                   "seats": str(quote.employees)},
        )
    except payments.PaymentError as exc:
        db.rollback()
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    db.add(
        Payment(
            org_id=org.id,
            subscription_id=subscription.id,
            provider="razorpay",
            order_id=order.id,
            amount=order.amount,
            currency=order.currency,
            status="created",
            contact_email=admin_email,
            contact_phone=payload.admin.phone or payload.company.contact_phone,
        )
    )
    audit(db, org_id=org.id, actor=None, action="signup.order_created", request=request,
          target_type="subscription", target_id=str(subscription.id),
          detail={"order_id": order.id, "amount": order.amount, "seats": quote.employees})
    db.commit()

    return SignupOrderResponse(
        organization_id=str(org.id),
        slug=org.slug,
        subscription_id=str(subscription.id),
        order_id=order.id,
        amount=order.amount,
        currency=order.currency,
        razorpay_key_id=order.key_id,
        simulated=order.simulated,
        quote=quote.as_dict(),
        prefill={
            "name": payload.admin.full_name,
            "email": admin_email,
            "contact": payload.admin.phone or payload.company.contact_phone or "",
        },
    )


@router.post("/trial", response_model=SignupCompleteResponse, status_code=status.HTTP_201_CREATED)
def start_trial(payload: TrialSignupRequest, request: Request, db: DbSession) -> SignupCompleteResponse:
    """Free trial — no payment, immediately usable."""
    ratelimit.enforce(request, "signup", ratelimit.SIGNUP)
    if not payload.accept_terms:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"reason": "terms_not_accepted",
                    "message": "The terms of service must be accepted."},
        )
    _reject_reserved(payload.company.slug)
    admin_email = str(payload.admin.email).lower()

    if _resume_or_reject(db, payload.company.slug, admin_email) is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"reason": "signup_in_progress",
                    "message": "A signup for this workspace is already in progress."},
        )

    org, owner = _create_org(db, payload.company, payload.admin, "active")
    trial_plan = plan_for(PlanId.TRIAL.value)
    subscription = subs.start_trial(db, org, seats=trial_plan.max_employees)
    db.flush()

    audit(db, org_id=org.id, actor=owner, action="signup.trial_started", request=request,
          target_type="subscription", target_id=str(subscription.id))
    db.commit()

    login_url = settings.tenant_url(org.slug, "/login")
    email.send_welcome(
        owner.email, owner.full_name, org.name, login_url, trial_plan.name,
        org_id=org.id,
    )

    return SignupCompleteResponse(
        organization_id=str(org.id),
        slug=org.slug,
        login_url=settings.tenant_url(org.slug, "/login"),
        admin_email=owner.email,
        plan_name=trial_plan.name,
        seats=subscription.seats,
        period_end=subscription.period_end.isoformat() if subscription.period_end else None,
        status=subscription.status,
    )


# --------------------------------------------------------------------------- #
# Payment confirmation
# --------------------------------------------------------------------------- #


def _activate_from_payment(db, payment: Payment, gateway_payload: dict | None = None) -> Organization:
    """Idempotent activation. Safe to call from both the callback and the webhook."""
    subscription = db.get(Subscription, payment.subscription_id) if payment.subscription_id else None
    if subscription is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Payment is not linked to a subscription")

    org = db.get(Organization, payment.org_id)

    if payment.status != "paid":
        payment.status = "paid"
        payment.paid_at = datetime.now(timezone.utc)
        if gateway_payload:
            payment.raw = gateway_payload
            payment.method = gateway_payload.get("method")

    if subscription.status != SubscriptionStatus.ACTIVE.value:
        subs.activate(db, subscription)

    owner = db.scalar(select(User).where(User.org_id == org.id, User.role == Role.OWNER.value))
    if owner is not None:
        owner.is_active = True

    return org


@router.post("/confirm", response_model=SignupCompleteResponse)
def confirm_payment(
    payload: ConfirmPaymentRequest, request: Request, db: DbSession
) -> SignupCompleteResponse:
    """Handle the checkout callback.

    Verified, but treated as a convenience rather than the source of truth — the
    webhook is authoritative. Both paths call the same idempotent activation, so
    whichever lands first wins.
    """
    payment = db.scalar(select(Payment).where(Payment.order_id == payload.razorpay_order_id))
    if payment is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown order")

    if not payments.verify_payment_signature(
        payload.razorpay_order_id, payload.razorpay_payment_id, payload.razorpay_signature
    ):
        payment.status = "failed"
        payment.error_code = "signature_mismatch"
        payment.error_description = "The payment signature did not verify."
        audit(db, org_id=payment.org_id, actor=None, action="signup.signature_mismatch",
              request=request, target_type="payment", target_id=str(payment.id))
        db.commit()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Payment verification failed")

    # Ask the gateway directly rather than trusting the browser's word for it.
    try:
        remote = payments.fetch_payment(payload.razorpay_payment_id)
    except payments.PaymentError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    if remote.get("status") not in ("captured", "authorized"):
        payment.status = "failed"
        payment.error_description = f"Gateway reports status {remote.get('status')!r}"
        db.commit()
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, "Payment was not captured")

    payment.payment_id = payload.razorpay_payment_id
    payment.signature = payload.razorpay_signature
    org = _activate_from_payment(db, payment, remote)

    subscription = db.get(Subscription, payment.subscription_id)
    owner = db.scalar(select(User).where(User.org_id == org.id, User.role == Role.OWNER.value))

    audit(db, org_id=org.id, actor=owner, action="signup.completed", request=request,
          target_type="subscription", target_id=str(subscription.id),
          detail={"order_id": payment.order_id, "amount": payment.amount})
    db.commit()

    plan_name = subs.entitlement(db, org).plan.name
    login_url = settings.tenant_url(org.slug, "/login")
    period_end = subscription.period_end.date().isoformat() if subscription.period_end else "-"
    if owner is not None:
        # Best effort by design: send() never raises, so a bounced welcome mail
        # cannot fail a payment that already succeeded.
        email.send_welcome(
            owner.email, owner.full_name, org.name, login_url, plan_name,
            org_id=org.id,
        )
        email.send_payment_receipt(
            owner.email, org.name, plan_name, subscription.seats,
            payment.amount, period_end, org_id=org.id,
        )

    return SignupCompleteResponse(
        organization_id=str(org.id),
        slug=org.slug,
        login_url=settings.tenant_url(org.slug, "/login"),
        admin_email=owner.email if owner else "",
        plan_name=subs.entitlement(db, org).plan.name,
        seats=subscription.seats,
        period_end=subscription.period_end.isoformat() if subscription.period_end else None,
        status=subscription.status,
    )


@router.post("/simulate-payment/{order_id}")
def simulate_payment(order_id: str, db: DbSession) -> dict:
    """Produce the callback a real checkout would post back.

    Available only while no Razorpay keys are configured. It exists so the whole
    signup flow can be exercised in development without credentials.
    """
    if settings.payments_configured:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not available")
    if db.scalar(select(Payment.id).where(Payment.order_id == order_id)) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown order")
    return payments.simulate_checkout(order_id)


@router.post("/webhook", include_in_schema=False)
async def razorpay_webhook(request: Request, db: DbSession) -> dict:
    """Authoritative payment confirmation.

    Always returns 200 for anything it has already handled or cannot act on:
    Razorpay retries non-2xx responses, and retrying a webhook we have correctly
    ignored is pure noise.
    """
    body = await request.body()
    signature = request.headers.get("X-Razorpay-Signature", "")

    if not payments.verify_webhook_signature(body, signature):
        # 400, not 200: a bad signature is worth surfacing rather than silently
        # dropping, and Razorpay's retries on it are diagnostic.
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid webhook signature")

    event = await request.json()
    kind = event.get("event", "")
    entity = (
        event.get("payload", {}).get("payment", {}).get("entity", {})
        if "payment" in event.get("payload", {})
        else {}
    )
    order_id = entity.get("order_id")
    if not order_id:
        return {"ok": True, "ignored": "no order id"}

    payment = db.scalar(select(Payment).where(Payment.order_id == order_id))
    if payment is None:
        log.warning("webhook %s for unknown order %s", kind, order_id)
        return {"ok": True, "ignored": "unknown order"}

    if kind in ("payment.captured", "order.paid"):
        payment.payment_id = entity.get("id") or payment.payment_id
        _activate_from_payment(db, payment, entity)
        db.commit()
        return {"ok": True, "activated": True}

    if kind == "payment.failed":
        payment.status = "failed"
        payment.error_code = entity.get("error_code")
        payment.error_description = entity.get("error_description")
        payment.raw = entity
        db.commit()
        return {"ok": True, "failed": True}

    return {"ok": True, "ignored": kind}
