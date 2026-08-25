"""Durable local queue.

Nothing is uploaded straight from memory. Every segment and screenshot is
committed to a local SQLite database first and removed only once the server has
acknowledged it, so an agent can run for days without a network and lose
nothing, and a crash mid-upload duplicates rather than drops (the server
deduplicates on ``client_uid``).

Screenshot *bytes* live as files next to the database rather than as blobs — a
few hundred 200 KB blobs would bloat the SQLite file and make vacuuming a
problem on a user's laptop.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

log = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS segments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    client_uid  TEXT NOT NULL UNIQUE,
    payload     TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS screenshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    client_uid  TEXT NOT NULL UNIQUE,
    meta        TEXT NOT NULL,
    file_path   TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_segments_created ON segments(created_at);
CREATE INDEX IF NOT EXISTS ix_screenshots_created ON screenshots(created_at);
"""

# Guard rails for a machine that never reconnects: stop the spool from eating
# the disk. Oldest entries go first.
MAX_SEGMENTS = 200_000
MAX_SCREENSHOTS = 5_000
MAX_AGE_DAYS = 30
# A row the server keeps rejecting is poison; drop it rather than blocking the
# queue behind it forever.
MAX_ATTEMPTS = 20


class Spool:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self.pending_dir = db_path.parent / "pending"
        self.pending_dir.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.executescript(SCHEMA)
        self._conn.commit()

    def close(self) -> None:
        try:
            self._conn.close()
        except sqlite3.Error:
            pass

    # -- segments -----------------------------------------------------------

    def put_segment(self, payload: dict) -> None:
        self._conn.execute(
            "INSERT OR IGNORE INTO segments (client_uid, payload, created_at) VALUES (?, ?, ?)",
            (payload["client_uid"], json.dumps(payload), _now_iso()),
        )
        self._conn.commit()

    def take_segments(self, limit: int = 200) -> list[tuple[int, dict]]:
        rows = self._conn.execute(
            "SELECT id, payload FROM segments ORDER BY id LIMIT ?", (limit,)
        ).fetchall()
        return [(row[0], json.loads(row[1])) for row in rows]

    def ack_segments(self, ids: list[int]) -> None:
        if not ids:
            return
        self._conn.executemany("DELETE FROM segments WHERE id = ?", [(i,) for i in ids])
        self._conn.commit()

    def fail_segments(self, ids: list[int]) -> None:
        if not ids:
            return
        self._conn.executemany(
            "UPDATE segments SET attempts = attempts + 1 WHERE id = ?", [(i,) for i in ids]
        )
        self._conn.execute("DELETE FROM segments WHERE attempts >= ?", (MAX_ATTEMPTS,))
        self._conn.commit()

    # -- screenshots --------------------------------------------------------

    def put_screenshot(self, meta: dict, image: bytes) -> None:
        name = f"{meta['client_uid']}.jpg"
        path = self.pending_dir / name
        path.write_bytes(image)
        self._conn.execute(
            "INSERT OR IGNORE INTO screenshots (client_uid, meta, file_path, created_at) "
            "VALUES (?, ?, ?, ?)",
            (meta["client_uid"], json.dumps(meta), str(path), _now_iso()),
        )
        self._conn.commit()

    def take_screenshots(self, limit: int = 5) -> list[tuple[int, dict, Path]]:
        rows = self._conn.execute(
            "SELECT id, meta, file_path FROM screenshots ORDER BY id LIMIT ?", (limit,)
        ).fetchall()
        return [(row[0], json.loads(row[1]), Path(row[2])) for row in rows]

    def ack_screenshot(self, row_id: int) -> None:
        row = self._conn.execute(
            "SELECT file_path FROM screenshots WHERE id = ?", (row_id,)
        ).fetchone()
        if row:
            Path(row[0]).unlink(missing_ok=True)
        self._conn.execute("DELETE FROM screenshots WHERE id = ?", (row_id,))
        self._conn.commit()

    def fail_screenshot(self, row_id: int) -> None:
        self._conn.execute(
            "UPDATE screenshots SET attempts = attempts + 1 WHERE id = ?", (row_id,)
        )
        for (path,) in self._conn.execute(
            "SELECT file_path FROM screenshots WHERE attempts >= ?", (MAX_ATTEMPTS,)
        ).fetchall():
            Path(path).unlink(missing_ok=True)
        self._conn.execute("DELETE FROM screenshots WHERE attempts >= ?", (MAX_ATTEMPTS,))
        self._conn.commit()

    # -- housekeeping -------------------------------------------------------

    def counts(self) -> tuple[int, int]:
        seg = self._conn.execute("SELECT COUNT(*) FROM segments").fetchone()[0]
        shot = self._conn.execute("SELECT COUNT(*) FROM screenshots").fetchone()[0]
        return int(seg), int(shot)

    def trim(self) -> None:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=MAX_AGE_DAYS)).isoformat()
        self._conn.execute("DELETE FROM segments WHERE created_at < ?", (cutoff,))
        self._conn.execute(
            "DELETE FROM segments WHERE id NOT IN "
            "(SELECT id FROM segments ORDER BY id DESC LIMIT ?)",
            (MAX_SEGMENTS,),
        )

        stale = self._conn.execute(
            "SELECT id, file_path FROM screenshots WHERE created_at < ? "
            "OR id NOT IN (SELECT id FROM screenshots ORDER BY id DESC LIMIT ?)",
            (cutoff, MAX_SCREENSHOTS),
        ).fetchall()
        for row_id, path in stale:
            Path(path).unlink(missing_ok=True)
            self._conn.execute("DELETE FROM screenshots WHERE id = ?", (row_id,))
        self._conn.commit()

    def wipe(self) -> None:
        """Called when the server revokes the device: stop holding its data."""
        for path in self.pending_dir.glob("*.jpg"):
            path.unlink(missing_ok=True)
        self._conn.execute("DELETE FROM segments")
        self._conn.execute("DELETE FROM screenshots")
        self._conn.commit()


def new_uid() -> str:
    return uuid.uuid4().hex


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
