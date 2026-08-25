"""Shapes for appraisals.

Two conventions run through this file.

**Ratings are integers on the cycle's scale**, and the scale is carried
alongside them — a `4` on the wire is meaningless without the `rating_max` that
went with it, which is why every review output repeats it rather than making the
client remember which cycle it came from.

**Weights are basis points, and scores are hundredths.** `3000` is 30%; `367` is
a rating of 3.67. Both integer, for the reason every rate and every amount in
this codebase is: a float in a figure somebody is appraised on renders
differently in two places and ends the conversation badly. The console divides
at the edge.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, Field

from app.schemas.common import ORMModel


# --------------------------------------------------------------------------- #
# Cycles
# --------------------------------------------------------------------------- #


class CycleIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=4000)
    #: The period being appraised, not the window for doing the appraising.
    period_start: date
    period_end: date
    self_review_closes: date | None = None
    manager_review_closes: date | None = None
    #: The top of the scale. No configurable minimum: every scale in practice
    #: starts at 1, and "not rated" is null rather than zero.
    rating_max: int = Field(default=5, ge=2, le=10)
    #: One label per point, lowest first — or none. A partial list is refused:
    #: a five-point scale with four labels has an unnamed top point that reads
    #: as a bug rather than a choice.
    rating_labels: list[str] | None = None
    requires_self_review: bool = True
    weights_must_total: bool = True


class CycleOut(ORMModel):
    id: uuid.UUID
    org_id: uuid.UUID
    name: str
    description: str | None = None
    period_start: date
    period_end: date
    self_review_closes: date | None = None
    manager_review_closes: date | None = None
    status: str
    rating_max: int
    rating_labels: list[str] | None = None
    requires_self_review: bool
    weights_must_total: bool
    closed_at: datetime | None = None
    created_at: datetime

    #: Filled by the service. How the round is going, without a second call.
    review_count: int = 0
    finalised_count: int = 0


class CycleStatusIn(BaseModel):
    #: `draft` is not accepted: a cycle employees have already seen cannot go
    #: back to being built, and a closed one stays closed.
    status: str = Field(pattern=r"^(open|closed)$")


# --------------------------------------------------------------------------- #
# Competencies
# --------------------------------------------------------------------------- #


class CompetencyIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=4000)
    sort_order: int = Field(default=0, ge=0, le=1000)
    is_active: bool = True


class CompetencyUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=4000)
    sort_order: int | None = Field(default=None, ge=0, le=1000)
    is_active: bool | None = None


class CompetencyOut(ORMModel):
    id: uuid.UUID
    name: str
    description: str | None = None
    sort_order: int
    is_active: bool


# --------------------------------------------------------------------------- #
# Goals
# --------------------------------------------------------------------------- #


class GoalIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=8000)
    target: str | None = Field(default=None, max_length=8000)
    #: Basis points. The set must total 10,000 unless the cycle says otherwise.
    weight_bps: int = Field(default=0, ge=0, le=10_000)


class GoalsIn(BaseModel):
    """A whole goal set. A replace, not a merge — see the service."""

    goals: list[GoalIn] = Field(default_factory=list, max_length=40)


class GoalOut(ORMModel):
    id: uuid.UUID
    title: str
    description: str | None = None
    target: str | None = None
    weight_bps: int
    self_rating: int | None = None
    manager_rating: int | None = None
    self_comment: str | None = None
    manager_comment: str | None = None
    sort_order: int


# --------------------------------------------------------------------------- #
# Writing a review
# --------------------------------------------------------------------------- #


class GoalRatingIn(BaseModel):
    goal_id: uuid.UUID
    #: Null clears a rating. "Not rated" and "rated lowest" are different, and
    #: an employee who rated something by accident needs a way back.
    rating: int | None = Field(default=None, ge=1, le=10)
    comment: str | None = Field(default=None, max_length=8000)


class CompetencyRatingIn(BaseModel):
    competency_id: uuid.UUID
    rating: int | None = Field(default=None, ge=1, le=10)
    comment: str | None = Field(default=None, max_length=8000)


class SelfReviewIn(BaseModel):
    goals: list[GoalRatingIn] = Field(default_factory=list, max_length=40)
    competencies: list[CompetencyRatingIn] = Field(default_factory=list, max_length=40)
    comment: str | None = Field(default=None, max_length=16_000)


class ManagerReviewIn(BaseModel):
    goals: list[GoalRatingIn] = Field(default_factory=list, max_length=40)
    competencies: list[CompetencyRatingIn] = Field(default_factory=list, max_length=40)
    comment: str | None = Field(default=None, max_length=16_000)
    #: The manager's call, on the cycle's scale. **Not** derived from the
    #: weighted score: the arithmetic is evidence, not the decision.
    overall_rating: int | None = Field(default=None, ge=1, le=10)
    #: Required at finalisation when the overall rating and the computed score
    #: differ by a whole point or more.
    override_reason: str | None = Field(default=None, max_length=8000)


class DecisionIn(BaseModel):
    approve: bool
    #: Required on a return — every flow but leave demands one.
    note: str | None = Field(default=None, max_length=8000)


class FinaliseIn(BaseModel):
    #: Release it to the employee in the same call. False by default: HR
    #: routinely finalises a batch and releases them once the increment letters
    #: are ready.
    share: bool = False


# --------------------------------------------------------------------------- #
# Reading one
# --------------------------------------------------------------------------- #


class CompetencyRatingOut(ORMModel):
    id: uuid.UUID
    competency_id: uuid.UUID
    #: Copied at rating time, not read through the catalogue. Renaming a
    #: competency must not rewrite what somebody was rated on.
    competency_name: str
    self_rating: int | None = None
    manager_rating: int | None = None
    comment: str | None = None
    sort_order: int


class ReviewOut(ORMModel):
    id: uuid.UUID
    cycle_id: uuid.UUID
    user_id: uuid.UUID
    manager_id: uuid.UUID | None = None
    status: str
    self_comment: str | None = None
    self_submitted_at: datetime | None = None
    reviewed_by: uuid.UUID | None = None
    reviewed_at: datetime | None = None
    review_note: str | None = None
    overall_rating: int | None = None
    override_reason: str | None = None
    final_comment: str | None = None
    #: The weighted mean in hundredths, frozen at finalisation. Null before it.
    score_centi: int | None = None
    #: The scale this review was rated on, copied at finalisation.
    rating_max: int | None = None
    finalised_at: datetime | None = None
    shared_at: datetime | None = None
    created_at: datetime

    user_name: str | None = None
    manager_name: str | None = None
    cycle_name: str | None = None
    #: The cycle's current scale, for a review not yet finalised. The frozen
    #: `rating_max` above wins once it is set.
    cycle_rating_max: int = 5
    rating_labels: list[str] | None = None

    goals: list[GoalOut] = []
    competencies: list[CompetencyRatingOut] = []

    #: What the weighted score *would* be right now, from the manager's ratings.
    #: Advisory and recomputed on every read until finalisation, which is why it
    #: is not the frozen `score_centi`.
    live_score_centi: int | None = None
    #: False when the reader is the employee and the rating has not been shared.
    #: The rating fields are blanked in that case rather than being sent and
    #: hidden by the client.
    rating_visible: bool = True


class OpenReviewsIn(BaseModel):
    #: Empty means everybody active. A cycle for one department passes ids.
    user_ids: list[uuid.UUID] = Field(default_factory=list, max_length=2000)


class OpenedOut(BaseModel):
    """How many reviews were created. Zero means they already existed."""

    created: int
