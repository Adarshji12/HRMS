"""Platform self-test.

    python -m agent.selftest

Exercises the tracker on whatever OS it is run on and reports which capabilities
actually work. This exists because the macOS and Linux trackers are written
against their platform APIs but cannot be executed on a Windows development
machine — so instead of shipping untested code with a shrug, validation is one
command for whoever does have the hardware.

It touches nothing: no enrolment, no server, no screenshots uploaded, no files
written. Safe to run on a stranger's laptop.
"""

from __future__ import annotations

import io
import platform
import sys
import time

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    RESULTS.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name:<34} {detail}")
    return ok


def warn(name: str, detail: str) -> None:
    RESULTS.append((name, True, detail))
    print(f"  WARN  {name:<34} {detail}")


def section(title: str) -> None:
    print(f"\n{title}")
    print("-" * 72)


def main() -> int:
    print("=" * 72)
    print(f"  MyDeskTime agent self-test — {platform.system()} {platform.release()}")
    print(f"  Python {sys.version.split()[0]}")
    print("=" * 72)

    section("Dependencies")
    for module, why in [
        ("PIL", "screenshot encoding"),
        ("mss", "screen capture"),
        ("requests", "server sync"),
        ("psutil", "process names"),
        ("pystray", "tray indicator (required for the visible-notice rule)"),
    ]:
        try:
            __import__(module)
            check(module, True, why)
        except ImportError:
            check(module, False, f"MISSING — {why}")

    if sys.platform == "darwin":
        for module, why in [("AppKit", "frontmost app"), ("Quartz", "idle + window titles")]:
            try:
                __import__(module)
                check(module, True, why)
            except ImportError:
                check(module, False, f"MISSING — pip install pyobjc-framework-Cocoa ({why})")
    elif sys.platform.startswith("linux"):
        try:
            __import__("Xlib")
            check("python-xlib", True, "window enumeration")
        except ImportError:
            check("python-xlib", False, "MISSING — pip install python-xlib")

    section("Tracker")
    from agent.trackers import NullTracker, get_tracker

    tracker = get_tracker()
    is_null = isinstance(tracker, NullTracker)
    if not check("platform tracker loaded", not is_null, type(tracker).__name__):
        if sys.platform.startswith("linux"):
            import os

            if os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland":
                warn("Wayland detected", "X11 tracking unavailable — see agent/README.md")
        print("\nNo platform tracker: nothing below can be validated.")
        return _summary()

    # Two samples a second apart: enough to tell a working tracker from one
    # that returns the same frozen struct every call.
    first = tracker.sample()
    time.sleep(1.1)
    second = tracker.sample()

    check("foreground app name", bool(first.app_name), repr(first.app_name))
    check("executable name", bool(first.app_exec), repr(first.app_exec))
    title_ok = bool(first.window_title)
    if title_ok:
        check("window title", True, repr(first.window_title[:44]))
    elif sys.platform == "darwin":
        warn("window title", "empty — grant Screen Recording in System Settings")
    else:
        warn("window title", "empty — some windows genuinely have none; retry with an editor focused")

    check("idle seconds readable", first.idle_s >= 0, f"{first.idle_s}s")
    tick_ok = first.input_tick > 0
    if tick_ok:
        moved = second.input_tick != first.input_tick
        check("input tick populated", True, f"{first.input_tick}")
        print(f"        (moved between samples: {moved} — true only if you touched the machine)")
    else:
        check("input tick populated", False, "0 — input activity will always report 0%")

    check("lock state readable", isinstance(first.locked, bool), f"locked={first.locked}")

    section("Browser URL")
    if first.is_browser:
        check("browser detected", True, first.browser or "?")
        if first.url_domain:
            check("URL resolved", True, first.url_domain)
        elif sys.platform == "darwin":
            warn("URL not resolved", "grant Accessibility, or focus a browser and rerun")
        else:
            warn("URL not resolved", "focus a browser tab and rerun")
    else:
        warn("no browser focused", "focus a browser window and rerun to test URL capture")

    section("Screen capture")
    try:
        from agent.screenshots import capture, capture_blocker

        blocked = capture_blocker()
        check("capture permitted", not blocked, blocked or "no blocker")

        if not blocked:
            data, width, height, monitors = capture(max_width=800, quality=50)
            # "len(data) > 0" was the old test and it passed on every failure
            # this file exists to catch: a blank frame is still a valid JPEG of
            # a few hundred bytes. Look at the pixels instead.
            #
            # This is a backstop, not the main defence — capture_blocker above
            # names the two known causes outright. It exists for the ones it
            # cannot know about: a compositor that returns black without
            # announcing itself, a virtual display with nothing attached.
            from PIL import Image, ImageStat  # noqa: PLC0415

            image = Image.open(io.BytesIO(data)).convert("L")
            spread = ImageStat.Stat(image).stddev[0]
            size = f"{width}x{height}, {len(data)//1024} KB, {monitors} monitor(s)"
            if spread < 1.5:
                # A real desktop is never this flat, even a plain one: there is
                # always a taskbar, a menu bar or a window edge somewhere.
                check("screen capture", False,
                      f"{size} — frame is blank (variation {spread:.1f}); "
                      "capture is being denied by the system")
            else:
                check("screen capture", True, size)
    except Exception as exc:  # noqa: BLE001
        detail = str(exc)[:60]
        if sys.platform == "darwin":
            detail += " — grant Screen Recording"
        check("screen capture", False, detail)

    section("Developer context")
    from agent.gitcontext import GitResolver, is_editor

    editor = is_editor(first.app_exec, first.app_name)
    if editor:
        info = GitResolver().resolve(first.window_title)
        check("editor detected", True, first.app_exec)
        if info.repo_name:
            check("git repo resolved", True, f"{info.repo_name} @ {info.branch_name}")
        else:
            warn("git repo not resolved", "set repo_search_roots in agent.json if this is a repo")
    else:
        warn("no editor focused", "focus VS Code or similar and rerun to test git context")

    tracker.close()
    return _summary()


def _summary() -> int:
    failures = [name for name, ok, _ in RESULTS if not ok]
    print("\n" + "=" * 72)
    if failures:
        print(f"  {len(failures)} FAILED: {', '.join(failures)}")
        print("  WARN lines are usually context-dependent, not defects.")
    else:
        print(f"  All {len(RESULTS)} checks passed on {platform.system()}.")
    print("=" * 72 + "\n")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
