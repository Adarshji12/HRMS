"""Rate limiting for the endpoints that accept a guess.

Deliberately in-process and dependency-free. A Redis-backed limiter is the
right answer once there is more than one API process, and this is written so
that swap is a change to one class rather than to every call site — but an
in-process limiter shipped today beats a distributed one that is still an
argument about infrastructure while the login page is unprotected.

The window is a fixed bucket rather than a sliding log: an attacker can send
2N attempts across a window boundary, which is an acceptable trade for O(1)
memory per key against an unbounded list of timestamps.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass

from fastapi import HTTPException, Request, status


@dataclass(frozen=True)
class Limit:
    times: int
    seconds: int


class RateLimiter:
    def __init__(self) -> None:
        self._hits: dict[str, tuple[int, float]] = {}
        self._lock = threading.Lock()
        self._last_sweep = time.monotonic()

    def _sweep(self, now: float) -> None:
        """Drop expired buckets so a stream of unique keys cannot grow forever.

        An attacker rotating source addresses would otherwise turn this limiter
        into a memory leak — the defence becoming the vulnerability.
        """
        if now - self._last_sweep < 60:
            return
        self._hits = {k: v for k, v in self._hits.items() if v[1] > now}
        self._last_sweep = now

    def check(self, key: str, limit: Limit) -> int | None:
        """Count a hit. Returns seconds to wait when over the limit, else None."""
        now = time.monotonic()
        with self._lock:
            self._sweep(now)
            count, expires = self._hits.get(key, (0, 0.0))
            if expires <= now:
                count, expires = 0, now + limit.seconds
            count += 1
            self._hits[key] = (count, expires)
            if count > limit.times:
                return max(1, int(expires - now))
        return None

    def reset(self, key: str) -> None:
        """Forget a key — called after a success, so a legitimate user who
        mistyped twice is not still counting against the limit afterwards."""
        with self._lock:
            self._hits.pop(key, None)


limiter = RateLimiter()


def client_ip(request: Request) -> str:
    """The caller's address, honouring one proxy hop.

    Only the first entry of X-Forwarded-For is used and only the leftmost value
    is trusted, because everything after it is attacker-controlled. Deploy
    behind a proxy that overwrites the header rather than appending to it.
    """
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def enforce(request: Request, bucket: str, limit: Limit, subject: str = "") -> str:
    """Apply a limit and raise 429 when it is exceeded. Returns the key used.

    ``subject`` narrows the bucket beyond the address — an email, for instance —
    so that one office behind a single NAT address cannot lock out its own staff
    by having several people mistype at once, while a single account still gets
    the protection.
    """
    key = f"{bucket}:{client_ip(request)}:{subject.strip().lower()}"
    retry_after = limiter.check(key, limit)
    if retry_after is not None:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many attempts. Try again shortly.",
            headers={"Retry-After": str(retry_after)},
        )
    return key


# Tuned to stop automation without troubling a person who forgot their password.
LOGIN = Limit(times=10, seconds=300)
RESET = Limit(times=5, seconds=900)
SIGNUP = Limit(times=10, seconds=3600)
AGENT_ENROL = Limit(times=20, seconds=600)
