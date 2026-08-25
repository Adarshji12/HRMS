"""What each person receives, and what has been sent to them.

Self-service by design: an employee sets their own preferences and reads their
own delivery history. An administrator has no route here to change what someone
else receives — being able to silence a colleague's "a device was enrolled
against your account" would defeat the point of sending it.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession
from app.models import NotificationLog
from app.services import mailconfig, notifications as notif

router = APIRouter(prefix="/notifications", tags=["notifications"])


class PreferenceIn(BaseModel):
    kind: str
    email_enabled: bool


class PreferencesIn(BaseModel):
    preferences: list[PreferenceIn]


@router.get("/preferences")
def read_preferences(viewer: CurrentUser, db: DbSession) -> dict:
    return {
        # Whether anything can actually be delivered, so the page can say so
        # rather than let people set preferences that quietly do nothing.
        "email_configured": mailconfig.resolve(db, viewer.org_id).configured,
        "preferences": notif.preferences_for(db, viewer),
    }


@router.put("/preferences")
def update_preferences(payload: PreferencesIn, viewer: CurrentUser, db: DbSession) -> dict:
    known = {spec.key: kind for kind, spec in notif.SPECS.items()}
    for item in payload.preferences:
        kind = known.get(item.kind)
        if kind is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, f"Unknown notification: {item.kind}"
            )
        # set_preference ignores mandatory kinds rather than raising: the client
        # sends the whole form back, and a security notice appearing in that
        # payload is not an error, it just cannot be switched off.
        notif.set_preference(db, viewer, kind, item.email_enabled)
    db.commit()
    return {"preferences": notif.preferences_for(db, viewer)}


@router.get("/history")
def read_history(
    viewer: CurrentUser,
    db: DbSession,
    days: int = Query(default=30, ge=1, le=365),
    limit: int = Query(default=50, ge=1, le=200),
) -> dict:
    """What this system has sent to you.

    Visible to the recipient because a monitoring product that mails people
    about themselves should be able to answer "what have you been sending, and
    to whom" without a support ticket. Scoped to the viewer only.
    """
    since = datetime.now(timezone.utc) - timedelta(days=days)
    rows = db.scalars(
        select(NotificationLog)
        .where(NotificationLog.user_id == viewer.id, NotificationLog.created_at >= since)
        .order_by(NotificationLog.created_at.desc())
        .limit(limit)
    ).all()
    labels = {spec.key: spec.label for spec in notif.SPECS.values()}
    return {
        "items": [
            {
                "kind": r.kind,
                "label": labels.get(r.kind, r.kind),
                "subject": r.subject,
                "status": r.status,
                "sent_at": (r.sent_at or r.created_at).isoformat(),
            }
            for r in rows
        ]
    }
