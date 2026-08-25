"""Screenshots must actually disappear when the retention window passes.

The console tells an administrator screenshots are kept for N days, and the
monitoring notice tells staff the same. That is a commitment made to people
about images of their screen, so it is worth testing rather than assuming —
particularly the part that deletes the image file, since an orphaned row is
recoverable and an orphaned blob nobody points at is just data left lying
around after it was promised gone.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.core.security import token_digest
from app.db.session import SessionLocal
from app.models import Device, OrgSettings, Screenshot
from app.models.activity import ActivitySegment
from app.services import storage
from app.services.retention import purge_all, purge_org


@pytest.fixture
def device_for():
    def make(tenant):
        with SessionLocal() as db:
            dev = Device(
                id=uuid.uuid4(), org_id=tenant.id, user_id=tenant.employee.id,
                machine_id=uuid.uuid4().hex, hostname="pc", os="windows",
                os_version="11", agent_version="0.1.0",
                token_hash=token_digest(uuid.uuid4().hex), is_active=True,
            )
            db.add(dev)
            db.commit()
            return dev.id
    return make


def _add_shot(tenant, device_id, days_ago: int) -> tuple[uuid.UUID, str, str]:
    """A screenshot with real files on disk, captured `days_ago` days back."""
    shot_id = uuid.uuid4()
    captured = datetime.now(timezone.utc) - timedelta(days=days_ago)
    # A tiny but genuine JPEG, so the storage layer writes real files.
    import io as _io

    from PIL import Image

    buf = _io.BytesIO()
    Image.new("RGB", (32, 24), (90, 120, 200)).save(buf, "JPEG")

    meta = storage.save_screenshot(
        buf.getvalue(), org_id=tenant.id, user_id=tenant.employee.id,
        captured_at=captured, shot_id=shot_id, max_width=64, quality=50, blur=False,
    )
    with SessionLocal() as db:
        db.add(Screenshot(
            id=shot_id, org_id=tenant.id, user_id=tenant.employee.id,
            device_id=device_id, client_uid=uuid.uuid4().hex,
            captured_at=captured, received_at=datetime.now(timezone.utc),
            storage_key=meta["storage_key"], thumb_key=meta["thumb_key"],
            width=meta["width"], height=meta["height"], file_size=meta["file_size"],
            monitor_count=1, blurred=False,
            app_name="Code", window_title="w", productivity="neutral", activity_pct=100,
        ))
        db.commit()
    return shot_id, meta["storage_key"], meta["thumb_key"]


def _exists(key: str) -> bool:
    try:
        storage.serve(key)
        return True
    except Exception:  # noqa: BLE001 - any failure to read means it is gone
        return False


def test_a_screenshot_past_the_window_is_deleted(tenants, device_for):
    acme, _ = tenants
    device_id = device_for(acme)
    with SessionLocal() as db:
        db.get(OrgSettings, acme.id).screenshot_retention_days = 30
        db.commit()

    shot_id, key, thumb = _add_shot(acme, device_id, days_ago=45)
    assert _exists(key), "fixture did not actually write a file"

    with SessionLocal() as db:
        purge_org(db, acme.id, db.get(OrgSettings, acme.id))

    with SessionLocal() as db:
        assert db.get(Screenshot, shot_id) is None, "the row survived the purge"

    # The row going is not the point — the image is.
    assert not _exists(key), "the image file is still on disk"
    assert not _exists(thumb), "the thumbnail is still on disk"


def test_a_recent_screenshot_is_kept(tenants, device_for):
    """The window has to cut one way only."""
    acme, _ = tenants
    device_id = device_for(acme)
    with SessionLocal() as db:
        db.get(OrgSettings, acme.id).screenshot_retention_days = 30
        db.commit()

    shot_id, key, _ = _add_shot(acme, device_id, days_ago=3)
    with SessionLocal() as db:
        purge_org(db, acme.id, db.get(OrgSettings, acme.id))

    with SessionLocal() as db:
        assert db.get(Screenshot, shot_id) is not None
    assert _exists(key)


def test_shortening_the_window_takes_effect_on_the_next_run(tenants, device_for):
    """An administrator lowering the number is the whole point of the setting."""
    acme, _ = tenants
    device_id = device_for(acme)
    with SessionLocal() as db:
        db.get(OrgSettings, acme.id).screenshot_retention_days = 30
        db.commit()

    shot_id, key, _ = _add_shot(acme, device_id, days_ago=10)

    with SessionLocal() as db:
        purge_org(db, acme.id, db.get(OrgSettings, acme.id))
        assert db.get(Screenshot, shot_id) is not None, "10 days should survive a 30-day window"

        db.get(OrgSettings, acme.id).screenshot_retention_days = 7
        db.commit()
        purge_org(db, acme.id, db.get(OrgSettings, acme.id))

    with SessionLocal() as db:
        assert db.get(Screenshot, shot_id) is None
    assert not _exists(key)


def test_zero_means_keep_forever(tenants, device_for):
    """0 has to mean 'no window', not 'delete everything older than now'."""
    acme, _ = tenants
    device_id = device_for(acme)
    with SessionLocal() as db:
        db.get(OrgSettings, acme.id).screenshot_retention_days = 0
        db.commit()

    shot_id, key, _ = _add_shot(acme, device_id, days_ago=400)
    with SessionLocal() as db:
        purge_org(db, acme.id, db.get(OrgSettings, acme.id))

    with SessionLocal() as db:
        assert db.get(Screenshot, shot_id) is not None
    assert _exists(key)


def test_one_company_window_does_not_purge_another(tenants, device_for):
    """Retention is per organisation; a short window at one tenant must not
    reach into another's data."""
    acme, globex = tenants
    acme_device, globex_device = device_for(acme), device_for(globex)
    with SessionLocal() as db:
        db.get(OrgSettings, acme.id).screenshot_retention_days = 1
        db.get(OrgSettings, globex.id).screenshot_retention_days = 365
        db.commit()

    acme_shot, acme_key, _ = _add_shot(acme, acme_device, days_ago=10)
    globex_shot, globex_key, _ = _add_shot(globex, globex_device, days_ago=10)

    purge_all()

    with SessionLocal() as db:
        assert db.get(Screenshot, acme_shot) is None, "acme's own 10-day-old shot should go"
        assert db.get(Screenshot, globex_shot) is not None, "globex's was purged by acme's window"
    assert _exists(globex_key)


def test_activity_segments_have_their_own_window(tenants, device_for):
    acme, _ = tenants
    device_id = device_for(acme)
    with SessionLocal() as db:
        settings = db.get(OrgSettings, acme.id)
        settings.activity_retention_days = 30
        settings.screenshot_retention_days = 0
        db.add(ActivitySegment(
            id=uuid.uuid4(), org_id=acme.id, user_id=acme.employee.id,
            device_id=device_id, client_uid=uuid.uuid4().hex,
            started_at=datetime.now(timezone.utc) - timedelta(days=90),
            ended_at=datetime.now(timezone.utc) - timedelta(days=90) + timedelta(minutes=5),
            duration_s=300, active_s=300, idle_s=0,
            app_name="Code", app_exec="code.exe", window_title="w", productivity="neutral",
        ))
        db.commit()
        result = purge_org(db, acme.id, db.get(OrgSettings, acme.id))

    assert result["segments"] == 1
