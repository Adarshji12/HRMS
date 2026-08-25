from __future__ import annotations

import logging
import re
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api.v1.router import api_router
from app.core.config import settings
from app.db.migrations import current_revision, head_revision
from app.middleware import RequestContextMiddleware, SecurityHeadersMiddleware

log = logging.getLogger("sentinel")


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Configuration first, before anything opens a connection. These checks
    # need no database, and running them after the schema check meant a deploy
    # with the default signing key reported "unable to open database file" —
    # which sends whoever is debugging it to entirely the wrong place.
    #
    # Fatal in production rather than a warning: booting on the published
    # default key means anyone who has read this repository can mint a valid
    # owner token for any tenant, and can decrypt every stored SMTP password,
    # since the same key derives the Fernet key.
    if settings.using_default_secret:
        if settings.is_production:
            raise RuntimeError(
                "SECRET_KEY is the development default. Generate one with "
                "python -c 'import secrets; print(secrets.token_urlsafe(48))' "
                "before running with ENVIRONMENT=production."
            )
        log.warning("SECRET_KEY is the development default - change it before deploying.")

    if settings.is_production and settings.is_sqlite:
        raise RuntimeError(
            "DATABASE_URL still points at SQLite, which cannot serve more than "
            "one process safely. Production needs PostgreSQL: "
            "postgresql+psycopg://user:pass@host/db"
        )

    # A reduced bcrypt cost is a test-suite convenience and nothing else. Left
    # unguarded it is the kind of setting that reaches production through a
    # copied .env and is never noticed, because nothing about the running system
    # looks different — every password is simply cheaper to crack.
    if settings.is_production and settings.bcrypt_rounds < 12:
        raise RuntimeError(
            f"BCRYPT_ROUNDS is {settings.bcrypt_rounds}. Production requires at "
            "least 12; the lower value exists only for the test suite."
        )

    # Fail loudly rather than take money through a simulator.
    if settings.razorpay_live and not settings.payments_configured:
        raise RuntimeError(
            "RAZORPAY_LIVE is true but RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET are unset."
        )
    if not settings.payments_configured:
        log.warning(
            "Razorpay is not configured - signup runs in SIMULATED payment mode. "
            "Set RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET before going live."
        )

    # The schema is owned by Alembic, not by the application. Starting up
    # against an out-of-date database is refused rather than silently patched:
    # an implicit create_all would mask a missing migration until the first
    # query against a column that does not exist.
    current, head = current_revision(), head_revision()
    if current != head:
        raise RuntimeError(
            f"Database schema is at {current or 'nothing'} but the code expects {head}. "
            f"Run: alembic upgrade head"
        )
    log.info("database ready at revision %s", current)

    # Seed any built-in plan the catalogue is missing, then load it into the
    # process cache. After this point plan_for() answers from the table, so an
    # operator's edits and additions apply without a Session at every call site.
    from app.services import plancatalog

    plancatalog.bootstrap()

    yield


# The interactive docs publish every route, parameter and schema to anyone who
# asks, which is a map of the attack surface. Useful in development, and no
# business being reachable on a production host.
_docs = {} if not settings.is_production else {
    "docs_url": None,
    "redoc_url": None,
    "openapi_url": None,
}

app = FastAPI(
    title="MyDeskTime API",
    version=__version__,
    description="Workforce activity analytics — agent ingest and admin reporting.",
    lifespan=lifespan,
    **_docs,
)

def _origin_regex() -> str | None:
    """Allow every tenant subdomain without enumerating them.

    Tenants are created at runtime, so a static origin list can never be
    complete. The pattern is anchored and the dot is escaped so that
    ``evil-sentinel.io`` does not match ``sentinel.io``.
    """
    if not settings.cors_allow_subdomains:
        return None
    base = re.escape(settings.base_domain)
    port = r"(:\d+)?"
    # The scheme follows the deployment rather than admitting both. With
    # allow_credentials=True, accepting http:// on a production domain lets
    # anything an attacker can serve over plain HTTP on a matching subdomain
    # read authenticated responses.
    scheme = "https" if settings.public_scheme == "https" else r"https?"
    return rf"^{scheme}://([a-z0-9][a-z0-9-]*\.)?{base}{port}$"


# Order matters: middleware added last runs first, so the request id is
# assigned before anything else can log, and the security headers are applied
# to whatever comes back — including CORS preflights and error responses.
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(RequestContextMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_origin_regex=_origin_regex(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router)


@app.get("/health", tags=["meta"])
def health() -> dict:
    return {"status": "ok", "version": __version__}
