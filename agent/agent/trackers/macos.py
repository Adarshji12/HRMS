"""macOS foreground-app, idle and browser-URL tracking.

Requires two permissions in System Settings → Privacy & Security, both of which
should be pre-granted by MDM (PPPC profile) on managed fleets:

* **Accessibility** — needed for AppleScript to read a browser's active tab.
* **Screen Recording** — needed for window titles via CGWindowList *and* for
  screenshots. Without it macOS returns empty titles rather than an error.
"""

from __future__ import annotations

import logging
import subprocess
import time

from agent.browsers import domain_of, identify_browser, normalise_url, url_from_title
from agent.trackers.base import Sample

log = logging.getLogger(__name__)

# AppleScript per browser. Chromium-family and WebKit-family use different
# vocabulary for the same idea.
_URL_SCRIPTS = {
    "chrome": 'tell application "Google Chrome" to return URL of active tab of front window',
    "brave": 'tell application "Brave Browser" to return URL of active tab of front window',
    "edge": 'tell application "Microsoft Edge" to return URL of active tab of front window',
    "vivaldi": 'tell application "Vivaldi" to return URL of active tab of front window',
    "safari": 'tell application "Safari" to return URL of front document',
}


class MacTracker:
    def __init__(self) -> None:
        from AppKit import NSWorkspace  # noqa: PLC0415 - optional platform dep
        import Quartz  # noqa: PLC0415

        self._workspace = NSWorkspace.sharedWorkspace()
        self._quartz = Quartz
        self._url_cache: tuple[str, str | None] | None = None

    # -- primitives ---------------------------------------------------------

    def _idle_ms(self) -> int:
        q = self._quartz
        try:
            seconds = q.CGEventSourceSecondsSinceLastEventType(
                q.kCGEventSourceStateHIDSystemState, q.kCGAnyInputEventType
            )
            # Kept in milliseconds: the float carries sub-second precision, and
            # rounding to whole seconds first would make the derived input tick
            # jitter by up to a second and miscount input activity.
            return max(0, int(seconds * 1000))
        except Exception:  # noqa: BLE001
            return 0

    def _front_window_title(self, pid: int) -> str:
        q = self._quartz
        try:
            windows = q.CGWindowListCopyWindowInfo(
                q.kCGWindowListOptionOnScreenOnly | q.kCGWindowListExcludeDesktopElements,
                q.kCGNullWindowID,
            )
        except Exception:  # noqa: BLE001
            return ""
        for win in windows or []:
            if win.get("kCGWindowOwnerPID") != pid:
                continue
            # Layer 0 is a normal application window; menus and overlays are not.
            if win.get("kCGWindowLayer", 0) != 0:
                continue
            name = win.get("kCGWindowName") or ""
            if name:
                return str(name)
        return ""

    def _screen_locked(self) -> bool:
        q = self._quartz
        try:
            session = q.CGSessionCopyCurrentDictionary()
        except Exception:  # noqa: BLE001
            return False
        if not session:
            return True
        return bool(session.get("CGSSessionScreenIsLocked", 0))

    def _browser_url(self, browser: str, title: str) -> str | None:
        if self._url_cache is not None and self._url_cache[0] == title:
            return self._url_cache[1]

        url = None
        script = _URL_SCRIPTS.get(browser)
        if script:
            try:
                result = subprocess.run(
                    ["osascript", "-e", script],
                    capture_output=True, text=True, timeout=2.0, check=False,
                )
                if result.returncode == 0:
                    url = result.stdout.strip() or None
            except (subprocess.SubprocessError, OSError):
                url = None

        url = normalise_url(url or url_from_title(title))
        self._url_cache = (title, url)
        return url

    # -- Tracker protocol ---------------------------------------------------

    def sample(self) -> Sample:
        idle_ms = self._idle_ms()
        idle_s = idle_ms // 1000
        # Same derivation as the Linux tracker: a timestamp that jumps to "now"
        # on input and holds steady between them, so the segmenter can measure
        # input activity identically on all three platforms.
        input_tick = int(time.monotonic() * 1000) - idle_ms

        if self._screen_locked():
            return Sample(
                app_name="Locked", app_exec="locked", idle_s=idle_s,
                locked=True, input_tick=input_tick,
            )

        app = self._workspace.frontmostApplication()
        if app is None:
            return Sample(app_name="Idle", idle_s=idle_s, input_tick=input_tick)

        app_name = str(app.localizedName() or "")
        pid = int(app.processIdentifier())
        bundle = str(app.bundleIdentifier() or "")
        # The bundle id is the stable identifier on macOS; app_exec carries it so
        # a single rule set can key off one field across platforms.
        app_exec = bundle or app_name.lower()

        title = self._front_window_title(pid)
        browser = identify_browser(app_exec, app_name) or identify_browser(app_name.lower())
        url = self._browser_url(browser, title) if browser else None

        return Sample(
            app_name=app_name or app_exec,
            app_exec=app_exec,
            window_title=title,
            pid=pid,
            is_browser=browser is not None,
            browser=browser,
            url_full=url,
            url_domain=domain_of(url),
            idle_s=idle_s,
            input_tick=input_tick,
        )

    def close(self) -> None:
        self._url_cache = None
