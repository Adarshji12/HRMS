"""Receipt and payment vouchers: balanced debit and credit lines posted to ledgers.

A voucher must balance (total debits equal total credits), carry a number from its own yearly series
(``RCP/26-27/0001``, ``PAY/26-27/0001``) and can be cancelled but never edited into a different amount: the
book keeps the cancelled row, marked, so a number is never reused. A ledger's balance is its opening balance
plus every posted voucher line.
"""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal

from fastapi import Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import User
from app.models.erp import ErpLedger, ErpVoucher, ErpVoucherLine
from app.schemas import erp as S
from app.services.erp.common import (
    ZERO, ErpError, get_owned, next_number, peek_number, record_audit, require, require_reason, user_names,
)

PREFIX = {"receipt": "RCP", "payment": "PAY"}
CENT = Decimal("0.01")


def _kind(voucher_type: str) -> str:
    if voucher_type not in PREFIX:
        raise ErpError("bad_type", "A voucher is a receipt or a payment.")
    return voucher_type


def _balance(opening: Decimal, opening_type: str, debit: Decimal, credit: Decimal) -> tuple[str, str]:
    signed = (opening if opening_type == "dr" else -opening) + (debit or ZERO) - (credit or ZERO)
    return str(abs(signed).quantize(CENT)), "dr" if signed >= 0 else "cr"


def ledger_balance(db: Session, viewer: User, ledger_id: uuid.UUID) -> dict:
    """What the ledger stands at now: its opening balance and every posted voucher line."""
    ledger = get_owned(db, ErpLedger, viewer.org_id, ledger_id, "ledger")
    debit, credit = db.execute(
        select(func.coalesce(func.sum(ErpVoucherLine.debit), 0), func.coalesce(func.sum(ErpVoucherLine.credit), 0))
        .join(ErpVoucher, ErpVoucher.id == ErpVoucherLine.voucher_id)
        .where(ErpVoucherLine.ledger_id == ledger.id, ErpVoucher.status == "posted")
    ).one()
    amount, side = _balance(ledger.opening_balance or ZERO, ledger.opening_type, Decimal(debit), Decimal(credit))
    return {"ledger_id": str(ledger.id), "name": ledger.name, "balance": amount, "side": side}


def _money(value) -> str:
    return str(Decimal(value or 0).quantize(CENT))


def _party_side(voucher_type: str) -> str:
    """The side the party sits on: a receipt credits the payer, a payment debits the payee."""
    return "cr" if voucher_type == "receipt" else "dr"


def _row(db: Session, v: ErpVoucher, names: dict[uuid.UUID, str]) -> dict:
    ids = {ln.ledger_id for ln in v.lines}
    ledgers = {l.id: l for l in db.scalars(select(ErpLedger).where(ErpLedger.id.in_(ids)))}
    side = _party_side(v.voucher_type)
    party = [ledgers[ln.ledger_id].name for ln in v.lines if ln.entry == side]
    return {
        "id": str(v.id), "voucher_type": v.voucher_type, "number": v.number,
        "voucher_date": v.voucher_date.isoformat(),
        "party": ", ".join(dict.fromkeys(party)) or "-",
        "narration": v.narration, "amount": _money(v.amount), "status": v.status,
        "debit": _money(v.amount) if side == "dr" else "0.00",
        "credit": _money(v.amount) if side == "cr" else "0.00",
        "entered_at": v.created_at.isoformat() if v.created_at else None,
        "entered_by": names.get(v.created_by) if v.created_by else None,
        "cancel_reason": v.cancel_reason,
        "postings": [
            {
                "ledger_id": str(ln.ledger_id), "ledger": ledgers[ln.ledger_id].name,
                "station": ledgers[ln.ledger_id].station, "entry": ln.entry,
                "debit": _money(ln.debit), "credit": _money(ln.credit), "narration": ln.narration,
            }
            for ln in v.lines
        ],
    }


def list_vouchers(
    db: Session, viewer: User, voucher_type: str, *, start: date | None = None, end: date | None = None,
) -> list[dict]:
    _kind(voucher_type)
    stmt = select(ErpVoucher).where(ErpVoucher.org_id == viewer.org_id, ErpVoucher.voucher_type == voucher_type)
    if start:
        stmt = stmt.where(ErpVoucher.voucher_date >= start)
    if end:
        stmt = stmt.where(ErpVoucher.voucher_date <= end)
    rows = db.scalars(stmt.order_by(ErpVoucher.voucher_date.desc(), ErpVoucher.created_at.desc())).all()
    names = user_names(db, viewer.org_id, [r.created_by for r in rows])
    return [_row(db, r, names) for r in rows]


def get_voucher(db: Session, viewer: User, voucher_id: uuid.UUID) -> dict:
    v = get_owned(db, ErpVoucher, viewer.org_id, voucher_id, "voucher")
    return _row(db, v, user_names(db, viewer.org_id, [v.created_by]))


def next_voucher_number(db: Session, viewer: User, voucher_type: str, on: date) -> dict:
    return {"number": peek_number(db, viewer.org_id, PREFIX[_kind(voucher_type)], on)}


def create_voucher(
    db: Session, viewer: User, voucher_type: str, payload: S.VoucherIn, request: Request | None = None,
) -> dict:
    require(viewer, "can_manage_billing")
    _kind(voucher_type)
    ids = {ln.ledger_id for ln in payload.lines}
    found = {
        l.id for l in db.scalars(select(ErpLedger).where(ErpLedger.org_id == viewer.org_id, ErpLedger.id.in_(ids)))
    }
    if found != ids:
        raise ErpError("bad_ledger", "One of the ledgers on this voucher does not exist.")
    debit = sum((ln.amount for ln in payload.lines if ln.entry == "dr"), ZERO)
    credit = sum((ln.amount for ln in payload.lines if ln.entry == "cr"), ZERO)
    if debit == 0 or credit == 0:
        raise ErpError("one_sided", "A voucher needs at least one debit line and one credit line.")
    if debit != credit:
        raise ErpError("unbalanced", f"Debits ({debit}) and credits ({credit}) must be equal.")
    voucher = ErpVoucher(
        org_id=viewer.org_id, voucher_type=voucher_type, voucher_date=payload.voucher_date,
        number=next_number(db, viewer.org_id, PREFIX[voucher_type], payload.voucher_date),
        narration=payload.narration, amount=debit, created_by=viewer.id,
    )
    for order, ln in enumerate(payload.lines):
        voucher.lines.append(ErpVoucherLine(
            ledger_id=ln.ledger_id, sort_order=order, entry=ln.entry, narration=ln.narration,
            debit=ln.amount if ln.entry == "dr" else ZERO, credit=ln.amount if ln.entry == "cr" else ZERO,
        ))
    db.add(voucher)
    db.flush()
    record_audit(db, viewer, f"voucher.{voucher_type}.created", voucher, request=request, detail={"amount": str(debit)})
    db.commit()
    return get_voucher(db, viewer, voucher.id)


def cancel_voucher(
    db: Session, viewer: User, voucher_id: uuid.UUID, reason: str | None, request: Request | None = None,
) -> dict:
    require(viewer, "can_manage_billing")
    v = get_owned(db, ErpVoucher, viewer.org_id, voucher_id, "voucher")
    if v.status == "cancelled":
        raise ErpError("already_cancelled", "This voucher is already cancelled.", 409)
    v.cancel_reason = require_reason(reason, "voucher is being cancelled")
    v.status = "cancelled"
    record_audit(db, viewer, f"voucher.{v.voucher_type}.cancelled", v, request=request, detail={"reason": v.cancel_reason})
    db.commit()
    return get_voucher(db, viewer, v.id)
