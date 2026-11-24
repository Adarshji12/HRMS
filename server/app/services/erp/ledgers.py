"""Ledgers: a party's own account in the books.

Only the master exists so far: nothing posts to a ledger, so its balance is its
opening balance. A ledger is deactivated, not deleted, once anything points at
it; nothing does yet, so delete is allowed.
"""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal

from fastapi import Request
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import User
from app.models.erp import ErpAccountGroup, ErpLedger
from app.schemas import erp as S
from app.services.erp.common import ErpError, get_owned, next_number, record_audit, require, row_dict


def _out(row: ErpLedger) -> dict:
    out = row_dict(row)
    balance = row.opening_balance or 0
    out["balance"] = str(balance)
    out["balance_type"] = row.opening_type
    return out


def list_ledgers(db: Session, viewer: User, *, q: str | None = None, active: bool | None = None) -> list[dict]:
    stmt = select(ErpLedger).where(ErpLedger.org_id == viewer.org_id)
    if active is not None:
        stmt = stmt.where(ErpLedger.is_active == active)
    if q and q.strip():
        like = f"%{q.strip().lower()}%"
        stmt = stmt.where(or_(
            func.lower(ErpLedger.name).like(like), func.lower(ErpLedger.code).like(like),
            func.lower(func.coalesce(ErpLedger.station, "")).like(like),
            func.lower(func.coalesce(ErpLedger.mobile, "")).like(like),
            func.lower(func.coalesce(ErpLedger.gstin, "")).like(like),
        ))
    return [_out(r) for r in db.scalars(stmt.order_by(func.lower(ErpLedger.name)))]


def get_ledger(db: Session, viewer: User, ledger_id: uuid.UUID) -> dict:
    return _out(get_owned(db, ErpLedger, viewer.org_id, ledger_id, "ledger"))


def save_ledger(
    db: Session, viewer: User, payload: S.LedgerIn, row_id: uuid.UUID | None = None,
    request: Request | None = None,
) -> dict:
    require(viewer, "can_manage_erp_masters")
    row = (
        get_owned(db, ErpLedger, viewer.org_id, row_id, "ledger")
        if row_id else ErpLedger(org_id=viewer.org_id, created_by=viewer.id)
    )
    clash = db.scalar(select(ErpLedger).where(
        ErpLedger.org_id == viewer.org_id,
        func.lower(ErpLedger.name) == payload.name.strip().lower(),
        *([ErpLedger.id != row.id] if row_id else []),
    ))
    if clash is not None:
        raise ErpError("duplicate_ledger", f"A ledger named \u201c{clash.name}\u201d already exists ({clash.code}).", 409)
    data = payload.model_dump()
    code = (data.pop("code") or "").strip().upper()
    data["name"] = data["name"].strip()
    if not row_id:
        row.code = code or next_number(db, viewer.org_id, "LED", date.today()).replace("/", "-")
    elif code:
        row.code = code
    for field, value in data.items():
        setattr(row, field, value)
    db.add(row)
    db.flush()
    record_audit(db, viewer, "ledger.saved", row, request=request, detail={"code": row.code})
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise ErpError("duplicate", "That ledger code is already used.", 409) from None
    db.refresh(row)
    return _out(row)


def delete_ledger(db: Session, viewer: User, ledger_id: uuid.UUID, request: Request | None = None) -> None:
    require(viewer, "can_manage_erp_masters")
    row = get_owned(db, ErpLedger, viewer.org_id, ledger_id, "ledger")
    record_audit(db, viewer, "ledger.deleted", row, request=request, detail={"code": row.code})
    db.delete(row)
    db.commit()


# --------------------------------------------------------------------------- #
# Account groups
# --------------------------------------------------------------------------- #

#: (name, parent) in tree order. Parents come before their children.
STANDARD_GROUPS: list[tuple[str, str | None]] = [
    ("Assets", None),
    ("Current Assets", "Assets"),
    ("Cash & Bank", "Current Assets"),
    ("Bank Accounts", "Cash & Bank"),
    ("Cash-in-hand", "Cash & Bank"),
    ("Sundry Debtors", "Current Assets"),
    ("Stock-in-hand", "Current Assets"),
    ("Input Tax Credit", "Current Assets"),
    ("Deposits (Asset)", "Current Assets"),
    ("Loans & Advances (Asset)", "Current Assets"),
    ("Fixed Assets", "Assets"),
    ("Investments", "Assets"),
    ("Misc. Expenses (Asset)", "Assets"),
    ("Liabilities", None),
    ("Current Liabilities", "Liabilities"),
    ("Sundry Creditors", "Current Liabilities"),
    ("Output Tax", "Current Liabilities"),
    ("Duties & Taxes Payable", "Current Liabilities"),
    ("Provisions", "Current Liabilities"),
    ("Loans & Borrowings", "Liabilities"),
    ("Bank OCC A/C", "Loans & Borrowings"),
    ("Secured Loans", "Loans & Borrowings"),
    ("Unsecured Loans", "Loans & Borrowings"),
    ("Suspense Account", "Liabilities"),
    ("Branch / Divisions", "Liabilities"),
    ("Equity", None),
    ("Capital Account", "Equity"),
    ("Reserves & Surplus", "Equity"),
    ("Income", None),
    ("Direct Income", "Income"),
    ("Sales Account", "Income"),
    ("Indirect Income", "Income"),
    ("Expenses", None),
    ("Direct Expenses", "Expenses"),
    ("Indirect Expenses", "Expenses"),
    ("Purchase Account", "Expenses"),
]


def _seed_groups(db: Session, org_id: uuid.UUID) -> None:
    if db.scalar(select(func.count()).select_from(ErpAccountGroup).where(ErpAccountGroup.org_id == org_id)):
        return
    made: dict[str, ErpAccountGroup] = {}
    for order, (name, parent) in enumerate(STANDARD_GROUPS):
        row = ErpAccountGroup(
            org_id=org_id, name=name, is_system=True, sort_order=order,
            parent_id=made[parent].id if parent else None,
        )
        db.add(row)
        db.flush()
        made[name] = row
    db.commit()


def _ordered(db: Session, org_id: uuid.UUID) -> list[tuple[ErpAccountGroup, int]]:
    """Every group in tree order, with its depth. Archived ones included."""
    rows = list(db.scalars(select(ErpAccountGroup).where(ErpAccountGroup.org_id == org_id)
                           .order_by(ErpAccountGroup.sort_order, func.lower(ErpAccountGroup.name))))
    children: dict[uuid.UUID | None, list[ErpAccountGroup]] = {}
    for r in rows:
        children.setdefault(r.parent_id, []).append(r)
    out: list[tuple[ErpAccountGroup, int]] = []

    def walk(parent: uuid.UUID | None, depth: int) -> None:
        for r in children.get(parent, []):
            out.append((r, depth))
            walk(r.id, depth + 1)

    walk(None, 0)
    return out


def _next_code(siblings: list[str], parent_code: str | None, top_index: int = 0) -> str:
    """The next free code under a parent: 1000 -> 1100 -> 1110 -> 1111."""
    if not parent_code or not parent_code.isdigit():
        return str((top_index + 1) * 1000)
    base = int(parent_code)
    step = 100 if base % 1000 == 0 else 10 if base % 100 == 0 else 1
    taken = [int(c) for c in siblings if c and c.isdigit() and int(c) > base]
    return str((max(taken) if taken else base) + step)


def _fill_codes(db: Session, org_id: uuid.UUID) -> None:
    """Give a code to every group that has none, walking the tree top-down."""
    ordered = _ordered(db, org_id)
    if all(r.code for r, _ in ordered):
        return
    by_id = {r.id: r for r, _ in ordered}
    tops = 0
    for r, _ in ordered:
        if r.code:
            if r.parent_id is None:
                tops += 1
            continue
        if r.parent_id is None:
            r.code = str((tops + 1) * 1000)
            tops += 1
        else:
            sibs = [c.code for c, _ in ordered if c.parent_id == r.parent_id and c.code]
            r.code = _next_code(sibs, by_id[r.parent_id].code)
        db.flush()
    db.commit()


def list_account_groups(db: Session, viewer: User) -> list[dict]:
    """Every live group in tree order, each with its depth."""
    _seed_groups(db, viewer.org_id)
    _fill_codes(db, viewer.org_id)
    return [{"id": str(r.id), "name": r.name, "code": r.code, "parent_id": str(r.parent_id) if r.parent_id else None,
             "depth": d, "is_system": r.is_system}
            for r, d in _ordered(db, viewer.org_id) if not r.is_archived]


def account_tree(db: Session, viewer: User, *, archived: bool = False) -> dict:
    """The chart of accounts: groups with codes, the ledgers under them, and balances rolled up.

    A balance is signed: debit positive, credit negative. A group's is the sum of
    everything beneath it.
    """
    _seed_groups(db, viewer.org_id)
    _fill_codes(db, viewer.org_id)
    ordered = _ordered(db, viewer.org_id)
    by_name = {r.name.lower(): r for r, _ in ordered}
    by_name["sundry debtors & creditors"] = by_name.get("sundry debtors", ordered[0][0])
    rows = list(db.scalars(select(ErpLedger).where(ErpLedger.org_id == viewer.org_id).order_by(func.lower(ErpLedger.name))))
    own: dict[uuid.UUID, int] = {}
    own_balance: dict[uuid.UUID, Decimal] = {}
    ledgers: list[dict] = []
    for l in rows:
        grp = by_name.get((l.account_group or "").lower())
        signed = (l.opening_balance or Decimal(0)) * (1 if l.opening_type == "dr" else -1)
        if grp is not None and (archived or l.is_active):
            own[grp.id] = own.get(grp.id, 0) + 1
            own_balance[grp.id] = own_balance.get(grp.id, Decimal(0)) + (signed if l.is_active else Decimal(0))
        if archived or l.is_active:
            ledgers.append({"id": str(l.id), "name": l.name, "code": l.code, "group_id": str(grp.id) if grp else None,
                            "balance": str(signed), "is_active": l.is_active, "account_group": l.account_group})
    ids = {r.id: r for r, _ in ordered}
    rolled: dict[uuid.UUID, Decimal] = {gid: v for gid, v in own_balance.items()}
    counts: dict[uuid.UUID, int] = dict(own)
    for r, _ in reversed(ordered):
        if r.parent_id in ids:
            rolled[r.parent_id] = rolled.get(r.parent_id, Decimal(0)) + rolled.get(r.id, Decimal(0))
            counts[r.parent_id] = counts.get(r.parent_id, 0) + counts.get(r.id, 0)
    groups = [
        {"id": str(r.id), "name": r.name, "code": r.code, "parent_id": str(r.parent_id) if r.parent_id else None,
         "depth": d, "is_system": r.is_system, "is_archived": r.is_archived,
         "balance": str(rolled.get(r.id, Decimal(0))), "accounts": counts.get(r.id, 0)}
        for r, d in ordered if archived or not r.is_archived
    ]
    totals = {r.name.lower(): {"balance": str(rolled.get(r.id, Decimal(0))), "accounts": counts.get(r.id, 0)}
              for r, d in ordered if d == 0}
    return {"groups": groups, "ledgers": ledgers, "totals": totals}


def update_account_group(
    db: Session, viewer: User, group_id: uuid.UUID, payload: S.AccountGroupEdit, request: Request | None = None,
) -> dict:
    """Rename or renumber a group. A standard group may be renamed too — the books find
    it by its place in the tree, not by its name."""
    require(viewer, "can_manage_erp_masters")
    row = get_owned(db, ErpAccountGroup, viewer.org_id, group_id, "group")
    name = payload.name.strip()
    clash = db.scalar(select(ErpAccountGroup).where(
        ErpAccountGroup.org_id == viewer.org_id, func.lower(ErpAccountGroup.name) == name.lower(), ErpAccountGroup.id != row.id))
    if clash is not None:
        raise ErpError("duplicate_group", f"\u201c{name}\u201d is already an account group.", 409)
    code = (payload.code or "").strip() or row.code
    if code and db.scalar(select(ErpAccountGroup).where(
        ErpAccountGroup.org_id == viewer.org_id, ErpAccountGroup.code == code, ErpAccountGroup.id != row.id)):
        raise ErpError("duplicate_code", f"The code {code} is already used by another group.", 409)
    if name != row.name:
        # Ledgers name their group by text, so they follow the rename.
        for l in db.scalars(select(ErpLedger).where(ErpLedger.org_id == viewer.org_id, ErpLedger.account_group == row.name)):
            l.account_group = name
    row.name, row.code = name, code
    record_audit(db, viewer, "account_group.updated", row, request=request, detail={"name": name, "code": code})
    db.commit()
    return {"id": str(row.id), "name": row.name, "code": row.code}


def archive_account_group(
    db: Session, viewer: User, group_id: uuid.UUID, archived: bool, request: Request | None = None,
) -> None:
    require(viewer, "can_manage_erp_masters")
    row = get_owned(db, ErpAccountGroup, viewer.org_id, group_id, "group")
    if archived and row.is_system:
        raise ErpError("system_group", "A standard account group cannot be archived.", 409)
    if archived:
        live_children = db.scalar(select(func.count()).select_from(ErpAccountGroup).where(
            ErpAccountGroup.parent_id == row.id, ErpAccountGroup.is_archived.is_(False)))
        live_ledgers = db.scalar(select(func.count()).select_from(ErpLedger).where(
            ErpLedger.org_id == viewer.org_id, ErpLedger.account_group == row.name, ErpLedger.is_active.is_(True)))
        if live_children or live_ledgers:
            raise ErpError("group_in_use", "Archive or move what sits under this group first.", 409)
    row.is_archived = archived
    record_audit(db, viewer, "account_group.archived" if archived else "account_group.restored", row, request=request)
    db.commit()


def save_openings(db: Session, viewer: User, payload: S.OpeningsIn, request: Request | None = None) -> dict:
    """Set the opening balance of many ledgers at once, from the Ledger Openings grid."""
    require(viewer, "can_manage_erp_masters")
    wanted = {r.id: r for r in payload.rows}
    rows = list(db.scalars(select(ErpLedger).where(ErpLedger.org_id == viewer.org_id, ErpLedger.id.in_(list(wanted)))))
    if len(rows) != len(wanted):
        raise ErpError("bad_ledger", "One of the ledgers is not in this company.", 422)
    changed = 0
    for row in rows:
        r = wanted[row.id]
        if row.opening_balance != r.opening_balance or row.opening_type != r.opening_type:
            row.opening_balance, row.opening_type = r.opening_balance, r.opening_type
            changed += 1
    if changed:
        record_audit(db, viewer, "ledger.openings_set", rows[0], request=request, detail={"ledgers": changed})
    db.commit()
    return {"updated": changed}


def set_ledger_active(db: Session, viewer: User, ledger_id: uuid.UUID, active: bool, request: Request | None = None) -> dict:
    require(viewer, "can_manage_erp_masters")
    row = get_owned(db, ErpLedger, viewer.org_id, ledger_id, "ledger")
    row.is_active = active
    record_audit(db, viewer, "ledger.restored" if active else "ledger.archived", row, request=request)
    db.commit()
    db.refresh(row)
    return _out(row)


def create_account_group(db: Session, viewer: User, payload: S.AccountGroupIn, request: Request | None = None) -> dict:
    require(viewer, "can_manage_erp_masters")
    _seed_groups(db, viewer.org_id)
    parent = get_owned(db, ErpAccountGroup, viewer.org_id, payload.parent_id, "group")
    name = payload.name.strip()
    if db.scalar(select(ErpAccountGroup).where(
        ErpAccountGroup.org_id == viewer.org_id, func.lower(ErpAccountGroup.name) == name.lower(),
    )):
        raise ErpError("duplicate_group", f"\u201c{name}\u201d is already an account group.", 409)
    _fill_codes(db, viewer.org_id)
    siblings = list(db.scalars(select(ErpAccountGroup.code).where(
        ErpAccountGroup.org_id == viewer.org_id, ErpAccountGroup.parent_id == parent.id)))
    chosen = (payload.code or "").strip()
    if chosen and db.scalar(select(ErpAccountGroup).where(
        ErpAccountGroup.org_id == viewer.org_id, ErpAccountGroup.code == chosen)):
        raise ErpError("duplicate_code", f"The code {chosen} is already used by another group.", 409)
    row = ErpAccountGroup(org_id=viewer.org_id, name=name, parent_id=parent.id, sort_order=10_000,
                          code=chosen or _next_code([c for c in siblings if c], parent.code))
    db.add(row)
    db.flush()
    record_audit(db, viewer, "account_group.created", row, request=request, detail={"name": name})
    db.commit()
    return {"id": str(row.id), "name": row.name, "code": row.code, "parent_id": str(parent.id), "depth": 0, "is_system": False}


def delete_account_group(db: Session, viewer: User, group_id: uuid.UUID, request: Request | None = None) -> None:
    require(viewer, "can_manage_erp_masters")
    row = get_owned(db, ErpAccountGroup, viewer.org_id, group_id, "group")
    if row.is_system:
        raise ErpError("system_group", "A standard account group cannot be deleted.", 409)
    if db.scalar(select(func.count()).select_from(ErpAccountGroup).where(ErpAccountGroup.parent_id == row.id)):
        raise ErpError("group_has_children", "Other groups sit under this one, so it cannot be deleted.", 409)
    if db.scalar(select(func.count()).select_from(ErpLedger).where(
        ErpLedger.org_id == viewer.org_id, ErpLedger.account_group == row.name,
    )):
        raise ErpError("group_in_use", "Ledgers are under this group, so it cannot be deleted.", 409)
    record_audit(db, viewer, "account_group.deleted", row, request=request, detail={"name": row.name})
    db.delete(row)
    db.commit()
