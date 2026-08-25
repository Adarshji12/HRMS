"""Calendar arithmetic that more than one module needs.

Small on purpose. Things land here when a second module needs them, not in
anticipation — and ``add_months`` arrived exactly that way: leave accrual had it,
then Core HR's probation end date needed the same thing and grew a second copy
with the same clamping bug surface. One implementation, one place the February
edge is reasoned about.
"""

from __future__ import annotations

from datetime import date


def add_months(day: date, months: int) -> date:
    """``day`` shifted by whole months, clamped to the end of the target month.

    31 January plus one month is 28 or 29 February, not an exception. Every
    caller here is computing a date somebody will be held to — a probation end,
    an accrual boundary — so raising on a month-end input would turn a routine
    date into a 500.
    """
    total = (day.year * 12 + day.month - 1) + months
    year, month = divmod(total, 12)
    month += 1
    for candidate in range(day.day, 0, -1):
        try:
            return date(year, month, candidate)
        except ValueError:
            continue
    raise ValueError("unreachable: every month has a first day")
