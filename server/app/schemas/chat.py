"""Wire shapes for team chat."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from app.schemas.common import ORMModel


class MessageOut(ORMModel):
    id: uuid.UUID
    channel_id: uuid.UUID
    #: Null where the author's account has been deleted. The message stays and
    #: the console renders it as from a former colleague — see the SET NULL note
    #: on the column.
    user_id: uuid.UUID | None = None
    user_name: str | None = None
    body: str
    created_at: datetime
    edited_at: datetime | None = None
    #: A removed message keeps its place in the thread and loses its body. The
    #: server blanks it here rather than trusting the console to hide it.
    is_deleted: bool = False

    # --- the attached file, described but never located -----------------------
    #
    # There is deliberately no `attachment_key` and no URL. The key is a storage
    # path, and putting one in a response body hands the reader something that
    # keeps working after they leave the channel. The console fetches
    # `/chat/messages/{id}/attachment`, which re-checks membership every time.
    attachment_name: str | None = None
    attachment_type: str | None = None
    attachment_size: int | None = None
    #: Whether the console should draw it in the thread rather than as a row
    #: with a download link. Decided server-side so "which types are safe to
    #: render" is answered once, next to the allow-list that admits them.
    attachment_inline: bool = False


class ChannelOut(BaseModel):
    id: uuid.UUID
    kind: str
    #: Resolved for the caller. A direct channel is named after the *other*
    #: person, so the same row has two titles depending on who is asking.
    title: str
    #: How many people can currently read it — derived, so it moves when
    #: somebody joins the team rather than when anybody updates the channel.
    members: int
    unread: int
    last_message_at: datetime | None = None
    #: A one-line preview, so the list is readable without opening anything.
    last_message_preview: str | None = None
    #: Groups only: whether this caller may rename it or change who is in it.
    #: Resolved here rather than by the console comparing ids, because the rule
    #: has a fallback the console does not know about — see
    #: ``services.chat.can_administer_group``.
    can_administer: bool = False


class PostIn(BaseModel):
    body: str = Field(min_length=1, max_length=4000)


class GroupIn(BaseModel):
    """Start a group. The creator is added by the service, not named here."""

    name: str = Field(min_length=1, max_length=120)
    #: At least one colleague — a group of one is a note to self, and the
    #: product has no such thing.
    user_ids: list[uuid.UUID] = Field(min_length=1, max_length=50)


class GroupRenameIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class MembersIn(BaseModel):
    user_ids: list[uuid.UUID] = Field(min_length=1, max_length=50)


class MemberOut(BaseModel):
    id: uuid.UUID
    full_name: str
    #: True for the one person who may administer the group, so the members
    #: panel can say who that is rather than leaving everybody guessing.
    is_admin: bool = False


class DirectIn(BaseModel):
    user_id: uuid.UUID


class TicketOut(BaseModel):
    """A short-lived, single-purpose credential for opening the socket.

    A browser cannot set an ``Authorization`` header on a WebSocket handshake,
    so the credential has to travel in the URL — and a URL is the one place a
    long-lived access token must never be, because it lands in proxy logs,
    referrer headers and browser history.

    So the console exchanges its bearer token for this over ordinary HTTP: a
    separate token, typed so it opens nothing but a socket, and expiring in
    under a minute.
    """

    ticket: str
    expires_in: int
