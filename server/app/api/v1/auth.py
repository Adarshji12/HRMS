from __future__ import annotations

import hashlib
import hmac
import uuid

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession, audit
from app.api.tenancy import CurrentTenant
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
    payload: LoginRequest, request: Request, tenant: CurrentTenant, db: DbSession
) -> TokenResponse:
    # Scoped to the tenant, not global. Email is unique per organisation, so a
    # global lookup would return an arbitrary one of several matching accounts
    # and could sign a user in to the wrong company.
    # Keyed on address *and* email, so one office behind a single NAT address
    # cannot lock its own staff out by having several people mistype at once,
    # while a single account still gets the protection.
    bucket = ratelimit.enforce(request, "login", ratelimit.LOGIN, payload.email)

    user = db.scalar(
        select(User).where(User.org_id == tenant.id, User.email == payload.email.strip().lower())
    )

    # One response for unknown account, wrong password and disabled account, so
    # the endpoint cannot be used to enumerate a company's staff.
    if (
        user is None
        or not user.password_hash
        or not user.is_active
        or not verify_password(payload.password, user.password_hash)
    ):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password")

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
        organization=TenantInfo.model_validate(tenant),
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


def _reset_url(request: Request, slug: str, token: str) -> str:
    path = f"/reset-password?token={token}"
    # In development the console often runs on a port other than the
    # configured public one; build the link from the page that asked, but only
    # when it is one of this deployment's own hosts.
    if not settings.is_production:
        origin = request.headers.get("origin") or ""
        host = origin.split("://", 1)[-1].split(":", 1)[0].lower()
        if host == settings.base_domain or host.endswith(f".{settings.base_domain}"):
            return f"{origin.rstrip('/')}{path}"
    return settings.tenant_url(slug, path)


def _user_for_token(db, tenant: Organization, token: str) -> User:
    payload = decode_access_token(token)
    invalid = HTTPException(
        status.HTTP_400_BAD_REQUEST,
        detail={
            "reason": "reset_link_invalid",
            "message": "This reset link has expired or has already been used. Request a new one.",
        },
    )
    if not payload or payload.get("typ") != _RESET_TYP or payload.get("org") != str(tenant.id):
        raise invalid
    try:
        user_id = uuid.UUID(str(payload.get("sub")))
    except ValueError:
        raise invalid from None
    user = db.get(User, user_id)
    if user is None or user.org_id != tenant.id or not user.is_active:
        raise invalid
    if not hmac.compare_digest(str(payload.get("ph", "")), _fingerprint(user)):
        raise invalid
    return user


@router.post("/forgot-password", response_model=ForgotPasswordOut)
def forgot_password(
    payload: ForgotPasswordIn, request: Request, tenant: CurrentTenant, db: DbSession
) -> ForgotPasswordOut:
    """Email a reset link. Answers the same whether or not the address exists.

    A different answer for a known address would turn this into a directory of
    the company's staff, so an unknown or disabled account gets the same
    response as a real one — just no email.
    """
    email = payload.email.strip().lower()
    ratelimit.enforce(request, "reset", ratelimit.RESET, email)

    user = db.scalar(select(User).where(User.org_id == tenant.id, User.email == email))
    if user is None or not user.is_active:
        return ForgotPasswordOut()

    hours = settings.password_reset_ttl_hours
    token = create_access_token(
        str(user.id),
        {"typ": _RESET_TYP, "org": str(tenant.id), "ph": _fingerprint(user)},
        expires_minutes=hours * 60,
    )
    url = _reset_url(request, tenant.slug, token)
    sent = email_svc.send_password_reset(user.email, user.full_name, url, hours, org_id=tenant.id)

    audit(db, org_id=tenant.id, actor=user, action="auth.password_reset_requested",
          request=request, target_type="user", target_id=str(user.id),
          detail={"delivered": sent})
    db.commit()

    return ForgotPasswordOut(dev_reset_url=None if sent or settings.is_production else url)


@router.get("/reset-password", response_model=ResetCheckOut)
def check_reset_link(token: str, tenant: CurrentTenant, db: DbSession) -> ResetCheckOut:
    """Is this link still good? Lets the page say so before anyone types."""
    user = _user_for_token(db, tenant, token)
    return ResetCheckOut(email=user.email, name=user.full_name)


@router.post("/reset-password", response_model=ForgotPasswordOut)
def reset_password(
    payload: ResetPasswordIn, request: Request, tenant: CurrentTenant, db: DbSession
) -> ForgotPasswordOut:
    """Set the new password. The link stops working as soon as this succeeds."""
    ratelimit.enforce(request, "reset-confirm", ratelimit.RESET)
    user = _user_for_token(db, tenant, payload.token)
    user.password_hash = hash_password(payload.password)
    audit(db, org_id=tenant.id, actor=user, action="auth.password_reset",
          request=request, target_type="user", target_id=str(user.id))
    db.commit()
    return ForgotPasswordOut()
