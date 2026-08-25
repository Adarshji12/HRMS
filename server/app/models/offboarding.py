"""Employee exit: the offboarding request, its clearance checklist, and the
full-and-final settlement **stub**.

Three tables, one workflow::

    OffboardingRequest -+- OffboardingTask  (clearance checklist, by category)
                        +- OffboardingFnf   (one settlement record per exit)

**The F&F table computes nothing, and nothing in this repository computes it.**
.. note::
   **The "settlement is manual" premise below is superseded.** It was written
   when payroll did not exist. It now does, and ``app.services.settlement``
   computes a full itemised proposal from live data -- salary, leave
   encashment, gratuity, notice, statutory, loans and unpaid claims -- which HR
   reviews and accepts into this record. The three numbers here are still
   stored exactly as recorded rather than derived, for the reasons given below,
   and a settlement may still be typed in from a spreadsheet. What changed is
   that nobody has to.

Full-and-final settlement needs payroll -- salary, leave encashment, PF, ESI,
TDS -- and payroll does not exist in this product and is an explicit non-goal
(spec section 14). Every paise in ``offboarding_fnf`` is a number an HR admin
typed in by hand, from a calculation they did somewhere else, usually a
spreadsheet. The columns are storage and an audit trail, not a ledger:
``net_payable_paise`` is saved exactly as entered and is deliberately *not*
forced to equal gross minus deductions, because ex-gratia, rounding and
negotiated write-offs are normal, and the number that was actually paid must
survive contact with our arithmetic. ``OffboardingFnf.is_consistent`` exists so
a UI can warn about a mismatch; nothing rejects the row. If a future reader goes
looking for where the settlement is calculated: it is not in this module, and it
is not anywhere else either. This is a known, documented gap, kept deliberately
so the exit workflow can complete without pretending to be payroll.

The second decision worth stating up front: completing an exit revokes the
leaver's devices through the **existing** ``devices.is_active = False`` path --
the same flag ``api/v1/admin.py`` already flips when an employee is deactivated,
and which the agent sees as a 403 and raises ``DeviceRevoked`` for. There is no
offboarding-specific revoke mechanism and there must never be one; a second way
to kill a device is a second thing to forget to check.
``OffboardingRequest.devices_revoked_at`` records *that* the revoke ran, and is
never consulted to decide whether a device may still collect.
"""

from __future__ import annotations

import enum
import uuid
from datetime import date, datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDMixin

if TYPE_CHECKING:
    from app.models.user import User


class OffboardingReason(str, enum.Enum):
    RESIGNATION = "resignation"
    TERMINATION = "termination"
    END_OF_CONTRACT = "end_of_contract"

    @property
    def is_voluntary(self) -> bool:
        """Reporting and tone, not access control. An involuntary exit normally
        has no notice period and wants same-day revocation."""
        return self is OffboardingReason.RESIGNATION


class OffboardingStatus(str, enum.Enum):
    INITIATED = "initiated"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    CANCELLED = "cancelled"

    @property
    def is_open(self) -> bool:
        """An open exit is what blocks a second one for the same employee."""
        return self in (OffboardingStatus.INITIATED, OffboardingStatus.IN_PROGRESS)


class ClearanceCategory(str, enum.Enum):
    """The four clearance desks an exit has to pass.

    Fixed by the spec rather than admin-editable: the completion gate and every
    report group by these, and a free-text category would make "is IT clearance
    done?" a question nobody can answer.
    """

    IT_ASSET_RETURN = "it_asset_return"
    KNOWLEDGE_TRANSFER = "knowledge_transfer"
    HR_CLEARANCE = "hr_clearance"
    FINANCE_CLEARANCE = "finance_clearance"


class ClearanceTaskStatus(str, enum.Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    DONE = "done"
    SKIPPED = "skipped"

    @property
    def is_settled(self) -> bool:
        """``skipped`` counts as settled: an item someone consciously waived must
        not hold an exit open forever. Who waived it is in ``completed_by``, so
        the trail survives the shortcut."""
        return self in (ClearanceTaskStatus.DONE, ClearanceTaskStatus.SKIPPED)


class ClearanceOwnerRole(str, enum.Enum):
    """Which desk is expected to action an item when nobody is named on it.

    Deliberately not ``models.user.Role``: "IT" is not an org role in this
    product, and being the desk that collects laptops is a workflow fact, not a
    permission.
    """

    HR = "hr"
    MANAGER = "manager"
    IT = "it"
    EMPLOYEE = "employee"


class FnfStatus(str, enum.Enum):
    DRAFT = "draft"
    APPROVED = "approved"
    PAID = "paid"
    CANCELLED = "cancelled"

    @property
    def is_final(self) -> bool:
        return self in (FnfStatus.PAID, FnfStatus.CANCELLED)


#: The clearance checklist an exit starts with.
#:
#: The spec calls the checklist "template-driven" but gives offboarding no
#: template table of its own, the way onboarding gets ``onboarding_templates``.
#: Rather than invent a table nobody asked for, the default template lives here
#: as data and the Phase 7 service copies it into ``offboarding_tasks`` rows when
#: a request is created -- so every exit still gets its own editable checklist,
#: which is the part that actually matters to HR. If per-department exit
#: templates are wanted later, add ``offboarding_templates`` mirroring the
#: onboarding pair and seed it from this constant; nothing else has to move.
#:
#: ``due_offset_days`` is relative to ``last_working_day``, and negative means
#: "before the last day" -- which is where most clearance genuinely belongs, the
#: F&F record being the obvious exception.
DEFAULT_CLEARANCE_CHECKLIST: tuple[dict[str, object], ...] = (
    {
        "category": ClearanceCategory.KNOWLEDGE_TRANSFER.value,
        "title": "Hand over projects and document open work",
        "owner_role": ClearanceOwnerRole.EMPLOYEE.value,
        "due_offset_days": -7,
        "is_mandatory": True,
    },
    {
        "category": ClearanceCategory.KNOWLEDGE_TRANSFER.value,
        "title": "Manager sign-off on handover completeness",
        "owner_role": ClearanceOwnerRole.MANAGER.value,
        "due_offset_days": -1,
        "is_mandatory": True,
    },
    {
        "category": ClearanceCategory.IT_ASSET_RETURN.value,
        "title": "Return company assets (laptop, monitor, SIM, ID card)",
        "owner_role": ClearanceOwnerRole.EMPLOYEE.value,
        "due_offset_days": 0,
        "is_mandatory": True,
    },
    {
        "category": ClearanceCategory.IT_ASSET_RETURN.value,
        "title": "Revoke application access and disable accounts",
        "owner_role": ClearanceOwnerRole.IT.value,
        "due_offset_days": 0,
        "is_mandatory": True,
    },
    {
        "category": ClearanceCategory.HR_CLEARANCE.value,
        "title": "Exit interview",
        "owner_role": ClearanceOwnerRole.HR.value,
        "due_offset_days": -2,
        "is_mandatory": False,
    },
    {
        "category": ClearanceCategory.HR_CLEARANCE.value,
        "title": "Collect resignation acceptance, issue relieving letter",
        "owner_role": ClearanceOwnerRole.HR.value,
        "due_offset_days": 0,
        "is_mandatory": True,
    },
    {
        "category": ClearanceCategory.FINANCE_CLEARANCE.value,
        "title": "Settle outstanding expense claims and salary advances",
        "owner_role": ClearanceOwnerRole.HR.value,
        "due_offset_days": -3,
        "is_mandatory": True,
    },
    {
        "category": ClearanceCategory.FINANCE_CLEARANCE.value,
        "title": "Record full-and-final settlement (calculated outside this system)",
        "owner_role": ClearanceOwnerRole.HR.value,
        "due_offset_days": 15,
        "is_mandatory": False,
    },
)


class OffboardingRequest(UUIDMixin, TimestampMixin, Base):
    """One employee exit, and the whole compliance trail for it."""

    __tablename__ = "offboarding_requests"
    __table_args__ = (
        Index("ix_offboarding_requests_org_status", "org_id", "status"),
        Index("ix_offboarding_requests_org_lwd", "org_id", "last_working_day"),
        # At most one *open* exit per employee -- not a plain unique constraint
        # on user_id, because someone can be rehired and leave again years
        # later, and the first exit has to stay on file when they do. The
        # predicate is spelled once per dialect because SQLite and Postgres do
        # not share the keyword and both are supported targets.
        Index(
            "uq_offboarding_requests_open_per_user",
            "user_id",
            unique=True,
            sqlite_where=text("status IN ('initiated', 'in_progress')"),
            postgresql_where=text("status IN ('initiated', 'in_progress')"),
        ),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # CASCADE: if the employee row is genuinely deleted -- an erasure request,
    # not an exit -- the paperwork about them goes too. Exit records for a user
    # who no longer exists are not evidence, they are a dangling name.
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # SET NULL, not CASCADE: the HR admin who raised this exit will one day be
    # offboarded themselves, and losing them must not erase everyone else's
    # exit records.
    initiated_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    reason: Mapped[str] = mapped_column(String(24), nullable=False)
    # The story behind the reason code -- "joining a competitor", the
    # termination cause. Reports group by ``reason``; humans read this.
    reason_note: Mapped[str | None] = mapped_column(Text, nullable=True)

    # The day the exit went on record: for a resignation the day the letter
    # landed, for a termination the day it was decided. Always known, so not
    # nullable.
    notice_date: Mapped[date] = mapped_column(Date, nullable=False)
    # Nullable on purpose. An exit is routinely raised before the last day is
    # agreed, and forcing a placeholder here would put a fictional date on a
    # relieving letter. Every clearance due date derives from this, so the
    # service recomputes them whenever it is finally set or moved.
    last_working_day: Mapped[date | None] = mapped_column(Date, nullable=True)

    status: Mapped[str] = mapped_column(
        String(20), default=OffboardingStatus.INITIATED.value, nullable=False
    )

    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Withdrawn resignations happen often enough to need a reason on file. The
    # row is cancelled rather than deleted, so the withdrawal is itself history.
    cancellation_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Audit timestamps for the two irreversible things completion does. Neither
    # is ever read to decide anything: whether a machine may still collect is
    # ``devices.is_active`` and nothing else, and whether a person may still log
    # in is ``users.is_active``. These columns answer "did it run, and when",
    # which is what an auditor asks and what those tables cannot say once a
    # device is deleted or a user is reactivated on rehire.
    devices_revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    user_deactivated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # ``foreign_keys`` is mandatory on all three: they point at the same table
    # and SQLAlchemy cannot guess which column each one means. No
    # ``back_populates`` anywhere in this module -- ``User`` is a shared model
    # this module may not edit, and one-directional relationships cost nothing.
    user: Mapped["User"] = relationship(foreign_keys=[user_id])
    initiator: Mapped["User | None"] = relationship(foreign_keys=[initiated_by])
    completer: Mapped["User | None"] = relationship(foreign_keys=[completed_by])

    tasks: Mapped[list["OffboardingTask"]] = relationship(
        back_populates="request",
        cascade="all, delete-orphan",
        order_by="(OffboardingTask.category, OffboardingTask.sort_order)",
    )
    fnf: Mapped["OffboardingFnf | None"] = relationship(
        back_populates="request", cascade="all, delete-orphan", uselist=False
    )

    @property
    def status_enum(self) -> OffboardingStatus:
        try:
            return OffboardingStatus(self.status)
        except ValueError:
            # Same guard as Project.status_enum: an unrecognised string must not
            # raise inside a list view. CANCELLED is the safe fallback -- it can
            # never make a stale row look like live, in-flight work.
            return OffboardingStatus.CANCELLED

    @property
    def blocking_tasks(self) -> list["OffboardingTask"]:
        """Mandatory clearance items still unsettled.

        Phase 7's completion gate should refuse to complete an exit while this
        is non-empty; a laptop that never came back is exactly the case where
        "mark complete" must not be one click.
        """
        return [t for t in self.tasks if t.is_mandatory and not t.is_settled]


class OffboardingTask(UUIDMixin, TimestampMixin, Base):
    """One clearance checklist item on one exit.

    Same shape as an onboarding task on purpose -- an instantiated copy with its
    own status, ``completed_by`` and ``completed_at`` -- so anyone who has read
    that module can read this one at a glance. It is a deliberate copy and not a
    shared base class: the two checklists answer to different owners and will
    drift, and coupling them would let an onboarding change quietly rewrite what
    an exit record means.
    """

    __tablename__ = "offboarding_tasks"
    __table_args__ = (
        Index("ix_offboarding_tasks_request_category", "request_id", "category"),
        Index("ix_offboarding_tasks_org_status", "org_id", "status"),
        Index("ix_offboarding_tasks_assignee_status", "assignee_user_id", "status"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    request_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("offboarding_requests.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )

    title: Mapped[str] = mapped_column(String(300), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    category: Mapped[str] = mapped_column(String(32), nullable=False)
    owner_role: Mapped[str] = mapped_column(
        String(20), default=ClearanceOwnerRole.HR.value, nullable=False
    )
    # Nullable: the desk named by ``owner_role`` owns the item until a specific
    # person picks it up, and demanding a name at creation time would stall
    # every checklist on the day it is created.
    #
    # The name follows ``models.project.Task.assignee_user_id``, which has meant
    # exactly this since before the HRMS work started and cannot move under the
    # additive-only rule. Onboarding's task table follows it too, so all three
    # spell "the person this item is on" the same way, and the resolved display
    # field is ``assignee_name`` in all three for the same reason. This is a
    # cross-module convention, not a local preference: do not rename it to match
    # whatever the neighbouring column happens to be called.
    assignee_user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    status: Mapped[str] = mapped_column(
        String(20), default=ClearanceTaskStatus.PENDING.value, nullable=False
    )
    # Whether this item blocks completion. Not everything does: an exit
    # interview the leaver refuses to attend cannot be allowed to keep their
    # laptop enrolled indefinitely.
    is_mandatory: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    # Kept alongside ``due_on`` rather than replaced by it: last working days
    # move during notice periods more often than not, and the offset is what
    # lets the service recompute every due date instead of asking HR to.
    due_offset_days: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # An HR working day in the org's local calendar, so Date and never DateTime.
    due_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    # The spec calls this ``order``, which is a reserved word in SQL: every
    # hand-written query touching it would need quoting, and one day someone
    # would forget. Named to match the onboarding checklist's own column rather
    # than picked independently -- the two task tables get read side by side,
    # and a field that means the same thing must not be spelled two ways.
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    completed_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Where "laptop returned, screen cracked" and "waived, employee absconded"
    # go. This is the field a dispute is settled from six months later.
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    request: Mapped["OffboardingRequest"] = relationship(back_populates="tasks")
    assignee: Mapped["User | None"] = relationship(foreign_keys=[assignee_user_id])
    completer: Mapped["User | None"] = relationship(foreign_keys=[completed_by])

    @property
    def is_settled(self) -> bool:
        """Done or consciously skipped.

        An unrecognised status reads as unsettled rather than raising, which
        keeps the completion gate closed instead of accidentally opening it.
        """
        try:
            return ClearanceTaskStatus(self.status).is_settled
        except ValueError:
            return False


class OffboardingFnf(UUIDMixin, TimestampMixin, Base):
    """Full-and-final settlement, **manually entered**.

    Read the module docstring before adding anything to this class. Nothing here
    is calculated: an HR admin works the settlement out elsewhere and types three
    numbers in. The table exists so the exit workflow can finish, and so that
    "was this person paid, how much, when, against what reference" has an answer
    -- not because this product knows how to compute a settlement. It does not,
    and until payroll exists it cannot.
    """

    __tablename__ = "offboarding_fnf"
    __table_args__ = (
        # One settlement per exit. A correction edits this row; a later exit
        # after a rehire is a different request and gets its own.
        UniqueConstraint("request_id", name="uq_offboarding_fnf_request_id"),
        Index("ix_offboarding_fnf_org_status", "org_id", "status"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    request_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("offboarding_requests.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )

    # Integer paise, like every other money column here (see app.core.plans).
    # A settlement is the last money a company owes a person; a float in this
    # column is a rounding complaint arriving on legal letterhead.
    gross_dues_paise: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    deductions_paise: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # Stored as entered. Deliberately not derived from the two above and
    # deliberately not constrained to match them: ex-gratia, negotiated
    # write-offs and rounding all make the arithmetic disagree legitimately, and
    # the figure that was actually paid is the one that matters.
    # ``is_consistent`` lets the UI warn about a mismatch; nothing rejects it.
    net_payable_paise: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), default="INR", nullable=False)

    status: Mapped[str] = mapped_column(String(20), default=FnfStatus.DRAFT.value, nullable=False)
    # The itemisation the numbers came from, in whatever form HR pasted it. The
    # real breakdown lives in their spreadsheet; this is the only trace of it
    # this system will ever hold.
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    prepared_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    approved_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # The day the money left, in the org's local calendar -- an accounting day,
    # so Date. Set together with ``status = paid``.
    paid_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    # NEFT/UTR or cheque number. Without it, "we paid you" is unprovable.
    payment_reference: Mapped[str | None] = mapped_column(String(120), nullable=True)
    paid_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    # When a computed proposal was accepted into this record. Null means the
    # three numbers were typed in from somewhere else, which is still allowed
    # and is what every settlement written before payroll existed looks like.
    computed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    request: Mapped["OffboardingRequest"] = relationship(back_populates="fnf")
    lines: Mapped[list["FnfLine"]] = relationship(  # noqa: F821
        back_populates="fnf",
        cascade="all, delete-orphan",
        order_by="FnfLine.sort_order",
    )
    preparer: Mapped["User | None"] = relationship(foreign_keys=[prepared_by])
    approver: Mapped["User | None"] = relationship(foreign_keys=[approved_by])
    payer: Mapped["User | None"] = relationship(foreign_keys=[paid_by])

    @property
    def is_consistent(self) -> bool:
        """Whether the typed-in numbers happen to add up. Advisory only -- see
        the note on ``net_payable_paise``."""
        return self.net_payable_paise == self.gross_dues_paise - self.deductions_paise

    @property
    def status_enum(self) -> FnfStatus:
        try:
            return FnfStatus(self.status)
        except ValueError:
            return FnfStatus.DRAFT
