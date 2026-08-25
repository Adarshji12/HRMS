"""What the agent is told to collect, and when.

The tracking window is the difference between a product that records the
working day and one that records someone's evening. It is set in two places in
the console — the organisation policy and a per-employee schedule — and only
one of them used to reach the agent.
"""

from __future__ import annotations

import uuid

import pytest

from app.core.security import token_digest
from app.db.session import SessionLocal
from app.models import Device, OrgSettings, User, WorkSchedule


@pytest.fixture
def device_for(tenants):
    """An enrolled device for a tenant's employee, and its token."""
    def make(tenant):
        with SessionLocal() as db:
            token = uuid.uuid4().hex
            db.add(Device(
                id=uuid.uuid4(), org_id=tenant.id, user_id=tenant.employee.id,
                machine_id=uuid.uuid4().hex, hostname="pc", os="windows",
                os_version="11", agent_version="0.1.0",
                token_hash=token_digest(token), is_active=True,
            ))
            db.commit()
        return token
    return make


def _heartbeat(client, tenant, token):
    return client.post(
        "/api/v1/agent/heartbeat",
        json={"agent_version": "0.1.0", "queued_items": 0},
        headers={"Authorization": f"Bearer {token}", "X-Org-Slug": tenant.slug},
    )


def test_the_agent_receives_the_organisation_hours(client, tenants, device_for):
    acme, _ = tenants
    token = device_for(acme)
    with SessionLocal() as db:
        settings = db.get(OrgSettings, acme.id)
        settings.work_day_start, settings.work_day_end = "09:00", "18:00"
        db.commit()

    config = _heartbeat(client, acme, token).json()["config"]
    assert config["work_day_start"] == "09:00"
    assert config["work_day_end"] == "18:00"


def test_a_personal_schedule_overrides_the_organisation_hours(client, tenants, device_for):
    """The console offers per-employee schedules as a tracking control. Until
    this was fixed the heartbeat sent only the org policy, so choosing
    10:00-19:00 for the support team changed nothing about when they were
    tracked."""
    acme, _ = tenants
    token = device_for(acme)
    with SessionLocal() as db:
        settings = db.get(OrgSettings, acme.id)
        settings.work_day_start, settings.work_day_end = "09:00", "18:00"
        schedule = WorkSchedule(
            id=uuid.uuid4(), org_id=acme.id, name="Support",
            start_time="10:00", end_time="19:00",
        )
        db.add(schedule)
        db.flush()
        db.get(User, acme.employee.id).schedule_id = schedule.id
        db.commit()

    config = _heartbeat(client, acme, token).json()["config"]
    assert config["work_day_start"] == "10:00"
    assert config["work_day_end"] == "19:00"


def test_an_employee_without_a_schedule_still_gets_the_org_policy(client, tenants, device_for):
    """The override must not blank the window for everyone else."""
    acme, _ = tenants
    token = device_for(acme)
    with SessionLocal() as db:
        settings = db.get(OrgSettings, acme.id)
        settings.work_day_start, settings.work_day_end = "08:30", "17:30"
        db.commit()

    config = _heartbeat(client, acme, token).json()["config"]
    assert config["work_day_start"] == "08:30"


def test_track_outside_hours_reaches_the_agent(client, tenants, device_for):
    """The switch that makes the window moot has to travel too."""
    acme, _ = tenants
    token = device_for(acme)
    with SessionLocal() as db:
        db.get(OrgSettings, acme.id).track_outside_hours = True
        db.commit()

    assert _heartbeat(client, acme, token).json()["config"]["track_outside_hours"] is True
