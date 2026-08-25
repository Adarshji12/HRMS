"""Org hierarchy: who reports to whom, and who may see whom.

The visibility rule is the important part. A manager sees their **reporting
subtree** — direct reports plus everyone under them — not "people with the same
team name". Team-name matching was the old rule and it is wrong in both
directions: it hid a manager's own reports who sat on another team, and it
exposed peers who merely shared a label.

Traversal is done in Python rather than a recursive CTE. One organisation's user
table is small (hundreds, not millions), it is loaded once per request, and the
alternative is a query SQLite cannot express the same way Postgres can. If an
org ever reaches tens of thousands of employees, swap this for a CTE on Postgres
and keep the same signature.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Department, Designation, Role, Team, User

# Depth guard. A cycle should be impossible (see would_create_cycle), but a
# corrupted row must not hang a request.
MAX_DEPTH = 24


def _reports_index(db: Session, org_id: uuid.UUID) -> dict[uuid.UUID | None, list[User]]:
    users = db.scalars(select(User).where(User.org_id == org_id)).all()
    index: dict[uuid.UUID | None, list[User]] = defaultdict(list)
    for user in users:
        index[user.manager_id].append(user)
    for bucket in index.values():
        bucket.sort(key=lambda u: u.full_name.lower())
    return index


def subtree_ids(
    db: Session, org_id: uuid.UUID, root_id: uuid.UUID, include_self: bool = True
) -> list[uuid.UUID]:
    """Every user under ``root_id`` in the reporting chain."""
    index = _reports_index(db, org_id)
    found: list[uuid.UUID] = [root_id] if include_self else []
    frontier = [root_id]
    seen = {root_id}

    for _ in range(MAX_DEPTH):
        if not frontier:
            break
        next_frontier: list[uuid.UUID] = []
        for manager_id in frontier:
            for report in index.get(manager_id, []):
                if report.id in seen:
                    continue
                seen.add(report.id)
                found.append(report.id)
                next_frontier.append(report.id)
        frontier = next_frontier

    return found


def would_create_cycle(db: Session, user_id: uuid.UUID, new_manager_id: uuid.UUID | None) -> bool:
    """True if setting this manager would make the reporting chain loop.

    Without this, A→B→A is one careless edit away, and every traversal after it
    either loops forever or silently truncates.
    """
    if new_manager_id is None:
        return False
    if new_manager_id == user_id:
        return True

    cursor: uuid.UUID | None = new_manager_id
    for _ in range(MAX_DEPTH):
        if cursor is None:
            return False
        if cursor == user_id:
            return True
        parent = db.scalar(select(User.manager_id).where(User.id == cursor))
        cursor = parent
    # Ran out of depth without resolving: treat as a cycle rather than allow it.
    return True


def visible_user_ids(db: Session, viewer: User) -> list[uuid.UUID] | None:
    """``None`` means "the whole organisation" — no filter needed.

    * owner/admin  -> everything
    * manager      -> their reporting subtree, plus any team they manage
    * employee     -> themselves only
    """
    if viewer.role_enum.can_administer:
        return None

    if viewer.role_enum is Role.MANAGER:
        ids = set(subtree_ids(db, viewer.org_id, viewer.id))
        # A team manager sees their team even where the reporting lines run
        # elsewhere — that is the whole point of naming them the manager.
        managed_teams = db.scalars(
            select(Team.id).where(Team.org_id == viewer.org_id, Team.manager_user_id == viewer.id)
        ).all()
        if managed_teams:
            ids.update(
                db.scalars(
                    select(User.id).where(
                        User.org_id == viewer.org_id, User.team_id.in_(managed_teams)
                    )
                ).all()
            )
        headed = db.scalars(
            select(Department.id).where(
                Department.org_id == viewer.org_id, Department.head_user_id == viewer.id
            )
        ).all()
        if headed:
            ids.update(
                db.scalars(
                    select(User.id).where(
                        User.org_id == viewer.org_id, User.department_id.in_(headed)
                    )
                ).all()
            )
        return sorted(ids, key=str)

    return [viewer.id]


# --------------------------------------------------------------------------- #
# Tree for the UI
# --------------------------------------------------------------------------- #


@dataclass
class Node:
    id: str
    name: str
    email: str
    role: str
    designation: str | None
    team: str | None
    department: str | None
    is_active: bool
    reports: list["Node"] = field(default_factory=list)

    @property
    def headcount(self) -> int:
        return 1 + sum(node.headcount for node in self.reports)

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "email": self.email,
            "role": self.role,
            "designation": self.designation,
            "team": self.team,
            "department": self.department,
            "is_active": self.is_active,
            "headcount": self.headcount,
            "reports": [node.as_dict() for node in self.reports],
        }


def reporting_line(db: Session, user: User) -> list[dict]:
    """This person and the managers above them, nested from the top down.

    Built by walking up rather than by filtering the full tree: the walk visits
    at most the depth of the organisation, while filtering would load every
    employee in the company to throw nearly all of them away.
    """
    teams = {t.id: t.name for t in db.scalars(select(Team).where(Team.org_id == user.org_id)).all()}
    departments = {
        d.id: d.name
        for d in db.scalars(select(Department).where(Department.org_id == user.org_id)).all()
    }
    titles = {
        d.id: d.name
        for d in db.scalars(select(Designation).where(Designation.org_id == user.org_id)).all()
    }

    def node_for(person: User) -> Node:
        return Node(
            id=str(person.id),
            name=person.full_name,
            email=person.email,
            role=person.role,
            designation=titles.get(person.designation_id),
            team=teams.get(person.team_id),
            department=departments.get(person.department_id),
            is_active=person.is_active,
        )

    chain: list[User] = [user]
    seen = {user.id}
    current = user
    # Guarded against a loop even though assignment refuses to create one:
    # a chain built from data should not be able to hang the request.
    while current.manager_id and current.manager_id not in seen:
        manager = db.get(User, current.manager_id)
        if manager is None or manager.org_id != user.org_id:
            break
        chain.append(manager)
        seen.add(manager.id)
        current = manager

    # chain is bottom-up; nest it top-down so the root is the outermost node.
    nodes = [node_for(person) for person in reversed(chain)]
    for parent, child in zip(nodes, nodes[1:]):
        parent.reports = [child]
    return [nodes[0].as_dict()]


def build_tree(db: Session, org_id: uuid.UUID, root_id: uuid.UUID | None = None) -> list[dict]:
    """Reporting tree. Roots are people with no manager, or ``root_id``."""
    users = db.scalars(select(User).where(User.org_id == org_id)).all()
    teams = {t.id: t.name for t in db.scalars(select(Team).where(Team.org_id == org_id)).all()}
    departments = {
        d.id: d.name for d in db.scalars(select(Department).where(Department.org_id == org_id)).all()
    }
    titles = {
        d.id: d.name
        for d in db.scalars(select(Designation).where(Designation.org_id == org_id)).all()
    }

    nodes = {
        user.id: Node(
            id=str(user.id),
            name=user.full_name,
            email=user.email,
            role=user.role,
            designation=titles.get(user.designation_id),
            team=teams.get(user.team_id),
            department=departments.get(user.department_id),
            is_active=user.is_active,
        )
        for user in users
    }

    roots: list[Node] = []
    for user in users:
        node = nodes[user.id]
        parent = nodes.get(user.manager_id) if user.manager_id else None
        # A manager_id pointing outside this org (or at a deleted user) makes the
        # node a root rather than dropping it — an employee must never vanish
        # from the org chart because of a dangling reference.
        if parent is not None and parent is not node:
            parent.reports.append(node)
        else:
            roots.append(node)

    for node in nodes.values():
        node.reports.sort(key=lambda n: n.name.lower())

    if root_id is not None:
        target = nodes.get(root_id)
        return [target.as_dict()] if target else []

    roots.sort(key=lambda n: n.name.lower())
    return [node.as_dict() for node in roots]
