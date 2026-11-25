"""Bill series: the numbering each kind of document follows."""

from __future__ import annotations

import uuid
from datetime import date

from fastapi import Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import User
from app.models.erp import ErpBillSeries
from app.schemas import erp as S
from app.services.erp.common import ErpError, get_owned, record_audit, require, row_dict

#: (key, label, group, default prefix) in the order the page lists them.
TRANSACTIONS = [
    ("sales_invoice", "Sales invoice", "sales", "INV-"), ("sale_order", "Sale order", "sales", "SLO-"),
    ("sales_order", "Sales order", "sales", "SO-"),
    ("quotation", "Quotation", "sales", "QT-"), ("delivery_challan", "Delivery challan", "sales", "DC-"),
    ("credit_note", "Credit note", "sales", "CN-"), ("receipt", "Receipt", "sales", "RC-"),
    ("purchase_bill", "Purchase bill", "purchase", "BILL-"), ("purchase_order", "Purchase order", "purchase", "PO-"),
    ("debit_note", "Debit note", "purchase", "DN-"), ("expense", "Expense", "purchase", "EXP-"),
    ("stock_adjustment", "Stock adjustment", "others", "SA-"), ("stock_transfer", "Stock transfer", "others", "ST-"),
    ("counter_shift", "Counter shift", "others", "CS-"), ("journal_entry", "Journal entry", "others", "JV-"),
    ("stock_issue", "Stock issue", "others", "SI-"),
]
KEYS = {t[0] for t in TRANSACTIONS}


def _out(row: ErpBillSeries) -> dict:
    out = row_dict(row)
    out["default_groups"] = list(row.default_groups or [])
    out["user_ids"] = list(row.user_ids or [])
    return out


def _seed(db: Session, org_id: uuid.UUID) -> None:
    """One default series per transaction. A transaction added later gets its own the next time the page opens."""
    have = set(db.scalars(select(ErpBillSeries.transaction).where(ErpBillSeries.org_id == org_id)))
    added = False
    for key, _label, _grp, prefix in TRANSACTIONS:
        if key in have:
            continue
        db.add(ErpBillSeries(org_id=org_id, transaction=key, name="Default", prefix=prefix, is_default=True,
                             default_groups=[]))
        added = True
    if added:
        db.commit()


def _years(on: date) -> tuple[str, str]:
    y = on.year if on.month >= 4 else on.year - 1
    return f"{y}-{(y + 1) % 100:02d}", str(on.year)


def issue_number(db: Session, org_id: uuid.UUID, transaction: str, on: date) -> str:
    """The next number on the default series for a transaction, taken: the series counter moves on."""
    _seed(db, org_id)
    row = db.scalar(select(ErpBillSeries).where(
        ErpBillSeries.org_id == org_id, ErpBillSeries.transaction == transaction
    ).order_by(ErpBillSeries.is_default.desc(), ErpBillSeries.created_at))
    if row is None:
        raise ErpError("no_series", "This transaction has no number series.", 422)
    fy, cy = _years(on)
    mid = f"{fy}/" if row.restart == "april" else f"{cy}/" if row.restart == "january" else ""
    number = f"{row.prefix}{mid}{str(row.next_number).zfill(row.digits)}{row.suffix}"
    row.next_number += 1
    row.issued += 1
    return number


def transactions() -> list[dict]:
    return [{"key": k, "label": l, "group": g} for k, l, g, _ in TRANSACTIONS]


def list_series(db: Session, viewer: User) -> list[dict]:
    _seed(db, viewer.org_id)
    rows = db.scalars(select(ErpBillSeries).where(ErpBillSeries.org_id == viewer.org_id)
                      .order_by(ErpBillSeries.transaction, ErpBillSeries.created_at))
    return [_out(r) for r in rows]


def save_series(
    db: Session, viewer: User, payload: S.BillSeriesIn, row_id: uuid.UUID | None = None, request: Request | None = None,
) -> dict:
    require(viewer, "can_manage_erp_masters")
    _seed(db, viewer.org_id)
    if payload.transaction not in KEYS:
        raise ErpError("bad_transaction", "Unknown transaction.", 422)
    row = (get_owned(db, ErpBillSeries, viewer.org_id, row_id, "bill series")
           if row_id else ErpBillSeries(org_id=viewer.org_id, transaction=payload.transaction))
    if row_id and row.transaction != payload.transaction:
        raise ErpError("bad_transaction", "A series cannot move to another transaction.", 422)
    name = payload.name.strip()
    clash = db.scalar(select(ErpBillSeries).where(
        ErpBillSeries.org_id == viewer.org_id, ErpBillSeries.transaction == row.transaction,
        func.lower(ErpBillSeries.name) == name.lower(), *([ErpBillSeries.id != row.id] if row_id else [])))
    if clash is not None:
        raise ErpError("duplicate", f"There is already a series called \u201c{clash.name}\u201d here.", 409)
    if row_id and payload.next_number < row.next_number:
        raise ErpError("next_only_forward", f"The next number can only move forward \u2014 it is already {row.next_number}.", 422)
    others = list(db.scalars(select(ErpBillSeries).where(
        ErpBillSeries.org_id == viewer.org_id, ErpBillSeries.transaction == row.transaction,
        *([ErpBillSeries.id != row.id] if row_id else []))))
    make_default = payload.is_default or not any(o.is_default for o in others)  # a transaction always has a default
    if make_default and not payload.is_active:
        raise ErpError("default_inactive", "The default series cannot be inactive. Make another series the default first.", 422)
    row.name, row.used_for = name, (payload.used_for or "").strip() or None
    row.prefix, row.suffix, row.digits, row.restart = payload.prefix, payload.suffix, payload.digits, payload.restart
    row.next_number, row.applicable_from = payload.next_number, payload.applicable_from
    row.print_title = (payload.print_title or "").strip() or None
    row.default_groups = list(dict.fromkeys(g.strip() for g in payload.default_groups if g.strip()))
    wanted = list(dict.fromkeys(payload.user_ids))
    if wanted:
        found = set(db.scalars(select(User.id).where(User.org_id == viewer.org_id, User.id.in_(wanted))))
        if len(found) != len(wanted):
            raise ErpError("bad_user", "One of the chosen people is not in this company.", 422)
    row.user_ids = [str(u) for u in wanted]
    row.billing_type, row.paper = payload.billing_type, payload.paper
    row.print_layout = (payload.print_layout or "").strip() or None
    row.is_default, row.is_active = make_default, payload.is_active
    for o in others:
        if make_default:
            o.is_default = False
        # A party group starts on one series per transaction: claiming it takes it from the others.
        o.default_groups = [g for g in (o.default_groups or []) if g not in row.default_groups]
    db.add(row)
    db.flush()
    record_audit(db, viewer, "bill_series.saved", row, request=request, detail={"transaction": row.transaction, "name": name})
    db.commit()
    db.refresh(row)
    return _out(row)


def delete_series(db: Session, viewer: User, series_id: uuid.UUID, request: Request | None = None) -> None:
    require(viewer, "can_manage_erp_masters")
    row = get_owned(db, ErpBillSeries, viewer.org_id, series_id, "bill series")
    if row.issued:
        raise ErpError("series_issued", f"{row.issued} numbers have been issued from this series, so it cannot be deleted. Mark it inactive instead.", 409)
    siblings = db.scalar(select(func.count()).select_from(ErpBillSeries).where(
        ErpBillSeries.org_id == viewer.org_id, ErpBillSeries.transaction == row.transaction, ErpBillSeries.id != row.id))
    if not siblings:
        raise ErpError("last_series", "Every transaction needs at least one series.", 409)
    if row.is_default:
        raise ErpError("default_series", "Make another series the default first.", 409)
    record_audit(db, viewer, "bill_series.deleted", row, request=request, detail={"name": row.name})
    db.delete(row)
    db.commit()
