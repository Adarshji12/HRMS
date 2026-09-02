"""Attendance regularization: the request lifecycle, and the one write-back.

This module owns every write to ``attendance_records`` that *is* a
regularisation, exactly as ``services/attendance.py`` owns every write that is
not. The two must never both claim a row, and the rule that keeps them apart is
D-007, enforced from both sides: the nightly job skips a row whose punch source
is ``regularized``, and this module is the only thing that ever sets that
source.

Five decisions a reader would otherwise get wrong.

**Approval creates the attendance row when the day has none (D-007).** The
wholly-missed day is not an edge case, it is the case regularisation exists for:
somebody was on a client site all Tuesday and never punched, so there is no row
to update. The spec has approval "writing to ``attendance_records``" and never
says who owns the row when there is not one, which is how that becomes a silent
no-op that approves a correction and corrects nothing.

**Every row this module creates states its ``status`` explicitly (D-020).** The
column defaults to ``present``, which is right on the punch path -- a row exists
because somebody punched -- and a trap here, because a defaulted row is a
*fabricated attendance record* produced by the one feature whose whole purpose
is correcting attendance honestly. The status is not invented locally either:
it comes from ``attendance.classify``, so a regularised public holiday reads
``holiday`` and a regularised two-hour day reads ``half_day``, under the same
six-value precedence every other row in the system was classified by.

**Every write-back writes an ``AuditLog`` row (D-021).** ``attendance_records``
has no ``updated_at`` -- nothing in this repository does (D-018) -- so a
corrected ``check_out_at`` would otherwise carry no record of when it was
corrected. The only other timestamp is ``regularization_requests.reviewed_at``,
reachable only through ``regularization_id``, and D-006 says in terms that that
pointer is not history. The audit row carries the before and after values,
because "this cell changed at 18:04" is not answerable from a pointer that has
since moved on.

**Re-filing against an already-approved day is allowed (D-006).** Correcting a
bad correction is legitimate, so approving a later request overwrites the
attendance row again and repoints ``regularization_id`` at the newest approved
request. That column is a convenience pointer, never an audit trail: after a
second approval it names only the latest one, and anything claiming to show
history queries ``regularization_requests`` by ``(user_id, date)`` instead.

**"One pending request per day" is not checked here (D-005/D-027).** It is a
partial unique index, and a service-layer check would be a read followed by a
write that two double-clicked submits interleave through happily. What this
module owes is to catch the ``IntegrityError`` that index raises and turn it
into a typed 409 rather than a 500 -- see :func:`submit`.
"""

from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import (
    AttendanceRecord,
    AttendanceStatus,
    AuditLog,
    Organization,
    PunchSource,
    RegularizationRequest,
    RegularizationStatus,
    Role,
    User,
)
from app.services import attendance
from app.services import chains, workflow, hierarchy
from app.services import notifications as notif

log = logging.getLogger(__name__)

#: How far past ``date`` a requested check-out may fall, in days. One, not zero:
#: a night shift's attendance day is the date it *started* (see
#: ``Shift.is_night_shift`` and ``PUNCH_OUT_LOOKBACK_DAYS``), so an 06:00
#: check-out legitimately belongs to yesterday's row. Not two: past that the
#: request is describing a different day, and approving it would write a
#: thirty-hour span onto a date payroll reads.
MAX_CHECK_OUT_OVERHANG_DAYS = 1


class RegularizationError(Exception):
    """A rule said no, with a code the console can branch on.

    Same shape as ``leave.LeaveError`` and for the same reason: the UI renders a
    different message for "you already have an open request for that day" than
    for "that request was already decided", and matching on prose breaks the
    first time somebody improves the wording. The router maps this to HTTP, so
    the service stays importable by anything without a request context.
    """

    def __init__(self, code: str, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _audit(
    db: Session,
    *,
    org_id: uuid.UUID,
    actor_id: uuid.UUID | None,
    action: str,
    target_type: str,
    target_id: uuid.UUID | str,
    detail: dict,
) -> None:
    """Write the audit row directly rather than through ``api.deps.audit``.

    Deliberate, and copied from ``services/leave.py``: no service in this
    codebase imports from ``app.api``. It also matters for D-021 specifically --
    the write-back audit has to be written where the write-back happens, so that
    a future caller of :func:`apply_to_attendance` that is not a router cannot
    produce an unrecorded attendance edit.
    """
    db.add(
        AuditLog(
            org_id=org_id,
            actor_user_id=actor_id,
            action=action,
            target_type=target_type,
            target_id=str(target_id),
            detail=detail,
        )
    )


# --------------------------------------------------------------------------- #
# Scope -- the hierarchy service answers this, and only the hierarchy service
# --------------------------------------------------------------------------- #


def scope_ids(db: Session, viewer: User) -> list[uuid.UUID] | None:
    """Whose requests this person may see. ``None`` means the whole organisation.

    Delegates straight to ``services/hierarchy.py``. Spec 2.5 is explicit that
    the reporting subtree must not be reimplemented a second time, and it is
    right: a second copy is a second thing to get wrong the day somebody's
    manager changes, and the two would then disagree about who may approve what.
    """
    return hierarchy.visible_user_ids(db, viewer)


def ensure_in_scope(db: Session, viewer: User, user_id: uuid.UUID) -> User:
    """Resolve an employee inside the viewer's org and reporting scope.

    404 for "not in this organisation" and 403 for "in it but not yours" -- the
    same split ``timesheets._target_user`` makes. Collapsing both into 403 would
    tell a manager that a user id they guessed exists somewhere.
    """
    target = db.get(User, user_id)
    if target is None or target.org_id != viewer.org_id:
        raise RegularizationError("employee_not_found", "Employee not found", 404)
    allowed = scope_ids(db, viewer)
    if allowed is not None and user_id not in allowed:
        raise RegularizationError(
            "out_of_scope", "That employee does not report to you.", 403
        )
    return target


# --------------------------------------------------------------------------- #
# Submitting
# --------------------------------------------------------------------------- #


def _check_day_is_requestable(org: Organization, day: date) -> None:
    """Refuse a correction for a day that has not happened yet.

    Not in the spec, and added anyway: "I forgot to punch out next Thursday" is
    not a correction of anything, and approving one would pre-stamp an
    attendance row the nightly job is then forbidden to touch (D-007), so a
    single typo would freeze a future day as ``present`` permanently. Today is
    allowed -- the ordinary case is realising at 18:05 that you never punched in
    this morning.
    """
    today = attendance.local_day(org)
    if day > today:
        raise RegularizationError(
            "future_date",
            "You cannot ask to correct a day that has not happened yet.",
        )


def _check_times_belong_to_day(
    org: Organization,
    day: date,
    requested_check_in: datetime | None,
    requested_check_out: datetime | None,
) -> None:
    """The requested timestamps must actually fall on the day being corrected.

    Approval writes these two values onto the row for ``date`` and derives
    ``worked_minutes`` from them, so a check-in dated three weeks off does not
    fail loudly -- it books a capped sixteen-hour day against a date nobody
    looked at. The check-out is allowed to land on the following local date,
    because a night shift's attendance day is the date it started.
    """
    tz = attendance.tz_for(org.timezone)
    if requested_check_in is not None:
        local_in = attendance.as_utc(requested_check_in).astimezone(tz).date()
        if local_in != day:
            raise RegularizationError(
                "check_in_off_day",
                f"The requested check-in falls on {local_in.isoformat()}, not on "
                f"{day.isoformat()}.",
            )
    if requested_check_out is not None:
        local_out = attendance.as_utc(requested_check_out).astimezone(tz).date()
        latest = day + timedelta(days=MAX_CHECK_OUT_OVERHANG_DAYS)
        if local_out < day or local_out > latest:
            raise RegularizationError(
                "check_out_off_day",
                f"The requested check-out falls on {local_out.isoformat()}, which "
                f"is neither {day.isoformat()} nor the morning after it.",
            )


def submit(
    db: Session,
    *,
    org: Organization,
    employee: User,
    actor: User,
    day: date,
    requested_check_in: datetime | None,
    requested_check_out: datetime | None,
    reason: str,
) -> RegularizationRequest:
    """File one request. ``actor`` is who is asking; ``employee`` is who it is about.

    The two are separate arguments rather than one, because HR or a manager
    filing on somebody's behalf is legitimate (D-008) and the audit trail has to
    keep saying which of the two it was. ``created_by_user_id`` is always
    populated -- a self-filed request stores the employee's own id and never
    NULL, because NULL on that column already means "the author's user row is
    gone", and overloading it would make a request filed by a departed HR admin
    read forever after as one the employee filed themselves.

    **The duplicate-pending refusal comes from the database (D-005/D-027).**
    There is deliberately no ``SELECT ... WHERE status='pending'`` here to
    contradict the partial unique index: that check is a read-then-write, and
    two double-clicked submits interleave through it into two identical rows in
    the manager's queue. What this function owes is that the index's
    ``IntegrityError`` leaves as a typed 409 and not as a 500 -- an unhandled
    one is indistinguishable, from the console's side, from a broken server.
    """
    _check_day_is_requestable(org, day)
    _check_times_belong_to_day(org, day, requested_check_in, requested_check_out)

    row = RegularizationRequest(
        org_id=org.id,
        user_id=employee.id,
        date=day,
        requested_check_in=requested_check_in,
        requested_check_out=requested_check_out,
        reason=reason,
        created_by_user_id=actor.id,
        status=RegularizationStatus.PENDING.value,
    )
    db.add(row)
    try:
        db.flush()
    except IntegrityError:
        # Rolled back before anything else touches the session: SQLAlchemy
        # refuses to continue after a failed flush, so without this the typed
        # 409 would arrive behind a PendingRollbackError from whatever the
        # router did next -- which is the 500 this whole branch exists to avoid.
        db.rollback()
        raise RegularizationError(
            "pending_request_exists",
            "There is already an open request for that day. Wait for it to be "
            "decided, or ask your manager to reject it first.",
            409,
        ) from None
    # A chain begins when the request does, not when somebody first looks at
    # it: written lazily, its first rung would be consumed by whoever happened
    # to open the queue. Does nothing when this flow has no chain configured,
    # which is most companies.
    chains.start_for(db, kind="regularization", record_id=row.id, subject=employee,
                     record=row)

    return row


# --------------------------------------------------------------------------- #
# Reading
# --------------------------------------------------------------------------- #


def get(db: Session, org_id: uuid.UUID, request_id: uuid.UUID) -> RegularizationRequest:
    """One request, scoped to the tenant. 404 rather than a cross-org read."""
    row = db.get(RegularizationRequest, request_id)
    if row is None or row.org_id != org_id:
        raise RegularizationError("not_found", "Regularization request not found", 404)
    return row


def list_for_user(
    db: Session,
    org_id: uuid.UUID,
    user_id: uuid.UUID,
    *,
    status: str | None = None,
    start: date | None = None,
    end: date | None = None,
) -> list[RegularizationRequest]:
    """One employee's own history, newest day first."""
    stmt = select(RegularizationRequest).where(
        RegularizationRequest.org_id == org_id,
        RegularizationRequest.user_id == user_id,
    )
    if status:
        stmt = stmt.where(RegularizationRequest.status == status)
    if start:
        stmt = stmt.where(RegularizationRequest.date >= start)
    if end:
        stmt = stmt.where(RegularizationRequest.date <= end)
    return list(
        db.scalars(
            stmt.order_by(
                RegularizationRequest.date.desc(),
                RegularizationRequest.created_at.desc(),
            )
        ).all()
    )


def review_queue(
    db: Session,
    viewer: User,
    *,
    status: str = RegularizationStatus.PENDING.value,
) -> list[RegularizationRequest]:
    """Everything in this approver's scope awaiting a decision, oldest day first.

    Oldest first on purpose: a queue sorted newest-first buries the request
    somebody has been waiting a fortnight on, and attendance corrections have a
    deadline nobody in the queue can see -- the payroll run.
    """
    stmt = select(RegularizationRequest).where(
        RegularizationRequest.org_id == viewer.org_id,
        RegularizationRequest.status == status,
    )
    allowed = scope_ids(db, viewer)
    if allowed is not None:
        stmt = stmt.where(RegularizationRequest.user_id.in_(allowed))
    return list(
        db.scalars(
            stmt.order_by(RegularizationRequest.date, RegularizationRequest.created_at)
        ).all()
    )


# --------------------------------------------------------------------------- #
# Deciding, and the write-back that D-007 makes this module's alone
# --------------------------------------------------------------------------- #


def _classify_day(
    db: Session, org: Organization, user: User, record: AttendanceRecord
) -> str:
    """The stored six-value day classification for a regularised row (D-020).

    Reuses ``attendance.classify`` rather than deciding here, so a regularised
    public holiday reads ``holiday``, a regularised Sunday reads ``weekly_off``
    with its worked minutes intact -- which is what makes Phase 4's comp-off
    rule expressible at all -- and a two-hour day reads ``half_day`` under the
    same threshold every other row was judged by. A private local copy of that
    precedence would drift from the nightly job's within one sprint, and the two
    disagreeing about the same date is exactly the ambiguity D-010 settled.

    **Integration request:** ``DayContext`` and ``classify`` are public names
    in another engineer's module. They are used here because the alternative is
    duplicating the classification, not because reaching past the underscore is
    right; both want promoting to public names once the lead holds both files.

    The context is built before the caller mutates anything, so its queries
    cannot autoflush a half-written row, and the record is handed to
    ``classify`` explicitly rather than re-read -- on the D-007 create path it
    does not exist in the database yet.
    """
    context = attendance.DayContext(db, org, record.date, user_ids=[user.id])
    return attendance.classify(context, user, record)


def _snapshot(record: AttendanceRecord | None) -> dict:
    """The fields a write-back can move, as JSON primitives, for the audit row."""
    if record is None:
        return {}

    def _iso(value: datetime | None) -> str | None:
        moment = attendance.as_utc(value)
        return moment.isoformat() if moment else None

    return {
        "check_in_at": _iso(record.check_in_at),
        "check_out_at": _iso(record.check_out_at),
        "check_in_source": record.check_in_source,
        "check_out_source": record.check_out_source,
        "status": record.status,
        "worked_minutes": record.worked_minutes,
        "regularization_id": (
            str(record.regularization_id) if record.regularization_id else None
        ),
    }


def apply_to_attendance(
    db: Session,
    *,
    org: Organization,
    request: RegularizationRequest,
    employee: User,
    reviewer: User,
) -> AttendanceRecord:
    """Write an approved correction into ``attendance_records`` (D-007).

    Creates the row when the day has none, updates it when it does, and writes
    an ``AuditLog`` row either way (D-021). Only the halves the employee
    actually asked for are touched: the common request is a forgotten check-out,
    and stamping ``regularized`` over a morning punch that was already correct
    would destroy real evidence in order to fix a different problem.

    Location data on a corrected half is cleared rather than carried over. A
    latitude recorded at 09:02 is not evidence for a check-in a manager has just
    moved to 08:30, and an ``is_geo_verified_in`` left ``True`` beside a decided
    timestamp tells every report that a human decision was GPS-confirmed.
    """
    # Looked up before anything is created, so the row this replaces is captured
    # for the audit trail exactly as it stood.
    record = attendance.record_for(db, org.id, employee.id, request.date)
    previous_note = record.note if record is not None else None
    before = _snapshot(record)
    created = record is None

    if created:
        record = AttendanceRecord(
            org_id=org.id,
            user_id=employee.id,
            date=request.date,
            # D-020, belt and braces. The classified value replaces this a few
            # lines down; the point of not leaving it to the column default is
            # that no failure between here and there can persist a fabricated
            # ``present`` for a day nobody came in on.
            status=AttendanceStatus.ABSENT.value,
            worked_minutes=0,
        )
        db.add(record)

    if request.requested_check_in is not None:
        record.check_in_at = request.requested_check_in
        record.check_in_source = PunchSource.REGULARIZED.value
        record.is_geo_verified_in = False
        record.check_in_lat = None
        record.check_in_lng = None
        record.check_in_distance_m = None
    if request.requested_check_out is not None:
        record.check_out_at = request.requested_check_out
        record.check_out_source = PunchSource.REGULARIZED.value
        record.is_geo_verified_out = False
        record.check_out_lat = None
        record.check_out_lng = None
        record.check_out_distance_m = None

    # The attendance service's own capped helper (D-012) rather than a
    # subtraction here: a correction is precisely the path that can produce a
    # sixteen-hour-plus span, and payroll reads this column.
    record.worked_minutes = attendance.worked_minutes_between(
        record.check_in_at, record.check_out_at
    )
    # D-006: repoint at the newest approved request. A convenience pointer, not
    # history -- the durable record is the requests table.
    record.regularization_id = request.id
    record.status = _classify_day(db, org, employee, record)

    # The day now looks odd for a reason, and the console renders this beside
    # it. The reviewer's note wins over the employee's reason as the later and
    # more authoritative of the two; any previous note survives in the audit row
    # rather than fighting for 500 shared characters.
    explanation = (request.review_note or "").strip() or request.reason.strip()
    record.note = f"Regularised: {explanation}"[:500]

    db.flush()

    _audit(
        db,
        org_id=org.id,
        actor_id=reviewer.id,
        # D-021. Named for the attendance write rather than for the approval, so
        # "when was this cell last changed, and by whom" is answerable by
        # querying audit_logs for one attendance_record id -- which is the
        # question ``updated_at`` would have answered if this codebase had one.
        action="regularization.attendance_written",
        target_type="attendance_record",
        target_id=record.id,
        detail={
            "regularization_id": str(request.id),
            "user_id": str(employee.id),
            "date": request.date.isoformat(),
            "created": created,
            "previous_note": previous_note,
            "before": before,
            "after": _snapshot(record),
        },
    )
    return record


def decide(
    db: Session,
    *,
    org: Organization,
    request: RegularizationRequest,
    reviewer: User,
    status: str,
    note: str | None = None,
) -> RegularizationRequest:
    """Approve or reject one request. Approval, and only approval, writes back.

    The guards -- already decided, self-review, a reason on a rejection -- are
    ``services.workflow``'s, declared once in ``workflow.REGULARIZATION``. What
    stays here is the part that is about regularization rather than about
    approval: finding the employee, and the attendance write-back.

    Does not commit.
    """
    approve = status == RegularizationStatus.APPROVED.value

    employee = db.get(User, request.user_id)
    if employee is None or employee.org_id != org.id:
        raise RegularizationError("employee_not_found", "Employee not found", 404)

    def write_back() -> None:
        """Approval, and only approval, rewrites attendance (spec 2.5).

        Rejection deliberately touches nothing outside this table: the absence,
        the missing check-out, the unverified geofence all stay exactly as they
        were, and the rejected request survives as the record that somebody
        asked and was told no.
        """
        apply_to_attendance(
            db, org=org, request=request, employee=employee, reviewer=reviewer
        )

    # Already-decided, self-review and reason-on-rejection are the kernel's now.
    # `workflow.REGULARIZATION` is where this flow's answers to those three
    # questions are written down, beside the other five flows'.
    workflow.decide(
        db, policy=workflow.REGULARIZATION, record=request, reviewer=reviewer,
        approve=approve, note=note, on_approve=write_back,
    )
    return request


# --------------------------------------------------------------------------- #
# Alerts -- through notifications.dispatch(), the one door
# --------------------------------------------------------------------------- #


def _describe(request: RegularizationRequest) -> str:
    parts = []
    if request.requested_check_in is not None:
        moment = attendance.as_utc(request.requested_check_in)
        parts.append(f"check-in {moment.isoformat()}")
    if request.requested_check_out is not None:
        moment = attendance.as_utc(request.requested_check_out)
        parts.append(f"check-out {moment.isoformat()}")
    return ", ".join(parts) or "no change"


def notify_submitted(db: Session, request: RegularizationRequest) -> bool:
    """Tell the employee's manager that a correction is waiting (spec 2.5).

    Optional, unlike the decision alert: this is a queue reminder, and a manager
    who works from the console rather than from mail is entitled to switch it
    off. ``dispatch`` owns that check -- there is no second preference test
    here, because a second place a preference gets consulted is how one
    eventually gets forgotten.
    """
    employee = db.get(User, request.user_id)
    if employee is None or employee.manager_id is None:
        return False
    manager = db.get(User, employee.manager_id)
    if manager is None:
        return False
    return notif.dispatch(
        db,
        manager,
        notif.Kind.REGULARIZATION_SUBMITTED,
        # One claim per request, so a retried submit cannot mail twice while a
        # second employee's request on the same day still gets through.
        dedupe_key=str(request.id),
        subject=f"Attendance correction from {employee.full_name}",
        body=(
            f"{employee.full_name} has asked to correct their attendance for "
            f"{request.date.isoformat()} ({_describe(request)}).\n\n"
            f"Reason: {request.reason}"
        ),
    )


def notify_decided(db: Session, request: RegularizationRequest) -> bool:
    """Tell the employee. **Non-optional**, and exactly once per decision.

    Non-optional because this is the only notice anybody gets that their own
    attendance record was rewritten by somebody else -- the same principle that
    already makes ``timesheet_decided`` mandatory, applied to the record payroll
    reads. ``notifications.SPECS`` carries ``optional=False`` for this kind, so
    ``dispatch`` ignores preferences and nothing here needs to re-check them.

    The decision is in the dedupe key rather than the request id alone. A
    request can only be decided once today, but the key then survives any future
    reopen-and-re-decide, and a double-submitted decision still sends one mail.
    """
    employee = db.get(User, request.user_id)
    if employee is None:
        return False
    return notif.dispatch(
        db,
        employee,
        notif.Kind.REGULARIZATION_DECIDED,
        dedupe_key=f"{request.id}:{request.status}",
        subject=f"Your attendance correction was {request.status}",
        body=(
            f"Your request to correct your attendance for "
            f"{request.date.isoformat()} ({_describe(request)}) was "
            f"{request.status}.\n\n"
            f"Note: {request.review_note or '-'}"
        ),
    )
