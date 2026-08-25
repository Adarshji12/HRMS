from __future__ import annotations

import logging
import sys

from agent.trackers.base import NullTracker, Sample, Tracker

log = logging.getLogger(__name__)


def get_tracker() -> Tracker:
    """Pick the platform tracker, degrading to a no-op rather than crashing.

    A machine missing an optional dependency should still enrol, heartbeat and
    report itself as online — that is far easier to diagnose from the dashboard
    than an agent that silently fails to start.
    """
    try:
        if sys.platform == "win32":
            from agent.trackers.windows import WindowsTracker

            return WindowsTracker()
        if sys.platform == "darwin":
            from agent.trackers.macos import MacTracker

            return MacTracker()
        from agent.trackers.linux import LinuxTracker

        return LinuxTracker()
    except Exception:  # noqa: BLE001 - import or platform API failure
        log.exception("no platform tracker available; running in null mode")
        return NullTracker()


__all__ = ["Sample", "Tracker", "get_tracker", "NullTracker"]
