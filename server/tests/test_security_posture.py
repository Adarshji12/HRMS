"""The hardening added after the production audit, asserted.

Each of these was a finding. A fix with no test is a fix that lasts until the
next refactor, which is why the audit ranked the missing suite above the
missing headers.
"""

from __future__ import annotations

import pytest

from app.core.config import Settings
from app.core.ratelimit import Limit, RateLimiter


# --------------------------------------------------------------- headers --

SECURITY_HEADERS = [
    ("X-Frame-Options", "DENY"),
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "strict-origin-when-cross-origin"),
]


@pytest.mark.parametrize("header,expected", SECURITY_HEADERS)
def test_security_headers_are_present(client, header, expected):
    response = client.get("/health")
    assert response.headers.get(header) == expected


def test_content_security_policy_forbids_framing(client):
    csp = client.get("/health").headers.get("Content-Security-Policy", "")
    assert "frame-ancestors 'none'" in csp


def test_headers_are_present_on_errors_too(client):
    """A 404 is still a response an attacker can frame."""
    response = client.get("/api/v1/nope")
    assert response.status_code == 404
    assert response.headers.get("X-Frame-Options") == "DENY"


def test_hsts_is_absent_outside_production(client):
    """Sending HSTS from a plain-http dev server pins the browser to https on
    localhost and breaks every other local project sharing the hostname."""
    assert "Strict-Transport-Security" not in client.get("/health").headers


def test_every_response_carries_a_request_id(client):
    rid = client.get("/health").headers.get("X-Request-ID")
    assert rid and len(rid) >= 8


def test_an_upstream_request_id_is_preserved(client):
    """A proxy that already assigned an id must not have it replaced, or the
    trace restarts at our edge and cannot be joined up."""
    response = client.get("/health", headers={"X-Request-ID": "abc123-from-proxy"})
    assert response.headers["X-Request-ID"] == "abc123-from-proxy"


# ------------------------------------------------------------ rate limit --

def test_rate_limiter_blocks_after_the_limit():
    limiter = RateLimiter()
    limit = Limit(times=3, seconds=60)
    assert [limiter.check("k", limit) for _ in range(3)] == [None, None, None]
    retry = limiter.check("k", limit)
    assert retry is not None and retry > 0


def test_rate_limiter_keys_are_independent():
    """One person mistyping must not lock out anybody else."""
    limiter = RateLimiter()
    limit = Limit(times=1, seconds=60)
    assert limiter.check("alice", limit) is None
    assert limiter.check("bob", limit) is None
    assert limiter.check("alice", limit) is not None


def test_rate_limiter_reset_clears_a_key():
    limiter = RateLimiter()
    limit = Limit(times=1, seconds=60)
    limiter.check("k", limit)
    assert limiter.check("k", limit) is not None
    limiter.reset("k")
    assert limiter.check("k", limit) is None


def test_login_is_rate_limited(client, tenants):
    """Ten wrong passwords is a person; the eleventh is a script."""
    acme, _ = tenants
    body = {"email": acme.owner.email, "password": "wrong-on-purpose"}
    codes = [
        client.post("/api/v1/auth/login", json=body, headers={"X-Org-Slug": acme.slug}).status_code
        for _ in range(12)
    ]
    assert 429 in codes, f"login never throttled: {codes}"
    # And it must have let a real person try more than once first.
    assert codes[0] == 401


def test_a_throttled_response_says_when_to_retry(client, tenants):
    acme, _ = tenants
    body = {"email": acme.owner.email, "password": "wrong-on-purpose"}
    last = None
    for _ in range(12):
        last = client.post("/api/v1/auth/login", json=body, headers={"X-Org-Slug": acme.slug})
    assert last.status_code == 429
    assert int(last.headers["Retry-After"]) > 0


# ----------------------------------------------------- configuration guards --

def test_production_refuses_the_default_secret():
    s = Settings(environment="production", secret_key="dev-only-insecure-key-change-me")
    assert s.is_production and s.using_default_secret


def test_development_tolerates_the_default_secret():
    s = Settings(environment="development", secret_key="dev-only-insecure-key-change-me")
    assert not s.is_production


def test_a_real_secret_is_not_flagged():
    assert not Settings(secret_key="k" * 60).using_default_secret


def test_cors_pattern_rejects_a_lookalike_domain():
    """evil-localhost.com must not match localhost."""
    import re

    from app.main import _origin_regex

    pattern = _origin_regex()
    assert pattern is not None
    assert not re.match(pattern, "http://evil-localhost.com")
    assert re.match(pattern, "http://acme.localhost")


def test_cors_pattern_drops_plain_http_when_the_site_is_https(monkeypatch):
    import re

    from app import main
    from app.core.config import settings as live

    monkeypatch.setattr(live, "public_scheme", "https")
    pattern = main._origin_regex()
    assert not re.match(pattern, "http://acme.localhost")
    assert re.match(pattern, "https://acme.localhost")


# ------------------------------------------------- startup guard ordering --

def _lifespan_error(monkeypatch, **overrides) -> str:
    """Boot the app with a broken config and return the failure message."""
    import anyio

    from app import main
    from app.core.config import settings as live

    for key, value in overrides.items():
        monkeypatch.setattr(live, key, value)

    async def boot():
        async with main.lifespan(main.app):
            pass

    try:
        anyio.run(boot)
    except RuntimeError as exc:
        return str(exc)
    return ""


def test_production_refuses_to_boot_on_the_default_secret(monkeypatch):
    message = _lifespan_error(
        monkeypatch, environment="production",
        secret_key="dev-only-insecure-key-change-me",
    )
    assert "SECRET_KEY" in message


def test_production_refuses_to_boot_on_sqlite(monkeypatch):
    message = _lifespan_error(
        monkeypatch, environment="production",
        database_url="sqlite:///./whatever.db",
    )
    assert "SQLite" in message


def test_config_is_checked_before_the_database(monkeypatch):
    """Both broken at once: the message must name the configuration mistake.

    These guards used to run after the schema check, so a production deploy
    with the default key reported "unable to open database file" and sent
    whoever was debugging it to the wrong place entirely.
    """
    message = _lifespan_error(
        monkeypatch, environment="production",
        secret_key="dev-only-insecure-key-change-me",
        database_url="postgresql+psycopg://nobody:nobody@127.0.0.1:1/nothing",
    )
    assert "SECRET_KEY" in message
    assert "database" not in message.lower()
