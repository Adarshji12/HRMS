"""Shapes for announcements, surveys and recognition.

Two conventions worth stating.

**A survey response has no identity on the wire, ever.** There is no schema in
this file with a `user_id` on an answer, and adding one would be the first step
in undoing what `models/engagement` is built to guarantee.

**A mean rating is integer hundredths**, matching appraisals: `370` is 3.70. The
console divides at the edge.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, Field

from app.schemas.common import ORMModel


# --------------------------------------------------------------------------- #
# Announcements
# --------------------------------------------------------------------------- #


class AnnouncementIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    body: str = Field(min_length=1, max_length=64_000)
    #: 'everyone' | 'departments' | 'teams' | 'people'. Coarse on purpose — see
    #: the service on why there is no rule engine here.
    audience_kind: str = Field(default="everyone",
                               pattern=r"^(everyone|departments|teams|people)$")
    audience_ids: list[uuid.UUID] = Field(default_factory=list, max_length=500)
    is_pinned: bool = False
    #: Whether reading is enough, or whether people must actively accept it.
    #: Those are different questions and a policy update needs the second.
    requires_acknowledgement: bool = False
    #: Null means it stays until archived — right for a policy, wrong for a
    #: canteen closure, so the author decides rather than a default.
    expires_on: date | None = None


class AnnouncementOut(ORMModel):
    id: uuid.UUID
    title: str
    body: str
    status: str
    audience_kind: str
    audience_ids: list[uuid.UUID] | None = None
    is_pinned: bool
    requires_acknowledgement: bool
    expires_on: date | None = None
    published_at: datetime | None = None
    created_at: datetime

    published_by_name: str | None = None
    #: Filled on the reader's own feed. Null on an admin listing, where "read by
    #: whom" is the reach report's question rather than this row's.
    read_at: datetime | None = None
    acknowledged_at: datetime | None = None


class AcknowledgeIn(BaseModel):
    #: False records a read; true records an acceptance. Both are stamped once
    #: and never rewritten by a later visit.
    acknowledge: bool = False


class ReachOut(BaseModel):
    audience: int
    read: int
    acknowledged: int
    #: Only the people who have **not** complied. A list of who has is a list
    #: nobody needs, and this one has a use: chasing.
    outstanding: list[str] = []


# --------------------------------------------------------------------------- #
# Surveys
# --------------------------------------------------------------------------- #


class QuestionIn(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)
    kind: str = Field(default="scale", pattern=r"^(scale|text|choice)$")
    scale_max: int = Field(default=5, ge=2, le=10)
    choices: list[str] = Field(default_factory=list, max_length=20)
    is_required: bool = True


class SurveyIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=8000)
    audience_kind: str = Field(default="everyone",
                               pattern=r"^(everyone|departments|teams|people)$")
    audience_ids: list[uuid.UUID] = Field(default_factory=list, max_length=500)
    #: **Frozen once the survey opens.** See `services/engagement`.
    is_anonymous: bool = True
    #: The floor for showing results and any breakdown of them.
    min_responses: int = Field(default=4, ge=2, le=100)
    opens_on: date | None = None
    closes_on: date | None = None
    questions: list[QuestionIn] = Field(default_factory=list, max_length=30)


class QuestionOut(ORMModel):
    id: uuid.UUID
    prompt: str
    kind: str
    scale_max: int
    choices: list[str] | None = None
    is_required: bool
    sort_order: int


class SurveyOut(ORMModel):
    id: uuid.UUID
    title: str
    description: str | None = None
    status: str
    audience_kind: str
    is_anonymous: bool
    min_responses: int
    opens_on: date | None = None
    closes_on: date | None = None
    closed_at: datetime | None = None
    created_at: datetime
    questions: list[QuestionOut] = []
    #: From the participant table, which knows only *that* somebody answered.
    invited: int = 0
    responded: int = 0
    #: On the reader's own listing: whether they personally have answered.
    i_responded: bool = False


class AnswerIn(BaseModel):
    question_id: uuid.UUID
    rating: int | None = Field(default=None, ge=1, le=10)
    text: str | None = Field(default=None, max_length=16_000)
    choice: str | None = Field(default=None, max_length=200)


class SubmissionIn(BaseModel):
    answers: list[AnswerIn] = Field(default_factory=list, max_length=30)


class QuestionResultOut(BaseModel):
    question_id: uuid.UUID
    prompt: str
    kind: str
    #: Hundredths. 370 is 3.70.
    mean_centi: int | None = None
    #: Count per scale point, lowest first.
    distribution: list[int] = []
    texts: list[str] = []
    counts: dict[str, int] = {}
    #: True when this question's answers are withheld for being too few. The
    #: question is still listed — hiding it would make an uncomfortable question
    #: look like one nobody asked.
    withheld: bool = False


class ResultsOut(BaseModel):
    survey_id: uuid.UUID
    title: str
    is_anonymous: bool
    invited: int
    responded: int
    min_responses: int
    questions: list[QuestionResultOut] = []
    #: Set when the whole survey is below the floor. A refusal, not a warning.
    withheld_reason: str | None = None


# --------------------------------------------------------------------------- #
# Recognition
# --------------------------------------------------------------------------- #


class RecognitionIn(BaseModel):
    to_user_id: uuid.UUID
    message: str = Field(min_length=1, max_length=4000)
    #: Optional tie to the competency catalogue. "Ownership — she took the
    #: incident at 2am" is a sentence that belongs in an appraisal.
    competency_id: uuid.UUID | None = None
    #: False keeps it between the two people — invisible to administrators too.
    is_public: bool = True


class RecognitionOut(ORMModel):
    id: uuid.UUID
    message: str
    competency_id: uuid.UUID | None = None
    is_public: bool
    created_at: datetime
    from_user_id: uuid.UUID | None = None
    to_user_id: uuid.UUID | None = None
    #: Null when the person has left. Renders as "a former colleague" rather
    #: than blank.
    from_name: str | None = None
    to_name: str | None = None
    competency_name: str | None = None
