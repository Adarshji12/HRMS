"""Appraisals: cycles, goals, competencies and the review itself.

Not to be confused with ``MyPerformance`` in the console, which is activity
analytics — hours and applications. This module is the annual conversation: what
somebody was asked to achieve, what they and their manager think happened, and
the rating that comes out of it.

Four decisions shape every table here.

**A cycle carries its own rating scale, and a review freezes it.** Companies move
from a 1-5 scale to 1-4, or relabel "Meets expectations", and last year's reviews
must not silently rescale. ``ReviewCycle.rating_max`` and ``rating_labels`` are
copied onto :class:`PerformanceReview` when it is finalised, the same way a
payslip freezes its lines and a Form 16 freezes its figures. A "4" without the
scale it was given on is not a rating, it is a digit.

**Weights are basis points and must total 10,000.** Goals are weighted — "30% on
delivery, 50% on quality, 20% on mentoring" — and a set that does not add up
produces a score nobody can defend. The service refuses at submission, the same
way a salary structure refuses when its components do not come to gross. Basis
points rather than percent for the reason every rate in this codebase is:
0.1 + 0.2 in a figure somebody is paid against is a support ticket.

**Scores are computed in hundredths, never floats.** ``score_centi`` is the
weighted mean of the ratings times a hundred, arrived at with one integer
division at the end. A 3.67 that renders as 3.6700000000000004 in one place and
3.67 in another is the kind of thing that ends a performance conversation badly.

**A finalised review is frozen.** The ninth instance of that rule here, after
timesheet approvals, issued letters, salary structures, payslips, Form 16,
expense claim totals, F&F settlements and settlement lines. A rating somebody has
been told, and that a increment was decided from, is a record.
"""

from __future__ import annotations

import enum
import uuid
from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDMixin

#: A rating in hundredths. 367 is 3.67. See the module docstring on why this is
#: not a float.
CENTI = 100

#: Weights are basis points and a goal set must come to exactly this.
FULL_WEIGHT_BPS = 10_000


class CycleStatus(str, enum.Enum):
    """Where an appraisal round is.

    ``DRAFT`` is HR building it — goals can be set, nothing is visible to
    employees. ``OPEN`` is the round running. ``CLOSED`` stops every write:
    reviews still in draft when a cycle closes stay in draft forever, which is
    the honest record of a review nobody completed.
    """

    DRAFT = "draft"
    OPEN = "open"
    CLOSED = "closed"

    @property
    def accepts_writes(self) -> bool:
        return self is CycleStatus.OPEN


class ReviewStatus(str, enum.Enum):
    """One review's journey.

    ``RETURNED`` is a real state and not a synonym for ``DRAFT``: an employee
    whose review comes back needs to know it was looked at and sent back, and a
    silent return to draft looks like their submission was lost.
    """

    DRAFT = "draft"
    #: The employee has had their say. Waiting on the manager.
    SELF_SUBMITTED = "self_submitted"
    #: The manager has had theirs. Waiting on whoever finalises.
    MANAGER_SUBMITTED = "manager_submitted"
    #: Sent back for more. Editable again by the employee.
    RETURNED = "returned"
    #: Frozen. See the module docstring.
    FINALISED = "finalised"

    @property
    def employee_may_edit(self) -> bool:
        return self in (ReviewStatus.DRAFT, ReviewStatus.RETURNED)

    @property
    def is_frozen(self) -> bool:
        return self is ReviewStatus.FINALISED


class ReviewCycle(UUIDMixin, TimestampMixin, Base):
    """One appraisal round for one company."""

    __tablename__ = "review_cycles"
    __table_args__ = (
        UniqueConstraint("org_id", "name", name="uq_review_cycles_org_name"),
        Index("ix_review_cycles_org_status", "org_id", "status"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    #: "FY2025-26 Annual", "H1 2026". A label, not a parsed period.
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    #: The period being appraised — not the window for doing the appraising.
    #: A review written in April is about the year that ended in March.
    period_start: Mapped[date] = mapped_column(Date, nullable=False)
    period_end: Mapped[date] = mapped_column(Date, nullable=False)

    #: When each side may write. Nullable: plenty of companies run an appraisal
    #: round by announcing it in a meeting, and a mandatory deadline nobody set
    #: would be a fabricated one.
    self_review_closes: Mapped[date | None] = mapped_column(Date, nullable=True)
    manager_review_closes: Mapped[date | None] = mapped_column(Date, nullable=True)

    status: Mapped[str] = mapped_column(
        String(16), default=CycleStatus.DRAFT.value, nullable=False
    )

    #: The top of the scale. 5 for the common 1-5; a company using 1-4 sets 4.
    #: There is no configurable minimum — every scale in practice starts at 1,
    #: and a zero rating means "not rated", which is what NULL is for.
    rating_max: Mapped[int] = mapped_column(Integer, default=5, nullable=False)
    #: One label per point, lowest first: ["Needs improvement", ..., "Outstanding"].
    #: Optional — a company that rates on bare numbers is not doing it wrong.
    rating_labels: Mapped[list | None] = mapped_column(JSON, nullable=True)

    #: Whether the employee must submit before the manager may write. False for
    #: companies that run a manager-only appraisal, which is common for
    #: probation reviews and hourly staff.
    requires_self_review: Mapped[bool] = mapped_column(
        Boolean, default=True, nullable=False
    )
    #: Whether goal weights must total 10,000 bps. Off for a cycle rated purely
    #: on competencies, where goals are context rather than the score.
    weights_must_total: Mapped[bool] = mapped_column(
        Boolean, default=True, nullable=False
    )

    closed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    reviews: Mapped[list["PerformanceReview"]] = relationship(
        back_populates="cycle", cascade="all, delete-orphan"
    )
    goals: Mapped[list["PerformanceGoal"]] = relationship(
        back_populates="cycle", cascade="all, delete-orphan"
    )

    @property
    def status_enum(self) -> CycleStatus:
        try:
            return CycleStatus(self.status)
        except ValueError:
            return CycleStatus.DRAFT


class Competency(UUIDMixin, TimestampMixin, Base):
    """One behaviour a company rates people on, company-wide.

    Not per-cycle. A competency framework is a statement about what the company
    values and it outlives any one appraisal round; re-entering it every year
    would guarantee it drifts. Deactivated rather than deleted, because a review
    that rated it has to stay readable.
    """

    __tablename__ = "competencies"
    __table_args__ = (
        UniqueConstraint("org_id", "name", name="uq_competencies_org_name"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class PerformanceGoal(UUIDMixin, TimestampMixin, Base):
    """What one person was asked to achieve in one cycle.

    Ratings live here rather than only on the review because the score is the
    weighted mean of *these*: a review carrying one overall number could not
    answer "which part did I do badly", which is the only question worth asking
    of an appraisal.
    """

    __tablename__ = "performance_goals"
    __table_args__ = (
        Index("ix_performance_goals_cycle_user", "cycle_id", "user_id", "sort_order"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    cycle_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("review_cycles.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )

    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: Basis points. The set must come to 10,000 — see the module docstring.
    weight_bps: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    #: What "done" looks like. Free text on purpose: every attempt to make this
    #: a structured metric ends in a number that misses the point of the goal.
    target: Mapped[str | None] = mapped_column(Text, nullable=True)

    #: Both on the cycle's scale, both nullable — unrated is a real state and is
    #: not the same as rated lowest.
    self_rating: Mapped[int | None] = mapped_column(Integer, nullable=True)
    manager_rating: Mapped[int | None] = mapped_column(Integer, nullable=True)
    self_comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    manager_comment: Mapped[str | None] = mapped_column(Text, nullable=True)

    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    cycle: Mapped["ReviewCycle"] = relationship(back_populates="goals")


class PerformanceReview(UUIDMixin, TimestampMixin, Base):
    """One person's appraisal in one cycle.

    The status columns are named to match ``services.workflow``'s convention
    (``reviewed_by``, ``reviewed_at``, ``review_note``) rather than inventing a
    seventh set of spellings. The manager's decision is driven by the kernel;
    finalisation is not — see ``workflow.PERFORMANCE``.
    """

    __tablename__ = "performance_reviews"
    __table_args__ = (
        # One review per person per cycle. A second is not a correction, it is
        # a contradiction.
        UniqueConstraint("cycle_id", "user_id", name="uq_performance_reviews_cycle_user"),
        Index("ix_performance_reviews_org_status", "org_id", "status"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    cycle_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("review_cycles.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    #: Who is expected to write the manager's half. Captured when the review is
    #: created rather than read live from ``users.manager_id``: a reorganisation
    #: mid-cycle must not hand somebody's appraisal to a manager who did not
    #: watch them work.
    manager_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    status: Mapped[str] = mapped_column(
        String(20), default=ReviewStatus.DRAFT.value, nullable=False
    )

    self_comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    self_submitted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # --- the kernel's columns, spelled the kernel's way ---------------------- #
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    review_note: Mapped[str | None] = mapped_column(Text, nullable=True)

    # --- finalisation --------------------------------------------------------- #
    #: The manager's overall call, on the cycle's scale. Not derived from
    #: ``score_centi``: a weighted mean is evidence, and a manager who wants to
    #: rate somebody above or below what the arithmetic says should have to say
    #: so rather than being quietly overruled by a formula.
    overall_rating: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: Required when ``overall_rating`` disagrees with the computed score by a
    #: whole point or more. Enforced in the service.
    override_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    final_comment: Mapped[str | None] = mapped_column(Text, nullable=True)

    #: The weighted mean of the manager's goal ratings, in hundredths, frozen at
    #: finalisation. Recomputing it later would silently change a rating
    #: somebody was told, because goals can be reweighted for the next cycle.
    score_centi: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: The scale this review was rated on, copied at finalisation. See the
    #: module docstring: a "4" without its scale is a digit.
    rating_max: Mapped[int | None] = mapped_column(Integer, nullable=True)

    finalised_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    finalised_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    #: When the employee saw the final rating. Null means it has not been shared,
    #: which is a different thing from not finalised — HR routinely finalises a
    #: batch and releases them after the increment letters are ready.
    shared_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    cycle: Mapped["ReviewCycle"] = relationship(back_populates="reviews")
    ratings: Mapped[list["CompetencyRating"]] = relationship(
        back_populates="review", cascade="all, delete-orphan",
        order_by="CompetencyRating.sort_order",
    )

    @property
    def status_enum(self) -> ReviewStatus:
        try:
            return ReviewStatus(self.status)
        except ValueError:
            return ReviewStatus.DRAFT


class CompetencyRating(UUIDMixin, TimestampMixin, Base):
    """One competency, rated on one review.

    ``competency_name`` is **copied**, not read through the relationship, for
    the same reason a payslip line copies its component's name: the catalogue is
    configuration an admin edits, and a review that renamed "Ownership" to
    "Accountability" three years later would rewrite what somebody was rated on.
    """

    __tablename__ = "competency_ratings"
    __table_args__ = (
        UniqueConstraint(
            "review_id", "competency_id", name="uq_competency_ratings_review_competency"
        ),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    review_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("performance_reviews.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    #: RESTRICT, matching every other catalogue reference here: a competency a
    #: review used is deactivated, never deleted.
    competency_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("competencies.id", ondelete="RESTRICT"), nullable=False
    )
    competency_name: Mapped[str] = mapped_column(String(120), nullable=False)

    self_rating: Mapped[int | None] = mapped_column(Integer, nullable=True)
    manager_rating: Mapped[int | None] = mapped_column(Integer, nullable=True)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    review: Mapped["PerformanceReview"] = relationship(back_populates="ratings")
