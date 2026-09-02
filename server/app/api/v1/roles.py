"""Named roles: list, create, edit, delete.

Administrators only, throughout. A role *is* the permission model, so anybody
who can edit one can grant themselves anything — there is no useful read-only
audience for this router below the administrator line.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Request, status
from pydantic import BaseModel, Field

from app.api.deps import AdminUser, DbSession, audit
from app.models import PERMISSION_KEYS
from app.schemas.common import ORMModel
from app.services import roles as svc

router = APIRouter(prefix="/roles", tags=["roles"])

_BASE_ROLE_PATTERN = r"^(owner|admin|manager|employee)$"
_SCOPE_PATTERN = r"^(self|team|department|company)$"


class RoleIn(BaseModel):
    """Create body. PATCH semantics on update — None means "leave unchanged"."""

    name: str | None = Field(default=None, max_length=80)
    description: str | None = Field(default=None, max_length=300)
    base_role: str | None = Field(default=None, pattern=_BASE_ROLE_PATTERN)
    data_scope: str | None = Field(default=None, pattern=_SCOPE_PATTERN)
    #: Only the true entries need sending; the service drops the rest. See
    #: ``services.roles.clean_permissions`` for why absent means off.
    permissions: dict[str, bool] | None = None


class RoleOut(ORMModel):
    id: uuid.UUID
    name: str
    description: str | None = None
    base_role: str
    data_scope: str
    permissions: dict[str, bool]
    is_builtin: bool
    #: How many people hold it. Shown beside the save button, because editing a
    #: role changes what all of them can do the moment it is saved.
    member_count: int = 0


class PermissionOut(BaseModel):
    """The catalogue the console renders its tick list from.

    Served rather than hardcoded in the frontend so a permission added to the
    product appears on the roles screen without a second deploy.
    """

    key: str


def _out(role, counts: dict[uuid.UUID, int]) -> RoleOut:
    return RoleOut(
        id=role.id,
        name=role.name,
        description=role.description,
        base_role=role.base_role,
        data_scope=role.data_scope,
        permissions={key: bool(role.permissions.get(key)) for key in PERMISSION_KEYS},
        is_builtin=role.is_builtin,
        member_count=counts.get(role.id, 0),
    )


@router.get("", response_model=list[RoleOut])
def list_roles(admin: AdminUser, db: DbSession) -> list[RoleOut]:
    """Every role in this company, seeding the built-ins on first look.

    The seed happens here rather than at signup so a workspace created before
    named roles existed gets them the first time somebody opens the screen.
    """
    rows = svc.ensure_builtins(db, admin.org_id)
    counts = svc.member_counts(db, admin.org_id)
    db.commit()
    return [_out(row, counts) for row in rows]


@router.get("/permissions", response_model=list[str])
def list_permissions(admin: AdminUser) -> list[str]:
    """Every permission key a role can carry, in console order."""
    return list(PERMISSION_KEYS)


@router.post("", response_model=RoleOut, status_code=status.HTTP_201_CREATED)
def create_role(payload: RoleIn, admin: AdminUser, request: Request, db: DbSession) -> RoleOut:
    row = svc.create_role(
        db, admin.org_id,
        name=payload.name or "",
        description=payload.description,
        base_role=payload.base_role or "employee",
        data_scope=payload.data_scope or "self",
        permissions=payload.permissions,
    )
    audit(db, org_id=admin.org_id, actor=admin, action="role.created", request=request,
          target_type="org_role", target_id=str(row.id),
          detail={"name": row.name, "base_role": row.base_role,
                  "data_scope": row.data_scope, "permissions": row.permissions})
    db.commit()
    return _out(row, svc.member_counts(db, admin.org_id))


@router.patch("/{role_id}", response_model=RoleOut)
def update_role(role_id: uuid.UUID, payload: RoleIn, admin: AdminUser,
                request: Request, db: DbSession) -> RoleOut:
    """Edit a role. Everybody holding it is affected immediately."""
    row = svc.update_role(
        db, admin.org_id, role_id,
        name=payload.name,
        description=payload.description,
        base_role=payload.base_role,
        data_scope=payload.data_scope,
        permissions=payload.permissions,
    )
    counts = svc.member_counts(db, admin.org_id)
    audit(db, org_id=admin.org_id, actor=admin, action="role.updated", request=request,
          target_type="org_role", target_id=str(row.id),
          # The member count is in the audit line because it is what makes the
          # change consequential — "granted payroll to a role" and "granted
          # payroll to fourteen people" are different events.
          detail={"name": row.name, "base_role": row.base_role,
                  "data_scope": row.data_scope, "permissions": row.permissions,
                  "members_affected": counts.get(row.id, 0)})
    db.commit()
    return _out(row, counts)


@router.delete("/{role_id}", status_code=status.HTTP_200_OK)
def delete_role(role_id: uuid.UUID, admin: AdminUser, request: Request, db: DbSession) -> dict:
    """Delete a custom role. Its holders fall back to their own permissions."""
    row = svc.get_role(db, admin.org_id, role_id)
    name = row.name
    held = svc.delete_role(db, admin.org_id, role_id)
    audit(db, org_id=admin.org_id, actor=admin, action="role.deleted", request=request,
          target_type="org_role", target_id=str(role_id),
          detail={"name": name, "members_released": held})
    db.commit()
    return {"released": held}
