from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession, audit
from app.api.tenancy import CurrentTenant
from app.core.config import settings
from app.core import ratelimit
from app.core.security import create_access_token, verify_password
from app.models import Organization, User
from app.schemas.common import LoginRequest, TenantInfo, TokenResponse, UserOut

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
