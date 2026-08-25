"""Windows foreground-window, idle and browser-URL tracking.

Uses plain ctypes against user32 for the hot path (sampled every second) and
UI Automation only for browser URLs, which is comparatively slow and therefore
cached per (window, title).
"""

from __future__ import annotations

import ctypes
import logging
from ctypes import wintypes

import psutil

from agent.browsers import domain_of, identify_browser, normalise_url, url_from_title
from agent.trackers.base import Sample

log = logging.getLogger(__name__)

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)


class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]


user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetLastInputInfo.argtypes = [ctypes.POINTER(LASTINPUTINFO)]
kernel32.GetTickCount64.restype = ctypes.c_ulonglong

# The lock screen and the credential UI. Foreground time inside either is not
# work, regardless of what the session-state APIs report.
_LOCK_SHELLS = {"lockapp.exe", "logonui.exe"}

# WTSSessionInfoEx / WTS_SESSIONSTATE_LOCK. WTSINFOEX_LEVEL1 puts SessionFlags
# at a fixed offset; the struct is read as raw bytes rather than mirrored field
# by field, because only that one LONG is wanted and the rest of the layout
# differs across SDK versions.
_WTS_CURRENT_SERVER_HANDLE = 0
_WTS_CURRENT_SESSION = -1
_WTS_SESSION_INFO_EX = 25
_WTS_SESSIONSTATE_LOCK = 0
_SESSION_FLAGS_OFFSET = 16  # DWORD Level + LONG SessionState... see below


def _wts_session_locked() -> bool:
    """True when this session is locked, per the documented WTS API.

    Raises OSError when wtsapi32 cannot be loaded so the caller can fall back.
    """
    wtsapi32 = ctypes.WinDLL("wtsapi32", use_last_error=True)
    buf = ctypes.c_void_p()
    size = wintypes.DWORD()
    ok = wtsapi32.WTSQuerySessionInformationW(
        _WTS_CURRENT_SERVER_HANDLE, _WTS_CURRENT_SESSION, _WTS_SESSION_INFO_EX,
        ctypes.byref(buf), ctypes.byref(size),
    )
    if not ok or not buf:
        return False
    try:
        if size.value < _SESSION_FLAGS_OFFSET + 4:
            return False
        raw = ctypes.string_at(buf, _SESSION_FLAGS_OFFSET + 4)
        # WTSINFOEX { DWORD Level; DWORD _pad; WTSINFOEX_LEVEL1 { ULONG SessionId;
        # WTS_CONNECTSTATE_CLASS SessionState; LONG SessionFlags; ... } }
        flags = int.from_bytes(raw[_SESSION_FLAGS_OFFSET:_SESSION_FLAGS_OFFSET + 4],
                               "little", signed=True)
        return flags == _WTS_SESSIONSTATE_LOCK
    finally:
        wtsapi32.WTSFreeMemory(buf)


def _locked_sample(idle_s: int, input_tick: int) -> Sample:
    """One shape for a locked session, however it was detected.

    app_name is "Locked" rather than the shell's own name so a locked stretch is
    obvious in the activity log instead of masquerading as an application.
    """
    return Sample(
        app_name="Locked", app_exec="locked", window_title="",
        idle_s=idle_s, locked=True, input_tick=input_tick,
    )


# UI Automation constants (UIAutomationClient.h) — used as literals so the agent
# does not depend on comtypes' generated enum names.
_UIA_CONTROL_TYPE_PROPERTY = 30003
_UIA_VALUE_VALUE_PROPERTY = 30045
_UIA_EDIT_CONTROL_TYPE = 50004
_TREESCOPE_DESCENDANTS = 4


class _UIAutomation:
    """Lazily-created UI Automation client for reading browser address bars."""

    def __init__(self) -> None:
        self._uia = None
        self._condition = None
        self._unavailable = False

    def _ensure(self) -> bool:
        if self._uia is not None:
            return True
        if self._unavailable:
            return False
        try:
            import comtypes.client
            from comtypes import COMError  # noqa: F401  (imported for callers)

            comtypes.client.GetModule("UIAutomationCore.dll")
            from comtypes.gen import UIAutomationClient as UIA

            self._uia = comtypes.client.CreateObject(
                UIA.CUIAutomation, interface=UIA.IUIAutomation
            )
            self._condition = self._uia.CreatePropertyCondition(
                _UIA_CONTROL_TYPE_PROPERTY, _UIA_EDIT_CONTROL_TYPE
            )
            return True
        except Exception:  # noqa: BLE001 - COM/typelib generation can fail anywhere
            log.warning("UI Automation unavailable; falling back to title parsing",
                        exc_info=True)
            self._unavailable = True
            return False

    def address_bar_value(self, hwnd: int) -> str | None:
        if not self._ensure():
            return None
        try:
            element = self._uia.ElementFromHandle(hwnd)
            if element is None:
                return None
            edit = element.FindFirst(_TREESCOPE_DESCENDANTS, self._condition)
            if edit is None:
                return None
            value = edit.GetCurrentPropertyValue(_UIA_VALUE_VALUE_PROPERTY)
            return str(value) if value else None
        except Exception:  # noqa: BLE001 - the window can vanish mid-call
            return None


class WindowsTracker:
    def __init__(self) -> None:
        self._uia = _UIAutomation()
        # (hwnd, title) -> url. The address bar only changes when the title
        # does, so this collapses ~60 UIA round-trips per minute into one.
        self._url_cache: tuple[tuple[int, str], str | None] | None = None
        self._proc_cache: dict[int, tuple[str, str]] = {}

    # -- primitives ---------------------------------------------------------

    @staticmethod
    def _window_title(hwnd: int) -> str:
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return ""
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        return buf.value

    @staticmethod
    def _input_state() -> tuple[int, int]:
        """(idle seconds, last-input tick in ms)."""
        info = LASTINPUTINFO()
        info.cbSize = ctypes.sizeof(info)
        if not user32.GetLastInputInfo(ctypes.byref(info)):
            return 0, 0
        # GetTickCount64 avoids the 49.7-day wrap that GetTickCount has, which
        # would otherwise report a huge idle time on long-uptime machines.
        millis = kernel32.GetTickCount64() - info.dwTime
        return max(0, int(millis // 1000)), int(info.dwTime)

    @staticmethod
    def _session_locked() -> bool:
        """True when the workstation is locked or on the secure desktop.

        Two checks, because neither is sufficient on its own.

        OpenInputDesktop was the only check here and it silently stopped
        working: on Windows 10/11 a process already running on the interactive
        desktop can keep opening the input desktop while the lock screen owns
        it, so this returned False for a locked machine. The observed cost was
        a 3h19m segment of "Windows Default Lock Screen" recorded as fully
        active work — locked time billed as productive time, which is worse
        than not recording it at all.

        WTSQuerySessionInformation with WTSSessionInfoEx is the documented
        answer and is authoritative on Win8+. It is wrapped in try/except
        because wtsapi32 is absent on some stripped images, in which case the
        desktop probe (plus the shell check in sample()) still applies.
        """
        desktop = user32.OpenInputDesktop(0, False, 0x0100)  # DESKTOP_READOBJECTS
        if not desktop:
            return True
        user32.CloseDesktop(desktop)

        try:
            return _wts_session_locked()
        except OSError:  # pragma: no cover - depends on the Windows image
            return False

    def _process_info(self, pid: int) -> tuple[str, str]:
        """(display name, executable name). Cached — psutil lookups are not free."""
        if pid in self._proc_cache:
            return self._proc_cache[pid]
        name, exe = "", ""
        try:
            proc = psutil.Process(pid)
            exe = proc.name()
            try:
                # The friendly product name if the binary carries one.
                name = proc.name().removesuffix(".exe").replace("_", " ").title()
            except (psutil.AccessDenied, OSError):
                name = exe
        except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
            pass
        if len(self._proc_cache) > 512:
            self._proc_cache.clear()
        self._proc_cache[pid] = (name, exe)
        return name, exe

    def _browser_url(self, hwnd: int, title: str) -> str | None:
        key = (hwnd, title)
        if self._url_cache is not None and self._url_cache[0] == key:
            return self._url_cache[1]

        url = self._uia.address_bar_value(hwnd) or url_from_title(title)
        url = normalise_url(url)
        self._url_cache = (key, url)
        return url

    # -- Tracker protocol ---------------------------------------------------

    def sample(self) -> Sample:
        idle_s, input_tick = self._input_state()

        if self._session_locked():
            return _locked_sample(idle_s, input_tick)

        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            # No foreground window: screensaver, UAC prompt, or a desktop switch.
            return Sample(app_name="Idle", app_exec="", idle_s=idle_s, input_tick=input_tick)

        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        app_name, app_exec = self._process_info(pid.value)
        title = self._window_title(hwnd)

        # Last line of defence. If the thing in front of the user is the lock
        # shell itself, the session is locked whatever the APIs above claimed —
        # nobody is doing billable work inside LockApp.exe. This is what would
        # have caught the 3h19m regression on its own.
        if app_exec.lower() in _LOCK_SHELLS:
            return _locked_sample(idle_s, input_tick)

        browser = identify_browser(app_exec, app_name)
        url = self._browser_url(hwnd, title) if browser else None

        return Sample(
            app_name=app_name or app_exec or "unknown",
            app_exec=app_exec,
            window_title=title,
            pid=pid.value,
            is_browser=browser is not None,
            browser=browser,
            url_full=url,
            url_domain=domain_of(url),
            idle_s=idle_s,
            input_tick=input_tick,
        )

    def close(self) -> None:
        self._url_cache = None
        self._proc_cache.clear()
