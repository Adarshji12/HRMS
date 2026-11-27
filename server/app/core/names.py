"""One rule for every list of named things: the same name is not added twice, in any capitals or spacing."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session


def tidy(name: str) -> str:
    """The name as it is stored: trimmed, with runs of spaces collapsed."""
    return " ".join((name or "").split())


def refuse_duplicate_name(
    db: Session, model: Any, org_id: uuid.UUID, name: str, *, exclude_id: uuid.UUID | None = None, where: tuple = ()
) -> str:
    """Raise 409 when ``name`` is already on the list; otherwise return it tidied.

    Compared lower-cased with spaces collapsed, so "Sales", "sales" and " SALES " are one name. ``where`` narrows the
    list (a designation is unique within its department, say) when the caller wants that.
    """
    clean = tidy(name)
    stmt = select(model.id, model.name).where(model.org_id == org_id, func.lower(model.name) == clean.lower(), *where)
    if exclude_id is not None:
        stmt = stmt.where(model.id != exclude_id)
    found = db.execute(stmt.limit(1)).first()
    if found is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"reason": "duplicate", "message": f"\u201c{found[1]}\u201d already exists. Names are matched without regard to capital letters."},
        )
    return clean
