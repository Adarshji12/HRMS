"""Plan catalogue and price calculation.

The *shape* of a plan and the arithmetic over it live here. Which plans exist is
data — see ``app.models.plan`` and ``app.services.plancatalog`` — because an
operator has to be able to add a negotiated plan without a release. The built-in
three below are the seed for that table and the floor the system falls back to:
if the catalogue cannot be read, ``plan_for`` still answers, and it answers with
the *least* permissive plan rather than the most.

``PLANS`` is mutated in place by the catalogue loader, never rebound, so the
modules that did ``from app.core.plans import PLANS`` still see current data.

All money is in **paise** (integer minor units). Never floats — 0.1 + 0.2 is not
0.3, and a rounding error in a charge is a refund and a support ticket. Razorpay
also expects paise, so no conversion happens at the boundary.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass

from app.core.modules import GRANTABLE_KEYS

RUPEE = 100  # paise per rupee


class PlanId(str, enum.Enum):
    TRIAL = "trial"
    STANDARD = "standard"
    ENTERPRISE = "enterprise"


class BillingCycle(str, enum.Enum):
    MONTHLY = "monthly"
    ANNUAL = "annual"

    @property
    def months(self) -> int:
        return 1 if self is BillingCycle.MONTHLY else 12


class SubscriptionStatus(str, enum.Enum):
    TRIALING = "trialing"
    PENDING_PAYMENT = "pending_payment"
    ACTIVE = "active"
    PAST_DUE = "past_due"
    EXPIRED = "expired"
    CANCELED = "canceled"
    SUSPENDED = "suspended"  # switched off by Super Admin

    @property
    def allows_dashboard(self) -> bool:
        return self in (
            SubscriptionStatus.TRIALING,
            SubscriptionStatus.ACTIVE,
            SubscriptionStatus.PAST_DUE,
        )

    @property
    def allows_collection(self) -> bool:
        """Whether agents may still enrol and upload.

        ``past_due`` deliberately keeps collecting. Cutting off capture the
        moment a card fails destroys the customer's data permanently, which is a
        far worse outcome than carrying an unpaid week — read access is what
        should degrade, not capture. ``suspended`` does stop collection, because
        that is a deliberate act by us, not a billing hiccup.
        """
        return self in (
            SubscriptionStatus.TRIALING,
            SubscriptionStatus.ACTIVE,
            SubscriptionStatus.PAST_DUE,
        )


@dataclass(frozen=True)
class Plan:
    # A slug, not the enum: a plan an operator adds has no enum member. PlanId
    # still names the three built-ins, and TRIAL is still the fallback.
    id: str
    name: str
    # Base fee for a full year, charged regardless of headcount.
    base_price_annual: int
    # Per employee, per month.
    per_employee_month: int
    min_employees: int
    max_employees: int
    max_screenshot_retention_days: int
    max_activity_retention_days: int
    min_screenshot_interval_s: int
    storage_gb: int
    features: tuple[str, ...] = ()
    #: HRMS modules this plan includes, by key. **Empty means every module** —
    #: not "none" — so every plan that existed before module gating, and every
    #: plan an operator creates without thinking about it, stays unrestricted.
    #: A gate whose default is "deny" turns one forgotten field into a customer
    #: losing a feature they already paid for.
    #:
    #: Deliberately NOT `features`, which is marketing copy for the pricing page
    #: ("SSO & SCIM", "Up to 5 employees"). Gating on a display string would mean
    #: rewording an advert silently revokes access.
    modules: tuple[str, ...] = ()
    description: str | None = None
    is_active: bool = True
    is_public: bool = True
    is_builtin: bool = False
    sort_order: int = 100

    def quote(self, employees: int, cycle: BillingCycle) -> "Quote":
        """Price for ``employees`` seats over one billing period."""
        seats = max(self.min_employees, min(employees, self.max_employees))
        months = cycle.months
        # The annual base is charged pro rata on a monthly cycle so the two
        # cycles stay comparable and switching between them is not a cliff.
        base = self.base_price_annual if months == 12 else round(self.base_price_annual / 12)
        seat_total = self.per_employee_month * seats * months
        return Quote(
            plan=self,
            cycle=cycle,
            employees=seats,
            base_amount=base,
            seat_amount=seat_total,
        )


@dataclass(frozen=True)
class Quote:
    plan: Plan
    cycle: BillingCycle
    employees: int
    base_amount: int
    seat_amount: int

    @property
    def subtotal(self) -> int:
        return self.base_amount + self.seat_amount

    @property
    def tax_amount(self) -> int:
        # 18% GST. A real deployment resolves this from the customer's place of
        # supply and GSTIN; this is a placeholder that at least keeps the
        # arithmetic and the displayed total honest.
        return round(self.subtotal * 0.18)

    @property
    def total(self) -> int:
        return self.subtotal + self.tax_amount

    def as_dict(self) -> dict:
        return {
            "plan_id": self.plan.id,
            "plan_name": self.plan.name,
            "billing_cycle": self.cycle.value,
            "employees": self.employees,
            "base_amount": self.base_amount,
            "seat_amount": self.seat_amount,
            "subtotal": self.subtotal,
            "tax_amount": self.tax_amount,
            "tax_rate_pct": 18,
            "total": self.total,
            "currency": "INR",
            # Convenience for the UI so it never does money maths in JS floats.
            "total_display": f"₹{self.total / 100:,.2f}",
            "per_employee_month": self.plan.per_employee_month,
            "base_price_annual": self.plan.base_price_annual,
        }


#: Every gateable HRMS module, re-exported from the registry that declares them.
#:
#: Kept as a name here because plan validation and several call sites already
#: import it; the list itself moved to ``app.core.modules`` so that adding a
#: module is one entry in one file rather than a tuple here plus a label map in
#: the UI plus a nav entry in the console.
ALL_MODULES: tuple[str, ...] = GRANTABLE_KEYS


BUILTIN_PLANS: dict[str, Plan] = {
    PlanId.TRIAL.value: Plan(
        id=PlanId.TRIAL.value,
        name="Free Trial",
        base_price_annual=0,
        per_employee_month=0,
        min_employees=1,
        max_employees=5,
        max_screenshot_retention_days=14,
        max_activity_retention_days=30,
        min_screenshot_interval_s=300,
        storage_gb=2,
        features=("Up to 5 employees", "14 days", "Full feature access"),
        description="Everything, for two weeks, for up to five people.",
        is_builtin=True,
        sort_order=10,
    ),
    PlanId.STANDARD.value: Plan(
        id=PlanId.STANDARD.value,
        name="Standard",
        base_price_annual=5_000 * RUPEE,
        per_employee_month=200 * RUPEE,
        min_employees=1,
        max_employees=500,
        max_screenshot_retention_days=90,
        max_activity_retention_days=365,
        min_screenshot_interval_s=60,
        storage_gb=250,
        features=(
            "Activity, apps & website tracking",
            "Screenshots from every 1 minute",
            "Timesheets, projects & reports",
            "Teams, departments & hierarchy",
        ),
        description="The everyday plan for a growing team.",
        is_builtin=True,
        sort_order=20,
    ),
    PlanId.ENTERPRISE.value: Plan(
        id=PlanId.ENTERPRISE.value,
        name="Enterprise",
        base_price_annual=5_000 * RUPEE,
        per_employee_month=200 * RUPEE,
        min_employees=100,
        max_employees=100_000,
        max_screenshot_retention_days=3650,
        max_activity_retention_days=3650,
        min_screenshot_interval_s=60,
        storage_gb=10_000,
        features=("Everything in Standard", "SSO & SCIM", "Custom retention", "DPA & audit support"),
        description="For a hundred seats and up, with the paperwork procurement asks for.",
        is_builtin=True,
        sort_order=30,
    ),
}

#: The live catalogue, keyed by slug. Seeded from ``BUILTIN_PLANS`` and replaced
#: in place by ``app.services.plancatalog.refresh`` once the database is
#: readable. Mutated, never rebound — importers hold this exact dict.
PLANS: dict[str, Plan] = dict(BUILTIN_PLANS)


def replace_catalogue(plans: dict[str, Plan]) -> None:
    """Swap the catalogue's contents without rebinding the name.

    ``trial`` is force-kept: it is what every unrecognised plan id resolves to,
    and a catalogue without it would make ``plan_for`` raise on the one path
    that exists so it never can.
    """
    PLANS.clear()
    PLANS.update(plans)
    PLANS.setdefault(PlanId.TRIAL.value, BUILTIN_PLANS[PlanId.TRIAL.value])


def plan_for(plan_id: str | None) -> Plan:
    """Resolve a stored ``subscriptions.plan_id`` to its limits.

    A plan an operator later deleted, or a typo, resolves to the trial — an
    unrecognised plan string must never grant *more* than the least one.
    """
    if plan_id:
        plan = PLANS.get(plan_id)
        if plan is not None:
            return plan
    return PLANS.get(PlanId.TRIAL.value, BUILTIN_PLANS[PlanId.TRIAL.value])


def quote_for(plan_id: str, employees: int, cycle: str) -> Quote:
    try:
        billing_cycle = BillingCycle(cycle)
    except ValueError:
        billing_cycle = BillingCycle.ANNUAL
    return plan_for(plan_id).quote(employees, billing_cycle)
