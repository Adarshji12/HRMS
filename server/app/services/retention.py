"""Retention enforcement.

Retention settings are a legal commitment, not a display preference — this job
is what makes them true. Run it from cron/systemd daily:

    python -m app.services.retention
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models import ActivitySegment, Organization, OrgSettings, Screenshot
from app.services import storage

log = logging.getLogger(__name__)


def purge_org(db: Session, org_id, settings: OrgSettings) -> dict:
    now = datetime.now(timezone.utc)
    result = {"screenshots": 0, "segments": 0}

    if settings.screenshot_retention_days > 0:
        cutoff = now - timedelta(days=settings.screenshot_retention_days)
        stale = db.scalars(
            select(Screenshot).where(
                Screenshot.org_id == org_id, Screenshot.captured_at < cutoff
            )
        ).all()
        for shot in stale:
            # Files first: an orphaned row is recoverable, an orphaned blob that
            # nothing points at is not, and it is the blob that carries the data.
            storage.delete(shot.storage_key)
            storage.delete(shot.thumb_key)
            db.delete(shot)
        result["screenshots"] = len(stale)

    if settings.activity_retention_days > 0:
        cutoff = now - timedelta(days=settings.activity_retention_days)
        res = db.execute(
            delete(ActivitySegment).where(
                ActivitySegment.org_id == org_id, ActivitySegment.started_at < cutoff
            )
        )
        result["segments"] = res.rowcount or 0

    db.commit()
    return result


def purge_all() -> dict:
    totals = {"screenshots": 0, "segments": 0}
    with SessionLocal() as db:
        for org in db.scalars(select(Organization)).all():
            settings = db.get(OrgSettings, org.id)
            if settings is None:
                continue
            res = purge_org(db, org.id, settings)
            totals["screenshots"] += res["screenshots"]
            totals["segments"] += res["segments"]
            log.info("purged org %s: %s", org.slug, res)
    return totals


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    print(purge_all())
