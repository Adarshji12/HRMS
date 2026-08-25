"""Programmatic access to Alembic.

Lets the app assert at startup that the database matches the code, and lets
``app.seed`` bring a fresh database up without shelling out.
"""

from __future__ import annotations

import logging
from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory

from app.core.config import SERVER_ROOT, settings
from app.db.session import engine

log = logging.getLogger(__name__)

ALEMBIC_INI = SERVER_ROOT / "alembic.ini"


def alembic_config() -> Config:
    config = Config(str(ALEMBIC_INI))
    config.set_main_option("script_location", str(Path(SERVER_ROOT / "alembic")))
    config.set_main_option("sqlalchemy.url", settings.database_url)
    return config


def head_revision() -> str | None:
    return ScriptDirectory.from_config(alembic_config()).get_current_head()


def current_revision() -> str | None:
    with engine.connect() as connection:
        return MigrationContext.configure(connection).get_current_revision()


def upgrade_to_head() -> str | None:
    command.upgrade(alembic_config(), "head")
    return current_revision()
