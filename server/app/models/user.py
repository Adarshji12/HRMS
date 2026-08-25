from __future__ import annotations

import enum
import uuid
from datetime import date, datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    String,
    Uuid,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDMixin

if TYPE_CHECKING:
    from app.models.corehr import EmployeeProfile
    from app.models.device import Device
    from app.models.org_structure import Department, Designation, Team, WorkSchedule
    from app.models.organization import Organization


class UserStatus(str, enum.Enum):
    """Where a person is in the employment lifecycle.

    Deliberately NOT a replacement for ``is_active``, and the distinction is the
    whole reason this column exists. ``is_active`` answers "may this account
    authenticate"; this answers "is this person a pre-joiner, staff, or an
    ex-employee". A pre-boarding hire is neither active nor departed — HR needs a
    checklist running for them a fortnight before they can log in — so
    overloading ``is_active`` for it would make "who has left the company"
    permanently unanswerable.

    Mirrors ``organizations.status``, including the ``pending_setup`` spelling,
    so the org-level and person-level lifecycles read the same way.
    """

    PENDING_SETUP = "pending_setup"
    ACTIVE = "active"
    INACTIVE = "inactive"


class Role(str, enum.Enum):
    OWNER = "owner"
    ADMIN = "admin"
    MANAGER = "manager"
    EMPLOYEE = "employee"

    @property
    def can_administer(self) -> bool:
        return self in (Role.OWNER, Role.ADMIN)

    @property
    def can_view_team(self) -> bool:
        return self in (Role.OWNER, Role.ADMIN, Role.MANAGER)


class User(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "users"
    __table_args__ = (
        UniqueConstraint("org_id", "email", name="uq_users_org_email"),
        UniqueConstraint("org_id", "employee_code", name="uq_users_org_code"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    full_name: Mapped[str] = mapped_column(String(200), nullable=False)
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    role: Mapped[str] = mapped_column(String(20), default=Role.EMPLOYEE.value, nullable=False)
    timezone: Mapped[str] = mapped_column(String(64), default="UTC", nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    #: Employment lifecycle — see UserStatus. Defaults to "active", NOT
    #: "pending_setup": every account that exists today belongs to someone
    #: already working here, so the default is what makes this migration
    #: additive instead of a silent mass-reclassification of the whole table.
    status: Mapped[str] = mapped_column(
        String(24), default=UserStatus.ACTIVE.value, nullable=False, index=True
    )

    # --- permissions ---------------------------------------------------------
    #
    # These RESTRICT; they never grant. The effective right is always
    # "the role allows it AND this flag is on", so ticking one on an employee
    # cannot let them see a colleague — the role check still runs first.
    #
    # That direction is deliberate. A permission system that can also grant
    # needs every endpoint audited for escalation; one that can only take away
    # needs a check only where the role already said yes. It also means the
    # default is True for everyone, so existing accounts keep the behaviour they
    # had and no backfill is required.
    can_view_screenshots: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    can_approve_timesheets: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    can_export_data: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    can_manage_projects: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    # HRMS modules. Same direction as the four above — these restrict, never
    # grant — so a manager without can_approve_leave still cannot approve for
    # anyone outside their reporting subtree, and an employee with the flag on
    # gains nothing, because the role check runs first either way.
    #
    # Approving leave and approving attendance corrections are separate flags on
    # purpose. They are separate decisions in most companies: a team lead who
    # signs off "you were in the office at 09:15" is routinely not the person
    # who signs off "you may take nine days off", because only one of those
    # spends a balance. Collapsing them would force every such org to grant one
    # to give the other.
    can_approve_leave: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    can_approve_regularization: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    can_manage_assets: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    can_manage_onboarding: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    can_manage_helpdesk: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    #: Read and edit *other people's* master records — statutory identity, bank
    #: details, confirmation. Restricts like the rest: the role check runs
    #: first, so this narrows HR and administrators, and never widens an
    #: employee. Everyone can always see and edit their own profile, which is
    #: why that path does not consult this flag at all.
    can_manage_people: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    #: Issue letters on the company's behalf. Separate from
    #: ``can_manage_people`` because the authorities differ: reading somebody's
    #: bank details is administrative, and signing an offer letter is a
    #: commitment the company is held to.
    can_issue_letters: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    #: Approve a team's expense claims. Distinct from ``can_reimburse_expenses``
    #: below because they are different jobs done by different people: a manager
    #: says the spend was legitimate, finance says it has been paid. One flag
    #: would let every approver mark claims paid.
    can_approve_expenses: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    #: Mark an approved claim as paid. Finance, not line management.
    can_reimburse_expenses: Mapped[bool] = mapped_column(
        Boolean, default=True, nullable=False
    )
    #: Sanction a loan or salary advance. Administrators only in practice: the
    #: role check in ``services/loans`` does not admit managers, because lending
    #: company money is not a line-management decision the way approving a taxi
    #: fare is.
    can_approve_loans: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    #: Disburse a sanctioned loan and record repayments against it. Separate
    #: from approving it for the same reason expenses splits approve from pay:
    #: one person says the company will lend, another says the money moved.
    can_disburse_loans: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    #: See and set salaries. The narrowest capability in the product: a salary
    #: is the one field employees compare with each other, and the blast radius
    #: of getting its visibility wrong is the whole company. Administrators
    #: only, and an employee sees their own structure through a separate path
    #: that consults no flag at all.
    can_manage_payroll: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    #: Run appraisal rounds: build cycles, set goals, finalise and release
    #: ratings. Defaults True like every flag but payroll — an appraisal
    #: discloses a manager's opinion of somebody, which is sensitive, but not in
    #: the way a salary is, and HR administrators are who run the round.
    can_manage_performance: Mapped[bool] = mapped_column(
        Boolean, default=True, nullable=False
    )
    #: Publish announcements, run pulse surveys, read survey results. Defaults
    #: True like every flag but payroll. Note that this grants nothing about
    #: *identity*: an anonymous survey's responses carry no user id at all, so
    #: there is no permission that could reveal who said what — see
    #: ``models/engagement``.
    can_manage_engagement: Mapped[bool] = mapped_column(
        Boolean, default=True, nullable=False
    )

    #: Page keys this person may NOT open, e.g. ["reports", "apps"]. Empty means
    #: everything their role reaches.
    #:
    #: Stored as a deny-list rather than an allow-list for the same reason the
    #: flags above default to True: a page added later is visible to everyone
    #: until somebody decides otherwise, instead of invisible to everyone until
    #: every account is edited.
    #:
    #: Only pages whose data endpoints belong to them alone are listed in
    #: PAGE_GUARDS (app/api/deps.py). Employees and Teams are deliberately not
    #: hideable: their endpoints feed the filter dropdowns on Reports, Apps and
    #: Projects, so "hiding" them would either break those pages or be a nav
    #: link that hides nothing.
    hidden_pages: Mapped[list | None] = mapped_column(JSON, nullable=True, default=list)

    # --- org placement -------------------------------------------------------
    department_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("departments.id", ondelete="SET NULL"), nullable=True, index=True
    )
    team_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("teams.id", ondelete="SET NULL"), nullable=True, index=True
    )
    designation_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("designations.id", ondelete="SET NULL"), nullable=True
    )
    schedule_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("work_schedules.id", ondelete="SET NULL"), nullable=True
    )
    # Reporting line, independent of team membership — see org_structure.py.
    manager_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )

    employee_code: Mapped[str | None] = mapped_column(String(40), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(32), nullable=True)
    joined_on: Mapped[date | None] = mapped_column(Date, nullable=True)

    # Typed into the agent once to bind a machine to this employee.
    enrollment_key: Mapped[str] = mapped_column(String(32), unique=True, nullable=False, index=True)

    # Compliance record: when this employee acknowledged the monitoring notice.
    notice_accepted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    organization: Mapped["Organization"] = relationship(back_populates="users")
    #: Lazy by default, so the row every request loads does not drag forty
    #: personal columns along with it.
    profile: Mapped["EmployeeProfile | None"] = relationship(
        back_populates="user",
        foreign_keys="EmployeeProfile.user_id",
        uselist=False,
        cascade="all, delete-orphan",
    )
    devices: Mapped[list["Device"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    # foreign_keys is required on all of these: users.id is referenced from
    # several columns (manager_id here, head_user_id and manager_user_id over
    # there), so SQLAlchemy cannot infer which join each relationship means.
    team: Mapped["Team | None"] = relationship(
        back_populates="members", foreign_keys=[team_id]
    )
    department: Mapped["Department | None"] = relationship(foreign_keys=[department_id])
    designation: Mapped["Designation | None"] = relationship(foreign_keys=[designation_id])
    schedule: Mapped["WorkSchedule | None"] = relationship(foreign_keys=[schedule_id])
    manager: Mapped["User | None"] = relationship(
        remote_side="User.id", foreign_keys=[manager_id], back_populates="reports"
    )
    reports: Mapped[list["User"]] = relationship(
        back_populates="manager", foreign_keys=[manager_id]
    )

    @property
    def role_enum(self) -> Role:
        return Role(self.role)

    @property
    def team_name(self) -> str | None:
        return self.team.name if self.team else None

    @property
    def department_name(self) -> str | None:
        return self.department.name if self.department else None

    @property
    def designation_name(self) -> str | None:
        return self.designation.name if self.designation else None
