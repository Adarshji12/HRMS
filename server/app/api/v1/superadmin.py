"""Super Admin (platform operator) API.

Mounted at ``/api/v1/platform``. Deliberately outside the tenant machinery:
these endpoints have no ``X-Org-Slug`` and no subdomain, because an operator
belongs to no organisation. Authentication is a separate token type, so a
company admin's token is rejected here even if they somehow guessed a URL.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator
from sqlalchemy import func, or_, select

from app.api.deps import DbSession, PlatformUser, PlatformWriter, audit
from app.core.config import settings
from app.core import modules as module_registry
from app.core.modules import GRANTABLE_KEYS
from app.core.plans import PlanId, SubscriptionStatus, plan_for, ALL_MODULES
from app.core import ratelimit
from app.core.security import (
    create_access_token,
    generate_enrollment_key,
    generate_password,
    hash_password,
    verify_password,
)
from app.services.classifier import seed_default_rules
from app.services import email, mailconfig, plancatalog, storage
from app.models import (
    AuditLog,
    Device,
    NotificationLog,
    Organization,
    OrgSettings,
    Payment,
    PlanRecord,
    Role,
    Screenshot,
    Subscription,
    Team,
    User,
)
from app.schemas.platform import (
    ChangePasswordRequest,
    CompanyDetail,
    CompanyRow,
    PaymentOut,
    PlatformAdminOut,
    PlatformLoginRequest,
    PlatformStats,
    PlatformTokenResponse,
    SubscriptionOut,
    SubscriptionOverride,
    SuspendRequest,
)
from app.services import subscriptions as subs

router = APIRouter(prefix="/platform", tags=["super-admin"])

log = logging.getLogger("sentinel.platform")

ONLINE_GRACE_S = 150


# --------------------------------------------------------------------------- #
# Auth
# --------------------------------------------------------------------------- #


@router.post("/auth/login", response_model=PlatformTokenResponse)
def platform_login(
    payload: PlatformLoginRequest, request: Request, db: DbSession
) -> PlatformTokenResponse:
    from app.models import PlatformAdmin

    # The platform console reaches every tenant, so this is the single highest
    # value credential in the product and gets the tightest bucket.
    ratelimit.enforce(request, "platform-login", ratelimit.LOGIN, payload.email)

    admin = db.scalar(
        select(PlatformAdmin).where(PlatformAdmin.email == payload.email.strip().lower())
    )
    if admin is None or not admin.is_active or not verify_password(
        payload.password, admin.password_hash
    ):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password")

    admin.last_login_at = datetime.now(timezone.utc)
    db.commit()

    return PlatformTokenResponse(
        access_token=create_access_token(str(admin.id), {"typ": "platform"}),
        expires_in=settings.access_token_expire_minutes * 60,
        admin=PlatformAdminOut.model_validate(admin),
    )


@router.get("/auth/me", response_model=PlatformAdminOut)
def platform_me(admin: PlatformUser):
    return admin


@router.post("/auth/change-password", response_model=PlatformAdminOut)
def change_password(payload: ChangePasswordRequest, admin: PlatformUser, db: DbSession):
    # Uses PlatformUser, not PlatformWriter: this is the one write that must
    # work while must_change_password is still set, or the account is bricked.
    if not verify_password(payload.current_password, admin.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Current password is incorrect")
    if payload.new_password == payload.current_password:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "New password must differ from the current one"
        )
    admin.password_hash = hash_password(payload.new_password)
    admin.must_change_password = False
    db.commit()
    return admin


# --------------------------------------------------------------------------- #
# Companies
# --------------------------------------------------------------------------- #


def _online_counts(db) -> dict[uuid.UUID, int]:
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=ONLINE_GRACE_S)
    rows = db.execute(
        select(Device.org_id, func.count(func.distinct(Device.user_id)))
        .where(
            Device.is_active.is_(True),
            Device.last_seen_at.is_not(None),
            Device.last_seen_at >= cutoff,
        )
        .group_by(Device.org_id)
    )
    return {row[0]: int(row[1]) for row in rows}


def _payment_status(db, org_id: uuid.UUID) -> str:
    latest = db.scalar(
        select(Payment)
        .where(Payment.org_id == org_id)
        .order_by(Payment.created_at.desc())
        .limit(1)
    )
    return latest.status if latest else "none"


def _company_row(db, org: Organization, seat_counts, online_counts) -> CompanyRow:
    ent = subs.entitlement(db, org)
    owner = db.scalar(
        select(User)
        .where(User.org_id == org.id, User.role.in_([Role.OWNER.value, Role.ADMIN.value]))
        .order_by(User.created_at)
        .limit(1)
    )
    sub = ent.subscription
    return CompanyRow(
        id=org.id,
        name=org.name,
        slug=org.slug,
        status=org.status,
        timezone=org.timezone,
        contact_email=org.contact_email,
        contact_phone=org.contact_phone,
        created_at=org.created_at,
        admin_name=owner.full_name if owner else None,
        admin_email=owner.email if owner else None,
        plan_id=ent.plan.id,
        plan_name=ent.plan.name,
        subscription_status=ent.status.value,
        billing_cycle=sub.billing_cycle if sub else None,
        period_start=sub.period_start if sub else None,
        period_end=sub.period_end if sub else None,
        days_remaining=ent.days_remaining,
        payment_status=_payment_status(db, org.id),
        seat_limit=ent.seats,
        seats_used=seat_counts.get(org.id, 0),
        employees_online=online_counts.get(org.id, 0),
    )


@router.get("/companies", response_model=list[CompanyRow])
def list_companies(
    admin: PlatformUser,
    db: DbSession,
    q: str | None = Query(default=None, description="name, slug or contact email"),
    status_filter: str | None = Query(default=None, alias="status"),
    plan: str | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> list[CompanyRow]:
    stmt = select(Organization).order_by(Organization.created_at.desc())
    if q:
        needle = f"%{q.strip().lower()}%"
        stmt = stmt.where(
            or_(
                func.lower(Organization.name).like(needle),
                func.lower(Organization.slug).like(needle),
                func.lower(Organization.contact_email).like(needle),
            )
        )
    if status_filter:
        stmt = stmt.where(Organization.status == status_filter)

    orgs = list(db.scalars(stmt.limit(limit).offset(offset)).all())

    seat_counts = {
        row[0]: int(row[1])
        for row in db.execute(
            select(User.org_id, func.count(User.id))
            .where(User.is_active.is_(True))
            .group_by(User.org_id)
        )
    }
    online = _online_counts(db)

    rows = [_company_row(db, org, seat_counts, online) for org in orgs]
    # Plan is derived, not a column, so it is filtered after assembly.
    if plan:
        rows = [r for r in rows if r.plan_id == plan]
    return rows


@router.get("/companies/{org_id}", response_model=CompanyDetail)
def company_detail(org_id: uuid.UUID, admin: PlatformUser, db: DbSession) -> CompanyDetail:
    org = db.get(Organization, org_id)
    if org is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Company not found")

    seat_counts = {org.id: subs.seats_used(db, org.id)}
    base = _company_row(db, org, seat_counts, _online_counts(db))

    history = list(
        db.scalars(
            select(Subscription)
            .where(Subscription.org_id == org.id)
            .order_by(Subscription.created_at.desc())
        ).all()
    )
    payments = list(
        db.scalars(
            select(Payment)
            .where(Payment.org_id == org.id)
            .order_by(Payment.created_at.desc())
            .limit(50)
        ).all()
    )
    activity = db.execute(
        select(AuditLog.action, AuditLog.created_at, AuditLog.detail)
        .where(AuditLog.org_id == org.id)
        .order_by(AuditLog.created_at.desc())
        .limit(30)
    )

    return CompanyDetail(
        **base.model_dump(),
        legal_name=org.legal_name,
        gstin=org.gstin,
        city=org.city,
        state=org.state,
        country=org.country,
        suspended_reason=org.suspended_reason,
        usage=subs.usage_for(db, org),
        subscriptions=[SubscriptionOut.model_validate(s) for s in history],
        payments=[PaymentOut.model_validate(p) for p in payments],
        recent_activity=[
            {"action": a, "at": t.isoformat() if t else None, "detail": d}
            for a, t, d in activity
        ],
    )


@router.post("/companies/{org_id}/suspend", response_model=CompanyRow)
def suspend_company(
    org_id: uuid.UUID,
    payload: SuspendRequest,
    admin: PlatformWriter,
    request: Request,
    db: DbSession,
) -> CompanyRow:
    org = db.get(Organization, org_id)
    if org is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Company not found")

    org.status = "suspended"
    org.suspended_at = datetime.now(timezone.utc)
    org.suspended_reason = payload.reason
    # Stop the agents too. Suspending only the dashboard would leave a
    # suspended company still collecting employee data, which is the one thing
    # a suspension must not allow.
    db.execute(Device.__table__.update().where(Device.org_id == org.id).values(is_active=False))

    audit(db, org_id=org.id, actor=None, action="platform.company_suspended", request=request,
          target_type="organization", target_id=str(org.id),
          detail={"reason": payload.reason, "by": admin.email})
    db.commit()
    return _company_row(db, org, {org.id: subs.seats_used(db, org.id)}, _online_counts(db))


@router.post("/companies/{org_id}/activate", response_model=CompanyRow)
def activate_company(
    org_id: uuid.UUID, admin: PlatformWriter, request: Request, db: DbSession
) -> CompanyRow:
    org = db.get(Organization, org_id)
    if org is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Company not found")

    org.status = "active"
    org.suspended_at = None
    org.suspended_reason = None
    # Devices are NOT auto-reactivated: they were switched off deliberately and
    # each machine should re-enrol, so a suspension is a real interruption
    # rather than something a company can wait out.
    audit(db, org_id=org.id, actor=None, action="platform.company_activated", request=request,
          target_type="organization", target_id=str(org.id), detail={"by": admin.email})
    db.commit()
    return _company_row(db, org, {org.id: subs.seats_used(db, org.id)}, _online_counts(db))


# --------------------------------------------------------------------------- #
# Per-company module grants
# --------------------------------------------------------------------------- #


class ModuleGrantIn(BaseModel):
    """One switch move: a module key and what to force it to.

    ``enabled=None`` is not "off" — it clears the override and returns the
    module to whatever the plan says. Without a way to express that, an operator
    who switches something on to help a customer through a bad week can never
    put it back under the plan's control, and the company drifts out of sync
    with every other company on that plan.
    """

    key: str
    enabled: bool | None = None

    @field_validator("key")
    @classmethod
    def _known(cls, value: str) -> str:
        cleaned = value.strip().lower()
        # Against GRANTABLE_KEYS, not ALL_KEYS: a planned module has no routes,
        # so storing a grant for it would read later as a customer who has a
        # feature that does not exist.
        if cleaned not in GRANTABLE_KEYS:
            raise ValueError(
                f"unknown module {value!r}; grantable keys are {sorted(GRANTABLE_KEYS)}"
            )
        return cleaned


class ModuleGrantsIn(BaseModel):
    """A whole panel submit. Replaces the override map, it does not merge.

    Replace rather than merge so the screen is honest: what the operator sees is
    what the company has. A merging endpoint cannot express "clear this one"
    without a second delete call, and the two get out of step the first time a
    request is retried.
    """

    grants: list[ModuleGrantIn] = Field(default_factory=list, max_length=64)


def _modules_payload(db, org: Organization) -> dict:
    """The registry, this company's resolved state, and the plan behind it."""
    ent = subs.entitlement(db, org)
    return {
        "plan_id": ent.plan.id,
        "plan_name": ent.plan.name,
        # Empty plan.modules means unrestricted; say so rather than sending []
        # and letting the UI guess what an empty list means.
        "plan_unrestricted": not ent.plan.modules,
        "modules": [
            {**definition, **ent.module_state()[definition["key"]]}
            for definition in module_registry.as_dicts()
        ],
    }


@router.get("/companies/{org_id}/modules")
def read_company_modules(org_id: uuid.UUID, admin: PlatformUser, db: DbSession) -> dict:
    """Which modules this company has, and whether the plan or a grant decided.

    Readable by any platform admin, including one still on a bootstrap password:
    looking at what a customer is entitled to is exactly the read-only
    inspection that account is for.
    """
    org = db.get(Organization, org_id)
    if org is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Company not found")
    return _modules_payload(db, org)


@router.put("/companies/{org_id}/modules")
def write_company_modules(
    org_id: uuid.UUID,
    payload: ModuleGrantsIn,
    admin: PlatformWriter,
    request: Request,
    db: DbSession,
) -> dict:
    """Set this company's module overrides.

    Audited with the before and after map rather than "modules changed". A
    module appearing or vanishing for a customer is the kind of thing that gets
    asked about weeks later, and "who turned Leave off for Acme on the 14th" is
    only answerable if the row carries both sides.
    """
    org = db.get(Organization, org_id)
    if org is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Company not found")

    before = dict(org.module_grants or {})
    after: dict[str, bool] = {}
    for grant in payload.grants:
        # None means inherit, which is stored as absence, not as a null — a key
        # mapped to null would have to be special-cased in allows_module, and
        # the one that got missed would be the bug.
        if grant.enabled is not None:
            after[grant.key] = grant.enabled

    if after == before:
        # No write, no audit row. An operator opening the panel and pressing
        # Save without touching anything should not leave a trail suggesting
        # they changed something.
        return _modules_payload(db, org)

    org.module_grants = after
    audit(
        db,
        org_id=org.id,
        actor=None,
        action="platform.company_modules_changed",
        request=request,
        target_type="organization",
        target_id=str(org.id),
        detail={
            "before": before,
            "after": after,
            "granted": sorted(k for k, v in after.items() if v and before.get(k) is not True),
            "revoked": sorted(k for k, v in after.items() if not v and before.get(k) is not False),
            "cleared": sorted(k for k in before if k not in after),
            "by": admin.email,
        },
    )
    db.commit()
    db.refresh(org)
    return _modules_payload(db, org)


@router.get("/modules")
def list_modules(admin: PlatformUser) -> list[dict]:
    """The module registry itself — what the plan editor offers as checkboxes."""
    return module_registry.as_dicts()


class CompanyUpdate(BaseModel):
    """Editable company details.

    Support fixes a misspelled company name, a bounced billing address or a
    GSTIN that arrived after signup. None of it touches the subscription — that
    is the override endpoint, deliberately separate, because "correct the
    spelling of the company" and "give them 40 more seats" should not be the
    same button.
    """

    name: str | None = Field(default=None, min_length=2, max_length=200)
    #: Renaming a workspace changes the subdomain every agent and bookmark
    #: uses, so it is offered but guarded below rather than treated as a
    #: cosmetic field.
    slug: str | None = Field(
        default=None, min_length=2, max_length=63, pattern=r"^[a-z0-9][a-z0-9-]*[a-z0-9]$"
    )
    timezone: str | None = Field(default=None, max_length=64)
    legal_name: str | None = Field(default=None, max_length=250)
    contact_email: EmailStr | None = None
    contact_phone: str | None = Field(default=None, max_length=32)
    address_line1: str | None = Field(default=None, max_length=255)
    address_line2: str | None = Field(default=None, max_length=255)
    city: str | None = Field(default=None, max_length=120)
    state: str | None = Field(default=None, max_length=120)
    postal_code: str | None = Field(default=None, max_length=20)
    country: str | None = Field(default=None, min_length=2, max_length=2)
    gstin: str | None = Field(default=None, max_length=20)
    industry: str | None = Field(default=None, max_length=80)


@router.patch("/companies/{org_id}", response_model=CompanyRow)
def update_company(
    org_id: uuid.UUID,
    payload: CompanyUpdate,
    admin: PlatformWriter,
    request: Request,
    db: DbSession,
) -> CompanyRow:
    org = db.get(Organization, org_id)
    if org is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Company not found")

    changes = payload.model_dump(exclude_unset=True)

    if "slug" in changes and changes["slug"]:
        slug = changes["slug"].strip().lower()
        if slug != org.slug:
            if slug in settings.reserved_slug_set:
                raise HTTPException(
                    status.HTTP_409_CONFLICT, f"'{slug}' is a reserved workspace name"
                )
            taken = db.scalar(
                select(Organization.id).where(
                    Organization.slug == slug, Organization.id != org.id
                )
            )
            if taken is not None:
                raise HTTPException(status.HTTP_409_CONFLICT, f"'{slug}' is already taken")
        changes["slug"] = slug

    if "contact_email" in changes and changes["contact_email"]:
        changes["contact_email"] = str(changes["contact_email"]).lower()
    if "country" in changes and changes["country"]:
        changes["country"] = changes["country"].upper()
    if "name" in changes and changes["name"]:
        changes["name"] = changes["name"].strip()

    for field, value in changes.items():
        setattr(org, field, value)

    audit(db, org_id=org.id, actor=None, action="platform.company_updated", request=request,
          target_type="organization", target_id=str(org.id),
          detail={"by": admin.email, "changes": changes})
    db.commit()
    return _company_row(db, org, {org.id: subs.seats_used(db, org.id)}, _online_counts(db))


class CompanyDelete(BaseModel):
    """Confirmation for a permanent delete.

    The slug has to be typed back. Suspending is one click because it is
    reversible; this is not, and the two live next to each other in the UI.
    """

    confirm_slug: str = Field(min_length=1, max_length=63)
    reason: str | None = Field(default=None, max_length=500)


@router.delete("/companies/{org_id}")
def delete_company(
    org_id: uuid.UUID,
    payload: CompanyDelete,
    admin: PlatformWriter,
    request: Request,
    db: DbSession,
) -> dict:
    """Erase a company and everything belonging to it. Permanent.

    Every tenant table is ``ON DELETE CASCADE`` from ``organizations``, so the
    rows go with one statement. The screenshot *files* do not — they live in
    object storage keyed by id, and a cascade in the database has no idea they
    exist — so they are removed first. Doing it in that order means a failure
    part-way leaves orphaned blobs with rows still pointing at them, which is
    recoverable; the reverse leaves rows pointing at nothing, which is not.

    This is also the one deletion whose audit record must outlive its subject:
    it is written with a NULL org so the cascade cannot take the evidence that
    the company ever existed along with the company.
    """
    org = db.get(Organization, org_id)
    if org is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Company not found")

    if payload.confirm_slug.strip().lower() != org.slug.lower():
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "reason": "confirmation_mismatch",
                "message": f"Type '{org.slug}' exactly to confirm the deletion.",
            },
        )

    name, slug = org.name, org.slug
    seats = subs.seats_used(db, org.id)

    shots = db.execute(
        select(Screenshot.storage_key, Screenshot.thumb_key).where(Screenshot.org_id == org.id)
    ).all()
    files_removed = 0
    for storage_key, thumb_key in shots:
        for key in (storage_key, thumb_key):
            if not key:
                continue
            try:
                storage.delete(key)
                files_removed += 1
            except Exception:  # noqa: BLE001 - a missing blob must not block the delete
                log.warning("could not remove screenshot blob %s for %s", key, slug)

    # A Core DELETE, not db.delete(org). The ORM would walk Organization.users
    # first and, finding no delete cascade on that relationship, try to NULL out
    # a non-nullable users.org_id — an IntegrityError instead of a deletion. The
    # table-level ON DELETE CASCADE that every tenant table already carries is
    # what should do this work, and this is how it gets to.
    db.expunge(org)
    db.execute(Organization.__table__.delete().where(Organization.id == org_id))

    # org_id=None deliberately: an audit row scoped to this organisation would
    # be cascaded away by the very delete it is recording.
    audit(
        db, org_id=None, actor=None, action="platform.company_deleted", request=request,
        target_type="organization", target_id=str(org_id),
        detail={
            "by": admin.email,
            "name": name,
            "slug": slug,
            "employees": seats,
            "screenshot_files_removed": files_removed,
            "reason": payload.reason,
        },
    )
    db.commit()
    return {
        "deleted": str(org_id),
        "name": name,
        "slug": slug,
        "screenshot_files_removed": files_removed,
    }


@router.patch("/companies/{org_id}/subscription", response_model=SubscriptionOut)
def override_subscription(
    org_id: uuid.UUID,
    payload: SubscriptionOverride,
    admin: PlatformWriter,
    request: Request,
    db: DbSession,
) -> Subscription:
    org = db.get(Organization, org_id)
    if org is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Company not found")

    sub = subs.current_subscription(db, org.id)
    if sub is None:
        sub = subs.start_trial(db, org)
        db.flush()

    changes = payload.model_dump(exclude_unset=True)
    if payload.plan_id:
        # Against the catalogue, not a hard-coded list: an operator-defined plan
        # must be selectable here, and a slug that no longer exists must not be
        # settable — plan_for() would resolve it to trial limits without ever
        # saying so.
        plancatalog.ensure_fresh(db)
        target_plan = db.get(PlanRecord, payload.plan_id)
        if target_plan is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={
                    "reason": "unknown_plan",
                    "message": f"No plan with the id '{payload.plan_id}'.",
                },
            )
        sub.plan_id = target_plan.id
    if payload.seats is not None:
        used = subs.seats_used(db, org.id)
        if payload.seats < used:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail={
                    "reason": "seats_below_usage",
                    "message": (
                        f"{used} employees are active; cannot set the limit to "
                        f"{payload.seats}. Deactivate employees first."
                    ),
                },
            )
        sub.seats = payload.seats
    if payload.status:
        sub.status = payload.status
    if payload.extend_days:
        base = sub.period_end or datetime.now(timezone.utc)
        if base.tzinfo is None:
            base = base.replace(tzinfo=timezone.utc)
        sub.period_end = base + timedelta(days=payload.extend_days)
    if payload.notes is not None:
        sub.notes = payload.notes

    # A plan change must actually reduce what is collected, not just relabel it.
    org_settings = db.get(OrgSettings, org.id)
    if org_settings is not None:
        subs.clamp_settings_to_plan(org_settings, plan_for(sub.plan_id))

    audit(db, org_id=org.id, actor=None, action="platform.subscription_override", request=request,
          target_type="subscription", target_id=str(sub.id),
          detail={"changes": changes, "by": admin.email})
    db.commit()
    return sub


def _is_recent(seen, cutoff) -> bool:
    """True when a naive-or-aware timestamp is at or after an aware cutoff."""
    if seen is None:
        return False
    if seen.tzinfo is None:
        seen = seen.replace(tzinfo=timezone.utc)
    return seen >= cutoff


@router.get("/companies/{org_id}/employees")
def company_employees(org_id: uuid.UUID, admin: PlatformUser, db: DbSession) -> list[dict]:
    """Roster only — never activity.

    Support needs to see that an employee exists and whether their agent is
    reporting. It does not need their screenshots, and this endpoint
    deliberately cannot reach them.
    """
    org = db.get(Organization, org_id)
    if org is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Company not found")

    cutoff = datetime.now(timezone.utc) - timedelta(seconds=ONLINE_GRACE_S)
    users = db.scalars(
        select(User).where(User.org_id == org_id).order_by(User.full_name)
    ).all()
    last_seen = {
        row[0]: row[1]
        for row in db.execute(
            select(Device.user_id, func.max(Device.last_seen_at))
            .where(Device.org_id == org_id)
            .group_by(Device.user_id)
        )
    }
    teams = {
        row[0]: row[1]
        for row in db.execute(select(Team.id, Team.name).where(Team.org_id == org_id))
    }
    return [
        {
            "id": str(u.id),
            "full_name": u.full_name,
            "email": u.email,
            "role": u.role,
            "team": teams.get(u.team_id),
            "is_active": u.is_active,
            "last_seen_at": last_seen.get(u.id),
            # SQLite hands these back naive, so the tzinfo has to be re-attached
            # before comparing or the whole page 500s on a bare TypeError.
            "is_online": _is_recent(last_seen.get(u.id), cutoff),
        }
        for u in users
    ]


# --------------------------------------------------------------------------- #
# Platform overview
# --------------------------------------------------------------------------- #


@router.get("/stats", response_model=PlatformStats)
def platform_stats(admin: PlatformUser, db: DbSession) -> PlatformStats:
    orgs = list(db.scalars(select(Organization)).all())
    online = _online_counts(db)

    active = suspended = trialing = revenue = expiring = 0
    now = datetime.now(timezone.utc)
    soon = now + timedelta(days=30)

    for org in orgs:
        ent = subs.entitlement(db, org)
        if org.status == "suspended":
            suspended += 1
        elif ent.status is SubscriptionStatus.TRIALING:
            trialing += 1
        elif ent.status is SubscriptionStatus.ACTIVE:
            active += 1
            revenue += ent.subscription.total_amount if ent.subscription else 0
        if ent.subscription and ent.subscription.period_end:
            end = ent.subscription.period_end
            if end.tzinfo is None:
                end = end.replace(tzinfo=timezone.utc)
            if now <= end <= soon:
                expiring += 1

    return PlatformStats(
        companies_total=len(orgs),
        companies_active=active,
        companies_suspended=suspended,
        companies_trialing=trialing,
        employees_total=int(
            db.scalar(select(func.count(User.id)).where(User.is_active.is_(True))) or 0
        ),
        employees_online=sum(online.values()),
        revenue_active_paise=revenue,
        subscriptions_expiring_30d=expiring,
    )


class PlanWrite(BaseModel):
    """A plan, as an operator defines it.

    Money is in **paise**, matching the rest of the billing code — the form
    converts, so nothing here ever holds rupees and no float ever touches a
    price. See ``app.core.plans``.
    """

    name: str = Field(min_length=2, max_length=80)
    description: str | None = Field(default=None, max_length=2000)
    base_price_annual: int = Field(default=0, ge=0, le=100_000_000_00)
    per_employee_month: int = Field(default=0, ge=0, le=10_000_000)
    min_employees: int = Field(default=1, ge=1, le=100_000)
    max_employees: int = Field(default=100, ge=1, le=1_000_000)
    max_screenshot_retention_days: int = Field(default=30, ge=1, le=3650)
    max_activity_retention_days: int = Field(default=90, ge=1, le=3650)
    min_screenshot_interval_s: int = Field(default=300, ge=30, le=86_400)
    storage_gb: int = Field(default=10, ge=1, le=1_000_000)
    features: list[str] = Field(default_factory=list, max_length=20)
    #: HRMS module keys included in this plan. **Empty = every module**, so a
    #: plan saved without touching this stays unrestricted rather than losing
    #: everything. Distinct from `features`, which is pricing-page copy.
    modules: list[str] = Field(default_factory=list, max_length=20)
    is_active: bool = True
    is_public: bool = True
    sort_order: int = Field(default=100, ge=0, le=10_000)

    @field_validator("features")
    @classmethod
    def _clean_features(cls, value: list[str]) -> list[str]:
        return [line.strip()[:120] for line in value if line.strip()]

    @field_validator("modules")
    @classmethod
    def _known_modules(cls, value):
        """Reject a module key the product does not have.

        A typo here is silent and expensive: "assests" is not in ALL_MODULES, so
        the plan would simply never include Asset Management and the operator
        would see a customer locked out of a module they were sold. Validating
        at the edge is the only cheap place to catch it.
        """
        if value is None:
            return None
        cleaned, unknown = [], []
        for key in value:
            key = key.strip().lower()
            if not key:
                continue
            (cleaned if key in ALL_MODULES else unknown).append(key)
        if unknown:
            raise ValueError(
                f"unknown module(s) {sorted(unknown)}; valid keys are {sorted(ALL_MODULES)}"
            )
        return sorted(set(cleaned))

    @model_validator(mode="after")
    def _range_is_a_range(self) -> "PlanWrite":
        # Caught here rather than at quote time. Plan.quote() clamps a headcount
        # into [min, max], and an inverted pair makes that clamp return the
        # minimum for every headcount — a plan that always bills for one seat.
        if self.max_employees < self.min_employees:
            raise ValueError("max_employees must be at least min_employees")
        return self


class PlanCreate(PlanWrite):
    #: The slug stored on every subscription that buys this plan, so it is
    #: fixed at creation and deliberately not editable afterwards.
    id: str = Field(min_length=2, max_length=32, pattern=r"^[a-z0-9][a-z0-9_-]*[a-z0-9]$")


class PlanUpdate(BaseModel):
    """Partial edit. Only what is sent changes, and ``id`` is never one of them."""

    name: str | None = Field(default=None, min_length=2, max_length=80)
    description: str | None = Field(default=None, max_length=2000)
    base_price_annual: int | None = Field(default=None, ge=0, le=100_000_000_00)
    per_employee_month: int | None = Field(default=None, ge=0, le=10_000_000)
    min_employees: int | None = Field(default=None, ge=1, le=100_000)
    max_employees: int | None = Field(default=None, ge=1, le=1_000_000)
    max_screenshot_retention_days: int | None = Field(default=None, ge=1, le=3650)
    max_activity_retention_days: int | None = Field(default=None, ge=1, le=3650)
    min_screenshot_interval_s: int | None = Field(default=None, ge=30, le=86_400)
    storage_gb: int | None = Field(default=None, ge=1, le=1_000_000)
    features: list[str] | None = Field(default=None, max_length=20)
    modules: list[str] | None = Field(default=None, max_length=20)
    is_active: bool | None = None
    is_public: bool | None = None
    sort_order: int | None = Field(default=None, ge=0, le=10_000)

    @field_validator("features")
    @classmethod
    def _clean_features(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        return [line.strip()[:120] for line in value if line.strip()]

    @field_validator("modules")
    @classmethod
    def _known_modules(cls, value):
        """Reject a module key the product does not have.

        A typo here is silent and expensive: "assests" is not in ALL_MODULES, so
        the plan would simply never include Asset Management and the operator
        would see a customer locked out of a module they were sold. Validating
        at the edge is the only cheap place to catch it.
        """
        if value is None:
            return None
        cleaned, unknown = [], []
        for key in value:
            key = key.strip().lower()
            if not key:
                continue
            (cleaned if key in ALL_MODULES else unknown).append(key)
        if unknown:
            raise ValueError(
                f"unknown module(s) {sorted(unknown)}; valid keys are {sorted(ALL_MODULES)}"
            )
        return sorted(set(cleaned))


def _subscriptions_on(db, plan_id: str) -> int:
    return int(
        db.scalar(select(func.count(Subscription.id)).where(Subscription.plan_id == plan_id)) or 0
    )


def _plan_payload(db, row: PlanRecord) -> dict:
    """The catalogue row, plus the one fact that decides what may be done to it.

    ``subscriptions`` is what makes offering delete safe at all: a plan nothing
    references can go, and a plan something references must not — a subscription
    stores only the slug, so deleting the row it names silently demotes that
    customer to trial limits at the next entitlement check.
    """
    data = plancatalog.as_dict(row)
    data["subscriptions"] = _subscriptions_on(db, row.id)
    return data


@router.get("/plans")
def list_plans(admin: PlatformUser, db: DbSession) -> list[dict]:
    plancatalog.sync_builtins(db)
    plancatalog.refresh(db)
    return [_plan_payload(db, row) for row in plancatalog.list_plans(db)]


@router.post("/plans", status_code=status.HTTP_201_CREATED)
def create_plan(
    payload: PlanCreate, admin: PlatformWriter, request: Request, db: DbSession
) -> dict:
    plan_id = payload.id.strip().lower()
    if db.get(PlanRecord, plan_id) is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "reason": "plan_exists",
                "message": f"A plan with the id '{plan_id}' already exists.",
            },
        )

    data = payload.model_dump(exclude={"id"})
    row = PlanRecord(id=plan_id, is_builtin=False, **data)
    db.add(row)

    audit(db, org_id=None, actor=None, action="platform.plan_created", request=request,
          target_type="plan", target_id=plan_id,
          detail={"by": admin.email, "plan": data})
    db.commit()
    plancatalog.refresh(db)
    return _plan_payload(db, row)


@router.patch("/plans/{plan_id}")
def update_plan(
    plan_id: str, payload: PlanUpdate, admin: PlatformWriter, request: Request, db: DbSession
) -> dict:
    row = db.get(PlanRecord, plan_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Plan not found")

    changes = payload.model_dump(exclude_unset=True)
    for field, value in changes.items():
        setattr(row, field, value)

    # Checked against the merged result rather than the payload: raising
    # min_employees on its own inverts the range just as easily as lowering
    # max_employees does.
    if row.max_employees < row.min_employees:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "reason": "employee_range_inverted",
                "message": "The maximum headcount cannot be below the minimum.",
            },
        )

    # The trial is the fallback every unrecognised plan id resolves to.
    # Deactivating it would point that fallback at something withdrawn.
    if row.id == PlanId.TRIAL.value and not row.is_active:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "reason": "trial_required",
                "message": (
                    "The trial plan cannot be switched off — it is the fallback "
                    "every unrecognised subscription resolves to."
                ),
            },
        )

    audit(db, org_id=None, actor=None, action="platform.plan_updated", request=request,
          target_type="plan", target_id=row.id,
          detail={"by": admin.email, "changes": changes})
    db.commit()
    plancatalog.refresh(db)

    # A limit that just came down has to bite on the companies already on the
    # plan, or a downgrade is only a relabel — the same reason changing one
    # company's plan clamps its settings.
    tightened = _reclamp_orgs_on_plan(db, row.id)
    if tightened:
        db.commit()

    result = _plan_payload(db, row)
    result["organizations_clamped"] = tightened
    return result


def _reclamp_orgs_on_plan(db, plan_id: str) -> int:
    """Re-apply a plan's caps to every company currently on it.

    Returns how many had to be reduced, which the response reports: "saved" and
    "saved, and shortened retention for four companies" are different outcomes,
    and an operator should not have to go and check which one happened.
    """
    plan = plan_for(plan_id)
    changed = 0
    org_ids = [row[0] for row in db.execute(select(Organization.id))]
    for org_id in org_ids:
        sub = subs.current_subscription(db, org_id)
        if sub is None or sub.plan_id != plan_id:
            continue
        org_settings = db.get(OrgSettings, org_id)
        if org_settings is None:
            continue
        if subs.clamp_settings_to_plan(org_settings, plan):
            changed += 1
    return changed


@router.delete("/plans/{plan_id}")
def delete_plan(plan_id: str, admin: PlatformWriter, request: Request, db: DbSession) -> dict:
    row = db.get(PlanRecord, plan_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Plan not found")

    if row.is_builtin:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "reason": "plan_builtin",
                "message": (
                    f"'{row.name}' ships with the product and cannot be deleted. "
                    "Switch it off instead to stop offering it."
                ),
            },
        )

    in_use = _subscriptions_on(db, plan_id)
    if in_use:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "reason": "plan_in_use",
                "subscriptions": in_use,
                "message": (
                    f"{in_use} subscription(s) are on '{row.name}'. Move them to "
                    "another plan first, or switch this one off to stop selling it."
                ),
            },
        )

    name = row.name
    db.delete(row)
    audit(db, org_id=None, actor=None, action="platform.plan_deleted", request=request,
          target_type="plan", target_id=plan_id,
          detail={"by": admin.email, "name": name})
    db.commit()
    plancatalog.refresh(db)
    return {"deleted": plan_id}


# --------------------------------------------------------------------------- #
# Outbound mail connector
# --------------------------------------------------------------------------- #


class MailSettingsIn(BaseModel):
    smtp_host: str = Field(default="", max_length=255)
    smtp_port: int = Field(default=587, ge=1, le=65535)
    smtp_user: str = Field(default="", max_length=255)
    #: Omit to keep the stored password. Send "" to clear it. The current value
    #: is never returned, so the form cannot round-trip it and a screenshot of
    #: this page is not a credential leak.
    smtp_password: str | None = None
    smtp_use_tls: bool = True
    email_from: str = Field(default="", max_length=255)


class MailTestIn(BaseModel):
    to: EmailStr


def _mail_state(db, row) -> dict:
    config = mailconfig.resolve(db)
    return {
        "configured": config.configured,
        "smtp_host": row.smtp_host,
        "smtp_port": row.smtp_port,
        "smtp_user": row.smtp_user,
        "smtp_use_tls": row.smtp_use_tls,
        "email_from": row.email_from,
        # Whether one is stored, never the value. A screenshot of this page is
        # not a credential leak.
        "has_password": bool(row.smtp_password_enc),
        "last_test": {
            "at": row.last_test_at.isoformat() if row.last_test_at else None,
            "to": row.last_test_to,
            "ok": row.last_test_ok,
            "error": row.last_test_error,
        },
    }


@router.get("/mail")
def read_mail_settings(admin: PlatformUser, db: DbSession) -> dict:
    """The connector. One source, this one."""
    return _mail_state(db, mailconfig.get_or_create(db))


@router.put("/mail")
def update_mail_settings(
    payload: MailSettingsIn, admin: PlatformWriter, request: Request, db: DbSession
) -> dict:
    row = mailconfig.get_or_create(db)
    row.smtp_host = payload.smtp_host.strip()
    row.smtp_port = payload.smtp_port
    row.smtp_user = payload.smtp_user.strip()
    row.smtp_use_tls = payload.smtp_use_tls
    row.email_from = payload.email_from.strip()
    if payload.smtp_password is not None:
        row.smtp_password_enc = mailconfig.encrypt(payload.smtp_password)

    audit(
        db, org_id=None, actor=None, action="platform.mail_configured", request=request,
        target_type="mail", target_id="settings",
        # Host and user only. The password is not audit material.
        detail={"host": row.smtp_host, "port": row.smtp_port, "user": row.smtp_user},
    )
    db.commit()
    db.refresh(row)
    return _mail_state(db, row)


@router.post("/mail/test")
def send_test_mail(
    payload: MailTestIn, admin: PlatformWriter, db: DbSession
) -> dict:
    """Prove the connector works, and record that it did.

    The single most useful control on the page: "saved" only means the form
    validated, and the difference between that and "a message arrived" is
    every wrong password, blocked port and rejected sender there is.
    """
    row = mailconfig.get_or_create(db)
    config = mailconfig.resolve(db)
    if not config.configured:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Set an SMTP host and save it before sending a test",
        )

    ok, error = mailconfig.send_test(config, str(payload.to))
    row.last_test_at = datetime.now(timezone.utc)
    row.last_test_to = str(payload.to)
    row.last_test_ok = ok
    row.last_test_error = None if ok else (error or "")[:2000]
    db.commit()
    db.refresh(row)
    return {"ok": ok, "error": row.last_test_error, **_mail_state(db, row)}


# --------------------------------------------------------------------------- #
# Operations
# --------------------------------------------------------------------------- #


@router.get("/health")
def platform_health(admin: PlatformUser, db: DbSession) -> dict:
    """The questions an operator actually has at 9am.

    Not a status page of green dots — every figure here is one somebody has had
    to dig out of the database at least once: is mail going anywhere, is the
    alert runner alive, which agents are stale, who is silently not being
    tracked.
    """
    now = datetime.now(timezone.utc)
    week = now - timedelta(days=7)

    orgs = list(db.scalars(select(Organization)).all())
    own_mail = shared_mail = no_mail = 0
    for org in orgs:
        cfg = mailconfig.resolve(db, org.id)
        if cfg.source == "workspace":
            own_mail += 1
        elif cfg.source == "platform":
            shared_mail += 1
        else:
            no_mail += 1

    delivery = {
        row[0]: int(row[1])
        for row in db.execute(
            select(NotificationLog.status, func.count(NotificationLog.id))
            .where(NotificationLog.created_at >= week)
            .group_by(NotificationLog.status)
        ).all()
    }
    last_alert = db.scalar(select(func.max(NotificationLog.created_at)))

    # Agent estate. A version nobody has upgraded and a device that stopped
    # reporting are the two things that make tracking data quietly wrong.
    versions = [
        {"version": v or "unknown", "devices": int(n)}
        for v, n in db.execute(
            select(Device.agent_version, func.count(Device.id))
            .where(Device.is_active.is_(True))
            .group_by(Device.agent_version)
            .order_by(func.count(Device.id).desc())
        ).all()
    ]
    stale_cutoff = now - timedelta(hours=24)
    devices_total = db.scalar(
        select(func.count(Device.id)).where(Device.is_active.is_(True))
    ) or 0
    devices_stale = db.scalar(
        select(func.count(Device.id)).where(
            Device.is_active.is_(True),
            or_(Device.last_seen_at.is_(None), Device.last_seen_at < stale_cutoff),
        )
    ) or 0

    storage_bytes = int(db.scalar(select(func.coalesce(func.sum(Screenshot.file_size), 0))) or 0)

    return {
        "generated_at": now.isoformat(),
        "mail": {
            "own_connector": own_mail,
            "using_platform": shared_mail,
            "none": no_mail,
            "platform_configured": mailconfig.resolve(db, None).configured,
        },
        "alerts": {
            "sent_7d": delivery.get("sent", 0),
            "failed_7d": delivery.get("failed", 0),
            "logged_7d": delivery.get("logged", 0),
            # The runner is a cron job outside this process. Its last write is
            # the only evidence here that it is still being invoked at all.
            "last_activity_at": last_alert.isoformat() if last_alert else None,
        },
        "agents": {
            "devices_total": int(devices_total),
            "devices_stale_24h": int(devices_stale),
            "versions": versions,
        },
        "storage": {"screenshot_bytes": storage_bytes},
    }


@router.get("/audit")
def platform_audit(
    admin: PlatformUser,
    db: DbSession,
    limit: int = Query(default=100, ge=1, le=500),
    org_id: uuid.UUID | None = None,
    action: str | None = None,
) -> dict:
    """Recent activity across every tenant, plus platform-scope actions.

    The audit table is the product's own accountability surface — it exists so
    the monitoring system is itself auditable. Until now it had no reader.
    """
    stmt = select(AuditLog).order_by(AuditLog.created_at.desc())
    if org_id is not None:
        stmt = stmt.where(AuditLog.org_id == org_id)
    if action:
        stmt = stmt.where(AuditLog.action.ilike(f"%{action}%"))
    rows = list(db.scalars(stmt.limit(limit)).all())

    org_names = {o.id: o.name for o in db.scalars(select(Organization)).all()}
    actor_names = {
        u.id: u.full_name for u in db.scalars(select(User)).all()
    }
    return {
        "items": [
            {
                "at": r.created_at.isoformat(),
                "action": r.action,
                # NULL org is a platform-scope action, not missing data.
                "organization": org_names.get(r.org_id) if r.org_id else "— platform —",
                "actor": actor_names.get(r.actor_user_id) if r.actor_user_id else "system",
                "target_type": r.target_type,
                "target_id": r.target_id,
                "detail": r.detail,
                "ip": r.ip,
            }
            for r in rows
        ]
    }


# --------------------------------------------------------------------------- #
# Provisioning a company by hand
# --------------------------------------------------------------------------- #


class CompanyCreate(BaseModel):
    """Everything needed to stand up a workspace without the signup flow.

    The public signup exists for self-serve customers. This is for the ones who
    arrive by phone, sign a paper contract, or pay by bank transfer — an
    operator should not have to walk them through a checkout that then has to be
    overridden, nor create the row by hand in SQL.
    """

    name: str = Field(min_length=2, max_length=200)
    slug: str = Field(min_length=2, max_length=63, pattern=r"^[a-z0-9][a-z0-9-]*[a-z0-9]$")
    timezone: str = Field(default="Asia/Kolkata", max_length=64)

    owner_name: str = Field(min_length=2, max_length=200)
    owner_email: EmailStr
    #: Omit and one is generated, returned once, and never stored in the clear.
    owner_password: str | None = Field(default=None, min_length=8, max_length=200)

    #: Checked against the catalogue in the handler — see SubscriptionOverride.
    plan_id: str = Field(default="trial", min_length=2, max_length=32)
    seats: int | None = Field(default=None, ge=1, le=100_000)
    #: Days from today. Defaults to the trial length for trials, a year otherwise.
    valid_days: int | None = Field(default=None, ge=1, le=3650)
    notes: str | None = Field(default=None, max_length=2000)
    send_welcome_email: bool = True

    # Optional billing details, so an invoice can be raised without a second
    # round-trip to the customer.
    legal_name: str | None = Field(default=None, max_length=250)
    contact_email: EmailStr | None = None
    contact_phone: str | None = Field(default=None, max_length=32)
    gstin: str | None = Field(default=None, max_length=20)
    city: str | None = Field(default=None, max_length=120)
    country: str = Field(default="IN", min_length=2, max_length=2)


@router.post("/companies", status_code=status.HTTP_201_CREATED)
def create_company(
    payload: CompanyCreate, admin: PlatformWriter, request: Request, db: DbSession
) -> dict:
    slug = payload.slug.strip().lower()
    if slug in settings.reserved_slug_set:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"'{slug}' is a reserved workspace name"
        )
    if db.scalar(select(Organization).where(Organization.slug == slug)) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, f"'{slug}' is already taken")

    owner_email = str(payload.owner_email).lower()
    # Email is unique per organisation, not globally, so this only guards the
    # one being created — the same person may own two workspaces.
    plancatalog.ensure_fresh(db)
    if db.get(PlanRecord, payload.plan_id) is None:
        # plan_for() would answer "trial" here rather than fail, and provisioning
        # a paying customer onto a five-seat trial because of a typo in a plan
        # slug is not a mistake to discover from a support ticket.
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "reason": "unknown_plan",
                "message": f"No plan with the id '{payload.plan_id}'.",
            },
        )
    plan = plan_for(payload.plan_id)
    password = payload.owner_password or generate_password()

    org = Organization(
        name=payload.name.strip(),
        slug=slug,
        timezone=payload.timezone,
        legal_name=payload.legal_name,
        contact_email=str(payload.contact_email).lower() if payload.contact_email else owner_email,
        contact_phone=payload.contact_phone,
        city=payload.city,
        country=payload.country.upper(),
        gstin=payload.gstin,
        status="active",
    )
    db.add(org)
    db.flush()

    db.add(OrgSettings(org_id=org.id))
    seed_default_rules(db, org.id)

    owner = User(
        org_id=org.id,
        email=owner_email,
        full_name=payload.owner_name.strip(),
        role=Role.OWNER.value,
        timezone=payload.timezone,
        password_hash=hash_password(password),
        enrollment_key=generate_enrollment_key(),
        is_active=True,
    )
    db.add(owner)
    db.flush()

    # start_trial then adjust, rather than a second construction path: one place
    # decides what a new subscription looks like, and it is already tested.
    seats = payload.seats or plan.max_employees
    subscription = subs.start_trial(db, org, seats=seats)
    subscription.plan_id = plan.id
    subscription.seats = seats
    if payload.notes:
        subscription.notes = payload.notes
    if payload.plan_id != "trial":
        # Provisioned against a contract, not a card. Active immediately.
        subscription.status = SubscriptionStatus.ACTIVE.value
    days = payload.valid_days or (settings.trial_days if payload.plan_id == "trial" else 365)
    subscription.period_start = datetime.now(timezone.utc)
    subscription.period_end = subscription.period_start + timedelta(days=days)

    org_settings = db.get(OrgSettings, org.id)
    if org_settings is not None:
        subs.clamp_settings_to_plan(org_settings, plan)

    db.flush()
    audit(
        db, org_id=org.id, actor=None, action="platform.company_created", request=request,
        target_type="organization", target_id=str(org.id),
        detail={"by": admin.email, "slug": slug, "plan": plan.id, "seats": seats},
    )
    db.commit()

    login_url = settings.tenant_url(org.slug, "/login")
    emailed = False
    if payload.send_welcome_email:
        # Never blocks provisioning: a mail outage must not leave a half-created
        # company behind. The password is returned either way.
        try:
            emailed = email.send_welcome(
                owner.email, owner.full_name, org.name, login_url, plan.name,
                org_id=org.id,
            )
        except Exception:  # noqa: BLE001
            emailed = False

    return {
        "organization_id": str(org.id),
        "name": org.name,
        "slug": org.slug,
        "login_url": login_url,
        "owner_email": owner.email,
        # Shown once. Not stored in the clear anywhere, so if the operator loses
        # it the owner has to use password reset.
        "owner_password": password,
        "generated_password": payload.owner_password is None,
        "plan": plan.name,
        "seats": seats,
        "status": subscription.status,
        "period_end": subscription.period_end.isoformat() if subscription.period_end else None,
        "welcome_email_sent": emailed,
    }
