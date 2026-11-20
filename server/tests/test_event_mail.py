"""Company email events: switch, wording, and the daily birthday mail."""

from __future__ import annotations

from datetime import date

from sqlalchemy import select

from app.db.session import SessionLocal
from app.models import EmployeeProfile, NotificationLog
from app.services import eventmail


def test_events_are_listed_off_by_default_except_leave_and_only_admins_edit(client, tenants):
    acme, _ = tenants
    data = client.get("/api/v1/notifications/rules", headers=acme.headers()).json()
    on = {e["key"]: e["is_enabled"] for e in data["events"]}
    assert on["birthday"] is False and on["leave_applied"] is True
    assert client.get("/api/v1/notifications/rules", headers=acme.headers(acme.employee_token)).status_code == 403
    assert client.put("/api/v1/notifications/rules/nope", json={}, headers=acme.headers()).status_code == 404


def test_rewording_and_reset(client, tenants):
    acme, _ = tenants
    r = client.put("/api/v1/notifications/rules/birthday", json={"is_enabled": True, "subject": "Cake, {name}!"}, headers=acme.headers())
    assert r.status_code == 200
    ev = {e["key"]: e for e in client.get("/api/v1/notifications/rules", headers=acme.headers()).json()["events"]}["birthday"]
    assert ev["is_enabled"] and ev["subject"] == "Cake, {name}!"
    client.put("/api/v1/notifications/rules/birthday", json={"subject": ""}, headers=acme.headers())
    ev = {e["key"]: e for e in client.get("/api/v1/notifications/rules", headers=acme.headers()).json()["events"]}["birthday"]
    assert ev["subject"] == ev["default_subject"]


def test_birthday_mail_goes_out_once_on_the_day(client, tenants):
    acme, _ = tenants
    day = date(2026, 3, 14)
    with SessionLocal() as db:
        profile = db.get(EmployeeProfile, acme.employee.id)
        if profile is None:
            profile = EmployeeProfile(user_id=acme.employee.id, org_id=acme.id)
            db.add(profile)
        profile.date_of_birth = date(1990, 3, 14)
        db.commit()
    assert eventmail.run_daily(day)["birthday"] == 0  # off
    client.put("/api/v1/notifications/rules/birthday", json={"is_enabled": True}, headers=acme.headers())
    assert eventmail.run_daily(day)["birthday"] >= 1
    assert eventmail.run_daily(day)["birthday"] == 0  # not twice
    with SessionLocal() as db:
        rows = db.scalars(select(NotificationLog).where(NotificationLog.kind == "birthday", NotificationLog.user_id == acme.employee.id)).all()
        assert len(rows) == 1 and "Happy birthday" in rows[0].subject
    sent = client.get("/api/v1/notifications/sent", headers=acme.headers()).json()["items"]
    assert any(i["event"] == "birthday" for i in sent)


def test_other_alerts_round_trip(client, tenants):
    acme, _ = tenants
    client.put("/api/v1/notifications/alerts", json={"probation_alert": False, "document_alert": True}, headers=acme.headers())
    assert client.get("/api/v1/notifications/rules", headers=acme.headers()).json()["alerts"] == {"probation_alert": False, "document_alert": True}
