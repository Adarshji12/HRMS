"""Appraisals: who may write what, when, and how a score is arrived at.

The shape of a review here is a conversation with three turns and one rule about
each of them:

1. **The employee writes first**, rating their own goals and saying what
   happened. They may edit until they submit; after that the text is theirs and
   the manager cannot change it. An appraisal where the manager can rewrite the
   employee's own words is not an appraisal.
2. **The manager decides.** That is a decision in the sense
   :mod:`app.services.workflow` means — approve it onward or send it back with a
   reason — so it goes through the kernel and gets the same guards every other
   approval in this system gets, including "not your own".
3. **Somebody finalises**, which freezes the rating. Finalisation is not driven
   by the kernel and ``workflow.PERFORMANCE`` says so: it is a second decision on
   the same record, and the kernel writes one set of reviewer columns.

Three things the arithmetic gets right on purpose
-------------------------------------------------

**Weights are basis points and must total 10,000.** Refused at submission, with
the shortfall named — the same refusal a salary structure gives when its
components do not come to gross. A weighted mean over weights that do not sum is
a number with no meaning that still renders as a rating.

**The score is integer hundredths, computed with one division at the end.**
``sum(weight_bps * rating) // 100`` over weights totalling 10,000 gives the
weighted mean times a hundred. No float touches a rating at any point.

**The computed score does not overrule the manager.** ``overall_rating`` is the
manager's call and is stored as given. When it disagrees with the arithmetic by a
whole point or more the service demands a reason — not because the manager is
wrong, but because "the numbers said 2.9 and the rating is 4" is the single most
challenged sentence in any appraisal and somebody should have written down why
before it is challenged.

Visibility
----------

An employee sees their own review always, and the **final rating only once it has
been shared**. HR routinely finalises a batch in one afternoon and releases them
when the increment letters are ready; a review that leaked its rating the moment
it was finalised would break that, and companies would stop using the system to
finalise. ``shared_at`` is the switch and it is a deliberate act.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date, datetime, timezone

from fastapi import HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import audit
from app.models import Role, User
from app.models.performance import (
    FULL_WEIGHT_BPS,
    Competency,
    CompetencyRating,
    CycleStatus,
    PerformanceGoal,
    PerformanceReview,
    ReviewCycle,
    ReviewStatus,
)
from app.services import hierarchy
from app.services import workflow


class PerformanceError(HTTPException):
    """A typed refusal, in the house style. ``{"reason", "message"}``."""

    def __init__(self, code: str, message: str, status_code: int = 422) -> None:
        super().__init__(status_code, detail={"reason": code, "message": message})
        self.code = code


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------- #
# Permissions
# --------------------------------------------------------------------------- #


def can_manage(viewer: User) -> bool:
    """Whether this person runs appraisals for the company.

    Administrators, restricted by the flag — which follows the house rule that
    a permission flag narrows and never widens, and defaults True. Running an
    appraisal round is HR's job and is not sensitive in the way payroll is, so
    it does not get payroll's opt-in treatment.
    """
    return viewer.role_enum.can_administer and getattr(
        viewer, "can_manage_performance", True
    )


def _require_manager_role(viewer: User) -> None:
    if not can_manage(viewer):
        raise PerformanceError(
            "not_permitted", "You may not manage appraisals.", 403
        )


# --------------------------------------------------------------------------- #
# Cycles
# --------------------------------------------------------------------------- #


def get_cycle(db: Session, org_id: uuid.UUID, cycle_id: uuid.UUID) -> ReviewCycle:
    """The cycle, or 404 — never another company's.

    404 rather than 403 on a cross-tenant miss, matching every other module: a
    403 confirms the id exists somewhere, which leaks across the boundary it is
    meant to defend.
    """
    row = db.get(ReviewCycle, cycle_id)
    if row is None or row.org_id != org_id:
        raise PerformanceError("not_found", "No such review cycle.", 404)
    return row


def list_cycles(db: Session, viewer: User) -> list[ReviewCycle]:
    """Cycles this viewer may see.

    Everybody sees open and closed cycles — an employee has to know their
    appraisal round exists. **Drafts are HR's alone**: a cycle being built has
    half its goals set and no dates agreed, and an employee seeing it would ask
    about a round that may never run.
    """
    stmt = select(ReviewCycle).where(ReviewCycle.org_id == viewer.org_id)
    if not can_manage(viewer):
        stmt = stmt.where(ReviewCycle.status != CycleStatus.DRAFT.value)
    return list(db.scalars(stmt.order_by(ReviewCycle.period_end.desc())))


def create_cycle(
    db: Session, viewer: User, payload, *, request: Request | None = None
) -> ReviewCycle:
    _require_manager_role(viewer)
    if payload.period_end < payload.period_start:
        raise PerformanceError(
            "bad_period", "The period ends before it starts."
        )
    _check_labels(payload.rating_max, payload.rating_labels)

    cycle = ReviewCycle(
        org_id=viewer.org_id,
        name=payload.name.strip(),
        description=(payload.description or "").strip() or None,
        period_start=payload.period_start,
        period_end=payload.period_end,
        self_review_closes=payload.self_review_closes,
        manager_review_closes=payload.manager_review_closes,
        rating_max=payload.rating_max,
        rating_labels=payload.rating_labels or None,
        requires_self_review=payload.requires_self_review,
        weights_must_total=payload.weights_must_total,
        status=CycleStatus.DRAFT.value,
    )
    db.add(cycle)
    db.flush()
    audit(db, org_id=viewer.org_id, actor=viewer, action="performance.cycle_created",
          request=request, target_type="review_cycle", target_id=str(cycle.id),
          detail={"name": cycle.name, "period": f"{cycle.period_start}..{cycle.period_end}"})
    db.commit()
    db.refresh(cycle)
    return cycle


def _check_labels(rating_max: int, labels) -> None:
    """A label per point, or none at all.

    A partial label list is worse than none: the console renders labels where it
    has them and bare numbers where it does not, so a four-label list on a
    five-point scale produces a scale whose top point is unnamed and looks like
    a bug rather than a choice.
    """
    if labels and len(labels) != rating_max:
        raise PerformanceError(
            "label_count",
            f"A {rating_max}-point scale needs {rating_max} labels or none — "
            f"{len(labels)} were given.",
        )


def set_cycle_status(
    db: Session, viewer: User, cycle_id: uuid.UUID, status: str,
    *, request: Request | None = None,
) -> ReviewCycle:
    """Open a cycle, or close it.

    Closing is one-way. Reopening a closed cycle would let somebody edit a
    review after the increment was decided from it, and "we closed it by
    mistake" is answered by a new cycle rather than by unfreezing an old one.
    """
    _require_manager_role(viewer)
    cycle = get_cycle(db, viewer.org_id, cycle_id)
    target = CycleStatus(status)

    if cycle.status_enum is CycleStatus.CLOSED:
        raise PerformanceError(
            "cycle_closed",
            "A closed cycle stays closed. Start a new one rather than reopening "
            "a round somebody's increment was decided from.",
            409,
        )
    if target is CycleStatus.DRAFT:
        raise PerformanceError(
            "no_unopen",
            "A cycle cannot go back to draft — employees have already seen it.",
        )

    cycle.status = target.value
    if target is CycleStatus.CLOSED:
        cycle.closed_at = _now()
    audit(db, org_id=viewer.org_id, actor=viewer,
          action=f"performance.cycle_{target.value}", request=request,
          target_type="review_cycle", target_id=str(cycle.id),
          detail={"name": cycle.name})
    db.commit()
    db.refresh(cycle)
    return cycle


# --------------------------------------------------------------------------- #
# Competencies
# --------------------------------------------------------------------------- #


def list_competencies(
    db: Session, viewer: User, *, include_inactive: bool = False
) -> list[Competency]:
    stmt = select(Competency).where(Competency.org_id == viewer.org_id)
    if not include_inactive:
        stmt = stmt.where(Competency.is_active.is_(True))
    return list(db.scalars(stmt.order_by(Competency.sort_order, Competency.name)))


def create_competency(
    db: Session, viewer: User, payload, *, request: Request | None = None
) -> Competency:
    _require_manager_role(viewer)
    existing = db.scalar(
        select(Competency).where(
            Competency.org_id == viewer.org_id,
            Competency.name == payload.name.strip(),
        )
    )
    if existing is not None:
        raise PerformanceError(
            "duplicate_name",
            f"“{payload.name.strip()}” already exists. Reactivate it rather than "
            "creating a second one — two competencies with one name make every "
            "report ambiguous.",
            409,
        )
    row = Competency(
        org_id=viewer.org_id, name=payload.name.strip(),
        description=(payload.description or "").strip() or None,
        sort_order=payload.sort_order, is_active=payload.is_active,
    )
    db.add(row)
    db.flush()
    audit(db, org_id=viewer.org_id, actor=viewer,
          action="performance.competency_created", request=request,
          target_type="competency", target_id=str(row.id),
          detail={"name": row.name})
    db.commit()
    db.refresh(row)
    return row


def update_competency(
    db: Session, viewer: User, competency_id: uuid.UUID, payload,
    *, request: Request | None = None,
) -> Competency:
    _require_manager_role(viewer)
    row = db.get(Competency, competency_id)
    if row is None or row.org_id != viewer.org_id:
        raise PerformanceError("not_found", "No such competency.", 404)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(row, field, value.strip() if isinstance(value, str) else value)
    audit(db, org_id=viewer.org_id, actor=viewer,
          action="performance.competency_updated", request=request,
          target_type="competency", target_id=str(row.id),
          detail={"name": row.name, "active": row.is_active})
    db.commit()
    db.refresh(row)
    return row


# --------------------------------------------------------------------------- #
# Reviews
# --------------------------------------------------------------------------- #


def get_review(db: Session, viewer: User, review_id: uuid.UUID) -> PerformanceReview:
    """A review this viewer may see, or 404.

    Three ways to be allowed: it is yours, you are the manager it was assigned
    to, or you run appraisals. Line management is read from the **review**, not
    from ``users.manager_id`` — a reorganisation mid-cycle must not hand
    somebody's appraisal to a manager who did not watch them work, and it must
    not take it away from the one who did.
    """
    row = db.get(PerformanceReview, review_id)
    if row is None or row.org_id != viewer.org_id:
        raise PerformanceError("not_found", "No such review.", 404)
    if row.user_id == viewer.id or row.manager_id == viewer.id or can_manage(viewer):
        return row
    raise PerformanceError("not_found", "No such review.", 404)


def open_reviews(
    db: Session, viewer: User, cycle_id: uuid.UUID,
    *, user_ids: list[uuid.UUID] | None = None, request: Request | None = None,
) -> int:
    """Create the review records for a cycle. Idempotent.

    Returns how many were **newly** created — zero means they already existed,
    which is information rather than a failure, the same contract
    ``payoutputs.file_payslips`` uses.

    Each review captures its manager at creation. See
    :class:`PerformanceReview.manager_id` for why that is a copy.
    """
    _require_manager_role(viewer)
    cycle = get_cycle(db, viewer.org_id, cycle_id)
    if cycle.status_enum is CycleStatus.CLOSED:
        raise PerformanceError(
            "cycle_closed", "That cycle is closed.", 409
        )

    stmt = select(User).where(
        User.org_id == viewer.org_id, User.is_active.is_(True)
    )
    if user_ids:
        stmt = stmt.where(User.id.in_(user_ids))
    people = list(db.scalars(stmt))

    already = {
        row.user_id for row in db.scalars(
            select(PerformanceReview).where(PerformanceReview.cycle_id == cycle.id)
        )
    }
    made = 0
    for person in people:
        if person.id in already:
            continue
        db.add(PerformanceReview(
            org_id=viewer.org_id, cycle_id=cycle.id, user_id=person.id,
            manager_id=person.manager_id, status=ReviewStatus.DRAFT.value,
        ))
        made += 1
    db.flush()
    audit(db, org_id=viewer.org_id, actor=viewer, action="performance.reviews_opened",
          request=request, target_type="review_cycle", target_id=str(cycle.id),
          detail={"cycle": cycle.name, "created": made, "existing": len(already)})
    db.commit()
    return made


def my_review(
    db: Session, viewer: User, cycle_id: uuid.UUID
) -> PerformanceReview | None:
    return db.scalar(
        select(PerformanceReview).where(
            PerformanceReview.org_id == viewer.org_id,
            PerformanceReview.cycle_id == cycle_id,
            PerformanceReview.user_id == viewer.id,
        )
    )


def list_reviews(
    db: Session, viewer: User, cycle_id: uuid.UUID, *, status: str | None = None
) -> list[PerformanceReview]:
    """Reviews in a cycle, scoped to what this viewer may see.

    HR sees the cycle. A manager sees the reviews **assigned to them** — not
    their whole reporting subtree, because the assignment is the record of who
    was meant to write it and the subtree is who reports to them today. Anyone
    else sees their own.
    """
    stmt = select(PerformanceReview).where(
        PerformanceReview.org_id == viewer.org_id,
        PerformanceReview.cycle_id == cycle_id,
    )
    if not can_manage(viewer):
        stmt = stmt.where(
            (PerformanceReview.manager_id == viewer.id)
            | (PerformanceReview.user_id == viewer.id)
        )
    if status:
        stmt = stmt.where(PerformanceReview.status == status)
    return list(db.scalars(stmt))


# --------------------------------------------------------------------------- #
# Goals
# --------------------------------------------------------------------------- #


def goals_for(
    db: Session, org_id: uuid.UUID, cycle_id: uuid.UUID, user_id: uuid.UUID
) -> list[PerformanceGoal]:
    return list(db.scalars(
        select(PerformanceGoal).where(
            PerformanceGoal.org_id == org_id,
            PerformanceGoal.cycle_id == cycle_id,
            PerformanceGoal.user_id == user_id,
        ).order_by(PerformanceGoal.sort_order, PerformanceGoal.created_at)
    ))


def set_goals(
    db: Session, viewer: User, cycle_id: uuid.UUID, user_id: uuid.UUID,
    goals, *, request: Request | None = None,
) -> list[PerformanceGoal]:
    """Replace somebody's goals for a cycle.

    A replace rather than a merge, the same choice payroll's compute makes: a
    merge leaves a goal from a draft nobody wanted and a weight that no longer
    fits, and those are the rows nobody notices until the score is wrong.

    **Goals may not be changed once the review has left draft.** Moving the
    target after somebody has rated themselves against it is the thing an
    appraisal system must not permit.
    """
    _require_manager_role(viewer)
    cycle = get_cycle(db, viewer.org_id, cycle_id)
    if cycle.status_enum is CycleStatus.CLOSED:
        raise PerformanceError("cycle_closed", "That cycle is closed.", 409)

    review = db.scalar(select(PerformanceReview).where(
        PerformanceReview.cycle_id == cycle_id,
        PerformanceReview.user_id == user_id,
    ))
    if review is not None and not review.status_enum.employee_may_edit:
        raise PerformanceError(
            "review_in_progress",
            f"That review is {review.status}. Goals cannot move after somebody "
            "has rated themselves against them.",
            409,
        )

    for existing in goals_for(db, viewer.org_id, cycle_id, user_id):
        db.delete(existing)
    db.flush()

    made = []
    for order, goal in enumerate(goals):
        if not 0 <= goal.weight_bps <= FULL_WEIGHT_BPS:
            raise PerformanceError(
                "bad_weight",
                f"“{goal.title}” has a weight outside 0–100%.",
            )
        row = PerformanceGoal(
            org_id=viewer.org_id, cycle_id=cycle_id, user_id=user_id,
            title=goal.title.strip(),
            description=(goal.description or "").strip() or None,
            target=(goal.target or "").strip() or None,
            weight_bps=goal.weight_bps, sort_order=order,
        )
        db.add(row)
        made.append(row)
    db.flush()
    audit(db, org_id=viewer.org_id, actor=viewer, action="performance.goals_set",
          request=request, target_type="review_cycle", target_id=str(cycle_id),
          detail={"for": str(user_id), "goals": len(made),
                  "total_weight_bps": sum(g.weight_bps for g in made)})
    db.commit()
    return goals_for(db, viewer.org_id, cycle_id, user_id)


def check_weights(cycle: ReviewCycle, goals: list[PerformanceGoal]) -> None:
    """Refuse a goal set that does not add up.

    Named shortfall, not a bare "invalid": somebody staring at eight goals needs
    to be told they are 500 basis points short, not that something is wrong.
    """
    if not cycle.weights_must_total or not goals:
        return
    total = sum(goal.weight_bps for goal in goals)
    if total != FULL_WEIGHT_BPS:
        raise PerformanceError(
            "weights_do_not_total",
            f"The goal weights come to {total / 100:g}% and must come to 100%. "
            f"{'Add' if total < FULL_WEIGHT_BPS else 'Remove'} "
            f"{abs(total - FULL_WEIGHT_BPS) / 100:g}%.",
        )


# --------------------------------------------------------------------------- #
# Scoring
# --------------------------------------------------------------------------- #


def score_centi(goals: list[PerformanceGoal], *, manager: bool = True) -> int | None:
    """The weighted mean rating, in hundredths. ``None`` when nothing is rated.

    One integer division, at the end. ``sum(weight_bps * rating)`` over weights
    totalling 10,000 and a rating of 1-5 lands between 10,000 and 50,000, and
    ``// 100`` turns that into 100-500 — the rating times a hundred. No float
    touches it, for the reason the module docstring gives.

    Rated goals only, and the weights are renormalised over them: an unrated
    goal must not drag the mean toward zero, because "not rated" and "rated
    lowest" are different and the model keeps them different.
    """
    rated = [
        (goal.weight_bps, goal.manager_rating if manager else goal.self_rating)
        for goal in goals
    ]
    rated = [(weight, rating) for weight, rating in rated if rating is not None and weight]
    if not rated:
        return None
    total_weight = sum(weight for weight, _ in rated)
    return sum(weight * rating for weight, rating in rated) * 100 // total_weight


def _check_rating(cycle: ReviewCycle, value: int | None, *, what: str) -> None:
    if value is None:
        return
    if not 1 <= value <= cycle.rating_max:
        raise PerformanceError(
            "rating_out_of_scale",
            f"{what} is {value}, and this cycle rates 1 to {cycle.rating_max}.",
        )


# --------------------------------------------------------------------------- #
# The three turns
# --------------------------------------------------------------------------- #


def save_self(
    db: Session, viewer: User, review_id: uuid.UUID, payload,
    *, request: Request | None = None,
) -> PerformanceReview:
    """The employee's own ratings and words. Theirs alone.

    Only the subject may call this — not their manager, not HR. An appraisal
    where somebody else can write the employee's half is not an appraisal, and
    "I did not say that" is unanswerable once it is possible.
    """
    review = get_review(db, viewer, review_id)
    if review.user_id != viewer.id:
        raise PerformanceError(
            "not_yours",
            "Only the employee writes their own half of a review.", 403,
        )
    if not review.status_enum.employee_may_edit:
        raise PerformanceError(
            "already_submitted",
            f"Your review is {review.status} and can no longer be edited.", 409,
        )
    cycle = get_cycle(db, viewer.org_id, review.cycle_id)
    _require_open(cycle)

    goals = {g.id: g for g in goals_for(db, viewer.org_id, review.cycle_id, viewer.id)}
    for entry in payload.goals:
        goal = goals.get(entry.goal_id)
        if goal is None:
            raise PerformanceError("goal_not_found", "That goal is not on your review.", 404)
        _check_rating(cycle, entry.rating, what=f"“{goal.title}”")
        goal.self_rating = entry.rating
        goal.self_comment = (entry.comment or "").strip() or None

    _save_competencies(db, viewer, review, cycle, payload.competencies, manager=False)
    review.self_comment = (payload.comment or "").strip() or None
    db.commit()
    db.refresh(review)
    return review


def submit_self(
    db: Session, viewer: User, review_id: uuid.UUID,
    *, request: Request | None = None,
) -> PerformanceReview:
    """Hand it to the manager. One-way.

    The weight check happens here rather than when goals are set, because a
    half-built goal list is a normal state while HR is still writing it. It stops
    being normal the moment somebody rates themselves against it.
    """
    review = get_review(db, viewer, review_id)
    if review.user_id != viewer.id:
        raise PerformanceError("not_yours", "That is not your review.", 403)
    if not review.status_enum.employee_may_edit:
        raise PerformanceError(
            "already_submitted", f"Your review is already {review.status}.", 409
        )
    cycle = get_cycle(db, viewer.org_id, review.cycle_id)
    _require_open(cycle)

    goals = goals_for(db, viewer.org_id, review.cycle_id, viewer.id)
    check_weights(cycle, goals)
    unrated = [g.title for g in goals if g.self_rating is None]
    if unrated:
        raise PerformanceError(
            "unrated_goals",
            "Rate every goal before submitting. Still unrated: "
            + ", ".join(unrated[:4])
            + ("…" if len(unrated) > 4 else ""),
        )

    review.status = ReviewStatus.SELF_SUBMITTED.value
    review.self_submitted_at = _now()
    audit(db, org_id=viewer.org_id, actor=viewer, action="performance.self_submitted",
          request=request, target_type="performance_review", target_id=str(review.id),
          detail={"cycle": str(review.cycle_id)})
    db.commit()
    db.refresh(review)
    return review


def save_manager(
    db: Session, viewer: User, review_id: uuid.UUID, payload,
    *, request: Request | None = None,
) -> PerformanceReview:
    """The manager's ratings. Does not decide anything — see :func:`decide`."""
    review = get_review(db, viewer, review_id)
    if review.manager_id != viewer.id and not can_manage(viewer):
        raise PerformanceError(
            "not_the_manager",
            "Only the manager this review was assigned to writes the manager's "
            "half.", 403,
        )
    if review.status_enum.is_frozen:
        raise PerformanceError(
            "frozen", "A finalised review cannot be changed.", 409
        )
    cycle = get_cycle(db, viewer.org_id, review.cycle_id)
    _require_open(cycle)
    if cycle.requires_self_review and review.status_enum in (
        ReviewStatus.DRAFT, ReviewStatus.RETURNED
    ):
        raise PerformanceError(
            "awaiting_self_review",
            "This cycle asks the employee to write first, and they have not "
            "submitted yet.", 409,
        )

    goals = {g.id: g for g in goals_for(db, viewer.org_id, review.cycle_id, review.user_id)}
    for entry in payload.goals:
        goal = goals.get(entry.goal_id)
        if goal is None:
            raise PerformanceError("goal_not_found", "That goal is not on this review.", 404)
        _check_rating(cycle, entry.rating, what=f"“{goal.title}”")
        goal.manager_rating = entry.rating
        goal.manager_comment = (entry.comment or "").strip() or None

    _save_competencies(db, viewer, review, cycle, payload.competencies, manager=True)
    _check_rating(cycle, payload.overall_rating, what="The overall rating")
    review.overall_rating = payload.overall_rating
    review.final_comment = (payload.comment or "").strip() or None
    review.override_reason = (payload.override_reason or "").strip() or None
    db.commit()
    db.refresh(review)
    return review


def _save_competencies(
    db: Session, viewer: User, review: PerformanceReview, cycle: ReviewCycle,
    entries, *, manager: bool,
) -> None:
    """Write one side's competency ratings, creating rows on first use.

    The competency's **name is copied** onto the rating the first time it is
    used on this review. See the model: renaming a competency later must not
    rewrite what somebody was rated on.
    """
    if not entries:
        return
    existing = {r.competency_id: r for r in review.ratings}
    catalogue = {
        c.id: c for c in db.scalars(
            select(Competency).where(Competency.org_id == viewer.org_id)
        )
    }
    for order, entry in enumerate(entries):
        competency = catalogue.get(entry.competency_id)
        if competency is None:
            raise PerformanceError(
                "competency_not_found", "That competency does not exist.", 404
            )
        _check_rating(cycle, entry.rating, what=f"“{competency.name}”")
        row = existing.get(entry.competency_id)
        if row is None:
            row = CompetencyRating(
                org_id=viewer.org_id, review_id=review.id,
                competency_id=competency.id, competency_name=competency.name,
                sort_order=competency.sort_order or order,
            )
            db.add(row)
            existing[competency.id] = row
        if manager:
            row.manager_rating = entry.rating
        else:
            row.self_rating = entry.rating
        if entry.comment is not None:
            row.comment = entry.comment.strip() or None
    db.flush()


def decide(
    db: Session, viewer: User, review_id: uuid.UUID, *, approve: bool,
    note: str | None = None, request: Request | None = None,
) -> PerformanceReview:
    """The manager's decision: pass it on, or send it back.

    Through :mod:`app.services.workflow`, so it gets the same guards as every
    other approval here — not decided twice, not your own, and a reason when it
    goes back. ``workflow.PERFORMANCE`` is where this flow's answers to those
    three questions are written down beside the other six.
    """
    review = get_review(db, viewer, review_id)
    if review.manager_id != viewer.id and not can_manage(viewer):
        raise PerformanceError(
            "not_the_manager", "That review is not yours to decide.", 403
        )
    cycle = get_cycle(db, viewer.org_id, review.cycle_id)
    _require_open(cycle)

    def require_ratings() -> None:
        goals = goals_for(db, viewer.org_id, review.cycle_id, review.user_id)
        unrated = [g.title for g in goals if g.manager_rating is None]
        if unrated:
            raise PerformanceError(
                "unrated_goals",
                "Rate every goal before passing this on. Still unrated: "
                + ", ".join(unrated[:4]) + ("…" if len(unrated) > 4 else ""),
            )

    workflow.decide(
        db, policy=workflow.PERFORMANCE, record=review, reviewer=viewer,
        approve=approve, note=note, request=request, on_approve=require_ratings,
        detail={"cycle": str(review.cycle_id)},
    )
    db.commit()
    db.refresh(review)
    return review


def finalise(
    db: Session, viewer: User, review_id: uuid.UUID, *,
    share: bool = False, request: Request | None = None,
) -> PerformanceReview:
    """Freeze the rating. The ninth freeze in this system.

    Not driven by the kernel, and ``workflow.PERFORMANCE`` says why: it is a
    second decision on a record whose one set of reviewer columns the manager's
    decision already used.

    ``share`` releases it to the employee in the same call for the common case.
    Left separate as a flag rather than assumed, because HR routinely finalises
    a batch and releases them when the increment letters are ready.
    """
    _require_manager_role(viewer)
    review = get_review(db, viewer, review_id)
    if review.status_enum is ReviewStatus.FINALISED:
        raise PerformanceError(
            "already_finalised",
            "That review is finalised. A rating somebody has been told is a "
            "record, not a draft.", 409,
        )
    if review.status_enum is not ReviewStatus.MANAGER_SUBMITTED:
        raise PerformanceError(
            "not_ready",
            f"That review is {review.status}. Only a manager-submitted review "
            "can be finalised.", 409,
        )
    cycle = get_cycle(db, viewer.org_id, review.cycle_id)
    goals = goals_for(db, viewer.org_id, review.cycle_id, review.user_id)
    check_weights(cycle, goals)

    computed = score_centi(goals)
    if review.overall_rating is None:
        raise PerformanceError(
            "no_overall_rating",
            "Set the overall rating before finalising. The computed score is "
            "evidence, not the decision.",
        )
    # A whole point of daylight between the arithmetic and the decision is the
    # most challenged sentence in any appraisal. Somebody should have written
    # down why before it is challenged, not after.
    if computed is not None and abs(review.overall_rating * 100 - computed) >= 100 \
            and not review.override_reason:
        raise PerformanceError(
            "override_reason_required",
            f"The weighted score is {computed / 100:.2f} and the overall rating "
            f"is {review.overall_rating}. Say why they differ.",
        )

    review.score_centi = computed
    # The scale, copied. See the model docstring: a "4" without its scale is a
    # digit.
    review.rating_max = cycle.rating_max
    review.status = ReviewStatus.FINALISED.value
    review.finalised_at = _now()
    review.finalised_by = viewer.id
    if share:
        review.shared_at = _now()

    audit(db, org_id=viewer.org_id, actor=viewer, action="performance.finalised",
          request=request, target_type="performance_review", target_id=str(review.id),
          detail={"for": str(review.user_id), "cycle": str(review.cycle_id),
                  "overall_rating": review.overall_rating,
                  "score_centi": review.score_centi, "shared": share})
    db.commit()
    db.refresh(review)
    return review


def share(
    db: Session, viewer: User, review_id: uuid.UUID,
    *, request: Request | None = None,
) -> PerformanceReview:
    """Let the employee see their final rating.

    Deliberate and separate. A review that leaked its rating the moment it was
    finalised would stop companies finalising in batches, which is how every
    appraisal round actually runs.
    """
    _require_manager_role(viewer)
    review = get_review(db, viewer, review_id)
    if review.status_enum is not ReviewStatus.FINALISED:
        raise PerformanceError(
            "not_finalised", "Only a finalised review can be shared.", 409
        )
    if review.shared_at is None:
        review.shared_at = _now()
        audit(db, org_id=viewer.org_id, actor=viewer, action="performance.shared",
              request=request, target_type="performance_review",
              target_id=str(review.id), detail={"for": str(review.user_id)})
        db.commit()
        db.refresh(review)
    return review


def _require_open(cycle: ReviewCycle) -> None:
    if not cycle.status_enum.accepts_writes:
        raise PerformanceError(
            "cycle_not_open",
            f"That cycle is {cycle.status}; nothing can be written to it.", 409,
        )


def visible_rating(review: PerformanceReview, viewer: User) -> bool:
    """Whether this viewer may see the final rating.

    The employee sees theirs **once it has been shared**; their manager and HR
    see it as soon as it exists. Hiding it from the manager who wrote it would
    be absurd; showing it to the employee before HR released it would break the
    batch-then-release rhythm every appraisal round has.
    """
    if review.user_id != viewer.id:
        return True
    return review.shared_at is not None
