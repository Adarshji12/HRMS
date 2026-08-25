"""Endpoints consumed by the desktop agent.

Everything here authenticates with an opaque device token except ``/enroll``,
which trades a user's enrollment key for one.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile, status
from sqlalchemy import select

from app.api.deps import CurrentDevice, DbSession, audit, get_org_settings
from app.api.tenancy import CurrentTenant, OptionalTenant
from app.core.config import settings as app_settings
from app.core import ratelimit
from app.core.security import generate_device_token, token_digest, verify_password
from app.models import (
    ActivitySegment,
    Device,
    Organization,
    Project,
    ProjectMember,
    Screenshot,
    User,
    WorkSchedule,
    WorkSession,
)
from app.schemas.agent import (
    ActivityBatch,
    AgentLoginRequest,
    DeviceInfo,
    EnrollRequest,
    EnrollResponse,
    HeartbeatRequest,
    HeartbeatResponse,
    IngestAck,
    ScreenshotMeta,
    SessionEndRequest,
    SessionStartRequest,
)
from app.schemas.common import OrgSettingsOut
from app.services import email, notifications as notif, storage
from app.services import subscriptions as subs
from app.services.attribution import Attributor
from app.services.classifier import Classifier

log = logging.getLogger(__name__)

router = APIRouter(prefix="/agent", tags=["agent"])

# Segments dated further ahead than this are rejected: a machine with a badly
# skewed clock would otherwise poison "today" for every report.
MAX_CLOCK_SKEW = timedelta(minutes=15)
# Backfill window for a machine returning from a long offline stretch.
MAX_BACKFILL = timedelta(days=30)


@router.post("/enroll", response_model=EnrollResponse)
def enroll(
    payload: EnrollRequest, request: Request, tenant: OptionalTenant, db: DbSession
) -> EnrollResponse:
    # An enrolment key is a bearer credential that binds a machine, so it is
    # guessable in principle and must not be guessable in practice.
    ratelimit.enforce(request, "agent-enroll", ratelimit.AGENT_ENROL)

    key = payload.enrollment_key.strip().upper()
    user = db.scalar(select(User).where(User.enrollment_key == key))
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid enrollment key")
    # Enrollment keys are globally unique, so they identify the organisation on
    # their own. When the agent is also pointed at a tenant URL the two must
    # agree, otherwise the same wrong response as an unknown key: a valid key
    # must not reveal which company it belongs to.
    if tenant is not None and user.org_id != tenant.id:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid enrollment key")

    return _bind_device(db, user, payload, request, via="key")


@router.post("/login", response_model=EnrollResponse)
def agent_login(
    payload: AgentLoginRequest, request: Request, tenant: CurrentTenant, db: DbSession
) -> EnrollResponse:
    """Bind a machine using the employee's own credentials.

    Requires a tenant, unlike ``/enroll``: an enrollment key is globally unique
    and so identifies its organisation, but an email is only unique *within*
    one — without the tenant the lookup would be ambiguous, which is the same
    cross-tenant bug the dashboard login had.

    The agent stores only the returned device token. The password is not
    persisted anywhere on the machine.
    """
    # Same credential as the dashboard login, so the same protection.
    ratelimit.enforce(request, "agent-login", ratelimit.LOGIN, payload.email)

    user = db.scalar(
        select(User).where(
            User.org_id == tenant.id, User.email == payload.email.strip().lower()
        )
    )
    if (
        user is None
        or not user.is_active
        or not user.password_hash
        or not verify_password(payload.password, user.password_hash)
    ):
        # One response for every failure mode, so the agent cannot be used to
        # enumerate a company's staff.
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password")

    user.last_login_at = datetime.now(timezone.utc)
    return _bind_device(db, user, payload, request, via="password")


def _org_console_url(org) -> str:
    port = f":{app_settings.public_port}" if app_settings.public_port else ""
    return f"{app_settings.public_scheme}://{org.slug}.{app_settings.base_domain}{port}/"


def _bind_device(
    db, user: User, payload: DeviceInfo, request: Request, *, via: str
) -> EnrollResponse:
    """Shared tail of /enroll and /login: check policy, issue a device token."""
    # An expired or suspended organisation must not be able to onboard new
    # machines, even with credentials that worked while it was active.
    subs.ensure_collection_allowed(db, user.organization)

    org_settings = get_org_settings(db, user.org_id)

    if org_settings.notice_required and not payload.accept_notice:
        # The agent is expected to display notice_text and retry with
        # accept_notice=True. Refusing here is what makes the notice binding.
        raise HTTPException(
            status.HTTP_412_PRECONDITION_FAILED,
            detail={"reason": "notice_not_accepted", "notice_text": org_settings.notice_text},
        )

    device = db.scalar(
        select(Device).where(
            Device.org_id == user.org_id, Device.machine_id == payload.machine_id
        )
    )
    token = generate_device_token()

    if device is None:
        device = Device(
            org_id=user.org_id,
            user_id=user.id,
            machine_id=payload.machine_id,
            hostname=payload.hostname,
            os=payload.os,
            os_version=payload.os_version,
            agent_version=payload.agent_version,
            token_hash=token_digest(token),
        )
        db.add(device)
        action = "device.enrolled"
    else:
        # Re-binding rotates the token and can move the machine to another
        # employee (shared hot-desk hardware).
        device.user_id = user.id
        device.hostname = payload.hostname
        device.os = payload.os
        device.os_version = payload.os_version
        device.agent_version = payload.agent_version
        device.token_hash = token_digest(token)
        device.is_active = True
        action = "device.re_enrolled"

    if org_settings.notice_required and user.notice_accepted_at is None:
        user.notice_accepted_at = datetime.now(timezone.utc)

    db.flush()
    audit(
        db,
        org_id=user.org_id,
        actor=user,
        action=action,
        request=request,
        target_type="device",
        target_id=str(device.id),
        detail={"hostname": payload.hostname, "os": payload.os, "via": via},
    )
    db.commit()

    # Security notice, to the person the machine now reports as. Only on a first
    # bind: re-enrolment is the ordinary result of reinstalling the agent, and
    # mailing someone every time they do that is how the important one gets
    # ignored. Sent inline rather than queued because this path has no
    # BackgroundTasks — email.send already swallows its own failures, so a mail
    # outage cannot break enrolment.
    if action == "device.enrolled":
        try:
            notif.dispatch(
                db, user, notif.Kind.DEVICE_ENROLLED,
                dedupe_key=str(device.id),
                subject="A device was enrolled against your account",
                send_fn=lambda: email.send_device_enrolled(
                    to=user.email, name=user.full_name, hostname=payload.hostname,
                    os_name=f"{payload.os} {payload.os_version}".strip(),
                    when_local=datetime.now(timezone.utc).strftime("%d %b %Y, %H:%M UTC"),
                    url=_org_console_url(user.organization),
                    org_id=user.org_id,
                ),
            )
        except Exception:  # noqa: BLE001 - never fail an enrolment over a notice
            log.exception("device-enrolled notice failed for %s", user.email)

    return EnrollResponse(
        device_id=device.id,
        device_token=token,
        user_id=user.id,
        user_name=user.full_name,
        user_email=user.email,
        org_name=user.organization.name,
        org_slug=user.organization.slug,
        config=OrgSettingsOut.model_validate(org_settings),
    )


@router.get("/config", response_model=OrgSettingsOut)
def get_config(device: CurrentDevice, db: DbSession) -> OrgSettingsOut:
    return OrgSettingsOut.model_validate(get_org_settings(db, device.org_id))


@router.get("/projects")
def agent_projects(device: CurrentDevice, db: DbSession) -> list[dict]:
    """Projects this employee may log time against, for the tray menu.

    Only projects they are a member of. The full company list can include
    client names they have no business seeing, and a dropdown is a poor place
    to leak them.
    """
    rows = db.execute(
        select(Project.id, Project.name, Project.code)
        .join(ProjectMember, ProjectMember.project_id == Project.id)
        .where(
            ProjectMember.user_id == device.user_id,
            Project.org_id == device.org_id,
            Project.status.in_(["active", "on_hold"]),
        )
        .order_by(Project.name)
    )
    return [{"id": str(pid), "name": name, "code": code} for pid, name, code in rows]


@router.post("/heartbeat", response_model=HeartbeatResponse)
def heartbeat(
    payload: HeartbeatRequest, device: CurrentDevice, db: DbSession
) -> HeartbeatResponse:
    device.last_seen_at = datetime.now(timezone.utc)
    if payload.agent_version:
        device.agent_version = payload.agent_version
    # Assigned unconditionally, including back to NULL: this has to clear the
    # moment the machine starts working again, or a permission granted on
    # Monday still reads as broken on Friday.
    device.capture_blocked = payload.capture_blocked
    db.commit()

    # A lapsed or suspended organisation revokes through the normal channel, so
    # the agent stops and wipes its spool rather than queueing data forever
    # against an account that can no longer receive it.
    org = db.get(Organization, device.org_id)
    entitlement = subs.entitlement(db, org)

    # A work schedule is assigned per employee and the console presents it as a
    # tracking control, but the heartbeat only ever carried the organisation
    # policy — so choosing 10:00-19:00 for the support team changed nothing
    # about when their agents collected. app.alerts already resolved the
    # schedule and its own comment noted the two "must agree"; this is the half
    # that was missing.
    #
    # Applied as an override on the outgoing config rather than as a new field,
    # so agents already in the field honour it on their next poll with no
    # update.
    config = OrgSettingsOut.model_validate(get_org_settings(db, device.org_id))
    user = db.get(User, device.user_id)
    if user is not None and user.schedule_id:
        schedule = db.get(WorkSchedule, user.schedule_id)
        if schedule is not None:
            config = config.model_copy(
                update={
                    "work_day_start": schedule.start_time,
                    "work_day_end": schedule.end_time,
                }
            )

    return HeartbeatResponse(
        server_time=datetime.now(timezone.utc),
        config=config,
        revoked=not device.is_active or not entitlement.collection_allowed,
    )


@router.post("/session/start", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def session_start(payload: SessionStartRequest, device: CurrentDevice, db: DbSession) -> None:
    open_session = db.scalar(
        select(WorkSession)
        .where(WorkSession.device_id == device.id, WorkSession.ended_at.is_(None))
        .order_by(WorkSession.started_at.desc())
    )
    if open_session is not None:
        # Previous run died without a clean stop (crash, power loss). Close it at
        # the device's last heartbeat rather than now, so the gap is not counted
        # as worked time.
        fallback = device.last_seen_at or open_session.started_at
        open_session.ended_at = fallback
        open_session.end_reason = "timeout"
        open_session.duration_s = max(
            0, int((fallback - open_session.started_at).total_seconds())
        )

    db.add(
        WorkSession(
            org_id=device.org_id,
            user_id=device.user_id,
            device_id=device.id,
            started_at=payload.started_at,
        )
    )
    device.last_seen_at = datetime.now(timezone.utc)
    db.commit()


@router.post("/session/end", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def session_end(payload: SessionEndRequest, device: CurrentDevice, db: DbSession) -> None:
    open_session = db.scalar(
        select(WorkSession)
        .where(WorkSession.device_id == device.id, WorkSession.ended_at.is_(None))
        .order_by(WorkSession.started_at.desc())
    )
    if open_session is None:
        return
    open_session.ended_at = payload.ended_at
    open_session.end_reason = "clean"
    open_session.duration_s = max(
        0, int((payload.ended_at - open_session.started_at).total_seconds())
    )
    db.commit()


def _utc(value: datetime) -> datetime:
    """Make a stored timestamp comparable with an incoming one.

    Postgres hands back timezone-aware values for these columns and SQLite
    hands back naive ones, so comparing a stored row against a request payload
    works on one engine and raises TypeError on the other. Normalising here is
    what stops that becoming a 500 that only ever appears in development.
    """
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


@router.post("/activity", response_model=IngestAck)
def ingest_activity(batch: ActivityBatch, device: CurrentDevice, db: DbSession) -> IngestAck:
    if len(batch.segments) > app_settings.max_segments_per_batch:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Batch too large")

    now = datetime.now(timezone.utc)
    org_settings = get_org_settings(db, device.org_id)
    classifier = Classifier.for_org(db, device.org_id)
    # Both built once per batch rather than per segment: each loads the org's
    # rule set, and a 200-segment upload would otherwise be 400 extra queries.
    attributor = Attributor.for_org(db, device.org_id)

    incoming_uids = [s.client_uid for s in batch.segments]
    # One query instead of one-per-row, and it keeps the transaction clean: a
    # replayed batch is a no-op rather than a constraint violation that would
    # roll back the whole request.
    known = set(
        db.scalars(
            select(ActivitySegment.client_uid).where(
                ActivitySegment.device_id == device.id,
                ActivitySegment.client_uid.in_(incoming_uids),
            )
        ).all()
    )

    # Every interval already recorded for this person anywhere near this batch,
    # fetched once. Per-segment queries would be up to 500 round trips for a
    # backfill after a laptop has been offline for a week.
    #
    # Deliberately by user, not by device: the case this exists to stop is two
    # devices — or two copies of the agent — covering the same wall clock.
    occupied: list[tuple[datetime, datetime]] = []
    if batch.segments:
        span_start = min(seg.started_at for seg in batch.segments)
        span_end = max(seg.ended_at for seg in batch.segments)
        occupied = [
            (_utc(row.started_at), _utc(row.ended_at))
            for row in db.execute(
                select(ActivitySegment.started_at, ActivitySegment.ended_at).where(
                    ActivitySegment.user_id == device.user_id,
                    ActivitySegment.ended_at > span_start,
                    ActivitySegment.started_at < span_end,
                )
            ).all()
            if row.ended_at is not None
        ]

    def overlaps(started: datetime, ended: datetime) -> bool:
        """True when this interval covers time already accounted for.

        A one-second touch at the boundary is not an overlap: consecutive
        segments from a healthy agent share an edge, and treating that as a
        clash would discard every second segment.
        """
        for other_start, other_end in occupied:
            if started < other_end and other_start < ended:
                latest_start = max(started, other_start)
                earliest_end = min(ended, other_end)
                if (earliest_end - latest_start).total_seconds() > 1:
                    return True
        return False

    accepted: list[str] = []
    rejected: dict[str, str] = {}
    overlapping = 0
    seen_in_batch: set[str] = set()

    for seg in batch.segments:
        if seg.client_uid in known or seg.client_uid in seen_in_batch:
            # Already stored — acknowledge so the agent drops it from its spool.
            accepted.append(seg.client_uid)
            continue

        if seg.ended_at <= seg.started_at:
            rejected[seg.client_uid] = "ended_at must be after started_at"
            continue
        if seg.started_at > now + MAX_CLOCK_SKEW:
            rejected[seg.client_uid] = "timestamp is in the future"
            continue
        if seg.started_at < now - MAX_BACKFILL:
            rejected[seg.client_uid] = "older than the backfill window"
            continue

        if overlaps(seg.started_at, seg.ended_at):
            # Accepted, not rejected: the agent should drop it from its spool
            # rather than retry forever. Nothing is lost that was not already
            # recorded by whichever tracker got there first.
            overlapping += 1
            accepted.append(seg.client_uid)
            continue

        duration = int((seg.ended_at - seg.started_at).total_seconds())
        if duration < org_settings.min_segment_s:
            # Not an error: the agent may be running an older, chattier policy.
            accepted.append(seg.client_uid)
            continue

        # Trust the duration derived from timestamps over the reported split, and
        # make the two halves add up to it.
        active_s = min(seg.active_s, duration)
        idle_s = min(seg.idle_s, duration - active_s)
        if active_s + idle_s < duration:
            idle_s = duration - active_s

        url_domain = seg.url_domain if org_settings.track_urls else None
        url_full = seg.url_full if org_settings.track_urls else None
        title = seg.window_title if org_settings.track_window_titles else ""

        attribution = attributor.resolve(
            app_exec=seg.app_exec,
            url_domain=url_domain,
            window_title=title,
            repo_name=seg.repo_name,
            selected_project_id=seg.project_id,
            selected_task_id=seg.task_id,
        )

        # Recorded before the flush so the rest of this batch is checked
        # against it too — a batch can contain its own overlaps.
        occupied.append((seg.started_at, seg.ended_at))

        db.add(
            ActivitySegment(
                org_id=device.org_id,
                user_id=device.user_id,
                device_id=device.id,
                client_uid=seg.client_uid,
                started_at=seg.started_at,
                ended_at=seg.ended_at,
                duration_s=duration,
                active_s=active_s,
                idle_s=idle_s,
                app_name=seg.app_name[:200],
                app_exec=seg.app_exec[:200],
                window_title=title,
                is_browser=seg.is_browser,
                browser=seg.browser,
                url_domain=url_domain,
                url_full=url_full,
                is_idle=seg.is_idle,
                productivity=classifier.classify(
                    app_exec=seg.app_exec,
                    url_domain=url_domain,
                    window_title=title,
                    is_idle=seg.is_idle,
                ),
                project_id=attribution.project_id,
                task_id=attribution.task_id,
                project_source=attribution.source.value if attribution.source else None,
                is_billable=attribution.is_billable,
                input_activity_pct=seg.input_activity_pct,
                repo_name=seg.repo_name,
                branch_name=seg.branch_name,
                file_path=seg.file_path,
            )
        )
        seen_in_batch.add(seg.client_uid)
        accepted.append(seg.client_uid)

    device.last_seen_at = now
    db.commit()

    if overlapping:
        # Worth a line in the log: the only ways to get here are a second agent
        # instance or a second machine covering the same hours, and both are
        # things an administrator would want to know about rather than have
        # silently corrected.
        log.warning(
            "device %s: %d/%d segments covered time already recorded for %s",
            device.id, overlapping, len(batch.segments), device.user_id,
        )

    return IngestAck(accepted=accepted, rejected=rejected)


@router.post("/screenshot", status_code=status.HTTP_201_CREATED)
def upload_screenshot(
    device: CurrentDevice,
    db: DbSession,
    meta: str = Form(..., description="JSON-encoded ScreenshotMeta"),
    file: UploadFile = File(...),
) -> dict:
    org_settings = get_org_settings(db, device.org_id)
    if not org_settings.screenshot_enabled:
        # Policy changed between capture and upload. Discard quietly with a 202
        # so the agent clears it from the spool instead of retrying forever.
        return {"stored": False, "reason": "screenshots_disabled"}

    try:
        parsed = ScreenshotMeta.model_validate_json(meta)
    except (ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"bad meta: {exc}") from exc

    existing = db.scalar(
        select(Screenshot).where(
            Screenshot.device_id == device.id, Screenshot.client_uid == parsed.client_uid
        )
    )
    if existing is not None:
        return {"stored": True, "id": str(existing.id), "duplicate": True}

    raw = file.file.read(app_settings.max_screenshot_bytes + 1)
    if len(raw) > app_settings.max_screenshot_bytes:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Screenshot too large")
    if not raw:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Empty upload")

    shot_id = uuid.uuid4()
    try:
        stored = storage.save_screenshot(
            raw,
            org_id=device.org_id,
            user_id=device.user_id,
            captured_at=parsed.captured_at,
            shot_id=shot_id,
            max_width=org_settings.screenshot_max_width,
            quality=org_settings.screenshot_quality,
            blur=org_settings.blur_screenshots,
        )
    except storage.StorageError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc

    shot = Screenshot(
        id=shot_id,
        org_id=device.org_id,
        user_id=device.user_id,
        device_id=device.id,
        client_uid=parsed.client_uid,
        captured_at=parsed.captured_at,
        received_at=datetime.now(timezone.utc),
        monitor_count=parsed.monitor_count,
        blurred=org_settings.blur_screenshots,
        app_name=parsed.app_name[:200],
        window_title=parsed.window_title if org_settings.track_window_titles else "",
        url_domain=parsed.url_domain if org_settings.track_urls else None,
        activity_pct=parsed.activity_pct,
        productivity=Classifier.for_org(db, device.org_id).classify(
            app_exec=parsed.app_exec,
            url_domain=parsed.url_domain if org_settings.track_urls else None,
            window_title=parsed.window_title,
        ),
        **stored,
    )
    db.add(shot)
    device.last_seen_at = datetime.now(timezone.utc)
    db.commit()
    return {"stored": True, "id": str(shot.id)}
