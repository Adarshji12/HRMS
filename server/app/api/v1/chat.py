"""Team chat: channels, threads, and the socket that pushes new messages.

Every rule lives in ``app.services.chat``. This file resolves who is asking,
turns a :class:`~app.services.chat.ChatError` into a typed HTTP response, and
pushes accepted messages to whoever is connected.

**Posting is HTTP; the socket only delivers.** A client cannot send anything
over the WebSocket that the server acts on — see the note on
``services/chathub.py``. That keeps one write path with one set of checks, and
means a broken socket costs live updates rather than the ability to speak.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import NoReturn

from fastapi import (
    APIRouter,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi import Response
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession
from app.core.security import create_access_token, decode_access_token
from app.db.session import SessionLocal
from app.models import ChatMessage, User
from app.schemas.chat import (
    ChannelOut,
    DirectIn,
    GroupIn,
    GroupRenameIn,
    MemberOut,
    MembersIn,
    MessageOut,
    PostIn,
    TicketOut,
)
from app.services import chat as svc
from app.services.chathub import hub

router = APIRouter(prefix="/chat", tags=["chat"])

#: The socket ticket's life. Long enough to survive a slow handshake on a phone,
#: short enough that one leaked out of a log is worthless by the time it is read.
TICKET_TTL_SECONDS = 30


def _fail(error: svc.ChatError) -> NoReturn:
    raise HTTPException(
        error.status_code, detail={"reason": error.code, "message": error.message}
    )


def _names(db, org_id: uuid.UUID) -> dict[uuid.UUID, str]:
    return {
        row[0]: row[1]
        for row in db.execute(select(User.id, User.full_name).where(User.org_id == org_id))
    }


def _message_out(message: ChatMessage, names: dict[uuid.UUID, str]) -> MessageOut:
    deleted = message.deleted_at is not None
    return MessageOut(
        id=message.id,
        channel_id=message.channel_id,
        user_id=message.user_id,
        user_name=names.get(message.user_id) if message.user_id else None,
        # Blanked here, on the server. A console that received the text of a
        # removed message and merely chose not to draw it has not removed it.
        body="" if deleted else message.body,
        created_at=message.created_at,
        edited_at=message.edited_at,
        is_deleted=deleted,
        # A removed message loses its file along with its text. The bytes are
        # still in storage until retention sweeps them, but nothing in the
        # console offers them and the download endpoint refuses.
        attachment_name=None if deleted else message.attachment_name,
        attachment_type=None if deleted else message.attachment_type,
        attachment_size=None if deleted else message.attachment_size,
        attachment_inline=(
            not deleted
            and (message.attachment_type or "") in svc.INLINE_ATTACHMENT_TYPES
        ),
    )


def _channel_out(db, viewer, channel, *, unread: int = 0, preview: str | None = None) -> ChannelOut:
    """One channel, resolved for this reader. Built here rather than three
    times, because `can_administer` is easy to forget on the copy nobody looks
    at and a group that cannot be edited from one screen is a bug report."""
    return ChannelOut(
        id=channel.id,
        kind=channel.kind,
        title=svc.channel_title(db, channel, viewer),
        members=len(svc.member_ids(db, channel)),
        unread=unread,
        last_message_at=channel.last_message_at,
        last_message_preview=preview,
        can_administer=svc.can_administer_group(db, viewer, channel),
    )


# --------------------------------------------------------------------------- #
# Channels
# --------------------------------------------------------------------------- #


@router.get("/channels", response_model=list[ChannelOut])
def channels(viewer: CurrentUser, db: DbSession) -> list[ChannelOut]:
    """Everything this person can open, most recently active first.

    Provisioning happens here rather than in a migration or a signup hook: a
    team channel exists the first time somebody on that team opens chat, and a
    team created next month gets one on the same path. See
    ``services.chat.ensure_channels`` for why there is only one such path.
    """
    svc.ensure_channels(db, viewer)
    db.commit()

    rows = svc.channels_for(db, viewer)
    unread = svc.unread_counts(db, viewer, rows)

    previews: dict[uuid.UUID, str] = {}
    for channel in rows:
        latest = db.scalar(
            select(ChatMessage)
            .where(ChatMessage.channel_id == channel.id, ChatMessage.deleted_at.is_(None))
            .order_by(ChatMessage.created_at.desc())
            .limit(1)
        )
        if latest is not None:
            # An attachment with no caption has an empty body. "Sent a file" is
            # a truer preview than a blank line, which reads as a bug.
            previews[channel.id] = (
                latest.body[:120] or (f"📎 {latest.attachment_name}" if latest.attachment_key else "")
            )

    return [
        _channel_out(
            db, viewer, channel,
            unread=unread.get(channel.id, 0),
            preview=previews.get(channel.id),
        )
        for channel in rows
    ]


@router.post("/direct", response_model=ChannelOut)
def direct(payload: DirectIn, viewer: CurrentUser, db: DbSession) -> ChannelOut:
    """Open — or reopen — the conversation with one person."""
    try:
        channel = svc.open_direct(db, viewer, payload.user_id)
    except svc.ChatError as error:
        _fail(error)
    db.commit()
    db.refresh(channel)
    return _channel_out(db, viewer, channel)


# --------------------------------------------------------------------------- #
# Messages
# --------------------------------------------------------------------------- #


@router.get("/channels/{channel_id}/messages", response_model=list[MessageOut])
def messages(
    channel_id: uuid.UUID,
    viewer: CurrentUser,
    db: DbSession,
    before: datetime | None = Query(default=None),
) -> list[MessageOut]:
    """One page of a thread, oldest-first within the page.

    ``before`` pages backwards by timestamp rather than by offset: the thread
    grows at the end while somebody scrolls back through it, and an offset
    repeats or skips a message every time it does.
    """
    try:
        channel = svc.ensure_readable(db, viewer, channel_id)
    except svc.ChatError as error:
        _fail(error)

    rows = svc.history(db, channel, before=before)
    # Reading the newest page is what marks a channel read. Paging further back
    # is not: somebody scrolling through last month has not read what arrived
    # while they were doing it.
    if before is None:
        svc.mark_read(db, viewer, channel)
        db.commit()

    return [_message_out(row, _names(db, viewer.org_id)) for row in rows]


@router.post(
    "/channels/{channel_id}/messages",
    response_model=MessageOut,
    status_code=status.HTTP_201_CREATED,
)
async def post_message(
    channel_id: uuid.UUID, payload: PostIn, viewer: CurrentUser, db: DbSession
) -> MessageOut:
    """Say something, then push it to everyone connected who may read it.

    The push happens **after the commit**, never before. A message delivered
    live and then lost to a rolled-back transaction is the one failure a chat
    application must not have: the reader saw it, and no reload will show it
    again.
    """
    try:
        channel = svc.ensure_readable(db, viewer, channel_id)
        message = svc.post(db, viewer, channel, payload.body)
    except svc.ChatError as error:
        _fail(error)

    recipients = svc.member_ids(db, channel)
    db.commit()
    db.refresh(message)
    out = _message_out(message, _names(db, viewer.org_id))

    await hub.send_to(recipients, {"type": "message", "message": out.model_dump(mode="json")})
    return out


@router.delete("/messages/{message_id}", response_model=MessageOut)
async def delete_message(
    message_id: uuid.UUID, viewer: CurrentUser, db: DbSession
) -> MessageOut:
    """Remove one's own message. Author only — see ``services.chat.remove``."""
    try:
        message = svc.remove(db, viewer, message_id)
        channel = svc.ensure_readable(db, viewer, message.channel_id)
    except svc.ChatError as error:
        _fail(error)

    recipients = svc.member_ids(db, channel)
    db.commit()
    db.refresh(message)
    out = _message_out(message, _names(db, viewer.org_id))

    await hub.send_to(recipients, {"type": "deleted", "message": out.model_dump(mode="json")})
    return out


@router.post(
    "/channels/{channel_id}/read",
    status_code=status.HTTP_204_NO_CONTENT,
    # Explicit, matching admin.py: without it FastAPI infers NoneType from
    # `-> None` and rejects a 204 route as "must not have a response body".
    response_model=None,
)
def read(channel_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> None:
    try:
        channel = svc.ensure_readable(db, viewer, channel_id)
    except svc.ChatError as error:
        _fail(error)
    svc.mark_read(db, viewer, channel)
    db.commit()


# --------------------------------------------------------------------------- #
# Groups
#
# Declared before the socket section and after the messages one, and every path
# here is a literal under /chat/groups or /chat/channels/{id}/... so nothing
# collides with the message routes above.
# --------------------------------------------------------------------------- #


@router.post("/groups", response_model=ChannelOut, status_code=status.HTTP_201_CREATED)
def create_group(payload: GroupIn, viewer: CurrentUser, db: DbSession) -> ChannelOut:
    """Start a named conversation with chosen colleagues.

    Open to everybody, deliberately. A group is how two people from different
    teams talk about a piece of work, and putting that behind an administrator
    would mean raising a ticket to have a conversation.
    """
    try:
        channel = svc.create_group(
            db, viewer, name=payload.name, user_ids=payload.user_ids
        )
    except svc.ChatError as error:
        _fail(error)
    db.commit()
    db.refresh(channel)
    return _channel_out(db, viewer, channel)


@router.get("/channels/{channel_id}/members", response_model=list[MemberOut])
def members(channel_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> list[MemberOut]:
    """Who is in a channel.

    Readable for every kind, not only groups: "who can see this" is a fair
    question about a department channel too, and the answer is already implied
    by the member count the list shows.
    """
    try:
        channel = svc.ensure_readable(db, viewer, channel_id)
    except svc.ChatError as error:
        _fail(error)

    people = db.scalars(
        select(User)
        .where(User.id.in_(svc.member_ids(db, channel)))
        .order_by(User.full_name)
    ).all()
    return [
        MemberOut(
            id=person.id,
            full_name=person.full_name,
            is_admin=channel.created_by == person.id,
        )
        for person in people
    ]


@router.post("/channels/{channel_id}/members", response_model=list[MemberOut])
async def add_members(
    channel_id: uuid.UUID, payload: MembersIn, viewer: CurrentUser, db: DbSession
) -> list[MemberOut]:
    """Add colleagues to a group.

    The people added are told over the socket rather than discovering the group
    the next time they happen to reload: a channel that appears silently is one
    somebody misses for a day.
    """
    try:
        channel = svc.ensure_readable(db, viewer, channel_id)
        added = svc.add_members(db, viewer, channel, payload.user_ids)
    except svc.ChatError as error:
        _fail(error)

    db.commit()
    if added:
        await hub.send_to([person.id for person in added], {"type": "channels"})
    return [
        MemberOut(id=person.id, full_name=person.full_name, is_admin=False)
        for person in added
    ]


@router.delete(
    "/channels/{channel_id}/members/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
async def remove_member(
    channel_id: uuid.UUID, user_id: uuid.UUID, viewer: CurrentUser, db: DbSession
) -> None:
    """Remove somebody from a group, or leave it yourself.

    One route for both because it is one write; the service decides which of
    the two the caller is allowed to be doing.
    """
    try:
        channel = svc.ensure_readable(db, viewer, channel_id)
        svc.remove_member(db, viewer, channel, user_id)
    except svc.ChatError as error:
        _fail(error)
    db.commit()
    # Told after the commit, and told to refresh rather than sent the channel:
    # somebody who has just been removed must not receive its contents.
    await hub.send_to([user_id], {"type": "channels"})


@router.patch("/channels/{channel_id}", response_model=ChannelOut)
def rename_group(
    channel_id: uuid.UUID, payload: GroupRenameIn, viewer: CurrentUser, db: DbSession
) -> ChannelOut:
    try:
        channel = svc.ensure_readable(db, viewer, channel_id)
        channel = svc.rename_group(db, viewer, channel, payload.name)
    except svc.ChatError as error:
        _fail(error)
    db.commit()
    db.refresh(channel)
    return _channel_out(db, viewer, channel)


# --------------------------------------------------------------------------- #
# Attachments
# --------------------------------------------------------------------------- #


@router.post(
    "/channels/{channel_id}/attachments",
    response_model=MessageOut,
    status_code=status.HTTP_201_CREATED,
)
async def send_attachment(
    channel_id: uuid.UUID,
    viewer: CurrentUser,
    db: DbSession,
    file: UploadFile = File(...),
    body: str = Form(default=""),
) -> MessageOut:
    """Send one file, with an optional caption, as a message.

    A separate route from ``post_message`` rather than one route that takes
    either: multipart and JSON are different request shapes, and a handler that
    accepts both ends up validating neither properly.

    The file is stored **before** the row is written and outside the
    transaction — see ``services.chat.store_file``. A stored object with no
    message pointing at it is litter that retention clears; a message pointing
    at an object that was never stored is a broken thread.
    """
    # One byte past the ceiling, so an oversize upload is refused on its size
    # rather than after the whole thing has been buffered.
    raw = await file.read(svc.MAX_ATTACHMENT_BYTES + 1)
    try:
        channel = svc.ensure_readable(db, viewer, channel_id)
        stored = svc.store_file(
            viewer,
            file_name=file.filename or "",
            content_type=file.content_type or "",
            raw=raw,
        )
        message = svc.post(db, viewer, channel, body, attachment=stored)
    except svc.ChatError as error:
        _fail(error)

    recipients = svc.member_ids(db, channel)
    db.commit()
    db.refresh(message)
    out = _message_out(message, _names(db, viewer.org_id))

    await hub.send_to(recipients, {"type": "message", "message": out.model_dump(mode="json")})
    return out


@router.get("/messages/{message_id}/attachment", response_model=None)
def download_attachment(
    message_id: uuid.UUID, viewer: CurrentUser, db: DbSession
) -> Response:
    """The only way to read an attachment.

    Membership is re-checked here on every request, which is the whole reason
    the storage key never appears in a response body.

    ``Content-Disposition: attachment`` is set for **every** type including the
    images the console renders inline. Inline rendering happens through an
    object URL the console builds from these bytes; the browser is never asked
    to navigate to this endpoint and display whatever comes back, because that
    is how an uploaded file becomes script running on the console's own origin.
    """
    try:
        message, served = svc.serve_attachment(db, viewer, message_id)
    except svc.ChatError as error:
        _fail(error)

    if served.url:
        return RedirectResponse(served.url, status_code=status.HTTP_307_TEMPORARY_REDIRECT)
    return FileResponse(
        served.path,
        media_type=message.attachment_type or "application/octet-stream",
        filename=message.attachment_name or None,
        content_disposition_type="attachment",
    )


# --------------------------------------------------------------------------- #
# The socket
# --------------------------------------------------------------------------- #


@router.post("/ticket", response_model=TicketOut)
def ticket(viewer: CurrentUser) -> TicketOut:
    """Exchange a bearer token for a short-lived socket credential.

    A browser cannot set a header on a WebSocket handshake, so the credential
    must travel in the URL — and a URL is exactly where a long-lived access
    token must never be: proxy logs, referrer headers, browser history. This is
    a separate token typed ``chat_ws``, which the socket handler accepts and
    nothing else does, and it expires in under a minute.
    """
    return TicketOut(
        ticket=create_access_token(
            str(viewer.id),
            {"typ": "chat_ws", "org": str(viewer.org_id)},
            expires_minutes=1,
        ),
        expires_in=TICKET_TTL_SECONDS,
    )


@router.websocket("/ws")
async def socket(websocket: WebSocket, ticket: str = Query(...)) -> None:
    """Live delivery. Read-only from the client's side.

    Nothing arriving on this socket is acted on — see the note at the top of
    ``services/chathub.py``. The receive loop exists only to notice the client
    going away; a browser that sends chatter is ignored rather than trusted.
    """
    payload = decode_access_token(ticket)
    if not payload or payload.get("typ") != "chat_ws":
        # Refused before accept, so the handshake fails outright rather than
        # opening a socket and closing it with a code the client has to inspect.
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    try:
        user_id = uuid.UUID(payload["sub"])
        org_id = uuid.UUID(payload["org"])
    except (KeyError, ValueError):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    # Re-checked against the database, not taken from the ticket. A ticket minted
    # a minute ago for somebody who has since been deactivated must not open a
    # socket that then receives their old team's messages.
    with SessionLocal() as db:
        user = db.get(User, user_id)
        if user is None or not user.is_active or user.org_id != org_id:
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return

    await websocket.accept()
    await hub.join(user_id, websocket)
    try:
        await websocket.send_json({"type": "ready"})
        while True:
            # Discarded. The loop is here to detect the disconnect.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001 — a broken socket is not a server error
        pass
    finally:
        await hub.leave(user_id, websocket)
