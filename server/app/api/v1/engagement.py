"""Engagement over HTTP.

Thin, like every router here. Two things worth noticing about the surface it
exposes, both of which are absences:

* **There is no endpoint that returns who answered a survey how.** Not for an
  administrator, not for the owner. The service has no function to back one and
  the model has no column to build one from — see ``models/engagement``.
* **Submitting a survey returns nothing.** A response id handed back would be a
  handle to the thing that must not be linkable to the person holding it.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Request, Response, status
from sqlalchemy import func, select

from app.api.deps import AdminUser, CurrentUser, DbSession
from app.models import User
from app.models.engagement import (
    AnnouncementRead,
    Recognition,
    SurveyParticipant,
    SurveyResponse,
)
from app.models.performance import Competency
from app.schemas.engagement import (
    AcknowledgeIn,
    AnnouncementIn,
    AnnouncementOut,
    QuestionOut,
    QuestionResultOut,
    ReachOut,
    RecognitionIn,
    RecognitionOut,
    ResultsOut,
    SubmissionIn,
    SurveyIn,
    SurveyOut,
)
from app.services import engagement as svc

router = APIRouter(prefix="/engagement", tags=["engagement"])


def _names(db: DbSession, org_id: uuid.UUID) -> dict[uuid.UUID, str]:
    return {
        row.id: row.full_name
        for row in db.scalars(select(User).where(User.org_id == org_id))
    }


# --------------------------------------------------------------------------- #
# Announcements
# --------------------------------------------------------------------------- #


@router.get("/announcements", response_model=list[AnnouncementOut])
def feed(viewer: CurrentUser, db: DbSession) -> list[AnnouncementOut]:
    """This reader's feed: published, unexpired, addressed to them.

    Each row carries whether *they* have read or acknowledged it, so the console
    can show the outstanding ones without a second call.
    """
    posts = svc.feed_for(db, viewer)
    names = _names(db, viewer.org_id)
    reads = {
        row.announcement_id: row for row in db.scalars(
            select(AnnouncementRead).where(AnnouncementRead.user_id == viewer.id)
        )
    }
    out = []
    for post in posts:
        item = AnnouncementOut.model_validate(post)
        item.published_by_name = names.get(post.published_by) if post.published_by else None
        mine = reads.get(post.id)
        item.read_at = mine.read_at if mine else None
        item.acknowledged_at = mine.acknowledged_at if mine else None
        out.append(item)
    return out


@router.get("/announcements/manage", response_model=list[AnnouncementOut])
def list_all(admin: AdminUser, db: DbSession) -> list[AnnouncementOut]:
    """Every announcement including drafts and archives — the author's view."""
    svc._require_manager(admin)
    names = _names(db, admin.org_id)
    from app.models.engagement import Announcement

    rows = db.scalars(
        select(Announcement)
        .where(Announcement.org_id == admin.org_id)
        .order_by(Announcement.created_at.desc())
    )
    out = []
    for post in rows:
        item = AnnouncementOut.model_validate(post)
        item.published_by_name = names.get(post.published_by) if post.published_by else None
        out.append(item)
    return out


@router.post("/announcements", response_model=AnnouncementOut,
             status_code=status.HTTP_201_CREATED)
def create(
    payload: AnnouncementIn, admin: AdminUser, db: DbSession, request: Request
) -> AnnouncementOut:
    return AnnouncementOut.model_validate(
        svc.create_announcement(db, admin, payload, request=request)
    )


@router.post("/announcements/{post_id}/publish", response_model=AnnouncementOut)
def publish(
    post_id: uuid.UUID, admin: AdminUser, db: DbSession, request: Request
) -> AnnouncementOut:
    """One-way. Un-publishing a post people have read would make the read
    receipts evidence about a document that officially never existed."""
    return AnnouncementOut.model_validate(
        svc.publish_announcement(db, admin, post_id, request=request)
    )


@router.post("/announcements/{post_id}/archive", response_model=AnnouncementOut)
def archive(
    post_id: uuid.UUID, admin: AdminUser, db: DbSession, request: Request
) -> AnnouncementOut:
    return AnnouncementOut.model_validate(
        svc.archive_announcement(db, admin, post_id, request=request)
    )


@router.post("/announcements/{post_id}/read", response_model=AnnouncementOut)
def mark_read(
    post_id: uuid.UUID, payload: AcknowledgeIn, viewer: CurrentUser,
    db: DbSession,
) -> AnnouncementOut:
    """Record a read, or an acknowledgement. Idempotent."""
    row = svc.mark_read(db, viewer, post_id, acknowledge=payload.acknowledge)
    post = svc.get_announcement(db, viewer.org_id, post_id)
    out = AnnouncementOut.model_validate(post)
    out.read_at, out.acknowledged_at = row.read_at, row.acknowledged_at
    return out


@router.get("/announcements/{post_id}/reach", response_model=ReachOut)
def reach(post_id: uuid.UUID, admin: AdminUser, db: DbSession) -> ReachOut:
    """How far it got, and who is outstanding. What HR asks the morning after."""
    got = svc.reach_of(db, admin, post_id)
    return ReachOut(audience=got.audience, read=got.read,
                    acknowledged=got.acknowledged, outstanding=got.outstanding)


# --------------------------------------------------------------------------- #
# Surveys
# --------------------------------------------------------------------------- #


def _survey_out(db, survey, *, i_responded: bool = False) -> SurveyOut:
    out = SurveyOut.model_validate(survey)
    out.questions = [QuestionOut.model_validate(q) for q in survey.questions]
    out.invited = int(db.scalar(select(func.count(SurveyParticipant.id)).where(
        SurveyParticipant.survey_id == survey.id)) or 0)
    out.responded = int(db.scalar(select(func.count(SurveyResponse.id)).where(
        SurveyResponse.survey_id == survey.id)) or 0)
    out.i_responded = i_responded
    return out


@router.get("/surveys", response_model=list[SurveyOut])
def list_surveys(admin: AdminUser, db: DbSession) -> list[SurveyOut]:
    """Every survey — the author's view. Counts only; never responses."""
    svc._require_manager(admin)
    from app.models.engagement import Survey

    return [
        _survey_out(db, survey)
        for survey in db.scalars(
            select(Survey).where(Survey.org_id == admin.org_id)
            .order_by(Survey.created_at.desc())
        )
    ]


@router.get("/surveys/mine", response_model=list[SurveyOut])
def my_surveys(viewer: CurrentUser, db: DbSession) -> list[SurveyOut]:
    """Open surveys this person was asked, and whether they have answered.

    "Whether" comes from the participant row, which is the only thing that knows
    — and knows only that.
    """
    return [
        _survey_out(db, survey, i_responded=responded)
        for survey, responded in svc.my_surveys(db, viewer)
    ]


@router.post("/surveys", response_model=SurveyOut, status_code=status.HTTP_201_CREATED)
def create_survey(
    payload: SurveyIn, admin: AdminUser, db: DbSession, request: Request
) -> SurveyOut:
    return _survey_out(db, svc.create_survey(db, admin, payload, request=request))


@router.post("/surveys/{survey_id}/open", response_model=SurveyOut)
def open_survey(
    survey_id: uuid.UUID, admin: AdminUser, db: DbSession, request: Request
) -> SurveyOut:
    """Open it, freezing both the population and the anonymity promise.

    Refuses if an anonymous survey's audience is smaller than its own results
    floor — collecting answers under a promise the system cannot keep is worse
    than not running it.
    """
    return _survey_out(db, svc.open_survey(db, admin, survey_id, request=request))


@router.post("/surveys/{survey_id}/close", response_model=SurveyOut)
def close_survey(
    survey_id: uuid.UUID, admin: AdminUser, db: DbSession, request: Request
) -> SurveyOut:
    return _survey_out(db, svc.close_survey(db, admin, survey_id, request=request))


@router.post("/surveys/{survey_id}/submit",
             status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
def submit(
    survey_id: uuid.UUID, payload: SubmissionIn, viewer: CurrentUser,
    db: DbSession, request: Request,
) -> Response:
    """Answer it.

    **204 with no body, deliberately.** A response id in the reply would be a
    handle to the thing that must not be linkable to the person holding it.
    """
    svc.submit(db, viewer, survey_id, payload.answers, request=request)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/surveys/{survey_id}/results", response_model=ResultsOut)
def results(survey_id: uuid.UUID, admin: AdminUser, db: DbSession) -> ResultsOut:
    """What it found — or a refusal to say, when too few have answered."""
    got = svc.results(db, admin, survey_id)
    return ResultsOut(
        survey_id=got.survey_id, title=got.title, is_anonymous=got.is_anonymous,
        invited=got.invited, responded=got.responded,
        min_responses=got.min_responses, withheld_reason=got.withheld_reason,
        questions=[
            QuestionResultOut(
                question_id=q.question_id, prompt=q.prompt, kind=q.kind,
                mean_centi=q.mean_centi, distribution=q.distribution,
                texts=q.texts, counts=q.counts, withheld=q.withheld,
            )
            for q in got.questions
        ],
    )


@router.get("/surveys/{survey_id}/outstanding", response_model=list[str])
def outstanding(survey_id: uuid.UUID, admin: AdminUser, db: DbSession) -> list[str]:
    """Who has not answered, by name.

    Reads the participant table and only that. Chasing non-responders is
    legitimate and necessary, and it must not require touching anything that
    knows what anybody said — which is exactly why the two are separate tables.
    """
    return svc.outstanding(db, admin, survey_id)


# --------------------------------------------------------------------------- #
# Recognition
# --------------------------------------------------------------------------- #


def _recognition_out(row, names, competencies) -> RecognitionOut:
    out = RecognitionOut.model_validate(row)
    out.from_name = names.get(row.from_user_id) if row.from_user_id else None
    out.to_name = names.get(row.to_user_id) if row.to_user_id else None
    out.competency_name = (
        competencies.get(row.competency_id) if row.competency_id else None
    )
    return out


@router.get("/recognition", response_model=list[RecognitionOut])
def wall(
    viewer: CurrentUser, db: DbSession, user_id: uuid.UUID | None = None
) -> list[RecognitionOut]:
    """Public recognition, newest first, plus this reader's own private ones.

    A private recognition is visible to the two people in it and to nobody else,
    administrators included — see the service on why.
    """
    names = _names(db, viewer.org_id)
    competencies = {
        c.id: c.name for c in db.scalars(
            select(Competency).where(Competency.org_id == viewer.org_id))
    }
    return [
        _recognition_out(row, names, competencies)
        for row in svc.recognition_wall(db, viewer, user_id=user_id)
    ]


@router.post("/recognition", response_model=RecognitionOut,
             status_code=status.HTTP_201_CREATED)
def recognise(
    payload: RecognitionIn, viewer: CurrentUser, db: DbSession, request: Request
) -> RecognitionOut:
    """Thank a colleague.

    No permission gate: recognition only administrators may give is not
    recognition, it is an award.
    """
    row = svc.recognise(db, viewer, payload, request=request)
    names = _names(db, viewer.org_id)
    competencies = {
        c.id: c.name for c in db.scalars(
            select(Competency).where(Competency.org_id == viewer.org_id))
    }
    return _recognition_out(row, names, competencies)
