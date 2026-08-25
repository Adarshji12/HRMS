"""Subscription resolution and plan enforcement.

The single place that answers "what is this company allowed to do right now".
Handlers ask this module rather than reading ``Subscription`` columns directly,
so a limit is enforced identically everywhere instead of being re-derived (and
eventually mis-derived) per endpoint.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core import modules
from app.core.config import settings as app_settings
from app.core.plans import BillingCycle, Plan, PlanId, SubscriptionStatus, plan_for
from app.models import Organization, OrgSettings, Screenshot, Subscription, User


def current_subscription(db: Session, org_id: uuid.UUID) -> Subscription | None:
    """The newest subscription row for the organisation.

    Newest rather than "active": a lapsed subscription still governs what the
    company may do (namely, very little), and returning None for it would read
    as "no limits" to any caller that forgot to handle the null.
    """
    return db.scalar(
        select(Subscription)
        .where(Subscription.org_id == org_id)
        .order_by(Subscription.created_at.desc())
        .limit(1)
    )


@dataclass(frozen=True)
class Entitlement:
    org: Organization
    subscription: Subscription | None
    plan: Plan
    status: SubscriptionStatus
    seats: int

    @property
    def dashboard_allowed(self) -> bool:
        return self.org.status == "active" and self.status.allows_dashboard

    @property
    def collection_allowed(self) -> bool:
        return self.org.status == "active" and self.status.allows_collection

    def allows_module(self, key: str) -> bool:
        """Whether this company may use an HRMS module, right now.

        Routed through here rather than through a second entitlement system, per
        HRMS_EXPANSION_PLAN §9.5 — "what is this company allowed to do right now"
        already has exactly one answer and this is a new question for it, not a
        new authority.

        Two layers, in this order:

        1. **The company's own grants** (``organizations.module_grants``), set by
           Super Admin. A key present there wins outright, in both directions: a
           customer who negotiated one extra module gets it without a bespoke
           plan, and a module can be switched off for one company without
           touching a plan other companies share.
        2. **The plan**, otherwise. An **empty** ``plan.modules`` means every
           module — a plan predating module gating, or one an operator creates
           without touching the field, stays unrestricted. A gate defaulting to
           deny turns one forgotten checkbox into a customer losing something
           they paid for.

        The override is read defensively. ``module_grants`` is a JSON column, so
        a hand-edited row can hold anything; a non-dict, or a value that is not a
        bool, falls through to the plan rather than raising. An entitlement check
        that 500s takes down the module for everyone, which is strictly worse
        than ignoring one malformed row.
        """
        grants = self.org.module_grants
        if isinstance(grants, dict):
            override = grants.get(key)
            if isinstance(override, bool):
                return override
        if not self.plan.modules:
            return True
        return key in self.plan.modules

    def module_state(self) -> dict[str, dict]:
        """Every registered module with how it resolved, and why.

        The "why" is the reason this exists rather than a bare ``{key: bool}``.
        Super Admin needs to render a switch that distinguishes "off because the
        plan does not include it" from "off because someone turned it off here",
        and the second is the only one an operator can undo on this screen.
        """
        grants = self.org.module_grants if isinstance(self.org.module_grants, dict) else {}
        state: dict[str, dict] = {}
        for definition in modules.MODULES:
            override = grants.get(definition.key)
            override = override if isinstance(override, bool) else None
            by_plan = (not self.plan.modules) or definition.key in self.plan.modules
            state[definition.key] = {
                "enabled": override if override is not None else by_plan,
                "in_plan": by_plan,
                "override": override,
                "source": "grant" if override is not None else "plan",
            }
        return state

    @property
    def days_remaining(self) -> int | None:
        if self.subscription is None or self.subscription.period_end is None:
            return None
        end = self.subscription.period_end
        if end.tzinfo is None:
            end = end.replace(tzinfo=timezone.utc)
        return max(0, (end - datetime.now(timezone.utc)).days)


def entitlement(db: Session, org: Organization) -> Entitlement:
    sub = current_subscription(db, org.id)

    if sub is None:
        return Entitlement(org, None, plan_for(PlanId.TRIAL.value),
                           SubscriptionStatus.EXPIRED, 0)

    try:
        state = SubscriptionStatus(sub.status)
    except ValueError:
        state = SubscriptionStatus.EXPIRED

    # A period that has run out is expired regardless of what the row says —
    # otherwise a company whose renewal never fired keeps full access forever.
    if state in (SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING) and sub.is_expired:
        state = SubscriptionStatus.EXPIRED

    return Entitlement(org, sub, plan_for(sub.plan_id), state, sub.seats)


# --------------------------------------------------------------------------- #
# Seats
# --------------------------------------------------------------------------- #


def seats_used(db: Session, org_id: uuid.UUID) -> int:
    """Active employees. Deactivated staff do not consume a seat."""
    return int(
        db.scalar(
            select(func.count(User.id)).where(
                User.org_id == org_id, User.is_active.is_(True)
            )
        )
        or 0
    )


def ensure_seat_available(db: Session, org: Organization) -> None:
    ent = entitlement(db, org)
    if not ent.dashboard_allowed:
        raise HTTPException(
            status.HTTP_402_PAYMENT_REQUIRED,
            detail={
                "reason": "subscription_inactive",
                "status": ent.status.value,
                "message": "This subscription is not active. Renew to add employees.",
            },
        )
    used = seats_used(db, org.id)
    if used >= ent.seats:
        raise HTTPException(
            status.HTTP_402_PAYMENT_REQUIRED,
            detail={
                "reason": "seat_limit_reached",
                "seats_used": used,
                "seat_limit": ent.seats,
                "message": (
                    f"All {ent.seats} seats are in use. Add seats to your plan "
                    f"to onboard more employees."
                ),
            },
        )


def ensure_collection_allowed(db: Session, org: Organization) -> None:
    """Guard for agent endpoints.

    Note that ``past_due`` still passes: cutting off capture the moment a
    payment fails destroys the customer's data permanently, which is far worse
    than carrying an unpaid week. Read access degrades first.
    """
    ent = entitlement(db, org)
    if not ent.collection_allowed:
        raise HTTPException(
            status.HTTP_402_PAYMENT_REQUIRED,
            detail={
                "reason": "collection_suspended",
                "status": ent.status.value,
                "message": "Tracking is suspended for this organisation.",
            },
        )


# --------------------------------------------------------------------------- #
# Plan-capped settings
# --------------------------------------------------------------------------- #


def clamp_settings_to_plan(org_settings: OrgSettings, plan: Plan) -> list[str]:
    """Force org settings inside the plan's limits.

    Applied on save *and* on plan change, so a downgrade actually reduces what
    is collected instead of leaving a lapsed customer on enterprise retention.
    Returns a description of anything that had to be reduced, for the response.
    """
    adjusted: list[str] = []

    if org_settings.screenshot_retention_days > plan.max_screenshot_retention_days:
        org_settings.screenshot_retention_days = plan.max_screenshot_retention_days
        adjusted.append(
            f"screenshot retention capped at {plan.max_screenshot_retention_days} days"
        )

    if org_settings.activity_retention_days > plan.max_activity_retention_days:
        org_settings.activity_retention_days = plan.max_activity_retention_days
        adjusted.append(f"activity retention capped at {plan.max_activity_retention_days} days")

    if org_settings.screenshot_interval_s < plan.min_screenshot_interval_s:
        org_settings.screenshot_interval_s = plan.min_screenshot_interval_s
        adjusted.append(
            f"screenshot interval raised to {plan.min_screenshot_interval_s}s"
        )

    return adjusted


# --------------------------------------------------------------------------- #
# Lifecycle
# --------------------------------------------------------------------------- #


def start_trial(db: Session, org: Organization, seats: int = 5) -> Subscription:
    now = datetime.now(timezone.utc)
    plan = plan_for(PlanId.TRIAL.value)
    sub = Subscription(
        org_id=org.id,
        plan_id=plan.id,
        billing_cycle=BillingCycle.ANNUAL.value,
        seats=min(seats, plan.max_employees),
        status=SubscriptionStatus.TRIALING.value,
        period_start=now,
        period_end=now + timedelta(days=app_settings.trial_days),
        activated_at=now,
    )
    db.add(sub)
    return sub


def activate(db: Session, sub: Subscription, *, at: datetime | None = None) -> Subscription:
    """Mark a paid subscription live and set its period.

    The period starts when payment lands, not when the order was created — a
    customer who leaves the checkout open overnight should not lose a day.
    """
    now = at or datetime.now(timezone.utc)
    months = BillingCycle(sub.billing_cycle).months
    sub.status = SubscriptionStatus.ACTIVE.value
    sub.activated_at = now
    sub.period_start = now
    # Calendar-ish month arithmetic without a dateutil dependency; 30-day months
    # would drift a customer's renewal date backwards every year.
    year = now.year + (now.month - 1 + months) // 12
    month = (now.month - 1 + months) % 12 + 1
    day = min(now.day, _days_in_month(year, month))
    sub.period_end = now.replace(year=year, month=month, day=day)

    org = db.get(Organization, sub.org_id)
    if org is not None:
        org.status = "active"
        org.suspended_at = None
        org.suspended_reason = None
        org_settings = db.get(OrgSettings, org.id)
        if org_settings is not None:
            clamp_settings_to_plan(org_settings, plan_for(sub.plan_id))
    return sub


def _days_in_month(year: int, month: int) -> int:
    import calendar

    return calendar.monthrange(year, month)[1]


# --------------------------------------------------------------------------- #
# Usage, for the Super Admin console
# --------------------------------------------------------------------------- #


def usage_for(db: Session, org: Organization) -> dict:
    ent = entitlement(db, org)
    used = seats_used(db, org.id)
    shots = int(
        db.scalar(select(func.count(Screenshot.id)).where(Screenshot.org_id == org.id)) or 0
    )
    storage_bytes = int(
        db.scalar(
            select(func.coalesce(func.sum(Screenshot.file_size), 0)).where(
                Screenshot.org_id == org.id
            )
        )
        or 0
    )
    return {
        "seats_used": used,
        "seat_limit": ent.seats,
        "seats_available": max(0, ent.seats - used),
        "screenshots": shots,
        "storage_bytes": storage_bytes,
        "storage_gb_limit": ent.plan.storage_gb,
        "status": ent.status.value,
        "plan_id": ent.plan.id,
        "plan_name": ent.plan.name,
        "days_remaining": ent.days_remaining,
    }
