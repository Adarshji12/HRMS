"""Shapes for the unified approvals queue.

Flat, and one shape for every flow. A union the console switches on would put
the knowledge of five modules into a rendering component, and the queue exists
precisely so the person reading it does not have to think about which module a
request came from.
"""

from __future__ import annotations

import uuid
from datetime import date

from pydantic import BaseModel


class PendingOut(BaseModel):
    #: Which flow. The console maps this to the route that decides it.
    kind: str
    #: The record's own id, which that route takes.
    id: uuid.UUID
    user_id: uuid.UUID
    user_name: str
    #: One line, enough to triage on. "Earned Leave, 2 days".
    title: str
    detail: str | None = None
    #: When it started waiting.
    since: date
    #: Derived from `since`, because every client would otherwise compute it —
    #: and one of them would use the wrong timezone.
    waiting_days: int = 0
    #: Paise, where the flow involves money. **Null where it does not**: a leave
    #: request has no amount, and rendering it as ₹0.00 would be a lie.
    amount_paise: int | None = None
    currency: str = "INR"


class PendingCountsOut(BaseModel):
    """One number per flow, plus the total. For a navigation badge."""

    leave: int = 0
    timesheet: int = 0
    regularization: int = 0
    expense: int = 0
    loan: int = 0
    performance: int = 0
    total: int = 0
