"""Team chat: channels, messages and read state.

**Membership is derived, not stored — for the channels that have an org answer.**

That is the one decision the whole module hangs off. A team channel's members
are the people whose ``users.team_id`` is that team; a department channel's are
the people in that department. There is no membership table for either, because
there is already an answer to "who is in this team" and a second one would drift
from it the first time somebody moved desks. Add a person to a team and they are
in its channel that afternoon; move them out and they stop being, without anyone
remembering to run a second update.

Only a **direct** channel — a conversation between two named people — has
explicit rows, because there is nothing in the org structure that describes it.

The cost is that a team channel cannot have a guest, and that is deliberate for
now: the alternative is a hybrid where membership is *sometimes* derived, which
is the shape that produces "why can Priya still see this" tickets. When guests
are genuinely needed, the answer is a fourth kind with fully explicit
membership, not an exception carved into these three.

**Messages are never hard-deleted.** ``deleted_at`` blanks the body for readers
and keeps the row, so a thread does not silently renumber and a moderation
question has something to answer with. Retention, when it comes, deletes rows on
a schedule — a different operation from a person removing a message.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
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


class ChannelKind(str, enum.Enum):
    """What decides who can read a channel.

    The value is not decoration — it selects the membership rule in
    ``services.chat.member_ids``, and every kind must have exactly one.
    """

    #: Everyone whose ``users.team_id`` is this channel's team.
    TEAM = "team"
    #: Everyone whose ``users.department_id`` is this channel's department.
    DEPARTMENT = "department"
    #: Exactly the two people with rows in ``chat_channel_members``.
    DIRECT = "direct"
    #: A conversation somebody made by hand and chose the members of.
    #:
    #: The only kind whose membership is neither derived from the org chart nor
    #: fixed at two people, which is why it exists at all: a project cutting
    #: across three teams has nowhere else to talk. Membership is read from
    #: ``chat_channel_members``, the same table a direct channel uses, so
    #: ``member_ids`` needed no new branch to support it.
    GROUP = "group"


class ChatChannel(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "chat_channels"
    __table_args__ = (
        # One channel per team and per department, enforced by the database
        # rather than by the service that creates them lazily. Two requests
        # arriving together for a team whose channel does not exist yet is the
        # ordinary case on a Monday morning, and the loser of that race must
        # fail on a constraint and re-read, not create a second channel.
        UniqueConstraint("org_id", "team_id", name="uq_chat_channels_org_team"),
        UniqueConstraint("org_id", "department_id", name="uq_chat_channels_org_department"),
        # The canonical pair for a direct channel — see `pair_key`.
        UniqueConstraint("org_id", "pair_key", name="uq_chat_channels_org_pair"),
        # The channel list for one company, newest activity first.
        Index("ix_chat_channels_org_kind", "org_id", "kind"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(String(16), nullable=False)

    #: Set on TEAM channels only. CASCADE: a deleted team takes its channel with
    #: it, because a channel whose membership rule points at nothing has no
    #: readers and no way to gain any.
    team_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("teams.id", ondelete="CASCADE"), nullable=True, index=True
    )
    #: Set on DEPARTMENT channels only. Same reasoning.
    department_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("departments.id", ondelete="CASCADE"), nullable=True, index=True
    )

    #: Set on DIRECT channels only: the two user ids, sorted and joined, so one
    #: pair can only ever have one channel however the two people open it. A
    #: nullable unique column is the right tool here — every non-direct channel
    #: leaves it NULL, and SQL lets NULLs repeat in a unique index.
    pair_key: Mapped[str | None] = mapped_column(String(80), nullable=True)

    #: Only for a direct channel, which has no team or department to name it
    #: after, and for a GROUP, which is named by whoever made it. Derived
    #: channels take their name from the row they point at, so renaming a team
    #: renames its channel with no write here at all.
    name: Mapped[str | None] = mapped_column(String(120), nullable=True)

    #: Who created a GROUP. NULL on every derived channel, because nobody
    #: created those — the org chart did.
    #:
    #: SET NULL rather than CASCADE: the person who started a project channel
    #: leaving the company must not delete the conversation underneath everyone
    #: still in it. A group whose creator is gone is administered by its
    #: remaining members — see ``services.chat.can_administer_group``.
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    #: Stamped on every post. It exists so the channel list can be ordered by
    #: recency without a correlated MAX(created_at) per channel on every load.
    last_message_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    @property
    def kind_enum(self) -> ChannelKind:
        return ChannelKind(self.kind)


class ChatChannelMember(UUIDMixin, TimestampMixin, Base):
    """Explicit membership. **Direct channels only** — see the module docstring."""

    __tablename__ = "chat_channel_members"
    __table_args__ = (
        UniqueConstraint("channel_id", "user_id", name="uq_chat_members_channel_user"),
        Index("ix_chat_members_user", "user_id"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    channel_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("chat_channels.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )


class ChatMessage(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "chat_messages"
    __table_args__ = (
        # One channel's thread, newest first. Every message read hits this, and
        # it is the index the keyset pagination in `services.chat.history`
        # pages backwards along.
        Index("ix_chat_messages_channel_created", "channel_id", "created_at"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    channel_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("chat_channels.id", ondelete="CASCADE"), nullable=False
    )
    #: SET NULL rather than CASCADE. Deleting an employee must not silently
    #: remove their side of every conversation they were part of — the thread
    #: would close up around the gap and read as though it never happened.
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    #: Empty string is legal, and only for a message that carries a file: an
    #: attachment with no caption is an ordinary thing to send, and forcing a
    #: word out of somebody first would be a rule with no purpose. Every write
    #: path still refuses a message that is empty AND has no attachment — see
    #: ``services.chat.post``.
    body: Mapped[str] = mapped_column(Text, nullable=False)

    # --- one attached file, or none ------------------------------------------
    #
    # Inline on the message rather than a table of their own, because the
    # product allows exactly one file per message: a second table would buy
    # nothing today and cost a join on every page of history. If multiple
    # attachments are ever wanted, that is the moment to split them out.
    #
    # The KEY IS NEVER SERIALISED. It is a storage path, and handing one to a
    # browser invites somebody to try fetching it directly — bypassing the
    # membership check that is the only thing standing between a private
    # channel and everybody else. The download endpoint re-checks membership on
    # every request and streams the bytes itself; see
    # ``api/v1/chat.download_attachment``.
    attachment_key: Mapped[str | None] = mapped_column(String(512), nullable=True)
    #: The name as the sender's computer had it, shown and used for the
    #: download. Never used to build the storage key — a filename is attacker
    #: input and a path separator in one is how it escapes the directory.
    attachment_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    attachment_type: Mapped[str | None] = mapped_column(String(120), nullable=True)
    attachment_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    #: Soft delete. The row stays; readers get a tombstone. See the module note.
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ChatRead(UUIDMixin, TimestampMixin, Base):
    """How far one person has read one channel.

    A row per person per channel they have actually opened — absence means "has
    never opened it", which is a different thing from "has read nothing" only in
    that nobody had to write a row for the hundred channels they never look at.
    """

    __tablename__ = "chat_reads"
    __table_args__ = (
        UniqueConstraint("channel_id", "user_id", name="uq_chat_reads_channel_user"),
        Index("ix_chat_reads_user", "user_id"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    channel_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("chat_channels.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    last_read_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
