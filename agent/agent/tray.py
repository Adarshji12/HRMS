"""System-tray indicator.

Deliberately not optional-by-configuration: monitoring must be visible to the
person being monitored. If ``pystray`` is unavailable the agent still runs, but
it logs a warning so the deployment is known to be missing its notice surface.
"""

from __future__ import annotations

import logging
import math
import threading

log = logging.getLogger(__name__)

BRAND = (0x5B, 0x18, 0xD9, 0xFF)
WHITE = (0xFF, 0xFF, 0xFF, 0xFF)
_SS = 8  # supersample: the notification area renders this at 16px


def _icon_image():
    """The MyDeskTime mark — matches admin/public/favicon.svg.

    Same simplified cut as the favicon (no raised slab, no motion arc): at
    notification-area size those details turn to mud.
    """
    from PIL import Image, ImageDraw

    s = 64 * _SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((2 * _SS, 2 * _SS, 62 * _SS, 62 * _SS), radius=14 * _SS, fill=BRAND)

    cx = cy = 32 * _SS
    r = 16 * _SS

    def cap(x, y, w):
        d.ellipse((x - w / 2, y - w / 2, x + w / 2, y + w / 2), fill=WHITE)

    def arm(angle_deg, length, w):
        x = cx + length * math.cos(math.radians(angle_deg))
        y = cy + length * math.sin(math.radians(angle_deg))
        d.line((cx, cy, x, y), fill=WHITE, width=round(w))
        cap(cx, cy, w)
        cap(x, y, w)

    # Dial, broken between 1 and 4 o'clock so the upper hand runs past it.
    ring_w = r * 0.19
    d.arc((cx - r, cy - r, cx + r, cy + r), 45, 300, fill=WHITE, width=round(ring_w))
    for a in (45, 300):
        cap(cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a)), ring_w)

    # Hands spelling a T.
    for angle, length in ((180, r * 0.83), (90, r * 0.83), (320, r * 1.20)):
        arm(angle, length, r * 0.24)

    return img.resize((64, 64), Image.LANCZOS)


class TrayIndicator:
    def __init__(self, org_name: str, user_name: str, notice_text: str,
                 on_quit=None) -> None:
        self.org_name = org_name
        self.user_name = user_name
        self.notice_text = notice_text
        self._on_quit = on_quit
        self._icon = None
        self._thread: threading.Thread | None = None
        # Read from the sample loop, written from the tray thread, so it is
        # guarded. A plain attribute would be a data race that shows up as time
        # landing on the wrong project once a week.
        self._lock = threading.Lock()
        self._projects: list[dict] = []
        self._selected: str | None = None
        self._warning: str | None = None

    def set_warning(self, text: str) -> None:
        """Admit on the tray that collection is degraded.

        The tray is where this product tells the employee it is running, so it
        is also where it should say when it is running but collecting nothing.
        Otherwise the only honest account of the gap is a line in a log file
        nobody opens, and the employee is left believing they are covered.
        """
        with self._lock:
            self._warning = text
        if self._icon is None:
            return
        self._icon.title = f"MyDeskTime — screenshots off: {text[:80]}"
        try:
            if self._icon.HAS_NOTIFICATION:
                self._icon.notify(text[:200], "MyDeskTime: screenshots not working")
        except Exception:  # noqa: BLE001 - a failed toast must not stop tracking
            log.debug("tray notification failed", exc_info=True)

    # -- project selection --------------------------------------------------

    @property
    def selected_project_id(self) -> str | None:
        with self._lock:
            return self._selected

    def set_projects(self, projects: list[dict]) -> None:
        with self._lock:
            same = [p.get("id") for p in projects] == [p.get("id") for p in self._projects]
            self._projects = projects
            # A project the employee was removed from must not stay selected.
            if self._selected and self._selected not in {p.get("id") for p in projects}:
                self._selected = None
        if not same and self._icon is not None:
            # pystray rebuilds the menu from the callable on update().
            self._icon.update_menu()

    def _select(self, project_id: str | None) -> None:
        with self._lock:
            self._selected = project_id
        name = next(
            (p["name"] for p in self._projects if p.get("id") == project_id), "no project"
        )
        log.info("tracking against %s", name)
        if self._icon is not None:
            self._icon.update_menu()

    def start(self) -> None:
        try:
            import pystray  # noqa: PLC0415 - optional dependency
        except ImportError:
            log.warning("pystray not installed: no tray indicator will be shown")
            return

        def show_notice(_icon, _item):
            log.info("monitoring notice: %s", self.notice_text)
            if _icon.HAS_NOTIFICATION:
                _icon.notify(self.notice_text[:200], "Monitoring notice")

        def quit_agent(icon, _item):
            icon.stop()
            if self._on_quit:
                self._on_quit()

        def project_items():
            """Built lazily so the list reflects the latest server response."""
            with self._lock:
                projects, selected = list(self._projects), self._selected

            yield pystray.MenuItem(
                "No project",
                lambda _i, _it: self._select(None),
                checked=lambda _it: selected is None,
                radio=True,
            )
            for project in projects:
                pid = project.get("id")
                label = project.get("name", "Untitled")
                if project.get("code"):
                    label = f"{label} ({project['code']})"
                yield pystray.MenuItem(
                    label,
                    # pid bound as a default argument, not captured — a closure
                    # over the loop variable would make every entry select the
                    # last project.
                    lambda _i, _it, pid=pid: self._select(pid),
                    checked=lambda _it, pid=pid: selected == pid,
                    radio=True,
                )

        menu = pystray.Menu(
            pystray.MenuItem(f"Tracking active - {self.user_name}", None, enabled=False),
            pystray.MenuItem(f"Organisation: {self.org_name}", None, enabled=False),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Working on", pystray.Menu(project_items)),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("What is recorded?", show_notice, default=True),
            pystray.MenuItem("Stop tracking", quit_agent),
        )
        self._icon = pystray.Icon(
            "mydesktime", _icon_image(), f"MyDeskTime - tracking for {self.org_name}",
            menu,
        )
        self._thread = threading.Thread(target=self._icon.run, daemon=True, name="tray")
        self._thread.start()

    def stop(self) -> None:
        if self._icon is not None:
            try:
                self._icon.stop()
            except Exception:  # noqa: BLE001
                pass
