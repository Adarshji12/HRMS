from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Annotated, Any

from fastapi import Depends, Header, HTTPException, Request, status
from starlette.requests import HTTPConnection
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.tenancy import CurrentTenant, OptionalTenant
from app.core.security import decode_access_token, token_digest
from app.db.session import get_db
from app.models import AuditLog, Device, Organization, OrgSettings, PlatformAdmin, Role, User

DbSession = Annotated[Session, Depends(get_db)]

_UNAUTH = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Not authenticated",
    headers={"WWW-Authenticate": "Bearer"},
)


def _bearer(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise _UNAUTH
    return authorization.split(" ", 1)[1].strip()


def get_current_user(
    db: DbSession,
    tenant: CurrentTenant,
    authorization: Annotated[str | None, Header()] = None,
) -> User:
    payload = decode_access_token(_bearer(authorization))
    if not payload or payload.get("typ") != "user":
        raise _UNAUTH
    try:
        user_id = uuid.UUID(payload["sub"])
    except (KeyError, ValueError):
        raise _UNAUTH from None

    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise _UNAUTH

    # A token minted for one tenant must not work on another's subdomain, even
    # though every query below also filters on org_id. Two independent checks,
    # because a single missed filter in one handler would otherwise be a
    # cross-tenant data leak.
    if user.org_id != tenant.id:
        raise _UNAUTH
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


def require_team_viewer(user: CurrentUser) -> User:
    """Sees somebody other than themselves.

    Reads the data scope rather than the role level. Identical outcome for the
    four built-in roles — manager is `team`, administrator is `company`,
    employee is `self` — but it also admits a named role that sees widely
    without managing anybody, which is the whole reason scope became a field.
    """
    if not user.sees_others:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient role")
    return user


#: The pages that can be switched off per person, and the label used when one
#: is refused. A page only belongs here when its data endpoints are its own —
#: gating a shared endpoint would break whichever other page also reads it.
PAGE_GUARDS = {
    "activity": "open Time & Activity",
    "apps": "open Apps & Websites",
    "timesheets": "open Timesheets",
    "projects": "open Projects",
    "reports": "open Reports",
    "hierarchy": "open the reporting hierarchy",
    # `leave.py` has always called deny_page("leave"); the key was missing here,
    # so the guard worked and the sentence did not — a refused employee was told
    # "Your account is not permitted to leave." The fallback renders the raw key,
    # which is fine for a debug log and not for a person.
    "leave": "open Leave",
}

# Attendance, Helpdesk, Assets and Onboarding deliberately have NO entry, and no
# `page:` key in the console nav either.
#
# Per-employee page hiding is the wrong tool for them. Those four are
# self-service: hiding Attendance from someone stops them punching in, and
# hiding Onboarding stops a new hire completing their own checklist — so the
# guard would not restrict a view, it would break the employee's ability to do
# their job. The org-level question ("this company did not buy Assets") is
# already answered by plan gating in `require_module`, which is a different
# mechanism for a different question.
#
# The rule that keeps this honest is in nav.tsx: a `page:` key with no guard
# behind it hides the link and leaves the data reachable, which is decoration
# rather than a permission. Better to have neither than half of one.


def deny_page(user: User, page: str) -> None:
    """Refuse a page this person has been switched out of.

    Enforced here rather than only hiding the nav link: a hidden link with a
    live endpoint behind it is decoration, and anyone who kept a bookmark walks
    straight past it.
    """
    hidden = user.hidden_pages or []
    if page in hidden:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail={
                "reason": "page_hidden",
                "message": f"Your account is not permitted to {PAGE_GUARDS.get(page, page)}.",
            },
        )


def deny_unless(user: User, flag: str, what: str) -> None:
    """Refuse when a permission is switched off.

    These flags only ever restrict — the role check has already run by the time
    this is called, so an employee cannot reach someone else's data by having a
    flag left on.

    Reads through :meth:`User.has`, not ``getattr``. That is the whole seam
    between named roles and the forty-four places that ask this question: the
    ``users`` columns stopped being the truth for anybody holding a role, and
    changing it here meant not changing it in forty-four handlers.
    """
    if not user.has(flag):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail={
                "reason": "permission_denied",
                "message": f"Your account is not permitted to {what}.",
            },
        )


def require_approver(user: TeamViewer) -> User:
    """Sees the team AND may sign off their hours.

    Two different things: a team lead who reviews workload is not automatically
    the person who approves what payroll pays out.
    """
    deny_unless(user, "can_approve_timesheets", "approve timesheets")
    return user


def require_exporter(user: CurrentUser) -> User:
    deny_unless(user, "can_export_data", "export data")
    return user


Approver = Annotated[User, Depends(require_approver)]
Exporter = Annotated[User, Depends(require_exporter)]


def require_owner(user: CurrentUser) -> User:
    """Stricter than require_admin: the owner, and nobody else.

    Reserved for things that are the account holder's alone rather than the
    administrators' — the outbound mail connector is the first, because it
    carries the company's own domain and a third-party SMTP credential, and
    "who may send mail as us" is not the same question as "who may change the
    screenshot interval".
    """
    if user.role_enum is not Role.OWNER:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the workspace owner can do this")
    return user


def require_admin(user: CurrentUser) -> User:
    if not user.role_enum.can_administer:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Administrator role required")
    return user


TeamViewer = Annotated[User, Depends(require_team_viewer)]
AdminUser = Annotated[User, Depends(require_admin)]
OwnerUser = Annotated[User, Depends(require_owner)]


def get_current_device(
    db: DbSession,
    tenant: OptionalTenant,
    authorization: Annotated[str | None, Header()] = None,
) -> Device:
    token = _bearer(authorization)
    device = db.scalar(select(Device).where(Device.token_hash == token_digest(token)))
    if device is None:
        raise _UNAUTH
    if not device.is_active:
        # 403 rather than 401: the credential is valid but the device was
        # revoked, and the agent must stop instead of retrying enrolment.
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Device revoked")
    # The device token already names its organisation, so a tenant host is not
    # required. If one is present it must agree — a mismatch means the agent is
    # pointed at the wrong tenant URL and should be told, not silently accepted.
    if tenant is not None and device.org_id != tenant.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Device belongs to another organisation")
    return device


CurrentDevice = Annotated[Device, Depends(get_current_device)]


def get_platform_admin(
    db: DbSession, authorization: Annotated[str | None, Header()] = None
) -> PlatformAdmin:
    """Super Admin authentication.

    Note there is no tenant dependency: platform operators exist outside every
    organisation. The ``typ`` claim is checked so a company user's token can
    never be replayed against a platform endpoint.
    """
    payload = decode_access_token(_bearer(authorization))
    if not payload or payload.get("typ") != "platform":
        raise _UNAUTH
    try:
        admin_id = uuid.UUID(payload["sub"])
    except (KeyError, ValueError):
        raise _UNAUTH from None

    admin = db.get(PlatformAdmin, admin_id)
    if admin is None or not admin.is_active:
        raise _UNAUTH
    return admin


PlatformUser = Annotated[PlatformAdmin, Depends(get_platform_admin)]


def require_platform_writer(admin: PlatformUser) -> PlatformAdmin:
    """Blocks every write while the bootstrap password is still in place.

    Read access is deliberately allowed so an operator can look around before
    changing it, but nothing can be modified from the credentials printed in
    the setup instructions.
    """
    if admin.must_change_password:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail={
                "reason": "password_change_required",
                "message": "Change the bootstrap password before making changes.",
            },
        )
    return admin


PlatformWriter = Annotated[PlatformAdmin, Depends(require_platform_writer)]


def get_org_settings(db: Session, org_id: uuid.UUID) -> OrgSettings:
    settings = db.get(OrgSettings, org_id)
    if settings is None:
        settings = OrgSettings(org_id=org_id)
        db.add(settings)
        db.flush()
    return settings


def jsonable(value: Any) -> Any:
    """Coerce a value into something ``json.dumps`` accepts.

    ``AuditLog.detail`` is a JSON column, and callers naturally hand it the dict
    a Pydantic ``model_dump()`` produced — which keeps UUIDs, dates and enums as
    Python objects. The default JSON encoder refuses those, so the failure did
    not surface as a bad audit row: it surfaced as a 500 on the *request*, at
    flush time, after the real change had already been made in the session.
    Editing an employee's team or manager hit it every single time.

    Coercing here rather than at each call site means no future endpoint can
    reintroduce it by passing the obvious thing.
    """
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, Enum):
        return jsonable(value.value)
    if isinstance(value, (uuid.UUID, Decimal)):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [jsonable(v) for v in value]
    return str(value)


def audit(
    db: Session,
    *,
    org_id: uuid.UUID | None,
    actor: User | None,
    action: str,
    request: Request | None = None,
    target_type: str | None = None,
    target_id: str | None = None,
    detail: dict | None = None,
) -> None:
    db.add(
        AuditLog(
            org_id=org_id,
            actor_user_id=actor.id if actor else None,
            action=action,
            target_type=target_type,
            target_id=target_id,
            detail=jsonable(detail),
            ip=request.client.host if request and request.client else None,
        )
    )


def visible_user_ids(db: Session, viewer: User) -> list[uuid.UUID] | None:
    """``None`` means "the whole organisation" — no filter needed.

    Delegates to the hierarchy service so scoping is defined in exactly one
    place: a manager sees their reporting subtree plus any team or department
    they head. See ``app.services.hierarchy`` for why the old same-team-name
    rule was wrong in both directions.
    """
    from app.services.hierarchy import visible_user_ids as resolve

    return resolve(db, viewer)


def require_module(key: str):
    """Refuse a whole HRMS module the company's plan does not include.

    Returned as a dependency and attached at ``include_router`` time in
    ``api/v1/router.py`` rather than added to each handler. That is the point:
    one line per module, in the file the lead owns, and no module author can
    forget the check or apply it to five of their six routes. It also keeps the
    gate out of the seven service modules entirely, so gating stays a
    subscription concern rather than leaking into domain code.

    Ordering matters. This resolves the tenant and reads the subscription; it
    deliberately does NOT authenticate, because authentication already happens in
    each route's own dependencies and duplicating it here would double every
    query. A caller with no valid token still gets 401 from the route itself.
    """

    def _guard(db: DbSession, tenant: CurrentTenant) -> None:
        from app.services import subscriptions as subs

        if not subs.entitlement(db, tenant).allows_module(key):
            raise HTTPException(
                status.HTTP_402_PAYMENT_REQUIRED,
                detail={
                    "reason": "module_not_in_plan",
                    "module": key,
                    "message": (
                        f"The {key} module is not included in this workspace's plan. "
                        "An administrator can upgrade from Billing."
                    ),
                },
            )

    return _guard


_READS = frozenset({"GET", "HEAD", "OPTIONS"})


def enforce_menu_rights(
    connection: HTTPConnection,
    db: DbSession,
    authorization: Annotated[str | None, Header()] = None,
) -> None:
    """Refuse a write the caller's role does not allow on that menu.

    Runs on every API request, before the handler. It only ever refuses; it
    never authenticates — a request with no user token passes through untouched
    and meets the handler's own auth, so login, signup, the agent and the
    platform console are unaffected.

    Nothing is checked for the owner, for a person with no named role, for a
    role never restricted by menu (``menu_rights`` is None), or for a path that
    belongs to no menu. Reads are not checked here; see ``core.menus``.
    """
    from app.core.menus import action_for, menu_for_write

    # A WebSocket (the chat socket) has no method and is not a write; this
    # dependency sees it because it is attached to every route.
    method = getattr(connection, "method", None)
    if method is None or method.upper() in _READS:
        return
    path = connection.url.path
    if path.startswith("/api/v1"):
        path = path[len("/api/v1"):]
    match = menu_for_write(path)
    if match is None:
        return
    if not authorization or not authorization.lower().startswith("bearer "):
        return
    payload = decode_access_token(authorization.split(" ", 1)[1].strip())
    if not payload or payload.get("typ") != "user":
        return
    try:
        user = db.get(User, uuid.UUID(payload["sub"]))
    except (KeyError, ValueError):
        return
    # The tenant is not re-checked here: get_current_user does that in the
    # handler, and this can only refuse, never let anything through.
    if user is None:
        return
    role = user.org_role
    if role is None or role.menu_rights is None or user.role_enum == Role.OWNER:
        return

    menu, remainder = match
    action = action_for(method, remainder)
    if action is None:
        return
    row = role.menu_rights.get(menu.key) or {}
    if not row.get("access"):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            f"Your role ({role.name}) does not have access to {menu.label}.",
        )
    if not row.get(action):
        verb = {"add": "add new entries", "edit": "make changes", "delete": "delete entries"}[action]
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            f"Your role ({role.name}) cannot {verb} in {menu.label}.",
        )
