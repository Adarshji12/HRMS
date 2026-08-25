"""Phase 2 — regularization: what approval writes, and what rejection must not.

The phase criterion is one sentence: *a rejected or approved request correctly
does or does not mutate ``attendance_records``, and the employee gets exactly
one email either way.* Every test here is that sentence or one of the rulings
that make it implementable.

Four failures this module exists to catch, none of which a mocked session would
show, which is why — per ``conftest.py`` — everything runs against the real app
and a real temporary database:

* **A silently fabricated attendance record (D-020).** ``status`` defaults to
  ``present``, so an approval that creates a row for a wholly-missed day and
  forgets to set it produces a fabricated day, marked present, with no punches
  on it — manufactured by the feature whose entire purpose is correcting
  attendance honestly. The assertion is not "status is not null"; it is that a
  two-hour regularised day reads ``half_day`` and a regularised Sunday reads
  ``weekly_off``, both of which a defaulted column gets wrong.
* **A 500 where a 409 belongs (D-027).** The one-pending-per-day rule lives in a
  partial unique index, so the duplicate arrives as an ``IntegrityError`` from
  the driver. Unhandled, it is indistinguishable from a broken server, and the
  console has nothing to render.
* **An unattributable attendance edit (D-021).** There is no ``updated_at``
  anywhere in this repository, so without an ``AuditLog`` row a corrected
  ``check_out_at`` records nothing about when it was corrected.
* **A rejection that mutates anything at all.** The whole point of saying no.

The router is mounted by a fixture when the lead has not wired it in yet, for
the reason ``test_hrms_helpdesk.py`` gives: a suite that is entirely 404s has
verified nothing. ``test_router_is_registered_for_integration`` checks the seam
separately, against the router module, so the shim can never hide it.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.core.security import create_access_token, generate_enrollment_key, hash_password
from app.db.session import SessionLocal
from app.models import (
    AttendanceRecord,
    AttendanceStatus,
    AuditLog,
    Holiday,
    NotificationLog,
    NotificationPreference,
    Organization,
    PunchSource,
    RegularizationRequest,
    RegularizationStatus,
    User,
)
from app.services import attendance as attendance_svc
from app.services import notifications as notif

BASE = "/api/v1/regularization"

#: A Wednesday, and the Sunday of the same week. Fixed in the past rather than
#: derived from "today", so a run on a Saturday cannot change what weekly-off
#: means and the future-date guard never fires by accident.
WORKDAY = date(2024, 3, 13)
SUNDAY = date(2024, 3, 17)


@pytest.fixture(scope="module", autouse=True)
def _regularization_router_mounted():
    """Mount the router if ``api/v1/router.py`` does not include it yet."""
    from app.api.v1 import regularization as regularization_api
    from app.main import app

    if not any(getattr(r, "path", "").startswith(BASE) for r in app.routes):
        app.include_router(regularization_api.router, prefix="/api/v1")
        app.openapi_schema = None
    yield


def test_router_is_registered_for_integration():
    """Fails until the lead adds regularization to ``api/v1/router.py``. Deliberate."""
    from app.api.v1.router import api_router

    paths = {getattr(route, "path", "") for route in api_router.routes}
    assert any(path.startswith(BASE) for path in paths), (
        "app/api/v1/router.py does not include regularization.router — see the "
        "Phase 2 integration request"
    )


# --------------------------------------------------------------------------- #
# Cast
# --------------------------------------------------------------------------- #


class Person:
    def __init__(self, user: User, slug: str) -> None:
        self.id = user.id
        self.name = user.full_name
        self.token = create_access_token(
            str(user.id), {"typ": "user", "org": str(user.org_id), "role": user.role}
        )
        self.slug = slug

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}", "X-Org-Slug": self.slug}


@pytest.fixture
def cast(tenants):
    """Acme with a real reporting line, plus somebody deliberately outside it.

    ``outsider`` reports to the owner rather than to ``mgr``, which is the only
    shape that can express the question §2.5 actually asks: not "may a manager
    approve", but "may a manager approve *this* person". A fixture where every
    employee reports to the one manager passes a subtree check that filters
    nothing.
    """
    acme, globex = tenants
    with SessionLocal() as db:
        def make(org_id, slug, email, role, name, manager_id=None):
            user = User(
                id=uuid.uuid4(), org_id=org_id, email=email, full_name=name, role=role,
                password_hash=hash_password("correct-horse-battery"), is_active=True,
                enrollment_key=generate_enrollment_key(), manager_id=manager_id,
            )
            db.add(user)
            db.flush()
            return Person(user, slug)

        mgr = make(acme.id, acme.slug, "mgr@acme.test", "manager", "Acme Manager",
                   manager_id=acme.owner.id)
        report = make(acme.id, acme.slug, "report@acme.test", "employee", "Acme Report",
                      manager_id=mgr.id)
        outsider = make(acme.id, acme.slug, "outsider@acme.test", "employee",
                        "Acme Outsider", manager_id=acme.owner.id)
        other = make(globex.id, globex.slug, "staff2@globex.test", "employee",
                     "Globex Staff", manager_id=globex.owner.id)
        db.commit()

    return {
        "acme": acme,
        "globex": globex,
        "owner": Person(_reload(acme.owner.id), acme.slug),
        "globex_owner": Person(_reload(globex.owner.id), globex.slug),
        "mgr": mgr,
        "report": report,
        "outsider": outsider,
        "globex_staff": other,
    }


def _reload(user_id: uuid.UUID) -> User:
    with SessionLocal() as db:
        return db.get(User, user_id)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _at(day: date, hour: int, minute: int = 0) -> datetime:
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=timezone.utc)


def _file(client, person: Person, *, day: date = WORKDAY, check_in=None, check_out=None,
          reason="I was on a client site and never punched.", path=None, **extra) -> dict:
    body: dict = {"date": day.isoformat(), "reason": reason}
    if check_in is not None:
        body["requested_check_in"] = check_in.isoformat()
    if check_out is not None:
        body["requested_check_out"] = check_out.isoformat()
    body.update(extra)
    return client.post(path or BASE, json=body, headers=person.headers)


def _decide(client, person: Person, request_id, decision: str, note: str | None = None):
    return client.post(
        f"{BASE}/{request_id}/review",
        json={"status": decision, "review_note": note},
        headers=person.headers,
    )


def _record(user_id: uuid.UUID, day: date = WORKDAY) -> AttendanceRecord | None:
    with SessionLocal() as db:
        return db.scalar(
            select(AttendanceRecord).where(
                AttendanceRecord.user_id == user_id, AttendanceRecord.date == day
            )
        )


def _seed_record(org_id, user_id, day: date, **overrides) -> uuid.UUID:
    """An ordinary punched day, so the update path has something real to update."""
    values = {
        "check_in_at": _at(day, 9),
        "check_in_source": PunchSource.WEB.value,
        "is_geo_verified_in": True,
        "check_in_lat": 12.9698,
        "check_in_lng": 77.75,
        "check_in_distance_m": 40,
        "status": AttendanceStatus.PRESENT.value,
        "worked_minutes": 0,
        "note": "client site visit",
    }
    values.update(overrides)
    with SessionLocal() as db:
        row = AttendanceRecord(org_id=org_id, user_id=user_id, date=day, **values)
        db.add(row)
        db.commit()
        return row.id


def _set_flag(user_id: uuid.UUID, value: bool) -> None:
    with SessionLocal() as db:
        db.get(User, user_id).can_approve_regularization = value
        db.commit()


def _decided_mail(user_id: uuid.UUID) -> list[NotificationLog]:
    with SessionLocal() as db:
        return list(
            db.scalars(
                select(NotificationLog).where(
                    NotificationLog.user_id == user_id,
                    NotificationLog.kind == notif.Kind.REGULARIZATION_DECIDED.value,
                )
            ).all()
        )


# --------------------------------------------------------------------------- #
# D-007 / D-020 — approval owns the row, and states its status
# --------------------------------------------------------------------------- #


def test_approval_creates_the_attendance_row_for_a_wholly_missed_day(client, cast):
    """D-007. There is no row to update, so approval creates one or does nothing."""
    assert _record(cast["report"].id) is None

    filed = _file(client, cast["report"], check_in=_at(WORKDAY, 9), check_out=_at(WORKDAY, 18))
    assert filed.status_code == 201, filed.text

    decided = _decide(client, cast["mgr"], filed.json()["id"], "approved", "confirmed")
    assert decided.status_code == 200, decided.text

    record = _record(cast["report"].id)
    assert record is not None, (
        "D-007: approval must CREATE the attendance row for a day that has none — "
        "otherwise a wholly-missed day is approved and nothing is corrected"
    )
    assert record.check_in_source == PunchSource.REGULARIZED.value
    assert record.check_out_source == PunchSource.REGULARIZED.value
    assert record.worked_minutes == 540
    assert record.regularization_id == uuid.UUID(filed.json()["id"])


def test_a_regularized_missed_day_is_never_left_present_by_default(client, cast):
    """D-020, and the reason it is a test rather than a comment.

    Two worked hours is a half day under the 240-minute default threshold. A
    service that creates the row and leaves ``status`` to the column default
    stores ``present`` here, and a fabricated present day is exactly what the
    ruling exists to prevent. Asserting on a full 09:00–18:00 day could not
    catch it, because ``present`` is the right answer there.
    """
    filed = _file(client, cast["report"], check_in=_at(WORKDAY, 9), check_out=_at(WORKDAY, 11))
    assert _decide(client, cast["mgr"], filed.json()["id"], "approved").status_code == 200

    record = _record(cast["report"].id)
    assert record.status == AttendanceStatus.HALF_DAY.value, (
        "D-020: the created row inherited the column's 'present' default instead "
        f"of being classified — got {record.status!r} for a two-hour day"
    )
    assert record.worked_minutes == 120


def test_a_regularized_weekly_off_keeps_its_calendar_status(client, cast):
    """The calendar outranks the punches, on this path as on every other.

    Sunday with no work schedule configured is a weekly off, and it stays one
    even though somebody demonstrably worked — with ``worked_minutes`` intact,
    which is the whole basis of Phase 4's comp-off rule ("status is weekly_off
    or holiday *and* worked_minutes > 0"). A locally invented classifier that
    only knew about punches would write ``present`` and quietly make comp-off
    inexpressible for regularised days.
    """
    filed = _file(client, cast["report"], day=SUNDAY,
                  check_in=_at(SUNDAY, 10), check_out=_at(SUNDAY, 15))
    assert _decide(client, cast["mgr"], filed.json()["id"], "approved").status_code == 200

    record = _record(cast["report"].id, SUNDAY)
    assert record.status == AttendanceStatus.WEEKLY_OFF.value
    assert record.worked_minutes == 300


def test_a_regularized_public_holiday_reads_holiday(client, cast):
    """Same precedence, through the holiday calendar rather than the schedule."""
    with SessionLocal() as db:
        db.add(Holiday(org_id=cast["acme"].id, name="Holi", holiday_date=WORKDAY))
        db.commit()

    filed = _file(client, cast["report"], check_in=_at(WORKDAY, 9), check_out=_at(WORKDAY, 18))
    assert _decide(client, cast["mgr"], filed.json()["id"], "approved").status_code == 200
    assert _record(cast["report"].id).status == AttendanceStatus.HOLIDAY.value


def test_approval_corrects_a_missing_check_out_without_touching_the_real_punch(
    client, cast
):
    """The common request: the morning punch is real and must survive intact.

    Stamping ``regularized`` over a check-in nobody disputed would destroy real
    evidence in order to fix a different problem — and would then make the
    nightly job skip a day it should still have been classifying on its own.
    """
    _seed_record(cast["acme"].id, cast["report"].id, WORKDAY)

    filed = _file(client, cast["report"], check_out=_at(WORKDAY, 18, 30))
    assert _decide(client, cast["mgr"], filed.json()["id"], "approved").status_code == 200

    record = _record(cast["report"].id)
    assert record.check_in_source == PunchSource.WEB.value
    assert record.is_geo_verified_in is True
    assert record.check_in_lat == pytest.approx(12.9698)
    assert record.check_out_source == PunchSource.REGULARIZED.value
    # The corrected half carries no location evidence, and must not claim any:
    # a coordinate taken at some other moment is not proof of an 18:30 exit.
    assert record.is_geo_verified_out is False
    assert record.check_out_lat is None
    assert record.worked_minutes == 570


def test_the_nightly_job_will_not_overwrite_what_approval_wrote(client, cast):
    """D-007's other half, asserted from this side of the seam.

    The write-back is only safe because ``stamp_org_day`` skips a row sourced
    ``regularized``. If a future edit here stopped setting that source, the
    nightly run would silently re-derive the day and the correction would vanish
    overnight — the failure would surface as a support ticket, not as a test.
    """
    filed = _file(client, cast["report"], check_in=_at(WORKDAY, 9), check_out=_at(WORKDAY, 11))
    assert _decide(client, cast["mgr"], filed.json()["id"], "approved").status_code == 200

    with SessionLocal() as db:
        org = db.get(Organization, cast["acme"].id)
        result = attendance_svc.stamp_org_day(db, org, WORKDAY)
        db.commit()
    assert result["skipped_regularized"] >= 1
    assert _record(cast["report"].id).status == AttendanceStatus.HALF_DAY.value


# --------------------------------------------------------------------------- #
# D-006 — re-filing against an already-approved day
# --------------------------------------------------------------------------- #


def test_a_second_approval_reoverwrites_the_row_and_repoints_the_pointer(client, cast):
    """D-006: correcting a bad correction is legitimate.

    And the pointer is a pointer. After the second approval
    ``regularization_id`` names only the newest request — which is exactly why
    nothing may follow that FK and call the result an audit trail. The durable
    history is the two rows in ``regularization_requests``.
    """
    first = _file(client, cast["report"], check_in=_at(WORKDAY, 9), check_out=_at(WORKDAY, 18))
    assert _decide(client, cast["mgr"], first.json()["id"], "approved").status_code == 200
    assert _record(cast["report"].id).worked_minutes == 540

    second = _file(client, cast["report"], check_in=_at(WORKDAY, 9), check_out=_at(WORKDAY, 13),
                   reason="Actually I left at one.")
    assert second.status_code == 201, second.text
    assert _decide(client, cast["mgr"], second.json()["id"], "approved").status_code == 200

    record = _record(cast["report"].id)
    assert record.worked_minutes == 240
    assert record.regularization_id == uuid.UUID(second.json()["id"])

    with SessionLocal() as db:
        history = db.scalars(
            select(RegularizationRequest).where(
                RegularizationRequest.user_id == cast["report"].id
            )
        ).all()
    assert len(history) == 2
    assert all(r.status == RegularizationStatus.APPROVED.value for r in history), (
        "the first approval must survive as history — D-006 is explicit that the "
        "pointer moving on does not erase the decision it moved off"
    )


# --------------------------------------------------------------------------- #
# Rejection mutates nothing
# --------------------------------------------------------------------------- #


def test_rejection_leaves_the_original_attendance_row_untouched(client, cast):
    _seed_record(cast["acme"].id, cast["report"].id, WORKDAY)

    filed = _file(client, cast["report"], check_out=_at(WORKDAY, 23, 55))
    rejected = _decide(client, cast["mgr"], filed.json()["id"], "rejected",
                       "You badged out at 18:00; ask IT for the door log.")
    assert rejected.status_code == 200, rejected.text
    assert rejected.json()["status"] == RegularizationStatus.REJECTED.value

    record = _record(cast["report"].id)
    assert record.check_out_at is None
    assert record.check_out_source is None
    assert record.check_in_source == PunchSource.WEB.value
    assert record.status == AttendanceStatus.PRESENT.value
    assert record.worked_minutes == 0
    assert record.regularization_id is None
    assert record.note == "client site visit"


def test_rejecting_a_wholly_missed_day_creates_no_row_at_all(client, cast):
    """The inverse: a no is not a quiet yes with different fields."""
    filed = _file(client, cast["report"], check_in=_at(WORKDAY, 9), check_out=_at(WORKDAY, 18))
    assert _decide(client, cast["mgr"], filed.json()["id"], "rejected", "no").status_code == 200
    assert _record(cast["report"].id) is None


def test_a_rejection_without_a_reason_is_refused(client, cast):
    """A no with no reason guarantees the identical request comes back tomorrow."""
    filed = _file(client, cast["report"], check_in=_at(WORKDAY, 9))
    refused = _decide(client, cast["mgr"], filed.json()["id"], "rejected", "   ")
    assert refused.status_code == 422
    assert refused.json()["detail"]["reason"] == "note_required"


def test_a_decided_request_cannot_be_decided_again(client, cast):
    filed = _file(client, cast["report"], check_in=_at(WORKDAY, 9), check_out=_at(WORKDAY, 18))
    assert _decide(client, cast["mgr"], filed.json()["id"], "approved").status_code == 200

    again = _decide(client, cast["mgr"], filed.json()["id"], "rejected", "changed my mind")
    assert again.status_code == 409
    assert again.json()["detail"]["reason"] == "already_decided"
    # And the first decision's write-back is still standing.
    assert _record(cast["report"].id).worked_minutes == 540


# --------------------------------------------------------------------------- #
# The alert: exactly one, and not switchable off
# --------------------------------------------------------------------------- #


def test_exactly_one_decision_alert_per_decision(client, cast):
    filed = _file(client, cast["report"], check_in=_at(WORKDAY, 9), check_out=_at(WORKDAY, 18))
    assert _decide(client, cast["mgr"], filed.json()["id"], "approved", "ok").status_code == 200
    assert len(_decided_mail(cast["report"].id)) == 1

    # A double-clicked decision is refused, and must not have mailed on its way
    # out either — the count is the assertion, not the status code.
    _decide(client, cast["mgr"], filed.json()["id"], "approved", "ok")
    assert len(_decided_mail(cast["report"].id)) == 1


def test_a_rejection_also_tells_the_employee_exactly_once(client, cast):
    filed = _file(client, cast["report"], check_in=_at(WORKDAY, 9))
    assert _decide(client, cast["mgr"], filed.json()["id"], "rejected", "no").status_code == 200
    sent = _decided_mail(cast["report"].id)
    assert len(sent) == 1
    assert "rejected" in sent[0].subject


def test_the_decision_alert_ignores_an_opt_out(client, cast):
    """Non-optional (§2.5). It is the only notice that your record was rewritten.

    Stored preference set to off, deliberately: ``dispatch`` reads preferences
    for every optional kind, so a kind wrongly registered as optional would pass
    every other test in this file and fail only here.
    """
    with SessionLocal() as db:
        db.add(
            NotificationPreference(
                org_id=cast["acme"].id,
                user_id=cast["report"].id,
                kind=notif.Kind.REGULARIZATION_DECIDED.value,
                email_enabled=False,
            )
        )
        db.commit()

    filed = _file(client, cast["report"], check_in=_at(WORKDAY, 9), check_out=_at(WORKDAY, 18))
    assert _decide(client, cast["mgr"], filed.json()["id"], "approved", "ok").status_code == 200
    assert len(_decided_mail(cast["report"].id)) == 1, (
        "regularization_decided must be non-optional — an employee cannot be "
        "opted out of being told their own attendance record was rewritten"
    )


def test_the_manager_is_told_when_a_request_is_filed(client, cast):
    _file(client, cast["report"], check_in=_at(WORKDAY, 9), check_out=_at(WORKDAY, 18))
    with SessionLocal() as db:
        sent = db.scalars(
            select(NotificationLog).where(
                NotificationLog.kind == notif.Kind.REGULARIZATION_SUBMITTED.value
            )
        ).all()
    assert [row.user_id for row in sent] == [cast["mgr"].id], (
        "the submitted alert went somewhere other than the employee's own manager"
    )


# --------------------------------------------------------------------------- #
# D-027 — the partial unique index, and what the API makes of it
# --------------------------------------------------------------------------- #


def test_a_second_pending_request_for_the_same_day_is_a_typed_409(client, cast):
    """Not a 500. The rule is a database index, so the refusal arrives as an
    ``IntegrityError`` from the driver; unhandled, it is indistinguishable from
    a broken server and the console has nothing to render."""
    first = _file(client, cast["report"], check_in=_at(WORKDAY, 9))
    assert first.status_code == 201, first.text

    second = _file(client, cast["report"], check_out=_at(WORKDAY, 18))
    assert second.status_code == 409, (
        f"expected a typed 409 from the partial unique index, got "
        f"{second.status_code}: {second.text}"
    )
    assert second.json()["detail"]["reason"] == "pending_request_exists"

    with SessionLocal() as db:
        count = len(
            db.scalars(
                select(RegularizationRequest).where(
                    RegularizationRequest.user_id == cast["report"].id
                )
            ).all()
        )
    assert count == 1


def test_refiling_after_a_rejection_is_accepted(client, cast):
    """The case a plain UniqueConstraint would have broken (D-005).

    Somebody explains themselves badly, gets a no, and asks again with the real
    reason. Uniqueness scoped to ``status='pending'`` is what keeps the rejected
    row as history while allowing the second attempt.
    """
    first = _file(client, cast["report"], check_in=_at(WORKDAY, 9))
    assert _decide(client, cast["mgr"], first.json()["id"], "rejected", "why?").status_code == 200

    second = _file(client, cast["report"], check_in=_at(WORKDAY, 9),
                   reason="Site badge log attached, I arrived at nine.")
    assert second.status_code == 201, second.text


def test_two_people_may_have_a_pending_request_on_the_same_day(client, cast):
    """The index is per person, not per day — the obvious over-broad mistake."""
    assert _file(client, cast["report"], check_in=_at(WORKDAY, 9)).status_code == 201
    assert _file(client, cast["outsider"], check_in=_at(WORKDAY, 9)).status_code == 201


# --------------------------------------------------------------------------- #
# D-021 — the attendance write-back is audited
# --------------------------------------------------------------------------- #


def test_every_attendance_write_back_writes_an_audit_row(client, cast):
    """There is no ``updated_at`` (D-018), so this row is the only record of when.

    The before/after payload matters as much as the row's existence: a corrected
    ``check_out_at`` whose audit entry does not say what it used to be cannot
    answer a payroll dispute, which is the only situation anybody reads it in.
    """
    _seed_record(cast["acme"].id, cast["report"].id, WORKDAY)
    filed = _file(client, cast["report"], check_out=_at(WORKDAY, 18))
    assert _decide(client, cast["mgr"], filed.json()["id"], "approved", "ok").status_code == 200

    record = _record(cast["report"].id)
    with SessionLocal() as db:
        rows = db.scalars(
            select(AuditLog).where(AuditLog.action == "regularization.attendance_written")
        ).all()
        assert len(rows) == 1, "D-021: the attendance write-back was not audited"
        entry = rows[0]
        assert entry.org_id == cast["acme"].id
        assert entry.actor_user_id == cast["mgr"].id
        assert entry.target_type == "attendance_record"
        assert entry.target_id == str(record.id)
        assert entry.created_at is not None
        assert entry.detail["created"] is False
        assert entry.detail["before"]["check_out_at"] is None
        assert entry.detail["after"]["check_out_at"] is not None
        assert entry.detail["regularization_id"] == filed.json()["id"]


def test_a_created_row_is_audited_as_a_creation(client, cast):
    filed = _file(client, cast["report"], check_in=_at(WORKDAY, 9), check_out=_at(WORKDAY, 18))
    assert _decide(client, cast["mgr"], filed.json()["id"], "approved").status_code == 200
    with SessionLocal() as db:
        entry = db.scalars(
            select(AuditLog).where(AuditLog.action == "regularization.attendance_written")
        ).one()
    assert entry.detail["created"] is True
    assert entry.detail["before"] == {}


def test_a_rejection_writes_no_attendance_audit_row(client, cast):
    """Symmetry with the row itself: nothing was written, so nothing is recorded."""
    filed = _file(client, cast["report"], check_in=_at(WORKDAY, 9))
    assert _decide(client, cast["mgr"], filed.json()["id"], "rejected", "no").status_code == 200
    with SessionLocal() as db:
        rows = db.scalars(
            select(AuditLog).where(AuditLog.action == "regularization.attendance_written")
        ).all()
    assert rows == []


# --------------------------------------------------------------------------- #
# Scope and permission
# --------------------------------------------------------------------------- #


def test_the_review_queue_is_the_reporting_subtree(client, cast):
    _file(client, cast["report"], check_in=_at(WORKDAY, 9))
    _file(client, cast["outsider"], check_in=_at(WORKDAY, 9))

    queue = client.get(f"{BASE}/review", headers=cast["mgr"].headers)
    assert queue.status_code == 200, queue.text
    assert [row["user_id"] for row in queue.json()] == [str(cast["report"].id)], (
        "the queue is not the hierarchy subtree — the outsider reports to the "
        "owner, not to this manager"
    )

    # The administrator's scope is the whole organisation, and it comes from the
    # hierarchy service rather than from a role check written in this module.
    everything = client.get(f"{BASE}/review", headers=cast["owner"].headers)
    assert {row["user_id"] for row in everything.json()} == {
        str(cast["report"].id), str(cast["outsider"].id)
    }


def test_a_manager_cannot_decide_outside_their_subtree(client, cast):
    filed = _file(client, cast["outsider"], check_in=_at(WORKDAY, 9), check_out=_at(WORKDAY, 18))
    refused = _decide(client, cast["mgr"], filed.json()["id"], "approved")
    assert refused.status_code == 403
    assert refused.json()["detail"]["reason"] == "out_of_scope"
    assert _record(cast["outsider"].id) is None


def test_the_permission_flag_blocks_the_queue_and_the_decision(client, cast):
    """D-002. The flag restricts; it never grants. Off means off for both halves."""
    filed = _file(client, cast["report"], check_in=_at(WORKDAY, 9), check_out=_at(WORKDAY, 18))
    _set_flag(cast["mgr"].id, False)

    assert client.get(f"{BASE}/review", headers=cast["mgr"].headers).status_code == 403
    refused = _decide(client, cast["mgr"], filed.json()["id"], "approved")
    assert refused.status_code == 403
    assert refused.json()["detail"]["reason"] == "permission_denied"
    assert _record(cast["report"].id) is None


def test_an_employee_cannot_reach_the_review_queue(client, cast):
    assert client.get(f"{BASE}/review", headers=cast["report"].headers).status_code == 403


def test_a_manager_cannot_decide_their_own_request(client, cast):
    """Self-approval defeats the point, and here it rewrites the approver's own row."""
    filed = _file(client, cast["mgr"], check_in=_at(WORKDAY, 9), check_out=_at(WORKDAY, 18))
    refused = _decide(client, cast["mgr"], filed.json()["id"], "approved")
    assert refused.status_code == 403
    assert refused.json()["detail"]["reason"] == "self_review"
    # The owner above them can, which is what stops the request being unresolvable.
    assert _decide(client, cast["owner"], filed.json()["id"], "approved").status_code == 200


# --------------------------------------------------------------------------- #
# On-behalf filing
# --------------------------------------------------------------------------- #


def test_on_behalf_filing_records_both_the_subject_and_the_filer(client, cast):
    filed = _file(client, cast["mgr"], check_in=_at(WORKDAY, 9), check_out=_at(WORKDAY, 18),
                  path=f"{BASE}/on-behalf/{cast['report'].id}",
                  reason="Filed by their manager; laptop was in for repair.")
    assert filed.status_code == 201, filed.text
    body = filed.json()
    assert body["user_id"] == str(cast["report"].id)
    assert body["created_by_user_id"] == str(cast["mgr"].id), (
        "D-008: the filer must be visible, or a request filed by HR reads as one "
        "the employee filed themselves"
    )
    assert body["created_by_name"] == cast["mgr"].name


def test_self_filing_records_the_employee_as_its_own_author(client, cast):
    """Not NULL. NULL on that column already means 'the author's row is gone'."""
    filed = _file(client, cast["report"], check_in=_at(WORKDAY, 9))
    assert filed.json()["created_by_user_id"] == str(cast["report"].id)


def test_on_behalf_filing_requires_the_permission(client, cast):
    """The subject is in the path, so the privilege is a different endpoint.

    An ordinary employee has no route to it at all — not an optional ``user_id``
    on the endpoint they already use, policed by one runtime ``if``.
    """
    refused = _file(client, cast["report"], check_in=_at(WORKDAY, 9),
                    path=f"{BASE}/on-behalf/{cast['outsider'].id}")
    assert refused.status_code == 403

    _set_flag(cast["mgr"].id, False)
    flagged = _file(client, cast["mgr"], check_in=_at(WORKDAY, 9),
                    path=f"{BASE}/on-behalf/{cast['report'].id}")
    assert flagged.status_code == 403
    assert flagged.json()["detail"]["reason"] == "permission_denied"


def test_on_behalf_filing_is_still_bound_by_the_subtree(client, cast):
    refused = _file(client, cast["mgr"], check_in=_at(WORKDAY, 9),
                    path=f"{BASE}/on-behalf/{cast['outsider'].id}")
    assert refused.status_code == 403
    assert refused.json()["detail"]["reason"] == "out_of_scope"


def test_the_ordinary_submit_body_cannot_name_somebody_else(client, cast):
    """``RegularizationIn`` has no ``user_id``, and an extra one is not honoured.

    Worth asserting rather than assuming: the whole attribution guarantee rests
    on the subject never coming from the body, and a future ``model_config``
    change is all it would take.
    """
    filed = _file(client, cast["report"], check_in=_at(WORKDAY, 9),
                  user_id=str(cast["outsider"].id))
    assert filed.status_code in (201, 422)
    if filed.status_code == 201:
        assert filed.json()["user_id"] == str(cast["report"].id)


# --------------------------------------------------------------------------- #
# Reading your own history
# --------------------------------------------------------------------------- #


def test_an_employee_reads_their_own_history_and_not_a_colleagues(client, cast):
    mine = _file(client, cast["report"], check_in=_at(WORKDAY, 9))
    _file(client, cast["outsider"], check_in=_at(WORKDAY, 9))

    own = client.get(BASE, headers=cast["report"].headers)
    assert own.status_code == 200, own.text
    assert [row["id"] for row in own.json()] == [mine.json()["id"]]

    peek = client.get(
        BASE, params={"user_id": str(cast["outsider"].id)}, headers=cast["report"].headers
    )
    assert peek.status_code == 403, (
        "a filtered empty list would be indistinguishable from 'they have never "
        "filed one' — the refusal has to be explicit"
    )


def test_a_manager_reads_a_reports_history_through_the_same_endpoint(client, cast):
    _file(client, cast["report"], check_in=_at(WORKDAY, 9))
    seen = client.get(
        BASE, params={"user_id": str(cast["report"].id)}, headers=cast["mgr"].headers
    )
    assert seen.status_code == 200
    assert len(seen.json()) == 1
    assert seen.json()[0]["user_name"] == cast["report"].name


# --------------------------------------------------------------------------- #
# Validation the approval path depends on
# --------------------------------------------------------------------------- #


def test_a_request_asking_for_nothing_is_refused(client, cast):
    """Mirrors ``ck_regularization_requests_has_requested_time`` as a 422."""
    empty = client.post(
        BASE, json={"date": WORKDAY.isoformat(), "reason": "nothing in particular"},
        headers=cast["report"].headers,
    )
    assert empty.status_code == 422


def test_a_reversed_pair_is_refused_before_it_can_produce_negative_time(client, cast):
    filed = _file(client, cast["report"], check_in=_at(WORKDAY, 18), check_out=_at(WORKDAY, 9))
    assert filed.status_code == 422


def test_a_future_day_cannot_be_regularized(client, cast):
    """A pre-stamped future day would be frozen by D-007 against the nightly job."""
    # Three days, not one: "tomorrow" is ambiguous when the runner's clock and
    # the org's timezone disagree about which day it currently is.
    tomorrow = date.today() + timedelta(days=3)
    filed = _file(client, cast["report"], day=tomorrow, check_in=_at(tomorrow, 9))
    assert filed.status_code == 422
    assert filed.json()["detail"]["reason"] == "future_date"


def test_the_requested_times_must_fall_on_the_day_being_corrected(client, cast):
    """Otherwise approval books a capped day against a date nobody looked at."""
    filed = _file(client, cast["report"], day=WORKDAY, check_in=_at(WORKDAY - timedelta(days=9), 9))
    assert filed.status_code == 422
    assert filed.json()["detail"]["reason"] == "check_in_off_day"


def test_a_night_shift_check_out_may_land_on_the_following_morning(client, cast):
    """The attendance day is the date the shift *started* — the same rule
    ``PUNCH_OUT_LOOKBACK_DAYS`` encodes on the punch path."""
    filed = _file(client, cast["report"], day=WORKDAY,
                  check_in=_at(WORKDAY, 22), check_out=_at(WORKDAY + timedelta(days=1), 6))
    assert filed.status_code == 201, filed.text
    assert _decide(client, cast["mgr"], filed.json()["id"], "approved").status_code == 200
    assert _record(cast["report"].id).worked_minutes == 480


# --------------------------------------------------------------------------- #
# Tenancy
# --------------------------------------------------------------------------- #


def test_another_tenant_cannot_see_or_decide_a_request(client, cast):
    filed = _file(client, cast["report"], check_in=_at(WORKDAY, 9), check_out=_at(WORKDAY, 18))

    queue = client.get(f"{BASE}/review", headers=cast["globex_owner"].headers)
    assert queue.status_code == 200
    assert queue.json() == []

    stolen = _decide(client, cast["globex_owner"], filed.json()["id"], "approved")
    assert stolen.status_code == 404, (
        "a cross-tenant decision must 404 on the tenant filter, not merely fail "
        "the scope check inside the wrong organisation"
    )
    assert _record(cast["report"].id) is None


def test_two_tenants_may_hold_the_same_pending_day_independently(client, cast):
    """The index is org-scoped, so one tenant's open request cannot block another's."""
    assert _file(client, cast["report"], check_in=_at(WORKDAY, 9)).status_code == 201
    assert _file(client, cast["globex_staff"], check_in=_at(WORKDAY, 9)).status_code == 201
