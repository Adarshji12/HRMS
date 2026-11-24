"""Sale bills raised against a ledger (or a walk-in customer).

A bill is saved with its lines and totals. It does not yet move stock or post to the
ledger's balance; those are linked separately.
"""

from __future__ import annotations

import uuid
from datetime import date

from fastapi import Request
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models import User
from app.models.erp import ErpItem, ErpLedger, ErpSaleBill, ErpSaleBillLine, ErpWalkinCustomer, ErpWarehouse
from app.schemas import erp as S
from app.services.erp.common import ZERO, ErpError, get_owned, money, next_number, price_line, qty, record_audit, require

WALKIN_NAME = "Walk-in Customer"


def _line_out(line: ErpSaleBillLine) -> dict:
    return {
        "id": str(line.id), "line_no": line.line_no, "item_id": str(line.item_id) if line.item_id else None,
        "description": line.description, "lot_no": line.lot_no, "quantity": str(line.quantity), "free_qty": str(line.free_qty),
        "uom": line.uom, "mrp": str(line.mrp), "rate": str(line.rate), "discount_percent": str(line.discount_percent),
        "discount_amount": str(line.discount_amount), "gst_percent": str(line.gst_percent),
        "taxable": str(line.taxable), "tax": str(line.tax), "amount": str(line.amount),
    }


def _party_facts(db: Session, bill: ErpSaleBill) -> tuple[str | None, str | None]:
    """The party's city and mobile, as the register shows them."""
    if bill.ledger_id and (led := db.get(ErpLedger, bill.ledger_id)):
        return led.city, led.mobile
    if bill.walkin_id and (w := db.get(ErpWalkinCustomer, bill.walkin_id)):
        return None, w.mobile
    return None, None


def _out(db: Session, bill: ErpSaleBill, *, lines: bool) -> dict:
    wh = db.get(ErpWarehouse, bill.warehouse_id) if bill.warehouse_id else None
    party = _party_facts(db, bill)
    out = {
        "id": str(bill.id), "number": bill.number, "bill_date": bill.bill_date.isoformat(), "bill_type": bill.bill_type,
        "ledger_id": str(bill.ledger_id) if bill.ledger_id else None, "walkin_id": str(bill.walkin_id) if bill.walkin_id else None,
        "party_name": bill.party_name, "doc_type": bill.doc_type, "valid_till": bill.valid_till.isoformat() if bill.valid_till else None,
        "status": bill.status, "station": party[0], "mobile": party[1], "warehouse_id": str(bill.warehouse_id) if bill.warehouse_id else None,
        "warehouse_name": wh.name if wh else None, "sub_total": str(bill.sub_total), "discount_total": str(bill.discount_total),
        "tax_total": str(bill.tax_total), "grand_total": str(bill.grand_total), "notes": bill.notes,
        "created_at": bill.created_at.isoformat(),
    }
    if lines:
        rows = db.scalars(select(ErpSaleBillLine).where(ErpSaleBillLine.bill_id == bill.id).order_by(ErpSaleBillLine.line_no))
        out["lines"] = [_line_out(r) for r in rows]
    return out


def list_bills(db: Session, viewer: User, *, q: str | None = None, date_from: date | None = None, date_to: date | None = None, doc_type: str = "bill") -> list[dict]:
    require(viewer, "can_manage_billing")
    stmt = select(ErpSaleBill).where(ErpSaleBill.org_id == viewer.org_id, ErpSaleBill.doc_type == doc_type)
    if date_from:
        stmt = stmt.where(ErpSaleBill.bill_date >= date_from)
    if date_to:
        stmt = stmt.where(ErpSaleBill.bill_date <= date_to)
    if q and q.strip():
        like = f"%{q.strip().lower()}%"
        stmt = stmt.where(or_(func.lower(ErpSaleBill.number).like(like), func.lower(ErpSaleBill.party_name).like(like)))
    return [_out(db, b, lines=False) for b in db.scalars(stmt.order_by(ErpSaleBill.bill_date.desc(), ErpSaleBill.created_at.desc()).limit(500))]


def get_bill(db: Session, viewer: User, bill_id: uuid.UUID) -> dict:
    require(viewer, "can_manage_billing")
    return _out(db, get_owned(db, ErpSaleBill, viewer.org_id, bill_id, "sale bill"), lines=True)


def create_bill(db: Session, viewer: User, payload: S.SaleBillIn, request: Request | None = None) -> dict:
    require(viewer, "can_manage_billing")
    ledger = get_owned(db, ErpLedger, viewer.org_id, payload.ledger_id, "ledger") if payload.ledger_id else None
    walkin = get_owned(db, ErpWalkinCustomer, viewer.org_id, payload.walkin_id, "walk-in customer") if payload.walkin_id else None
    if ledger is None and walkin is None and not payload.walkin_bill:
        raise ErpError("party_required", "Choose the party.", 422)
    if payload.warehouse_id:
        get_owned(db, ErpWarehouse, viewer.org_id, payload.warehouse_id, "store")
    on = payload.bill_date or date.today()
    number = next_number(db, viewer.org_id, "QT" if payload.doc_type == "quotation" else "SB", on)
    bill = ErpSaleBill(
        org_id=viewer.org_id, number=number, bill_date=on, bill_type=payload.bill_type, doc_type=payload.doc_type, valid_till=payload.valid_till,
        ledger_id=ledger.id if ledger else None, walkin_id=walkin.id if walkin else None,
        party_name=ledger.name if ledger else (walkin.name if walkin else WALKIN_NAME),
        warehouse_id=payload.warehouse_id, notes=(payload.notes or "").strip() or None, created_by=viewer.id,
    )
    db.add(bill)
    db.flush()
    sub, disc, tax, grand = ZERO, ZERO, ZERO, ZERO
    for n, line in enumerate(payload.lines, start=1):
        item = get_owned(db, ErpItem, viewer.org_id, line.item_id, "item") if line.item_id else None
        gross = money(qty(line.quantity) * money(line.rate))
        priced = price_line(line.quantity, line.rate, line.gst_percent, line.discount_percent, line.discount_amount)
        db.add(ErpSaleBillLine(
            org_id=viewer.org_id, bill_id=bill.id, line_no=n, item_id=item.id if item else None, description=line.description.strip(),
            lot_no=(line.lot_no or "").strip() or None, quantity=qty(line.quantity), free_qty=qty(line.free_qty),
            uom=line.uom or (item.uom if item else None), mrp=money(line.mrp), rate=money(line.rate),
            discount_percent=line.discount_percent, discount_amount=money(line.discount_amount), gst_percent=line.gst_percent,
            taxable=priced["taxable_value"], tax=priced["tax_amount"], amount=priced["amount"],
        ))
        sub += priced["taxable_value"]
        disc += gross - priced["taxable_value"]
        tax += priced["tax_amount"]
        grand += priced["amount"]
    bill.sub_total, bill.discount_total, bill.tax_total, bill.grand_total = money(sub), money(disc), money(tax), money(grand)
    db.flush()
    record_audit(db, viewer, "sale_bill.create", bill, request=request, detail={"number": number, "total": str(bill.grand_total)})
    db.commit()
    return _out(db, bill, lines=True)
