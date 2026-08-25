"""Departments, teams and designations.

Models the shape the spec asks for:

    Company -> Department -> Team -> Employee

with a *separate* manager chain (``User.manager_id``) laid over it. The two are
deliberately not the same thing: a team has one accountable manager, but people
routinely report to someone outside their team (a matrixed designer reporting to
the design lead while sitting on a product team). Collapsing them would force
every such company to lie about one or the other.

Departments can nest via ``parent_id`` so "Engineering -> Platform -> Infra"
works without inventing a second level of table.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    Uuid,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDMixin

if TYPE_CHECKING:
    from app.models.user import User


class Department(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "departments"
    __table_args__ = (UniqueConstraint("org_id", "name", name="uq_department_org_name"),)

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    code: Mapped[str | None] = mapped_column(String(32), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Self-referential so departments can nest arbitrarily deep.
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("departments.id", ondelete="SET NULL"), nullable=True
    )
    # SET NULL, not CASCADE: losing the department head must not delete the
    # department and orphan everyone in it.
    #
    # use_alter breaks a genuine dependency cycle — users.department_id points
    # here while this points back at users. Without it the table ordering is
    # unresolvable and Postgres refuses to create the schema; with it the
    # constraint is added by ALTER once both tables exist.
    head_user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey("users.id", ondelete="SET NULL", use_alter=True,
                   name="fk_departments_head_user_id_users"),
        nullable=True,
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    parent: Mapped["Department | None"] = relationship(remote_side="Department.id")
    teams: Mapped[list["Team"]] = relationship(back_populates="department")


class Team(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "teams"
    __table_args__ = (UniqueConstraint("org_id", "name", name="uq_team_org_name"),)

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    department_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("departments.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # Same cycle as Department.head_user_id — see the note there.
    manager_user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey("users.id", ondelete="SET NULL", use_alter=True,
                   name="fk_teams_manager_user_id_users"),
        nullable=True,
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    department: Mapped["Department | None"] = relationship(back_populates="teams")
    members: Mapped[list["User"]] = relationship(
        back_populates="team", foreign_keys="User.team_id"
    )


class Designation(UUIDMixin, TimestampMixin, Base):
    """Job title. ``level`` orders them for seniority sorting in reports."""

    __tablename__ = "designations"
    __table_args__ = (UniqueConstraint("org_id", "name", name="uq_designation_org_name"),)

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    level: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class WorkSchedule(UUIDMixin, TimestampMixin, Base):
    """Expected working hours, for attendance and overtime.

    Assigned per employee, falling back to the organisation default. Kept
    separate from ``OrgSettings`` because a support team on 10:00-19:00 and an
    engineering team on 09:30-18:30 is the normal case, not the exception.
    """

    __tablename__ = "work_schedules"
    __table_args__ = (UniqueConstraint("org_id", "name", name="uq_schedule_org_name"),)

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    start_time: Mapped[str] = mapped_column(String(5), default="09:00", nullable=False)
    end_time: Mapped[str] = mapped_column(String(5), default="18:00", nullable=False)
    # Bitmask, Monday = bit 0. 0b0011111 = Mon-Fri.
    working_days: Mapped[int] = mapped_column(Integer, default=0b0011111, nullable=False)
    break_minutes: Mapped[int] = mapped_column(Integer, default=60, nullable=False)
    # Daily hours past which time counts as overtime.
    overtime_after_minutes: Mapped[int] = mapped_column(Integer, default=480, nullable=False)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    def works_on(self, weekday: int) -> bool:
        """``weekday`` is Python's Monday=0 convention."""
        return bool(self.working_days & (1 << weekday))

    @property
    def expected_minutes(self) -> int:
        start_h, start_m = (int(p) for p in self.start_time.split(":"))
        end_h, end_m = (int(p) for p in self.end_time.split(":"))
        span = (end_h * 60 + end_m) - (start_h * 60 + start_m)
        if span < 0:  # overnight shift
            span += 24 * 60
        return max(0, span - self.break_minutes)
