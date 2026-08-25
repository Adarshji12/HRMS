"""The plan catalogue, as data.

Pricing used to be a frozen dataclass in ``app.core.plans`` on the argument that
a price should change on a deploy, not at runtime. That holds for a single
hosted product; it does not hold for this one, where an operator negotiates a
plan for a customer and needs it to exist the same afternoon. Waiting on a
release to add "Standard (50 seats, comped)" meant the override panel was used
to fake it, and the subscription then said ``standard`` while the customer was
on something else entirely.

So the catalogue lives here and the built-ins are seeded from code on startup.
The two properties that mattered are kept:

* **Money is still integer paise.** Never floats — see ``app.core.plans``.
* **A row is never really deleted while anything references it.** Deactivating
  hides a plan from new signups; a subscription that still names it keeps
  resolving to the same limits it was sold under.
"""

from __future__ import annotations

from sqlalchemy import Boolean, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin


class PlanRecord(TimestampMixin, Base):
    __tablename__ = "plans"

    #: Stable slug — ``trial``, ``standard`` or whatever an operator adds. This
    #: is what ``subscriptions.plan_id`` stores, so it is the primary key and is
    #: never rewritten; renaming a plan changes ``name``, not ``id``.
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    base_price_annual: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    per_employee_month: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    min_employees: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    max_employees: Mapped[int] = mapped_column(Integer, default=100, nullable=False)

    max_screenshot_retention_days: Mapped[int] = mapped_column(Integer, default=30, nullable=False)
    max_activity_retention_days: Mapped[int] = mapped_column(Integer, default=90, nullable=False)
    min_screenshot_interval_s: Mapped[int] = mapped_column(Integer, default=300, nullable=False)
    storage_gb: Mapped[int] = mapped_column(Integer, default=10, nullable=False)

    features: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    #: HRMS module keys this plan includes. Empty list = every module, so
    #: existing rows need no backfill and stay unrestricted.
    modules: Mapped[list] = mapped_column(JSON, default=list, nullable=False)

    #: Off means "no longer sold". Existing subscriptions on the plan are
    #: untouched — the limits they were sold under still resolve.
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    #: Whether the public signup page offers it. An operator-only plan (a
    #: negotiated enterprise deal) is active but not public.
    is_public: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    #: Built-ins are re-seeded on every boot and cannot be deleted; ``trial`` in
    #: particular is the fallback every unknown plan id resolves to.
    is_builtin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    sort_order: Mapped[int] = mapped_column(Integer, default=100, nullable=False)
