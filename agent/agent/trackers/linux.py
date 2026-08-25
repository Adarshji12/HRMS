"""Linux (X11) foreground-window and idle tracking.

Wayland is not supported by this backend: it deliberately denies clients access
to other windows' titles. A Wayland deployment needs a compositor-specific path
(GNOME Shell extension, KWin script) or the xdg-desktop-portal screencast API.
``LinuxTracker`` raises on construction under Wayland so ``get_tracker`` falls
back to the null tracker instead of silently reporting nothing.
"""

from __future__ import annotations

import ctypes
import logging
import os
import time

import psutil

from agent.browsers import domain_of, identify_browser, normalise_url, url_from_title
from agent.trackers.base import Sample

log = logging.getLogger(__name__)


class _XScreenSaverInfo(ctypes.Structure):
    _fields_ = [
        ("window", ctypes.c_ulong),
        ("state", ctypes.c_int),
        ("kind", ctypes.c_int),
        ("since", ctypes.c_ulong),
        ("idle", ctypes.c_ulong),
        ("event_mask", ctypes.c_ulong),
    ]


class LinuxTracker:
    def __init__(self) -> None:
        if os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland":
            raise RuntimeError("Wayland session: X11 window tracking is unavailable")

        from Xlib import display as xdisplay  # noqa: PLC0415 - optional platform dep

        self._display = xdisplay.Display()
        self._root = self._display.screen().root
        self._net_active = self._display.intern_atom("_NET_ACTIVE_WINDOW")
        self._net_name = self._display.intern_atom("_NET_WM_NAME")
        self._net_pid = self._display.intern_atom("_NET_WM_PID")
        self._utf8 = self._display.intern_atom("UTF8_STRING")

        self._xss = self._load_xss()
        self._x11_display, self._xss_info = self._open_x11()
        self._url_cache: tuple[str, str | None] | None = None
        self._proc_cache: dict[int, tuple[str, str]] = {}

    @staticmethod
    def _load_xss():
        for name in ("libXss.so.1", "libXss.so"):
            try:
                lib = ctypes.cdll.LoadLibrary(name)
                lib.XScreenSaverAllocInfo.restype = ctypes.POINTER(_XScreenSaverInfo)
                lib.XScreenSaverQueryInfo.argtypes = [
                    ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(_XScreenSaverInfo)
                ]
                return lib
            except OSError:
                continue
        log.warning("libXss not found; idle detection disabled")
        return None

    def _open_x11(self):
        """One display connection and one info struct, reused for the process.

        The previous implementation opened a fresh XOpenDisplay on every call
        and never closed it. Sampled once a second that leaks ~86,400
        connections a day until the X server refuses new clients and the user's
        whole desktop session breaks — the single worst bug in this file.

        restype must also be declared: ctypes defaults to c_int, which
        truncates a 64-bit Display* to 32 bits and hands the library a pointer
        into nowhere.
        """
        try:
            libx11 = ctypes.cdll.LoadLibrary("libX11.so.6")
        except OSError:
            log.warning("libX11 not found; idle detection disabled")
            return None, None
        libx11.XOpenDisplay.restype = ctypes.c_void_p
        libx11.XOpenDisplay.argtypes = [ctypes.c_char_p]
        display = libx11.XOpenDisplay(None)
        if not display:
            log.warning("could not open an X display; idle detection disabled")
            return None, None
        info = self._xss.XScreenSaverAllocInfo() if self._xss else None
        return display, info

    # -- primitives ---------------------------------------------------------

    def _idle_ms(self) -> int:
        if self._xss is None or self._x11_display is None or self._xss_info is None:
            return 0
        try:
            self._xss.XScreenSaverQueryInfo(
                ctypes.c_void_p(self._x11_display),
                ctypes.c_ulong(self._root.id),
                self._xss_info,
            )
            return max(0, int(self._xss_info.contents.idle))
        except Exception:  # noqa: BLE001
            return 0

    def _active_window(self):
        try:
            prop = self._root.get_full_property(self._net_active, 0)
        except Exception:  # noqa: BLE001
            return None
        if not prop or not prop.value:
            return None
        try:
            return self._display.create_resource_object("window", prop.value[0])
        except Exception:  # noqa: BLE001
            return None

    def _window_title(self, window) -> str:
        for atom, kind in ((self._net_name, self._utf8), (0, 0)):
            try:
                if atom:
                    prop = window.get_full_property(atom, kind)
                else:
                    prop = window.get_wm_name()
                    return str(prop or "")
                if prop and prop.value:
                    value = prop.value
                    return value.decode("utf-8", "replace") if isinstance(value, bytes) else str(value)
            except Exception:  # noqa: BLE001
                continue
        return ""

    def _window_pid(self, window) -> int:
        try:
            prop = window.get_full_property(self._net_pid, 0)
            if prop and prop.value:
                return int(prop.value[0])
        except Exception:  # noqa: BLE001
            pass
        return 0

    def _process_info(self, pid: int) -> tuple[str, str]:
        if pid in self._proc_cache:
            return self._proc_cache[pid]
        name, exe = "", ""
        try:
            proc = psutil.Process(pid)
            exe = proc.name()
            name = exe.replace("-", " ").title()
        except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
            pass
        if len(self._proc_cache) > 512:
            self._proc_cache.clear()
        self._proc_cache[pid] = (name, exe)
        return name, exe

    def _browser_url(self, title: str) -> str | None:
        # No cross-desktop way to read a browser's address bar on Linux; AT-SPI
        # works only where the browser exposes accessibility. Title parsing is
        # the honest default until the browser extension ships.
        if self._url_cache is not None and self._url_cache[0] == title:
            return self._url_cache[1]
        url = normalise_url(url_from_title(title))
        self._url_cache = (title, url)
        return url

    # -- Tracker protocol ---------------------------------------------------

    def sample(self) -> Sample:
        idle_ms = self._idle_ms()
        idle_s = idle_ms // 1000
        # Derive the same last-input timestamp Windows reports directly: it
        # jumps to "now" on every input and holds steady between them, which is
        # exactly what the segmenter diffs to measure input activity. Keeping
        # the field meaningful on every platform avoids input_activity_pct
        # silently reading 0% on Linux and macOS.
        input_tick = int(time.monotonic() * 1000) - idle_ms
        window = self._active_window()
        if window is None:
            return Sample(app_name="Idle", idle_s=idle_s, input_tick=input_tick)

        title = self._window_title(window)
        pid = self._window_pid(window)
        app_name, app_exec = self._process_info(pid) if pid else ("", "")

        browser = identify_browser(app_exec, app_name)
        url = self._browser_url(title) if browser else None

        return Sample(
            app_name=app_name or app_exec or "unknown",
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
        try:
            self._display.close()
        except Exception:  # noqa: BLE001
            pass
        # Release the raw X11 connection opened for XScreenSaver. Without this
        # a long-lived agent that restarts its tracker leaks one per restart.
        if self._x11_display:
            try:
                libx11 = ctypes.cdll.LoadLibrary("libX11.so.6")
                libx11.XCloseDisplay.argtypes = [ctypes.c_void_p]
                libx11.XCloseDisplay(ctypes.c_void_p(self._x11_display))
            except Exception:  # noqa: BLE001
                pass
            self._x11_display = None
