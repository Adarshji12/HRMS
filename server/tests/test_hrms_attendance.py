"""Phase 1: geofence maths, punching, the nightly stamp job, and the two guards.

Written against the real application and the real (temporary) database, per the
conventions in ``conftest.py`` — no mocked session, no mocked geofence. The
failures this module exists to catch are a tenant punching into another
tenant's muster and a derived job overwriting a human decision, and both are
invisible to a test whose dependencies return what the author expected.

The two tests immediately below assert the lead-owned integration seam itself —
that ``api/v1/router.py`` includes this router and that ``app/scheduler.py``
registers the nightly job **hourly**, which is what D-003 actually chose. They
are cheap and they fail loudly rather than as forty identical 404s, which is the
shape this failure would otherwise take.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.core.security import create_access_token, generate_enrollment_key, token_digest
from app.db.session import SessionLocal
from app.models import (
    AttendanceRecord,
    AttendanceSettings,
    AttendanceStatus,
    Device,
    Holiday,
    OfficeLocation,
    PunchSource,
    Shift,
    ShiftAssignment,
    WorkSchedule,
)
from app.models.attendance import MAX_WORKED_MINUTES_PER_DAY
from app.services import attendance as svc
from app.services import geofence

# A Wednesday, and the Sunday of the same week. Fixed rather than derived from
# "today" so a run on a Saturday cannot quietly change what weekly-off means.
WORKDAY = date(2024, 3, 13)
SUNDAY = date(2024, 3, 17)


def test_router_is_registered_for_integration():
    """The attendance router must be mounted in ``api/v1/router.py``.

    Checked against the router module rather than the running app, so a stray
    ``include_router`` anywhere else cannot satisfy it.
    """
    from app.api.v1.router import api_router

    paths = {getattr(route, "path", "") for route in api_router.routes}
    assert any(path.startswith("/api/v1/attendance") for path in paths), (
        "app/api/v1/router.py does not include attendance.router — see the Phase 1 "
        "integration request"
    )


def test_nightly_job_is_registered_with_the_scheduler():
    """``attendance_status`` must be in ``app/scheduler.py``, and be *hourly*.

    The interval is asserted, not only the name: D-003 chose the hourly-wake
    approach, and a job registered at 24h would silently finalise attendance at
    local midnight for one timezone and at some other local hour for everyone
    else — which is the outcome the ruling exists to reject.
    """
    from app.scheduler import build_jobs

    jobs = {job.name: job for job in build_jobs()}
    assert "attendance_status" in jobs, (
        "app/scheduler.py does not register attendance_status — see the Phase 1 "
        "integration request"
    )
    assert jobs["attendance_status"].every_seconds == 3600, (
        "D-003 picked option (a): the job must wake hourly and act only on the "
        "organisations whose local hour is in the window."
    )


# --------------------------------------------------------------------------- #
# 1. Geofence maths — pure, no database, which is the whole point of §8
# --------------------------------------------------------------------------- #

# Two real Bengaluru sites, ~11 km apart.
WHITEFIELD = geofence.Fence(
    id=uuid.uuid4(), name="Whitefield", lat=12.9698, lng=77.7500, radius_m=200
)
KORAMANGALA = geofence.Fence(
    id=uuid.uuid4(), name="Koramangala", lat=12.9352, lng=77.6245, radius_m=150
)


def test_haversine_is_zero_for_the_same_point():
    assert geofence.haversine_m(12.9698, 77.75, 12.9698, 77.75) == 0.0


def test_haversine_known_distance():
    """One degree of latitude is ~111.2 km anywhere on the sphere."""
    metres = geofence.haversine_m(0.0, 0.0, 1.0, 0.0)
    assert 111_000 < metres < 111_400


def test_haversine_crosses_the_antimeridian_the_short_way():
    """179.9E to 179.9W is 0.2 degrees apart, not most of the way round."""
    metres = geofence.haversine_m(0.0, 179.9, 0.0, -179.9)
    assert metres < 25_000


def test_haversine_is_symmetric():
    a = geofence.haversine_m(12.9698, 77.75, 12.9352, 77.6245)
    b = geofence.haversine_m(12.9352, 77.6245, 12.9698, 77.75)
    assert a == pytest.approx(b)


def test_inside_the_radius_is_verified():
    # ~55 m north of the Whitefield centre: comfortably inside a 200 m fence.
    verdict = geofence.resolve(12.9703, 77.7500, [WHITEFIELD])
    assert verdict.is_verified is True
    assert verdict.office_name == "Whitefield"
    assert verdict.distance_m is not None and verdict.distance_m < 200


def test_outside_every_radius_is_flagged_not_rejected():
    """§2.2: a punch outside the fence is accepted and flagged, with a distance."""
    verdict = geofence.resolve(12.9800, 77.7500, [WHITEFIELD])
    assert verdict.is_verified is False
    assert verdict.office_name == "Whitefield"
    assert verdict.distance_m > 200


def test_multiple_offices_verify_against_any_of_them():
    """Multi-office orgs are normal, not an edge case."""
    inside_koramangala = geofence.resolve(12.9353, 77.6246, [WHITEFIELD, KORAMANGALA])
    assert inside_koramangala.is_verified is True
    assert inside_koramangala.office_name == "Koramangala"

    inside_whitefield = geofence.resolve(12.9699, 77.7501, [WHITEFIELD, KORAMANGALA])
    assert inside_whitefield.is_verified is True
    assert inside_whitefield.office_name == "Whitefield"


def test_nearest_office_is_reported_even_when_outside_all_of_them():
    verdict = geofence.resolve(12.9352, 77.6300, [WHITEFIELD, KORAMANGALA])
    assert verdict.is_verified is False
    assert verdict.office_name == "Koramangala"


def test_no_coordinate_is_unverified_with_no_invented_distance():
    verdict = geofence.resolve(None, None, [WHITEFIELD])
    assert verdict.is_verified is False
    assert verdict.distance_m is None
    assert verdict.office_name is None


def test_no_offices_at_all_is_unverified_with_no_invented_distance():
    verdict = geofence.resolve(12.9698, 77.75, [])
    assert verdict.is_verified is False
    assert verdict.distance_m is None


def test_device_accuracy_widens_the_fence_but_never_narrows_it():
    # ~330 m out: outside a 200 m fence, inside one widened by a ±500 m fix.
    strict = geofence.resolve(12.9728, 77.75, [WHITEFIELD])
    assert strict.is_verified is False

    lenient = geofence.resolve(12.9728, 77.75, [WHITEFIELD], accuracy_m=500)
    assert lenient.is_verified is True
    assert lenient.within_accuracy_margin is True

    # A tiny accuracy figure must not shrink the employer's fence.
    still_inside = geofence.resolve(12.9703, 77.75, [WHITEFIELD], accuracy_m=1)
    assert still_inside.is_verified is True
    assert still_inside.within_accuracy_margin is False


# --------------------------------------------------------------------------- #
# 2. Worked minutes (D-012)
# --------------------------------------------------------------------------- #


def test_worked_minutes_are_capped_at_the_daily_maximum():
    start = datetime(2024, 3, 13, 2, 0, tzinfo=timezone.utc)
    assert svc.worked_minutes_between(start, start + timedelta(hours=8)) == 480
    assert (
        svc.worked_minutes_between(start, start + timedelta(hours=23))
        == MAX_WORKED_MINUTES_PER_DAY
    )


def test_worked_minutes_never_go_negative_or_null():
    start = datetime(2024, 3, 13, 10, 0, tzinfo=timezone.utc)
    assert svc.worked_minutes_between(start, start - timedelta(hours=2)) == 0
    assert svc.worked_minutes_between(start, None) == 0
    assert svc.worked_minutes_between(None, None) == 0


# --------------------------------------------------------------------------- #
# Fixtures for the API half
# --------------------------------------------------------------------------- #


@pytest.fixture
def office(tenants):
    """One active office in Acme, and none in Globex."""
    acme, _ = tenants
    with SessionLocal() as db:
        location = OfficeLocation(
            id=uuid.uuid4(), org_id=acme.id, name="Whitefield",
            lat=12.9698, lng=77.7500, radius_m=200, is_active=True,
        )
        db.add(location)
        db.commit()
        return str(location.id)


def _last_weekday_before_today() -> date:
    """The most recent Mon-Fri strictly before today.

    Tests that pair `weekday_schedule` with "yesterday" are only correct five
    days in seven: run one on a Sunday and yesterday is Saturday, which the
    schedule quite rightly classifies `weekly_off` rather than `present`. That is
    a defect in the test, not in the stamping — and the kind that passes all week
    and fails the weekend build, when nobody is looking at CI.
    """
    day = date.today() - timedelta(days=1)
    while day.weekday() > 4:  # 5 = Saturday, 6 = Sunday
        day -= timedelta(days=1)
    return day


@pytest.fixture
def weekday_schedule(tenants):
    """A Mon-Fri default schedule for Acme, so Sunday is a weekly off."""
    acme, _ = tenants
    with SessionLocal() as db:
        schedule = WorkSchedule(
            id=uuid.uuid4(), org_id=acme.id, name="Standard",
            working_days=0b0011111, is_default=True,
        )
        db.add(schedule)
        db.commit()
        return str(schedule.id)


def _set_enforcement(org_id, mode: str) -> None:
    with SessionLocal() as db:
        row = db.get(AttendanceSettings, org_id)
        if row is None:
            db.add(AttendanceSettings(org_id=org_id, geofence_enforcement=mode))
        else:
            row.geofence_enforcement = mode
        db.commit()


def _record(org_id, user_id, day, **kwargs) -> uuid.UUID:
    with SessionLocal() as db:
        row = AttendanceRecord(
            id=uuid.uuid4(), org_id=org_id, user_id=user_id, date=day,
            status=kwargs.pop("status", AttendanceStatus.PRESENT.value),
            worked_minutes=kwargs.pop("worked_minutes", 0),
            **kwargs,
        )
        db.add(row)
        db.commit()
        return row.id


# --------------------------------------------------------------------------- #
# 3. Punching
# --------------------------------------------------------------------------- #


def test_punch_in_without_geolocation_is_accepted_and_flagged(client, tenants, office):
    """Denied geolocation is the normal case, not an error (§2.2, schema docstring)."""
    acme, _ = tenants
    response = client.post(
        "/api/v1/attendance/punch/in",
        json={},
        headers=acme.headers(acme.employee_token),
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["is_geo_verified"] is False
    assert body["distance_m"] is None
    assert body["enforcement"] == "flag_only"
    assert body["record"]["check_in_at"] is not None
    assert body["record"]["status"] == "present"

    with SessionLocal() as db:
        row = db.scalar(select(AttendanceRecord).where(AttendanceRecord.org_id == acme.id))
        assert row is not None
        assert row.is_geo_verified_in is False
        assert row.check_in_distance_m is None
        assert row.check_in_source == "web"


def test_punch_in_inside_the_geofence_is_verified(client, tenants, office):
    acme, _ = tenants
    response = client.post(
        "/api/v1/attendance/punch/in",
        json={"lat": 12.9699, "lng": 77.7501, "source": "mobile_web"},
        headers=acme.headers(acme.employee_token),
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["is_geo_verified"] is True
    assert body["nearest_office_name"] == "Whitefield"
    assert body["distance_m"] < 200


def test_punch_in_outside_the_geofence_stores_the_distance(client, tenants, office):
    acme, _ = tenants
    response = client.post(
        "/api/v1/attendance/punch/in",
        json={"lat": 12.9800, "lng": 77.7500},
        headers=acme.headers(acme.employee_token),
    )
    assert response.status_code == 201, response.text
    assert response.json()["is_geo_verified"] is False

    with SessionLocal() as db:
        row = db.scalar(select(AttendanceRecord).where(AttendanceRecord.org_id == acme.id))
        assert row.check_in_distance_m > 200


def test_duplicate_punch_in_on_the_same_day_is_refused(client, tenants, office):
    acme, _ = tenants
    first = client.post("/api/v1/attendance/punch/in", json={},
                        headers=acme.headers(acme.employee_token))
    assert first.status_code == 201
    second = client.post("/api/v1/attendance/punch/in", json={},
                         headers=acme.headers(acme.employee_token))
    assert second.status_code == 409
    assert second.json()["detail"]["reason"] == "already_punched_in"

    with SessionLocal() as db:
        count = len(
            db.scalars(select(AttendanceRecord).where(AttendanceRecord.org_id == acme.id)).all()
        )
        assert count == 1


def test_punch_out_without_a_punch_in_is_refused(client, tenants):
    acme, _ = tenants
    response = client.post("/api/v1/attendance/punch/out", json={},
                           headers=acme.headers(acme.employee_token))
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "not_punched_in"


def test_punch_out_closes_the_day_and_records_worked_minutes(client, tenants):
    acme, _ = tenants
    client.post("/api/v1/attendance/punch/in", json={},
                headers=acme.headers(acme.employee_token))
    response = client.post("/api/v1/attendance/punch/out", json={},
                           headers=acme.headers(acme.employee_token))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["record"]["check_out_at"] is not None
    assert body["record"]["is_missing_punch"] is False
    assert body["record"]["worked_minutes"] == 0  # same minute, in a test

    again = client.post("/api/v1/attendance/punch/out", json={},
                        headers=acme.headers(acme.employee_token))
    assert again.status_code == 409
    assert again.json()["detail"]["reason"] == "already_punched_out"


def test_required_mode_refuses_a_punch_with_a_typed_error(client, tenants, office):
    """§2.2: 'required' blocks, but with a renderable typed error, not a raw 4xx."""
    acme, _ = tenants
    _set_enforcement(acme.id, "required")

    no_location = client.post("/api/v1/attendance/punch/in", json={},
                              headers=acme.headers(acme.employee_token))
    assert no_location.status_code == 403
    assert no_location.json()["detail"]["reason"] == "location_required"

    far_away = client.post(
        "/api/v1/attendance/punch/in",
        json={"lat": 12.9800, "lng": 77.7500},
        headers=acme.headers(acme.employee_token),
    )
    assert far_away.status_code == 403
    detail = far_away.json()["detail"]
    assert detail["reason"] == "outside_geofence"
    assert detail["nearest_office_name"] == "Whitefield"
    assert detail["distance_m"] > 200

    at_the_office = client.post(
        "/api/v1/attendance/punch/in",
        json={"lat": 12.9699, "lng": 77.7501},
        headers=acme.headers(acme.employee_token),
    )
    assert at_the_office.status_code == 201


def test_a_client_cannot_widen_the_geofence_without_limit(client, tenants, office):
    """``accuracy_m`` is client-supplied, and ``required`` is the only blocking mode.

    Uncapped, ``accuracy_m: 100000`` walks through the entire enforcement from
    anywhere on earth. See ``MAX_ACCURACY_WIDENING_M``.
    """
    acme, _ = tenants
    _set_enforcement(acme.id, "required")
    response = client.post(
        "/api/v1/attendance/punch/in",
        # Mumbai, ~840 km from the Bengaluru office, with a claimed 100 km fix.
        json={"lat": 19.0760, "lng": 72.8777, "accuracy_m": 100000},
        headers=acme.headers(acme.employee_token),
    )
    assert response.status_code == 403
    assert response.json()["detail"]["reason"] == "outside_geofence"


def test_off_mode_skips_the_geofence_entirely(client, tenants, office):
    acme, _ = tenants
    _set_enforcement(acme.id, "off")
    response = client.post(
        "/api/v1/attendance/punch/in",
        json={"lat": 12.9699, "lng": 77.7501},
        headers=acme.headers(acme.employee_token),
    )
    assert response.status_code == 201
    body = response.json()
    assert body["enforcement"] == "off"
    assert body["distance_m"] is None


def test_a_device_token_may_punch_and_the_source_is_not_client_controlled(client, tenants):
    """§7: punch endpoints accept a device token *or* a user JWT."""
    acme, _ = tenants
    raw = "device-token-for-the-punch-test"
    with SessionLocal() as db:
        db.add(
            Device(
                id=uuid.uuid4(), org_id=acme.id, user_id=acme.employee.id,
                machine_id="m-1", hostname="laptop", os="windows",
                token_hash=token_digest(raw), is_active=True,
            )
        )
        db.commit()

    response = client.post(
        "/api/v1/attendance/punch/in",
        json={"source": "web"},
        headers={"Authorization": f"Bearer {raw}", "X-Org-Slug": acme.slug},
    )
    assert response.status_code == 201, response.text
    # The body asked for "web"; the credential says otherwise and wins.
    assert response.json()["record"]["check_in_source"] == PunchSource.AGENT_SESSION.value


def test_an_unauthenticated_punch_is_refused(client, tenants):
    acme, _ = tenants
    response = client.post(
        "/api/v1/attendance/punch/in", json={},
        headers={"Authorization": "Bearer nonsense", "X-Org-Slug": acme.slug},
    )
    assert response.status_code == 401


# --------------------------------------------------------------------------- #
# 4. The nightly status job (D-003, D-007, D-010, D-020)
# --------------------------------------------------------------------------- #


def _run_job_for(day: date) -> dict:
    """Run the hourly job at a moment whose org-local hour is the target one.

    Organisations default to UTC in the fixtures and
    ``ATTENDANCE_STATUS_JOB_HOUR_LOCAL`` defaults to 0, so 00:30 UTC on the day
    *after* ``day`` is the window in which ``day`` gets finalised.
    """
    return svc.stamp_statuses_for_local_hour(
        datetime.combine(day + timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc)
        + timedelta(minutes=30)
    )


def test_job_only_acts_inside_the_org_local_window(tenants, weekday_schedule):
    """D-003(a): hourly wake-up, act only where local time is in the window."""
    noon = datetime.combine(WORKDAY + timedelta(days=1), datetime.min.time(),
                            tzinfo=timezone.utc) + timedelta(hours=12)
    totals = svc.stamp_statuses_for_local_hour(noon)
    assert totals["orgs_considered"] == 2
    assert totals["orgs_stamped"] == 0

    with SessionLocal() as db:
        assert db.scalars(select(AttendanceRecord)).all() == []


def test_job_marks_a_missing_working_day_absent(tenants, weekday_schedule):
    acme, _ = tenants
    totals = _run_job_for(WORKDAY)
    assert totals["orgs_stamped"] == 2

    with SessionLocal() as db:
        row = db.scalar(
            select(AttendanceRecord).where(
                AttendanceRecord.org_id == acme.id,
                AttendanceRecord.user_id == acme.employee.id,
                AttendanceRecord.date == WORKDAY,
            )
        )
        assert row is not None
        # D-020: the created row states its status; it does not inherit `present`.
        assert row.status == AttendanceStatus.ABSENT.value
        assert row.worked_minutes == 0


def test_job_marks_a_non_working_day_weekly_off(tenants, weekday_schedule):
    acme, _ = tenants
    _run_job_for(SUNDAY)
    with SessionLocal() as db:
        row = db.scalar(
            select(AttendanceRecord).where(
                AttendanceRecord.org_id == acme.id,
                AttendanceRecord.user_id == acme.employee.id,
                AttendanceRecord.date == SUNDAY,
            )
        )
        assert row.status == AttendanceStatus.WEEKLY_OFF.value


def test_job_classifies_a_full_day_present_and_a_short_day_half(tenants, weekday_schedule):
    acme, _ = tenants
    morning = datetime(2024, 3, 13, 3, 30, tzinfo=timezone.utc)
    _record(
        acme.id, acme.employee.id, WORKDAY,
        check_in_at=morning, check_out_at=morning + timedelta(hours=8),
        check_in_source="web", check_out_source="web",
    )
    _record(
        acme.id, acme.owner.id, WORKDAY,
        check_in_at=morning, check_out_at=morning + timedelta(hours=3),
        check_in_source="web", check_out_source="web",
    )

    _run_job_for(WORKDAY)

    with SessionLocal() as db:
        rows = {
            row.user_id: row
            for row in db.scalars(
                select(AttendanceRecord).where(
                    AttendanceRecord.org_id == acme.id, AttendanceRecord.date == WORKDAY
                )
            ).all()
        }
        assert rows[acme.employee.id].status == AttendanceStatus.PRESENT.value
        assert rows[acme.employee.id].worked_minutes == 480
        assert rows[acme.owner.id].status == AttendanceStatus.HALF_DAY.value
        assert rows[acme.owner.id].worked_minutes == 180


def test_job_marks_a_company_holiday(tenants, weekday_schedule):
    acme, _ = tenants
    with SessionLocal() as db:
        db.add(
            Holiday(id=uuid.uuid4(), org_id=acme.id, holiday_date=WORKDAY,
                    name="Holi", is_optional=False, is_active=True)
        )
        db.commit()

    _run_job_for(WORKDAY)
    with SessionLocal() as db:
        row = db.scalar(
            select(AttendanceRecord).where(
                AttendanceRecord.org_id == acme.id,
                AttendanceRecord.user_id == acme.employee.id,
            )
        )
        assert row.status == AttendanceStatus.HOLIDAY.value


def test_job_is_idempotent(tenants, weekday_schedule):
    acme, _ = tenants
    _run_job_for(WORKDAY)
    second = _run_job_for(WORKDAY)
    assert second["created"] == 0
    assert second["updated"] == 0
    assert second["unchanged"] >= 2


def test_job_never_overwrites_a_regularized_row(tenants, weekday_schedule):
    """**D-007.** A human decision outranks a derived one.

    The row below is deliberately inconsistent with what the job would compute —
    eight hours of punches classified ``half_day`` with ``worked_minutes`` of 0 —
    so that "left alone" is distinguishable from "recomputed to the same value".
    """
    acme, _ = tenants
    morning = datetime(2024, 3, 13, 3, 30, tzinfo=timezone.utc)
    _record(
        acme.id, acme.employee.id, WORKDAY,
        check_in_at=morning, check_out_at=morning + timedelta(hours=8),
        check_in_source=PunchSource.REGULARIZED.value,
        check_out_source=PunchSource.REGULARIZED.value,
        status=AttendanceStatus.HALF_DAY.value,
        worked_minutes=0,
    )

    totals = _run_job_for(WORKDAY)
    assert totals["skipped_regularized"] == 1

    with SessionLocal() as db:
        row = db.scalar(
            select(AttendanceRecord).where(
                AttendanceRecord.org_id == acme.id,
                AttendanceRecord.user_id == acme.employee.id,
                AttendanceRecord.date == WORKDAY,
            )
        )
        assert row.status == AttendanceStatus.HALF_DAY.value
        assert row.worked_minutes == 0


def test_a_punch_cannot_overwrite_a_regularized_day_either(client, tenants):
    acme, _ = tenants
    today = date.today()
    _record(
        acme.id, acme.employee.id, today,
        check_in_at=datetime.now(timezone.utc) - timedelta(hours=2),
        check_in_source=PunchSource.REGULARIZED.value,
    )
    response = client.post("/api/v1/attendance/punch/in", json={},
                           headers=acme.headers(acme.employee_token))
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "day_regularized"


# --------------------------------------------------------------------------- #
# 5. D-014 — 'required' with no offices locks the tenant out
# --------------------------------------------------------------------------- #


def test_required_is_refused_when_the_org_has_no_active_locations(client, tenants):
    """**D-014**, with a typed error the console can render into a fix."""
    acme, _ = tenants
    response = client.put(
        "/api/v1/attendance/settings",
        json={"geofence_enforcement": "required"},
        headers=acme.headers(),
    )
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["reason"] == "geofence_required_without_locations"
    assert detail["active_location_count"] == 0

    with SessionLocal() as db:
        assert db.get(AttendanceSettings, acme.id) is None


def test_required_is_allowed_once_a_location_exists(client, tenants, office):
    acme, _ = tenants
    response = client.put(
        "/api/v1/attendance/settings",
        json={"geofence_enforcement": "required"},
        headers=acme.headers(),
    )
    assert response.status_code == 200, response.text
    assert response.json()["geofence_enforcement"] == "required"
    assert response.json()["active_location_count"] == 1


def test_the_last_active_location_cannot_be_removed_under_required(client, tenants, office):
    """The same lockout, one screen further away — see ``_guard_last_active_location``."""
    acme, _ = tenants
    _set_enforcement(acme.id, "required")

    deleted = client.delete(f"/api/v1/attendance/locations/{office}", headers=acme.headers())
    assert deleted.status_code == 409
    assert deleted.json()["detail"]["reason"] == "last_active_location"

    deactivated = client.patch(
        f"/api/v1/attendance/locations/{office}",
        json={"name": "Whitefield", "lat": 12.9698, "lng": 77.75, "is_active": False},
        headers=acme.headers(),
    )
    assert deactivated.status_code == 409


def test_missing_settings_row_reads_as_the_default_and_stays_missing(client, tenants):
    """**D-009**: a GET resolves the default and never lazily inserts a row."""
    acme, _ = tenants
    response = client.get("/api/v1/attendance/settings", headers=acme.headers())
    assert response.status_code == 200
    assert response.json()["geofence_enforcement"] == "flag_only"

    with SessionLocal() as db:
        assert db.get(AttendanceSettings, acme.id) is None


# --------------------------------------------------------------------------- #
# 6. Shifts, the rota, and the read-time verdicts D-010 keeps out of the table
# --------------------------------------------------------------------------- #


@pytest.fixture
def day_shift(tenants):
    acme, _ = tenants
    with SessionLocal() as db:
        shift = Shift(
            id=uuid.uuid4(), org_id=acme.id, name="General",
            start_time="09:00", end_time="18:00", grace_minutes=15,
            half_day_threshold_minutes=240, is_night_shift=False, is_active=True,
        )
        db.add(shift)
        db.commit()
        return str(shift.id)


def test_late_and_early_out_are_computed_at_read_time_not_stored(
    client, tenants, day_shift, weekday_schedule
):
    """D-010: the verdicts are derived from the shift in force, never persisted."""
    acme, _ = tenants
    with SessionLocal() as db:
        db.add(
            ShiftAssignment(
                id=uuid.uuid4(), org_id=acme.id, user_id=acme.employee.id,
                shift_id=uuid.UUID(day_shift), effective_from=date(2024, 1, 1),
            )
        )
        db.commit()

    _record(
        acme.id, acme.employee.id, WORKDAY,
        check_in_at=datetime(2024, 3, 13, 9, 40, tzinfo=timezone.utc),
        check_out_at=datetime(2024, 3, 13, 17, 0, tzinfo=timezone.utc),
        check_in_source="web", check_out_source="web", worked_minutes=440,
    )

    response = client.get(
        "/api/v1/attendance/me",
        params={"start": WORKDAY.isoformat(), "end": WORKDAY.isoformat()},
        headers=acme.headers(acme.employee_token),
    )
    assert response.status_code == 200, response.text
    day = response.json()[0]
    assert day["shift_name"] == "General"
    assert day["is_late"] is True
    assert day["late_minutes"] == 40
    assert day["is_early_out"] is True
    assert day["early_out_minutes"] == 60

    # Nothing derived was written back to the row.
    with SessionLocal() as db:
        row = db.scalar(select(AttendanceRecord).where(AttendanceRecord.org_id == acme.id))
        assert not hasattr(row, "is_late")


def test_backdating_a_shift_assignment_restamps_the_affected_days(
    client, tenants, day_shift, weekday_schedule
):
    """D-010's consequence: a corrected rota must not leave stale half-days."""
    acme, _ = tenants
    # The most recent working day, not literally yesterday: `weekday_schedule` is
    # Mon-Fri, so on a Sunday "yesterday" is a Saturday the job correctly stamps
    # weekly_off, and the assertion below would fail for the right reason.
    yesterday = _last_weekday_before_today()
    _record(
        acme.id, acme.employee.id, yesterday,
        check_in_at=datetime.combine(yesterday, datetime.min.time(), tzinfo=timezone.utc)
        + timedelta(hours=9),
        check_out_at=datetime.combine(yesterday, datetime.min.time(), tzinfo=timezone.utc)
        + timedelta(hours=17),
        check_in_source="web", check_out_source="web",
        status=AttendanceStatus.HALF_DAY.value, worked_minutes=0,
    )

    response = client.post(
        "/api/v1/attendance/shift-assignments",
        json={
            "user_id": str(acme.employee.id),
            "shift_id": day_shift,
            "effective_from": (yesterday - timedelta(days=7)).isoformat(),
        },
        headers=acme.headers(),
    )
    assert response.status_code == 201, response.text

    with SessionLocal() as db:
        row = db.scalar(
            select(AttendanceRecord).where(
                AttendanceRecord.org_id == acme.id, AttendanceRecord.date == yesterday
            )
        )
        # Eight hours against a four-hour threshold: the stale half_day is gone.
        assert row.status == AttendanceStatus.PRESENT.value
        assert row.worked_minutes == 480

        # And a rota correction did not backfill a week of absences for the whole
        # company as a side effect — it re-derived the days that already existed.
        assert len(db.scalars(select(AttendanceRecord)).all()) == 1


def test_assigning_a_shift_closes_the_previous_open_row(client, tenants, day_shift):
    acme, _ = tenants
    with SessionLocal() as db:
        night = Shift(id=uuid.uuid4(), org_id=acme.id, name="Night",
                      start_time="22:00", end_time="06:00", is_night_shift=True)
        db.add(night)
        db.commit()
        night_id = str(night.id)

    client.post(
        "/api/v1/attendance/shift-assignments",
        json={"user_id": str(acme.employee.id), "shift_id": day_shift,
              "effective_from": "2024-01-01"},
        headers=acme.headers(),
    )
    client.post(
        "/api/v1/attendance/shift-assignments",
        json={"user_id": str(acme.employee.id), "shift_id": night_id,
              "effective_from": "2024-06-01"},
        headers=acme.headers(),
    )

    with SessionLocal() as db:
        rows = db.scalars(
            select(ShiftAssignment)
            .where(ShiftAssignment.org_id == acme.id)
            .order_by(ShiftAssignment.effective_from)
        ).all()
        assert len(rows) == 2
        assert rows[0].effective_to == date(2024, 5, 31)
        assert rows[1].effective_to is None

    # And the historical lookup still answers with the shift of the day.
    with SessionLocal() as db:
        assert svc.shift_on(db, acme.id, acme.employee.id, date(2024, 3, 1)).name == "General"
        assert svc.shift_on(db, acme.id, acme.employee.id, date(2024, 7, 1)).name == "Night"


def test_a_shift_with_rota_history_cannot_be_deleted(client, tenants, day_shift):
    acme, _ = tenants
    client.post(
        "/api/v1/attendance/shift-assignments",
        json={"user_id": str(acme.employee.id), "shift_id": day_shift,
              "effective_from": "2024-01-01"},
        headers=acme.headers(),
    )
    response = client.delete(f"/api/v1/attendance/shifts/{day_shift}", headers=acme.headers())
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "shift_in_use"


# --------------------------------------------------------------------------- #
# 7. Team view via the hierarchy service
# --------------------------------------------------------------------------- #


def test_team_view_covers_the_reporting_subtree(client, tenants, weekday_schedule):
    acme, _ = tenants
    _record(acme.id, acme.employee.id, WORKDAY, check_in_source="web",
            check_in_at=datetime(2024, 3, 13, 4, 0, tzinfo=timezone.utc))

    response = client.get(
        "/api/v1/attendance/team",
        params={"start": WORKDAY.isoformat(), "end": WORKDAY.isoformat()},
        headers=acme.headers(),
    )
    assert response.status_code == 200, response.text
    rows = response.json()
    assert len(rows) == 1
    assert rows[0]["user_id"] == str(acme.employee.id)
    assert rows[0]["user_name"] == acme.employee.full_name
    assert rows[0]["is_missing_punch"] is True


def test_an_employee_cannot_open_the_team_view(client, tenants):
    acme, _ = tenants
    response = client.get(
        "/api/v1/attendance/team", headers=acme.headers(acme.employee_token)
    )
    assert response.status_code == 403


# --------------------------------------------------------------------------- #
# 8. Tenant isolation — the question this product lives or dies on
# --------------------------------------------------------------------------- #


def test_a_token_from_one_tenant_cannot_punch_into_another(client, tenants):
    acme, globex = tenants
    response = client.post(
        "/api/v1/attendance/punch/in",
        json={},
        headers={
            "Authorization": f"Bearer {acme.employee_token}",
            "X-Org-Slug": globex.slug,
        },
    )
    assert response.status_code == 401

    with SessionLocal() as db:
        assert db.scalars(select(AttendanceRecord)).all() == []


def test_one_tenant_cannot_read_anothers_attendance(client, tenants):
    acme, globex = tenants
    foreign_id = _record(
        globex.id, globex.employee.id, WORKDAY,
        check_in_at=datetime(2024, 3, 13, 4, 0, tzinfo=timezone.utc), check_in_source="web",
    )

    listed = client.get(
        "/api/v1/attendance/team",
        params={"start": WORKDAY.isoformat(), "end": WORKDAY.isoformat()},
        headers=acme.headers(),
    )
    assert listed.status_code == 200
    assert listed.json() == []

    fetched = client.get(f"/api/v1/attendance/records/{foreign_id}", headers=acme.headers())
    assert fetched.status_code == 404


def test_one_tenant_cannot_see_or_edit_anothers_offices(client, tenants, office):
    acme, globex = tenants
    listed = client.get("/api/v1/attendance/locations", headers=globex.headers())
    assert listed.status_code == 200
    assert listed.json() == []

    patched = client.patch(
        f"/api/v1/attendance/locations/{office}",
        json={"name": "Stolen", "lat": 0.0, "lng": 0.0},
        headers=globex.headers(),
    )
    assert patched.status_code == 404

    deleted = client.delete(f"/api/v1/attendance/locations/{office}", headers=globex.headers())
    assert deleted.status_code == 404


def test_settings_are_per_tenant(client, tenants, office):
    acme, globex = tenants
    _set_enforcement(acme.id, "required")
    response = client.get("/api/v1/attendance/settings", headers=globex.headers())
    assert response.status_code == 200
    assert response.json()["geofence_enforcement"] == "flag_only"
    assert response.json()["active_location_count"] == 0


def test_office_locations_round_trip(client, tenants):
    acme, _ = tenants
    created = client.post(
        "/api/v1/attendance/locations",
        json={"name": "HQ", "lat": 12.9698, "lng": 77.75, "radius_m": 250},
        headers=acme.headers(),
    )
    assert created.status_code == 201, created.text
    assert created.json()["radius_m"] == 250

    duplicate = client.post(
        "/api/v1/attendance/locations",
        json={"name": "HQ", "lat": 12.9698, "lng": 77.75},
        headers=acme.headers(),
    )
    assert duplicate.status_code == 409

    location_id = created.json()["id"]
    deleted = client.delete(f"/api/v1/attendance/locations/{location_id}",
                            headers=acme.headers())
    assert deleted.status_code == 204
    with SessionLocal() as db:
        assert db.scalars(select(OfficeLocation)).all() == []


def test_today_is_null_before_the_first_punch_and_a_row_after_it(client, tenants):
    """A synthesised empty day would be indistinguishable from a stamped absence."""
    acme, _ = tenants
    before = client.get("/api/v1/attendance/me/today", headers=acme.headers(acme.employee_token))
    assert before.status_code == 200
    assert before.json() is None

    client.post("/api/v1/attendance/punch/in", json={},
                headers=acme.headers(acme.employee_token))
    after = client.get("/api/v1/attendance/me/today", headers=acme.headers(acme.employee_token))
    assert after.status_code == 200
    assert after.json()["check_in_at"] is not None


def test_punch_out_closes_yesterdays_open_night_shift_row(client, tenants):
    """A night shift's attendance day is the date it *started* — see the model."""
    acme, _ = tenants
    yesterday = date.today() - timedelta(days=1)
    _record(
        acme.id, acme.employee.id, yesterday,
        check_in_at=datetime.now(timezone.utc) - timedelta(hours=8),
        check_in_source="web",
    )

    response = client.post("/api/v1/attendance/punch/out", json={},
                           headers=acme.headers(acme.employee_token))
    assert response.status_code == 200, response.text
    assert response.json()["record"]["date"] == yesterday.isoformat()

    with SessionLocal() as db:
        rows = db.scalars(select(AttendanceRecord).where(AttendanceRecord.org_id == acme.id)).all()
        assert len(rows) == 1
        assert rows[0].worked_minutes == pytest.approx(480, abs=2)


def test_recompute_refuses_a_range_that_has_not_ended(client, tenants, weekday_schedule):
    acme, _ = tenants
    response = client.post(
        "/api/v1/attendance/recompute",
        params={"start": date.today().isoformat(), "end": date.today().isoformat()},
        headers=acme.headers(),
    )
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "future_range"


def test_recompute_stamps_a_past_range_for_this_org_only(client, tenants, weekday_schedule):
    acme, globex = tenants
    response = client.post(
        "/api/v1/attendance/recompute",
        params={"start": WORKDAY.isoformat(), "end": WORKDAY.isoformat()},
        headers=acme.headers(),
    )
    assert response.status_code == 200, response.text
    assert response.json()["created"] == 2

    with SessionLocal() as db:
        assert (
            db.scalars(
                select(AttendanceRecord).where(AttendanceRecord.org_id == globex.id)
            ).all()
            == []
        )


def test_shifts_round_trip_and_expose_the_specs_hours_field(client, tenants):
    acme, _ = tenants
    created = client.post(
        "/api/v1/attendance/shifts",
        json={"name": "General", "start_time": "09:00", "end_time": "18:00",
              "half_day_threshold_minutes": 270},
        headers=acme.headers(),
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["half_day_threshold_hours"] == 4.5
    assert body["expected_minutes"] == 540

    listed = client.get("/api/v1/attendance/shifts", headers=acme.headers())
    assert listed.status_code == 200
    assert [s["name"] for s in listed.json()] == ["General"]

    duplicate = client.post(
        "/api/v1/attendance/shifts", json={"name": "General"}, headers=acme.headers()
    )
    assert duplicate.status_code == 409


def test_an_employee_cannot_create_an_office_location(client, tenants):
    acme, _ = tenants
    response = client.post(
        "/api/v1/attendance/locations",
        json={"name": "Mine", "lat": 0.0, "lng": 0.0},
        headers=acme.headers(acme.employee_token),
    )
    assert response.status_code == 403
