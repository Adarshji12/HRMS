"""Symmetric encryption for secrets that must be read back.

Distinct from ``core.security``, which hashes passwords. A hash is one-way on
purpose; the values here — an SMTP password, an employee's PAN — have to come
back out, so they are encrypted rather than hashed. Keeping the two in separate
modules is what stops someone reaching for ``encrypt`` when they wanted
``hash_password``.

The key is derived from ``SECRET_KEY``, so rotating that makes every stored
secret unreadable. That is a deliberate, documented consequence rather than an
oversight: the alternative is a second key to manage, lose and leak, and this
deployment already treats ``SECRET_KEY`` as the thing you must not lose.
Decryption failure returns empty and logs loudly, because a silent empty string
looks like "never set" and sends someone hunting for the wrong bug.

Extracted from ``services/mailconfig``, which had the only Fernet in the
codebase. A second caller copying those four lines would have been a second
place to get the key derivation subtly different.
"""

from __future__ import annotations

import base64
import hashlib
import logging

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import settings

log = logging.getLogger(__name__)


def _fernet() -> Fernet:
    digest = hashlib.sha256(settings.secret_key.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_secret(value: str | None) -> str | None:
    """Ciphertext, or None for an empty input.

    None rather than an encryption of the empty string, so "not set" stays
    distinguishable from "set to blank" in the column — a NULL check is the same
    question every caller actually asks.
    """
    if not value:
        return None
    return _fernet().encrypt(value.encode("utf-8")).decode("ascii")


def decrypt_secret(token: str | None, *, label: str = "value") -> str:
    """Plaintext, or "" if absent or undecryptable.

    ``label`` names the thing in the log line. Almost every real failure here is
    a changed ``SECRET_KEY``, and the operator needs to know *what* they can no
    longer read to know what to re-enter.
    """
    if not token:
        return ""
    try:
        return _fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError):
        log.error(
            "stored %s could not be decrypted - SECRET_KEY has changed. "
            "The value must be re-entered.",
            label,
        )
        return ""


def mask_tail(value: str | None, *, keep: int = 4, mask: str = "•") -> str | None:
    """``"ABCDE1234F"`` -> ``"••••••234F"``. None passes through.

    Used for identity numbers that a screen must be able to confirm without
    displaying — "is this the right PAN" is answerable from the last four
    characters, and the full value then only leaves the server for the people
    who genuinely need it.

    A value at or under ``keep`` is masked entirely rather than shown: a
    three-character secret displayed in full because it was too short to mask is
    exactly the edge case that leaks.
    """
    if not value:
        return None
    if len(value) <= keep:
        return mask * len(value)
    return mask * (len(value) - keep) + value[-keep:]
