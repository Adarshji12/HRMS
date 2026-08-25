"""Periodic alert runner.

    python -m app.alerts run            # everything due now
    python -m app.alerts run --dry-run  # decide, print, send nothing
    python -m app.alerts run --only agent_silent

Driven by cron or Windows Task Scheduler, every 10-15 minutes:

    */15 * * * *  cd /srv/mydesktime/server && .venv/bin/python -m app.alerts run

A process rather than an in-process scheduler, deliberately. APScheduler inside
uvicorn is one line shorter and then fires once per worker, so a two-worker
deployment mails everyone twice — and it dies silently with the web process, at
which point nobody is told that nobody is being told anything. This follows the
convention already set by ``python -m app.seed`` and ``python -m app.platform_setup``.

Everything here is a *condition*, re-evaluated from scratch on each run. Nothing
tracks "have I already looked at this" in memory; de-duplication is entirely the
unique constraint in app.services.notifications.dispatch. That is what makes the
runner safe to invoke twice by accident, and safe to catch up after being down.
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import date, datetime, time as dtime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import SessionLocal
from app.models import (
    Device,
    Organization,
    OrgSettings,
    TimesheetApproval,
    User,
    WorkSchedule,
)
from app.services import email, mailconfig, notifications as notif, reports, subscriptions
from app.services.notifications import Audience, Kind

log = logging.getLogger("app.alerts")

#: How long an agent may stay quiet during working hours before we say so. The
#: agent heartbeats on sync_interval_s (60s default); 30 minutes is long enough
#: that a reboot, a laptop lid, or a flaky hotel wifi does not generate mail,
#: and short enough that a whole afternoon is not lost the way 18 August was.
SILENT_AFTER_MINUTES = 30


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def _console_url(org: Organization, path: str = "/") -> str:
    """The tenant's own address. Links into someone else's workspace are noise."""
    port = f":{settings.public_port}" if settings.public_port else ""
    return f"{settings.public_scheme}://{org.slug}.{settings.base_domain}{port}{path}"


def _org_tz(db: Session, org: Organization) -> str:
    row = db.scalar(select(OrgSettings).where(OrgSettings.org_id == org.id))
    return (getattr(row, "timezone", None) or org.timezone or "UTC") if row else (org.timezone or "UTC")


def _hhmm(value: str, fallback: dtime) -> dtime:
    try:
        hh, mm = value.split(":")
        return dtime(int(hh), int(mm))
    except (ValueError, AttributeError):
        return fallback


def _schedule_for(db: Session, user: User, org_settings: OrgSettings | None) -> tuple[dtime, dtime, int]:
    """(start, end, working-days bitmask) for one employee.

    Falls back to the organisation's working hours, which is what the agent
    itself does — the two must agree or the alert fires outside the window the
    agent was told to track.
    """
    if user.schedule_id:
        sched = db.get(WorkSchedule, user.schedule_id)
        if sched:
            return (
                _hhmm(sched.start_time, dtime(9, 0)),
                _hhmm(sched.end_time, dtime(18, 0)),
                sched.working_days,
            )
    start = _hhmm(getattr(org_settings, "work_day_start", "09:00"), dtime(9, 0))
    end = _hhmm(getattr(org_settings, "work_day_end", "18:00"), dtime(18, 0))
    return start, end, 0b0011111


def _within_working_hours(now_local: datetime, start: dtime, end: dtime, days: int) -> bool:
    if not days & (1 << now_local.weekday()):
        return False
    t = now_local.time()
    if start <= end:
        return start <= t <= end
    return t >= start or t <= end  # overnight shift


def _period_bounds(day: date, period: str) -> tuple[date, date]:
    if period == "daily":
        return day, day
    if period == "monthly":
        first = day.replace(day=1)
        nxt = (first + timedelta(days=32)).replace(day=1)
        return first, nxt - timedelta(days=1)
    monday = day - timedelta(days=day.weekday())
    return monday, monday + timedelta(days=6)


# --------------------------------------------------------------------------- #
# rules
# --------------------------------------------------------------------------- #

def rule_agent_silent(db: Session, org: Organization, now: datetime, dry: bool) -> int:
    """Tell an employee their agent has gone quiet while they should be working.

    The alert that would have caught 18 August: the agent stopped at 16:02 and
    nobody found out until the next morning, by which time the afternoon was
    unrecoverable.

    Keyed by local date, so a machine left off for a week produces one mail per
    working day rather than one every fifteen minutes.
    """
    tz_name = _org_tz(db, org)
    tz = reports.tz_for(tz_name)
    now_local = now.astimezone(tz)
    org_settings = db.scalar(select(OrgSettings).where(OrgSettings.org_id == org.id))
    sent = 0

    for user in notif.recipients_for(db, org.id, Audience.EMPLOYEE):
        start, end, days = _schedule_for(db, user, org_settings)
        if not _within_working_hours(now_local, start, end, days):
            continue
        # Not yet far enough into the day for silence to mean anything.
        if (datetime.combine(now_local.date(), start, tzinfo=tz) + timedelta(
            minutes=SILENT_AFTER_MINUTES
        )) > now_local:
            continue

        devices = list(
            db.scalars(
                select(Device).where(Device.user_id == user.id, Device.is_active.is_(True))
            ).all()
        )
        # Never enrolled is a different problem, with a different fix. Silence is
        # about a machine that used to report and stopped.
        if not devices:
            continue

        latest = max((d.last_seen_at for d in devices if d.last_seen_at), default=None)
        if latest is None:
            continue
        if latest.tzinfo is None:
            latest = latest.replace(tzinfo=timezone.utc)
        gap = int((now - latest).total_seconds() // 60)
        if gap < SILENT_AFTER_MINUTES:
            continue

        device = max(
            devices, key=lambda d: d.last_seen_at or datetime.min.replace(tzinfo=timezone.utc)
        )
        # Keyed on the local date of the LAST REPORT, not of today: a machine
        # left off over a long weekend is one silence, not three, and the key
        # changes the moment it reports again and stops again.
        key = latest.astimezone(tz).date().isoformat()
        local = latest.astimezone(tz).strftime("%d %b %Y, %H:%M")
        # dispatch() applies this too, but only on the real path. Without the
        # same check here a dry run reports people who have switched the alert
        # off, so it over-counts — and a preview that disagrees with the thing
        # it is previewing is worse than no preview.
        if dry and not notif.wants(db, user, Kind.AGENT_SILENT):
            continue
        if dry:
            log.info("[dry] agent_silent -> %s (%s, %dm since %s)",
                     user.email, device.hostname, gap, local)
            sent += 1
            continue
        ok = notif.dispatch(
            db, user, Kind.AGENT_SILENT, key,
            subject="Your MyDeskTime agent stopped reporting",
            send_fn=lambda u=user, d=device, l=local, g=gap: email.send_agent_silent(
                to=u.email, name=u.full_name, hostname=d.hostname,
                last_seen_local=l, gap_minutes=g,
                console_url=_console_url(org),
                manage_url=_console_url(org, "/notifications"),
                org_id=org.id,
            ),
        )
        sent += 1 if ok else 0
    return sent


def rule_timesheet_due(db: Session, org: Organization, now: datetime, dry: bool) -> int:
    """Nudge an employee whose period closes today and whose sheet is a draft."""
    tz = reports.tz_for(_org_tz(db, org))
    today = now.astimezone(tz).date()
    start, end = _period_bounds(today, "weekly")
    if today != end:  # only on the last day of the period
        return 0

    sent = 0
    for user in notif.recipients_for(db, org.id, Audience.EMPLOYEE):
        approval = db.scalar(
            select(TimesheetApproval).where(
                TimesheetApproval.user_id == user.id,
                TimesheetApproval.period_start == start,
                TimesheetApproval.period_type == "weekly",
            )
        )
        if approval is not None and approval.status != "draft":
            continue
        key = f"weekly:{start.isoformat()}"
        # dispatch() applies this too, but only on the real path. Without the
        # same check here a dry run reports people who have switched the alert
        # off, so it over-counts — and a preview that disagrees with the thing
        # it is previewing is worse than no preview.
        if dry and not notif.wants(db, user, Kind.TIMESHEET_DUE):
            continue
        if dry:
            log.info("[dry] timesheet_due -> %s (%s)", user.email, key)
            sent += 1
            continue
        if not notif.wants(db, user, Kind.TIMESHEET_DUE) or notif.already_sent(
            db, user, Kind.TIMESHEET_DUE, key
        ):
            continue
        period = f"{start.isoformat()} to {end.isoformat()}"
        ok = notif.dispatch(
            db, user, Kind.TIMESHEET_DUE, key,
            subject=f"Timesheet due - {period}",
            send_fn=lambda u=user: email.send_timesheet_due(
                to=u.email, name=u.full_name, period=period, ends_on=end.isoformat(),
                url=_console_url(org, "/timesheets"),
                manage_url=_console_url(org, "/notifications"),
                org_id=org.id,
            ),
        )
        sent += 1 if ok else 0
    return sent


def rule_approvals_pending(db: Session, org: Organization, now: datetime, dry: bool) -> int:
    """Daily reminder to reviewers while submitted timesheets sit unreviewed."""
    tz = reports.tz_for(_org_tz(db, org))
    today = now.astimezone(tz).date()
    start, end = _period_bounds(today, "weekly")

    pending = db.scalar(
        select(func.count(TimesheetApproval.id)).where(
            TimesheetApproval.org_id == org.id,
            TimesheetApproval.status == "submitted",
        )
    ) or 0
    if pending == 0:
        return 0

    sent = 0
    for user in notif.recipients_for(db, org.id, Audience.MANAGER):
        # The count is in the key: the reminder legitimately fires again when
        # the pile grows, and stays quiet while it does not.
        key = f"{today.isoformat()}:{pending}"
        # dispatch() applies this too, but only on the real path. Without the
        # same check here a dry run reports people who have switched the alert
        # off, so it over-counts — and a preview that disagrees with the thing
        # it is previewing is worse than no preview.
        if dry and not notif.wants(db, user, Kind.APPROVALS_PENDING):
            continue
        if dry:
            log.info("[dry] approvals_pending -> %s (%d)", user.email, pending)
            sent += 1
            continue
        noun = "timesheet" if pending == 1 else "timesheets"
        ok = notif.dispatch(
            db, user, Kind.APPROVALS_PENDING, key,
            subject=f"{pending} {noun} awaiting your approval",
            send_fn=lambda u=user: email.send_approvals_pending(
                to=u.email, name=u.full_name, count=pending,
                period=f"{start.isoformat()} to {end.isoformat()}",
                url=_console_url(org, "/timesheets"),
                manage_url=_console_url(org, "/notifications"),
                org_id=org.id,
            ),
        )
        sent += 1 if ok else 0
    return sent


def rule_weekly_summary(db: Session, org: Organization, now: datetime, dry: bool) -> int:
    """Last week's own figures, to the person they are about. Mondays only."""
    tz_name = _org_tz(db, org)
    tz = reports.tz_for(tz_name)
    now_local = now.astimezone(tz)
    if now_local.weekday() != 0 or now_local.hour < 8:
        return 0

    end = now_local.date() - timedelta(days=1)          # yesterday, Sunday
    start = end - timedelta(days=6)                      # the Monday before
    win_start, win_end = reports.range_bounds(start, end, tz_name)
    sent = 0

    for user in notif.recipients_for(db, org.id, Audience.EMPLOYEE):
        totals = reports.totals_for(db, org.id, win_start, win_end, [user.id])
        if totals.tracked_s == 0:
            continue  # nothing to report is not a report
        key = start.isoformat()
        # dispatch() applies this too, but only on the real path. Without the
        # same check here a dry run reports people who have switched the alert
        # off, so it over-counts — and a preview that disagrees with the thing
        # it is previewing is worse than no preview.
        if dry and not notif.wants(db, user, Kind.WEEKLY_SUMMARY):
            continue
        if dry:
            log.info("[dry] weekly_summary -> %s (%.1fh)", user.email, totals.tracked_s / 3600)
            sent += 1
            continue
        if not notif.wants(db, user, Kind.WEEKLY_SUMMARY) or notif.already_sent(
            db, user, Kind.WEEKLY_SUMMARY, key
        ):
            continue
        period = f"{start.isoformat()} to {end.isoformat()}"
        worked = _days_worked(db, org.id, user, start, end, tz_name)
        ok = notif.dispatch(
            db, user, Kind.WEEKLY_SUMMARY, key,
            subject=f"Your week on MyDeskTime - {period}",
            send_fn=lambda u=user, t=totals, w=worked: email.send_weekly_summary(
                to=u.email, name=u.full_name, period=period,
                tracked=_hours(t.tracked_s), active=_hours(t.active_s),
                productivity=int(t.productivity_pct), days_worked=w,
                url=_console_url(org, "/me"),
                manage_url=_console_url(org, "/notifications"),
                org_id=org.id,
            ),
        )
        sent += 1 if ok else 0
    return sent


def _hours(seconds: int) -> str:
    h, m = divmod(int(seconds) // 60, 60)
    return f"{h}h {m}m" if h else f"{m}m"


def _days_worked(db, org_id, user, start: date, end: date, tz_name: str) -> int:
    n = 0
    day = start
    while day <= end:
        d0, d1 = reports.day_bounds(day, tz_name)
        if reports.totals_for(db, org_id, d0, d1, [user.id]).tracked_s > 0:
            n += 1
        day += timedelta(days=1)
    return n


def rule_billing_and_capacity(db: Session, org: Organization, now: datetime, dry: bool) -> int:
    """Trial, payment, seats and storage — to administrators only."""
    try:
        usage = subscriptions.usage_for(db, org)
    except Exception:  # noqa: BLE001 - a billing lookup must not stop the run
        log.exception("usage lookup failed for %s", org.slug)
        return 0

    status = usage.get("status")
    days_left = usage.get("days_remaining")
    alerts: list[tuple[Kind, str, str, str]] = []

    if status in ("past_due", "expired", "suspended"):
        alerts.append((
            Kind.BILLING_ATTENTION, f"billing:{status}",
            "Payment overdue" if status == "past_due" else f"Subscription {status}",
            "Tracking continues, but the console will lock without a renewal.",
        ))
    elif status == "trialing" and days_left is not None and days_left <= 7:
        alerts.append((
            Kind.BILLING_ATTENTION, f"trial:{days_left}",
            "Trial ends in %d day%s" % (days_left, "" if days_left == 1 else "s"),
            "Choose a plan to keep tracking after the trial.",
        ))

    limit = usage.get("seat_limit") or 0
    if limit and (usage.get("seats_available") or 0) <= 0:
        alerts.append((
            Kind.CAPACITY_WARNING, f"seats:{usage.get('seats_used')}",
            "Seat limit reached",
            f"{usage.get('seats_used')} of {limit} seats in use - no room to add an employee.",
        ))

    gb_limit = usage.get("storage_gb_limit") or 0
    if gb_limit:
        pct = int(usage.get("storage_bytes", 0) / (gb_limit * 1024 ** 3) * 100)
        if pct >= 90:
            alerts.append((
                Kind.CAPACITY_WARNING, f"storage:{pct}",
                f"Screenshot storage {pct}% full",
                "Shorten the retention window or move to a larger plan.",
            ))

    sent = 0
    for kind, key, headline, detail in alerts:
        for user in notif.recipients_for(db, org.id, Audience.ADMIN):
            # Same reason as the rules above: preview what will actually go.
            if dry and not notif.wants(db, user, kind):
                continue
            if dry:
                log.info("[dry] %s -> %s (%s)", kind.value, user.email, headline)
                sent += 1
                continue
            template = (
                email.send_billing_attention if kind is Kind.BILLING_ATTENTION
                else email.send_capacity_warning
            )
            ok = notif.dispatch(
                db, user, kind, key, subject=f"{headline} - {org.name}",
                send_fn=lambda u=user, t=template, h=headline, d=detail: t(
                    to=u.email, org_name=org.name, headline=h, detail=d,
                    url=_console_url(org, "/billing"),
                    org_id=org.id,
                ),
            )
            sent += 1 if ok else 0
    return sent


RULES = {
    "agent_silent": rule_agent_silent,
    "timesheet_due": rule_timesheet_due,
    "approvals_pending": rule_approvals_pending,
    "weekly_summary": rule_weekly_summary,
    "billing": rule_billing_and_capacity,
}


# --------------------------------------------------------------------------- #
# entry point
# --------------------------------------------------------------------------- #

def run(only: str | None = None, dry: bool = False) -> int:
    now = datetime.now(timezone.utc)
    total = 0
    with SessionLocal() as db:
        orgs = list(db.scalars(select(Organization)).all())
        log.info("evaluating %d rule(s) across %d organisation(s)",
                 len(RULES) if not only else 1, len(orgs))
        for org in orgs:
            for name, fn in RULES.items():
                if only and name != only:
                    continue
                try:
                    n = fn(db, org, now, dry)
                except Exception:  # noqa: BLE001 - one bad rule must not stop the rest
                    db.rollback()
                    log.exception("rule %s failed for %s", name, org.slug)
                    continue
                if n:
                    log.info("  %-18s %-16s %d", org.slug, name, n)
                    total += n
    log.info("%s %d notification(s)", "would send" if dry else "sent", total)
    return total


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="app.alerts", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    r = sub.add_parser("run", help="evaluate every rule once")
    r.add_argument("--dry-run", action="store_true", help="decide and print, send nothing")
    r.add_argument("--only", choices=sorted(RULES), help="run a single rule")
    r.add_argument("--log-level", default="INFO")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=args.log_level.upper(),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )
    # Reported per workspace: each may have its own connector, and "mail works"
    # is not a single fact any more.
    with SessionLocal() as probe:
        for org in probe.scalars(select(Organization)).all():
            cfg = mailconfig.resolve(probe, org.id)
            if cfg.configured:
                log.info("mail for %s: %s:%s (%s)", org.slug, cfg.host, cfg.port, cfg.source)
            else:
                log.warning(
                    "mail for %s: no connector - messages will be logged, not delivered",
                    org.slug,
                )
    run(only=args.only, dry=args.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
