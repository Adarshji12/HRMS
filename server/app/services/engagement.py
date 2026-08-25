"""Announcements, pulse surveys and recognition.

Most of this module is ordinary. One part of it is not, and that part is why the
module is worth reading before changing.

The anonymity guarantee, and the three things that enforce it
-------------------------------------------------------------

:mod:`app.models.engagement` explains the shape: for an anonymous survey the
response row carries **no user id**, and participation is tracked in a separate
table that records *that* somebody answered and never *what*. This module is
where that shape is kept honest, and it does three things:

1. **:func:`submit` writes ``user_id=None`` on an anonymous survey**, in the one
   place a response is ever created. There is no other writer, and the
   participant row is stamped in the same transaction so a submission cannot
   count without being recorded or be recorded without counting.

2. **:func:`results` refuses below the floor**, and refuses the same way for
   every breakdown of the results. Refuses, not warns: a warning is something a
   reader scrolls past, and the number underneath it is still on their screen.
   Free-text answers are held to a **higher** bar than ratings, because a
   sentence identifies its author in a way a "4" does not.

3. **:func:`set_status` freezes ``is_anonymous`` when a survey opens.** Flipping
   it afterwards would retroactively expose people who answered believing
   otherwise. It is the only field on a survey that cannot be corrected, and
   that is the correct trade.

There is deliberately no function anywhere in this module that takes a survey
and returns who said what. Not a private one, not a debug one. If somebody needs
that, they need a different instrument — an attributed survey — and the model
supports one.

Audiences
---------

Coarse on purpose: everyone, some departments, some teams, or a named list. A
rule engine over arbitrary attributes is a filter language nobody can read back
six months later, and these four cover what companies actually send. Resolution
happens once, at publish or open, and the resulting participant rows are the
record — so somebody moving department halfway through a survey does not
silently leave the population it was measuring.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timezone

from fastapi import HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import audit
from app.models import User
from app.models.engagement import (
    Announcement,
    AnnouncementRead,
    AudienceKind,
    PostStatus,
    QuestionKind,
    Recognition,
    Survey,
    SurveyAnswer,
    SurveyParticipant,
    SurveyQuestion,
    SurveyResponse,
    SurveyStatus,
)
from app.models.performance import Competency

#: Free text is held to a higher bar than a rating. A sentence carries voice,
#: detail and grievance; a "4" carries a digit. Four people's ratings average
#: into something nobody can attribute — four people's paragraphs do not.
TEXT_FLOOR_EXTRA = 2


class EngagementError(HTTPException):
    """A typed refusal, in the house style. ``{"reason", "message"}``."""

    def __init__(self, code: str, message: str, status_code: int = 422) -> None:
        super().__init__(status_code, detail={"reason": code, "message": message})
        self.code = code


def _now() -> datetime:
    return datetime.now(timezone.utc)


def can_manage(viewer: User) -> bool:
    return viewer.role_enum.can_administer and getattr(
        viewer, "can_manage_engagement", True
    )


def _require_manager(viewer: User) -> None:
    if not can_manage(viewer):
        raise EngagementError(
            "not_permitted", "You may not publish announcements or run surveys.", 403
        )


# --------------------------------------------------------------------------- #
# Audiences
# --------------------------------------------------------------------------- #


def resolve_audience(
    db: Session, org_id: uuid.UUID, kind: str, ids: list | None
) -> list[User]:
    """Who a post or survey is for, right now.

    Resolved **once**, at publish or open, and the participant rows written from
    it are the record. Re-resolving later would quietly change who a survey was
    measuring when somebody moves department, which makes a trend line across
    two quarters a comparison between different populations.
    """
    stmt = select(User).where(User.org_id == org_id, User.is_active.is_(True))
    audience = AudienceKind(kind)
    wanted = [uuid.UUID(str(i)) for i in (ids or [])]

    if audience is AudienceKind.EVERYONE:
        pass
    elif not wanted:
        raise EngagementError(
            "empty_audience",
            f"An audience of {audience.value} needs at least one selection.",
        )
    elif audience is AudienceKind.DEPARTMENTS:
        stmt = stmt.where(User.department_id.in_(wanted))
    elif audience is AudienceKind.TEAMS:
        stmt = stmt.where(User.team_id.in_(wanted))
    else:
        stmt = stmt.where(User.id.in_(wanted))
    return list(db.scalars(stmt))


def _is_in_audience(user: User, kind: str, ids: list | None) -> bool:
    """Whether one person is in an audience, without resolving the whole thing.

    Used on the read path, where resolving every announcement's audience to
    render a feed would be one query per post.
    """
    audience = AudienceKind(kind)
    if audience is AudienceKind.EVERYONE:
        return True
    wanted = {str(i) for i in (ids or [])}
    if audience is AudienceKind.DEPARTMENTS:
        return str(user.department_id) in wanted
    if audience is AudienceKind.TEAMS:
        return str(user.team_id) in wanted
    return str(user.id) in wanted


# --------------------------------------------------------------------------- #
# Announcements
# --------------------------------------------------------------------------- #


def get_announcement(
    db: Session, org_id: uuid.UUID, post_id: uuid.UUID
) -> Announcement:
    row = db.get(Announcement, post_id)
    if row is None or row.org_id != org_id:
        raise EngagementError("not_found", "No such announcement.", 404)
    return row


def create_announcement(
    db: Session, viewer: User, payload, *, request: Request | None = None
) -> Announcement:
    _require_manager(viewer)
    # Validated at creation rather than at publish: an author who picked an empty
    # department should find out while they are still writing.
    resolve_audience(db, viewer.org_id, payload.audience_kind, payload.audience_ids)
    post = Announcement(
        org_id=viewer.org_id,
        title=payload.title.strip(),
        body=payload.body,
        audience_kind=payload.audience_kind,
        audience_ids=[str(i) for i in (payload.audience_ids or [])] or None,
        is_pinned=payload.is_pinned,
        requires_acknowledgement=payload.requires_acknowledgement,
        expires_on=payload.expires_on,
        status=PostStatus.DRAFT.value,
    )
    db.add(post)
    db.flush()
    audit(db, org_id=viewer.org_id, actor=viewer,
          action="engagement.announcement_created", request=request,
          target_type="announcement", target_id=str(post.id),
          detail={"title": post.title, "audience": post.audience_kind})
    db.commit()
    db.refresh(post)
    return post


def publish_announcement(
    db: Session, viewer: User, post_id: uuid.UUID, *, request: Request | None = None
) -> Announcement:
    """Put it on the feed. One-way — an announcement is unpublished by archiving.

    Reverting to draft would mean a post people have read and possibly
    acknowledged going back to being unwritten, and the read receipts would then
    be evidence about a document that officially never existed.
    """
    _require_manager(viewer)
    post = get_announcement(db, viewer.org_id, post_id)
    if post.status_enum is not PostStatus.DRAFT:
        raise EngagementError(
            "already_published",
            f"This announcement is {post.status}. Archive it rather than "
            "un-publishing one people have already read.",
            409,
        )
    post.status = PostStatus.PUBLISHED.value
    post.published_at = _now()
    post.published_by = viewer.id
    reach = len(resolve_audience(db, viewer.org_id, post.audience_kind,
                                 post.audience_ids))
    audit(db, org_id=viewer.org_id, actor=viewer,
          action="engagement.announcement_published", request=request,
          target_type="announcement", target_id=str(post.id),
          detail={"title": post.title, "reach": reach})
    db.commit()
    db.refresh(post)
    return post


def archive_announcement(
    db: Session, viewer: User, post_id: uuid.UUID, *, request: Request | None = None
) -> Announcement:
    """Off the feed, still readable. Not deleted: "we never announced that" is a
    claim the archive answers."""
    _require_manager(viewer)
    post = get_announcement(db, viewer.org_id, post_id)
    post.status = PostStatus.ARCHIVED.value
    audit(db, org_id=viewer.org_id, actor=viewer,
          action="engagement.announcement_archived", request=request,
          target_type="announcement", target_id=str(post.id),
          detail={"title": post.title})
    db.commit()
    db.refresh(post)
    return post


def feed_for(db: Session, viewer: User) -> list[Announcement]:
    """What this person sees: published, unexpired, and addressed to them.

    Pinned first, then newest. Expiry is compared against today rather than
    filtered in SQL because an expiry of null means "until archived", and a
    ``NULL <= today`` comparison quietly drops exactly the posts that should
    never drop off.
    """
    today = date.today()
    rows = db.scalars(
        select(Announcement).where(
            Announcement.org_id == viewer.org_id,
            Announcement.status == PostStatus.PUBLISHED.value,
        ).order_by(Announcement.is_pinned.desc(), Announcement.published_at.desc())
    )
    return [
        post for post in rows
        if (post.expires_on is None or post.expires_on >= today)
        and _is_in_audience(viewer, post.audience_kind, post.audience_ids)
    ]


def mark_read(
    db: Session, viewer: User, post_id: uuid.UUID, *, acknowledge: bool = False
) -> AnnouncementRead:
    """Record that this person opened it, or accepted it.

    Idempotent, and the two timestamps are set independently: reading twice does
    not move ``read_at``, and acknowledging does not overwrite when they first
    opened it. Both are evidence and neither should be rewritten by a later
    visit.
    """
    post = get_announcement(db, viewer.org_id, post_id)
    if not _is_in_audience(viewer, post.audience_kind, post.audience_ids):
        raise EngagementError("not_found", "No such announcement.", 404)

    row = db.scalar(select(AnnouncementRead).where(
        AnnouncementRead.announcement_id == post.id,
        AnnouncementRead.user_id == viewer.id,
    ))
    if row is None:
        row = AnnouncementRead(
            org_id=viewer.org_id, announcement_id=post.id, user_id=viewer.id
        )
        db.add(row)
    if row.read_at is None:
        row.read_at = _now()
    if acknowledge and row.acknowledged_at is None:
        row.acknowledged_at = _now()
    db.commit()
    db.refresh(row)
    return row


@dataclass(slots=True)
class Reach:
    """How far an announcement got. What HR asks the morning after."""

    audience: int
    read: int
    acknowledged: int
    #: Names, for chasing. Only ever the *outstanding* ones — a list of who has
    #: complied is a list nobody needs and this one has a use.
    outstanding: list[str] = field(default_factory=list)


def reach_of(db: Session, viewer: User, post_id: uuid.UUID) -> Reach:
    _require_manager(viewer)
    post = get_announcement(db, viewer.org_id, post_id)
    people = resolve_audience(db, viewer.org_id, post.audience_kind, post.audience_ids)
    rows = {
        row.user_id: row for row in db.scalars(
            select(AnnouncementRead).where(AnnouncementRead.announcement_id == post.id)
        )
    }
    read = sum(1 for p in people if rows.get(p.id) and rows[p.id].read_at)
    acked = sum(1 for p in people if rows.get(p.id) and rows[p.id].acknowledged_at)
    # Outstanding means "has not done the thing that was asked" — which is
    # acknowledging when that was required, and reading otherwise.
    if post.requires_acknowledgement:
        outstanding = [p.full_name for p in people
                       if not (rows.get(p.id) and rows[p.id].acknowledged_at)]
    else:
        outstanding = [p.full_name for p in people
                       if not (rows.get(p.id) and rows[p.id].read_at)]
    return Reach(audience=len(people), read=read, acknowledged=acked,
                 outstanding=sorted(outstanding))


# --------------------------------------------------------------------------- #
# Surveys
# --------------------------------------------------------------------------- #


def get_survey(db: Session, org_id: uuid.UUID, survey_id: uuid.UUID) -> Survey:
    row = db.get(Survey, survey_id)
    if row is None or row.org_id != org_id:
        raise EngagementError("not_found", "No such survey.", 404)
    return row


def create_survey(
    db: Session, viewer: User, payload, *, request: Request | None = None
) -> Survey:
    _require_manager(viewer)
    if not payload.questions:
        raise EngagementError("no_questions", "A survey needs at least one question.")
    resolve_audience(db, viewer.org_id, payload.audience_kind, payload.audience_ids)

    survey = Survey(
        org_id=viewer.org_id,
        title=payload.title.strip(),
        description=(payload.description or "").strip() or None,
        audience_kind=payload.audience_kind,
        audience_ids=[str(i) for i in (payload.audience_ids or [])] or None,
        is_anonymous=payload.is_anonymous,
        min_responses=payload.min_responses,
        opens_on=payload.opens_on, closes_on=payload.closes_on,
        status=SurveyStatus.DRAFT.value,
    )
    db.add(survey)
    db.flush()
    for order, question in enumerate(payload.questions):
        kind = QuestionKind(question.kind)
        if kind is QuestionKind.CHOICE and not question.choices:
            raise EngagementError(
                "no_choices", f"“{question.prompt[:40]}” is a choice question with "
                              "no options."
            )
        db.add(SurveyQuestion(
            org_id=viewer.org_id, survey_id=survey.id, prompt=question.prompt.strip(),
            kind=kind.value, scale_max=question.scale_max,
            choices=question.choices or None, is_required=question.is_required,
            sort_order=order,
        ))
    db.flush()
    audit(db, org_id=viewer.org_id, actor=viewer, action="engagement.survey_created",
          request=request, target_type="survey", target_id=str(survey.id),
          detail={"title": survey.title, "anonymous": survey.is_anonymous,
                  "questions": len(payload.questions)})
    db.commit()
    db.refresh(survey)
    return survey


def open_survey(
    db: Session, viewer: User, survey_id: uuid.UUID, *, request: Request | None = None
) -> Survey:
    """Open it, and freeze the population and the anonymity promise.

    Both are frozen here for the same reason: what a survey measured and what it
    promised have to be true of every response in it, and neither can be
    established retroactively.
    """
    _require_manager(viewer)
    survey = get_survey(db, viewer.org_id, survey_id)
    if survey.status_enum is not SurveyStatus.DRAFT:
        raise EngagementError(
            "already_open", f"That survey is {survey.status}.", 409
        )

    people = resolve_audience(db, viewer.org_id, survey.audience_kind,
                              survey.audience_ids)
    if len(people) < survey.min_responses and survey.is_anonymous:
        # Refused at the door rather than at the results screen. An anonymous
        # survey of three people can never show a result, and letting it run
        # would collect answers under a promise the system then cannot keep.
        raise EngagementError(
            "audience_too_small",
            f"This audience is {len(people)} people and anonymous results need "
            f"at least {survey.min_responses}. Widen it, lower the threshold, "
            "or run it as an attributed survey.",
        )
    for person in people:
        db.add(SurveyParticipant(
            org_id=viewer.org_id, survey_id=survey.id, user_id=person.id
        ))
    survey.status = SurveyStatus.OPEN.value
    db.flush()
    audit(db, org_id=viewer.org_id, actor=viewer, action="engagement.survey_opened",
          request=request, target_type="survey", target_id=str(survey.id),
          detail={"title": survey.title, "invited": len(people),
                  "anonymous": survey.is_anonymous})
    db.commit()
    db.refresh(survey)
    return survey


def close_survey(
    db: Session, viewer: User, survey_id: uuid.UUID, *, request: Request | None = None
) -> Survey:
    _require_manager(viewer)
    survey = get_survey(db, viewer.org_id, survey_id)
    survey.status = SurveyStatus.CLOSED.value
    survey.closed_at = _now()
    audit(db, org_id=viewer.org_id, actor=viewer, action="engagement.survey_closed",
          request=request, target_type="survey", target_id=str(survey.id),
          detail={"title": survey.title})
    db.commit()
    db.refresh(survey)
    return survey


def my_surveys(db: Session, viewer: User) -> list[tuple[Survey, bool]]:
    """Open surveys this person was invited to, and whether they have answered.

    From the participant row, which is the only thing that knows — and knows
    only that, never what they said.
    """
    rows = db.execute(
        select(Survey, SurveyParticipant.responded_at)
        .join(SurveyParticipant, SurveyParticipant.survey_id == Survey.id)
        .where(
            Survey.org_id == viewer.org_id,
            SurveyParticipant.user_id == viewer.id,
            Survey.status == SurveyStatus.OPEN.value,
        )
        .order_by(Survey.created_at.desc())
    ).all()
    return [(survey, responded is not None) for survey, responded in rows]


def submit(
    db: Session, viewer: User, survey_id: uuid.UUID, answers,
    *, request: Request | None = None,
) -> None:
    """Record one submission.

    **The one place a response is ever created**, and the place the anonymity
    guarantee is kept: ``user_id`` is written as ``None`` when the survey is
    anonymous. The participant row is stamped in the same transaction, so a
    submission cannot count without being recorded or be recorded without
    counting.

    Nothing is returned. A response id handed back to the caller would be a
    handle to the thing that must not be linkable to them, and there is no
    endpoint that would take it.
    """
    survey = get_survey(db, viewer.org_id, survey_id)
    if survey.status_enum is not SurveyStatus.OPEN:
        raise EngagementError(
            "not_open", f"That survey is {survey.status}.", 409
        )

    participant = db.scalar(select(SurveyParticipant).where(
        SurveyParticipant.survey_id == survey.id,
        SurveyParticipant.user_id == viewer.id,
    ))
    if participant is None:
        raise EngagementError("not_invited", "You were not asked this survey.", 404)
    if participant.responded_at is not None:
        raise EngagementError(
            "already_responded",
            "You have already answered this one. Answers cannot be changed — an "
            "anonymous response has nothing on it that could identify which one "
            "was yours.",
            409,
        )

    questions = {q.id: q for q in survey.questions}
    given = {a.question_id for a in answers}
    missing = [q.prompt for q in survey.questions
               if q.is_required and q.id not in given]
    if missing:
        raise EngagementError(
            "missing_answers",
            "Answer every required question. Still blank: "
            + "; ".join(m[:40] for m in missing[:3]),
        )

    response = SurveyResponse(
        org_id=viewer.org_id,
        survey_id=survey.id,
        # The guarantee, in one line. See the module docstring.
        user_id=None if survey.is_anonymous else viewer.id,
        submitted_at=_now(),
    )
    db.add(response)
    db.flush()

    for answer in answers:
        question = questions.get(answer.question_id)
        if question is None:
            raise EngagementError("bad_question", "That question is not on this survey.", 404)
        kind = QuestionKind(question.kind)
        if kind is QuestionKind.SCALE:
            if answer.rating is not None and not 1 <= answer.rating <= question.scale_max:
                raise EngagementError(
                    "rating_out_of_scale",
                    f"That question is rated 1 to {question.scale_max}.",
                )
        if kind is QuestionKind.CHOICE and answer.choice not in (question.choices or []):
            raise EngagementError("bad_choice", "That is not one of the options.")
        db.add(SurveyAnswer(
            org_id=viewer.org_id, response_id=response.id, question_id=question.id,
            rating=answer.rating if kind is QuestionKind.SCALE else None,
            text=(answer.text or "").strip() or None if kind is QuestionKind.TEXT else None,
            choice=answer.choice if kind is QuestionKind.CHOICE else None,
        ))

    participant.responded_at = _now()
    # Deliberately not audited with the actor's id against the survey: an audit
    # row saying "X submitted to anonymous survey Y at 14:03" plus a response
    # timestamped 14:03 is the join this module exists to prevent.
    db.commit()


@dataclass(slots=True)
class QuestionResult:
    question_id: uuid.UUID
    prompt: str
    kind: str
    #: Mean rating in hundredths, integer — the same discipline appraisals use.
    #: None for a non-scale question or when nothing was rated.
    mean_centi: int | None = None
    #: How many people picked each point, lowest first. Empty for non-scale.
    distribution: list[int] = field(default_factory=list)
    #: Free-text answers, in a shuffled-by-nothing order — they arrive in
    #: whatever order the database returns, which is not submission order and is
    #: not a person's order.
    texts: list[str] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=dict)
    #: True when this question's answers are withheld for being too few. The
    #: question is still listed: hiding it entirely would make an uncomfortable
    #: question look like one nobody asked.
    withheld: bool = False


@dataclass(slots=True)
class Results:
    survey_id: uuid.UUID
    title: str
    is_anonymous: bool
    invited: int
    responded: int
    min_responses: int
    questions: list[QuestionResult] = field(default_factory=list)
    #: Set when the whole survey is below the floor.
    withheld_reason: str | None = None


def results(db: Session, viewer: User, survey_id: uuid.UUID) -> Results:
    """What the survey found — or a refusal to say.

    **Refuses below the floor rather than warning.** A warning is something a
    reader scrolls past while the number underneath it is still on their screen.

    Free text is held to a higher bar than ratings: a sentence carries voice,
    detail and grievance, and identifies its author in a way a "4" does not.
    """
    _require_manager(viewer)
    survey = get_survey(db, viewer.org_id, survey_id)

    invited = int(db.scalar(select(func.count(SurveyParticipant.id)).where(
        SurveyParticipant.survey_id == survey.id)) or 0)
    responded = int(db.scalar(select(func.count(SurveyResponse.id)).where(
        SurveyResponse.survey_id == survey.id)) or 0)

    out = Results(
        survey_id=survey.id, title=survey.title, is_anonymous=survey.is_anonymous,
        invited=invited, responded=responded, min_responses=survey.min_responses,
    )
    if survey.is_anonymous and responded < survey.min_responses:
        out.withheld_reason = (
            f"{responded} of {invited} have answered. Results are withheld below "
            f"{survey.min_responses} responses — with fewer than that, an "
            "anonymous answer is not anonymous."
        )
        # The questions are still listed, without their answers, so nobody
        # concludes the survey was never run.
        out.questions = [
            QuestionResult(question_id=q.id, prompt=q.prompt, kind=q.kind,
                           withheld=True)
            for q in survey.questions
        ]
        return out

    text_floor = survey.min_responses + TEXT_FLOOR_EXTRA if survey.is_anonymous else 0
    for question in survey.questions:
        rows = list(db.scalars(select(SurveyAnswer).where(
            SurveyAnswer.question_id == question.id)))
        result = QuestionResult(
            question_id=question.id, prompt=question.prompt, kind=question.kind
        )
        kind = QuestionKind(question.kind)
        if kind is QuestionKind.SCALE:
            ratings = [r.rating for r in rows if r.rating is not None]
            if ratings:
                # One division at the end, integer throughout — the same
                # arithmetic appraisals use, and for the same reason.
                result.mean_centi = sum(ratings) * 100 // len(ratings)
                result.distribution = [
                    sum(1 for r in ratings if r == point)
                    for point in range(1, question.scale_max + 1)
                ]
        elif kind is QuestionKind.CHOICE:
            for row in rows:
                if row.choice:
                    result.counts[row.choice] = result.counts.get(row.choice, 0) + 1
        else:
            texts = [r.text for r in rows if r.text]
            if survey.is_anonymous and len(texts) < text_floor:
                result.withheld = True
            else:
                result.texts = texts
        out.questions.append(result)
    return out


def outstanding(db: Session, viewer: User, survey_id: uuid.UUID) -> list[str]:
    """Who has not responded yet, by name.

    This reads :class:`SurveyParticipant` and **only** that table. It is the
    reason participation is tracked separately: chasing the people who have not
    answered is a legitimate and necessary thing to do, and it must not require
    touching anything that knows what anybody said.
    """
    _require_manager(viewer)
    survey = get_survey(db, viewer.org_id, survey_id)
    rows = db.execute(
        select(User.full_name)
        .join(SurveyParticipant, SurveyParticipant.user_id == User.id)
        .where(
            SurveyParticipant.survey_id == survey.id,
            SurveyParticipant.responded_at.is_(None),
        )
        .order_by(User.full_name)
    ).all()
    return [name for (name,) in rows]


# --------------------------------------------------------------------------- #
# Recognition
# --------------------------------------------------------------------------- #


def recognise(
    db: Session, viewer: User, payload, *, request: Request | None = None
) -> Recognition:
    """One person thanking another, on the record.

    No permission gate: recognition that only administrators may give is not
    recognition, it is an award. Two rules only, and both are obvious once
    stated.
    """
    if payload.to_user_id == viewer.id:
        raise EngagementError(
            "self_recognition", "Recognition is something somebody else gives you."
        )
    recipient = db.get(User, payload.to_user_id)
    if recipient is None or recipient.org_id != viewer.org_id:
        raise EngagementError("not_found", "No such colleague.", 404)

    competency_id = None
    if payload.competency_id:
        competency = db.get(Competency, payload.competency_id)
        if competency is None or competency.org_id != viewer.org_id:
            raise EngagementError("not_found", "No such competency.", 404)
        competency_id = competency.id

    row = Recognition(
        org_id=viewer.org_id, from_user_id=viewer.id, to_user_id=recipient.id,
        message=payload.message.strip(), competency_id=competency_id,
        is_public=payload.is_public,
    )
    db.add(row)
    db.flush()
    audit(db, org_id=viewer.org_id, actor=viewer, action="engagement.recognition_given",
          request=request, target_type="recognition", target_id=str(row.id),
          detail={"to": str(recipient.id), "public": row.is_public})
    db.commit()
    db.refresh(row)
    return row


def recognition_wall(
    db: Session, viewer: User, *, user_id: uuid.UUID | None = None, limit: int = 50
) -> list[Recognition]:
    """Public recognition, newest first — plus your own private ones.

    A private recognition is visible to the two people in it and to nobody else,
    including administrators. That is not an oversight: a quiet thank you that
    HR can read is not a quiet thank you, and knowing it might be read is enough
    to stop some being sent.
    """
    stmt = select(Recognition).where(Recognition.org_id == viewer.org_id)
    if user_id is not None:
        stmt = stmt.where(Recognition.to_user_id == user_id)
    rows = list(db.scalars(stmt.order_by(Recognition.created_at.desc()).limit(limit)))
    return [
        row for row in rows
        if row.is_public or viewer.id in (row.from_user_id, row.to_user_id)
    ]
