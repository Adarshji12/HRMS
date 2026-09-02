"""Wire shapes for meetings.

The important thing about these models is what is **not** on them: ``room``
appears on exactly one of them, :class:`JoinOut`, which only the join endpoint
returns and only to somebody it has already checked. The room name is the
credential on a public Jitsi deployment, so a listing that carried it would hand
every meeting's door key to everyone who can see the calendar.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field, model_validator

from app.schemas.common import ORMModel


class InviteeOut(ORMModel):
    user_id: uuid.UUID
    user_name: str
    employee_code: str | None = None
    #: Null until they are handed the room. Arrival, not duration — see the note
    #: on ``models/meetings.py``.
    joined_at: datetime | None = None


class MeetingOut(BaseModel):
    id: uuid.UUID
    title: str
    agenda: str | None = None
    starts_at: datetime
    duration_minutes: int
    status: str
    host_user_id: uuid.UUID | None = None
    host_name: str | None = None
    #: What the invitee list was seeded from — "Platform", say — so the console
    #: can label a nine-person meeting without printing nine names.
    seeded_from: str | None = None
    invitee_count: int
    attended_count: int
    #: Resolved server-side from the clock and the status, so the console renders
    #: the button from this rather than re-deriving the window and disagreeing.
    can_join: bool
    can_cancel: bool
    #: Deliberately absent: `room`. See the module docstring.


class MeetingDetailOut(MeetingOut):
    invitees: list[InviteeOut] = []


class ScheduleIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    starts_at: datetime
    duration_minutes: int = Field(default=30, ge=5, le=480)
    agenda: str | None = Field(default=None, max_length=4000)

    #: Any combination. A team plus two extra people is the ordinary case —
    #: seeded from the org structure, then adjusted.
    user_ids: list[uuid.UUID] = []
    team_id: uuid.UUID | None = None
    department_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def _somebody(self) -> "ScheduleIn":
        if not self.user_ids and self.team_id is None and self.department_id is None:
            raise ValueError("Invite somebody: pick a team, a department, or people.")
        return self


class JoinOut(BaseModel):
    """The room, handed over once the server has checked who is asking."""

    #: The Jitsi deployment. The company's own if it named one, otherwise the
    #: server default — which is the public instance, so the media does not go
    #: through servers this project runs.
    domain: str
    room: str
    #: What to show above the tile, so nobody has to type their own name into
    #: somebody else's video service.
    display_name: str
