"""Employee tracking: sharing, the live view, a day's route, and who may see whom."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone


def _ping(client, tenant, token, lat, lng, minutes_ago=0, **extra):
    at = (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat()
    r = client.post("/api/v1/location/pings", json={"points": [{"lat": lat, "lng": lng, "at": at, **extra}]},
                    headers=tenant.headers(token))
    assert r.status_code == 200, r.text


def test_live_and_route_for_an_admin_and_a_refusal_for_an_employee(client, tenants):
    acme, _ = tenants
    _ping(client, acme, acme.employee_token, 28.6139, 77.2090, minutes_ago=5)
    _ping(client, acme, acme.employee_token, 28.6200, 77.2150, minutes_ago=1)

    live = client.get("/api/v1/tracking/live", headers=acme.headers()).json()
    mine = next(p for p in live["people"] if p["user_id"] == str(acme.employee.id))
    assert mine["state"] == "reporting" and mine["moving"] is True  # moved ~850 m between pings
    assert live["reporting"] >= 1

    today = datetime.now(timezone.utc).date().isoformat()
    route = client.get(f"/api/v1/tracking/route?user_id={acme.employee.id}&date={today}", headers=acme.headers()).json()
    assert len(route["points"]) == 2 and route["distance_km"] > 0.5

    assert client.get("/api/v1/tracking/live", headers=acme.headers(acme.employee_token)).status_code == 403


def test_old_positions_are_last_seen_and_bad_points_are_refused(client, tenants):
    acme, _ = tenants
    _ping(client, acme, acme.employee_token, 19.0760, 72.8777, minutes_ago=120)
    live = client.get("/api/v1/tracking/live", headers=acme.headers()).json()
    mine = next(p for p in live["people"] if p["user_id"] == str(acme.employee.id))
    assert mine["state"] == "earlier" and mine["moving"] is False
    bad = client.post("/api/v1/location/pings", json={"points": [{"lat": 123, "lng": 0}]}, headers=acme.headers(acme.employee_token))
    assert bad.status_code == 422


def test_hr_can_switch_gps_tracking_off_for_the_company(client, tenants):
    """On by default; with it off the server keeps no pings, and only an administrator can change it."""
    acme, _ = tenants
    assert client.get("/api/v1/attendance/settings", headers=acme.headers(acme.employee_token)).json()["gps_tracking_enabled"] is True

    denied = client.put("/api/v1/attendance/settings", json={"gps_tracking_enabled": False}, headers=acme.headers(acme.employee_token))
    assert denied.status_code in (401, 403)

    off = client.put("/api/v1/attendance/settings", json={"gps_tracking_enabled": False}, headers=acme.headers())
    assert off.status_code == 200 and off.json()["gps_tracking_enabled"] is False
    at = datetime.now(timezone.utc).isoformat()
    sent = client.post("/api/v1/location/pings", json={"points": [{"lat": 28.6, "lng": 77.2, "at": at}]}, headers=acme.headers(acme.employee_token))
    assert sent.status_code == 200 and sent.json() == {"saved": 0, "enabled": False}

    on = client.put("/api/v1/attendance/settings", json={"gps_tracking_enabled": True}, headers=acme.headers())
    assert on.json()["gps_tracking_enabled"] is True
    kept = client.post("/api/v1/location/pings", json={"points": [{"lat": 28.6, "lng": 77.2, "at": at}]}, headers=acme.headers(acme.employee_token))
    assert kept.json()["saved"] == 1
