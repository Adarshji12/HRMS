"""Opening stock by item and store, entered as lots.

The stock ledger holds the total (one ``opening`` movement per change); the lots hold the
detail: barcode, MRP, purchase rate and sale rates per batch. Saving an item's lots
replaces them and moves the ledger by the difference.
"""

from __future__ import annotations

import uuid

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import User
from app.models.erp import ErpItem, ErpOpeningLot, ErpWarehouse, MovementKind
from app.schemas import erp as S
from app.services.erp import stock
from app.services.erp.common import ZERO, ErpError, get_owned, money, qty, record_audit, require

_MONEY_FIELDS = ("mrp", "pur_rate", "rate_a", "rate_b", "rate_c")


def _lot_out(lot: ErpOpeningLot) -> dict:
    return {
        "id": str(lot.id), "lot_no": lot.lot_no, "barcode": lot.barcode, "quantity": str(lot.quantity),
        **{f: str(getattr(lot, f)) for f in _MONEY_FIELDS},
        "value": str(money(lot.quantity * lot.pur_rate)),
    }


def _lots(db: Session, org_id: uuid.UUID, warehouse_id: uuid.UUID, item_id: uuid.UUID | None = None) -> list[ErpOpeningLot]:
    stmt = select(ErpOpeningLot).where(ErpOpeningLot.org_id == org_id, ErpOpeningLot.warehouse_id == warehouse_id)
    if item_id:
        stmt = stmt.where(ErpOpeningLot.item_id == item_id)
    return list(db.scalars(stmt.order_by(ErpOpeningLot.created_at, ErpOpeningLot.lot_no)))


def list_openings(db: Session, viewer: User, warehouse_id: uuid.UUID, *, q: str | None = None,
                  company: str | None = None, category: str | None = None, with_stock: bool = False) -> list[dict]:
    """Every stocked, non-serialised item with what it opened with in this store."""
    require(viewer, "can_manage_inventory")
    get_owned(db, ErpWarehouse, viewer.org_id, warehouse_id, "store")
    by_item: dict[uuid.UUID, list[ErpOpeningLot]] = {}
    for lot in _lots(db, viewer.org_id, warehouse_id):
        by_item.setdefault(lot.item_id, []).append(lot)
    items = db.scalars(select(ErpItem).where(
        ErpItem.org_id == viewer.org_id, ErpItem.item_type == "goods", ErpItem.track_inventory.is_(True),
        ErpItem.is_serialized.is_(False), ErpItem.is_active.is_(True),
    ).order_by(ErpItem.code))
    needle = (q or "").strip().lower()
    rows = []
    for item in items:
        if needle and not any(needle in (x or "").lower() for x in (item.code, item.name, item.barcode)):
            continue
        if company and (item.make or "") != company:
            continue
        if category and (item.category or "") != category:
            continue
        lots = by_item.get(item.id, [])
        total = sum((lot.quantity for lot in lots), ZERO)
        value = sum((lot.quantity * lot.pur_rate for lot in lots), ZERO)
        if with_stock and total == 0:
            continue
        rows.append({
            "item_id": str(item.id), "code": item.code, "name": item.name, "make": item.make, "category": item.category,
            "uom": item.uom, "quantity": str(qty(total)), "rate": str(money(value / total)) if total else "0.00",
            "value": str(money(value)), "lot_count": len(lots),
        })
    return rows


def get_lots(db: Session, viewer: User, item_id: uuid.UUID, warehouse_id: uuid.UUID) -> list[dict]:
    require(viewer, "can_manage_inventory")
    get_owned(db, ErpItem, viewer.org_id, item_id, "item")
    get_owned(db, ErpWarehouse, viewer.org_id, warehouse_id, "store")
    return [_lot_out(lot) for lot in _lots(db, viewer.org_id, warehouse_id, item_id)]


def save_lots(db: Session, viewer: User, item_id: uuid.UUID, payload: S.OpeningStockIn, request: Request | None = None) -> dict:
    require(viewer, "can_manage_inventory")
    item = get_owned(db, ErpItem, viewer.org_id, item_id, "item")
    if not item.is_stocked or item.is_serialized:
        raise ErpError("not_lot_stock", f"{item.code} is not held as lots; serialised items are opened through Opening stock in Inventory.", 409)
    wh = stock.active_warehouse(db, viewer.org_id, payload.warehouse_id)
    kept = [lot for lot in payload.lots if lot.quantity > 0 or (lot.lot_no or "").strip() or (lot.barcode or "").strip()]
    named = [(lot.lot_no or "").strip().lower() for lot in kept if (lot.lot_no or "").strip()]
    if len(named) != len(set(named)):
        raise ErpError("duplicate_lot", "Two lots have the same S.Stock No.", 422)
    old = _lots(db, viewer.org_id, wh.id, item.id)
    old_total = sum((lot.quantity for lot in old), ZERO)
    for lot in old:
        db.delete(lot)
    db.flush()
    taken = set(named)
    n = 0
    new_total, new_value = ZERO, ZERO
    for lot in kept:
        number = (lot.lot_no or "").strip()
        if not number:
            n += 1
            while f"{item.code}-{n}".lower() in taken:
                n += 1
            number = f"{item.code}-{n}"
            taken.add(number.lower())
        row = ErpOpeningLot(
            org_id=viewer.org_id, item_id=item.id, warehouse_id=wh.id, lot_no=number,
            barcode=(lot.barcode or "").strip() or None, quantity=qty(lot.quantity),
            **{f: money(getattr(lot, f)) for f in _MONEY_FIELDS},
        )
        db.add(row)
        new_total += row.quantity
        new_value += row.quantity * row.pur_rate
    delta = qty(new_total - old_total)
    if delta != 0:
        cost = money(new_value / new_total) if new_total else None
        stock.move(db, viewer, item=item, warehouse_id=wh.id, quantity=delta, kind=MovementKind.OPENING,
                   ref_type="opening_lots", ref_id=item.id, ref_number="OPENING",
                   unit_cost=cost if delta > 0 else None, reason="Opening stock")
    db.flush()
    record_audit(db, viewer, "opening_stock.save", item, request=request,
                 detail={"store": wh.name, "quantity": str(qty(new_total)), "lots": len(kept)})
    db.commit()
    return {"item_id": str(item.id), "quantity": str(qty(new_total)),
            "lots": [_lot_out(lot) for lot in _lots(db, viewer.org_id, wh.id, item.id)]}
