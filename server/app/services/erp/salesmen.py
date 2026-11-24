"""Salesmen: who sells for the company, with area, commission and a monthly target."""

from __future__ import annotations

import uuid
from datetime import date

from fastapi import Request
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import User
from app.models.erp import ErpLedger, ErpSalesman
from app.schemas import erp as S
from app.services.erp.common import ErpError, get_owned, next_number, record_audit, require, row_dict


def _out(row: ErpSalesman, ledgers: int = 0) -> dict:
    out = row_dict(row)
    out["ledgers"] = ledgers
    return out


def _ledger_counts(db: Session, org_id: uuid.UUID) -> dict[str, int]:
    rows = db.execute(
        select(func.lower(ErpLedger.salesman), func.count()).where(
            ErpLedger.org_id == org_id, ErpLedger.salesman.is_not(None)).group_by(func.lower(ErpLedger.salesman))
    ).all()
    return {name: n for name, n in rows}


def list_salesmen(db: Session, viewer: User, *, q: str | None = None, active: bool | None = None) -> list[dict]:
    stmt = select(ErpSalesman).where(ErpSalesman.org_id == viewer.org_id)
    if active is not None:
        stmt = stmt.where(ErpSalesman.is_active == active)
    if q and q.strip():
        like = f"%{q.strip().lower()}%"
        stmt = stmt.where(or_(
            func.lower(ErpSalesman.name).like(like), func.lower(ErpSalesman.code).like(like),
            func.lower(func.coalesce(ErpSalesman.mobile, "")).like(like),
            func.lower(func.coalesce(ErpSalesman.area_beat, "")).like(like),
        ))
    counts = _ledger_counts(db, viewer.org_id)
    return [_out(r, counts.get(r.name.lower(), 0)) for r in db.scalars(stmt.order_by(func.lower(ErpSalesman.name)))]


def save_salesman(
    db: Session, viewer: User, payload: S.SalesmanIn, row_id: uuid.UUID | None = None, request: Request | None = None,
) -> dict:
    require(viewer, "can_manage_erp_masters")
    row = (get_owned(db, ErpSalesman, viewer.org_id, row_id, "salesman")
           if row_id else ErpSalesman(org_id=viewer.org_id))
    name = payload.name.strip()
    clash = db.scalar(select(ErpSalesman).where(
        ErpSalesman.org_id == viewer.org_id, func.lower(ErpSalesman.name) == name.lower(),
        *([ErpSalesman.id != row.id] if row_id else [])))
    if clash is not None:
        raise ErpError("duplicate_salesman", f"A salesman named \u201c{clash.name}\u201d already exists ({clash.code}).", 409)
    data = payload.model_dump()
    code = (data.pop("code") or "").strip().upper()
    data["name"] = name
    if not row_id:
        row.code = code or next_number(db, viewer.org_id, "SM", date.today()).replace("/", "-")
    elif code:
        row.code = code
    renamed_from = row.name if row_id and row.name != name else None
    for field, value in data.items():
        setattr(row, field, value)
    if renamed_from:
        # A ledger names its salesman by text, so it follows the rename.
        for l in db.scalars(select(ErpLedger).where(
                ErpLedger.org_id == viewer.org_id, func.lower(ErpLedger.salesman) == renamed_from.lower())):
            l.salesman = name
    db.add(row)
    db.flush()
    record_audit(db, viewer, "salesman.saved", row, request=request, detail={"code": row.code})
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise ErpError("duplicate", "That salesman code is already used.", 409) from None
    db.refresh(row)
    return _out(row, _ledger_counts(db, viewer.org_id).get(row.name.lower(), 0))


def delete_salesman(db: Session, viewer: User, salesman_id: uuid.UUID, request: Request | None = None) -> None:
    require(viewer, "can_manage_erp_masters")
    row = get_owned(db, ErpSalesman, viewer.org_id, salesman_id, "salesman")
    if _ledger_counts(db, viewer.org_id).get(row.name.lower(), 0):
        raise ErpError("salesman_in_use", f"{row.name} is the salesman on ledgers, so cannot be deleted. Mark them inactive instead.", 409)
    record_audit(db, viewer, "salesman.deleted", row, request=request, detail={"code": row.code})
    db.delete(row)
    db.commit()
