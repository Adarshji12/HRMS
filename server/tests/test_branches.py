"""Branches and locations: the Organisation masters."""

from __future__ import annotations


def _branch(client, tenant, **over):
    body = {"name": "Pune Office", "code": "pnq", "state": "Maharashtra", "city": "Pune", **over}
    return client.post("/api/v1/org/branches", json=body, headers=tenant.headers())


def test_a_branch_is_created_listed_and_tidied(client, tenants):
    tenant, _ = tenants
    made = _branch(client, tenant, email="hr@pune.test", phone=" 020 1234 ")
    assert made.status_code == 201, made.text
    body = made.json()
    assert body["code"] == "PNQ" and body["phone"] == "020 1234" and body["is_active"] is True
    assert [b["name"] for b in client.get("/api/v1/org/branches", headers=tenant.headers()).json()] == ["Pune Office"]
    assert _branch(client, tenant).status_code == 409
    assert _branch(client, tenant, name="Bad Mail", email="not-an-address").status_code == 422
    assert client.post("/api/v1/org/branches", json={"name": "X"}, headers=tenant.headers(tenant.employee_token)).status_code == 403


def test_only_one_branch_is_the_head_office(client, tenants):
    tenant, _ = tenants
    first = _branch(client, tenant, name="Mumbai HQ", is_head_office=True).json()
    second = _branch(client, tenant, name="Pune Office", is_head_office=True).json()
    rows = {b["id"]: b for b in client.get("/api/v1/org/branches", headers=tenant.headers()).json()}
    assert rows[second["id"]]["is_head_office"] is True
    assert rows[first["id"]]["is_head_office"] is False


def test_a_location_belongs_to_a_branch_and_may_have_no_coordinates(client, tenants):
    tenant, _ = tenants
    branch = _branch(client, tenant).json()
    made = client.post("/api/v1/attendance/locations", headers=tenant.headers(), json={
        "name": "Plant 2", "branch_id": branch["id"], "state": "Maharashtra", "city": "Pune"})
    assert made.status_code == 201, made.text
    loc = made.json()
    assert loc["branch_name"] == "Pune Office" and loc["lat"] is None and loc["lng"] is None

    # An unmapped site is listed but never part of the punch check.
    from app.db.session import SessionLocal
    from app.services import attendance as svc
    with SessionLocal() as db:
        assert [l.name for l in svc.active_locations(db, tenant.id)] == []

    half = client.post("/api/v1/attendance/locations", headers=tenant.headers(), json={"name": "Half", "lat": 18.5})
    assert half.status_code == 422
    mapped = client.patch(f"/api/v1/attendance/locations/{loc['id']}", headers=tenant.headers(), json={
        "name": "Plant 2", "branch_id": branch["id"], "lat": 18.5204, "lng": 73.8567, "radius_m": 200})
    assert mapped.status_code == 200, mapped.text
    with SessionLocal() as db:
        assert [l.name for l in svc.active_locations(db, tenant.id)] == ["Plant 2"]


def test_deleting_a_branch_keeps_its_locations(client, tenants):
    tenant, _ = tenants
    branch = _branch(client, tenant).json()
    loc = client.post("/api/v1/attendance/locations", headers=tenant.headers(),
                      json={"name": "Dock", "branch_id": branch["id"]}).json()
    assert client.delete(f"/api/v1/org/branches/{branch['id']}", headers=tenant.headers()).status_code == 204
    rows = client.get("/api/v1/attendance/locations", headers=tenant.headers()).json()
    assert [(r["name"], r["branch_id"]) for r in rows if r["id"] == loc["id"]] == [("Dock", None)]


def test_a_location_cannot_use_another_companys_branch(client, tenants):
    a, b = tenants
    foreign = _branch(client, b).json()
    r = client.post("/api/v1/attendance/locations", headers=a.headers(), json={"name": "Sneaky", "branch_id": foreign["id"]})
    assert r.status_code == 422


# ------------------------------------------------------------------ holidays --- #


def _holiday(client, tenant, **over):
    body = {"holiday_date": "2026-08-15", "name": "Independence Day", **over}
    return client.post("/api/v1/leave/holidays", json=body, headers=tenant.headers())


def test_a_holiday_has_a_type_and_optionally_a_branch(client, tenants):
    tenant, _ = tenants
    branch = _branch(client, tenant).json()
    made = _holiday(client, tenant, holiday_type="national", branch_id=branch["id"])
    assert made.status_code == 201, made.text
    body = made.json()
    assert body["holiday_type"] == "national" and body["branch_name"] == "Pune Office" and body["is_optional"] is False
    assert _holiday(client, tenant, name="Bad", holiday_type="weekend").status_code == 422


def test_the_optional_type_and_the_opt_in_flag_go_together(client, tenants):
    tenant, _ = tenants
    optional = _holiday(client, tenant, name="Karwa Chauth", holiday_type="optional").json()
    assert optional["is_optional"] is True


def test_the_older_calendar_form_does_not_wipe_type_or_branch(client, tenants):
    tenant, _ = tenants
    branch = _branch(client, tenant).json()
    made = _holiday(client, tenant, holiday_type="festival", branch_id=branch["id"]).json()
    # The Leave Settings form sends neither field.
    edited = client.put(f"/api/v1/leave/holidays/{made['id']}", headers=tenant.headers(), json={
        "holiday_date": "2026-08-15", "name": "Independence Day (renamed)", "is_optional": False, "is_active": True})
    assert edited.status_code == 200, edited.text
    assert edited.json()["holiday_type"] == "festival" and edited.json()["branch_id"] == branch["id"]
    # Ticking its opt-in box there makes it an Optional / Restricted holiday; unticking returns it to Public.
    on = client.put(f"/api/v1/leave/holidays/{made['id']}", headers=tenant.headers(), json={
        "holiday_date": "2026-08-15", "name": "X", "is_optional": True}).json()
    assert on["holiday_type"] == "optional"
    off = client.put(f"/api/v1/leave/holidays/{made['id']}", headers=tenant.headers(), json={
        "holiday_date": "2026-08-15", "name": "X", "is_optional": False}).json()
    assert off["holiday_type"] == "public"


def test_a_holiday_cannot_use_another_companys_branch(client, tenants):
    a, b = tenants
    foreign = _branch(client, b).json()
    assert _holiday(client, a, branch_id=foreign["id"]).status_code == 422


# ------------------------------------------------------------------ overtime --- #


def test_the_overtime_policy_is_saved_and_changes_what_counts():
    from datetime import date

    from app.services.timesheets import DayRow

    def day(**policy):
        return DayRow(day=date(2026, 8, 12), tracked_minutes=540, expected_minutes=480, **policy)

    assert day().overtime_minutes == 60                                   # the behaviour before a policy
    assert day(ot_enabled=False).overtime_minutes == 0
    assert day(ot_min_minutes=90).overtime_minutes == 0                    # 60 extra is under the minimum
    assert day(ot_min_minutes=30).overtime_minutes == 60
    off = DayRow(day=date(2026, 8, 15), tracked_minutes=300, is_working_day=False)
    assert off.overtime_minutes == 300
    off.ot_on_off_days = False
    assert off.overtime_minutes == 0


def test_the_overtime_policy_round_trips_through_the_settings_endpoint(client, tenants):
    tenant, _ = tenants
    base = client.get("/api/v1/attendance/settings", headers=tenant.headers()).json()
    assert (base["overtime_enabled"], base["overtime_min_minutes"], base["overtime_on_off_days"]) == (True, 0, True)
    saved = client.put("/api/v1/attendance/settings", headers=tenant.headers(), json={
        "overtime_enabled": True, "overtime_min_minutes": 45, "overtime_on_off_days": False})
    assert saved.status_code == 200, saved.text
    assert saved.json()["overtime_min_minutes"] == 45 and saved.json()["overtime_on_off_days"] is False
    again = client.get("/api/v1/attendance/settings", headers=tenant.headers()).json()
    assert again["overtime_min_minutes"] == 45
    # A save that mentions only the geofence leaves the overtime policy alone.
    client.put("/api/v1/attendance/settings", headers=tenant.headers(), json={"geofence_enforcement": "off"})
    assert client.get("/api/v1/attendance/settings", headers=tenant.headers()).json()["overtime_min_minutes"] == 45
    assert client.put("/api/v1/attendance/settings", headers=tenant.headers(),
                      json={"overtime_min_minutes": 9999}).status_code == 422


# ------------------------------------------------------------------- methods --- #


def test_manual_attendance_can_be_switched_off_per_channel(client, tenants):
    tenant, _ = tenants
    staff = tenant.headers(tenant.employee_token)
    base = client.get("/api/v1/attendance/settings", headers=tenant.headers()).json()
    assert (base["manual_enabled"], base["manual_web_enabled"], base["manual_mobile_enabled"]) == (True, True, True)
    assert (base["face_enabled"], base["biometric_enabled"]) == (False, False)

    client.put("/api/v1/attendance/settings", headers=tenant.headers(), json={"manual_web_enabled": False})
    refused = client.post("/api/v1/attendance/punch/in", json={"source": "web"}, headers=staff)
    assert refused.status_code == 403 and refused.json()["detail"]["reason"] == "manual_attendance_off"
    # The phone channel is a separate switch and still works.
    assert client.post("/api/v1/attendance/punch/in", json={"source": "mobile_web"}, headers=staff).status_code == 201

    client.put("/api/v1/attendance/settings", headers=tenant.headers(), json={"manual_web_enabled": True, "manual_enabled": False})
    assert client.post("/api/v1/attendance/punch/out", json={"source": "mobile_web"}, headers=staff).status_code == 403
    client.put("/api/v1/attendance/settings", headers=tenant.headers(), json={"manual_enabled": True})
    assert client.post("/api/v1/attendance/punch/out", json={"source": "mobile_web"}, headers=staff).status_code == 200


def test_devices_are_registered_per_kind_with_unique_ids(client, tenants):
    tenant, _ = tenants
    place = client.post("/api/v1/attendance/locations", headers=tenant.headers(), json={"name": "HQ"}).json()
    made = client.post("/api/v1/attendance/devices", headers=tenant.headers(),
                       json={"kind": "face", "name": "Lobby terminal", "device_code": " FX-100 ", "location_id": place["id"]})
    assert made.status_code == 201, made.text
    assert made.json()["device_code"] == "FX-100" and made.json()["location_name"] == "HQ"
    dup = client.post("/api/v1/attendance/devices", headers=tenant.headers(), json={"kind": "face", "name": "Other", "device_code": "FX-100"})
    assert dup.status_code == 409
    # The same ID on the other kind of device is a different machine.
    assert client.post("/api/v1/attendance/devices", headers=tenant.headers(),
                       json={"kind": "biometric", "name": "Finger", "device_code": "FX-100"}).status_code == 201
    assert client.post("/api/v1/attendance/devices", headers=tenant.headers(), json={"kind": "retina", "name": "X"}).status_code == 422
    assert client.get("/api/v1/attendance/devices", headers=tenant.headers(tenant.employee_token)).status_code == 403
    assert client.delete(f"/api/v1/attendance/devices/{made.json()['id']}", headers=tenant.headers()).status_code == 204


def test_a_device_records_its_verification_and_timing(client, tenants):
    tenant, _ = tenants
    branch = _branch(client, tenant).json()
    base = {"kind": "face", "name": "Shop entrance", "branch_id": branch["id"]}
    made = client.post("/api/v1/attendance/devices", headers=tenant.headers(), json={
        **base, "location_required": True, "lat": 18.52043, "lng": 73.856744, "radius_m": 150,
        "ip_required": True, "allowed_ips": "203.0.113.7, 10.0.0.0/8\n192.168.1.*",
        "cooldown_s": 90, "allowed_from_min": 60, "allowed_until_min": 120})
    assert made.status_code == 201, made.text
    body = made.json()
    assert body["branch_name"] == "Pune Office" and body["radius_m"] == 150
    assert body["allowed_ips"] == "203.0.113.7\n10.0.0.0/8\n192.168.1.*"
    assert (body["cooldown_s"], body["allowed_from_min"], body["allowed_until_min"]) == (90, 60, 120)

    plain = client.post("/api/v1/attendance/devices", headers=tenant.headers(), json={**base, "name": "Plain"}).json()
    assert (plain["location_required"], plain["ip_required"], plain["cooldown_s"]) == (False, False, 120)

    # A switch that is on needs what it checks against.
    assert client.post("/api/v1/attendance/devices", headers=tenant.headers(),
                       json={**base, "name": "A", "location_required": True}).status_code == 422
    assert client.post("/api/v1/attendance/devices", headers=tenant.headers(),
                       json={**base, "name": "B", "ip_required": True}).status_code == 422
    assert client.post("/api/v1/attendance/devices", headers=tenant.headers(),
                       json={**base, "name": "C", "ip_required": True, "allowed_ips": "not-an-ip"}).status_code == 422
