"""Tenant resolution.

A request is bound to one organisation before authentication happens, resolved
from (in order):

1. the ``Host`` header — ``acme.sentinel.io`` -> slug ``acme``;
2. the ``X-Org-Slug`` header, for API clients and local development, where
   subdomains are inconvenient.

Resolution is *not* an authorisation decision — naming a tenant grants nothing.
It only decides which organisation's user table a login is checked against, and
which tenant a bearer token is allowed to be used on. Both of those then have to
pass their own checks.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import get_db
from app.models import Organization

ORG_HEADER = "X-Org-Slug"


def slug_from_host(host: str | None) -> str | None:
    """Extract a tenant slug from a Host header, or None if there is not one."""
    if not host:
        return None

    hostname = host.split(":", 1)[0].strip().lower().rstrip(".")
    base = settings.base_domain.strip().lower()
    if not hostname or hostname == base:
        return None
    if not hostname.endswith(f".{base}"):
        return None

    label = hostname[: -(len(base) + 1)]
    # Only the left-most label is the tenant; anything deeper is not a tenant
    # host at all rather than a tenant with dots in its name.
    if "." in label:
        return None
    if not label or label in settings.reserved_slug_set:
        return None
    return label


def resolve_slug(request: Request, header_slug: str | None) -> str | None:
    return slug_from_host(request.headers.get("host")) or (
        header_slug.strip().lower() if header_slug else None
    )


def get_optional_tenant(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    x_org_slug: Annotated[str | None, Header()] = None,
) -> Organization | None:
    slug = resolve_slug(request, x_org_slug)
    if not slug:
        return None
    return db.scalar(select(Organization).where(Organization.slug == slug))


def get_tenant(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    x_org_slug: Annotated[str | None, Header()] = None,
) -> Organization:
    slug = resolve_slug(request, x_org_slug)
    if not slug:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail={
                "reason": "no_tenant",
                "message": (
                    f"No organisation in this request. Use https://<org>.{settings.base_domain} "
                    f"or send an {ORG_HEADER} header."
                ),
            },
        )

    org = db.scalar(select(Organization).where(Organization.slug == slug))
    if org is None:
        # Same shape as "exists but you may not touch it" would be — the
        # response must not confirm whether a company uses the product.
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail={"reason": "unknown_tenant", "message": "No such organisation."},
        )
    return org


CurrentTenant = Annotated[Organization, Depends(get_tenant)]
OptionalTenant = Annotated[Organization | None, Depends(get_optional_tenant)]
