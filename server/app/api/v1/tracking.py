"""Employee tracking: pings people share, the live map, and a day's route.

Posting is for yourself only. Reading is for people who see a team, and only for the people they
see: an administrator sees everyone, a manager their reports.
"""

from __future__ import annotations

import math
import uuid
from datetime import date, datetime, time, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession, visible_user_ids
from app.models import AttendanceRecord, LocationPing, Organization, User
from app.services import reports

router = APIRouter(tags=["tracking"])

#: A position older than this is "last seen", not "reporting now".
FRESH = timedelta(minutes=15)
#: How far back the live map looks.
LOOKBACK = timedelta(hours=12)


class PointIn(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    accuracy_m: float | None = Field(default=None, ge=0, le=100_000)
    speed_mps: float | None = Field(default=None, ge=0, le=500)
    at: datetime | None = None


class PingsIn(BaseModel):
    points: list[PointIn] = Field(min_length=1, max_length=50)


def _metres(a_lat: float, a_lng: float, b_lat: float, b_lng: float) -> float:
    r = 6_371_000
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = p2 - p1, math.radians(b_lng - a_lng)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _people(db, viewer: User) -> list[User]:
    if not (viewer.role_enum.can_administer or viewer.role_enum.can_view_team):
        raise HTTPException(403, "Tracking is for people who manage a team.")
    scope = visible_user_ids(db, viewer)
    stmt = select(User).where(User.org_id == viewer.org_id, User.is_active.is_(True))
    if scope is not None:
        stmt = stmt.where(User.id.in_(scope))
    return list(db.scalars(stmt.order_by(User.full_name)))


@router.post("/location/pings")
def post_pings(payload: PingsIn, viewer: CurrentUser, db: DbSession) -> dict:
    # HR can switch GPS tracking off for the company (HR Settings > Attendance); nothing is kept while it is off.
    from app.models import AttendanceSettings

    policy = db.get(AttendanceSettings, viewer.org_id)
    if policy is not None and not policy.gps_tracking_enabled:
        return {"saved": 0, "enabled": False}
    now = datetime.now(timezone.utc)
    kept = 0
    for p in payload.points:
        at = _aware(p.at) if p.at else now
        if at > now + timedelta(minutes=5) or at < now - timedelta(days=2):
            continue
        db.add(LocationPing(org_id=viewer.org_id, user_id=viewer.id, lat=p.lat, lng=p.lng,
                            accuracy_m=p.accuracy_m, speed_mps=p.speed_mps, recorded_at=at))
        kept += 1
    db.commit()
    return {"saved": kept}


@router.get("/tracking/people")
def people(viewer: CurrentUser, db: DbSession) -> list[dict]:
    return [{"id": str(u.id), "name": u.full_name} for u in _people(db, viewer)]


@router.get("/tracking/live")
def live(viewer: CurrentUser, db: DbSession) -> dict:
    now = datetime.now(timezone.utc)
    out = []
    for person in _people(db, viewer):
        recent = list(db.scalars(
            select(LocationPing).where(LocationPing.org_id == viewer.org_id, LocationPing.user_id == person.id,
                                       LocationPing.recorded_at >= now - LOOKBACK)
            .order_by(LocationPing.recorded_at.desc()).limit(2)))
        if not recent:
            continue
        last = recent[0]
        at = _aware(last.recorded_at)
        fresh = now - at <= FRESH
        moving = False
        if fresh:
            if last.speed_mps is not None:
                moving = last.speed_mps >= 1.0
            elif len(recent) == 2:
                prev = recent[1]
                gap = (at - _aware(prev.recorded_at)).total_seconds()
                moving = 0 < gap <= 600 and _metres(prev.lat, prev.lng, last.lat, last.lng) >= 50
        out.append({"user_id": str(person.id), "name": person.full_name, "lat": last.lat, "lng": last.lng,
                    "accuracy_m": last.accuracy_m, "at": at.isoformat(), "state": "reporting" if fresh else "earlier",
                    "moving": moving})
    out.sort(key=lambda r: (r["state"] != "reporting", r["name"]))
    return {
        "now": now.isoformat(),
        "reporting": sum(1 for r in out if r["state"] == "reporting"),
        "earlier": sum(1 for r in out if r["state"] == "earlier"),
        "moving": sum(1 for r in out if r["moving"]),
        "people": out,
    }


def _hhmm(value: str | None, default: time) -> time:
    if not value:
        return default
    try:
        hour, minute = value.split(":")
        return time(int(hour), int(minute))
    except (ValueError, TypeError):
        raise HTTPException(422, "Times are HH:MM")


@router.get("/tracking/route")
def route(
    viewer: CurrentUser, db: DbSession, user_id: uuid.UUID, day: date = Query(alias="date"),
    start: str | None = None, end: str | None = None,
) -> dict:
    allowed = {u.id for u in _people(db, viewer)} | {viewer.id}
    if user_id not in allowed:
        raise HTTPException(403, "You do not see this person's route.")
    org = db.get(Organization, viewer.org_id)
    tz = reports.tz_for(org.timezone if org else "UTC")
    lo = datetime.combine(day, _hhmm(start, time(0, 0)), tzinfo=tz)
    hi = datetime.combine(day, _hhmm(end, time(23, 59, 59)), tzinfo=tz)
    rows = list(db.scalars(
        select(LocationPing).where(LocationPing.org_id == viewer.org_id, LocationPing.user_id == user_id,
                                   LocationPing.recorded_at >= lo, LocationPing.recorded_at <= hi)
        .order_by(LocationPing.recorded_at)))
    points, distance = [], 0.0
    for r in rows:
        if points and _metres(points[-1]["lat"], points[-1]["lng"], r.lat, r.lng) < 5:
            continue  # standing still: drop the jitter
        if points:
            distance += _metres(points[-1]["lat"], points[-1]["lng"], r.lat, r.lng)
        points.append({"lat": r.lat, "lng": r.lng, "at": _aware(r.recorded_at).astimezone(tz).isoformat()})
    record = db.scalar(select(AttendanceRecord).where(
        AttendanceRecord.org_id == viewer.org_id, AttendanceRecord.user_id == user_id, AttendanceRecord.date == day))
    punches = []
    if record:
        if record.check_in_lat is not None and record.check_in_at:
            punches.append({"kind": "in", "lat": record.check_in_lat, "lng": record.check_in_lng,
                            "at": _aware(record.check_in_at).astimezone(tz).isoformat()})
        if record.check_out_lat is not None and record.check_out_at:
            punches.append({"kind": "out", "lat": record.check_out_lat, "lng": record.check_out_lng,
                            "at": _aware(record.check_out_at).astimezone(tz).isoformat()})
    return {
        "points": points, "punches": punches, "distance_km": round(distance / 1000, 2),
        "first_at": points[0]["at"] if points else None, "last_at": points[-1]["at"] if points else None,
    }
