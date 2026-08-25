"""Remove overlapping activity segments left by concurrent trackers.

Before the ingest guard existed, two agent instances — or two enrolled
machines — could both record the same wall clock. Every segment carried its own
client_uid, so the idempotent ingest accepted all of them, and totals are
SUM(duration_s). The result is a stored history that reports more hours than
there were.

This repairs data recorded before the guard. It is a one-off, and it is written
to be run with --dry-run first, because the fix is a delete and the operator
should see the number before it happens.

Keeps the earliest segment of any overlapping pair. Not the longest, and not a
merge: the earliest is the one whose app, window title and productivity were
actually observed at that moment, and rewriting a segment's boundaries would
invent attribution that no tracker recorded.
"""

from __future__ import annotations

import argparse
import logging
from datetime import datetime, timezone

from sqlalchemy import delete, select

from app.db.session import SessionLocal
from app.models import User
from app.models.activity import ActivitySegment

log = logging.getLogger("sentinel.deoverlap")


def _utc(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def find_overlapping(db, user_id) -> list:
    """Segment ids to remove so this user's remaining segments are disjoint.

    A sweep in start order: keep a segment when it begins at or after the point
    the kept set already reaches, drop it otherwise. One pass, and it needs
    only the running maximum rather than the whole kept set.
    """
    rows = db.execute(
        select(
            ActivitySegment.id, ActivitySegment.started_at, ActivitySegment.ended_at
        )
        .where(ActivitySegment.user_id == user_id, ActivitySegment.ended_at.is_not(None))
        .order_by(ActivitySegment.started_at, ActivitySegment.ended_at)
    ).all()

    drop = []
    reach: datetime | None = None
    for row in rows:
        start, end = _utc(row.started_at), _utc(row.ended_at)
        # A one-second touch is not an overlap: consecutive segments from a
        # healthy agent share an edge.
        if reach is not None and (min(end, reach) - start).total_seconds() > 1:
            drop.append(row.id)
            continue
        reach = end if reach is None else max(reach, end)
    return drop


def run(dry: bool = True) -> dict:
    totals = {"users": 0, "segments_removed": 0, "seconds_removed": 0}
    with SessionLocal() as db:
        users = db.scalars(select(User.id)).all()
        for user_id in users:
            drop = find_overlapping(db, user_id)
            if not drop:
                continue
            removed = db.execute(
                select(ActivitySegment.duration_s).where(ActivitySegment.id.in_(drop))
            ).scalars().all()
            seconds = sum(removed)

            totals["users"] += 1
            totals["segments_removed"] += len(drop)
            totals["seconds_removed"] += seconds
            log.info(
                "%s: %s%d overlapping segment(s), %.1f h",
                user_id, "[dry] " if dry else "", len(drop), seconds / 3600,
            )
            if not dry:
                # In chunks: a user with a long history can exceed the
                # parameter limit of a single IN clause.
                for i in range(0, len(drop), 500):
                    db.execute(
                        delete(ActivitySegment).where(
                            ActivitySegment.id.in_(drop[i : i + 500])
                        )
                    )
                db.commit()
    return totals


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="app.services.deoverlap", description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="report what would be removed and change nothing")
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args(argv)
    logging.basicConfig(level=args.log_level.upper(), format="%(levelname)-7s %(message)s")

    totals = run(dry=args.dry_run)
    verb = "would remove" if args.dry_run else "removed"
    print(
        f"{verb} {totals['segments_removed']} segment(s) "
        f"({totals['seconds_removed'] / 3600:.1f} h) across {totals['users']} user(s)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
