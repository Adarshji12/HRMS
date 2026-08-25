"""Loads the plan catalogue out of the database and into ``app.core.plans``.

Two jobs, and keeping them apart is the point:

* ``sync_builtins`` writes the three plans defined in code into the table if
  they are missing. It never overwrites an operator's edits — an operator who
  discounts Standard should not have that undone by the next deploy — it only
  fills in a row that is not there at all.
* ``refresh`` reads the table back into ``plans.PLANS`` so that every existing
  caller of ``plan_for`` keeps working unchanged, with no ``Session`` threaded
  through a dozen call sites that have no business holding one.

The cache is process-local and refreshed whenever the catalogue is written, so
a single-process deployment is immediately consistent. Multi-process runs pick a
change up on the ``CATALOGUE_TTL_S`` re-read below, which is the trade being
made deliberately: plan edits are rare and a minute of staleness on a price is
survivable, whereas a database round trip on every entitlement check is not.
"""

from __future__ import annotations

import logging
import time

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.plans import BUILTIN_PLANS, Plan, replace_catalogue
from app.models.plan import PlanRecord

log = logging.getLogger("sentinel.plans")

CATALOGUE_TTL_S = 60

_loaded_at = 0.0


def record_to_plan(row: PlanRecord) -> Plan:
    return Plan(
        id=row.id,
        name=row.name,
        base_price_annual=row.base_price_annual,
        per_employee_month=row.per_employee_month,
        min_employees=row.min_employees,
        max_employees=row.max_employees,
        max_screenshot_retention_days=row.max_screenshot_retention_days,
        max_activity_retention_days=row.max_activity_retention_days,
        min_screenshot_interval_s=row.min_screenshot_interval_s,
        storage_gb=row.storage_gb,
        features=tuple(row.features or ()),
        modules=tuple(row.modules or ()),
        description=row.description,
        is_active=row.is_active,
        is_public=row.is_public,
        is_builtin=row.is_builtin,
        sort_order=row.sort_order,
    )


def sync_builtins(db: Session) -> int:
    """Insert any built-in plan the table is missing. Returns how many.

    Idempotent, and deliberately insert-only: a row that already exists is left
    exactly as the operator left it.
    """
    existing = set(db.scalars(select(PlanRecord.id)).all())
    added = 0
    for plan in BUILTIN_PLANS.values():
        if plan.id in existing:
            continue
        db.add(
            PlanRecord(
                id=plan.id,
                name=plan.name,
                description=plan.description,
                base_price_annual=plan.base_price_annual,
                per_employee_month=plan.per_employee_month,
                min_employees=plan.min_employees,
                max_employees=plan.max_employees,
                max_screenshot_retention_days=plan.max_screenshot_retention_days,
                max_activity_retention_days=plan.max_activity_retention_days,
                min_screenshot_interval_s=plan.min_screenshot_interval_s,
                storage_gb=plan.storage_gb,
                features=list(plan.features),
                modules=list(plan.modules),
                is_active=True,
                is_public=True,
                is_builtin=True,
                sort_order=plan.sort_order,
            )
        )
        added += 1
    if added:
        db.commit()
    return added


def _seed_in_new_session() -> None:
    """Seed the built-ins on a session of our own.

    Deliberately not the caller's session: ``refresh`` is reached from inside
    request handlers that have uncommitted work pending, and committing theirs
    early to write reference data would persist half a signup.
    """
    from app.db.session import SessionLocal

    with SessionLocal() as own:
        sync_builtins(own)


def refresh(db: Session) -> None:
    """Reload ``plans.PLANS`` from the table.

    An empty table is treated as "not seeded yet" rather than as "no plans
    exist" — the latter would leave every company resolving to the code
    fallback with nothing in the console to edit.
    """
    global _loaded_at
    rows = db.scalars(select(PlanRecord)).all()
    if not rows:
        _seed_in_new_session()
        rows = db.scalars(select(PlanRecord)).all()
    if rows:
        replace_catalogue({row.id: record_to_plan(row) for row in rows})
    _loaded_at = time.monotonic()


def ensure_fresh(db: Session) -> None:
    """Reload if the cached catalogue has aged out. Cheap on the common path."""
    if time.monotonic() - _loaded_at < CATALOGUE_TTL_S:
        return
    refresh(db)


def bootstrap() -> None:
    """Startup hook: seed the built-ins, then load the catalogue.

    Failure here is logged and swallowed. The code defaults in
    ``BUILTIN_PLANS`` are already loaded, so a catalogue the database will not
    hand over degrades to "the three plans we shipped" rather than to a server
    that will not boot.
    """
    from app.db.session import SessionLocal

    try:
        with SessionLocal() as db:
            sync_builtins(db)
            refresh(db)
    except Exception:  # pragma: no cover - startup resilience
        log.exception("could not load the plan catalogue; using the built-in plans")


def list_plans(db: Session, *, public_only: bool = False) -> list[PlanRecord]:
    stmt = select(PlanRecord).order_by(PlanRecord.sort_order, PlanRecord.name)
    if public_only:
        stmt = stmt.where(PlanRecord.is_active.is_(True), PlanRecord.is_public.is_(True))
    return list(db.scalars(stmt).all())


def as_dict(row: PlanRecord) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "description": row.description,
        "base_price_annual": row.base_price_annual,
        "per_employee_month": row.per_employee_month,
        "min_employees": row.min_employees,
        "max_employees": row.max_employees,
        "max_screenshot_retention_days": row.max_screenshot_retention_days,
        "max_activity_retention_days": row.max_activity_retention_days,
        "min_screenshot_interval_s": row.min_screenshot_interval_s,
        "storage_gb": row.storage_gb,
        "features": list(row.features or ()),
        "is_active": row.is_active,
        "is_public": row.is_public,
        "is_builtin": row.is_builtin,
        "sort_order": row.sort_order,
    }
