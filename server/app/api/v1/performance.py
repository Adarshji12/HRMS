"""Appraisals over HTTP.

Thin, like every router here: the rules are in ``services/performance.py`` and
this file translates. Two things it does own, because they are presentation
rather than policy:

* **Serialising a review**, which means deciding what to blank when the reader
  is the employee and the rating has not been shared. The service answers
  *whether*; this decides what that looks like on the wire — the rating fields
  are removed rather than sent with a flag, because a client that receives a
  number will eventually render it.
* **The live score**, recomputed on every read until finalisation. It is
  advisory: the frozen ``score_centi`` is what a finalised review carries.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Request, status
from sqlalchemy import func, select

from app.api.deps import AdminUser, CurrentUser, DbSession
from app.models import User
from app.models.performance import PerformanceReview, ReviewStatus
from app.schemas.performance import (
    CompetencyIn,
    CompetencyOut,
    CompetencyRatingOut,
    CompetencyUpdate,
    CycleIn,
    CycleOut,
    CycleStatusIn,
    DecisionIn,
    FinaliseIn,
    GoalOut,
    GoalsIn,
    ManagerReviewIn,
    OpenedOut,
    OpenReviewsIn,
    ReviewOut,
    SelfReviewIn,
)
from app.services import performance as svc

router = APIRouter(prefix="/performance", tags=["performance"])


def _names(db: DbSession, org_id: uuid.UUID) -> dict[uuid.UUID, str]:
    return {
        row.id: row.full_name
        for row in db.scalars(select(User).where(User.org_id == org_id))
    }


def _cycle_out(db, cycle) -> CycleOut:
    out = CycleOut.model_validate(cycle)
    counts = db.execute(
        select(
            func.count(PerformanceReview.id),
            func.count(PerformanceReview.finalised_at),
        ).where(PerformanceReview.cycle_id == cycle.id)
    ).one()
    out.review_count, out.finalised_count = int(counts[0]), int(counts[1])
    return out


def _review_out(db, viewer: User, review, *, names=None) -> ReviewOut:
    names = names if names is not None else _names(db, viewer.org_id)
    cycle = review.cycle
    goals = svc.goals_for(db, review.org_id, review.cycle_id, review.user_id)

    out = ReviewOut.model_validate(review)
    out.user_name = names.get(review.user_id)
    out.manager_name = names.get(review.manager_id) if review.manager_id else None
    out.cycle_name = cycle.name
    out.cycle_rating_max = cycle.rating_max
    out.rating_labels = cycle.rating_labels
    out.goals = [GoalOut.model_validate(goal) for goal in goals]
    out.competencies = [
        CompetencyRatingOut.model_validate(row) for row in review.ratings
    ]
    out.live_score_centi = svc.score_centi(goals)

    out.rating_visible = svc.visible_rating(review, viewer)
    if not out.rating_visible:
        # Removed, not flagged. A client that receives a number will eventually
        # render it, and this one is the number the employee has not been told.
        out.overall_rating = None
        out.score_centi = None
        out.live_score_centi = None
        out.final_comment = None
        out.override_reason = None
        for goal in out.goals:
            goal.manager_rating = None
            goal.manager_comment = None
        for rating in out.competencies:
            rating.manager_rating = None
    return out


# --------------------------------------------------------------------------- #
# Cycles
# --------------------------------------------------------------------------- #


@router.get("/cycles", response_model=list[CycleOut])
def list_cycles(viewer: CurrentUser, db: DbSession) -> list[CycleOut]:
    """Cycles this viewer may see. Drafts are HR's alone — see the service."""
    return [_cycle_out(db, cycle) for cycle in svc.list_cycles(db, viewer)]


@router.post("/cycles", response_model=CycleOut, status_code=status.HTTP_201_CREATED)
def create_cycle(
    payload: CycleIn, admin: AdminUser, db: DbSession, request: Request
) -> CycleOut:
    return _cycle_out(db, svc.create_cycle(db, admin, payload, request=request))


@router.post("/cycles/{cycle_id}/status", response_model=CycleOut)
def set_cycle_status(
    cycle_id: uuid.UUID, payload: CycleStatusIn, admin: AdminUser,
    db: DbSession, request: Request,
) -> CycleOut:
    """Open a cycle, or close it. Closing is one-way — see the service."""
    return _cycle_out(
        db, svc.set_cycle_status(db, admin, cycle_id, payload.status, request=request)
    )


@router.post("/cycles/{cycle_id}/open-reviews", response_model=OpenedOut)
def open_reviews(
    cycle_id: uuid.UUID, payload: OpenReviewsIn, admin: AdminUser,
    db: DbSession, request: Request,
) -> OpenedOut:
    """Create the review records. Idempotent; the count is what was **new**."""
    return OpenedOut(
        created=svc.open_reviews(
            db, admin, cycle_id, user_ids=payload.user_ids or None, request=request
        )
    )


# --------------------------------------------------------------------------- #
# Competencies
# --------------------------------------------------------------------------- #


@router.get("/competencies", response_model=list[CompetencyOut])
def list_competencies(
    viewer: CurrentUser, db: DbSession, include_inactive: bool = False
) -> list[CompetencyOut]:
    return [
        CompetencyOut.model_validate(row)
        for row in svc.list_competencies(db, viewer, include_inactive=include_inactive)
    ]


@router.post("/competencies", response_model=CompetencyOut,
             status_code=status.HTTP_201_CREATED)
def create_competency(
    payload: CompetencyIn, admin: AdminUser, db: DbSession, request: Request
) -> CompetencyOut:
    return CompetencyOut.model_validate(
        svc.create_competency(db, admin, payload, request=request)
    )


@router.patch("/competencies/{competency_id}", response_model=CompetencyOut)
def update_competency(
    competency_id: uuid.UUID, payload: CompetencyUpdate, admin: AdminUser,
    db: DbSession, request: Request,
) -> CompetencyOut:
    """Edit or deactivate. There is no delete: a competency a review rated has
    to stay readable, which is what the RESTRICT on the rating table enforces."""
    return CompetencyOut.model_validate(
        svc.update_competency(db, admin, competency_id, payload, request=request)
    )


# --------------------------------------------------------------------------- #
# Goals
# --------------------------------------------------------------------------- #


@router.get("/cycles/{cycle_id}/goals/{user_id}", response_model=list[GoalOut])
def read_goals(
    cycle_id: uuid.UUID, user_id: uuid.UUID, viewer: CurrentUser, db: DbSession
) -> list[GoalOut]:
    """Somebody's goals. Reached through the review, so its visibility rules
    apply rather than a second set written here."""
    review = db.scalar(select(PerformanceReview).where(
        PerformanceReview.org_id == viewer.org_id,
        PerformanceReview.cycle_id == cycle_id,
        PerformanceReview.user_id == user_id,
    ))
    if review is None:
        raise svc.PerformanceError("not_found", "No review for that person.", 404)
    svc.get_review(db, viewer, review.id)
    return [
        GoalOut.model_validate(goal)
        for goal in svc.goals_for(db, viewer.org_id, cycle_id, user_id)
    ]


@router.put("/cycles/{cycle_id}/goals/{user_id}", response_model=list[GoalOut])
def set_goals(
    cycle_id: uuid.UUID, user_id: uuid.UUID, payload: GoalsIn,
    admin: AdminUser, db: DbSession, request: Request,
) -> list[GoalOut]:
    """Replace a goal set. Refused once the employee has started rating."""
    return [
        GoalOut.model_validate(goal)
        for goal in svc.set_goals(
            db, admin, cycle_id, user_id, payload.goals, request=request
        )
    ]


# --------------------------------------------------------------------------- #
# Reviews
# --------------------------------------------------------------------------- #


@router.get("/cycles/{cycle_id}/reviews", response_model=list[ReviewOut])
def list_reviews(
    cycle_id: uuid.UUID, viewer: CurrentUser, db: DbSession,
    status_filter: str | None = None,
) -> list[ReviewOut]:
    names = _names(db, viewer.org_id)
    return [
        _review_out(db, viewer, review, names=names)
        for review in svc.list_reviews(db, viewer, cycle_id, status=status_filter)
    ]


@router.get("/cycles/{cycle_id}/mine", response_model=ReviewOut | None)
def my_review(
    cycle_id: uuid.UUID, viewer: CurrentUser, db: DbSession
) -> ReviewOut | None:
    """The reader's own review, or null.

    Null rather than 404: "this cycle has not opened reviews yet" is a normal
    state an employee will hit, and a 404 makes the console show an error for
    something that is not one.
    """
    review = svc.my_review(db, viewer, cycle_id)
    return _review_out(db, viewer, review) if review else None


@router.get("/reviews/{review_id}", response_model=ReviewOut)
def read_review(
    review_id: uuid.UUID, viewer: CurrentUser, db: DbSession
) -> ReviewOut:
    return _review_out(db, viewer, svc.get_review(db, viewer, review_id))


@router.post("/reviews/{review_id}/self", response_model=ReviewOut)
def save_self(
    review_id: uuid.UUID, payload: SelfReviewIn, viewer: CurrentUser,
    db: DbSession, request: Request,
) -> ReviewOut:
    """The employee's own half. Only they may write it — see the service."""
    return _review_out(
        db, viewer, svc.save_self(db, viewer, review_id, payload, request=request)
    )


@router.post("/reviews/{review_id}/self/submit", response_model=ReviewOut)
def submit_self(
    review_id: uuid.UUID, viewer: CurrentUser, db: DbSession, request: Request
) -> ReviewOut:
    """Hand it to the manager. One-way, and it checks the weights add up."""
    return _review_out(
        db, viewer, svc.submit_self(db, viewer, review_id, request=request)
    )


@router.post("/reviews/{review_id}/manager", response_model=ReviewOut)
def save_manager(
    review_id: uuid.UUID, payload: ManagerReviewIn, viewer: CurrentUser,
    db: DbSession, request: Request,
) -> ReviewOut:
    """The manager's ratings. Saving is not deciding — see `/decision`."""
    return _review_out(
        db, viewer, svc.save_manager(db, viewer, review_id, payload, request=request)
    )


@router.post("/reviews/{review_id}/decision", response_model=ReviewOut)
def decide(
    review_id: uuid.UUID, payload: DecisionIn, viewer: CurrentUser,
    db: DbSession, request: Request,
) -> ReviewOut:
    """Pass it on, or send it back with a reason.

    Through the approval kernel, so it gets the same guards as every other
    decision here. `/decision` and `{"approve": true}` deliberately match the
    leave route's shape — one client-side handler covers both.
    """
    return _review_out(
        db, viewer,
        svc.decide(db, viewer, review_id, approve=payload.approve,
                   note=payload.note, request=request),
    )


@router.post("/reviews/{review_id}/finalise", response_model=ReviewOut)
def finalise(
    review_id: uuid.UUID, payload: FinaliseIn, admin: AdminUser,
    db: DbSession, request: Request,
) -> ReviewOut:
    """Freeze the rating, and optionally release it in the same call."""
    return _review_out(
        db, admin,
        svc.finalise(db, admin, review_id, share=payload.share, request=request),
    )


@router.post("/reviews/{review_id}/share", response_model=ReviewOut)
def share(
    review_id: uuid.UUID, admin: AdminUser, db: DbSession, request: Request
) -> ReviewOut:
    """Let the employee see their rating. Deliberate and separate."""
    return _review_out(db, admin, svc.share(db, admin, review_id, request=request))
