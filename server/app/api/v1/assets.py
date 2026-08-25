"""Asset register, custody lifecycle, and the employee's own asset list.

Thin by design: every handler here resolves permissions and hands straight off
to ``app.services.assets``. The custody invariant — ``assets.status`` agreeing
with the ledger — lives entirely in the service, because it must hold no matter
which caller opens an assignment, and onboarding's ``it_setup`` task and
offboarding's ``it_asset_return`` task both call the service directly rather
than coming through this router.

**Two audiences, split at the URL.** Everything under ``/assets`` is the
administrator's register and is gated on ``can_manage_assets``; ``/assets/my``
is the employee's read-only list of what they are currently holding and is
gated on nothing but being logged in. The gate covers the register's *reads*
too, not only its writes: who is holding which machine, and what the company
paid for it, is the same data the flag exists to withhold, and a read-only leak
of it is still a leak. ``deny_unless`` only ever restricts (see the note on the
columns in ``app.models.user``), so this cannot grant anybody anything.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Query, Request, status

from app.api.deps import AdminUser, CurrentUser, DbSession, deny_unless
from app.schemas.assets import (
    AssetAssignmentIn,
    AssetAssignmentOut,
    AssetIn,
    AssetOut,
    AssetReturnIn,
    MyAssetOut,
)
from app.services import assets as svc

router = APIRouter(prefix="/assets", tags=["assets"])

_MANAGE = "manage assets"


# --------------------------------------------------------------------------- #
# Employee-facing
#
# Declared before /{asset_id}. FastAPI matches routes in declaration order, so
# a literal path registered after a UUID path parameter is unreachable: "my"
# would be parsed as an asset id and 422 before this handler was ever
# considered. Keep these two above the register section.
# --------------------------------------------------------------------------- #


@router.get("/my", response_model=list[MyAssetOut])
def my_assets(viewer: CurrentUser, db: DbSession) -> list[MyAssetOut]:
    """What the caller is currently holding.

    Always the caller's own id — never a query parameter. An employee reading
    someone else's asset list is the register endpoint, which is gated.
    """
    return svc.my_assets(db, viewer.org_id, viewer.id)


# --------------------------------------------------------------------------- #
# Register
# --------------------------------------------------------------------------- #


@router.get("", response_model=list[AssetOut])
def list_assets(
    admin: AdminUser,
    db: DbSession,
    status_filter: str | None = Query(default=None, alias="status"),
    category: str | None = None,
    holder_user_id: uuid.UUID | None = None,
) -> list[AssetOut]:
    # Aliased because `status` is also the FastAPI status-code module imported
    # above; same shape projects.py uses for the same collision.
    deny_unless(admin, "can_manage_assets", _MANAGE)
    return svc.list_assets(
        db,
        admin.org_id,
        status_filter=status_filter,
        category=category,
        holder_user_id=holder_user_id,
    )


@router.post("", response_model=AssetOut, status_code=status.HTTP_201_CREATED)
def create_asset(payload: AssetIn, admin: AdminUser, db: DbSession, request: Request) -> AssetOut:
    deny_unless(admin, "can_manage_assets", _MANAGE)
    return svc.create_asset(db, admin.org_id, payload, actor=admin, request=request)


@router.post("/assign", response_model=AssetAssignmentOut, status_code=status.HTTP_201_CREATED)
def assign_asset(
    payload: AssetAssignmentIn, admin: AdminUser, db: DbSession, request: Request
) -> AssetAssignmentOut:
    """Hand an asset to somebody.

    The asset id is in the body rather than the path because this creates a row
    in the ledger, not a sub-resource of the asset, and the same payload is
    what onboarding's ``it_setup`` task builds when it calls the service.
    """
    deny_unless(admin, "can_manage_assets", _MANAGE)
    return svc.assign_asset(db, admin.org_id, payload, actor=admin, request=request)


@router.get("/users/{user_id}/history", response_model=list[AssetAssignmentOut])
def user_history(
    user_id: uuid.UUID, admin: AdminUser, db: DbSession
) -> list[AssetAssignmentOut]:
    deny_unless(admin, "can_manage_assets", _MANAGE)
    return svc.user_history(db, admin.org_id, user_id)


@router.get("/{asset_id}", response_model=AssetOut)
def get_asset(asset_id: uuid.UUID, admin: AdminUser, db: DbSession) -> AssetOut:
    deny_unless(admin, "can_manage_assets", _MANAGE)
    return svc.asset_detail(db, admin.org_id, asset_id)


@router.patch("/{asset_id}", response_model=AssetOut)
def update_asset(
    asset_id: uuid.UUID, payload: AssetIn, admin: AdminUser, db: DbSession, request: Request
) -> AssetOut:
    deny_unless(admin, "can_manage_assets", _MANAGE)
    return svc.update_asset(db, admin.org_id, asset_id, payload, actor=admin, request=request)


@router.delete("/{asset_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_asset(
    asset_id: uuid.UUID, admin: AdminUser, db: DbSession, request: Request
) -> None:
    deny_unless(admin, "can_manage_assets", _MANAGE)
    svc.delete_asset(db, admin.org_id, asset_id, actor=admin, request=request)


# --------------------------------------------------------------------------- #
# Custody
# --------------------------------------------------------------------------- #


@router.post("/{asset_id}/return", response_model=AssetAssignmentOut)
def return_asset(
    asset_id: uuid.UUID,
    payload: AssetReturnIn,
    admin: AdminUser,
    db: DbSession,
    request: Request,
) -> AssetAssignmentOut:
    """Take an asset back.

    Keyed on the asset rather than the assignment id: the person doing this is
    holding a laptop and reading the sticker on it, and requiring them to first
    look up which assignment row is open is asking them to do the query the
    partial unique index already answers.
    """
    deny_unless(admin, "can_manage_assets", _MANAGE)
    return svc.return_asset(db, admin.org_id, asset_id, payload, actor=admin, request=request)


@router.get("/{asset_id}/history", response_model=list[AssetAssignmentOut])
def custody_history(
    asset_id: uuid.UUID, admin: AdminUser, db: DbSession
) -> list[AssetAssignmentOut]:
    deny_unless(admin, "can_manage_assets", _MANAGE)
    return svc.custody_history(db, admin.org_id, asset_id)
