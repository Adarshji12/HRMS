"""A person's recorded time must never overlap itself.

Totals are SUM(duration_s), which only equals elapsed working time while the
segments are disjoint. Two agent instances, or two enrolled machines used at
once, produce overlap that the client_uid de-duplication cannot see: every
segment is genuinely distinct, they simply cover the same clock. Measured on a
real account before this guard existed — 1,311 segments summing to 36.5 hours
across 5.1 hours of wall clock.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.core.security import hash_password
from app.db.session import SessionLocal
from app.models import Device, Organization, OrgSettings, User
from app.models.activity import ActivitySegment

BASE = datetime(2026, 8, 19, 9, 0, tzinfo=timezone.utc)


@pytest.fixture
def agent(client_raising):
    """An enrolled device, plus a helper that posts segments as it would."""
    client = client_raising
    with SessionLocal() as db:
        org = Organization(id=uuid.uuid4(), slug="ingest", name="Ingest Ltd")
        db.add(org)
        db.flush()
        db.add(OrgSettings(org_id=org.id, min_segment_s=1))
        user = User(
            id=uuid.uuid4(), org_id=org.id, email="worker@ingest.test",
            full_name="Worker", role="employee", is_active=True,
            password_hash=hash_password("x"), enrollment_key=uuid.uuid4().hex[:16].upper(),
        )
        db.add(user)
        db.flush()
        token = uuid.uuid4().hex
        from app.core.security import token_digest

        device = Device(
            id=uuid.uuid4(), org_id=org.id, user_id=user.id, hostname="pc-1",
            machine_id=uuid.uuid4().hex, os="windows", os_version="11", agent_version="0.1.0",
            token_hash=token_digest(token), is_active=True,
        )
        db.add(device)
        db.commit()
        ids = (org.id, user.id, device.id, token, org.slug)

    org_id, user_id, device_id, token, slug = ids

    def post(segments):
        return client.post(
            "/api/v1/agent/activity",
            json={"segments": segments},
            headers={"Authorization": f"Bearer {token}", "X-Org-Slug": slug},
        )

    def seg(offset_min, minutes, uid=None):
        start = BASE + timedelta(minutes=offset_min)
        return {
            "client_uid": uid or uuid.uuid4().hex,
            "started_at": start.isoformat(),
            "ended_at": (start + timedelta(minutes=minutes)).isoformat(),
            "active_s": minutes * 60,
            "idle_s": 0,
            "app_name": "Code",
            "app_exec": "code.exe",
            "window_title": "work",
        }

    return type("Agent", (), {
        "post": staticmethod(post), "seg": staticmethod(seg),
        "user_id": user_id, "org_id": org_id,
    })


def _total(user_id) -> int:
    with SessionLocal() as db:
        return sum(
            s.duration_s
            for s in db.query(ActivitySegment).filter(ActivitySegment.user_id == user_id).all()
        )


def test_disjoint_segments_are_all_kept(agent):
    """The guard must not eat ordinary consecutive activity."""
    response = agent.post([agent.seg(0, 10), agent.seg(10, 10), agent.seg(20, 10)])
    assert response.status_code == 200
    assert _total(agent.user_id) == 30 * 60


def test_a_second_tracker_covering_the_same_hour_is_refused(agent):
    """Two instances, each with its own client_uid, covering one hour."""
    agent.post([agent.seg(0, 60)])
    agent.post([agent.seg(0, 60)])
    assert _total(agent.user_id) == 60 * 60, "the same hour was counted twice"


def test_partial_overlap_is_refused(agent):
    agent.post([agent.seg(0, 30)])
    agent.post([agent.seg(15, 30)])
    assert _total(agent.user_id) == 30 * 60


def test_overlap_inside_a_single_batch_is_refused(agent):
    """A batch can contain its own overlaps when a spool is replayed."""
    agent.post([agent.seg(0, 30), agent.seg(0, 30), agent.seg(0, 30)])
    assert _total(agent.user_id) == 30 * 60


def test_touching_segments_are_not_treated_as_overlapping(agent):
    """Consecutive segments share an edge. Treating that as a clash would throw
    away every second segment a healthy agent produces."""
    agent.post([agent.seg(0, 10)])
    agent.post([agent.seg(10, 10)])
    assert _total(agent.user_id) == 20 * 60


def test_a_refused_segment_is_acknowledged_not_rejected(agent):
    """The agent must drop it from the spool rather than retry it forever."""
    agent.post([agent.seg(0, 30)])
    duplicate = agent.seg(0, 30)
    response = agent.post([duplicate])
    assert response.status_code == 200
    body = response.json()
    assert duplicate["client_uid"] in body["accepted"]
    assert duplicate["client_uid"] not in body["rejected"]


def test_ten_concurrent_trackers_do_not_multiply_the_day(agent):
    """The shape of the real incident: many instances, one working period."""
    for _ in range(10):
        agent.post([agent.seg(0, 60), agent.seg(60, 60), agent.seg(120, 60)])
    assert _total(agent.user_id) == 3 * 60 * 60
