"""Named roles: a permission set and a data scope, defined once per company.

Before this, permissions lived on the *person*. Nineteen booleans on every
``users`` row, ticked one employee at a time. Onboarding twenty people meant
answering the same nineteen questions twenty times, and "every HR executive can
now issue letters" was not a sentence the product could express — you found the
executives by hand and hoped you had found them all.

Three ideas, kept separate on purpose because real companies vary them
independently:

**What you can do** — the permission set. A flat map of the same ``can_*`` keys
the ``users`` table already used, so the forty-four existing check sites did not
have to change shape; only where they read the answer from.

**What you can see** — :class:`DataScope`. Genuinely new, and the reason this
was worth doing: the old model inferred scope from the role level, so somebody
who must see the whole company's expenses but manages nobody could only be
expressed by making them an administrator — handing them payroll and settings to
solve a reporting problem. ``deps.py`` already carried a comment about a finance
approver being "routinely nobody's manager". Now they can be Company scope with
two permissions and nothing else.

**Which built-in level it behaves as** — ``base_role``. The coarse
``can_administer`` / ``can_view_team`` checks predate this and are load-bearing
in about a hundred places. Rather than rewrite them, every custom role declares
which of the four it stands in for.

Roles are per-organisation. There is no global role table and there should not
be: one tenant's "Manager" approves leave and another's signs off payroll, and a
shared definition would be wrong for both.
"""

from __future__ import annotations

import enum
import uuid

from sqlalchemy import Boolean, ForeignKey, JSON, String, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDMixin


class DataScope(str, enum.Enum):
    """How much of the company a role can see.

    Deliberately not a permission. "May approve expenses" and "may see the whole
    company's expenses" are different questions, and an HRMS that answers them
    with one switch forces every finance hire to become an administrator.

    ``TEAM`` means the reporting subtree plus any team or department the person
    heads — the existing manager rule, named rather than inferred. See
    ``services/hierarchy.visible_user_ids``, which is the single place this is
    resolved.
    """

    SELF = "self"
    TEAM = "team"
    DEPARTMENT = "department"
    COMPANY = "company"


#: Every permission a role can carry, in the order the console lists them.
#:
#: These are the same keys as the ``users`` columns, deliberately: it is what
#: let ``deny_unless`` keep working against a different source of truth without
#: touching its forty-four callers. A key added here must also exist on ``User``
#: until the columns are retired.
PERMISSION_KEYS: tuple[str, ...] = (
    "can_view_screenshots",
    "can_approve_timesheets",
    "can_export_data",
    "can_manage_projects",
    "can_approve_leave",
    "can_approve_regularization",
    "can_punch_anywhere",
    "can_manage_assets",
    "can_manage_onboarding",
    "can_manage_helpdesk",
    "can_manage_people",
    "can_issue_letters",
    "can_approve_expenses",
    "can_reimburse_expenses",
    "can_approve_loans",
    "can_disburse_loans",
    "can_manage_payroll",
    "can_manage_performance",
    "can_manage_engagement",
)


class OrgRole(UUIDMixin, TimestampMixin, Base):
    """One named role in one company."""

    __tablename__ = "org_roles"
    __table_args__ = (
        UniqueConstraint("org_id", "name", name="uq_org_roles_org_name"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    #: Shown under the name when assigning somebody. Worth insisting on: "Finance
    #: Officer" tells you nothing about whether they can see salaries.
    description: Mapped[str | None] = mapped_column(String(300), nullable=True)

    #: Which of the four built-in levels this role stands in for, for the coarse
    #: `can_administer` / `can_view_team` checks that predate named roles.
    base_role: Mapped[str] = mapped_column(String(20), default="employee", nullable=False)

    data_scope: Mapped[str] = mapped_column(
        String(20), default=DataScope.SELF.value, nullable=False
    )

    #: ``{"can_issue_letters": true, ...}``. A key that is absent is False —
    #: absent and false mean the same thing, so the console can send only what
    #: it turned on and a permission added to the product later defaults to off
    #: for every role that predates it. That is the safe direction.
    permissions: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)

    #: Seeded for every organisation and not deletable. A company must always
    #: have somewhere to put its owner and its ordinary staff, and a workspace
    #: that has deleted every role cannot onboard anybody.
    is_builtin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    def allows(self, flag: str) -> bool:
        return bool(self.permissions.get(flag, False))
