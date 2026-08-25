"""Shapes for the settlement proposal and its stored lines.

Money is **integer paise** on the wire, as everywhere else here. The suffix is
kept on `amount_paise` because the offboarding module's existing settlement
fields carry it (`gross_dues_paise`, `net_payable_paise`) and one table with two
naming conventions is a table somebody misreads.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel

from app.schemas.common import ORMModel


class FnfLineOut(ORMModel):
    id: uuid.UUID
    kind: str
    code: str
    label: str
    #: Always positive; ``kind`` carries the sign. See ``models/settlement.py``.
    amount_paise: int
    source: str
    source_id: uuid.UUID | None = None
    #: The working behind the figure — "18.5 days at ₹1,923/day". This is what
    #: makes a settlement answerable when somebody queries it.
    detail: str | None = None
    sort_order: int


class ProposedLineOut(BaseModel):
    """A line as computed. Same shape as a stored one, minus the identity a row
    it has not become yet would not have."""

    kind: str
    code: str
    label: str
    amount_paise: int
    source: str
    source_id: uuid.UUID | None = None
    detail: str | None = None


class ProposalOut(BaseModel):
    """A settlement as computed, before anybody agrees to it. Stored nowhere."""

    request_id: uuid.UUID
    user_id: uuid.UUID
    user_name: str
    last_working_day: date
    lines: list[ProposedLineOut] = []
    gross_dues_paise: int = 0
    deductions_paise: int = 0
    #: May be **negative** — a leaver with a large loan owes the company money,
    #: and clamping it to zero would quietly write the debt off.
    net_payable_paise: int = 0
    #: Inputs that were missing, and assumptions made in their place. Never
    #: empty in practice: the tax note is always present.
    warnings: list[str] = []
    #: Advisory only. Income tax on a settlement is not computed here — see the
    #: service module's docstring for why a plausible figure would be a wrong one.
    tax_paid_ytd: int = 0
    tax_deducted_ytd: int = 0
    currency: str = "INR"
