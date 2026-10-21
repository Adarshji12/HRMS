"""HR settings: read-or-create, and minting employee codes from the format."""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import HrSettings, User


def get_settings(db: Session, org_id: uuid.UUID) -> HrSettings:
    """The org's HR settings, created on first read with the model defaults."""
    row = db.scalar(select(HrSettings).where(HrSettings.org_id == org_id))
    if row is None:
        row = HrSettings(org_id=org_id)
        db.add(row)
        db.flush()
    return row


def format_code(row: HrSettings, number: int) -> str:
    """``EMP-0007`` from the format and a number. A blank prefix drops the
    separator too, so the code is just ``0007``."""
    digits = str(number).zfill(row.emp_code_digits) if row.emp_code_digits > 0 else str(number)
    prefix = row.emp_code_prefix.strip()
    return f"{prefix}{row.emp_code_separator}{digits}" if prefix else digits


def _taken(db: Session, org_id: uuid.UUID, code: str) -> bool:
    return db.scalar(
        select(User.id).where(User.org_id == org_id, User.employee_code == code).limit(1)
    ) is not None


def preview_code(db: Session, org_id: uuid.UUID) -> str:
    """The code the next employee would get, skipping any already in use."""
    row = get_settings(db, org_id)
    number = row.emp_code_next
    while _taken(db, org_id, format_code(row, number)):
        number += 1
    return format_code(row, number)


def mint_code(db: Session, org_id: uuid.UUID) -> str:
    """Hand out the next free code and advance the counter, inside the
    caller's transaction. Codes typed in by hand may already occupy numbers in
    the series; those are skipped rather than duplicated."""
    row = get_settings(db, org_id)
    number = row.emp_code_next
    while _taken(db, org_id, format_code(row, number)):
        number += 1
    row.emp_code_next = number + 1
    return format_code(row, number)


def note_used(db: Session, org_id: uuid.UUID, code: str | None) -> None:
    """If a hand-entered code is exactly the next one in the series, move the
    counter past it, so the preview does not offer a code that is taken."""
    if not code:
        return
    row = get_settings(db, org_id)
    if code == format_code(row, row.emp_code_next):
        row.emp_code_next += 1
