"""Collapses per-second samples into activity segments.

One row per second per employee would be ~30k rows/day/head. Consecutive samples
that describe the same thing are merged instead, so a 40-minute stretch in one
editor file is a single row carrying its active/idle split.

A segment is closed when:
* the focused app, window title or URL changes;
* the machine crosses the idle threshold, or comes back from it;
* the segment reaches ``max_segment_s`` (so a long unattended stretch still
  shows up on the timeline at a sane granularity).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

from agent.trackers.base import Sample


@dataclass
class Segment:
    client_uid: str
    started_at: datetime
    ended_at: datetime
    active_s: int
    idle_s: int
    app_name: str
    app_exec: str
    window_title: str
    is_browser: bool
    browser: str | None
    url_domain: str | None
    url_full: str | None
    is_idle: bool
    # Share of sampled seconds in which the user actually touched the machine.
    input_activity_pct: int = 0
    project_id: str | None = None
    task_id: str | None = None
    repo_name: str | None = None
    branch_name: str | None = None
    file_path: str | None = None

    @property
    def duration_s(self) -> int:
        return int((self.ended_at - self.started_at).total_seconds())

    def to_payload(self, *, include_titles: bool, include_urls: bool) -> dict:
        return {
            "client_uid": self.client_uid,
            "started_at": self.started_at.isoformat(),
            "ended_at": self.ended_at.isoformat(),
            "active_s": self.active_s,
            "idle_s": self.idle_s,
            "app_name": self.app_name[:200],
            "app_exec": self.app_exec[:200],
            "window_title": (self.window_title[:2000] if include_titles else ""),
            "is_browser": self.is_browser,
            "browser": self.browser,
            "url_domain": self.url_domain if include_urls else None,
            "url_full": (self.url_full[:2000] if self.url_full and include_urls else None),
            "is_idle": self.is_idle,
            "input_activity_pct": self.input_activity_pct,
            "project_id": self.project_id,
            "task_id": self.task_id,
            "repo_name": self.repo_name,
            "branch_name": self.branch_name,
            # The file name only; never the full path, which leaks client and
            # customer names through directory structure.
            "file_path": (self.file_path[:2000] if self.file_path and include_titles else None),
        }


@dataclass
class _Open:
    sample: Sample
    started_at: datetime
    last_at: datetime
    active_s: float = 0.0
    idle_s: float = 0.0
    idle_samples: int = 0
    total_samples: int = 0
    # Samples in which the last-input tick moved, i.e. the user typed or moved
    # the mouse at some point in that second.
    input_samples: int = 0
    last_input_tick: int = 0
    urls: list[str] = field(default_factory=list)
    project_id: str | None = None
    task_id: str | None = None
    repo_name: str | None = None
    branch_name: str | None = None
    file_path: str | None = None


class Segmenter:
    def __init__(
        self,
        *,
        idle_threshold_s: int = 180,
        min_segment_s: int = 3,
        max_segment_s: int = 900,
    ) -> None:
        self.idle_threshold_s = idle_threshold_s
        self.min_segment_s = min_segment_s
        self.max_segment_s = max_segment_s
        self._open: _Open | None = None

    def update_policy(self, *, idle_threshold_s: int, min_segment_s: int) -> None:
        self.idle_threshold_s = idle_threshold_s
        self.min_segment_s = min_segment_s

    # -----------------------------------------------------------------------

    def add(
        self,
        sample: Sample,
        now: datetime | None = None,
        elapsed_s: float = 1.0,
        *,
        project_id: str | None = None,
        task_id: str | None = None,
        repo_name: str | None = None,
        branch_name: str | None = None,
        file_path: str | None = None,
    ) -> Segment | None:
        """Feed one sample. Returns a finished segment when one closes."""
        now = now or datetime.now(timezone.utc)
        is_idle_now = sample.locked or sample.idle_s >= self.idle_threshold_s

        emitted: Segment | None = None
        current = self._open

        if current is not None:
            was_idle = current.idle_samples > 0 and current.total_samples > 0 and (
                current.idle_s > current.active_s
            )
            identity_changed = current.sample.identity != sample.identity
            idle_flipped = was_idle != is_idle_now
            too_long = (now - current.started_at).total_seconds() >= self.max_segment_s

            if identity_changed or idle_flipped or too_long:
                emitted = self._close(now)
                current = None

        if current is None:
            self._open = _Open(sample=sample, started_at=now, last_at=now)
            current = self._open

        # Attribute the elapsed slice, then update the sample so the segment
        # carries the most recent title/URL for this identity.
        if is_idle_now:
            current.idle_s += elapsed_s
        else:
            current.active_s += elapsed_s
        current.idle_samples += 1 if is_idle_now else 0
        current.total_samples += 1
        # A moved tick means input happened since the previous sample. The first
        # sample of a segment has nothing to compare against, so it is not
        # counted either way rather than guessed.
        if current.last_input_tick and sample.input_tick != current.last_input_tick:
            current.input_samples += 1
        current.last_input_tick = sample.input_tick
        current.last_at = now
        current.sample = sample

        # Context is carried on the open segment, not recomputed at close: the
        # employee may switch project mid-window, and the value at the moment
        # the work happened is the one that should stick.
        if project_id is not None:
            current.project_id = project_id
            current.task_id = task_id
        if repo_name is not None:
            current.repo_name = repo_name
            current.branch_name = branch_name
        if file_path is not None:
            current.file_path = file_path

        return emitted

    def flush(self, now: datetime | None = None) -> Segment | None:
        return self._close(now or datetime.now(timezone.utc))

    # -----------------------------------------------------------------------

    def _close(self, now: datetime) -> Segment | None:
        current = self._open
        self._open = None
        if current is None:
            return None

        duration = (now - current.started_at).total_seconds()
        if duration < self.min_segment_s:
            # Alt-tab noise. Dropping it here keeps the spool and the database
            # from filling with sub-second rows that no report would ever show.
            return None

        # Scale the tallies onto the wall-clock duration: a slow sample loop or a
        # suspended laptop can make them drift apart.
        counted = current.active_s + current.idle_s
        if counted <= 0:
            active_s, idle_s = int(duration), 0
        else:
            active_s = int(round(duration * (current.active_s / counted)))
            idle_s = int(duration) - active_s

        sample = current.sample
        # Comparable samples are one fewer than total: the first has no
        # predecessor to diff against.
        comparable = max(1, current.total_samples - 1)
        return Segment(
            client_uid=uuid.uuid4().hex,
            started_at=current.started_at,
            ended_at=now,
            active_s=max(0, active_s),
            idle_s=max(0, idle_s),
            app_name=sample.app_name,
            app_exec=sample.app_exec,
            window_title=sample.window_title,
            is_browser=sample.is_browser,
            browser=sample.browser,
            url_domain=sample.url_domain,
            url_full=sample.url_full,
            is_idle=idle_s > active_s,
            input_activity_pct=min(100, round(100 * current.input_samples / comparable)),
            project_id=current.project_id,
            task_id=current.task_id,
            repo_name=current.repo_name,
            branch_name=current.branch_name,
            file_path=current.file_path,
        )
