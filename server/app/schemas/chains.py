"""Shapes for approval chains.

One convention worth stating: a level says **how** to find its reviewer, not who
they are. `reviewer_user_id` is set only for the `named_user` rule; everything
else resolves against the requester at the moment they submit. A chain naming
Priya breaks the day Priya changes team, and every company that has run one for
a year has a level pointing at somebody who left.
"""

from __future__ import annotations

import uuid
from typing import Any
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


# --------------------------------------------------------------------------- #
# Conditional routing
# --------------------------------------------------------------------------- #

#: The operators a clause may use. Kept in step with `services.chains.OPERATORS`
#: — a pattern rather than an import, because schemas here never import
#: services, and a value this file accepts that the evaluator does not know
#: would be a rule that silently never matches.
OPERATOR = r"^(eq|ne|gt|gte|lt|lte|any_of|none_of)$"


class ConditionIn(BaseModel):
    """One clause of a rule. Clauses are ANDed.

    ``value`` is deliberately untyped: it is a number for an amount, an id for a
    department, and a list of ids for "is any of". The evaluator coerces and
    treats anything it cannot compare as **not matched**, never as an error —
    see the section note in ``services.chains``.
    """

    field: str = Field(min_length=1, max_length=40)
    op: str = Field(pattern=OPERATOR)
    #: Money is in **paise**, like every amount in this product. The console
    #: converts; the rule stores what the record stores, so a comparison never
    #: depends on which screen wrote the rule.
    value: Any = None


class RuleIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    #: Lower runs first. Absent means "keep the order of this list".
    priority: int | None = Field(default=None, ge=0, le=9999)
    conditions: list[ConditionIn] = Field(default_factory=list, max_length=10)
    levels: list[LevelIn] = Field(default_factory=list, max_length=5)
    #: The "otherwise" row: matched unconditionally and sorted last. Its
    #: conditions are dropped on save, because a fallback with a condition is
    #: not a fallback.
    is_fallback: bool = False
    is_active: bool = True


class RulesIn(BaseModel):
    """Every rule for one flow, in order. A replace, not a merge."""

    rules: list[RuleIn] = Field(default_factory=list, max_length=40)


class ConditionOut(BaseModel):
    field: str
    op: str
    value: Any = None


class RuleOut(ORMModel):
    id: uuid.UUID
    kind: str
    name: str
    priority: int
    conditions: list[ConditionOut] = []
    is_fallback: bool
    is_active: bool
    levels: list[LevelOut] = []


class FieldOut(BaseModel):
    """One thing a rule on this flow may ask about.

    Served rather than hardcoded in the console, because the vocabulary is per
    flow — a leave application has no amount — and two copies of that list is
    one that goes stale the day somebody adds a field.
    """

    key: str
    label: str
    #: money | number | days | choice | id | text
    type: str
    #: Which list the console should offer as values, if any.
    options: str | None = None
    help: str | None = None


class VocabularyOut(BaseModel):
    fields: list[FieldOut] = []
    #: Operator key → the words to show for it.
    operators: dict[str, str] = {}


class PreviewIn(BaseModel):
    """A hypothetical request, for asking which rule would catch it.

    ``values`` are the record's own fields by their rule key — `amount`,
    `leave_type`, `days`. Whose request it is decides the common fields
    (department, team, role), so it is a real colleague rather than more typed
    values: a preview against a made-up department would answer about a company
    that does not exist.
    """

    subject_user_id: uuid.UUID | None = None
    values: dict[str, Any] = Field(default_factory=dict)
