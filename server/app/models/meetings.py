"""Meetings: a time, a set of people, and a room to meet in.

**Invitees are stored, not derived — the opposite of chat, deliberately.**

A team channel's members are whoever is on the team *right now*, because a
channel is a place and the team is the answer to who belongs in it. A meeting is
not a place, it is an event: "these nine people, Thursday at ten". Deriving that
from a team would rewrite history every time somebody joined or left — last
month's retrospective would show today's team in the room, and a person who has
since moved on would vanish from a meeting they actually attended.

So the invitee list is a **snapshot taken at the moment of scheduling**. The
console seeds it from a team, a department or the org chart, which is where the
convenience lives; what gets written is a list of names.

**The room name is the secret.** There is no password on a public Jitsi room —
anyone who knows the name is in it. So the name is a random token, never derived
from the meeting's title or the company's, and it is handed out only by the join
endpoint and only to somebody on the invitee list inside the join window. A room
called ``acme-standup`` is a room a stranger guesses on the first try.

**Attendance records arrival, not duration.** A row is stamped when somebody is
handed the room. Knowing when they left would mean embedding the provider's
JavaScript in the console and trusting what it reports; arrival is a fact the
server observed itself, and it is the one the question "who turned up" needs.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDMixin


class MeetingStatus(str, enum.Enum):
    SCHEDULED = "scheduled"
    #: Called off. The row and its invitees stay — a cancelled meeting is a
    #: thing that happened to people's calendars, not a thing to erase.
    CANCELLED = "cancelled"


class Meeting(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "meetings"
    __table_args__ = (
        # The company's calendar, by time. Every listing hits this.
        Index("ix_meetings_org_start", "org_id", "starts_at"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    agenda: Mapped[str | None] = mapped_column(Text, nullable=True)

    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    #: Minutes. Stored rather than an end timestamp because "45 minutes" is what
    #: somebody schedules and what they change when it moves — an end time has
    #: to be recomputed every time the start does, and one of the two writes
    #: eventually gets missed.
    duration_minutes: Mapped[int] = mapped_column(Integer, default=30, nullable=False)

    #: SET NULL, like a chat message's author: deleting an employee must not
    #: delete the meetings they organised out of everybody else's calendar.
    host_user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )

    #: The random room token. Unique per company, and never derived from the
    #: title — see the module docstring on why the name is the secret.
    room: Mapped[str] = mapped_column(String(64), nullable=False)

    status: Mapped[str] = mapped_column(
        String(16), default=MeetingStatus.SCHEDULED.value, nullable=False
    )

    #: What the list was seeded from, kept for the console's benefit only — it
    #: labels the meeting "the Platform team" rather than listing nine names.
    #: It is NOT consulted when deciding who may join; the invitee rows are.
    seeded_from: Mapped[str | None] = mapped_column(String(120), nullable=True)

    @property
    def status_enum(self) -> MeetingStatus:
        return MeetingStatus(self.status)


class MeetingInvitee(UUIDMixin, TimestampMixin, Base):
    """One person on one meeting's list, and whether they turned up.

    Invitation and attendance share a row rather than sitting in two tables.
    They are one fact per person per meeting — "asked, and here is what
    happened" — and splitting them would mean a join to answer the only question
    anybody asks of either.
    """

    __tablename__ = "meeting_invitees"
    __table_args__ = (
        UniqueConstraint("meeting_id", "user_id", name="uq_meeting_invitees_meeting_user"),
        # "My meetings", which is the query the console opens with.
        Index("ix_meeting_invitees_user", "user_id"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    meeting_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    #: Stamped the first time the server hands this person the room, and never
    #: moved afterwards — the answer to "when did you arrive" is the first time,
    #: not the last time you rejoined after a dropout.
    joined_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
