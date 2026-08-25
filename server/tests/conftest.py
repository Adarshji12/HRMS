"""Shared fixtures.

Every test runs against a real application and a real (temporary) database
rather than mocks. The findings this suite exists to prevent — a tenant seeing
another tenant's data, a delete that reports success without deleting — are
exactly the ones that mocked dependencies hide, because the mock returns
whatever the test author expected instead of what the query would.
"""

from __future__ import annotations

import os
import tempfile
import uuid
from pathlib import Path

import pytest

# Must be set before app.core.config is imported anywhere, since Settings reads
# the environment once at import time.
_TMP = Path(tempfile.mkdtemp(prefix="hrdesktimesol-tests-"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_TMP / 'test.db').as_posix()}"
os.environ["SECRET_KEY"] = "test-key-not-the-dev-default-and-not-a-real-one"
os.environ["ENVIRONMENT"] = "development"
os.environ["STORAGE_DIR"] = str(_TMP / "storage")
os.environ["BASE_DOMAIN"] = "localhost"
# Hashing is meant to be slow, and this suite creates several hundred accounts.
# At the production factor that is minutes of CI spent proving bcrypt works.
# `main.py` refuses to boot on a reduced factor in production, so this cannot
# escape the tests.
os.environ["BCRYPT_ROUNDS"] = "4"

from fastapi.testclient import TestClient  # noqa: E402

from app.core.security import (  # noqa: E402
    create_access_token,
    generate_enrollment_key,
    hash_password,
)
from app.db.base import Base  # noqa: E402
from app.db.session import SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Organization, OrgSettings, PlatformAdmin, User  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def _schema():
    """Build the schema once, through the migrations.

    Alembic rather than create_all, for two reasons. The application refuses to
    start unless the recorded revision matches the code, so create_all leaves it
    unbootable — and more usefully, this means every test runs against the exact
    schema a deployment gets, so a migration that drifts from the models fails
    the suite instead of production.
    """
    from alembic import command
    from alembic.config import Config

    cfg = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    cfg.set_main_option("sqlalchemy.url", os.environ["DATABASE_URL"])
    command.upgrade(cfg, "head")
    yield
    Base.metadata.drop_all(engine)


@pytest.fixture(autouse=True)
def _clean():
    """Empty every table between tests, so order never matters."""
    yield
    with SessionLocal() as db:
        for table in reversed(Base.metadata.sorted_tables):
            db.execute(table.delete())
        db.commit()


@pytest.fixture
def client_raising():
    """Like `client`, but lets a server exception surface as a traceback.

    Used by tests where a 500 is a bug to diagnose rather than a status to
    assert — swallowing it turns "why did this break" into a bare 500.
    """
    with TestClient(app) as c:
        yield c


@pytest.fixture
def client():
    # raise_server_exceptions=False so a 500 is asserted as a response rather
    # than re-raised — a test that crashes cannot check the status code.
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def _make_org(db, slug: str, name: str) -> Organization:
    org = Organization(id=uuid.uuid4(), slug=slug, name=name)
    db.add(org)
    db.flush()
    db.add(OrgSettings(org_id=org.id))
    db.flush()
    return org


def _make_user(db, org, email: str, role: str, name: str) -> User:
    user = User(
        id=uuid.uuid4(), org_id=org.id, email=email, full_name=name,
        role=role, password_hash=hash_password("correct-horse-battery"), is_active=True,
        enrollment_key=generate_enrollment_key(),
    )
    db.add(user)
    db.flush()
    return user


class Tenant:
    """A company plus the tokens and ids a test needs to act as its people."""

    def __init__(self, org: Organization, owner: User, employee: User) -> None:
        self.id = org.id
        self.slug = org.slug
        self.owner = owner
        self.employee = employee
        self.owner_token = create_access_token(
            str(owner.id), {"typ": "user", "org": str(org.id), "role": owner.role})
        self.employee_token = create_access_token(
            str(employee.id), {"typ": "user", "org": str(org.id), "role": employee.role})

    def headers(self, token: str | None = None) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {token or self.owner_token}",
            "X-Org-Slug": self.slug,
        }


@pytest.fixture
def tenants() -> tuple[Tenant, Tenant]:
    """Two unrelated companies.

    Two, always. A single-tenant fixture cannot express the only question that
    matters for this product: whether one company can reach another's data.
    """
    with SessionLocal() as db:
        made = []
        for slug, name in (("acme", "Acme Ltd"), ("globex", "Globex Inc")):
            org = _make_org(db, slug, name)
            owner = _make_user(db, org, f"owner@{slug}.test", "owner", f"{name} Owner")
            staff = _make_user(db, org, f"staff@{slug}.test", "employee", f"{name} Staff")
            made.append(Tenant(org, owner, staff))
        db.commit()
        for t in made:
            db.refresh(t.owner)
            db.refresh(t.employee)
        return made[0], made[1]


@pytest.fixture
def platform_token() -> str:
    with SessionLocal() as db:
        admin = PlatformAdmin(
            id=uuid.uuid4(), email="ops@platform.test", full_name="Ops",
            password_hash=hash_password("correct-horse-battery"), is_active=True,
        )
        db.add(admin)
        db.commit()
        return create_access_token(str(admin.id), {"typ": "platform"})
