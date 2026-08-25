"""The outbound mail connector: where it is stored, and how its password is kept.

Two levels, resolved in this order:

1. the workspace's own connector, set by its owner
2. the platform default, set by a super admin

A company sending from its own domain is the point of level 1 — the recipients
are its own staff, and mail about their working hours arriving from a stranger's
domain is what both spam filters and employees distrust. Level 2 exists because
signup and password-reset mail has to go out before the workspace exists, or
before anyone has configured it, and there has to be something to send it with.

There is no environment fallback. Two places to configure one thing means every
"why is mail not sending" starts with working out which one won, and an operator
who edits a screen and sees nothing change has no way to discover a stale
variable is overriding them.

The password is encrypted at rest with a key derived from ``SECRET_KEY``. That
ties mail credentials to the same secret that already signs tokens: rotating it
invalidates both, which is the correct blast radius, and it keeps the password
out of every database dump and backup.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.crypto import decrypt_secret, encrypt_secret
from app.db.session import SessionLocal
from app.models import MailSettings

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class MailConfig:
    host: str
    port: int
    user: str
    password: str
    use_tls: bool
    sender: str
    #: "workspace" | "platform" | "none" — so a screen can say whose connector
    #: is actually carrying the mail rather than leaving an owner to guess
    #: whether their blank form means "unset" or "inherited".
    source: str = "none"

    @property
    def configured(self) -> bool:
        return bool(self.host)


def encrypt(password: str) -> str | None:
    """Thin alias kept so this module's callers read as mail code.

    The implementation moved to ``core.crypto`` when employee statutory IDs
    became a second thing needing encryption at rest — one key derivation, not
    two that could drift apart.
    """
    return encrypt_secret(password)


def decrypt(token: str | None) -> str:
    # Almost always SECRET_KEY changed. Louder than a silent auth failure at
    # send time, which would look like a broken mail server.
    return decrypt_secret(token, label="SMTP password")


def row(db: Session, org_id: uuid.UUID | None = None) -> MailSettings | None:
    """One connector. ``org_id=None`` means the platform default row."""
    stmt = select(MailSettings)
    stmt = stmt.where(
        MailSettings.org_id == org_id if org_id is not None else MailSettings.org_id.is_(None)
    )
    return db.scalar(stmt.limit(1))


def get_or_create(db: Session, org_id: uuid.UUID | None = None) -> MailSettings:
    """The settings row for one scope, created empty on first use."""
    existing = row(db, org_id)
    if existing is not None:
        return existing
    created = MailSettings(
        org_id=org_id, smtp_host="", smtp_port=587, smtp_user="",
        smtp_use_tls=True, email_from="",
    )
    db.add(created)
    db.commit()
    db.refresh(created)
    return created


def _from_row(stored: MailSettings, source: str) -> MailConfig:
    return MailConfig(
        host=stored.smtp_host,
        port=stored.smtp_port,
        user=stored.smtp_user,
        password=decrypt(stored.smtp_password_enc),
        use_tls=stored.smtp_use_tls,
        sender=stored.email_from,
        source=source,
    )


def resolve(db: Session | None = None, org_id: uuid.UUID | None = None) -> MailConfig:
    """The connector that will actually carry mail for this workspace.

    Falls back to the platform default, so a workspace that has not configured
    anything still gets its password resets — and a platform with nothing set is
    honestly reported as unconfigured rather than silently doing nothing.
    """
    own = db is None
    session = db or SessionLocal()
    try:
        if org_id is not None:
            mine = row(session, org_id)
            if mine is not None and mine.smtp_host:
                return _from_row(mine, "workspace")
        shared = row(session, None)
        if shared is not None and shared.smtp_host:
            return _from_row(shared, "platform")
        return MailConfig("", 587, "", "", True, "", "none")
    finally:
        if own:
            session.close()


def send_test(config: MailConfig, to: str) -> tuple[bool, str | None]:
    """Deliver one message with an explicit config, reporting why if it failed.

    Deliberately does NOT go through ``email.send``. That resolves the connector
    itself and swallows every failure into a log line — correct for a password
    reset, which must not break a signup because the mail provider is down, and
    useless for a button whose entire job is to tell the operator what is wrong.
    """
    from app.services import email  # local: email imports this module

    text = (
        "This is a test from the MyDeskTime platform console.\n\n"
        "If you are reading it, outbound mail is working.\n"
    )
    html = email._WRAPPER.format(
        body=(
            "<p>This is a test from the MyDeskTime platform console.</p>"
            "<p>If you are reading it, outbound mail is working.</p>"
        ),
        footer="Sent by the platform console's test button.",
    )
    message = email._build(to, "MyDeskTime test message", text, config.sender, html)
    try:
        email._deliver(config, message)
    except Exception as exc:  # noqa: BLE001 - the reason is the whole point
        log.warning("SMTP test to %s failed: %s", to, exc)
        return False, f"{type(exc).__name__}: {exc}"
    return True, None
