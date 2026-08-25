from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, MetaData, Uuid
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# Every constraint gets a deterministic name.
#
# Not cosmetic: SQLite cannot ALTER a table, so Alembic rebuilds it ("batch"
# mode) — and rebuilding requires naming every constraint it has to recreate.
# Without this convention, autogenerate produces migrations that die with
# "Constraint must have a name" the moment a table with an unnamed foreign key
# or check constraint is altered. It also means a future migration can drop a
# constraint by name instead of by guesswork.
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    """Declarative base.

    ``Uuid`` renders as native ``uuid`` on Postgres and ``CHAR(32)`` on SQLite,
    so the same models run against the dev SQLite file and production Postgres.
    """

    metadata = MetaData(naming_convention=NAMING_CONVENTION)


class UUIDMixin:
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
