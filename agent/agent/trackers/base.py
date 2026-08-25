from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class Sample:
    """One observation of the foreground window."""

    app_name: str = ""
    app_exec: str = ""
    window_title: str = ""
    pid: int = 0
    is_browser: bool = False
    browser: str | None = None
    url_full: str | None = None
    url_domain: str | None = None
    # Seconds since the last keyboard or mouse input, machine-wide.
    idle_s: int = 0
    locked: bool = False

    # Monotonic timestamp of the last input event, in milliseconds.
    #
    # This is how input *activity* is measured without a keyboard hook: compare
    # the value between two samples and you know whether the user touched the
    # machine in that interval. Counting real keystrokes would need
    # SetWindowsHookEx — the keylogger API — and installing one to produce a
    # number nobody acts on is not a trade worth making. No key identity, no
    # click coordinates, and nothing that could reconstruct what was typed.
    input_tick: int = 0

    @property
    def identity(self) -> tuple:
        """What must stay equal for two samples to belong to the same segment."""
        return (self.app_exec, self.window_title, self.url_domain, self.locked)


class Tracker(Protocol):
    def sample(self) -> Sample: ...
    def close(self) -> None: ...


class NullTracker:
    """Used when no platform backend could be loaded."""

    def sample(self) -> Sample:
        return Sample(app_name="unknown", app_exec="unknown")

    def close(self) -> None:
        return None
