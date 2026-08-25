"""Password hashing, JWT issuance and agent device tokens.

Two distinct credential types live here:

* **User JWTs** — short-lived bearer tokens for dashboard users.
* **Device tokens** — long-lived opaque secrets held by desktop agents. Only a
  SHA-256 digest is stored, so a database leak does not yield working agent
  credentials.
"""

from __future__ import annotations

import hashlib
import secrets
import string
from datetime import datetime, timedelta, timezone
from typing import Any

import bcrypt
from jose import JWTError, jwt

from app.core.config import settings

# bcrypt silently truncates at 72 bytes; do it explicitly so a long password is
# never accepted as a prefix match of itself.
_BCRYPT_MAX_BYTES = 72


def _clip(password: str) -> bytes:
    return password.encode("utf-8")[:_BCRYPT_MAX_BYTES]


def hash_password(password: str) -> str:
    return bcrypt.hashpw(
        _clip(password), bcrypt.gensalt(rounds=settings.bcrypt_rounds)
    ).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(_clip(password), password_hash.encode("utf-8"))
    except ValueError:
        return False


def create_access_token(subject: str, extra: dict[str, Any] | None = None) -> str:
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "sub": subject,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=settings.access_token_expire_minutes)).timestamp()),
        **(extra or {}),
    }
    return jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)


def decode_access_token(token: str) -> dict[str, Any] | None:
    try:
        return jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
    except JWTError:
        return None


def generate_device_token() -> str:
    """Opaque agent credential. Shown once at enrolment, never retrievable."""
    return f"dev_{secrets.token_urlsafe(32)}"


def generate_enrollment_key() -> str:
    """Short, human-transcribable key an employee types into the agent once."""
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no I/O/0/1
    raw = "".join(secrets.choice(alphabet) for _ in range(16))
    return "-".join(raw[i : i + 4] for i in range(0, 16, 4))


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# Unambiguous characters only: these passwords get read aloud on a phone call
# and typed from a screenshot, where I/l/1 and O/0 are a support ticket.
_ALPHABET = (
    "".join(c for c in string.ascii_letters + string.digits if c not in "Il1O0")
    + "!@#$%^&*-_=+"
)


def generate_password(length: int = 20) -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(length))
