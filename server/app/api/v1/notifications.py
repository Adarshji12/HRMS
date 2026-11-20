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

from app.api.deps import AdminUser, CurrentUser, DbSession
from app.models import NotificationLog, NotificationOrgSettings, NotificationRule, User
from app.services import eventmail, mailconfig, notifications as notif

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


# --------------------------------------------------------------------------- #
# The company's email events (Settings -> Notifications)
# --------------------------------------------------------------------------- #

class RuleIn(BaseModel):
    is_enabled: bool | None = None
    #: An empty string puts the built-in wording back.
    subject: str | None = None
    body: str | None = None


class AlertsIn(BaseModel):
    probation_alert: bool
    document_alert: bool


@router.get("/rules")
def read_rules(admin: AdminUser, db: DbSession) -> dict:
    rows = {r.event: r for r in db.scalars(select(NotificationRule).where(NotificationRule.org_id == admin.org_id))}
    events = []
    for event in eventmail.EVENTS.values():
        row = rows.get(event.key)
        events.append({
            "key": event.key, "label": event.label, "description": event.description,
            "audience": event.audience, "schedule": event.schedule,
            "is_enabled": row.is_enabled if row else event.default_on,
            "subject": (row.subject if row and row.subject else event.subject),
            "body": (row.body if row and row.body else event.body),
            "default_subject": event.subject, "default_body": event.body,
        })
    settings = eventmail.org_settings(db, admin.org_id)
    return {
        "email_configured": mailconfig.resolve(db, admin.org_id).configured,
        "placeholders": eventmail.PLACEHOLDERS,
        "events": events,
        "alerts": {"probation_alert": settings.probation_alert, "document_alert": settings.document_alert},
    }


@router.put("/rules/{event}")
def write_rule(event: str, payload: RuleIn, admin: AdminUser, db: DbSession) -> dict:
    if event not in eventmail.EVENTS:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such notification")
    default = eventmail.EVENTS[event]
    row = db.scalar(select(NotificationRule).where(NotificationRule.org_id == admin.org_id, NotificationRule.event == event))
    if row is None:
        row = NotificationRule(org_id=admin.org_id, event=event, is_enabled=default.default_on)
        db.add(row)
    if payload.is_enabled is not None:
        row.is_enabled = payload.is_enabled
    # Wording equal to the built-in text is stored as "no override", so a later change to the
    # built-in wording still reaches a company that never edited it.
    if payload.subject is not None:
        text = payload.subject.strip()
        row.subject = None if not text or text == default.subject else text[:300]
    if payload.body is not None:
        text = payload.body.strip()
        row.body = None if not text or text == default.body.strip() else text[:5000]
    db.commit()
    return {"ok": True}


@router.put("/alerts")
def write_alerts(payload: AlertsIn, admin: AdminUser, db: DbSession) -> dict:
    row = db.get(NotificationOrgSettings, admin.org_id)
    if row is None:
        row = NotificationOrgSettings(org_id=admin.org_id)
        db.add(row)
    row.probation_alert = payload.probation_alert
    row.document_alert = payload.document_alert
    db.commit()
    return {"ok": True}


@router.get("/sent")
def read_sent(admin: AdminUser, db: DbSession, limit: int = Query(default=50, ge=1, le=200)) -> dict:
    """Everything the company's event mails have sent, newest first, failures included."""
    labels = {k: e.label for k, e in eventmail.EVENTS.items()}
    labels.update({spec.key: spec.label for spec in notif.SPECS.values()})
    rows = db.execute(
        select(NotificationLog, User.full_name)
        .join(User, User.id == NotificationLog.user_id)
        .where(NotificationLog.org_id == admin.org_id)
        .order_by(NotificationLog.created_at.desc()).limit(limit)
    ).all()
    return {"items": [
        {"event": r.kind, "label": labels.get(r.kind, r.kind), "to": name, "subject": r.subject,
         "status": r.status, "error": r.error, "sent_at": (r.sent_at or r.created_at).isoformat()}
        for r, name in rows
    ]}
