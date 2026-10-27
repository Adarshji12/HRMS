from __future__ import annotations

import hashlib
import hmac
import uuid

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession, audit
from app.api.tenancy import CurrentTenant, OptionalTenant
from app.core.config import settings
from app.core import ratelimit
from app.core.security import create_access_token, decode_access_token, hash_password, verify_password
from app.models import Organization, User
from app.schemas.common import LoginRequest, TenantInfo, TokenResponse, UserOut
from app.services import email as email_svc

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/tenant", response_model=TenantInfo)
def tenant_info(tenant: CurrentTenant) -> Organization:
    """Public: lets the sign-in page name the organisation it belongs to.

    Exposes only the display name and slug — never member counts, plan or
    anything else that would make the endpoint useful for reconnaissance.
    """
    return tenant


@router.post("/login", response_model=TokenResponse)
def login(
    payload: LoginRequest, request: Request, tenant: OptionalTenant, db: DbSession
) -> TokenResponse:
    # Keyed on address *and* email, so one office behind a single NAT address
    # cannot lock its own staff out by having several people mistype at once,
    # while a single account still gets the protection.
    bucket = ratelimit.enforce(request, "login", ratelimit.LOGIN, payload.email)
    email = payload.email.strip().lower()

    # Email is unique per organisation, not globally. On a tenant host the
    # lookup stays scoped to it. Without one (a host with no subdomain) every
    # account with this email is tried, and only those whose password matches
    # count — so the answer can never sign anyone in to the wrong company.
    query = select(User).where(User.email == email)
    if tenant is not None:
        query = query.where(User.org_id == tenant.id)
    matches = [
        user
        for user in db.scalars(query)
        if user.password_hash
        and user.is_active
        and verify_password(payload.password, user.password_hash)
    ]

    # One response for unknown account, wrong password and disabled account, so
    # the endpoint cannot be used to enumerate a company's staff.
    if not matches:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password")

    if len(matches) > 1:
        # The password is right for several companies. Naming them leaks
        # nothing: the caller has just proved they hold each of these accounts.
        orgs = db.scalars(
            select(Organization)
            .where(Organization.id.in_([user.org_id for user in matches]))
            .order_by(Organization.name)
        )
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "reason": "choose_workspace",
                "message": "This account belongs to more than one company. Choose one.",
                "workspaces": [{"slug": org.slug, "name": org.name} for org in orgs],
            },
        )

    user = matches[0]
    org = tenant or db.get(Organization, user.org_id)

    # Cleared on success: someone who mistyped twice before getting it right
    # should not still be counting against the limit afterwards.
    ratelimit.limiter.reset(bucket)

    audit(db, org_id=user.org_id, actor=user, action="auth.login", request=request)
    db.commit()

    return TokenResponse(
        access_token=create_access_token(
            str(user.id), {"typ": "user", "org": str(user.org_id), "role": user.role}
        ),
        expires_in=settings.access_token_expire_minutes * 60,
        organization=TenantInfo.model_validate(org),
    )


@router.get("/me", response_model=UserOut)
def me(user: CurrentUser) -> User:
    return user


# --------------------------------------------------------------------------- #
# Password reset
# --------------------------------------------------------------------------- #
#
# Stateless: the link carries a signed token rather than a row in a table. It
# names the user and the organisation, expires after
# ``settings.password_reset_ttl_hours``, and carries a fingerprint of the
# password hash it was issued against — so the moment the password changes,
# every link issued before it stops working. That is what makes a link
# single-use without anything to store or sweep.
#
# The token's ``typ`` is "pwreset". Every session check requires ``typ ==
# "user"``, so a reset link can never be replayed as a sign-in.

_RESET_TYP = "pwreset"


class ForgotPasswordIn(BaseModel):
    email: str = Field(min_length=3, max_length=255)


class ForgotPasswordOut(BaseModel):
    ok: bool = True
    #: Development only, and only when the mail could not be sent: the link
    #: itself, so the flow can be exercised without an SMTP connector. Never
    #: populated in production, where it would hand the reset to whoever asked.
    dev_reset_url: str | None = None


class ResetCheckOut(BaseModel):
    email: str
    name: str


class ResetPasswordIn(BaseModel):
    token: str = Field(min_length=10, max_length=4000)
    password: str = Field(min_length=8, max_length=200)


def _fingerprint(user: User) -> str:
    seed = f"{user.id}:{user.password_hash or '-'}"
    return hashlib.sha256(seed.encode()).hexdigest()[:24]


def _reset_url(request: Request, slug: str | None, token: str) -> str:
    path = f"/reset-password?token={token}"
    # In development the console often runs on a port other than the
    # configured public one; build the link from the page that asked, but only
    # when it is one of this deployment's own hosts.
    if not settings.is_production:
        origin = request.headers.get("origin") or ""
        host = origin.split("://", 1)[-1].split(":", 1)[0].lower()
        if host == settings.base_domain or host.endswith(f".{settings.base_domain}"):
            return f"{origin.rstrip('/')}{path}"
    if slug is None:
        # Asked from a host with no subdomain: the link goes back there, and the
        # token itself names the company.
        port = f":{settings.public_port}" if settings.public_port else ""
        return f"{settings.public_scheme}://{settings.base_domain}{port}{path}"
    return settings.tenant_url(slug, path)


def _user_for_token(db, tenant: Organization | None, token: str) -> User:
    payload = decode_access_token(token)
    invalid = HTTPException(
        status.HTTP_400_BAD_REQUEST,
        detail={
            "reason": "reset_link_invalid",
            "message": "This reset link has expired or has already been used. Request a new one.",
        },
    )
    if not payload or payload.get("typ") != _RESET_TYP:
        raise invalid
    # On a tenant host the link must be that tenant's; elsewhere the signed
    # token's own org claim decides.
    if tenant is not None and payload.get("org") != str(tenant.id):
        raise invalid
    try:
        user_id = uuid.UUID(str(payload.get("sub")))
    except ValueError:
        raise invalid from None
    user = db.get(User, user_id)
    if user is None or str(user.org_id) != payload.get("org") or not user.is_active:
        raise invalid
    if not hmac.compare_digest(str(payload.get("ph", "")), _fingerprint(user)):
        raise invalid
    return user


@router.post("/forgot-password", response_model=ForgotPasswordOut)
def forgot_password(
    payload: ForgotPasswordIn, request: Request, tenant: OptionalTenant, db: DbSession
) -> ForgotPasswordOut:
    """Email a reset link. Answers the same whether or not the address exists.

    A different answer for a known address would turn this into a directory of
    the company's staff, so an unknown or disabled account gets the same
    response as a real one — just no email. Without a tenant host, every
    company account on this address gets its own link.
    """
    email = payload.email.strip().lower()
    ratelimit.enforce(request, "reset", ratelimit.RESET, email)

    query = select(User).where(User.email == email, User.is_active.is_(True))
    if tenant is not None:
        query = query.where(User.org_id == tenant.id)

    hours = settings.password_reset_ttl_hours
    dev_url: str | None = None
    for user in db.scalars(query).all():
        token = create_access_token(
            str(user.id),
            {"typ": _RESET_TYP, "org": str(user.org_id), "ph": _fingerprint(user)},
            expires_minutes=hours * 60,
        )
        url = _reset_url(request, tenant.slug if tenant else None, token)
        sent = email_svc.send_password_reset(user.email, user.full_name, url, hours, org_id=user.org_id)
        audit(db, org_id=user.org_id, actor=user, action="auth.password_reset_requested",
              request=request, target_type="user", target_id=str(user.id),
              detail={"delivered": sent})
        if not sent and dev_url is None:
            dev_url = url
    db.commit()

    return ForgotPasswordOut(dev_reset_url=None if settings.is_production else dev_url)


@router.get("/reset-password", response_model=ResetCheckOut)
def check_reset_link(token: str, tenant: OptionalTenant, db: DbSession) -> ResetCheckOut:
    """Is this link still good? Lets the page say so before anyone types."""
    user = _user_for_token(db, tenant, token)
    return ResetCheckOut(email=user.email, name=user.full_name)


@router.post("/reset-password", response_model=ForgotPasswordOut)
def reset_password(
    payload: ResetPasswordIn, request: Request, tenant: OptionalTenant, db: DbSession
) -> ForgotPasswordOut:
    """Set the new password. The link stops working as soon as this succeeds."""
    ratelimit.enforce(request, "reset-confirm", ratelimit.RESET)
    user = _user_for_token(db, tenant, payload.token)
    user.password_hash = hash_password(payload.password)
    audit(db, org_id=user.org_id, actor=user, action="auth.password_reset",
          request=request, target_type="user", target_id=str(user.id))
    db.commit()
    return ForgotPasswordOut()
