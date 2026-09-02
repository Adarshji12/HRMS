"""Named roles: seeding the built-ins, and the rules for editing them.

The four built-ins exist so a company has somewhere to put people on day one
without designing a permission model first. They mirror what the four hardcoded
levels used to grant, so a workspace that never opens the roles screen behaves
exactly as it did.

They are seeded lazily rather than in the migration. A permission added to the
product in six months has to reach tenants that migrated today, and the default
map lives here — duplicating it into a migration would guarantee the two drift.
"""

from __future__ import annotations

import uuid

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import DataScope, OrgRole, PERMISSION_KEYS, Role, User


def _refuse(code: str, message: str, http: int = status.HTTP_409_CONFLICT) -> HTTPException:
    return HTTPException(http, detail={"reason": code, "message": message})


#: The four roles every company starts with.
#:
#: The permission sets reproduce what each hardcoded level granted before roles
#: existed, which is the only defensible starting point: anything else would
#: silently change what people could do on the day this shipped.
#:
#: Owner carries no explicit permissions on purpose — ``require_owner`` and the
#: ``can_administer`` checks answer for them, and listing nineteen ticks against
#: a role nobody can edit would imply they could be untucked.
BUILTINS: tuple[dict, ...] = (
    {
        "name": "Owner",
        "description": "The account holder. Everything, including the things administrators cannot do — outbound mail, and the billing relationship.",
        "base_role": Role.OWNER.value,
        "data_scope": DataScope.COMPANY.value,
        "permissions": {key: True for key in PERMISSION_KEYS},
    },
    {
        "name": "Administrator",
        "description": "Runs the workspace day to day. Everything except the owner-only settings. Salaries stay off until granted — see and set salaries is the one permission that never comes free with a role.",
        "base_role": Role.ADMIN.value,
        "data_scope": DataScope.COMPANY.value,
        "permissions": {
            key: key != "can_manage_payroll" for key in PERMISSION_KEYS
        },
    },
    {
        "name": "Manager",
        "description": "Sees their own reporting line and approves what it sends them. No access to company-wide administration.",
        "base_role": Role.MANAGER.value,
        "data_scope": DataScope.TEAM.value,
        "permissions": {
            "can_view_screenshots": True,
            "can_approve_timesheets": True,
            "can_export_data": True,
            "can_manage_projects": True,
            "can_approve_leave": True,
            "can_approve_regularization": True,
            "can_approve_expenses": True,
        },
    },
    {
        "name": "Employee",
        "description": "Their own record and their own requests. The default for a new hire.",
        "base_role": Role.EMPLOYEE.value,
        "data_scope": DataScope.SELF.value,
        "permissions": {},
    },
)


def ensure_builtins(db: Session, org_id: uuid.UUID) -> list[OrgRole]:
    """Create any built-in role this organisation is missing, and return them all.

    Idempotent and safe to call on every list. Matched on name rather than a
    stored key because the names are the identity here — a company that renames
    "Manager" has made a different role, and re-seeding one beside it is the
    honest outcome rather than silently renaming theirs back.
    """
    existing = {
        row.name: row
        for row in db.scalars(select(OrgRole).where(OrgRole.org_id == org_id))
    }
    made = False
    for spec in BUILTINS:
        if spec["name"] in existing:
            continue
        row = OrgRole(org_id=org_id, is_builtin=True, **spec)
        db.add(row)
        existing[spec["name"]] = row
        made = True
    if made:
        db.flush()
    return list_roles(db, org_id)


def list_roles(db: Session, org_id: uuid.UUID) -> list[OrgRole]:
    """Built-ins first in their declared order, then custom roles by name."""
    order = {spec["name"]: index for index, spec in enumerate(BUILTINS)}
    rows = list(db.scalars(select(OrgRole).where(OrgRole.org_id == org_id)))
    return sorted(
        rows,
        key=lambda r: (0, order[r.name]) if r.is_builtin and r.name in order else (1, r.name.lower()),
    )


def member_counts(db: Session, org_id: uuid.UUID) -> dict[uuid.UUID, int]:
    """How many people hold each role — the number the console shows beside it.

    Worth surfacing: editing a role changes what those people can do
    immediately, and an administrator about to untick "approve leave" should see
    that fourteen people are on the other side of it.
    """
    return {
        row[0]: int(row[1])
        for row in db.execute(
            select(User.role_id, func.count(User.id))
            .where(User.org_id == org_id, User.role_id.is_not(None))
            .group_by(User.role_id)
        )
    }


def get_role(db: Session, org_id: uuid.UUID, role_id: uuid.UUID) -> OrgRole:
    row = db.get(OrgRole, role_id)
    if row is None or row.org_id != org_id:
        raise _refuse("not_found", "No such role.", status.HTTP_404_NOT_FOUND)
    return row


def clean_permissions(raw: dict | None) -> dict:
    """Keep only keys the product actually has, and only the true ones.

    Dropping the false entries is deliberate. Absent and false mean the same
    thing to :meth:`OrgRole.allows`, so storing only what is switched on means a
    permission added to the product later defaults to OFF for every role that
    predates it. That is the safe direction; the alternative silently grants new
    capabilities to roles nobody has reviewed.
    """
    return {key: True for key in PERMISSION_KEYS if (raw or {}).get(key)}


def create_role(db: Session, org_id: uuid.UUID, *, name: str, description: str | None,
                base_role: str, data_scope: str, permissions: dict | None) -> OrgRole:
    name = name.strip()
    if not name:
        raise _refuse("name_required", "A role needs a name.", status.HTTP_422_UNPROCESSABLE_ENTITY)
    clash = db.scalar(
        select(OrgRole).where(OrgRole.org_id == org_id, func.lower(OrgRole.name) == name.lower())
    )
    if clash is not None:
        raise _refuse("name_taken", f"A role called “{clash.name}” already exists.")

    row = OrgRole(
        org_id=org_id,
        name=name,
        description=(description or "").strip() or None,
        base_role=base_role,
        data_scope=data_scope,
        permissions=clean_permissions(permissions),
        is_builtin=False,
    )
    db.add(row)
    db.flush()
    return row


def update_role(db: Session, org_id: uuid.UUID, role_id: uuid.UUID, *,
                name: str | None, description: str | None,
                base_role: str | None, data_scope: str | None,
                permissions: dict | None) -> OrgRole:
    """Edit a role. Takes effect immediately for everybody holding it.

    That is the point of roles and the reason the console shows the member count
    beside the save button — this is not a draft that gets applied later.

    A built-in may have its **permissions and scope** changed but not its name or
    its base role. Companies genuinely want a Manager who cannot see screenshots.
    None of them want a Manager whose base role is quietly Administrator: the
    coarse ``can_administer`` checks read that, and it would hand out settings
    and payroll from a screen about approving leave.
    """
    row = get_role(db, org_id, role_id)

    if row.is_builtin and (name is not None and name.strip() != row.name):
        raise _refuse(
            "builtin_locked",
            f"“{row.name}” is a built-in role and cannot be renamed. Create a new "
            "role if you need a different one.",
        )
    if row.is_builtin and base_role is not None and base_role != row.base_role:
        raise _refuse(
            "builtin_locked",
            f"“{row.name}” is a built-in role; its level cannot be changed. Its "
            "permissions and its data scope can.",
        )

    if name is not None and not row.is_builtin:
        cleaned = name.strip()
        if not cleaned:
            raise _refuse("name_required", "A role needs a name.",
                          status.HTTP_422_UNPROCESSABLE_ENTITY)
        clash = db.scalar(
            select(OrgRole).where(
                OrgRole.org_id == org_id,
                func.lower(OrgRole.name) == cleaned.lower(),
                OrgRole.id != row.id,
            )
        )
        if clash is not None:
            raise _refuse("name_taken", f"A role called “{clash.name}” already exists.")
        row.name = cleaned

    if description is not None:
        row.description = description.strip() or None
    if base_role is not None and not row.is_builtin:
        row.base_role = base_role
    if data_scope is not None:
        row.data_scope = data_scope
    if permissions is not None:
        row.permissions = clean_permissions(permissions)
    db.flush()
    return row


def delete_role(db: Session, org_id: uuid.UUID, role_id: uuid.UUID) -> int:
    """Remove a custom role, returning how many people were holding it.

    They are not deleted and not reassigned — the FK is ``SET NULL``, so they
    fall back to their own columns, which is a survivable state. Reassigning
    them to some other role automatically would be a permission change nobody
    asked for, made silently, to people whose names were never on the screen.
    """
    row = get_role(db, org_id, role_id)
    if row.is_builtin:
        raise _refuse(
            "builtin_locked",
            f"“{row.name}” is a built-in role and cannot be deleted. Every company "
            "needs somewhere to put its owner and its staff.",
        )
    held = member_counts(db, org_id).get(row.id, 0)
    db.delete(row)
    db.flush()
    return held
