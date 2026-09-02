"""Team chat: who may read what, what the thread says, and posting to it.

Every rule lives here. The router resolves who is asking and turns a
:class:`ChatError` into an HTTP response; a handler that contains a chat rule is
a bug, exactly as in ``leave.py`` and ``corehr.py``.

Two ideas carry the module.

**One function answers "who is in this channel".** :func:`member_ids` is it, and
it is the only place any kind's membership rule is written down. Everything else
— the access check, the fan-out to open sockets, the unread count — calls it.
The moment a second function decides membership, the socket fan-out and the
permission check can disagree, and the way that failure presents is a message
delivered live to somebody who is not allowed to load it.

**Reads are scoped by that same function, never by the org alone.** Every query
here filters on a channel the caller has already been proved a member of. There
is no "list all messages in my org" path, because there is no question that
needs one.
"""

from __future__ import annotations

import re
import uuid
from typing import Iterable
from datetime import datetime, timezone

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.services import storage
from app.models import (
    ChannelKind,
    ChatChannel,
    ChatChannelMember,
    ChatMessage,
    ChatRead,
    Department,
    Team,
    User,
)

#: A single message. Long enough for a paragraph, short enough that the thread
#: stays a conversation rather than a document store.
MAX_BODY_CHARS = 4000

#: How many messages one history page returns.
PAGE_SIZE = 50

#: One attached file. Smaller than an expense receipt's 15 MB on purpose: a
#: receipt is evidence somebody is required to produce, and a chat attachment is
#: a convenience. A 25 MB video in a team channel is a file-sharing product, and
#: this is not one.
MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

#: What may be sent. An allow-list, not a deny-list — the failure mode of a deny
#: list is that everything nobody thought of gets through, and the thing nobody
#: thought of is the one that matters.
#:
#: Deliberately absent: anything executable, and anything the browser will run
#: if it is ever served inline. The download endpoint sets
#: ``Content-Disposition: attachment`` regardless, so this is the second of two
#: defences rather than the only one.
ALLOWED_ATTACHMENT_TYPES = frozenset({
    "image/png", "image/jpeg", "image/gif", "image/webp",
    "application/pdf",
    "text/plain", "text/csv",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/zip",
})

#: Rendered inline in the thread rather than as a row with a download link.
#: Images only, and only the formats every browser decodes natively.
INLINE_ATTACHMENT_TYPES = frozenset({"image/png", "image/jpeg", "image/gif", "image/webp"})

#: How many people one group may hold. Not a technical limit — a "group" of
#: eighty is an announcement list, and the product has a noticeboard for that.
MAX_GROUP_MEMBERS = 50

_SAFE_SUFFIX = re.compile(r"^\.[A-Za-z0-9]{1,8}$")


def _suffix_for(file_name: str) -> str:
    """The extension, if it is plausibly an extension.

    A filename is attacker input. This never builds a storage path out of it —
    the key is a UUID — and the suffix is only kept so a downloaded file opens
    in the right application.
    """
    suffix = ("." + file_name.rsplit(".", 1)[-1]) if "." in file_name else ""
    return suffix if _SAFE_SUFFIX.match(suffix) else ""


class ChatError(Exception):
    """A rule said no, with a code the console can branch on."""

    def __init__(self, code: str, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime) -> datetime:
    """Attach UTC to a timestamp the database handed back without one.

    Postgres returns ``timestamptz`` columns as timezone-aware datetimes;
    SQLite has no timezone type and returns them naive. Comparing one of each
    raises ``TypeError``, so the same expression works in production and
    crashes in development — or the reverse, which is worse.

    Every comparison in this module that puts a stored timestamp next to a
    freshly-minted one goes through here. Comparisons where *both* sides come
    out of the database are left alone: they are already consistent, and the
    right place for those is inside the query anyway.
    """
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def pair_key(a: uuid.UUID, b: uuid.UUID) -> str:
    """The canonical identity of a two-person conversation.

    Sorted, so opening a chat with somebody produces the same key whichever of
    the two of you clicked first. The unique index on it is what stops a pair
    ending up with two half-populated threads.
    """
    first, second = sorted([str(a), str(b)])
    return f"{first}:{second}"


# --------------------------------------------------------------------------- #
# Membership — the single rule
# --------------------------------------------------------------------------- #


def member_ids(db: Session, channel: ChatChannel) -> list[uuid.UUID]:
    """Everyone who may read this channel, right now.

    Derived for team and department channels — see the module docstring on
    ``models/chat.py`` for why there is no membership table for those — and read
    from ``chat_channel_members`` for a direct one.

    Inactive users are excluded. A deactivated account keeping a live socket
    open on its old team's channel is the leak this line prevents.
    """
    kind = channel.kind_enum

    if kind is ChannelKind.TEAM:
        if channel.team_id is None:
            return []
        stmt = select(User.id).where(
            User.org_id == channel.org_id,
            User.team_id == channel.team_id,
            User.is_active.is_(True),
        )
    elif kind is ChannelKind.DEPARTMENT:
        if channel.department_id is None:
            return []
        stmt = select(User.id).where(
            User.org_id == channel.org_id,
            User.department_id == channel.department_id,
            User.is_active.is_(True),
        )
    else:
        stmt = (
            select(ChatChannelMember.user_id)
            .join(User, User.id == ChatChannelMember.user_id)
            .where(
                ChatChannelMember.channel_id == channel.id,
                User.is_active.is_(True),
            )
        )

    return list(db.scalars(stmt))


def can_read(db: Session, user: User, channel: ChatChannel) -> bool:
    """Membership *and* tenancy. The org check is not redundant.

    A channel id is a guessable-shaped value arriving from a client, and
    ``member_ids`` for a direct channel reads a membership table that says
    nothing about which company the channel belongs to. Both, always.
    """
    if channel.org_id != user.org_id:
        return False
    return user.id in set(member_ids(db, channel))


def ensure_readable(db: Session, user: User, channel_id: uuid.UUID) -> ChatChannel:
    """Load a channel this person may read, or refuse.

    404 rather than 403 for a channel they are not in. Answering "forbidden"
    would confirm the channel exists, which for a direct message between two
    other people is itself the thing worth not confirming.
    """
    channel = db.get(ChatChannel, channel_id)
    if channel is None or not can_read(db, user, channel):
        raise ChatError("not_found", "That conversation does not exist.", 404)
    return channel


# --------------------------------------------------------------------------- #
# Provisioning
# --------------------------------------------------------------------------- #


def _create(db: Session, **fields) -> ChatChannel:
    """Insert a channel, tolerating the race the unique constraints exist for.

    Two people from the same team opening chat at the same time on a Monday is
    the ordinary case, not an edge one. The loser of that race re-reads rather
    than failing, which is only safe because the constraint is in the database
    and not in a check above this line.
    """
    channel = ChatChannel(id=uuid.uuid4(), **fields)
    db.add(channel)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        lookup = select(ChatChannel).where(ChatChannel.org_id == fields["org_id"])
        if fields.get("team_id") is not None:
            lookup = lookup.where(ChatChannel.team_id == fields["team_id"])
        elif fields.get("department_id") is not None:
            lookup = lookup.where(ChatChannel.department_id == fields["department_id"])
        else:
            lookup = lookup.where(ChatChannel.pair_key == fields.get("pair_key"))
        existing = db.scalar(lookup)
        if existing is None:
            # The insert failed for some reason other than the race.
            raise
        return existing
    return channel


def ensure_channels(db: Session, user: User) -> None:
    """Make sure this person's team and department channels exist.

    Lazy rather than seeded, and this is the only path that creates a derived
    channel. A migration that made one per existing team would still leave every
    team created afterwards without one, so this function would have to exist
    regardless — and then there would be two ways a channel comes into being.

    Called on every channel listing. It is two indexed lookups for the common
    case where both already exist, which is every request after the first.
    """
    if user.team_id is not None:
        found = db.scalar(
            select(ChatChannel).where(
                ChatChannel.org_id == user.org_id, ChatChannel.team_id == user.team_id
            )
        )
        if found is None:
            _create(db, org_id=user.org_id, kind=ChannelKind.TEAM.value, team_id=user.team_id)

    if user.department_id is not None:
        found = db.scalar(
            select(ChatChannel).where(
                ChatChannel.org_id == user.org_id,
                ChatChannel.department_id == user.department_id,
            )
        )
        if found is None:
            _create(
                db,
                org_id=user.org_id,
                kind=ChannelKind.DEPARTMENT.value,
                department_id=user.department_id,
            )


def open_direct(db: Session, user: User, other_id: uuid.UUID) -> ChatChannel:
    """The conversation between two people, created on first use."""
    if other_id == user.id:
        raise ChatError("self_dm", "You cannot start a conversation with yourself.")
    other = db.get(User, other_id)
    if other is None or other.org_id != user.org_id or not other.is_active:
        raise ChatError("no_such_person", "That person is not in this workspace.", 404)

    key = pair_key(user.id, other_id)
    found = db.scalar(
        select(ChatChannel).where(
            ChatChannel.org_id == user.org_id, ChatChannel.pair_key == key
        )
    )
    if found is not None:
        return found

    channel = _create(
        db, org_id=user.org_id, kind=ChannelKind.DIRECT.value, pair_key=key
    )
    # Guarded because `_create` may have returned somebody else's winning insert
    # from the race, in which case the member rows are already there.
    existing = set(db.scalars(
        select(ChatChannelMember.user_id).where(ChatChannelMember.channel_id == channel.id)
    ))
    for member in (user.id, other_id):
        if member not in existing:
            db.add(ChatChannelMember(
                id=uuid.uuid4(), org_id=user.org_id, channel_id=channel.id, user_id=member,
            ))
    db.flush()
    return channel


# --------------------------------------------------------------------------- #
# Reading
# --------------------------------------------------------------------------- #


def channels_for(db: Session, user: User) -> list[ChatChannel]:
    """Every channel this person can open, most recently active first.

    Built from the org structure rather than from a membership table for the
    derived kinds — the point of the whole design. A person with no team and no
    department has only their direct conversations, which is correct: there is
    no group for them to be in yet.
    """
    clauses = []
    if user.team_id is not None:
        clauses.append(ChatChannel.team_id == user.team_id)
    if user.department_id is not None:
        clauses.append(ChatChannel.department_id == user.department_id)

    direct_ids = select(ChatChannelMember.channel_id).where(
        ChatChannelMember.user_id == user.id
    )
    clauses.append(ChatChannel.id.in_(direct_ids))

    rows = db.scalars(
        select(ChatChannel)
        .where(
            ChatChannel.org_id == user.org_id,
            ChatChannel.is_archived.is_(False),
            or_(*clauses),
        )
        # A channel nobody has posted in yet sorts last rather than first: it has
        # no `last_message_at`, and NULL must not read as "just now".
        .order_by(ChatChannel.last_message_at.desc().nullslast(), ChatChannel.created_at)
    ).all()
    return list(rows)


def unread_counts(db: Session, user: User, channels: list[ChatChannel]) -> dict[uuid.UUID, int]:
    """How many messages in each channel arrived after this person last looked.

    One grouped query rather than one per channel. A channel with no read row is
    one they have never opened, and every message in it counts as unread — which
    is what makes a newly-provisioned team channel announce itself.

    Their own messages are excluded. Nobody has unread messages from themselves,
    and counting them makes the badge tick up as you type.
    """
    if not channels:
        return {}
    ids = [channel.id for channel in channels]

    # A LEFT JOIN and one aggregate, so the "newer than what they have read"
    # comparison happens in SQL. Doing it in Python would mean comparing a
    # stored timestamp against a stored timestamp across two queries, and on
    # SQLite those come back naive — the same mismatch `_aware` exists for.
    # Here both sides are columns, so the database settles it.
    reads = (
        select(ChatRead.channel_id, ChatRead.last_read_at)
        .where(ChatRead.user_id == user.id, ChatRead.channel_id.in_(ids))
        .subquery()
    )
    rows = db.execute(
        select(ChatMessage.channel_id, func.count(ChatMessage.id))
        .select_from(ChatMessage)
        .join(reads, reads.c.channel_id == ChatMessage.channel_id, isouter=True)
        .where(
            ChatMessage.channel_id.in_(ids),
            # Nobody has unread messages from themselves, and counting them
            # makes the badge tick up as you type.
            ChatMessage.user_id != user.id,
            ChatMessage.deleted_at.is_(None),
            or_(
                reads.c.last_read_at.is_(None),
                ChatMessage.created_at > reads.c.last_read_at,
            ),
        )
        .group_by(ChatMessage.channel_id)
    )
    return {row[0]: int(row[1]) for row in rows}


def history(
    db: Session, channel: ChatChannel, before: datetime | None = None, limit: int = PAGE_SIZE
) -> list[ChatMessage]:
    """One page of a thread, newest first.

    Keyset pagination on ``created_at`` rather than an offset. A thread grows at
    the end while somebody is scrolling back through it, and an offset silently
    repeats or skips a message every time it does.
    """
    stmt = select(ChatMessage).where(ChatMessage.channel_id == channel.id)
    if before is not None:
        stmt = stmt.where(ChatMessage.created_at < before)
    rows = db.scalars(
        stmt.order_by(ChatMessage.created_at.desc()).limit(min(limit, PAGE_SIZE))
    ).all()
    # Reversed here rather than in the console: the query has to walk backwards
    # from the newest, and the reader wants it forwards.
    return list(reversed(rows))


def mark_read(db: Session, user: User, channel: ChatChannel) -> None:
    """Up to now. Idempotent, and never moves backwards.

    A second tab open on an older view of the same channel must not un-read
    messages the first tab has already shown.
    """
    now = _now()
    row = db.scalar(
        select(ChatRead).where(ChatRead.channel_id == channel.id, ChatRead.user_id == user.id)
    )
    if row is None:
        db.add(ChatRead(
            id=uuid.uuid4(), org_id=user.org_id, channel_id=channel.id,
            user_id=user.id, last_read_at=now,
        ))
    elif now > _aware(row.last_read_at):
        row.last_read_at = now
    db.flush()


# --------------------------------------------------------------------------- #
# Writing
# --------------------------------------------------------------------------- #


def post(
    db: Session,
    user: User,
    channel: ChatChannel,
    body: str,
    *,
    attachment: dict | None = None,
) -> ChatMessage:
    """Add a message. The caller has already proved they may read the channel.

    ``attachment`` is the already-stored file's metadata, from ``store_file``.
    A message may be text, a file, or both — but not neither, which is the one
    rule that has to hold here rather than at the edge: an empty row in a thread
    is a message nobody sent.
    """
    text = body.strip()
    if not text and not attachment:
        raise ChatError("empty", "A message needs something in it.")
    if len(text) > MAX_BODY_CHARS:
        raise ChatError(
            "too_long", f"Messages are limited to {MAX_BODY_CHARS} characters."
        )

    message = ChatMessage(
        id=uuid.uuid4(), org_id=user.org_id, channel_id=channel.id,
        user_id=user.id, body=text,
        attachment_key=(attachment or {}).get("key"),
        attachment_name=(attachment or {}).get("name"),
        attachment_type=(attachment or {}).get("type"),
        attachment_size=(attachment or {}).get("size"),
    )
    db.add(message)
    # Stamped so the channel list can order by recency without a MAX() per
    # channel on every load.
    channel.last_message_at = _now()
    db.flush()
    # Posting is reading: somebody who just typed into a channel has seen it.
    mark_read(db, user, channel)
    return message


def remove(db: Session, user: User, message_id: uuid.UUID) -> ChatMessage:
    """Soft-delete one's own message.

    Author only — not managers, not administrators. Chat moderation is a
    different feature with a different audit trail, and quietly giving admins a
    delete button on other people's messages is how it arrives without one.
    """
    message = db.get(ChatMessage, message_id)
    if message is None or message.org_id != user.org_id:
        raise ChatError("not_found", "That message does not exist.", 404)
    if message.user_id != user.id:
        raise ChatError("not_yours", "You can only remove your own messages.", 403)
    if message.deleted_at is None:
        message.deleted_at = _now()
        db.flush()
    return message


# --------------------------------------------------------------------------- #
# Display helpers
# --------------------------------------------------------------------------- #


def channel_title(db: Session, channel: ChatChannel, viewer: User) -> str:
    """What to call a channel on screen.

    Derived channels take their name from the row they point at, so renaming a
    team renames its channel with no write here at all. A direct channel is
    named after *the other person*, which means the same row has two different
    titles depending on who is looking — which is why this is a function and not
    a column.
    """
    kind = channel.kind_enum
    if kind is ChannelKind.TEAM:
        team = db.get(Team, channel.team_id) if channel.team_id else None
        return team.name if team else "Team"
    if kind is ChannelKind.DEPARTMENT:
        department = db.get(Department, channel.department_id) if channel.department_id else None
        return department.name if department else "Department"
    if kind is ChannelKind.GROUP:
        # The one kind with a name of its own: nothing in the org chart names it,
        # because nothing in the org chart made it.
        return channel.name or "Group"

    other = db.scalar(
        select(User)
        .join(ChatChannelMember, ChatChannelMember.user_id == User.id)
        .where(ChatChannelMember.channel_id == channel.id, User.id != viewer.id)
    )
    return other.full_name if other else "Conversation"


# --------------------------------------------------------------------------- #
# Groups
#
# The only channels a person creates. Everything above this line is derived from
# the org chart or from a pair of people; a group is somebody deciding that a
# conversation should exist, which makes membership and administration real
# questions for the first time in this module.
# --------------------------------------------------------------------------- #


def can_administer_group(db: Session, user: User, channel: ChatChannel) -> bool:
    """Who may rename a group or change who is in it.

    The creator, or -- once they have left or been deactivated -- **any member**.
    Not administrators: a project channel is not company property to be
    reorganised, and an admin who needs to be in one can be added like anybody
    else.

    The fallback matters. Without it, a group whose creator resigns is frozen
    forever: nobody can add their replacement, and the members can only abandon
    it and start again. ``created_by`` is SET NULL precisely so this branch is
    reachable.
    """
    if channel.kind_enum is not ChannelKind.GROUP:
        return False
    if channel.org_id != user.org_id:
        return False
    if channel.created_by is None:
        return user.id in set(member_ids(db, channel))
    return channel.created_by == user.id


def _require_group_admin(db: Session, user: User, channel: ChatChannel) -> None:
    if not can_administer_group(db, user, channel):
        raise ChatError(
            "not_group_admin",
            "Only the person who created this group can change who is in it.",
            403,
        )


def _resolve_members(db: Session, user: User, user_ids: Iterable[uuid.UUID]) -> list[User]:
    """The colleagues named, refusing anybody outside this workspace.

    Filtered on ``org_id`` inside the query rather than checked after it: a list
    of ids arriving from a client is exactly the shape that reaches into another
    tenant when the filter is left to a later line.
    """
    wanted = {uuid.UUID(str(value)) for value in user_ids}
    wanted.discard(user.id)
    if not wanted:
        return []
    rows = db.scalars(
        select(User).where(
            User.org_id == user.org_id,
            User.id.in_(wanted),
            User.is_active.is_(True),
        )
    ).all()
    return list(rows)


def create_group(
    db: Session, user: User, *, name: str, user_ids: Iterable[uuid.UUID]
) -> ChatChannel:
    """Start a named conversation with a chosen set of colleagues.

    The creator is always a member -- a group you made and cannot read would be
    a bug that looks like a permission -- and counts against the size limit like
    everybody else.

    Duplicate names are allowed, deliberately. Two teams can both have a "Q3
    planning" and neither is wrong; a uniqueness rule here would only produce an
    error message about somebody else's channel that the reader cannot see.
    """
    title = (name or "").strip()
    if not title:
        raise ChatError("no_name", "Give the group a name.")
    if len(title) > 120:
        raise ChatError("name_too_long", "Group names are limited to 120 characters.")

    people = _resolve_members(db, user, user_ids)
    if not people:
        raise ChatError("no_members", "Add at least one colleague to the group.")
    if len(people) + 1 > MAX_GROUP_MEMBERS:
        raise ChatError(
            "too_many",
            f"A group holds up to {MAX_GROUP_MEMBERS} people. Use a team channel "
            "or the noticeboard for anything wider.",
        )

    channel = ChatChannel(
        id=uuid.uuid4(),
        org_id=user.org_id,
        kind=ChannelKind.GROUP.value,
        name=title,
        created_by=user.id,
    )
    db.add(channel)
    db.flush()

    for member in [user, *people]:
        db.add(ChatChannelMember(
            id=uuid.uuid4(), org_id=user.org_id, channel_id=channel.id, user_id=member.id
        ))
    db.flush()
    return channel


def rename_group(db: Session, user: User, channel: ChatChannel, name: str) -> ChatChannel:
    _require_group_admin(db, user, channel)
    title = (name or "").strip()
    if not title:
        raise ChatError("no_name", "Give the group a name.")
    channel.name = title[:120]
    db.flush()
    return channel


def add_members(
    db: Session, user: User, channel: ChatChannel, user_ids: Iterable[uuid.UUID]
) -> list[User]:
    """Add colleagues to a group. Returns only the ones actually added.

    Somebody already in the group is skipped rather than refused: adding five
    people of whom one was already there is a successful action, and an error
    would leave the caller to diff the lists to find out which.

    **New members can read the history.** That is a decision rather than an
    oversight -- a group is a room, and somebody let into a room can read what
    is written on the walls. It is written down here because the opposite is
    equally arguable, and the console says so on the add dialog so nobody is
    surprised by it.
    """
    _require_group_admin(db, user, channel)

    existing = set(member_ids(db, channel))
    people = [p for p in _resolve_members(db, user, user_ids) if p.id not in existing]
    if not people:
        return []
    if len(existing) + len(people) > MAX_GROUP_MEMBERS:
        raise ChatError("too_many", f"A group holds up to {MAX_GROUP_MEMBERS} people.")

    for member in people:
        db.add(ChatChannelMember(
            id=uuid.uuid4(), org_id=user.org_id, channel_id=channel.id, user_id=member.id
        ))
    db.flush()
    return people


def remove_member(db: Session, user: User, channel: ChatChannel, user_id: uuid.UUID) -> None:
    """Take somebody out of a group, or leave it yourself.

    Both directions through one function because they are the same write, and
    the only difference is who may ask: anybody may remove themselves, and only
    the group's administrator may remove somebody else.
    """
    if channel.kind_enum is not ChannelKind.GROUP:
        raise ChatError(
            "not_a_group",
            "Only a group's membership can be changed. Team and department "
            "channels follow the org chart.",
        )
    if user_id != user.id:
        _require_group_admin(db, user, channel)

    row = db.scalar(
        select(ChatChannelMember).where(
            ChatChannelMember.channel_id == channel.id,
            ChatChannelMember.user_id == user_id,
        )
    )
    if row is None:
        return
    db.delete(row)
    db.flush()

    # A group with nobody left in it is archived, not deleted: those messages
    # are still somebody's record of what was said, and a hard delete here would
    # be a way to erase a conversation by removing every member from it.
    if not member_ids(db, channel):
        channel.is_archived = True
        db.flush()


def group_members(db: Session, channel: ChatChannel) -> list[User]:
    """Everyone in a group, for the members panel."""
    return list(db.scalars(
        select(User)
        .join(ChatChannelMember, ChatChannelMember.user_id == User.id)
        .where(ChatChannelMember.channel_id == channel.id, User.is_active.is_(True))
        .order_by(User.full_name)
    ))


# --------------------------------------------------------------------------- #
# Attachments
# --------------------------------------------------------------------------- #


def store_file(user: User, *, file_name: str, content_type: str, raw: bytes) -> dict:
    """Put one file in object storage and describe it. Writes no rows.

    Separate from ``post`` so the transaction stays short: an S3 round trip
    inside an open transaction holds a database connection for the length of
    somebody's upload. The caller stores the returned metadata on the message.

    The key is a UUID under the organisation's prefix and owes **nothing** to
    the filename. Only the extension is carried across, and only after being
    matched against a strict pattern -- a path separator smuggled through a
    filename is how an upload escapes its directory.
    """
    if not raw:
        raise ChatError("empty_upload", "That file is empty.")
    if len(raw) > MAX_ATTACHMENT_BYTES:
        raise ChatError(
            "too_large",
            f"Attachments are limited to {MAX_ATTACHMENT_BYTES // (1024 * 1024)} MB.",
            413,
        )

    kind = (content_type or "").split(";")[0].strip().lower()
    if kind not in ALLOWED_ATTACHMENT_TYPES:
        raise ChatError(
            "type_not_allowed",
            "That kind of file cannot be sent in chat. Images, PDFs, documents, "
            "spreadsheets and zip archives are accepted.",
        )

    key = f"chat/{user.org_id}/{uuid.uuid4()}{_suffix_for(file_name or '')}"
    try:
        size = storage.backend().put(key, raw, kind)
    except storage.StorageError as exc:
        raise ChatError("storage_failed", f"Could not store the file: {exc}", 503) from exc

    return {
        "key": key,
        "name": (file_name or "file")[:255],
        "type": kind[:120],
        "size": size,
    }


def serve_attachment(
    db: Session, user: User, message_id: uuid.UUID
) -> tuple[ChatMessage, storage.Served]:
    """The bytes of one attachment, after re-checking who is asking.

    The membership check runs **here, on every download**, which is the entire
    reason the storage key is never serialised into a response body. A key in
    the message payload would be a URL that outlives the reader's membership of
    the channel, and a link forwarded out of a private group would keep working
    for whoever received it.

    A soft-deleted message stops serving its file even though retention has not
    yet removed it: deleting a message the sender regretted has to take the
    photograph with it, or the delete button is a lie.
    """
    message = db.get(ChatMessage, message_id)
    if message is None or message.org_id != user.org_id or not message.attachment_key:
        raise ChatError("not_found", "That attachment does not exist.", 404)
    if message.deleted_at is not None:
        raise ChatError("not_found", "That attachment does not exist.", 404)

    channel = db.get(ChatChannel, message.channel_id)
    if channel is None or not can_read(db, user, channel):
        raise ChatError("not_found", "That attachment does not exist.", 404)

    try:
        return message, storage.serve(message.attachment_key)
    except storage.StorageError as exc:
        raise ChatError("storage_failed", f"Could not read the file: {exc}", 503) from exc
