"""Stations: the towns a ledger can be at, kept in the geography master.

A station is a city of the geography master. This is the ERP's view of it: how many ledgers each
town has, whether it came with the standard India list or was added by the company, and a delete
that refuses while a ledger is at the town.
"""

from __future__ import annotations

import uuid

from fastapi import Request
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import User
from app.models.crm import CrmCity, CrmDistrict, CrmState
from app.models.erp import ErpLedger
from app.schemas import erp as S
from app.services import crm as crm_svc
from app.services import crm_geography
from app.services.erp.common import ErpError, record_audit, require


def _key(name: str) -> str:
    return " ".join((name or "").lower().split())


def _standard() -> set[tuple[str, str]]:
    """(state, city) pairs that came with the standard India list."""
    return {(_key(st["name"]), _key(c["name"])) for st in crm_geography.india()["states"] for c in st.get("cities", [])}


def _row(c: CrmCity, state: CrmState | None, district: CrmDistrict | None, ledgers: int, standard: set[tuple[str, str]]) -> dict:
    return {
        "id": str(c.id), "name": c.name, "state_id": str(c.state_id), "state_name": state.name if state else None,
        "district_id": str(c.district_id) if c.district_id else None, "district_name": district.name if district else None,
        "pincode": c.pincode, "is_active": c.is_active, "ledgers": ledgers,
        "source": "standard" if (_key(state.name if state else ""), _key(c.name)) in standard else "custom",
    }


def list_stations(db: Session, viewer: User) -> list[dict]:
    counts = {k: n for k, n in db.execute(
        select(func.lower(func.trim(ErpLedger.station)), func.count()).where(
            ErpLedger.org_id == viewer.org_id, ErpLedger.station.is_not(None)).group_by(func.lower(func.trim(ErpLedger.station)))).all() if k}
    standard = _standard()
    rows = db.execute(
        select(CrmCity, CrmState, CrmDistrict).join(CrmState, CrmState.id == CrmCity.state_id)
        .outerjoin(CrmDistrict, CrmDistrict.id == CrmCity.district_id)
        .where(CrmCity.org_id == viewer.org_id).order_by(func.lower(CrmCity.name))).all()
    return [_row(c, st, d, counts.get(_key(c.name), 0), standard) for c, st, d in rows]


def save_station(
    db: Session, viewer: User, payload: S.StationIn, row_id: uuid.UUID | None = None, request: Request | None = None,
) -> dict:
    require(viewer, "can_manage_erp_masters")
    state = db.scalar(select(CrmState).where(CrmState.org_id == viewer.org_id, CrmState.id == payload.state_id))
    if state is None:
        raise ErpError("bad_state", "Choose a state from the list.", 422)
    district = None
    if payload.district_id:
        district = db.scalar(select(CrmDistrict).where(CrmDistrict.org_id == viewer.org_id, CrmDistrict.id == payload.district_id))
        if district is None or district.state_id != state.id:
            raise ErpError("bad_district", "That district is not in the chosen state.", 422)
    if row_id:
        row = db.scalar(select(CrmCity).where(CrmCity.org_id == viewer.org_id, CrmCity.id == row_id))
        if row is None:
            raise ErpError("not_found", "Station not found.", 404)
    else:
        row = CrmCity(org_id=viewer.org_id)
    name = payload.name.strip()
    clash = db.scalar(select(CrmCity).where(
        CrmCity.org_id == viewer.org_id, CrmCity.state_id == state.id, func.lower(CrmCity.name) == name.lower(),
        *([CrmCity.id != row.id] if row_id else [])))
    if clash is not None:
        raise ErpError("duplicate", f"“{clash.name}” is already a station in {state.name}.", 409)
    renamed_from = row.name if row_id and row.name != name else None
    row.name, row.state_id, row.district_id, row.pincode = name, state.id, district.id if district else None, payload.pincode
    db.add(row)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise ErpError("duplicate", f"\u201c{name}\u201d is already a station in {state.name}.", 409) from None
    if renamed_from:
        # A ledger names its station by text, so it follows the rename.
        for l in db.scalars(select(ErpLedger).where(ErpLedger.org_id == viewer.org_id, func.lower(ErpLedger.station) == renamed_from.lower())):
            l.station = name
    record_audit(db, viewer, "station.saved", row, request=request, detail={"name": name, "state": state.name})
    db.commit()
    db.refresh(row)
    count = db.scalar(select(func.count()).select_from(ErpLedger).where(
        ErpLedger.org_id == viewer.org_id, func.lower(ErpLedger.station) == name.lower())) or 0
    return _row(row, state, district, count, _standard())


def delete_station(db: Session, viewer: User, station_id: uuid.UUID, request: Request | None = None) -> None:
    require(viewer, "can_manage_erp_masters")
    row = db.scalar(select(CrmCity).where(CrmCity.org_id == viewer.org_id, CrmCity.id == station_id))
    if row is None:
        raise ErpError("not_found", "Station not found.", 404)
    used = db.scalar(select(func.count()).select_from(ErpLedger).where(
        ErpLedger.org_id == viewer.org_id, func.lower(ErpLedger.station) == row.name.lower())) or 0
    if used:
        raise ErpError("station_in_use", f"{used} ledger{'s are' if used != 1 else ' is'} at {row.name}, so it cannot be deleted.", 409)
    record_audit(db, viewer, "station.deleted", row, request=request, detail={"name": row.name})
    # Leads and customers that point at the town refuse the delete, as they do on the City Master.
    crm_svc.delete_master(db, viewer.org_id, "cities", station_id)
