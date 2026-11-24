"""Walk-in customers: cash customers kept as a simple list, not as ledgers."""

from __future__ import annotations

import uuid

from fastapi import Request
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models import CrmCustomer, User
from app.models.erp import ErpSaleBill, ErpWalkinCustomer
from app.schemas import erp as S
from app.services.erp.common import ErpError, get_owned, record_audit, require, row_dict


WALKIN_CODE = "WALK-IN"


def billing_customer(db: Session, org_id: uuid.UUID) -> CrmCustomer:
    """The one customer record every walk-in invoice hangs off.

    Invoices need a customer to carry receipts and ageing; walk-ins are not kept
    as customers, so they share this record and the invoice keeps the walk-in's own name.
    """
    row = db.scalar(select(CrmCustomer).where(CrmCustomer.org_id == org_id, CrmCustomer.code == WALKIN_CODE))
    if row is None:
        row = CrmCustomer(org_id=org_id, code=WALKIN_CODE, name="Walk-in Customer", mobile="0000000000", status="active")
        db.add(row)
        db.flush()
    return row


def _stats(db: Session, org_id: uuid.UUID, ids: list[uuid.UUID]) -> dict[uuid.UUID, tuple]:
    """Bills raised, their total and the latest date, per walk-in customer."""
    if not ids:
        return {}
    rows = db.execute(
        select(ErpSaleBill.walkin_id, func.count(), func.coalesce(func.sum(ErpSaleBill.grand_total), 0), func.max(ErpSaleBill.bill_date))
        .where(ErpSaleBill.org_id == org_id, ErpSaleBill.doc_type == "bill", ErpSaleBill.walkin_id.in_(ids)).group_by(ErpSaleBill.walkin_id)
    ).all()
    return {r[0]: (r[1], r[2], r[3]) for r in rows}


def _out(row: ErpWalkinCustomer, stats: tuple | None = None) -> dict:
    out = row_dict(row)
    bills, total, last = stats or (0, 0, None)
    out.update({"bills": bills, "total_bought": str(total), "last_bill": last.isoformat() if last else None})
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
    rows = list(db.scalars(stmt.order_by(func.lower(ErpWalkinCustomer.name))))
    stats = _stats(db, viewer.org_id, [r.id for r in rows])
    return [_out(r, stats.get(r.id)) for r in rows]


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
