"""Meetings: schedule one, see yours, join the room.

Every rule lives in ``app.services.meetings``. This file resolves who is asking
and turns a :class:`~app.services.meetings.MeetingError` into a typed response.

The room name is returned by exactly one route — ``POST /{id}/join`` — and never
appears in a listing. On a public Jitsi deployment the name is the credential,
so a calendar that carried it would be a calendar that hands out door keys.
"""

from __future__ import annotations

import uuid
from typing import NoReturn

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession, audit
from app.models import Meeting, MeetingInvitee, User
from app.schemas.meetings import (
    InviteeOut,
    JoinOut,
    MeetingDetailOut,
    MeetingOut,
    ScheduleIn,
)
from app.services import meetings as svc

router = APIRouter(prefix="/meetings", tags=["meetings"])


def _fail(error: svc.MeetingError) -> NoReturn:
    raise HTTPException(
        error.status_code, detail={"reason": error.code, "message": error.message}
    )


def _names(db, org_id: uuid.UUID) -> dict[uuid.UUID, tuple[str, str | None]]:
    return {
        row[0]: (row[1], row[2])
        for row in db.execute(
            select(User.id, User.full_name, User.employee_code).where(User.org_id == org_id)
        )
    }


def _out(db, meeting: Meeting, viewer: User, names) -> MeetingOut:
    rows = svc.invitees_of(db, meeting)
    return MeetingOut(
        id=meeting.id,
        title=meeting.title,
        agenda=meeting.agenda,
        starts_at=meeting.starts_at,
        duration_minutes=meeting.duration_minutes,
        status=meeting.status,
        host_user_id=meeting.host_user_id,
        host_name=names.get(meeting.host_user_id, (None, None))[0]
        if meeting.host_user_id else None,
        seeded_from=meeting.seeded_from,
        invitee_count=len(rows),
        attended_count=sum(1 for row in rows if row.joined_at is not None),
        # Resolved here so the console renders its button from the server's
        # answer rather than re-deriving the window and disagreeing about it.
        can_join=svc.can_join_now(meeting),
        can_cancel=meeting.host_user_id == viewer.id
        and meeting.status_enum is not svc.MeetingStatus.CANCELLED,
    )


@router.get("", response_model=list[MeetingOut])
def my_meetings(
    viewer: CurrentUser,
    db: DbSession,
    include_past: bool = Query(default=False),
) -> list[MeetingOut]:
    """The meetings this person was invited to, soonest first.

    Scoped by invitation, not by company: an administrator is not automatically
    in everybody's one-to-ones, and a listing scoped by org would put them there.
    """
    rows = svc.for_user(db, viewer, upcoming_only=not include_past)
    names = _names(db, viewer.org_id)
    return [_out(db, meeting, viewer, names) for meeting in rows]


@router.post("", response_model=MeetingDetailOut, status_code=status.HTTP_201_CREATED)
def create(
    payload: ScheduleIn, viewer: CurrentUser, request: Request, db: DbSession
) -> MeetingDetailOut:
    """Book a call.

    Anyone may schedule one — a meeting is not an administrative act, and gating
    it behind a role would mean an engineer cannot call two colleagues together.
    Who can be *invited* is still bounded by the workspace.
    """
    try:
        invitees, label = svc.resolve_invitees(
            db,
            viewer,
            user_ids=payload.user_ids,
            team_id=payload.team_id,
            department_id=payload.department_id,
        )
        meeting = svc.schedule(
            db,
            viewer,
            title=payload.title,
            starts_at=payload.starts_at,
            duration_minutes=payload.duration_minutes,
            invitees=invitees,
            seeded_from=label,
            agenda=payload.agenda,
        )
    except svc.MeetingError as error:
        _fail(error)

    audit(db, org_id=viewer.org_id, actor=viewer, action="meeting.scheduled", request=request,
          detail={"meeting_id": str(meeting.id), "invitees": len(invitees)})
    db.commit()
    db.refresh(meeting)
    return _detail(db, meeting, viewer)


@router.get("/{meeting_id}", response_model=MeetingDetailOut)
def detail(meeting_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> MeetingDetailOut:
    try:
        meeting = svc.ensure_invited(db, viewer, meeting_id)
    except svc.MeetingError as error:
        _fail(error)
    return _detail(db, meeting, viewer)


def _detail(db, meeting: Meeting, viewer: User) -> MeetingDetailOut:
    names = _names(db, meeting.org_id)
    base = _out(db, meeting, viewer, names)
    rows = svc.invitees_of(db, meeting)
    return MeetingDetailOut(
        **base.model_dump(),
        invitees=[
            InviteeOut(
                user_id=row.user_id,
                user_name=names.get(row.user_id, ("—", None))[0],
                employee_code=names.get(row.user_id, ("—", None))[1],
                joined_at=row.joined_at,
            )
            for row in rows
        ],
    )


@router.post("/{meeting_id}/cancel", response_model=MeetingDetailOut)
def cancel(
    meeting_id: uuid.UUID, viewer: CurrentUser, request: Request, db: DbSession
) -> MeetingDetailOut:
    try:
        meeting = svc.ensure_invited(db, viewer, meeting_id)
        svc.cancel(db, viewer, meeting)
    except svc.MeetingError as error:
        _fail(error)
    audit(db, org_id=viewer.org_id, actor=viewer, action="meeting.cancelled", request=request,
          detail={"meeting_id": str(meeting.id)})
    db.commit()
    db.refresh(meeting)
    return _detail(db, meeting, viewer)


@router.post("/{meeting_id}/join", response_model=JoinOut)
def join(meeting_id: uuid.UUID, viewer: CurrentUser, db: DbSession) -> JoinOut:
    """Hand over the room, and stamp attendance.

    The only route that returns a room name. It re-checks everything rather than
    trusting the ``can_join`` the listing sent: that flag was true when the
    listing was built, and a browser can hold a page open for an hour.
    """
    try:
        meeting = svc.ensure_invited(db, viewer, meeting_id)
        domain, room = svc.join(db, viewer, meeting)
    except svc.MeetingError as error:
        _fail(error)
    db.commit()
    return JoinOut(domain=domain, room=room, display_name=viewer.full_name)
