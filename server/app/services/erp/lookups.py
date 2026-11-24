"""Inventory lookups: sub categories, units, HSN / SAC codes, racks and bill series."""

from __future__ import annotations

import uuid

from fastapi import Request
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models import User
from app.models.erp import ErpItem, ErpLookup
from app.schemas import erp as S
from app.services.erp.common import ErpError, get_owned, record_audit, require, row_dict

KINDS = {"subcategory", "unit", "hsn", "rack", "billseries"}

#: The GST Unit Quantity Codes a unit can report under in GSTR-1.
UQC = [
    "BAG", "BAL", "BDL", "BKL", "BOU", "BOX", "BTL", "BUN", "CAN", "CBM", "CCM", "CMS", "CTN", "DOZ", "DRM", "GGK",
    "GMS", "GRS", "GYD", "KGS", "KLR", "KME", "LTR", "MLT", "MTR", "MTS", "NOS", "OTH", "PAC", "PCS", "PRS", "QTL",
    "ROL", "SET", "SQF", "SQM", "SQY", "TBS", "TGM", "THD", "TON", "TUB", "UGS", "UNT", "YDS",
]

#: (code, name, UQC, decimals) -- the units every company starts with.
STANDARD_UNITS = [
    ("BAG", "Bags", "BAG", 0), ("BOX", "Box", "BOX", 0), ("DOZ", "Dozens", "DOZ", 0), ("GMS", "Grams", "GMS", 3),
    ("HRS", "Hours", "OTH", 2), ("KGS", "Kilograms", "KGS", 3), ("LTR", "Litres", "LTR", 3), ("MTR", "Metres", "MTR", 2),
    ("NOS", "Numbers", "NOS", 0), ("PAC", "Packs", "PAC", 0), ("PCS", "Pieces", "PCS", 0), ("SET", "Sets", "SET", 0),
]
LABEL = {"subcategory": "sub category", "unit": "unit", "hsn": "HSN / SAC code", "rack": "rack", "billseries": "bill series"}


def _check_kind(kind: str) -> None:
    if kind not in KINDS:
        raise ErpError("bad_kind", "Unknown list.", 404)


GST_MAX = 40


def _clean(kind: str, payload: S.LookupIn, name: str = "") -> dict:
    """Keep only the values this kind uses, and check them."""
    raw = payload.data or {}
    data: dict = {}
    if kind == "unit":
        uqc = str(raw.get("uqc") or "").upper()
        if uqc and uqc not in UQC:
            raise ErpError("bad_uqc", "Choose a GST unit quantity code from the list.", 422)
        try:
            decimals = int(raw.get("decimals", 0) or 0)
        except (TypeError, ValueError):
            raise ErpError("bad_decimals", "Decimals must be a whole number.", 422) from None
        if not 0 <= decimals <= 4:
            raise ErpError("bad_decimals", "Decimals must be between 0 and 4.", 422)
        data.update({"uqc": uqc or None, "decimals": decimals})
    elif kind == "hsn":
        try:
            gst = float(raw.get("gst", 0) or 0)
        except (TypeError, ValueError):
            raise ErpError("bad_gst", "GST % must be a number.", 422) from None
        if not 0 <= gst <= GST_MAX:
            raise ErpError("bad_gst", f"GST % must be between 0 and {GST_MAX}.", 422)
        # SAC codes (services) start with 99; everything else is an HSN (goods).
        kind_of = str(raw.get("type") or ("sac" if name.startswith("99") else "hsn")).lower()
        if kind_of not in ("hsn", "sac"):
            raise ErpError("bad_hsn_type", "Choose HSN (goods) or SAC (services).", 422)
        if (kind_of == "sac") != name.startswith("99"):
            raise ErpError("bad_hsn_type", "SAC codes (services) start with 99; HSN codes (goods) do not.", 422)
        uqc = "NA" if kind_of == "sac" else str(raw.get("uqc") or "").upper()
        if kind_of == "hsn":
            if not uqc:
                raise ErpError("uqc_needed", "Choose the unit quantity code GSTR-1 reports this under.", 422)
            if uqc not in UQC:
                raise ErpError("bad_uqc", "Choose a GST unit quantity code from the list.", 422)
        data.update({"gst": gst, "type": kind_of, "uqc": uqc, "short_name": str(raw.get("short_name") or "").strip()[:40] or None})
    elif kind == "billseries":
        kind_of = raw.get("type", "sale")
        if kind_of not in ("sale", "purchase", "sale_return", "purchase_return", "order"):
            raise ErpError("bad_series", "Choose what the series numbers.", 422)
        try:
            nxt = int(raw.get("next", 1) or 1)
        except (TypeError, ValueError):
            raise ErpError("bad_series", "The next number must be a whole number.", 422) from None
        if nxt < 1:
            raise ErpError("bad_series", "The next number must be 1 or more.", 422)
        data.update({"type": kind_of, "prefix": str(raw.get("prefix", "") or "")[:12], "next": nxt})
    return data


def _seed_units(db: Session, org_id: uuid.UUID) -> None:
    """The standard units, the first time a company opens the list."""
    if db.scalar(select(func.count()).select_from(ErpLookup).where(ErpLookup.org_id == org_id, ErpLookup.kind == "unit")):
        return
    for code, name, uqc, decimals in STANDARD_UNITS:
        db.add(ErpLookup(org_id=org_id, kind="unit", name=code, description=name, data={"uqc": uqc, "decimals": decimals}))
    db.commit()


def _item_counts(db: Session, org_id: uuid.UUID, kind: str) -> dict[str, int]:
    """How many items carry each unit or HSN, by the text the item stores."""
    if kind not in ("unit", "hsn", "rack"):
        return {}
    col = ErpItem.uom if kind == "unit" else ErpItem.hsn_sac if kind == "hsn" else ErpItem.rack
    return {k: n for k, n in db.execute(select(col, func.count()).where(ErpItem.org_id == org_id).group_by(col)).all() if k}


def list_lookups(db: Session, viewer: User, kind: str, *, q: str | None = None, active: bool | None = None) -> list[dict]:
    _check_kind(kind)
    if kind == "unit":
        _seed_units(db, viewer.org_id)
    stmt = select(ErpLookup).where(ErpLookup.org_id == viewer.org_id, ErpLookup.kind == kind)
    if active is not None:
        stmt = stmt.where(ErpLookup.is_active == active)
    if q and q.strip():
        like = f"%{q.strip().lower()}%"
        stmt = stmt.where(or_(
            func.lower(ErpLookup.name).like(like), func.lower(func.coalesce(ErpLookup.description, "")).like(like),
            func.lower(func.coalesce(ErpLookup.parent_name, "")).like(like),
        ))
    counts = _item_counts(db, viewer.org_id, kind)
    return [{**row_dict(r), "items": counts.get(r.name, 0)} for r in db.scalars(stmt.order_by(func.lower(ErpLookup.name)))]


def save_lookup(
    db: Session, viewer: User, kind: str, payload: S.LookupIn, row_id: uuid.UUID | None = None, request: Request | None = None,
) -> dict:
    _check_kind(kind)
    require(viewer, "can_manage_erp_masters")
    if kind == "unit":
        _seed_units(db, viewer.org_id)  # before the first row, so a first save does not skip the starter units
    row = (get_owned(db, ErpLookup, viewer.org_id, row_id, LABEL[kind])
           if row_id else ErpLookup(org_id=viewer.org_id, kind=kind))
    name = payload.name.strip()
    if kind == "hsn":
        name = name.replace(" ", "")
        if not name.isdigit() or not 2 <= len(name) <= 8:
            raise ErpError("bad_hsn", "An HSN / SAC code is 2 to 8 digits.", 422)
    clash = db.scalar(select(ErpLookup).where(
        ErpLookup.org_id == viewer.org_id, ErpLookup.kind == kind, func.lower(ErpLookup.name) == name.lower(),
        *([ErpLookup.id != row.id] if row_id else [])))
    if clash is not None:
        raise ErpError("duplicate", f"\u201c{name}\u201d is already on this list.", 409)
    if kind == "unit":
        name = name.upper().replace(" ", "")
        if not (payload.description or "").strip():
            raise ErpError("unit_name_needed", "Give the unit a name, such as Pieces.", 422)
    if kind in ("subcategory", "rack") and not (payload.parent_name or "").strip():
        raise ErpError("parent_needed", "Choose the category it belongs to." if kind == "subcategory" else "Choose the store it is in.", 422)
    renamed_from = row.name if row_id and row.name != name else None
    row.name = name
    row.description = (payload.description or "").strip() or None
    row.parent_name = (payload.parent_name or "").strip() or None
    row.data = _clean(kind, payload, name)
    row.is_active = payload.is_active
    if renamed_from and kind in ("unit", "hsn", "rack"):
        # An item names its unit, HSN and rack by text, so it follows the rename.
        col = ErpItem.uom if kind == "unit" else ErpItem.hsn_sac if kind == "hsn" else ErpItem.rack
        for it in db.scalars(select(ErpItem).where(ErpItem.org_id == viewer.org_id, col == renamed_from)):
            if kind == "unit":
                it.uom = name
            elif kind == "hsn":
                it.hsn_sac = name
            else:
                it.rack = name
    db.add(row)
    db.flush()
    record_audit(db, viewer, f"{kind}.saved", row, request=request, detail={"name": name})
    db.commit()
    db.refresh(row)
    return row_dict(row)


def delete_lookup(db: Session, viewer: User, kind: str, row_id: uuid.UUID, request: Request | None = None) -> None:
    _check_kind(kind)
    require(viewer, "can_manage_erp_masters")
    row = get_owned(db, ErpLookup, viewer.org_id, row_id, LABEL[kind])
    if kind in ("unit", "hsn", "rack"):
        col = ErpItem.uom if kind == "unit" else ErpItem.hsn_sac if kind == "hsn" else ErpItem.rack
        if db.scalar(select(func.count()).select_from(ErpItem).where(ErpItem.org_id == viewer.org_id, col == row.name)):
            raise ErpError("in_use", f"Items use \u201c{row.name}\u201d, so it cannot be deleted. Mark it inactive instead.", 409)
    record_audit(db, viewer, f"{kind}.deleted", row, request=request, detail={"name": row.name})
    db.delete(row)
    db.commit()
