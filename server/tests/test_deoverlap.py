"""The one-off repair for history recorded before the ingest guard.

It deletes, so the selection logic is tested directly rather than trusted: the
cost of it being wrong is real working hours disappearing from someone's
record.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.db.session import SessionLocal
from app.models.activity import ActivitySegment
from app.services.deoverlap import find_overlapping, run

BASE = datetime(2026, 8, 19, 9, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _reset_device_cache():
    _DEVICE.clear()
    yield
    _DEVICE.clear()


_DEVICE: dict = {}


def _device_for(db, user, org_id):
    """Segments require a device; one per user is enough for these tests."""
    from app.models import Device
    from app.core.security import token_digest

    if user.id not in _DEVICE:
        dev = Device(
            id=uuid.uuid4(), org_id=org_id, user_id=user.id,
            machine_id=uuid.uuid4().hex, hostname="pc", os="windows",
            os_version="11", agent_version="0.1.0",
            token_hash=token_digest(uuid.uuid4().hex), is_active=True,
        )
        db.add(dev)
        db.flush()
        _DEVICE[user.id] = dev.id
    return _DEVICE[user.id]


def _add(db, user, offset_min, minutes, org_id):
    seg = ActivitySegment(
        id=uuid.uuid4(), org_id=org_id, user_id=user.id,
        device_id=_device_for(db, user, org_id),
        client_uid=uuid.uuid4().hex,
        started_at=BASE + timedelta(minutes=offset_min),
        ended_at=BASE + timedelta(minutes=offset_min + minutes),
        duration_s=minutes * 60, active_s=minutes * 60, idle_s=0,
        app_name="Code", app_exec="code.exe", window_title="w",
        productivity="neutral",
    )
    db.add(seg)
    return seg


def test_disjoint_history_is_left_alone(tenants):
    """The repair must never touch a healthy record."""
    acme = tenants[0]
    with SessionLocal() as db:
        for i in range(4):
            _add(db, acme.employee, i * 30, 30, acme.id)
        db.commit()
        assert find_overlapping(db, acme.employee.id) == []


def test_a_duplicated_hour_is_reduced_to_one(tenants):
    acme = tenants[0]
    with SessionLocal() as db:
        _add(db, acme.employee, 0, 60, acme.id)
        _add(db, acme.employee, 0, 60, acme.id)
        db.commit()
        assert len(find_overlapping(db, acme.employee.id)) == 1


def test_ten_concurrent_trackers_collapse_to_one(tenants):
    acme = tenants[0]
    with SessionLocal() as db:
        for _ in range(10):
            _add(db, acme.employee, 0, 60, acme.id)
        db.commit()
    result = run(dry=False)
    assert result["segments_removed"] == 9
    with SessionLocal() as db:
        kept = db.query(ActivitySegment).filter(
            ActivitySegment.user_id == acme.employee.id).all()
        assert len(kept) == 1
        assert sum(s.duration_s for s in kept) == 3600


def test_touching_segments_are_kept(tenants):
    """Consecutive segments share an edge; dropping those would delete half of
    every healthy day."""
    acme = tenants[0]
    with SessionLocal() as db:
        _add(db, acme.employee, 0, 10, acme.id)
        _add(db, acme.employee, 10, 10, acme.id)
        db.commit()
        assert find_overlapping(db, acme.employee.id) == []


def test_the_earliest_of_an_overlapping_pair_survives(tenants):
    """Not the longest. The earliest is the one whose app and title were
    actually observed at that moment."""
    acme = tenants[0]
    with SessionLocal() as db:
        first = _add(db, acme.employee, 0, 20, acme.id)
        _add(db, acme.employee, 5, 60, acme.id)
        db.commit()
        keep_id = first.id
    run(dry=False)
    with SessionLocal() as db:
        remaining = db.query(ActivitySegment).filter(
            ActivitySegment.user_id == acme.employee.id).all()
        assert [s.id for s in remaining] == [keep_id]


def test_a_dry_run_changes_nothing(tenants):
    acme = tenants[0]
    with SessionLocal() as db:
        for _ in range(3):
            _add(db, acme.employee, 0, 60, acme.id)
        db.commit()
    result = run(dry=True)
    assert result["segments_removed"] == 2
    with SessionLocal() as db:
        assert db.query(ActivitySegment).filter(
            ActivitySegment.user_id == acme.employee.id).count() == 3


def test_one_users_overlap_does_not_affect_another(tenants):
    """Two people working the same hours is normal, not overlap."""
    acme, globex = tenants
    with SessionLocal() as db:
        _add(db, acme.employee, 0, 60, acme.id)
        _add(db, globex.employee, 0, 60, globex.id)
        db.commit()
    assert run(dry=True)["segments_removed"] == 0
