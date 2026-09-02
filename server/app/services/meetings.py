"""Scheduling a call, and deciding who gets handed the room.

Every rule lives here. The router resolves who is asking and turns a
:class:`MeetingError` into an HTTP response.

The one function worth reading before changing anything is :func:`join`. It is
the whole security model: on a public Jitsi deployment there is no password and
no waiting room, so **the room name is the credential**, and this is the only
place that hands it out. Everything else — the invitee list, the time window,
the cancellation check — exists to constrain that one moment.
"""

from __future__ import annotations

import secrets
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import (
    Department,
    Meeting,
    MeetingInvitee,
    MeetingStatus,
    Organization,
    Team,
    User,
)

#: How long before the start time the room opens. People arrive early, and a
#: join button that refuses until the exact minute is a button that makes
#: everybody late.
EARLY_JOIN_MINUTES = 15

#: How long past the scheduled end it stays open. Meetings overrun; the room
#: closing on the hour would end the conversation for everyone at once.
LATE_JOIN_MINUTES = 60

#: Sanity bounds on a booking. Not policy — just the range in which a number is
#: a duration rather than a typo.
MIN_DURATION = 5
MAX_DURATION = 8 * 60


class MeetingError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime) -> datetime:
    """Attach UTC to a timestamp the database returned without one.

    Postgres hands back ``timestamptz`` aware; SQLite hands it back naive, and
    comparing one of each raises ``TypeError``. Same helper, same reason, as the
    one in ``services/chat.py`` — every comparison here that puts a stored
    timestamp beside a fresh one goes through it.
    """
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def new_room() -> str:
    """A room nobody can guess.

    Never derived from the title, the company or the date. On a public Jitsi
    instance anyone who knows the name is in the call, so a room called
    ``acme-standup-monday`` is a room a competitor reaches on the first attempt.
    32 hex characters is 128 bits.
    """
    return f"mdt-{secrets.token_hex(16)}"


def domain_for(db: Session, org_id: uuid.UUID) -> str:
    """Which Jitsi deployment this company uses.

    Their own if they have named one, the server default otherwise. The default
    is the public instance, which means the media does not go through servers
    this project runs — see the note on ``settings.meeting_domain``.
    """
    org = db.get(Organization, org_id)
    return (org.meeting_domain if org and org.meeting_domain else settings.meeting_domain).strip()


# --------------------------------------------------------------------------- #
# Scheduling
# --------------------------------------------------------------------------- #


def resolve_invitees(
    db: Session,
    host: User,
    *,
    user_ids: list[uuid.UUID] | None = None,
    team_id: uuid.UUID | None = None,
    department_id: uuid.UUID | None = None,
) -> tuple[list[uuid.UUID], str | None]:
    """Turn "the Platform team" into a list of names, once.

    This is the seeding step, and it runs **at scheduling time only**. What gets
    stored is the list it returns; the team is remembered in ``seeded_from`` as
    a label and is never consulted again. See the module docstring on
    ``models/meetings.py`` for why a meeting's list is a snapshot and a chat
    channel's membership is not.
    """
    ids: set[uuid.UUID] = set()
    label: str | None = None

    if team_id is not None:
        team = db.get(Team, team_id)
        if team is None or team.org_id != host.org_id:
            raise MeetingError("no_such_team", "That team is not in this workspace.", 404)
        label = team.name
        ids.update(db.scalars(select(User.id).where(
            User.org_id == host.org_id, User.team_id == team_id, User.is_active.is_(True)
        )))

    if department_id is not None:
        department = db.get(Department, department_id)
        if department is None or department.org_id != host.org_id:
            raise MeetingError("no_such_department", "That department is not here.", 404)
        label = department.name if label is None else f"{label} + {department.name}"
        ids.update(db.scalars(select(User.id).where(
            User.org_id == host.org_id,
            User.department_id == department_id,
            User.is_active.is_(True),
        )))

    if user_ids:
        found = set(db.scalars(select(User.id).where(
            User.org_id == host.org_id, User.id.in_(user_ids), User.is_active.is_(True)
        )))
        missing = set(user_ids) - found
        if missing:
            raise MeetingError(
                "no_such_person", "One or more of those people are not in this workspace.", 404
            )
        ids.update(found)

    # The host is always in the room. Scheduling a meeting you cannot join is
    # not a state worth being able to reach.
    ids.add(host.id)
    return sorted(ids, key=str), label


def schedule(
    db: Session,
    host: User,
    *,
    title: str,
    starts_at: datetime,
    duration_minutes: int,
    invitees: list[uuid.UUID],
    seeded_from: str | None = None,
    agenda: str | None = None,
) -> Meeting:
    clean = title.strip()
    if not clean:
        raise MeetingError("no_title", "A meeting needs a title.")
    if not (MIN_DURATION <= duration_minutes <= MAX_DURATION):
        raise MeetingError(
            "bad_duration", f"Length must be between {MIN_DURATION} minutes and 8 hours."
        )
    if len(invitees) < 1:
        raise MeetingError("no_invitees", "Invite at least one person.")

    meeting = Meeting(
        id=uuid.uuid4(),
        org_id=host.org_id,
        title=clean,
        agenda=(agenda or "").strip() or None,
        starts_at=starts_at,
        duration_minutes=duration_minutes,
        host_user_id=host.id,
        room=new_room(),
        seeded_from=seeded_from,
    )
    db.add(meeting)
    db.flush()

    for user_id in invitees:
        db.add(MeetingInvitee(
            id=uuid.uuid4(), org_id=host.org_id, meeting_id=meeting.id, user_id=user_id,
        ))
    db.flush()
    return meeting


def cancel(db: Session, user: User, meeting: Meeting) -> Meeting:
    """Call it off. Host only.

    The row and its invitees stay, and the status changes. A cancelled meeting
    is a thing that happened to nine people's calendars — deleting it would take
    it out of theirs without explaining why it went.
    """
    if meeting.host_user_id != user.id:
        raise MeetingError("not_host", "Only the person who scheduled it can cancel it.", 403)
    meeting.status = MeetingStatus.CANCELLED.value
    db.flush()
    return meeting


# --------------------------------------------------------------------------- #
# Reading
# --------------------------------------------------------------------------- #


def for_user(
    db: Session, user: User, *, upcoming_only: bool = True, limit: int = 100
) -> list[Meeting]:
    """The meetings this person was invited to.

    Invitee rows, not the org: an administrator is not automatically in
    everyone's one-to-ones, and a listing scoped by company rather than by
    invitation would put them there.
    """
    stmt = (
        select(Meeting)
        .join(MeetingInvitee, MeetingInvitee.meeting_id == Meeting.id)
        .where(MeetingInvitee.user_id == user.id, Meeting.org_id == user.org_id)
    )
    if upcoming_only:
        # Anything not yet finished, plus the late-join grace — a meeting that
        # started ten minutes ago is the one you are most likely looking for.
        stmt = stmt.where(Meeting.starts_at >= _now() - timedelta(hours=12))
    return list(db.scalars(stmt.order_by(Meeting.starts_at).limit(limit)))


def invitees_of(db: Session, meeting: Meeting) -> list[MeetingInvitee]:
    return list(db.scalars(
        select(MeetingInvitee).where(MeetingInvitee.meeting_id == meeting.id)
    ))


def ensure_invited(db: Session, user: User, meeting_id: uuid.UUID) -> Meeting:
    """Load a meeting this person is on the list for, or refuse.

    404 rather than 403, like a chat channel: telling somebody a meeting exists
    that they were not invited to is itself the leak — the title alone can say
    more than anybody meant it to.
    """
    meeting = db.get(Meeting, meeting_id)
    if meeting is None or meeting.org_id != user.org_id:
        raise MeetingError("not_found", "That meeting does not exist.", 404)
    row = db.scalar(select(MeetingInvitee).where(
        MeetingInvitee.meeting_id == meeting.id, MeetingInvitee.user_id == user.id
    ))
    if row is None:
        raise MeetingError("not_found", "That meeting does not exist.", 404)
    return meeting


# --------------------------------------------------------------------------- #
# Joining — the whole security model
# --------------------------------------------------------------------------- #


def join_window(meeting: Meeting) -> tuple[datetime, datetime]:
    start = _aware(meeting.starts_at)
    return (
        start - timedelta(minutes=EARLY_JOIN_MINUTES),
        start + timedelta(minutes=meeting.duration_minutes + LATE_JOIN_MINUTES),
    )


def can_join_now(meeting: Meeting, at: datetime | None = None) -> bool:
    if meeting.status_enum is MeetingStatus.CANCELLED:
        return False
    opens, closes = join_window(meeting)
    now = at or _now()
    return opens <= now <= closes


def join(db: Session, user: User, meeting: Meeting) -> tuple[str, str]:
    """Hand over the room, and stamp attendance. Returns ``(domain, room)``.

    The only place the room name leaves the server. Three things have to hold
    and all three are checked here rather than trusted from the caller: the
    meeting is not cancelled, the clock is inside the window, and this person is
    on the list — the last one already proved by ``ensure_invited`` upstream,
    which is why this function takes a loaded meeting rather than an id.
    """
    if meeting.status_enum is MeetingStatus.CANCELLED:
        raise MeetingError("cancelled", "That meeting was cancelled.", 409)

    opens, closes = join_window(meeting)
    now = _now()
    if now < opens:
        raise MeetingError(
            "too_early",
            f"The room opens {EARLY_JOIN_MINUTES} minutes before the start.",
            409,
        )
    if now > closes:
        raise MeetingError("over", "That meeting has finished.", 409)

    row = db.scalar(select(MeetingInvitee).where(
        MeetingInvitee.meeting_id == meeting.id, MeetingInvitee.user_id == user.id
    ))
    # Stamped once. Rejoining after a dropout is not a second arrival, and
    # overwriting would turn "came on time" into "came back at the end".
    if row is not None and row.joined_at is None:
        row.joined_at = now
        db.flush()

    return domain_for(db, meeting.org_id), meeting.room
