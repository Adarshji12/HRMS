"""Aggregation queries behind the dashboard and report endpoints.

All boundaries are computed in the organisation's timezone and converted to UTC
before hitting the database, so "Monday" means the employee's Monday rather than
the server's.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import Select, case, func, select
from sqlalchemy.orm import Session

from app.models import ActivitySegment, Device, Productivity, Team, User

# A device that has not checked in for this long is shown as offline.
ONLINE_GRACE_S = 150


def tz_for(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def day_bounds(day: date, tz_name: str) -> tuple[datetime, datetime]:
    tz = tz_for(tz_name)
    start_local = datetime.combine(day, time.min, tzinfo=tz)
    return (
        start_local.astimezone(timezone.utc),
        (start_local + timedelta(days=1)).astimezone(timezone.utc),
    )


def range_bounds(start: date, end: date, tz_name: str) -> tuple[datetime, datetime]:
    """``end`` is inclusive."""
    tz = tz_for(tz_name)
    start_utc = datetime.combine(start, time.min, tzinfo=tz).astimezone(timezone.utc)
    end_utc = (
        datetime.combine(end, time.min, tzinfo=tz) + timedelta(days=1)
    ).astimezone(timezone.utc)
    return start_utc, end_utc


@dataclass
class Totals:
    tracked_s: int = 0
    active_s: int = 0
    idle_s: int = 0
    productive_s: int = 0
    unproductive_s: int = 0
    neutral_s: int = 0

    @property
    def productivity_pct(self) -> float:
        base = self.productive_s + self.unproductive_s + self.neutral_s
        return round(100 * self.productive_s / base, 1) if base else 0.0

    @property
    def efficiency_pct(self) -> float:
        """Share of tracked time that was not idle."""
        return round(100 * self.active_s / self.tracked_s, 1) if self.tracked_s else 0.0

    def as_dict(self) -> dict:
        return {
            "tracked_s": self.tracked_s,
            "active_s": self.active_s,
            "idle_s": self.idle_s,
            "productive_s": self.productive_s,
            "unproductive_s": self.unproductive_s,
            "neutral_s": self.neutral_s,
            "productivity_pct": self.productivity_pct,
            "efficiency_pct": self.efficiency_pct,
        }


@dataclass
class UserDay:
    user_id: uuid.UUID
    full_name: str
    email: str
    team: str | None
    totals: Totals = field(default_factory=Totals)
    first_activity: datetime | None = None
    last_activity: datetime | None = None
    is_online: bool = False


def _window(stmt: Select, start: datetime, end: datetime) -> Select:
    # Half-open [start, end): a segment counts against the day it started in, so
    # a segment straddling midnight is not double counted.
    return stmt.where(ActivitySegment.started_at >= start, ActivitySegment.started_at < end)


_TOTAL_COLS = (
    func.coalesce(func.sum(ActivitySegment.duration_s), 0),
    func.coalesce(func.sum(ActivitySegment.active_s), 0),
    func.coalesce(func.sum(ActivitySegment.idle_s), 0),
    func.coalesce(
        func.sum(
            case(
                (ActivitySegment.productivity == Productivity.PRODUCTIVE.value,
                 ActivitySegment.duration_s),
                else_=0,
            )
        ),
        0,
    ),
    func.coalesce(
        func.sum(
            case(
                (ActivitySegment.productivity == Productivity.UNPRODUCTIVE.value,
                 ActivitySegment.duration_s),
                else_=0,
            )
        ),
        0,
    ),
    func.coalesce(
        func.sum(
            case(
                (ActivitySegment.productivity == Productivity.NEUTRAL.value,
                 ActivitySegment.duration_s),
                else_=0,
            )
        ),
        0,
    ),
)


def totals_for(
    db: Session,
    org_id: uuid.UUID,
    start: datetime,
    end: datetime,
    user_ids: list[uuid.UUID] | None = None,
) -> Totals:
    stmt = _window(select(*_TOTAL_COLS).where(ActivitySegment.org_id == org_id), start, end)
    if user_ids is not None:
        if not user_ids:
            return Totals()
        stmt = stmt.where(ActivitySegment.user_id.in_(user_ids))
    row = db.execute(stmt).one()
    return Totals(*[int(v) for v in row])


def per_user_totals(
    db: Session, org_id: uuid.UUID, start: datetime, end: datetime
) -> dict[uuid.UUID, Totals]:
    stmt = _window(
        select(ActivitySegment.user_id, *_TOTAL_COLS)
        .where(ActivitySegment.org_id == org_id)
        .group_by(ActivitySegment.user_id),
        start,
        end,
    )
    return {row[0]: Totals(*[int(v) for v in row[1:]]) for row in db.execute(stmt)}


def team_names(db: Session, org_id: uuid.UUID) -> dict[uuid.UUID, str]:
    """Resolved once per request. Reading ``user.team_name`` per row would lazy
    load one query per employee — the classic N+1 on any roster view."""
    return {
        team.id: team.name
        for team in db.scalars(select(Team).where(Team.org_id == org_id)).all()
    }


def user_day_rows(
    db: Session, org_id: uuid.UUID, start: datetime, end: datetime
) -> list[UserDay]:
    users = db.scalars(
        select(User).where(User.org_id == org_id, User.is_active.is_(True)).order_by(User.full_name)
    ).all()
    totals = per_user_totals(db, org_id, start, end)
    teams = team_names(db, org_id)

    span_stmt = _window(
        select(
            ActivitySegment.user_id,
            func.min(ActivitySegment.started_at),
            func.max(ActivitySegment.ended_at),
        )
        .where(ActivitySegment.org_id == org_id)
        .group_by(ActivitySegment.user_id),
        start,
        end,
    )
    spans = {row[0]: (row[1], row[2]) for row in db.execute(span_stmt)}

    cutoff = datetime.now(timezone.utc) - timedelta(seconds=ONLINE_GRACE_S)
    online_ids = set(
        db.scalars(
            select(Device.user_id).where(
                Device.org_id == org_id,
                Device.is_active.is_(True),
                Device.last_seen_at.is_not(None),
                Device.last_seen_at >= cutoff,
            )
        ).all()
    )

    rows: list[UserDay] = []
    for u in users:
        first, last = spans.get(u.id, (None, None))
        rows.append(
            UserDay(
                user_id=u.id,
                full_name=u.full_name,
                email=u.email,
                team=teams.get(u.team_id),
                totals=totals.get(u.id, Totals()),
                first_activity=first,
                last_activity=last,
                is_online=u.id in online_ids,
            )
        )
    return rows


def top_breakdown(
    db: Session,
    org_id: uuid.UUID,
    start: datetime,
    end: datetime,
    *,
    by: str,
    user_ids: list[uuid.UUID] | None = None,
    limit: int = 15,
) -> list[dict]:
    """``by`` is one of ``app``, ``domain``, ``browser``."""
    if by == "app":
        label = ActivitySegment.app_name
        extra_filter = ActivitySegment.is_browser.is_(False)
    elif by == "domain":
        label = ActivitySegment.url_domain
        extra_filter = ActivitySegment.url_domain.is_not(None)
    elif by == "browser":
        label = ActivitySegment.browser
        extra_filter = ActivitySegment.browser.is_not(None)
    else:
        raise ValueError(f"unknown breakdown: {by}")

    stmt = _window(
        select(
            label,
            func.coalesce(func.sum(ActivitySegment.duration_s), 0),
            func.coalesce(func.sum(ActivitySegment.active_s), 0),
            func.max(ActivitySegment.productivity),
        )
        .where(ActivitySegment.org_id == org_id, extra_filter, ActivitySegment.is_idle.is_(False))
        .group_by(label)
        .order_by(func.sum(ActivitySegment.duration_s).desc())
        .limit(limit),
        start,
        end,
    )
    if user_ids is not None:
        if not user_ids:
            return []
        stmt = stmt.where(ActivitySegment.user_id.in_(user_ids))

    out = []
    for name, duration, active, productivity in db.execute(stmt):
        if not name:
            continue
        out.append(
            {
                "label": name,
                "duration_s": int(duration),
                "active_s": int(active),
                "productivity": productivity or Productivity.NEUTRAL.value,
            }
        )
    return out


def hourly_histogram(
    db: Session,
    org_id: uuid.UUID,
    start: datetime,
    end: datetime,
    tz_name: str,
    user_ids: list[uuid.UUID] | None = None,
) -> list[dict]:
    """24 buckets of active seconds, in the organisation's local hours.

    Bucketing is done in Python rather than SQL: ``date_trunc`` at a timezone is
    Postgres-only, and this endpoint has to work on the SQLite dev database too.
    The row count for one day of one org is small enough that it does not matter.
    """
    stmt = _window(
        select(
            ActivitySegment.started_at,
            ActivitySegment.duration_s,
            ActivitySegment.active_s,
            ActivitySegment.productivity,
        ).where(ActivitySegment.org_id == org_id),
        start,
        end,
    )
    if user_ids is not None:
        if not user_ids:
            return [{"hour": h, "active_s": 0, "productive_s": 0, "unproductive_s": 0}
                    for h in range(24)]
        stmt = stmt.where(ActivitySegment.user_id.in_(user_ids))

    tz = tz_for(tz_name)
    buckets = [{"hour": h, "active_s": 0, "productive_s": 0, "unproductive_s": 0}
               for h in range(24)]
    for started_at, duration_s, active_s, productivity in db.execute(stmt):
        if started_at.tzinfo is None:
            started_at = started_at.replace(tzinfo=timezone.utc)
        hour = started_at.astimezone(tz).hour
        buckets[hour]["active_s"] += int(active_s)
        if productivity == Productivity.PRODUCTIVE.value:
            buckets[hour]["productive_s"] += int(duration_s)
        elif productivity == Productivity.UNPRODUCTIVE.value:
            buckets[hour]["unproductive_s"] += int(duration_s)
    return buckets


def daily_series(
    db: Session,
    org_id: uuid.UUID,
    start: date,
    end: date,
    tz_name: str,
    user_ids: list[uuid.UUID] | None = None,
) -> list[dict]:
    """One row per calendar day in [start, end], inclusive."""
    out = []
    day = start
    while day <= end:
        d0, d1 = day_bounds(day, tz_name)
        totals = totals_for(db, org_id, d0, d1, user_ids)
        out.append({"date": day.isoformat(), **totals.as_dict()})
        day += timedelta(days=1)
    return out
