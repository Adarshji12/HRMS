"""Cross-cutting HTTP middleware: security headers and request correlation.

Kept out of ``app.main`` so the application factory stays readable, and so
each concern can be tested on its own.
"""

from __future__ import annotations

import logging
import time
import uuid
from contextvars import ContextVar

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from app.core.config import settings

log = logging.getLogger("sentinel.access")

#: Set per request so any log line emitted while handling it can be tied back
#: to the response the caller saw. A ContextVar rather than a global because
#: the server handles requests concurrently.
request_id: ContextVar[str] = ContextVar("request_id", default="-")


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Give every request an id, log its outcome, and hand the id back.

    Without this a production incident is a wall of undifferentiated log lines
    with no way to group the ones belonging to the failing request, and no way
    for a customer report ("it failed at 14:02") to be matched to anything.
    """

    async def dispatch(self, request: Request, call_next):
        # Honour an upstream id when a proxy already assigned one, so a trace
        # survives the hop rather than restarting at our edge.
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:16]
        token = request_id.set(rid)
        started = time.perf_counter()
        try:
            response: Response = await call_next(request)
        except Exception:
            # Log with the id before the exception handler turns it into a 500,
            # otherwise the traceback and the response cannot be connected.
            log.exception(
                "%s %s failed [rid=%s]", request.method, request.url.path, rid
            )
            raise
        finally:
            request_id.reset(token)

        took = (time.perf_counter() - started) * 1000
        # Server errors are the ones worth finding in a log; the rest stay at
        # debug so normal traffic does not bury them.
        level = logging.ERROR if response.status_code >= 500 else logging.DEBUG
        log.log(
            level,
            '%s %s %s %.0fms [rid=%s]',
            request.method, request.url.path, response.status_code, took, rid,
        )
        response.headers["X-Request-ID"] = rid
        return response


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Headers every response should carry.

    The console displays employee screenshots, so framing protection is the one
    that matters most here: without it the whole admin UI can be embedded in a
    hostile page and clicked through by someone who thinks they are using a
    different site.
    """

    async def dispatch(self, request: Request, call_next):
        response: Response = await call_next(request)

        # Deny rather than sameorigin: nothing in this product embeds itself.
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        # Send the origin to third parties but never the path — screenshot and
        # employee URLs carry identifiers that should not leak in a Referer.
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.headers.setdefault(
            "Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()"
        )

        # The API serves JSON and images, never HTML that should run script, so
        # the policy can be as tight as it gets. The console is a separate
        # origin with its own CSP set by whatever serves its static files.
        #
        # Swagger UI and ReDoc are the exception: they pull scripts and styles
        # from a CDN, and default-src 'none' would leave a developer staring at
        # a blank page with the reason buried in the browser console. They only
        # exist outside production anyway.
        if not request.url.path.startswith(("/docs", "/redoc", "/openapi.json")):
            response.headers.setdefault(
                "Content-Security-Policy",
                "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
            )

        # Only over HTTPS, and only in production. Sending HSTS from a plain
        # http:// development server would pin a browser to https on localhost
        # and break every other local project on the same host.
        if settings.is_production and settings.public_scheme == "https":
            response.headers.setdefault(
                "Strict-Transport-Security", "max-age=31536000; includeSubDomains"
            )

        return response
