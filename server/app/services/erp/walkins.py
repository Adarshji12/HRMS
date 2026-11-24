"""Walk-in customers: cash customers kept as a simple list, not as ledgers."""

from __future__ import annotations

import uuid

from fastapi import Request
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models import User
from app.models.erp import ErpWalkinCustomer
from app.schemas import erp as S
from app.services.erp.common import ErpError, get_owned, record_audit, require, row_dict


def _out(row: ErpWalkinCustomer) -> dict:
    out = row_dict(row)
    # No sale bill points at a walk-in customer yet.
    out.update({"bills": 0, "total_bought": "0", "last_bill": None})
    return out


def list_walkins(db: Session, viewer: User, *, q: str | None = None, active: bool | None = None) -> list[dict]:
    stmt = select(ErpWalkinCustomer).where(ErpWalkinCustomer.org_id == viewer.org_id)
    if active is not None:
        stmt = stmt.where(ErpWalkinCustomer.is_active == active)
    if q and q.strip():
        like = f"%{q.strip().lower()}%"
        stmt = stmt.where(or_(
            func.lower(ErpWalkinCustomer.name).like(like),
            func.lower(func.coalesce(ErpWalkinCustomer.mobile, "")).like(like),
            func.lower(func.coalesce(ErpWalkinCustomer.email, "")).like(like),
        ))
    return [_out(r) for r in db.scalars(stmt.order_by(func.lower(ErpWalkinCustomer.name)))]


def save_walkin(
    db: Session, viewer: User, payload: S.WalkinIn, row_id: uuid.UUID | None = None, request: Request | None = None,
) -> dict:
    require(viewer, "can_manage_erp_masters")
    row = (get_owned(db, ErpWalkinCustomer, viewer.org_id, row_id, "walk-in customer")
           if row_id else ErpWalkinCustomer(org_id=viewer.org_id, created_by=viewer.id))
    data = payload.model_dump()
    data["name"] = data["name"].strip()
    if data["mobile"]:
        clash = db.scalar(select(ErpWalkinCustomer).where(
            ErpWalkinCustomer.org_id == viewer.org_id, ErpWalkinCustomer.mobile == data["mobile"],
            *([ErpWalkinCustomer.id != row.id] if row_id else [])))
        if clash is not None:
            raise ErpError("duplicate_walkin", f"{clash.name} already has this mobile number.", 409)
    for field, value in data.items():
        setattr(row, field, value)
    db.add(row)
    db.flush()
    record_audit(db, viewer, "walkin.saved", row, request=request, detail={"name": row.name})
    db.commit()
    db.refresh(row)
    return _out(row)


def delete_walkin(db: Session, viewer: User, walkin_id: uuid.UUID, request: Request | None = None) -> None:
    require(viewer, "can_manage_erp_masters")
    row = get_owned(db, ErpWalkinCustomer, viewer.org_id, walkin_id, "walk-in customer")
    record_audit(db, viewer, "walkin.deleted", row, request=request, detail={"name": row.name})
    db.delete(row)
    db.commit()
