"""Onboarding checklists: reusable templates and the per-hire instances cut from them.

The one thing to get right here is that **an instance is a copy, not a reference**.

``OnboardingTemplateTask`` rows are the blueprint an HR admin maintains.
``OnboardingTask`` rows are *instantiated copies* of them, taken at the moment a
hire's checklist is created, and from then on they live their own life. Nothing
in the instance reads through to the template for its title, category, owner or
due date — those values are physically duplicated onto the instance row.

That duplication is the feature. A checklist is the record of what one specific
person was actually asked to do, and sign-off, audit and compliance all depend
on it not changing underneath them. If instances pointed at template rows, then
editing the template — renaming a task, reordering it, deleting one that is no
longer relevant for *future* hires — would retroactively rewrite the in-flight
checklist of every hire already part-way through it, and a task somebody
completed last week could silently become a different task. Templates must stay
freely editable without that blast radius, so we pay for it in duplicated
strings, which is the cheap side of the trade.

``source_template_task_id`` survives on the copy, but only as provenance ("which
blueprint row produced this"), for template-effectiveness reporting. It is
``SET NULL`` and nothing user-visible is ever resolved through it.

Timing follows the same split. The template carries ``due_offset_days``,
relative to the hire's joining date, because a blueprint cannot know a date.
Instantiation resolves that against ``OnboardingInstance.joining_date`` and
writes a concrete ``due_date`` onto the copy (Phase 6 service work). Once
written it does not drift when the offset on the template is later edited.
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
    Uuid,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDMixin

if TYPE_CHECKING:
    from app.models.user import User


class OnboardingCategory(str, enum.Enum):
    """What kind of work a checklist item is. Drives the grouped HR view."""

    DOCUMENTATION = "documentation"
    IT_SETUP = "it_setup"
    TRAINING = "training"
    COMPLIANCE = "compliance"
    OTHER = "other"


#: Display order for the grouped pipeline view. Kept next to the enum rather
#: than in the console so an export and the UI agree on one ordering.
CATEGORY_ORDER: tuple[str, ...] = (
    OnboardingCategory.DOCUMENTATION.value,
    OnboardingCategory.IT_SETUP.value,
    OnboardingCategory.TRAINING.value,
    OnboardingCategory.COMPLIANCE.value,
    OnboardingCategory.OTHER.value,
)

# IT_SETUP is the seam Asset Management plugs into: an asset assignment (laptop,
# SIM, ID card) is raised against a task in this category, so an `it_setup` task
# and an `asset_assignments` row are the same event seen from two sides. Assets
# stays usable standalone — nothing in this module reaches into it, and the join
# is made by the service layer in a later phase. Do not repurpose this value;
# the asset module keys off the literal string.


class OnboardingOwnerRole(str, enum.Enum):
    """Which desk is accountable for a checklist item.

    Deliberately *not* ``models.user.Role``. "IT" is not an org role in this
    product, and "employee" here means the new hire specifically, not the role
    of whoever acts. Reusing ``Role`` would force every tenant to invent an IT
    role purely so a checklist could describe itself.
    """

    HR = "hr"
    MANAGER = "manager"
    IT = "it"
    EMPLOYEE = "employee"


class OnboardingInstanceStatus(str, enum.Enum):
    """Lifecycle of one hire's checklist.

    ``PENDING_SETUP`` is the same value and the same meaning as
    ``organizations.status`` already uses: the row exists and work can begin
    against it, but the subject cannot log in yet. For onboarding that is
    pre-boarding — HR collects documents and IT orders a laptop days before day
    one, against a ``users`` row with no password and no enrolled device.
    """

    PENDING_SETUP = "pending_setup"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    CANCELLED = "cancelled"

    @property
    def is_open(self) -> bool:
        """True while the checklist still belongs in the HR pipeline view."""
        return self in (
            OnboardingInstanceStatus.PENDING_SETUP,
            OnboardingInstanceStatus.IN_PROGRESS,
        )


class OnboardingTaskStatus(str, enum.Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    DONE = "done"
    SKIPPED = "skipped"

    @property
    def is_closed(self) -> bool:
        """Closed means "needs no further action", which includes SKIPPED.

        Progress and overdue counts both use this. A skipped task must not hold
        a checklist at 90% forever — "not applicable to this hire" is a
        legitimate ending. It stays distinct from DONE so an audit can still
        tell "we did it" from "we decided not to".
        """
        return self in (OnboardingTaskStatus.DONE, OnboardingTaskStatus.SKIPPED)


class OnboardingTemplate(UUIDMixin, TimestampMixin, Base):
    """A checklist blueprint an admin builds once per role or department."""

    __tablename__ = "onboarding_templates"
    __table_args__ = (
        UniqueConstraint("org_id", "name", name="uq_onboarding_template_org_name"),
        Index("ix_onboarding_templates_org_dept", "org_id", "department_id"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    # NULL means "applies to every department" — the org-wide fallback. Template
    # selection at instantiation is therefore: the active template for the
    # hire's department if one exists, otherwise the department-less one.
    #
    # SET NULL rather than CASCADE: deleting a department must widen its
    # template to org-wide, never destroy a checklist an admin spent an
    # afternoon building.
    department_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("departments.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # Retiring a template must not delete it: instances name it for provenance,
    # and an admin who un-retires it next quarter expects its tasks to still be
    # there. Inactive templates are simply skipped when picking one.
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    tasks: Mapped[list["OnboardingTemplateTask"]] = relationship(
        back_populates="template",
        cascade="all, delete-orphan",
        order_by="OnboardingTemplateTask.sort_order",
    )


class OnboardingTemplateTask(UUIDMixin, TimestampMixin, Base):
    """One blueprint row. Never assigned to anybody — it is copied first."""

    __tablename__ = "onboarding_template_tasks"
    __table_args__ = (
        Index("ix_onboarding_tmpl_tasks_template_order", "template_id", "sort_order"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    template_id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        ForeignKey("onboarding_templates.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    category: Mapped[str] = mapped_column(
        String(20), default=OnboardingCategory.OTHER.value, nullable=False
    )
    owner_role: Mapped[str] = mapped_column(
        String(20), default=OnboardingOwnerRole.HR.value, nullable=False
    )

    # Days relative to the hire's joining date. Negative is the normal case for
    # pre-boarding ("offer letter countersigned", -7), zero is day one, positive
    # is the first-weeks tail. A blueprint has no date by definition; the
    # concrete one is computed onto the instantiated copy.
    due_offset_days: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # Named sort_order, not `order`: ORDER is a reserved word in SQL and every
    # hand-written report query would otherwise have to quote it.
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    # A task that exists to collect a file ("upload your PAN card"). Without
    # these, onboarding_documents.doc_type has no vocabulary and nothing tells
    # HR which documents a hire still owes. Both fields are copied onto the
    # instantiated task, and an OnboardingDocument points back at the task it
    # satisfies.
    requires_document: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    doc_type: Mapped[str | None] = mapped_column(String(64), nullable=True)

    template: Mapped["OnboardingTemplate"] = relationship(back_populates="tasks")


class OnboardingInstance(UUIDMixin, TimestampMixin, Base):
    """One hire's checklist run.

    Created when a user is added with a joining date of today or later. That
    user row may still be in a pre-login state — see
    ``OnboardingInstanceStatus.PENDING_SETUP`` — which is the whole point of
    pre-boarding.
    """

    __tablename__ = "onboarding_instances"
    __table_args__ = (
        # The HR pipeline lists open instances for the org, soonest joiners
        # first; these are the two indexes that view runs on.
        Index("ix_onboarding_instances_org_status", "org_id", "status"),
        Index("ix_onboarding_instances_org_joining", "org_id", "joining_date"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # No unique constraint on (org_id, user_id): a rehire, or a transfer that
    # warrants a fresh checklist, is a second legitimate instance for the same
    # person. The service enforces "at most one *open* instance"; the schema
    # does not, because a partial unique index on status is not portable to the
    # SQLite deployments this product also runs on.
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )

    # Nullable + SET NULL: a template can be deleted, and an ad-hoc checklist
    # can be built with no template at all. Neither may take a hire's tasks
    # with it — the tasks are copies and stand on their own.
    template_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("onboarding_templates.id", ondelete="SET NULL"), nullable=True
    )
    # The template's name as it read at instantiation. Snapshotted for the same
    # reason the tasks are copied: "which checklist did this person get" must
    # still answer correctly after the template is renamed or deleted.
    template_name: Mapped[str | None] = mapped_column(String(200), nullable=True)

    # The anchor every due_offset_days is resolved against. Date, not DateTime:
    # this is a calendar day in the org's timezone, never a UTC instant. Copied
    # from users.joined_on at creation rather than read through it, so moving a
    # hire's start date is an explicit reschedule of the checklist, not a
    # silent one that quietly re-dates tasks people already completed.
    joining_date: Mapped[date] = mapped_column(Date, nullable=False)

    status: Mapped[str] = mapped_column(
        String(24),
        default=OnboardingInstanceStatus.PENDING_SETUP.value,
        nullable=False,
        index=True,
    )
    # Stamped when the first task leaves PENDING and when the last one closes.
    # Stored rather than derived so "time to onboard" reporting reads two
    # columns instead of scanning every task row of every instance.
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    user: Mapped["User"] = relationship(foreign_keys=[user_id])
    template: Mapped["OnboardingTemplate | None"] = relationship(foreign_keys=[template_id])
    tasks: Mapped[list["OnboardingTask"]] = relationship(
        back_populates="instance",
        cascade="all, delete-orphan",
        order_by="OnboardingTask.sort_order",
    )
    documents: Mapped[list["OnboardingDocument"]] = relationship(
        back_populates="instance", cascade="all, delete-orphan"
    )

    @property
    def status_enum(self) -> OnboardingInstanceStatus:
        try:
            return OnboardingInstanceStatus(self.status)
        except ValueError:
            return OnboardingInstanceStatus.PENDING_SETUP


class OnboardingTask(UUIDMixin, TimestampMixin, Base):
    """An instantiated copy of a template task. See the module docstring."""

    __tablename__ = "onboarding_tasks"
    __table_args__ = (
        Index("ix_onboarding_tasks_instance_status", "instance_id", "status"),
        # "What is overdue across the company" — the HR nag list.
        Index("ix_onboarding_tasks_org_due", "org_id", "due_date", "status"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    instance_id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        ForeignKey("onboarding_instances.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Provenance only — "which blueprint row produced this copy" — so we can
    # report on how well a template actually works. Nothing shown to a user is
    # resolved through it, and it going NULL when the template row is deleted
    # costs nothing but that reporting link.
    source_template_task_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("onboarding_template_tasks.id", ondelete="SET NULL"), nullable=True
    )

    # --- copied from the template task at instantiation ----------------------
    # Duplicated on purpose. Editing the template must not rewrite a checklist
    # somebody is already working through.
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    category: Mapped[str] = mapped_column(
        String(20), default=OnboardingCategory.OTHER.value, nullable=False
    )
    owner_role: Mapped[str] = mapped_column(
        String(20), default=OnboardingOwnerRole.HR.value, nullable=False
    )
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    requires_document: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    doc_type: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # --- resolved at instantiation -------------------------------------------
    # joining_date + the template task's due_offset_days, computed once.
    # Nullable because a task added to one checklist by hand may genuinely have
    # no deadline.
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    # owner_role says which desk owns this; this says which person, once
    # somebody resolves the role (the hire's manager, the on-duty IT admin).
    # Both are kept: the role outlives the individual leaving the company.
    #
    # Spelled ``assignee_user_id`` — the agent noun — deliberately, and it is
    # load-bearing in three modules at once. ``models/project.py:Task`` is the
    # pre-existing task table and already spells it this way; additive-only
    # means that column can never be renamed, so it is the anchor and we match
    # it rather than the other way round. ``models/offboarding.py`` matches it
    # too, so every "who owns this task" column in the product reads the same.
    # The derived display field is ``assignee_name`` for the same reason —
    # ``api/v1/projects.py`` already serves that key. Do not "tidy" this back
    # to the passive participle to match the neighbouring ``assigned``-style
    # prose: that reintroduces two names for one concept across three modules,
    # and by then a rename migration is the only way out of it.
    assignee_user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )

    status: Mapped[str] = mapped_column(
        String(20), default=OnboardingTaskStatus.PENDING.value, nullable=False
    )
    completed_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Why it was skipped, or what was actually done. Free text on purpose —
    # this is the field somebody reads a year later when the hire disputes it.
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    instance: Mapped["OnboardingInstance"] = relationship(back_populates="tasks")
    documents: Mapped[list["OnboardingDocument"]] = relationship(back_populates="task")

    @property
    def status_enum(self) -> OnboardingTaskStatus:
        try:
            return OnboardingTaskStatus(self.status)
        except ValueError:
            return OnboardingTaskStatus.PENDING

    def is_overdue(self, today: date) -> bool:
        """``today`` is passed in: the caller knows the org's timezone, we don't."""
        if self.due_date is None or self.status_enum.is_closed:
            return False
        return self.due_date < today


class OnboardingDocument(UUIDMixin, TimestampMixin, Base):
    """A file collected during onboarding — a signed offer letter, an ID proof.

    The bytes never touch the database. ``storage_key`` is the same opaque key
    ``services/storage.py`` already mints for screenshots, served by the same
    backend (local disk or S3-compatible) behind the same permission check:
    one storage mechanism for the product, not two. Nothing outside that module
    may build or parse the key.
    """

    __tablename__ = "onboarding_documents"
    __table_args__ = (Index("ix_onboarding_docs_instance_type", "instance_id", "doc_type"),)

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    instance_id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        ForeignKey("onboarding_instances.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Which checklist item this upload satisfies, when it satisfies one. HR also
    # collects documents nobody put on the checklist, so it is nullable, and
    # SET NULL keeps the file when the task it answered is removed — deleting a
    # checklist row must never orphan a signed contract.
    task_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("onboarding_tasks.id", ondelete="SET NULL"), nullable=True, index=True
    )

    # Free-form rather than an enum: the required document set is
    # jurisdictional (PAN and Aadhaar here, an I-9 elsewhere) and a tenant must
    # be able to add one without a deploy.
    doc_type: Mapped[str] = mapped_column(String(64), nullable=False)
    storage_key: Mapped[str] = mapped_column(String(255), nullable=False)
    # As uploaded, for the download filename. The storage key is opaque and
    # deliberately carries nothing human-meaningful.
    file_name: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    content_type: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    file_size: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    # SET NULL on both: the uploader or the verifier leaving the company must
    # not delete the document, and "verified by someone who has since left" is
    # a materially better audit record than no row at all.
    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    verified_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # A null verified_at is the only signal of "not checked yet". There is no
    # separate boolean, so there is nothing to fall out of sync with it.
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    verification_note: Mapped[str | None] = mapped_column(Text, nullable=True)

    instance: Mapped["OnboardingInstance"] = relationship(back_populates="documents")
    task: Mapped["OnboardingTask | None"] = relationship(back_populates="documents")

    @property
    def is_verified(self) -> bool:
        return self.verified_at is not None
