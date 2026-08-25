"""Screen capture and its schedule.

Captured images are downscaled and JPEG-encoded *on the agent* before they reach
the spool: uploading full-resolution PNGs from a 4K multi-monitor desk would be
~20 MB per capture and would dominate the employee's bandwidth.
"""

from __future__ import annotations

import io
import logging
import os
import random
import sys
from datetime import datetime, timedelta, timezone

from PIL import Image

log = logging.getLogger(__name__)


class CaptureError(RuntimeError):
    pass


def capture_blocker() -> str | None:
    """Why screen capture cannot work on this machine, or None if it can.

    Both cases this catches fail *silently* otherwise, which is the worst shape
    a monitoring failure can take: the capture succeeds, the upload succeeds,
    the dashboard fills with images, and every one of them is blank. Nobody
    looks at a folder of screenshots that is arriving on schedule.

    Checked deterministically rather than by inspecting the pixels. A frame that
    happens to be dark is not evidence of anything, and a macOS capture without
    permission comes back as the desktop wallpaper — which is a perfectly
    detailed image, just not of anyone's work.
    """
    if sys.platform == "linux":
        # Wayland deliberately denies one client access to another's surface.
        # mss still connects through XWayland and still returns a frame, so
        # there is no error to catch — the frame is simply black.
        if os.environ.get("WAYLAND_DISPLAY") or os.environ.get("XDG_SESSION_TYPE") == "wayland":
            return (
                "this is a Wayland session, which does not let one program capture "
                "another's window; log in with an X11/Xorg session instead"
            )

    if sys.platform == "darwin":
        try:
            import Quartz  # noqa: PLC0415 - macOS only, imported where it is used
        except ImportError:
            return None
        preflight = getattr(Quartz, "CGPreflightScreenCaptureAccess", None)
        if preflight is None:
            # Pre-Catalina: no TCC gate on screen capture at all.
            return None
        if not preflight():
            return (
                "Screen Recording permission has not been granted; macOS returns "
                "the desktop wallpaper instead of the screen. Grant it in System "
                "Settings → Privacy & Security → Screen Recording"
            )

    return None


def request_macos_permission() -> None:
    """Trigger the macOS Screen Recording prompt, once.

    macOS only ever shows this prompt in response to an explicit request, and
    only the first time — after that the answer is changed in System Settings
    or not at all. Asking at startup puts the request at the moment the
    employee is being told they are monitored, rather than never.
    """
    if sys.platform != "darwin":
        return
    try:
        import Quartz  # noqa: PLC0415

        request = getattr(Quartz, "CGRequestScreenCaptureAccess", None)
        if request is not None:
            request()
    except Exception:  # noqa: BLE001 - a prompt failing must not stop the agent
        log.debug("could not request Screen Recording permission", exc_info=True)


def capture(
    *, max_width: int = 1600, quality: int = 60, all_monitors: bool = True
) -> tuple[bytes, int, int, int]:
    """Grab the screen. Returns (jpeg_bytes, width, height, monitor_count)."""
    # Refuse before capturing rather than uploading a blank frame. A skipped
    # capture leaves a gap someone can ask about; a black one does not.
    blocked = capture_blocker()
    if blocked:
        raise CaptureError(blocked)

    try:
        import mss  # noqa: PLC0415 - imported lazily so enrolment works headless
    except ImportError as exc:  # pragma: no cover
        raise CaptureError("mss is not installed") from exc

    try:
        with mss.mss() as sct:
            monitors = sct.monitors
            # monitors[0] is the union of every display; 1..n are the individual
            # ones. Capturing the union keeps multi-monitor context in one image.
            target = monitors[0] if all_monitors and len(monitors) > 1 else monitors[
                1 if len(monitors) > 1 else 0
            ]
            raw = sct.grab(target)
            monitor_count = max(1, len(monitors) - 1)
            img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")
    except Exception as exc:  # noqa: BLE001 - mss raises platform-specific errors
        raise CaptureError(f"screen capture failed: {exc}") from exc

    if max_width and img.width > max_width:
        ratio = max_width / img.width
        img = img.resize((max_width, max(1, round(img.height * ratio))), Image.LANCZOS)

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=max(20, min(95, quality)), optimize=True)
    return buf.getvalue(), img.width, img.height, monitor_count


class Scheduler:
    """Fires once per interval window.

    With ``randomize`` the moment inside each window is unpredictable, which is
    the point: a fixed 10-minute cadence is trivial to work around. The number
    of captures per hour stays exactly the same either way, so the setting does
    not quietly increase how much is collected.
    """

    def __init__(self, interval_s: int, randomize: bool = True) -> None:
        self.interval_s = max(30, interval_s)
        self.randomize = randomize
        self._rng = random.SystemRandom()
        self._window_start = datetime.now(timezone.utc)
        self._next_at = self._pick(self._window_start)

    def update(self, interval_s: int, randomize: bool) -> None:
        interval_s = max(30, interval_s)
        if interval_s == self.interval_s and randomize == self.randomize:
            return
        self.interval_s = interval_s
        self.randomize = randomize
        self._window_start = datetime.now(timezone.utc)
        self._next_at = self._pick(self._window_start)

    def _pick(self, window_start: datetime) -> datetime:
        offset = self._rng.uniform(0, self.interval_s) if self.randomize else self.interval_s
        return window_start + timedelta(seconds=offset)

    @property
    def next_at(self) -> datetime:
        return self._next_at

    def due(self, now: datetime | None = None) -> bool:
        now = now or datetime.now(timezone.utc)
        if now < self._next_at:
            return False
        # Advance to the next window boundary rather than measuring from `now`,
        # so a slow upload or a suspended laptop cannot make captures drift
        # progressively later. The loop covers a long suspend in one step.
        self._window_start += timedelta(seconds=self.interval_s)
        while self._window_start <= now:
            self._window_start += timedelta(seconds=self.interval_s)
        self._next_at = self._pick(self._window_start)
        return True
