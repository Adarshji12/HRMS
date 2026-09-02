"""Multi-level approval chains: the configuration, and one record's journey.

``services/workflow`` has decided approvals since the kernel landed, but always
at **one level** — somebody decides and it is finished. That is right for a
half-day of leave and wrong for a ₹4,00,000 loan, which most companies route
through the manager, then the department head, then finance.

This module adds the chain. Two tables, and the split matters:

:class:`WorkflowLevel` is **configuration** an administrator edits — "expense
claims in Engineering go manager, then department head". It is a template.

:class:`WorkflowStep` is **history** — the actual chain written onto one record
when it enters the flow, with the reviewer resolved to a real person at that
moment. Nothing on a live chain is read back through the configuration. This is
the same discipline onboarding uses for its checklists, and for the same
reason: editing the config must not rewrite the chain of a request already
half-way through it. A step somebody approved last Tuesday silently becoming a
different step is the failure the split exists to prevent.

The rule that keeps every existing flow working
------------------------------------------------

**No configured chain means exactly the behaviour that came before.** A flow
with no :class:`WorkflowLevel` rows decides in one step, gated by the same
permission rules it always used, with no step rows written at all. Chains are
opt-in per flow and per department, and a company that never opens the setup
screen sees no change whatever.

That is not a migration convenience. It is the correct default: a two-person
company routing leave through three levels is a company where nothing gets
approved.

Reviewers are resolved, not stored twice
-----------------------------------------

A level says *how* to find its reviewer — the requester's manager, that
manager's manager, the department head, a named person, or anybody holding a
capability. :class:`WorkflowStep` stores who that turned out to be. If the
resolution finds nobody, the step is created **unassigned** rather than skipped:
a level with no reviewer is a configuration problem somebody must see, and
silently skipping it would approve things through a gate that was supposed to
exist.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDMixin

#: greytHR allows five. More than that is a signature process, not an approval
#: chain, and every level past the third is one more person who rubber-stamps
#: because the two before them did.
MAX_LEVELS = 5


class ReviewerRule(str, enum.Enum):
    """How a level finds its reviewer.

    Relationships rather than names, mostly: a chain naming Priya breaks the day
    Priya changes team, and every company that has run one for a year has a
    level pointing at somebody who left.
    """

    #: Whoever the requester reports to. The overwhelmingly common first level.
    REPORTING_MANAGER = "reporting_manager"
    #: One further up. The usual second level, and it resolves to nobody at the
    #: top of the tree — which is a real answer, see the module docstring.
    SKIP_LEVEL_MANAGER = "skip_level_manager"
    #: The head of the requester's department.
    DEPARTMENT_HEAD = "department_head"
    #: A specific person. For "all loans go to Anita in finance", which is a
    #: legitimate rule and the reason this is not relationships only.
    NAMED_USER = "named_user"
    #: Anybody holding the flow's own capability — `can_approve_expenses` and
    #: so on. A queue rather than a person: the first to act decides.
    CAPABILITY = "capability"


class StepStatus(str, enum.Enum):
    """Where one link in the chain is.

    ``SKIPPED`` and ``ESCALATED`` are separate states rather than one "not
    decided normally": skipped means the level resolved to nobody or to the
    requester themselves, escalated means somebody was asked and did not
    answer in time. Those need different conversations afterwards.
    """

    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    SKIPPED = "skipped"
    ESCALATED = "escalated"


class WorkflowRule(UUIDMixin, TimestampMixin, Base):
    """A condition, and the chain to use when it holds.

    The thing that turns "expenses go manager → department head" into "expenses
    **over ₹50,000** go manager → department head → finance". Without it a flow
    has exactly one chain per department, and every company that routes by
    amount — which is most of them — has to route the largest claim the same way
    as the smallest.

    **First match wins, top to bottom.** Rules are ordered by ``priority`` and
    the first whose conditions hold supplies the whole chain; nothing merges,
    and no rule adds a rung to another rule's chain. That is the shape a person
    can read off one screen and predict: a chain assembled from three partial
    matches is one nobody can answer "who approves this" about without running
    the code.

    ``conditions`` is a list of clauses, ANDed:

    ``[{"field": "amount", "op": "gt", "value": 5000000}]``

    An **empty** list matches everything, which is what makes the fallback rule
    work. Exactly one rule per flow should carry ``is_fallback`` — it is forced
    to sort last whatever its priority says, and it is what a record falls to
    when nothing else matched. Without one, an unmatched record uses the plain
    department chain, which is the behaviour that existed before rules did.

    The vocabulary of fields and operators lives in ``services.chains``, not
    here: it is per flow (a leave application has no amount), and a column
    cannot express that. Storing an unknown field is therefore possible and is
    treated as **not matching** rather than as an error — a rule that cannot be
    evaluated must not silently approve things by matching everything.
    """

    __tablename__ = "workflow_rules"
    __table_args__ = (
        Index("ix_workflow_rules_org_kind", "org_id", "kind", "priority"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    #: Which flow, from ``services.workflow.POLICIES`` — "leave", "expense".
    kind: Mapped[str] = mapped_column(String(24), nullable=False)
    #: What an administrator called it. Shown on the record's chain so somebody
    #: reading an approval can see *why* it routed the way it did.
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    #: Lower runs first. Ties broken by creation order, so two rules added with
    #: the same priority still evaluate in a defined sequence rather than
    #: whichever the database returns first.
    priority: Mapped[int] = mapped_column(Integer, default=100, nullable=False)
    #: Clauses, ANDed. See the class docstring.
    conditions: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    #: The "otherwise" row. Sorted last regardless of priority and matched
    #: unconditionally, so a flow with one of these can never route nowhere.
    is_fallback: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    #: delete-orphan: a rung has no meaning without the rule it belongs to.
    levels: Mapped[list["WorkflowLevel"]] = relationship(
        back_populates="rule",
        cascade="all, delete-orphan",
        order_by="WorkflowLevel.level",
    )


class WorkflowLevel(UUIDMixin, TimestampMixin, Base):
    """One rung of a configured chain. Configuration, not history."""

    __tablename__ = "workflow_levels"
    __table_args__ = (
        # One rung per position, per flow, per scope — and `rule_id` is part of
        # the scope. Two rules for one flow both having a level 1 is the whole
        # point of rules; without this column in the constraint the second rule
        # could not be saved at all.
        #
        # NULLs repeat in a unique index on both backends, so the pre-rules
        # rows (rule_id NULL) keep exactly the uniqueness they had.
        UniqueConstraint("org_id", "kind", "department_id", "level", "rule_id",
                         name="uq_workflow_levels_scope_level"),
        Index("ix_workflow_levels_org_kind", "org_id", "kind"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    #: Which flow, from ``services.workflow.POLICIES`` — "leave", "expense".
    kind: Mapped[str] = mapped_column(String(24), nullable=False)
    #: Null means the company-wide chain for this flow. A department row
    #: overrides it entirely rather than extending it: a chain that was half
    #: inherited and half local is one nobody can read off the screen.
    department_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("departments.id", ondelete="CASCADE"), nullable=True
    )

    #: The rule this rung belongs to, or NULL for the plain department chain.
    #:
    #: Nullable is what makes rules additive rather than a migration: every
    #: level written before rules existed has NULL here and keeps working
    #: exactly as it did, and a company that never writes a rule sees no change
    #: whatever. CASCADE because a rung without its rule is a chain fragment
    #: belonging to no condition.
    rule_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("workflow_rules.id", ondelete="CASCADE"),
        nullable=True, index=True,
    )

    #: 1-based position in the chain.
    level: Mapped[int] = mapped_column(Integer, nullable=False)
    reviewer_rule: Mapped[str] = mapped_column(
        String(24), default=ReviewerRule.REPORTING_MANAGER.value, nullable=False
    )
    #: Set only for NAMED_USER. SET NULL rather than CASCADE — losing the person
    #: must leave a visibly broken level, not silently delete a rung.
    reviewer_user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    #: Days before this level is auto-forwarded to the next. 0 = never, which
    #: is the default: a chain that moves on by itself is a chain where nobody
    #: noticed the request, and most companies want to be asked first.
    auto_forward_days: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    #: Days before it escalates to ``escalate_to_user_id``. 0 = never.
    escalate_after_days: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    escalate_to_user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    rule: Mapped["WorkflowRule | None"] = relationship(back_populates="levels")


class WorkflowStep(UUIDMixin, TimestampMixin, Base):
    """One rung as it actually happened, on one record.

    ``record_id`` is a bare Uuid with no foreign key, deliberately: steps attach
    to leave applications, expense claims, loans and four other tables, and a
    polymorphic FK is not a thing. ``kind`` says which table, exactly as
    ``AuditLog.target_type`` already does in this codebase.
    """

    __tablename__ = "workflow_steps"
    __table_args__ = (
        # `org_id` leads the constraint even though `record_id` is a UUID that
        # cannot collide across tenants in practice. `record_id` carries no
        # foreign key — it is polymorphic, see the class docstring — so nothing
        # *structurally* ties it to one company, and this codebase's isolation
        # test requires every unique constraint to be provably tenant-scoped
        # rather than scoped by an argument about UUIDs. It caught this.
        UniqueConstraint("org_id", "record_id", "level",
                         name="uq_workflow_steps_record_level"),
        Index("ix_workflow_steps_record", "record_id", "level"),
        # The escalation sweep's query: everything still waiting, oldest first.
        Index("ix_workflow_steps_pending", "org_id", "status"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    kind: Mapped[str] = mapped_column(String(24), nullable=False)
    #: The approved thing. No FK — see the class docstring.
    record_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False, index=True)
    #: Whose request it is. Carried so the escalation sweep and the queue can
    #: name them without one join per step into a table it has to guess.
    subject_user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    level: Mapped[int] = mapped_column(Integer, nullable=False)
    #: Copied from the level that created it, so a reader can see what the rule
    #: *was* even after the configuration changed.
    reviewer_rule: Mapped[str] = mapped_column(String(24), nullable=False)
    #: Resolved when the chain was written. Null means the rule found nobody —
    #: the step is created anyway and shows as unassigned, because a level with
    #: no reviewer is a configuration problem somebody must see.
    reviewer_user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )

    status: Mapped[str] = mapped_column(
        String(12), default=StepStatus.PENDING.value, nullable=False
    )
    #: Who actually acted. Not always ``reviewer_user_id``: a CAPABILITY level
    #: resolves to nobody in particular, and an escalation is decided by the
    #: escalation point rather than the person who was asked first.
    acted_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    acted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    #: When this rung started waiting. The escalation clock runs from here, not
    #: from when the request was filed: a level that waited two days behind a
    #: slow first reviewer has not itself been slow.
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    auto_forward_days: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    escalate_after_days: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    escalate_to_user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    @property
    def status_enum(self) -> StepStatus:
        try:
            return StepStatus(self.status)
        except ValueError:
            return StepStatus.PENDING

    @property
    def is_open(self) -> bool:
        return self.status_enum is StepStatus.PENDING
