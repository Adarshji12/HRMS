"""Attendance regularization: submit, review queue, decision, on-behalf filing.

Written as a sibling of ``timesheets.py`` and ``leave.py`` on purpose. Phase 10
renders all three in one merged approvals inbox, and two approval flows that
read differently become two approval flows that behave differently.

Every rule lives in ``app.services.regularization`` -- who may decide, what a
decision does to ``attendance_records``, what a rejection deliberately does not
do. This file resolves who is asking, who they are asking about, and turns a
:class:`~app.services.regularization.RegularizationError` into a typed HTTP
response. A handler here containing a regularization rule is a bug.

Two things that are genuinely this file's business.

**On-behalf filing takes its subject in the path, not in the body.** HR filing
for somebody who has no laptop is a real requirement (D-008), but an optional
``user_id`` on the ordinary submit body would mean every employee's request goes
through a handler that *could* file for anyone and is policed at runtime by one
``if``. A separate path with its own dependency makes the privileged operation a
different endpoint, so the unprivileged one has no code path to the privilege at
all -- and so an audit reader can tell the two apart by URL.

**One decision endpoint, not ``/approve`` plus ``/reject``.** ``status`` is a
required field on the Phase 0 ``RegularizationReviewIn`` contract, which admits
only ``approved`` or ``rejected`` -- deciding is one transition with two
outcomes, and splitting it would leave that merged schema with no caller and
duplicate the already-decided, self-review and note-required guards across two
handlers.
"""

from __future__ import annotations

import uuid
from datetime import date
from typing import Annotated, NoReturn

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
    Query,
    Request,
    status,
)
from sqlalchemy import select

from app.api.deps import (
    CurrentUser,
    DbSession,
    TeamViewer,
    audit,
    deny_unless,
)
from app.db.session import SessionLocal
from app.models import Organization, RegularizationRequest, RegularizationStatus, User
from app.schemas.regularization import (
    RegularizationIn,
    RegularizationOut,
    RegularizationReviewIn,
)
from app.services import regularization as svc

router = APIRouter(prefix="/regularization", tags=["regularization"])


# --------------------------------------------------------------------------- #
# Dependencies and small shared resolvers
# --------------------------------------------------------------------------- #


def require_regularization_approver(user: TeamViewer) -> User:
    """Sees the team AND may rewrite their attendance records.

    Built on ``can_approve_regularization`` rather than ``can_approve_leave`` or
    ``can_approve_timesheets``: D-002 made them separate flags because the team
    lead who signs off "you were in the office at 09:15" is routinely not the
    person who signs off "you may take nine days off". Only one of those spends
    a balance, and only one of them edits the record payroll reads.

    Defined here rather than in ``deps.py`` for the reason ``leave.py`` gives
    for its own approver: ``deps.py`` is the lead's file, and this is three
    lines composed from primitives it already exports.
    """
    deny_unless(user, "can_approve_regularization", "approve attendance regularization")
    return user


RegularizationApprover = Annotated[User, Depends(require_regularization_approver)]


def _fail(error: svc.RegularizationError) -> NoReturn:
    """Turn a service refusal into a response the console can branch on.

    The ``reason`` code, not the sentence: the UI offers "view the open request"
    for ``pending_request_exists`` and nothing at all for ``already_decided``,
    and matching on prose breaks the first time somebody improves the wording.
    """
    raise HTTPException(
        error.status_code, detail={"reason": error.code, "message": error.message}
    )


def _org(db, org_id: uuid.UUID) -> Organization:
    org = db.get(Organization, org_id)
    if org is None:  # pragma: no cover - the tenant middleware resolved it already
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Organisation not found")
    return org


def _names(db, org_id: uuid.UUID, rows) -> dict[uuid.UUID, str]:
    """Display names for exactly the people these rows mention.

    Scoped to the ids actually referenced rather than "every user in the org".
    A request carries at most three (subject, reviewer, author) and a page shows
    a screenful, so the unscoped version read a five-thousand-row user table on
    every call to decorate twenty rows — invisible on a demo tenant and a full
    table scan per request on a real one.
    """
    wanted: set[uuid.UUID] = set()
    for row in rows:
        wanted.update(
            value
            for value in (row.user_id, row.reviewed_by_user_id, row.created_by_user_id)
            if value is not None
        )
    if not wanted:
        return {}
    return {
        row[0]: row[1]
        for row in db.execute(
            select(User.id, User.full_name).where(
                User.org_id == org_id, User.id.in_(wanted)
            )
        )
    }


def _out(row: RegularizationRequest, names: dict[uuid.UUID, str]) -> RegularizationOut:
    """One row plus the three derived names, so no client ever joins.

    ``reviewer_name`` stays ``None`` on a pending row and on a decided row whose
    reviewer has since been deleted -- ``reviewed_at`` is then the surviving
    proof that a decision was made, which is why the queue renders the timestamp
    and not only the name (D-008).
    """
    out = RegularizationOut.model_validate(row)
    out.user_name = names.get(row.user_id)
    out.reviewer_name = names.get(row.reviewed_by_user_id)
    out.created_by_name = names.get(row.created_by_user_id)
    return out


# --------------------------------------------------------------------------- #
# Alerts, queued after the commit
# --------------------------------------------------------------------------- #


def _queue(
    background: BackgroundTasks,
    request_id: uuid.UUID,
    *,
    submitted: bool = False,
    decided: bool = False,
) -> None:
    """Send the alerts after the transaction that caused them has committed.

    Queued rather than awaited for the reason ``timesheets._notify_decision``
    already gives: ``app.services.email`` is synchronous SMTP, and an approval
    must not crawl because the mail provider is having a bad afternoon. It runs
    in a fresh session because ``notifications.dispatch`` commits, and a commit
    inside the request's session would end the transaction the attendance
    write-back and its audit row share.
    """

    def _send() -> None:
        with SessionLocal() as fresh:
            row = fresh.get(RegularizationRequest, request_id)
            if row is None:
                return
            if submitted:
                svc.notify_submitted(fresh, row)
            if decided:
                svc.notify_decided(fresh, row)

    background.add_task(_send)


# --------------------------------------------------------------------------- #
# Filing
# --------------------------------------------------------------------------- #


def _create(
    *,
    db,
    viewer: User,
    subject: User,
    payload: RegularizationIn,
    request: Request,
    background: BackgroundTasks,
    on_behalf: bool,
) -> RegularizationOut:
    """The body both filing endpoints share, after each has settled who may file."""
    org = _org(db, viewer.org_id)
    try:
        row = svc.submit(
            db,
            org=org,
            employee=subject,
            actor=viewer,
            day=payload.date,
            requested_check_in=payload.requested_check_in,
            requested_check_out=payload.requested_check_out,
            reason=payload.reason,
        )
    except svc.RegularizationError as error:
        _fail(error)

    audit(
        db,
        org_id=viewer.org_id,
        actor=viewer,
        action="regularization.submitted",
        request=request,
        target_type="regularization_request",
        target_id=str(row.id),
        detail={
            "for": str(subject.id),
            "date": payload.date,
            "on_behalf": on_behalf,
            "requested_check_in": payload.requested_check_in,
            "requested_check_out": payload.requested_check_out,
        },
    )
    db.commit()
    _queue(background, row.id, submitted=True)
    return _out(row, _names(db, viewer.org_id, [row]))


@router.post("", response_model=RegularizationOut, status_code=status.HTTP_201_CREATED)
def submit(
    payload: RegularizationIn,
    viewer: CurrentUser,
    request: Request,
    background: BackgroundTasks,
    db: DbSession,
) -> RegularizationOut:
    """Ask for one of your own attendance days to be corrected.

    There is no ``user_id`` on this path, in the body or in the URL. An employee
    filing in a colleague's name is the attribution hole the whole feature
    exists to close, so the subject is the authenticated caller and nothing
    else; filing for somebody else is a different endpoint with its own
    permission (see :func:`submit_on_behalf`).
    """
    return _create(
        db=db,
        viewer=viewer,
        subject=viewer,
        payload=payload,
        request=request,
        background=background,
        on_behalf=False,
    )


@router.post(
    "/on-behalf/{user_id}",
    response_model=RegularizationOut,
    status_code=status.HTTP_201_CREATED,
)
def submit_on_behalf(
    user_id: uuid.UUID,
    payload: RegularizationIn,
    viewer: RegularizationApprover,
    request: Request,
    background: BackgroundTasks,
    db: DbSession,
) -> RegularizationOut:
    """File a correction for somebody else. HR and managers only.

    Two gates, not one: the permission flag decides whether this person may file
    for anyone at all, and the hierarchy decides which anyone. A manager with
    the flag still cannot file against an employee outside their reporting
    subtree, and an administrator's scope is the whole organisation because
    ``hierarchy.visible_user_ids`` says so -- not because this handler
    special-cases the role.

    ``created_by_user_id`` records the filer and ``user_id`` the subject, so the
    row says who asked on whose behalf rather than quietly reading as
    self-filed.
    """
    try:
        subject = svc.ensure_in_scope(db, viewer, user_id)
    except svc.RegularizationError as error:
        _fail(error)
    return _create(
        db=db,
        viewer=viewer,
        subject=subject,
        payload=payload,
        request=request,
        background=background,
        on_behalf=True,
    )


# --------------------------------------------------------------------------- #
# Reading
# --------------------------------------------------------------------------- #


@router.get("", response_model=list[RegularizationOut])
def list_mine(
    viewer: CurrentUser,
    db: DbSession,
    user_id: uuid.UUID | None = None,
    status_filter: str | None = Query(default=None, alias="status"),
    start: date | None = None,
    end: date | None = None,
) -> list[RegularizationOut]:
    """Your own regularization history.

    ``user_id`` lets a manager read one of their reports' history from the same
    endpoint, scoped by the hierarchy service exactly as the review queue is. An
    employee passing somebody else's id gets a 403, not a filtered empty list --
    silence would be indistinguishable from "they have never filed one".
    """
    subject = viewer
    if user_id is not None and user_id != viewer.id:
        try:
            subject = svc.ensure_in_scope(db, viewer, user_id)
        except svc.RegularizationError as error:
            _fail(error)
    rows = svc.list_for_user(
        db, viewer.org_id, subject.id, status=status_filter, start=start, end=end
    )
    names = _names(db, viewer.org_id, rows)
    return [_out(row, names) for row in rows]


@router.get("/review", response_model=list[RegularizationOut])
def review_queue(
    viewer: RegularizationApprover,
    db: DbSession,
    status_filter: str = Query(default=RegularizationStatus.PENDING.value, alias="status"),
) -> list[RegularizationOut]:
    """Everything in this approver's reporting subtree awaiting a decision.

    Scope comes from ``services/hierarchy.py`` through the service, not from a
    second rule written here. There is exactly one answer in this codebase to
    "whose data may this manager see", and spec 2.5 is explicit that this module
    is not to write a second one.
    """
    rows = svc.review_queue(db, viewer, status=status_filter)
    names = _names(db, viewer.org_id, rows)
    return [_out(row, names) for row in rows]


# --------------------------------------------------------------------------- #
# Deciding
# --------------------------------------------------------------------------- #


@router.post("/{request_id}/review", response_model=RegularizationOut)
def review(
    request_id: uuid.UUID,
    payload: RegularizationReviewIn,
    viewer: RegularizationApprover,
    request: Request,
    background: BackgroundTasks,
    db: DbSession,
) -> RegularizationOut:
    """Approve or reject one request.

    Approval writes into ``attendance_records`` -- creating the row when the day
    has none (D-007) -- and stamps an ``AuditLog`` row for that write (D-021).
    Rejection leaves the attendance row untouched. Both tell the employee, once,
    through a notification they cannot switch off.
    """
    try:
        row = svc.get(db, viewer.org_id, request_id)
        # Scope is checked against the *subject* before the decision, so a
        # manager cannot decide a request belonging to somebody else's subtree
        # merely by knowing its id.
        svc.ensure_in_scope(db, viewer, row.user_id)
        svc.decide(
            db,
            org=_org(db, viewer.org_id),
            request=row,
            reviewer=viewer,
            status=payload.status,
            note=payload.review_note,
        )
    except svc.RegularizationError as error:
        db.rollback()
        _fail(error)

    audit(
        db,
        org_id=viewer.org_id,
        actor=viewer,
        action="regularization.decided",
        request=request,
        target_type="regularization_request",
        target_id=str(row.id),
        detail={
            "for": str(row.user_id),
            "date": row.date,
            "decision": row.status,
            "note": payload.review_note,
        },
    )
    db.commit()
    _queue(background, row.id, decided=True)
    return _out(row, _names(db, viewer.org_id, [row]))
