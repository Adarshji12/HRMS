"""Check stored activity data for the shapes that make reports lie.

    python -m app.services.dataaudit

Every check here corresponds to a way the numbers on a dashboard can be wrong
while nothing raises an error. That is the failure mode worth hunting in this
product: an employer makes decisions about people from these figures, so a
plausible wrong number does more damage than a visible outage.

Reports only. Nothing is modified — each finding names the command that fixes
it, so the operator decides.
"""

from __future__ import annotations

import argparse
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

from app.db.session import SessionLocal
from app.models import Device, OrgSettings, Organization, User
from app.models.activity import ActivitySegment
from app.models.device import WorkSession
from app.models.screenshot import Screenshot

log = logging.getLogger("sentinel.dataaudit")

# Shells that are the lock screen rather than an application. Time spent here
# is not work, and before the agent's lock detection was hardened it was banked
# as ordinary activity.
LOCK_SHELLS = {"lockapp.exe", "logonui.exe", "lockapp", "logonui"}

# No single focused window plausibly lasts this long. A segment longer than
# this means a tracker that stopped sampling and closed the gap on resume.
IMPLAUSIBLE_SEGMENT_S = 6 * 3600


@dataclass
class Finding:
    check: str
    count: int
    detail: str
    fix: str = ""
    severity: str = "warn"


@dataclass
class Report:
    findings: list[Finding] = field(default_factory=list)

    def add(self, *args, **kwargs) -> None:
        self.findings.append(Finding(*args, **kwargs))


def _utc(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def audit() -> Report:
    report = Report()
    now = datetime.now(timezone.utc)

    with SessionLocal() as db:
        # -- 1. overlapping segments -------------------------------------
        # The one that inflated a 5-hour day to 36. Totals are SUM(duration_s),
        # which is only elapsed time while a person's segments are disjoint.
        overlap_users, overlap_segments, overlap_seconds = 0, 0, 0
        for user_id in db.scalars(select(User.id)).all():
            rows = db.execute(
                select(ActivitySegment.started_at, ActivitySegment.ended_at, ActivitySegment.duration_s)
                .where(ActivitySegment.user_id == user_id, ActivitySegment.ended_at.is_not(None))
                .order_by(ActivitySegment.started_at)
            ).all()
            reach, dropped, seconds = None, 0, 0
            for row in rows:
                start, end = _utc(row.started_at), _utc(row.ended_at)
                if reach is not None and (min(end, reach) - start).total_seconds() > 1:
                    dropped += 1
                    seconds += row.duration_s
                    continue
                reach = end if reach is None else max(reach, end)
            if dropped:
                overlap_users += 1
                overlap_segments += dropped
                overlap_seconds += seconds
        if overlap_segments:
            report.add(
                "Overlapping segments", overlap_segments,
                f"{overlap_users} employee(s), {overlap_seconds / 3600:.1f} h counted more than once",
                "python -m app.services.deoverlap --dry-run", "critical",
            )

        # -- 2. lock screen banked as work -------------------------------
        lock_rows = db.execute(
            select(func.count(ActivitySegment.id), func.coalesce(func.sum(ActivitySegment.duration_s), 0))
            .where(func.lower(ActivitySegment.app_exec).in_(LOCK_SHELLS))
        ).one()
        if lock_rows[0]:
            report.add(
                "Lock screen counted as activity", int(lock_rows[0]),
                f"{lock_rows[1] / 3600:.1f} h recorded while the machine was locked",
                "recorded before lock detection was hardened; remove or reclassify", "critical",
            )

        # -- 3. active + idle must equal duration ------------------------
        mismatched = db.scalar(
            select(func.count(ActivitySegment.id)).where(
                ActivitySegment.active_s + ActivitySegment.idle_s > ActivitySegment.duration_s
            )
        )
        if mismatched:
            report.add(
                "Active + idle exceeds duration", int(mismatched),
                "the activity split does not add up, so efficiency percentages are wrong",
                "ingest clamps these; rows predate that clamp",
            )

        # -- 4. implausibly long segments --------------------------------
        long_rows = db.execute(
            select(func.count(ActivitySegment.id), func.coalesce(func.sum(ActivitySegment.duration_s), 0))
            .where(ActivitySegment.duration_s > IMPLAUSIBLE_SEGMENT_S)
        ).one()
        if long_rows[0]:
            report.add(
                "Implausibly long segments", int(long_rows[0]),
                f"single focused windows over {IMPLAUSIBLE_SEGMENT_S // 3600} h, totalling "
                f"{long_rows[1] / 3600:.1f} h — usually a suspended machine closing the gap on resume",
            )

        # -- 5. work sessions ---------------------------------------------
        zero_sessions = db.scalar(
            select(func.count(WorkSession.id)).where(WorkSession.duration_s == 0)
        )
        if zero_sessions:
            report.add(
                "Zero-length attendance rows", int(zero_sessions),
                "agent starts that recorded no work; they clutter the attendance table "
                "without changing any total",
                "python -m app.services.dataaudit --clean-sessions",
            )

        # -- 6. duplicate screenshots -------------------------------------
        dupe_shots = db.execute(
            select(func.count())
            .select_from(
                select(Screenshot.user_id, Screenshot.captured_at)
                .group_by(Screenshot.user_id, Screenshot.captured_at)
                .having(func.count(Screenshot.id) > 1)
                .subquery()
            )
        ).scalar()
        if dupe_shots:
            report.add(
                "Screenshots captured at the same instant", int(dupe_shots),
                "two trackers capturing at once; the gallery shows each moment twice",
            )

        # -- 7. future and ancient timestamps ------------------------------
        future = db.scalar(
            select(func.count(ActivitySegment.id))
            .where(ActivitySegment.started_at > now + timedelta(minutes=10))
        )
        if future:
            report.add(
                "Segments dated in the future", int(future),
                "a machine with a wrong clock; these land in tomorrow's report",
            )

        # -- 8. tracking outside the configured working hours -------------
        for org in db.scalars(select(Organization)).all():
            settings = db.get(OrgSettings, org.id)
            if settings is None or settings.track_outside_hours:
                continue
            # Counted in the organisation's own timezone, which is the window
            # the policy is expressed in.
            outside = 0
            rows = db.execute(
                select(ActivitySegment.started_at)
                .where(ActivitySegment.org_id == org.id)
            ).scalars().all()
            try:
                from zoneinfo import ZoneInfo

                tz = ZoneInfo(org.timezone or "UTC")
            except Exception:  # noqa: BLE001
                tz = timezone.utc
            start_h, start_m = (settings.work_day_start or "00:00").split(":")[:2]
            end_h, end_m = (settings.work_day_end or "23:59").split(":")[:2]
            lo = int(start_h) * 60 + int(start_m)
            hi = int(end_h) * 60 + int(end_m)
            for started in rows:
                local = _utc(started).astimezone(tz)
                minute = local.hour * 60 + local.minute
                inside = lo <= minute <= hi if lo <= hi else (minute >= lo or minute <= hi)
                if not inside:
                    outside += 1
            if outside:
                report.add(
                    f"Activity outside working hours ({org.slug})", outside,
                    f"policy says {settings.work_day_start}-{settings.work_day_end} with "
                    "'track outside hours' off, yet these were recorded",
                    "agents apply this locally; check their timezone and agent version",
                )

        # -- 9. per-employee schedules that govern nothing -----------------
        scheduled = db.scalar(select(func.count(User.id)).where(User.schedule_id.is_not(None)))
        if scheduled:
            report.add(
                "Work schedules that do not reach the agent", int(scheduled),
                "employees have a work schedule assigned, but the heartbeat sends only the "
                "organisation policy, so their tracking window is the org default",
                "either send the schedule per device or stop offering it as a tracking control",
            )

        # -- 10. devices that cannot capture -------------------------------
        blocked = db.scalar(
            select(func.count(Device.id)).where(Device.capture_blocked.is_not(None))
        )
        if blocked:
            report.add(
                "Devices reporting but not capturing", int(blocked),
                "online and enrolled, collecting no screenshots — a Wayland session or an "
                "ungranted macOS permission",
            )

    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="app.services.dataaudit", description=__doc__)
    parser.add_argument("--clean-sessions", action="store_true",
                        help="delete zero-length attendance rows (changes no total)")
    parser.add_argument("--clean-lock", action="store_true",
                        help="delete segments recorded while the machine was locked")
    parser.add_argument("--log-level", default="WARNING")
    args = parser.parse_args(argv)
    logging.basicConfig(level=args.log_level.upper(), format="%(levelname)-7s %(message)s")

    if args.clean_sessions:
        from sqlalchemy import delete

        with SessionLocal() as db:
            result = db.execute(delete(WorkSession).where(WorkSession.duration_s == 0))
            db.commit()
            print(f"removed {result.rowcount} zero-length attendance row(s)")
        return 0

    if args.clean_lock:
        from sqlalchemy import delete

        # Deleted rather than reclassified as idle. Idle time is still tracked
        # time, and a locked machine is not being worked at — leaving these as
        # idle would keep them in the working-time total, which is the number
        # that was wrong in the first place.
        with SessionLocal() as db:
            seconds = db.scalar(
                select(func.coalesce(func.sum(ActivitySegment.duration_s), 0)).where(
                    func.lower(ActivitySegment.app_exec).in_(LOCK_SHELLS)
                )
            )
            result = db.execute(
                delete(ActivitySegment).where(
                    func.lower(ActivitySegment.app_exec).in_(LOCK_SHELLS)
                )
            )
            db.commit()
            print(
                f"removed {result.rowcount} lock-screen segment(s), "
                f"{(seconds or 0) / 3600:.1f} h of falsely recorded work"
            )
        return 0

    report = audit()
    print()
    print("=" * 76)
    print("  Activity data audit")
    print("=" * 76)
    if not report.findings:
        print("\n  Nothing to report — no known distortion in the stored data.\n")
        return 0

    for f in sorted(report.findings, key=lambda x: x.severity != "critical"):
        mark = "!!" if f.severity == "critical" else " *"
        print(f"\n{mark} {f.check}: {f.count}")
        print(f"     {f.detail}")
        if f.fix:
            print(f"     fix: {f.fix}")
    print()
    return 1 if any(f.severity == "critical" for f in report.findings) else 0


if __name__ == "__main__":
    raise SystemExit(main())
