"""Inventory: the stock ledger, serials, reservations, and stock documents.

Every quantity that moves, moves through :func:`move`. It is the only writer of
``erp_stock_movements`` and ``erp_stock_balances``, so the two cannot drift: a
GRN, a dispatch, an issue and an adjustment all differ in *why* stock moved,
never in *how*.

Three guards live in :func:`move` rather than in its callers, because each is
a rule the PRD states once for the whole module:

* **No negative stock** unless the organisation has switched it on
  (FR-08.24).
* **Reserved stock is spoken for.** An issue may not take good stock that a
  sales order has reserved; only that order's own dispatch may consume the
  reservation. Otherwise the shelf looks full right up until the order ships
  short.
* **Weighted average cost** moves only on receipts. An outbound movement is
  valued at the bucket's average at that moment, which is what makes the
  ledger's value column add up to the balance's.

Serialised items carry one serial per unit on every movement, checked against
where the serial actually is — a unit cannot be dispatched from Mumbai while
the system believes it is in Pune (FR-09.03, "serial-level reconciliation").
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Iterable

from fastapi import Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import User
from app.models.erp import (
    ErpItem,
    ErpSerial,
    ErpSerialEvent,
    ErpStockBalance,
    ErpStockDoc,
    ErpStockDocLine,
    ErpStockMovement,
    ErpWarehouse,
    MovementKind,
    SerialStatus,
    StockCondition,
    StockDocKind,
    StockDocStatus,
)
from app.schemas import erp as S
from app.services.erp.common import (
    ZERO,
    ErpError,
    get_owned,
    get_settings,
    money,
    next_number,
    qty,
    record_audit,
    require,
    require_reason,
    row_dict,
    user_names,
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------- #
# Lookups
# --------------------------------------------------------------------------- #


def stocked_item(db: Session, org_id: uuid.UUID, item_id: uuid.UUID | None) -> ErpItem | None:
    """The item if it is a stocked good, ``None`` for a service or a free-text line."""
    if item_id is None:
        return None
    item = get_owned(db, ErpItem, org_id, item_id, "item")
    return item if item.is_stocked else None


def active_warehouse(db: Session, org_id: uuid.UUID, warehouse_id: uuid.UUID | None) -> ErpWarehouse:
    if warehouse_id is None:
        raise ErpError("warehouse_required", "Choose a warehouse.")
    wh = get_owned(db, ErpWarehouse, org_id, warehouse_id, "warehouse")
    if not wh.is_active:
        raise ErpError("warehouse_inactive", f"{wh.name} is inactive.", 409)
    return wh


def balance(
    db: Session, org_id: uuid.UUID, item_id: uuid.UUID, warehouse_id: uuid.UUID,
    condition: str = StockCondition.GOOD.value,
) -> ErpStockBalance:
    row = db.scalar(select(ErpStockBalance).where(
        ErpStockBalance.org_id == org_id, ErpStockBalance.item_id == item_id,
        ErpStockBalance.warehouse_id == warehouse_id, ErpStockBalance.condition == condition,
    ))
    if row is None:
        row = ErpStockBalance(
            org_id=org_id, item_id=item_id, warehouse_id=warehouse_id, condition=condition,
            quantity=ZERO, reserved_qty=ZERO, avg_cost=ZERO,
        )
        db.add(row)
        db.flush()
    return row


def available(db: Session, org_id: uuid.UUID, item_id: uuid.UUID, warehouse_id: uuid.UUID | None = None) -> Decimal:
    """Good stock not promised to anybody."""
    stmt = select(func.coalesce(func.sum(ErpStockBalance.quantity - ErpStockBalance.reserved_qty), 0)).where(
        ErpStockBalance.org_id == org_id, ErpStockBalance.item_id == item_id,
        ErpStockBalance.condition == StockCondition.GOOD.value,
    )
    if warehouse_id is not None:
        stmt = stmt.where(ErpStockBalance.warehouse_id == warehouse_id)
    return Decimal(str(db.scalar(stmt) or 0))


# --------------------------------------------------------------------------- #
# The one writer
# --------------------------------------------------------------------------- #


def move(
    db: Session, viewer: User, *, item: ErpItem, warehouse_id: uuid.UUID, quantity: Decimal,
    kind: MovementKind, ref_type: str, ref_id: uuid.UUID, ref_number: str | None,
    condition: str = StockCondition.GOOD.value, unit_cost: Decimal | None = None,
    serials: list[str] | None = None, reason: str | None = None,
    consume_reserved: Decimal = ZERO,
) -> ErpStockMovement:
    """Write one ledger line and move the balance with it. See the module docstring."""
    quantity = qty(quantity)
    if quantity == 0:
        raise ErpError("zero_quantity", "A movement must move something.")
    bucket = balance(db, viewer.org_id, item.id, warehouse_id, condition)
    settings = get_settings(db, viewer.org_id)

    if quantity < 0:
        out = -quantity
        free = bucket.quantity - bucket.reserved_qty + consume_reserved
        if not settings.allow_negative_stock:
            if bucket.quantity < out:
                wh = db.get(ErpWarehouse, warehouse_id)
                raise ErpError(
                    "insufficient_stock",
                    f"{item.code}: only {bucket.quantity.normalize()} {item.uom} "
                    f"({condition}) at {wh.name if wh else 'that warehouse'}, "
                    f"{out.normalize()} needed.",
                    409,
                )
            if condition == StockCondition.GOOD.value and free < out:
                raise ErpError(
                    "stock_reserved",
                    f"{item.code}: {bucket.reserved_qty.normalize()} of the "
                    f"{bucket.quantity.normalize()} on hand is reserved for sales orders.",
                    409,
                )
        if consume_reserved:
            bucket.reserved_qty = max(ZERO, bucket.reserved_qty - consume_reserved)
        cost = bucket.avg_cost
    else:
        cost = money(unit_cost if unit_cost is not None else bucket.avg_cost or item.standard_cost)
        if bucket.quantity + quantity > 0:
            held = max(bucket.quantity, ZERO)
            bucket.avg_cost = money((held * bucket.avg_cost + quantity * cost) / (held + quantity))

    bucket.quantity = qty(bucket.quantity + quantity)
    bucket.last_movement_at = _now()
    row = ErpStockMovement(
        org_id=viewer.org_id, item_id=item.id, warehouse_id=warehouse_id, condition=condition,
        kind=kind.value, quantity=quantity, unit_cost=cost, balance_after=bucket.quantity,
        ref_type=ref_type, ref_id=ref_id, ref_number=ref_number,
        serials=serials or None, reason=reason, created_by=viewer.id,
    )
    db.add(row)
    db.flush()
    return row


# --------------------------------------------------------------------------- #
# Serials
# --------------------------------------------------------------------------- #


def check_serial_count(item: ErpItem, quantity: Decimal, serials: list[str]) -> list[str]:
    """One serial per unit, no repeats, for a serialised item; none otherwise."""
    cleaned = [s.strip() for s in serials if s and s.strip()]
    if not item.is_serialized:
        if cleaned:
            raise ErpError("not_serialized", f"{item.code} is not serial-tracked.")
        return []
    if quantity != quantity.to_integral_value():
        raise ErpError("whole_units", f"{item.code} is serial-tracked and moves in whole units.")
    if len(cleaned) != int(quantity):
        raise ErpError(
            "serial_count",
            f"{item.code}: {int(quantity)} units need {int(quantity)} serial numbers, "
            f"{len(cleaned)} given.",
        )
    if len(set(cleaned)) != len(cleaned):
        raise ErpError("serial_repeated", f"{item.code}: a serial number appears twice.")
    return cleaned


def _event(db: Session, viewer: User, serial: ErpSerial, kind: MovementKind, ref_type: str,
           ref_id: uuid.UUID, ref_number: str | None) -> None:
    db.add(ErpSerialEvent(
        org_id=viewer.org_id, serial_id=serial.id, kind=kind.value,
        warehouse_id=serial.warehouse_id, condition=serial.condition,
        ref_type=ref_type, ref_id=ref_id, ref_number=ref_number, created_by=viewer.id,
    ))


def _serial_rows(db: Session, org_id: uuid.UUID, item_id: uuid.UUID, serials: Iterable[str]) -> dict[str, ErpSerial]:
    wanted = list(serials)
    if not wanted:
        return {}
    return {
        s.serial_no: s for s in db.scalars(select(ErpSerial).where(
            ErpSerial.org_id == org_id, ErpSerial.item_id == item_id, ErpSerial.serial_no.in_(wanted)))
    }


def receive_serials(
    db: Session, viewer: User, *, item: ErpItem, serials: list[str], warehouse_id: uuid.UUID,
    condition: str, ref_type: str, ref_id: uuid.UUID, ref_number: str | None,
    vendor_id: uuid.UUID | None = None, grn_id: uuid.UUID | None = None, received_on: date | None = None,
) -> None:
    """New units arriving from a vendor. A serial already in stock is a duplicate."""
    existing = _serial_rows(db, viewer.org_id, item.id, serials)
    for serial_no in serials:
        row = existing.get(serial_no)
        if row is not None and row.status in (SerialStatus.IN_STOCK.value, SerialStatus.IN_TRANSIT.value):
            raise ErpError("serial_exists", f"{item.code} serial {serial_no} is already in stock.", 409)
        if row is None:
            row = ErpSerial(org_id=viewer.org_id, item_id=item.id, serial_no=serial_no)
            db.add(row)
        row.warehouse_id = warehouse_id
        row.condition = condition
        row.status = SerialStatus.IN_STOCK.value
        row.vendor_id = vendor_id
        row.goods_receipt_id = grn_id
        row.customer_id = None
        row.sales_order_id = None
        if item.warranty_months and received_on:
            month = received_on.month - 1 + item.warranty_months
            year = received_on.year + month // 12
            day = min(received_on.day, 28)
            row.warranty_until = date(year, month % 12 + 1, day)
        db.flush()
        _event(db, viewer, row, MovementKind.GRN, ref_type, ref_id, ref_number)


def take_serials(
    db: Session, viewer: User, *, item: ErpItem, serials: list[str], warehouse_id: uuid.UUID,
    condition: str, new_status: SerialStatus, kind: MovementKind, ref_type: str, ref_id: uuid.UUID,
    ref_number: str | None, customer_id: uuid.UUID | None = None,
    sales_order_id: uuid.UUID | None = None,
) -> None:
    """Units leaving a warehouse. Each must be in stock *there*, in that condition."""
    rows = _serial_rows(db, viewer.org_id, item.id, serials)
    for serial_no in serials:
        row = rows.get(serial_no)
        if (
            row is None or row.status != SerialStatus.IN_STOCK.value
            or row.warehouse_id != warehouse_id or row.condition != condition
        ):
            raise ErpError(
                "serial_not_here",
                f"{item.code} serial {serial_no} is not in {condition} stock at this warehouse.", 409,
            )
        row.status = new_status.value
        row.warehouse_id = None if new_status is not SerialStatus.IN_STOCK else warehouse_id
        if customer_id:
            row.customer_id = customer_id
            row.sales_order_id = sales_order_id
        _event(db, viewer, row, kind, ref_type, ref_id, ref_number)


def place_serials(
    db: Session, viewer: User, *, item: ErpItem, serials: list[str], warehouse_id: uuid.UUID,
    condition: str, kind: MovementKind, ref_type: str, ref_id: uuid.UUID, ref_number: str | None,
    expect: tuple[SerialStatus, ...],
) -> None:
    """Known units coming back in — a return, the far end of a transfer."""
    rows = _serial_rows(db, viewer.org_id, item.id, serials)
    for serial_no in serials:
        row = rows.get(serial_no)
        if row is None or SerialStatus(row.status) not in expect:
            raise ErpError(
                "serial_unknown",
                f"{item.code} serial {serial_no} is not out of stock, so it cannot come back in.", 409,
            )
        row.status = SerialStatus.IN_STOCK.value
        row.warehouse_id = warehouse_id
        row.condition = condition
        _event(db, viewer, row, kind, ref_type, ref_id, ref_number)


# --------------------------------------------------------------------------- #
# Reservations
# --------------------------------------------------------------------------- #


def reserve(db: Session, org_id: uuid.UUID, item: ErpItem, warehouse_id: uuid.UUID, quantity: Decimal) -> None:
    bucket = balance(db, org_id, item.id, warehouse_id)
    free = bucket.quantity - bucket.reserved_qty
    if quantity > free:
        raise ErpError(
            "insufficient_stock",
            f"{item.code}: {free.normalize()} available to reserve, {quantity.normalize()} asked.", 409,
        )
    bucket.reserved_qty = qty(bucket.reserved_qty + quantity)


def release(db: Session, org_id: uuid.UUID, item_id: uuid.UUID, warehouse_id: uuid.UUID, quantity: Decimal) -> None:
    bucket = balance(db, org_id, item_id, warehouse_id)
    bucket.reserved_qty = max(ZERO, qty(bucket.reserved_qty - quantity))


# --------------------------------------------------------------------------- #
# Reads
# --------------------------------------------------------------------------- #


def list_balances(
    db: Session, viewer: User, *, item_id: uuid.UUID | None = None,
    warehouse_id: uuid.UUID | None = None, condition: str | None = None,
    include_zero: bool = False,
) -> list[dict]:
    stmt = (
        select(ErpStockBalance, ErpItem, ErpWarehouse)
        .join(ErpItem, ErpItem.id == ErpStockBalance.item_id)
        .join(ErpWarehouse, ErpWarehouse.id == ErpStockBalance.warehouse_id)
        .where(ErpStockBalance.org_id == viewer.org_id)
    )
    if item_id:
        stmt = stmt.where(ErpStockBalance.item_id == item_id)
    if warehouse_id:
        stmt = stmt.where(ErpStockBalance.warehouse_id == warehouse_id)
    if condition:
        stmt = stmt.where(ErpStockBalance.condition == condition)
    if not include_zero:
        stmt = stmt.where(ErpStockBalance.quantity != 0)
    out = []
    for bal, item, wh in db.execute(stmt.order_by(ErpItem.name, ErpWarehouse.name)).all():
        out.append({
            "id": str(bal.id), "item_id": str(item.id), "item_code": item.code, "item_name": item.name,
            "uom": item.uom, "is_serialized": item.is_serialized,
            "warehouse_id": str(wh.id), "warehouse_name": wh.name, "condition": bal.condition,
            "quantity": str(bal.quantity), "reserved_qty": str(bal.reserved_qty),
            "available_qty": str(bal.quantity - bal.reserved_qty),
            "avg_cost": str(bal.avg_cost), "value": str(money(bal.quantity * bal.avg_cost)),
            "reorder_level": str(item.reorder_level),
            "last_movement_at": bal.last_movement_at.isoformat() if bal.last_movement_at else None,
        })
    return out


def list_movements(
    db: Session, viewer: User, *, item_id: uuid.UUID | None = None,
    warehouse_id: uuid.UUID | None = None, ref_id: uuid.UUID | None = None, limit: int = 300,
) -> list[dict]:
    stmt = (
        select(ErpStockMovement, ErpItem, ErpWarehouse)
        .join(ErpItem, ErpItem.id == ErpStockMovement.item_id)
        .join(ErpWarehouse, ErpWarehouse.id == ErpStockMovement.warehouse_id)
        .where(ErpStockMovement.org_id == viewer.org_id)
    )
    if item_id:
        stmt = stmt.where(ErpStockMovement.item_id == item_id)
    if warehouse_id:
        stmt = stmt.where(ErpStockMovement.warehouse_id == warehouse_id)
    if ref_id:
        stmt = stmt.where(ErpStockMovement.ref_id == ref_id)
    rows = db.execute(stmt.order_by(ErpStockMovement.created_at.desc()).limit(limit)).all()
    names = user_names(db, viewer.org_id, [m.created_by for m, _, _ in rows])
    return [
        {
            **row_dict(m), "item_code": item.code, "item_name": item.name, "uom": item.uom,
            "warehouse_name": wh.name, "value": str(money(m.quantity * m.unit_cost)),
            "created_by_name": names.get(m.created_by),
        }
        for m, item, wh in rows
    ]


def find_serial(db: Session, viewer: User, serial_no: str) -> list[dict]:
    """Every unit with that serial — across items, since two OEMs can collide."""
    rows = db.execute(
        select(ErpSerial, ErpItem).join(ErpItem, ErpItem.id == ErpSerial.item_id).where(
            ErpSerial.org_id == viewer.org_id, ErpSerial.serial_no.ilike(f"%{serial_no.strip()}%"))
        .limit(50)
    ).all()
    out = []
    for serial, item in rows:
        events = list(db.scalars(select(ErpSerialEvent).where(
            ErpSerialEvent.serial_id == serial.id).order_by(ErpSerialEvent.created_at)))
        warehouses = {w.id: w.name for w in db.scalars(select(ErpWarehouse).where(
            ErpWarehouse.org_id == viewer.org_id))}
        out.append({
            **row_dict(serial), "item_code": item.code, "item_name": item.name,
            "warehouse_name": warehouses.get(serial.warehouse_id),
            "history": [
                {**row_dict(e), "warehouse_name": warehouses.get(e.warehouse_id)} for e in events
            ],
        })
    return out


def serials_in(db: Session, viewer: User, item_id: uuid.UUID, warehouse_id: uuid.UUID,
               condition: str = StockCondition.GOOD.value) -> list[str]:
    """Pickable serials — what the dispatch and issue forms offer."""
    return list(db.scalars(select(ErpSerial.serial_no).where(
        ErpSerial.org_id == viewer.org_id, ErpSerial.item_id == item_id,
        ErpSerial.warehouse_id == warehouse_id, ErpSerial.condition == condition,
        ErpSerial.status == SerialStatus.IN_STOCK.value,
    ).order_by(ErpSerial.serial_no)))


# --------------------------------------------------------------------------- #
# Stock documents
# --------------------------------------------------------------------------- #

PREFIX = {"issue": "ISS", "return": "RET", "transfer": "TRF", "adjustment": "ADJ"}


def _doc_out(db: Session, doc: ErpStockDoc) -> dict:
    items = {i.id: i for i in db.scalars(select(ErpItem).where(
        ErpItem.id.in_([line.item_id for line in doc.lines])))} if doc.lines else {}
    wh = {w.id: w.name for w in db.scalars(select(ErpWarehouse).where(ErpWarehouse.org_id == doc.org_id))}
    names = user_names(db, doc.org_id, [doc.created_by, doc.reviewed_by, doc.recipient_id])
    from app.services import chains

    return {
        **row_dict(doc),
        "from_warehouse_name": wh.get(doc.from_warehouse_id),
        "to_warehouse_name": wh.get(doc.to_warehouse_id),
        "created_by_name": names.get(doc.created_by),
        "reviewed_by_name": names.get(doc.reviewed_by),
        "recipient_name": names.get(doc.recipient_id),
        "chain": [row_dict(s) for s in chains.steps_for(db, doc.id)],
        "lines": [
            {
                **row_dict(line),
                "item_code": items[line.item_id].code if line.item_id in items else None,
                "item_name": items[line.item_id].name if line.item_id in items else None,
                "uom": items[line.item_id].uom if line.item_id in items else None,
                "is_serialized": items[line.item_id].is_serialized if line.item_id in items else False,
            }
            for line in doc.lines
        ],
    }


def list_docs(db: Session, viewer: User, *, kind: str | None = None, status: str | None = None) -> list[dict]:
    stmt = select(ErpStockDoc).where(ErpStockDoc.org_id == viewer.org_id)
    if kind:
        stmt = stmt.where(ErpStockDoc.kind == kind)
    if status:
        stmt = stmt.where(ErpStockDoc.status == status)
    return [_doc_out(db, d) for d in db.scalars(stmt.order_by(ErpStockDoc.created_at.desc()).limit(300))]


def get_doc(db: Session, viewer: User, doc_id: uuid.UUID) -> dict:
    return _doc_out(db, get_owned(db, ErpStockDoc, viewer.org_id, doc_id, "stock document"))


def _validate_doc(db: Session, viewer: User, payload: S.StockDocIn) -> None:
    kind = StockDocKind(payload.kind)
    if kind in (StockDocKind.ISSUE, StockDocKind.TRANSFER, StockDocKind.ADJUSTMENT):
        active_warehouse(db, viewer.org_id, payload.from_warehouse_id)
    if kind in (StockDocKind.RETURN, StockDocKind.TRANSFER):
        active_warehouse(db, viewer.org_id, payload.to_warehouse_id)
    if kind is StockDocKind.TRANSFER and payload.from_warehouse_id == payload.to_warehouse_id:
        raise ErpError("same_warehouse", "A transfer needs two different warehouses.")
    if kind is StockDocKind.ADJUSTMENT and not payload.reason:
        raise ErpError("reason_required", "An adjustment needs a reason code.")
    for line in payload.lines:
        item = get_owned(db, ErpItem, viewer.org_id, line.item_id, "item")
        if not item.is_stocked:
            raise ErpError("not_stocked", f"{item.code} is a service and is not stocked.")
        if line.quantity == 0:
            raise ErpError("zero_quantity", f"{item.code}: a quantity of zero moves nothing.")
        if kind is not StockDocKind.ADJUSTMENT and line.quantity < 0:
            raise ErpError("negative_quantity", f"{item.code}: quantities are positive here.")
        check_serial_count(item, abs(qty(line.quantity)), line.serials)


def save_doc(
    db: Session, viewer: User, payload: S.StockDocIn, doc_id: uuid.UUID | None = None,
    request: Request | None = None,
) -> dict:
    require(viewer, "can_manage_inventory")
    _validate_doc(db, viewer, payload)
    today = payload.doc_date or date.today()
    if doc_id:
        doc = get_owned(db, ErpStockDoc, viewer.org_id, doc_id, "stock document")
        if doc.status != StockDocStatus.DRAFT.value:
            raise ErpError("not_draft", "Only a draft can be edited.", 409)
        if doc.kind != payload.kind:
            raise ErpError("kind_fixed", "A document's kind cannot change.")
    else:
        doc = ErpStockDoc(
            org_id=viewer.org_id, kind=payload.kind, created_by=viewer.id, doc_date=today,
            number=next_number(db, viewer.org_id, PREFIX[payload.kind], today),
        )
        db.add(doc)
    for field in ("from_warehouse_id", "to_warehouse_id", "reason", "project_id", "recipient_id", "notes"):
        setattr(doc, field, getattr(payload, field))
    doc.doc_date = today
    doc.lines.clear()
    value = ZERO
    for order, line in enumerate(payload.lines):
        item = db.get(ErpItem, line.item_id)
        cost = ZERO
        if doc.from_warehouse_id:
            cost = balance(db, viewer.org_id, item.id, doc.from_warehouse_id, line.condition).avg_cost
        cost = cost or item.standard_cost
        q = qty(line.quantity)
        value += abs(q) * cost
        doc.lines.append(ErpStockDocLine(
            org_id=viewer.org_id, item_id=item.id, quantity=q, condition=line.condition,
            unit_cost=money(cost), serials=check_serial_count(item, abs(q), line.serials) or None,
            sort_order=order,
        ))
    doc.value = money(value)
    db.flush()
    record_audit(db, viewer, "stock_doc.saved", doc, request=request, detail={"kind": doc.kind})
    db.commit()
    return get_doc(db, viewer, doc.id)


def _post_out(db: Session, viewer: User, doc: ErpStockDoc, line: ErpStockDocLine, kind: MovementKind,
              new_status: SerialStatus, warehouse_id: uuid.UUID, quantity: Decimal) -> None:
    item = db.get(ErpItem, line.item_id)
    if line.serials:
        take_serials(db, viewer, item=item, serials=line.serials, warehouse_id=warehouse_id,
                     condition=line.condition, new_status=new_status, kind=kind,
                     ref_type="stock_doc", ref_id=doc.id, ref_number=doc.number)
    moved = move(db, viewer, item=item, warehouse_id=warehouse_id, quantity=-quantity, kind=kind,
                 ref_type="stock_doc", ref_id=doc.id, ref_number=doc.number,
                 condition=line.condition, serials=line.serials, reason=doc.reason)
    line.unit_cost = moved.unit_cost


def _post_in(db: Session, viewer: User, doc: ErpStockDoc, line: ErpStockDocLine, kind: MovementKind,
             warehouse_id: uuid.UUID, quantity: Decimal, expect: tuple[SerialStatus, ...]) -> None:
    item = db.get(ErpItem, line.item_id)
    if line.serials:
        place_serials(db, viewer, item=item, serials=line.serials, warehouse_id=warehouse_id,
                      condition=line.condition, kind=kind, ref_type="stock_doc", ref_id=doc.id,
                      ref_number=doc.number, expect=expect)
    move(db, viewer, item=item, warehouse_id=warehouse_id, quantity=quantity, kind=kind,
         ref_type="stock_doc", ref_id=doc.id, ref_number=doc.number, condition=line.condition,
         unit_cost=line.unit_cost or None, serials=line.serials, reason=doc.reason)


def post_doc(db: Session, viewer: User, doc_id: uuid.UUID, request: Request | None = None) -> dict:
    """Issue, return, or send a transfer on its way. Not an adjustment — that
    is approved, and approval is what posts it."""
    require(viewer, "can_manage_inventory")
    doc = get_owned(db, ErpStockDoc, viewer.org_id, doc_id, "stock document")
    kind = StockDocKind(doc.kind)
    if doc.status != StockDocStatus.DRAFT.value:
        raise ErpError("not_draft", f"This document is {doc.status}.", 409)
    if kind is StockDocKind.ADJUSTMENT:
        raise ErpError("needs_approval", "An adjustment is submitted for approval, not posted.", 409)

    for line in doc.lines:
        if kind is StockDocKind.ISSUE:
            _post_out(db, viewer, doc, line, MovementKind.ISSUE, SerialStatus.ISSUED,
                      doc.from_warehouse_id, line.quantity)
        elif kind is StockDocKind.RETURN:
            _post_in(db, viewer, doc, line, MovementKind.RETURN, doc.to_warehouse_id, line.quantity,
                     (SerialStatus.ISSUED, SerialStatus.DELIVERED))
        else:
            _post_out(db, viewer, doc, line, MovementKind.TRANSFER_OUT, SerialStatus.IN_TRANSIT,
                      doc.from_warehouse_id, line.quantity)
    doc.status = (StockDocStatus.IN_TRANSIT if kind is StockDocKind.TRANSFER else StockDocStatus.POSTED).value
    doc.posted_at = _now()
    record_audit(db, viewer, "stock_doc.posted", doc, request=request, detail={"kind": doc.kind})
    db.commit()
    return get_doc(db, viewer, doc.id)


def receive_transfer(db: Session, viewer: User, doc_id: uuid.UUID, request: Request | None = None) -> dict:
    require(viewer, "can_manage_inventory")
    doc = get_owned(db, ErpStockDoc, viewer.org_id, doc_id, "stock document")
    if doc.kind != StockDocKind.TRANSFER.value or doc.status != StockDocStatus.IN_TRANSIT.value:
        raise ErpError("not_in_transit", "Only a transfer in transit can be received.", 409)
    for line in doc.lines:
        _post_in(db, viewer, doc, line, MovementKind.TRANSFER_IN, doc.to_warehouse_id, line.quantity,
                 (SerialStatus.IN_TRANSIT,))
    doc.status = StockDocStatus.RECEIVED.value
    doc.received_at = _now()
    record_audit(db, viewer, "stock_doc.received", doc, request=request)
    db.commit()
    return get_doc(db, viewer, doc.id)


def submit_adjustment(db: Session, viewer: User, doc_id: uuid.UUID, request: Request | None = None) -> dict:
    from app.services import chains

    require(viewer, "can_manage_inventory")
    doc = get_owned(db, ErpStockDoc, viewer.org_id, doc_id, "stock document")
    if doc.kind != StockDocKind.ADJUSTMENT.value:
        raise ErpError("not_adjustment", "Only an adjustment is submitted for approval.", 409)
    if doc.status != StockDocStatus.DRAFT.value:
        raise ErpError("not_draft", f"This adjustment is {doc.status}.", 409)
    doc.status = StockDocStatus.SUBMITTED.value
    doc.submitted_at = _now()
    db.flush()
    chains.start_for(db, kind="stock_adjustment", record_id=doc.id, subject=viewer, record=doc)
    record_audit(db, viewer, "stock_doc.submitted", doc, request=request)
    db.commit()
    return get_doc(db, viewer, doc.id)


def decide_adjustment(
    db: Session, viewer: User, doc_id: uuid.UUID, payload: S.DecisionIn, request: Request | None = None,
) -> dict:
    from app.services import workflow
    from app.services.erp.common import kernel_decide

    doc = get_owned(db, ErpStockDoc, viewer.org_id, doc_id, "stock document")
    if doc.kind != StockDocKind.ADJUSTMENT.value:
        raise ErpError("not_adjustment", "Only an adjustment is approved.", 409)

    def post() -> None:
        for line in doc.lines:
            item = db.get(ErpItem, line.item_id)
            if line.quantity < 0:
                _post_out(db, viewer, doc, line, MovementKind.ADJUSTMENT, SerialStatus.SCRAPPED,
                          doc.from_warehouse_id, -line.quantity)
            else:
                if line.serials:
                    receive_serials(db, viewer, item=item, serials=line.serials,
                                    warehouse_id=doc.from_warehouse_id, condition=line.condition,
                                    ref_type="stock_doc", ref_id=doc.id, ref_number=doc.number)
                move(db, viewer, item=item, warehouse_id=doc.from_warehouse_id, quantity=line.quantity,
                     kind=MovementKind.ADJUSTMENT, ref_type="stock_doc", ref_id=doc.id,
                     ref_number=doc.number, condition=line.condition, unit_cost=line.unit_cost,
                     serials=line.serials, reason=doc.reason)
        doc.posted_at = _now()

    kernel_decide(db, viewer, workflow.ERP_STOCK_ADJUSTMENT, doc, payload, on_approve=post,
                  request=request)
    db.commit()
    return get_doc(db, viewer, doc.id)


def cancel_doc(db: Session, viewer: User, doc_id: uuid.UUID, reason: str | None,
               request: Request | None = None) -> dict:
    require(viewer, "can_manage_inventory")
    doc = get_owned(db, ErpStockDoc, viewer.org_id, doc_id, "stock document")
    if doc.status not in (StockDocStatus.DRAFT.value, StockDocStatus.SUBMITTED.value):
        raise ErpError(
            "already_posted",
            "Posted stock is corrected with a return or an adjustment, not by cancelling.", 409,
        )
    cleaned = require_reason(reason, "document is cancelled")
    doc.status = StockDocStatus.CANCELLED.value
    doc.notes = f"{doc.notes or ''}\nCancelled: {cleaned}".strip()
    record_audit(db, viewer, "stock_doc.cancelled", doc, request=request, detail={"reason": cleaned})
    db.commit()
    return get_doc(db, viewer, doc.id)
