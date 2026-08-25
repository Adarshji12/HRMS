"""Shapes for approval chains.

One convention worth stating: a level says **how** to find its reviewer, not who
they are. `reviewer_user_id` is set only for the `named_user` rule; everything
else resolves against the requester at the moment they submit. A chain naming
Priya breaks the day Priya changes team, and every company that has run one for
a year has a level pointing at somebody who left.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from app.schemas.common import ORMModel

RULE = r"^(reporting_manager|skip_level_manager|department_head|named_user|capability)$"


class LevelIn(BaseModel):
    #: Position is taken from the order of the list, not from a field: two
    #: rungs claiming level 2 is an ambiguous chain, and a list cannot express
    #: that mistake.
    reviewer_rule: str = Field(default="reporting_manager", pattern=RULE)
    #: Required for `named_user`, ignored otherwise.
    reviewer_user_id: uuid.UUID | None = None
    #: 0 = never. The default, because a chain that moves on by itself is a
    #: chain where nobody noticed the request.
    auto_forward_days: int = Field(default=0, ge=0, le=90)
    escalate_after_days: int = Field(default=0, ge=0, le=90)
    escalate_to_user_id: uuid.UUID | None = None


class LevelsIn(BaseModel):
    """A whole chain for one scope. A replace, not a merge — see the service."""

    levels: list[LevelIn] = Field(default_factory=list, max_length=5)


class LevelOut(ORMModel):
    id: uuid.UUID
    kind: str
    department_id: uuid.UUID | None = None
    level: int
    reviewer_rule: str
    reviewer_user_id: uuid.UUID | None = None
    auto_forward_days: int
    escalate_after_days: int
    escalate_to_user_id: uuid.UUID | None = None
    is_active: bool

    reviewer_name: str | None = None
    escalate_to_name: str | None = None


class StepOut(ORMModel):
    """One rung as it actually happened."""

    id: uuid.UUID
    level: int
    reviewer_rule: str
    reviewer_user_id: uuid.UUID | None = None
    #: 'pending' | 'approved' | 'rejected' | 'skipped' | 'escalated'
    status: str
    acted_by: uuid.UUID | None = None
    acted_at: datetime | None = None
    note: str | None = None
    started_at: datetime | None = None

    #: Null means the rule found nobody. The step is shown as **unassigned**
    #: rather than hidden: a level with no reviewer is a configuration problem
    #: somebody must see.
    reviewer_name: str | None = None
    acted_by_name: str | None = None


class ChainOut(BaseModel):
    """A record's chain. Empty when the flow has none configured."""

    kind: str
    record_id: uuid.UUID
    steps: list[StepOut] = []
    #: Which rung is waiting, or null when the chain is done or absent.
    current_level: int | None = None
    total: int = 0


class SweepOut(BaseModel):
    escalated: int = 0
    auto_forwarded: int = 0
