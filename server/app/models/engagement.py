"""Engagement: announcements, pulse surveys and recognition.

Three things a company says to its people, and one they say to each other.

The table that matters most here is the one that is deliberately **not** joined
to anything.

Anonymity is structural, not a promise
--------------------------------------

A pulse survey that says "your answers are anonymous" and stores a ``user_id``
next to each answer is not anonymous — it is anonymous until somebody with
database access is curious, or until a subpoena arrives, or until a well-meaning
engineer adds a "who has not responded yet" report and joins the two tables.

So for an anonymous survey the response carries **no user id at all**.
:class:`SurveyResponse.user_id` is NULL and stays NULL, and there is no column
on it that could be joined back to a person.

Preventing a second submission still has to work, and it does — through
:class:`SurveyParticipant`, a separate table that records *that* somebody
responded and never *what* they said. The two tables share no key. That is the
whole design: the guarantee is that the join is impossible, not that nobody
writes it.

Two consequences worth stating:

* **``is_anonymous`` is immutable once a survey opens.** Flipping it afterwards
  would either retroactively expose people who answered believing otherwise, or
  silently discard attribution somebody expected. The service refuses.
* **Small populations are suppressed.** An anonymous survey with three
  respondents in a four-person team is not anonymous, and neither is a
  department breakdown of it. ``Survey.min_responses`` is the floor, and results
  below it are refused rather than shown with a warning — a warning is something
  a reader can ignore.

Read and acknowledged are different
-----------------------------------

:class:`AnnouncementRead` carries both. Opening a post is passive; acknowledging
it is an act somebody performed. A policy update needs the second, and "97% have
read it" would be a false answer to "has everybody accepted the new expenses
policy".
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

#: Default floor for showing anonymous survey results, and for any breakdown of
#: them. Four rather than three: three is small enough that one person's answer
#: moves the mean visibly, and everyone in a four-person team can work out who
#: said what from a three-response average.
DEFAULT_MIN_RESPONSES = 4


class AudienceKind(str, enum.Enum):
    """Who a post or a survey is for.

    Deliberately coarse. A rules engine over arbitrary attributes is a filter
    language nobody can read back six months later, and "everybody in these two
    departments" covers what companies actually send.
    """

    EVERYONE = "everyone"
    DEPARTMENTS = "departments"
    TEAMS = "teams"
    #: A named list. For the "these eleven people" case that no grouping fits.
    PEOPLE = "people"


class PostStatus(str, enum.Enum):
    DRAFT = "draft"
    PUBLISHED = "published"
    #: Off the feed, still readable by anybody who has the link. Not deleted:
    #: "we never announced that" is a claim the archive answers.
    ARCHIVED = "archived"


class SurveyStatus(str, enum.Enum):
    DRAFT = "draft"
    OPEN = "open"
    CLOSED = "closed"


class QuestionKind(str, enum.Enum):
    """How a question is answered.

    ``SCALE`` is the one that produces a number to average. ``TEXT`` is the one
    that produces the sentence somebody actually needed to read, and it is also
    the one that leaks identity in a small population — see the service.
    """

    SCALE = "scale"
    TEXT = "text"
    CHOICE = "choice"


class Announcement(UUIDMixin, TimestampMixin, Base):
    """Something the company is telling its people."""

    __tablename__ = "announcements"
    __table_args__ = (
        Index("ix_announcements_org_status", "org_id", "status"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)

    status: Mapped[str] = mapped_column(
        String(16), default=PostStatus.DRAFT.value, nullable=False
    )
    audience_kind: Mapped[str] = mapped_column(
        String(16), default=AudienceKind.EVERYONE.value, nullable=False
    )
    #: Department, team or user ids, depending on ``audience_kind``. Empty for
    #: EVERYONE. A JSON list rather than a join table: an audience is written
    #: once and read as a whole, never queried across.
    audience_ids: Mapped[list | None] = mapped_column(JSON, nullable=True)

    #: Stays at the top of the feed. One thing at a time in practice, but not
    #: enforced — a company with two genuinely urgent notices should not have to
    #: choose, and a constraint here would be a rule about editorial judgement.
    is_pinned: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    #: Whether reading is enough, or whether people must actively say they have
    #: seen it. See the module docstring on why those differ.
    requires_acknowledgement: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )
    #: Drops off the feed after this date. Null means it stays until archived —
    #: which is right for a policy and wrong for a canteen closure, so the
    #: author decides rather than a default.
    expires_on: Mapped[date | None] = mapped_column(Date, nullable=True)

    published_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    published_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    reads: Mapped[list["AnnouncementRead"]] = relationship(
        back_populates="announcement", cascade="all, delete-orphan"
    )

    @property
    def status_enum(self) -> PostStatus:
        try:
            return PostStatus(self.status)
        except ValueError:
            return PostStatus.DRAFT


class AnnouncementRead(UUIDMixin, TimestampMixin, Base):
    """That one person opened, or accepted, one announcement.

    Two timestamps rather than one flag. Opening a post is passive;
    acknowledging is an act. "97% have read it" is not an answer to "has
    everybody accepted the new expenses policy", and a single column would make
    those the same question.
    """

    __tablename__ = "announcement_reads"
    __table_args__ = (
        UniqueConstraint("announcement_id", "user_id",
                         name="uq_announcement_reads_post_user"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    announcement_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("announcements.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    read_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    acknowledged_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    announcement: Mapped["Announcement"] = relationship(back_populates="reads")


class Survey(UUIDMixin, TimestampMixin, Base):
    """A pulse survey. Read the module docstring before touching anything here."""

    __tablename__ = "surveys"
    __table_args__ = (
        Index("ix_surveys_org_status", "org_id", "status"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    status: Mapped[str] = mapped_column(
        String(16), default=SurveyStatus.DRAFT.value, nullable=False
    )
    audience_kind: Mapped[str] = mapped_column(
        String(16), default=AudienceKind.EVERYONE.value, nullable=False
    )
    audience_ids: Mapped[list | None] = mapped_column(JSON, nullable=True)

    #: **Immutable once the survey opens.** Flipping it afterwards would either
    #: retroactively expose people who answered believing otherwise, or discard
    #: attribution somebody expected. The service refuses.
    is_anonymous: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    #: The floor for showing results, and for any breakdown of them. See the
    #: module docstring: three responses in a four-person team is not anonymity.
    min_responses: Mapped[int] = mapped_column(
        Integer, default=DEFAULT_MIN_RESPONSES, nullable=False
    )

    opens_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    closes_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    questions: Mapped[list["SurveyQuestion"]] = relationship(
        back_populates="survey", cascade="all, delete-orphan",
        order_by="SurveyQuestion.sort_order",
    )

    @property
    def status_enum(self) -> SurveyStatus:
        try:
            return SurveyStatus(self.status)
        except ValueError:
            return SurveyStatus.DRAFT


class SurveyQuestion(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "survey_questions"

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    survey_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("surveys.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(
        String(12), default=QuestionKind.SCALE.value, nullable=False
    )
    #: Top of the scale for a SCALE question. Ignored otherwise.
    scale_max: Mapped[int] = mapped_column(Integer, default=5, nullable=False)
    #: The options for a CHOICE question, in order.
    choices: Mapped[list | None] = mapped_column(JSON, nullable=True)
    is_required: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    survey: Mapped["Survey"] = relationship(back_populates="questions")


class SurveyParticipant(UUIDMixin, TimestampMixin, Base):
    """That one person was asked, and whether they have answered.

    **Never what they answered.** This is the double-submission guard and the
    "who is still outstanding" list, and it is a separate table from
    :class:`SurveyResponse` for exactly that reason — see the module docstring.
    It shares no key with a response and there is nothing here to join on.
    """

    __tablename__ = "survey_participants"
    __table_args__ = (
        UniqueConstraint("survey_id", "user_id", name="uq_survey_participants"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    survey_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("surveys.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    #: The instant, not a flag — "when did the response rate move" is a question
    #: HR asks, and a boolean cannot answer it.
    responded_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class SurveyResponse(UUIDMixin, TimestampMixin, Base):
    """One submission.

    ``user_id`` is **NULL for an anonymous survey and is never written**. It
    exists only for the attributed case, which is a real and different thing —
    a manager-effectiveness survey that names the respondent is a legitimate
    instrument, and pretending otherwise would push companies into running it
    over email instead.
    """

    __tablename__ = "survey_responses"

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    survey_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("surveys.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    #: See the class docstring. NULL is the anonymous case and the default.
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    submitted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )

    answers: Mapped[list["SurveyAnswer"]] = relationship(
        back_populates="response", cascade="all, delete-orphan"
    )


class SurveyAnswer(UUIDMixin, TimestampMixin, Base):
    """One answer to one question.

    Three nullable value columns rather than one polymorphic blob: a rating that
    can be averaged has to be an integer the database understands, and "3" and
    the string "3" behave differently the first time somebody sorts them.
    """

    __tablename__ = "survey_answers"
    __table_args__ = (
        Index("ix_survey_answers_question", "question_id"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    response_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("survey_responses.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    question_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("survey_questions.id", ondelete="CASCADE"), nullable=False
    )
    rating: Mapped[int | None] = mapped_column(Integer, nullable=True)
    text: Mapped[str | None] = mapped_column(Text, nullable=True)
    choice: Mapped[str | None] = mapped_column(String(200), nullable=True)

    response: Mapped["SurveyResponse"] = relationship(back_populates="answers")


class Recognition(UUIDMixin, TimestampMixin, Base):
    """One person saying thank you to another, on the record.

    Optionally tagged with a competency from the performance catalogue, which is
    the point of it being in the same product: "Ownership — she took the
    incident at 2am" is a sentence that belongs in an appraisal, and re-typing
    it there from memory in March is how it gets lost.
    """

    __tablename__ = "recognitions"
    __table_args__ = (
        Index("ix_recognitions_org_created", "org_id", "created_at"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    #: SET NULL on both: somebody leaving must not erase the thanks they gave or
    #: received. The name is resolved for display and reads as "a former
    #: colleague" when it cannot be.
    from_user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    to_user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    message: Mapped[str] = mapped_column(Text, nullable=False)
    #: RESTRICT, like every other reference to the competency catalogue: one a
    #: recognition cites is deactivated, never deleted.
    competency_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("competencies.id", ondelete="RESTRICT"), nullable=True
    )
    #: False keeps it between the two people. Public is the default because the
    #: point of recognition is that other people see it, but a quiet thank you
    #: is a real thing and forcing it onto a feed would stop some being sent.
    is_public: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
