"""India's states, union territories and districts in the CRM geography masters."""

from __future__ import annotations

from sqlalchemy import func, select

from app.db.session import SessionLocal
from app.models.crm import CrmCity, CrmDistrict, CrmState
from app.services.crm_geography import india, load_india


def _counts(org_id) -> tuple[int, int]:
    with SessionLocal() as db:
        states = db.scalar(select(func.count()).select_from(CrmState).where(CrmState.org_id == org_id))
        districts = db.scalar(select(func.count()).select_from(CrmDistrict).where(CrmDistrict.org_id == org_id))
    return states, districts


def test_the_data_file_covers_every_state_and_union_territory():
    data = india()["states"]
    assert len(data) == 36
    codes = [s["gst_code"] for s in data]
    assert len(set(codes)) == 36
    by_name = {s["name"]: s for s in data}
    assert by_name["Kerala"]["gst_code"] == "32" and len(by_name["Kerala"]["districts"]) == 14
    assert by_name["Uttar Pradesh"]["gst_code"] == "09" and len(by_name["Uttar Pradesh"]["districts"]) == 75
    assert {"Mahe", "Yanam", "Karaikal", "Puducherry"} <= set(by_name["Puducherry"]["districts"])
    assert sum(len(s["districts"]) for s in data) > 750
    # Every state has cities, and every city names one of its own state's districts.
    for s in data:
        assert s["cities"], s["name"]
        for city in s["cities"]:
            assert city["district"] in s["districts"], (s["name"], city)
    assert {"Kochi", "Thiruvananthapuram"} <= {c["name"] for c in by_name["Kerala"]["cities"]}
    assert ("Vijayawada", "NTR") in {(c["name"], c["district"]) for c in by_name["Andhra Pradesh"]["cities"]}
    assert ("Hyderabad", "Hyderabad") in {(c["name"], c["district"]) for c in by_name["Telangana"]["cities"]}


def test_loading_india_adds_everything_once(client, tenants):
    acme, _ = tenants
    response = client.post("/api/v1/crm/geography/india", headers=acme.headers())
    assert response.status_code == 200, response.text
    first = response.json()
    total = sum(len(s["districts"]) for s in india()["states"])
    assert first["districts"] == total

    states, districts = _counts(acme.id)
    assert states >= 36 and districts == total
    cities = sum(len(s["cities"]) for s in india()["states"])
    assert first["cities"] == cities
    with SessionLocal() as db:
        kochi = db.scalar(select(CrmCity).where(CrmCity.org_id == acme.id, CrmCity.name == "Kochi"))
        ernakulam = db.get(CrmDistrict, kochi.district_id)
    assert ernakulam.name == "Ernakulam"

    again = client.post("/api/v1/crm/geography/india", headers=acme.headers()).json()
    assert again == {"countries": 0, "states": 0, "districts": 0, "cities": 0}
    assert _counts(acme.id) == (states, districts)


def test_a_company_s_own_rows_are_kept(client, tenants):
    acme, _ = tenants
    with SessionLocal() as db:
        load_india(db, acme.id)
        kerala = db.scalar(select(CrmState).where(CrmState.org_id == acme.id, CrmState.name == "Kerala"))
        wayanad = db.scalar(select(CrmDistrict).where(CrmDistrict.state_id == kerala.id, CrmDistrict.name == "Wayanad"))
        wayanad.is_active = False
        db.add(CrmDistrict(org_id=acme.id, state_id=kerala.id, name="My Own Region"))
        db.commit()
        added = load_india(db, acme.id)
        db.commit()
        names = set(db.scalars(select(CrmDistrict.name).where(CrmDistrict.state_id == kerala.id)).all())
        still_off = db.scalar(select(CrmDistrict.is_active).where(CrmDistrict.id == wayanad.id))
    assert added["districts"] == 0
    assert "My Own Region" in names and still_off is False


def test_only_administrators_can_load_it(client, tenants):
    acme, _ = tenants
    response = client.post("/api/v1/crm/geography/india", headers=acme.headers(acme.employee_token))
    assert response.status_code == 403


def test_an_old_spelling_is_renamed_not_duplicated(client, tenants):
    acme, _ = tenants
    with SessionLocal() as db:
        load_india(db, acme.id)
        odisha = db.scalar(select(CrmState).where(CrmState.org_id == acme.id, CrmState.name == "Odisha"))
        cuttack = db.scalar(select(CrmDistrict).where(CrmDistrict.state_id == odisha.id, CrmDistrict.name == "Cuttack"))
        cuttack.name = "Kataka"  # as the earlier copy of the list spelled it
        db.commit()
        added = load_india(db, acme.id)
        db.commit()
        names = list(db.scalars(select(CrmDistrict.name).where(CrmDistrict.state_id == odisha.id)).all())
    assert added.get("renamed") == 1 and added["districts"] == 0
    assert "Cuttack" in names and "Kataka" not in names and names.count("Cuttack") == 1
