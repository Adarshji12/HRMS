"""India's states, union territories, districts and cities, for the CRM geography masters.

The list lives in ``app/data/india_geography.json`` (its ``source`` key says
where it came from and what was corrected). ``load_india`` adds whatever a
company does not already have — matching by name, case-insensitively — and
leaves everything it does have alone, so it is safe to run again after a new
district is created or after a company has renamed or deactivated its own.
"""

from __future__ import annotations

import json
import uuid
from functools import lru_cache
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.crm import CrmCity, CrmCountry, CrmDistrict, CrmState

_DATA = Path(__file__).resolve().parent.parent / "data" / "india_geography.json"


@lru_cache(maxsize=1)
def india() -> dict:
    return json.loads(_DATA.read_text(encoding="utf-8"))


#: District names an earlier copy of the list spelled differently. A company
#: that loaded that copy has these rows; they are renamed in place rather than
#: duplicated beside the corrected name.
_RENAMED: dict[str, dict[str, str]] = {
    "Odisha": {"Anugola": "Angul", "Baleshwar": "Balasore", "Baragada": "Bargarh",
               "Debagada": "Deogarh", "Kandhamala": "Kandhamal", "Kataka": "Cuttack",
               "Kendrapada": "Kendrapara", "Kendujhar": "Keonjhar", "Nayagada": "Nayagarh",
               "Sundaragada": "Sundargarh"},
    "Jharkhand": {"East Singhbum": "East Singhbhum"},
    "Madhya Pradesh": {"MAUGANJ": "Mauganj"},
    "Punjab": {"S.A.S Nagar": "SAS Nagar (Mohali)"},
    "Chhattisgarh": {"Manendragarh-Chirmiri-Bharatpur(M C B)": "Manendragarh-Chirmiri-Bharatpur"},
}


def _key(name: str) -> str:
    return " ".join(name.lower().split())


def load_india(db: Session, org_id: uuid.UUID) -> dict[str, int]:
    """Add India, its 36 states and union territories, their districts and cities.

    Each city is placed under its district. A city the company already has in
    that state — by name — is left as it is, district and all.

    Flushes but does not commit. Returns how many of each were added.
    """
    country = db.scalar(
        select(CrmCountry).where(CrmCountry.org_id == org_id, CrmCountry.iso2 == "IN")
    ) or db.scalar(
        select(CrmCountry).where(CrmCountry.org_id == org_id, CrmCountry.name.ilike("india"))
    )
    added = {"countries": 0, "states": 0, "districts": 0, "cities": 0}
    if country is None:
        country = CrmCountry(org_id=org_id, name="India", iso2="IN", dial_code="+91")
        db.add(country)
        db.flush()
        added["countries"] = 1

    states = {
        _key(s.name): s
        for s in db.scalars(select(CrmState).where(CrmState.org_id == org_id)).all()
    }
    for entry in india()["states"]:
        state = states.get(_key(entry["name"]))
        if state is None:
            state = CrmState(org_id=org_id, country_id=country.id, name=entry["name"],
                             gst_code=entry["gst_code"])
            db.add(state)
            db.flush()
            states[_key(entry["name"])] = state
            added["states"] += 1
        elif not state.gst_code:
            state.gst_code = entry["gst_code"]

        districts = {
            _key(d.name): d
            for d in db.scalars(
                select(CrmDistrict).where(CrmDistrict.org_id == org_id, CrmDistrict.state_id == state.id)
            ).all()
        }
        for old, new in _RENAMED.get(entry["name"], {}).items():
            row = districts.get(_key(old))
            if row is not None and _key(new) not in districts:
                row.name = new
                districts[_key(new)] = districts.pop(_key(old))
                added.setdefault("renamed", 0)
                added["renamed"] += 1
        for name in entry["districts"]:
            if _key(name) not in districts:
                row = CrmDistrict(org_id=org_id, state_id=state.id, name=name)
                db.add(row)
                districts[_key(name)] = row
                added["districts"] += 1
        db.flush()

        cities = {
            _key(c.name)
            for c in db.scalars(
                select(CrmCity).where(CrmCity.org_id == org_id, CrmCity.state_id == state.id)
            ).all()
        }
        for city in entry.get("cities", []):
            if _key(city["name"]) in cities:
                continue
            district = districts.get(_key(city["district"])) if city.get("district") else None
            db.add(CrmCity(org_id=org_id, state_id=state.id, name=city["name"],
                           district_id=district.id if district else None))
            cities.add(_key(city["name"]))
            added["cities"] += 1
    db.flush()
    return added
