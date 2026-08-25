"""Agent entry point.

    python -m agent.main --enroll ABCD-EFGH-IJKL-MNOP --server https://sentinel.example.com
    python -m agent.main                 # run with stored credentials
    python -m agent.main --status        # show enrolment, policy and queue depth
    python -m agent.main --once          # single sample + sync, for smoke tests
"""

from __future__ import annotations

import argparse
import logging
import logging.handlers
import os
import platform
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from datetime import datetime, time as dtime, timezone

from agent import __version__
from agent.api import (
    ApiClient,
    AuthFailed,
    DeviceRevoked,
    NoticeRequired,
    ServerUnavailable,
)
from agent import gitcontext
from agent.config import LOG_PATH, SPOOL_PATH, AgentConfig, Policy
from agent.gitcontext import GitInfo, GitResolver
from agent.screenshots import (
    CaptureError,
    Scheduler,
    capture,
    capture_blocker,
    request_macos_permission,
)
from agent.segmenter import Segmenter
from agent.singleinstance import AlreadyRunning, SingleInstance
from agent.spool import Spool, new_uid
from agent.trackers import get_tracker
from agent.tray import TrayIndicator

log = logging.getLogger("agent")

SEGMENT_BATCH = 200
SCREENSHOT_BATCH = 3


def setup_logging(level: str = "INFO") -> None:
    handler = logging.handlers.RotatingFileHandler(
        LOG_PATH, maxBytes=2_000_000, backupCount=3, encoding="utf-8"
    )
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    handler.setFormatter(fmt)

    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(fmt)

    root = logging.getLogger()
    root.setLevel(getattr(logging, level.upper(), logging.INFO))
    root.handlers = [handler, console]


def platform_name() -> str:
    return {"win32": "windows", "darwin": "darwin"}.get(sys.platform, "linux")


def _parse_hhmm(value: str, fallback: dtime) -> dtime:
    try:
        hour, minute = value.split(":")
        return dtime(int(hour), int(minute))
    except (ValueError, AttributeError):
        return fallback


class Agent:
    def __init__(self, config: AgentConfig) -> None:
        self.config = config
        self.api = ApiClient(
            config.server_url,
            config.device_token,
            verify=config.verify_tls,
            org_slug=config.org_slug,
        )
        self.spool = Spool(SPOOL_PATH)
        self.tracker = get_tracker()
        self.segmenter = Segmenter(
            idle_threshold_s=config.policy.idle_threshold_s,
            min_segment_s=config.policy.min_segment_s,
            max_segment_s=config.segment_max_s,
        )
        self.scheduler = Scheduler(
            config.policy.screenshot_interval_s, config.policy.screenshot_randomize
        )
        self.git = GitResolver(config.repo_search_roots or None)
        self.tray = TrayIndicator(
            config.org_name, config.user_name, config.policy.notice_text,
            on_quit=self.request_stop,
        )
        self.capture_blocked: str | None = None
        self._stop = threading.Event()
        self._last_sync = 0.0
        self._last_sample = None

    # -- lifecycle ----------------------------------------------------------

    def request_stop(self, *_args) -> None:
        log.info("stop requested")
        self._stop.set()

    def run(self) -> int:
        log.info(
            "agent %s starting for %s (%s) -> %s",
            __version__, self.config.user_name, self.config.org_name, self.config.server_url,
        )
        self.tray.start()

        # Ask once, at the moment the employee is being told they are
        # monitored. macOS only ever shows this prompt on an explicit request
        # and only the first time; never asking means the answer is no forever.
        if self.config.policy.screenshot_enabled:
            request_macos_permission()

        # Then say plainly whether capture can work at all. Left unsaid, both
        # of the cases this catches look identical to a healthy agent from the
        # dashboard: screenshots arrive on schedule and every one is blank.
        self.capture_blocked = (
            capture_blocker() if self.config.policy.screenshot_enabled else None
        )
        if self.capture_blocked:
            log.error("SCREENSHOTS DISABLED: %s", self.capture_blocked)
            self.tray.set_warning(self.capture_blocked)

        started_at = datetime.now(timezone.utc)
        try:
            self.api.session_start(started_at.isoformat())
        except (ServerUnavailable, AuthFailed) as exc:
            log.warning("could not open work session: %s", exc)
        except DeviceRevoked:
            log.error("device is revoked; exiting")
            self.spool.wipe()
            return 3

        self.spool.trim()
        interval = self.config.sample_interval_s
        next_tick = time.monotonic()

        try:
            while not self._stop.is_set():
                next_tick += interval
                try:
                    self.tick(interval)
                except DeviceRevoked:
                    log.error("device revoked by administrator; stopping and wiping queue")
                    self.spool.wipe()
                    return 3
                except Exception:  # noqa: BLE001 - a bad tick must not kill the agent
                    log.exception("unhandled error in sample loop")

                # Sleep the remainder of the tick; if we overran, resync rather
                # than trying to catch up with a burst of samples.
                delay = next_tick - time.monotonic()
                if delay < 0:
                    next_tick = time.monotonic()
                    delay = 0
                self._stop.wait(delay)
        finally:
            self.shutdown(started_at)
        return 0

    def shutdown(self, _started_at: datetime) -> None:
        log.info("shutting down")
        final = self.segmenter.flush()
        if final is not None:
            self._spool_segment(final)
        try:
            self.sync(force=True)
        except Exception:  # noqa: BLE001
            log.warning("final sync failed; data stays queued locally")
        try:
            self.api.session_end(datetime.now(timezone.utc).isoformat())
        except Exception:  # noqa: BLE001
            pass
        self.tray.stop()
        self.tracker.close()
        self.spool.close()

    # -- one iteration ------------------------------------------------------

    def tick(self, elapsed: float) -> None:
        now = datetime.now(timezone.utc)

        if not self.within_working_hours(now):
            # Outside configured hours: close anything open and collect nothing.
            finished = self.segmenter.flush(now)
            if finished is not None:
                self._spool_segment(finished)
            self.maybe_sync(now)
            return

        sample = self.tracker.sample()
        self._last_sample = sample

        # Git context is only attempted for editors — resolving it for every
        # window would scan the disk for folder names that are not projects.
        git = GitInfo()
        if self.config.policy.track_window_titles and gitcontext.is_editor(
            sample.app_exec, sample.app_name
        ):
            git = self.git.resolve(sample.window_title)

        finished = self.segmenter.add(
            sample, now, elapsed,
            project_id=self.tray.selected_project_id,
            repo_name=git.repo_name,
            branch_name=git.branch_name,
            file_path=git.file_path,
        )
        if finished is not None:
            self._spool_segment(finished)

        if self.config.policy.screenshot_enabled and self.scheduler.due(now):
            self.take_screenshot(now, sample)

        self.maybe_sync(now)

    def within_working_hours(self, now: datetime) -> bool:
        policy = self.config.policy
        if policy.track_outside_hours:
            return True
        local = now.astimezone()
        start = _parse_hhmm(policy.work_day_start, dtime(0, 0))
        end = _parse_hhmm(policy.work_day_end, dtime(23, 59))
        if start <= end:
            return start <= local.time() <= end
        # Overnight shift, e.g. 22:00 -> 06:00.
        return local.time() >= start or local.time() <= end

    def _spool_segment(self, segment) -> None:
        payload = segment.to_payload(
            include_titles=self.config.policy.track_window_titles,
            include_urls=self.config.policy.track_urls,
        )
        self.spool.put_segment(payload)
        log.debug(
            "segment %s %ss %s%s",
            segment.client_uid[:8], segment.duration_s, segment.app_name,
            f" [{segment.url_domain}]" if segment.url_domain else "",
        )

    def take_screenshot(self, now: datetime, sample) -> None:
        policy = self.config.policy
        try:
            image, width, height, monitors = capture(
                max_width=policy.screenshot_max_width,
                quality=policy.screenshot_quality,
                all_monitors=policy.capture_all_monitors,
            )
        except CaptureError as exc:
            log.warning("screenshot skipped: %s", exc)
            return

        activity_pct = 0 if sample.idle_s >= policy.idle_threshold_s else 100
        meta = {
            "client_uid": new_uid(),
            "captured_at": now.isoformat(),
            "app_name": sample.app_name[:200],
            "app_exec": sample.app_exec[:200],
            "window_title": sample.window_title[:2000] if policy.track_window_titles else "",
            "url_domain": sample.url_domain if policy.track_urls else None,
            "monitor_count": monitors,
            "activity_pct": activity_pct,
        }
        self.spool.put_screenshot(meta, image)
        log.info("screenshot captured (%dx%d, %.0f KB) next at %s",
                 width, height, len(image) / 1024,
                 self.scheduler.next_at.astimezone().strftime("%H:%M:%S"))

    # -- sync ---------------------------------------------------------------

    def maybe_sync(self, now: datetime) -> None:
        if time.monotonic() - self._last_sync >= self.config.policy.sync_interval_s:
            self.sync()

    def sync(self, force: bool = False) -> None:
        self._last_sync = time.monotonic()
        seg_count, shot_count = self.spool.counts()

        try:
            state = self.api.heartbeat(seg_count + shot_count, self.capture_blocked)
        except ServerUnavailable as exc:
            log.debug("heartbeat failed (offline?): %s", exc)
            return
        except AuthFailed:
            log.error("device token rejected; re-enrolment required")
            return

        if state.get("revoked"):
            raise DeviceRevoked("server reports device revoked")
        self.apply_policy(Policy.from_server(state.get("config", {})))
        self.refresh_projects()

        self.flush_segments()
        if self.config.policy.screenshot_enabled or force:
            self.flush_screenshots()

    def flush_segments(self) -> None:
        while True:
            rows = self.spool.take_segments(SEGMENT_BATCH)
            if not rows:
                return
            ids = [row_id for row_id, _ in rows]
            payloads = [payload for _, payload in rows]
            try:
                accepted = self.api.send_segments(payloads)
            except (ServerUnavailable, AuthFailed) as exc:
                log.debug("segment upload deferred: %s", exc)
                self.spool.fail_segments(ids)
                return

            done = [row_id for row_id, payload in rows if payload["client_uid"] in accepted]
            self.spool.ack_segments(done)
            log.info("uploaded %d/%d segments", len(done), len(rows))
            if len(done) < len(rows):
                # Something in this batch is stuck; count the attempt so a
                # permanently-poisoned row eventually ages out.
                self.spool.fail_segments([i for i in ids if i not in done])
                return
            if len(rows) < SEGMENT_BATCH:
                return

    def flush_screenshots(self) -> None:
        for row_id, meta, path in self.spool.take_screenshots(SCREENSHOT_BATCH):
            if not path.exists():
                self.spool.ack_screenshot(row_id)
                continue
            try:
                self.api.upload_screenshot(meta, path)
            except (ServerUnavailable, AuthFailed) as exc:
                log.debug("screenshot upload deferred: %s", exc)
                self.spool.fail_screenshot(row_id)
                return
            self.spool.ack_screenshot(row_id)
            log.info("uploaded screenshot %s", meta["client_uid"][:8])

    def refresh_projects(self) -> None:
        """Keep the tray menu current. Failure is not worth interrupting sync."""
        try:
            self.tray.set_projects(self.api.projects())
        except Exception:  # noqa: BLE001
            log.debug("could not refresh the project list", exc_info=True)

    def apply_policy(self, policy: Policy) -> None:
        old = self.config.policy
        if policy == old:
            return
        self.config.policy = policy
        self.config.save()
        self.segmenter.update_policy(
            idle_threshold_s=policy.idle_threshold_s, min_segment_s=policy.min_segment_s
        )
        self.scheduler.update(policy.screenshot_interval_s, policy.screenshot_randomize)
        log.info(
            "policy updated: screenshots=%s every %ss (random=%s), idle=%ss, urls=%s",
            policy.screenshot_enabled, policy.screenshot_interval_s,
            policy.screenshot_randomize, policy.idle_threshold_s, policy.track_urls,
        )


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def _device_payload(config: AgentConfig, accept: bool) -> dict:
    return {
        "machine_id": config.machine_id,
        "hostname": platform.node() or socket.gethostname(),
        "os": platform_name(),
        "os_version": platform.version(),
        "agent_version": __version__,
        "accept_notice": accept,
    }


def _store_binding(config: AgentConfig, result: dict) -> None:
    config.device_id = result["device_id"]
    config.device_token = result["device_token"]
    config.user_name = result.get("user_name", "")
    config.user_email = result.get("user_email", "")
    config.org_name = result.get("org_name", "")
    config.org_slug = result.get("org_slug", config.org_slug)
    config.notice_accepted = True
    config.policy = Policy.from_server(result.get("config", {}))
    config.save()


def _print_bound(config: AgentConfig) -> None:
    print(f"\nSigned in as {config.user_name} at {config.org_name}.")
    print(f"Device id  : {config.device_id}")
    print(f"Screenshots: {'on' if config.policy.screenshot_enabled else 'off'}"
          f" every {config.policy.screenshot_interval_s}s")
    # Name a command that exists on this machine. Somebody who enrolled from
    # the packaged setup has no checkout to run "python -m agent.main" from.
    if getattr(sys, "frozen", False):
        binary = "sentinel-agent.exe" if sys.platform == "win32" else "sentinel-agent"
        print("\nTracking starts automatically when you sign in.")
        print(f"To start it now, run {binary} in this folder.")
    else:
        print("\nStart tracking with:  python -m agent.main")


def _show_notice(text: str) -> bool:
    """Display the monitoring notice and ask for consent. True if accepted."""
    print("\n" + "=" * 72)
    print("MONITORING NOTICE")
    print("=" * 72)
    print(text or "This device will be monitored by your employer.")
    print("=" * 72)
    answer = input("\nType 'accept' to consent and continue, anything else to cancel: ")
    return answer.strip().lower() == "accept"


def do_login(config: AgentConfig, email: str | None, org: str | None, accept: bool) -> int:
    """Bind this machine using the employee's own dashboard credentials."""
    import getpass

    if org:
        config.org_slug = org.strip().lower()
    if not config.org_slug:
        config.org_slug = input("Workspace name (e.g. acme): ").strip().lower()
    if not config.org_slug:
        print("A workspace name is required.")
        return 2

    address = email or input("Work email: ").strip()
    # getpass keeps the password off the screen and out of shell history. It is
    # sent once and never written to disk — only the returned device token is.
    password = getpass.getpass("Password: ")

    api = ApiClient(config.server_url, verify=config.verify_tls, org_slug=config.org_slug)
    payload = {**_device_payload(config, accept), "email": address, "password": password}

    try:
        result = api.login(payload)
    except NoticeRequired as exc:
        if not accept and not _show_notice(exc.notice_text):
            print("Sign-in cancelled. Nothing is being tracked.")
            return 1
        payload["accept_notice"] = True
        try:
            result = api.login(payload)
        except (AuthFailed, DeviceRevoked, ServerUnavailable) as exc2:
            print(f"Sign-in failed: {exc2}")
            return 2
    except AuthFailed as exc:
        print(f"Sign-in failed: {exc}")
        return 2
    except DeviceRevoked as exc:
        print(f"This workspace cannot accept new devices: {exc}")
        return 3
    except ServerUnavailable as exc:
        print(f"Cannot reach {config.server_url}: {exc}")
        return 2

    _store_binding(config, result)
    _print_bound(config)
    return 0


def do_enroll(config: AgentConfig, key: str, accept: bool) -> int:
    api = ApiClient(config.server_url, verify=config.verify_tls, org_slug=config.org_slug)
    payload = {**_device_payload(config, accept), "enrollment_key": key.strip().upper()}

    try:
        result = api.enroll(payload)
    except NoticeRequired as exc:
        if accept:
            print("\nNotice acceptance was sent but refused by the server.")
            return 2
        if not _show_notice(exc.notice_text):
            print("Enrolment cancelled. Nothing is being tracked.")
            return 1
        payload["accept_notice"] = True
        try:
            result = api.enroll(payload)
        except (AuthFailed, DeviceRevoked, ServerUnavailable) as exc2:
            print(f"Enrolment failed: {exc2}")
            return 2
    except AuthFailed as exc:
        print(f"Enrolment failed: {exc}")
        return 2
    except DeviceRevoked as exc:
        print(f"This workspace cannot accept new devices: {exc}")
        return 3
    except ServerUnavailable as exc:
        print(f"Cannot reach {config.server_url}: {exc}")
        return 2

    _store_binding(config, result)
    _print_bound(config)
    return 0


def _start_tracker() -> bool:
    """Launch the tracker now, detached from this console.

    DETACHED_PROCESS so it does not die when this window closes, and does not
    borrow the console it was started from.
    """
    if sys.platform != "win32" or not getattr(sys, "frozen", False):
        return False
    tracker = Path(sys.executable).with_name("sentinel-agent.exe")
    if not tracker.exists():
        return False
    try:
        DETACHED_PROCESS = 0x00000008
        subprocess.Popen(  # noqa: S603
            [str(tracker)],
            creationflags=DETACHED_PROCESS,
            cwd=str(tracker.parent),
        )
        return True
    except OSError:
        log.exception("could not start the tracker")
        return False


def _register_autostart() -> bool:
    """Make the tracker start at every sign-in.

    The interactive setup used to enrol and then print "MyDeskTime will now
    start automatically", which was simply untrue: only install.ps1 ever
    registered anything. A machine set up by double-clicking would sit there
    doing nothing until somebody launched the tracker by hand, and nobody would
    know, because a tracker that is not running looks exactly like an employee
    who is not working.

    schtasks rather than a Run-key entry: the Run key is a single string any
    installer can overwrite, a user can switch it off from Task Manager without
    knowing what it was, and it offers no restart-on-failure.
    """
    if sys.platform != "win32" or not getattr(sys, "frozen", False):
        return False

    tracker = Path(sys.executable).with_name("sentinel-agent.exe")
    if not tracker.exists():
        log.warning("tracker not found beside %s; autostart not registered", sys.executable)
        return False

    try:
        result = subprocess.run(  # noqa: S603
            [
                "schtasks", "/Create",
                "/TN", "MyDeskTime Agent",
                "/SC", "ONLOGON",
                "/TR", f'"{tracker}"',
                "/RL", "LIMITED",
                "/F",  # replace an existing task rather than failing
            ],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0:
            log.info("autostart registered as a scheduled task")
            return True
        # Expected on most machines: an ONLOGON task is written to the
        # machine-wide store and Windows refuses that without elevation.
        # Employees are rarely local administrators, so this is the normal
        # path, not the exceptional one.
        log.info(
            "scheduled task refused (%s); using the per-user run key instead",
            (result.stderr or result.stdout).strip()[:120],
        )
    except (OSError, subprocess.SubprocessError):
        log.exception("schtasks failed; using the per-user run key instead")

    return _register_run_key(tracker)


def _register_run_key(tracker: Path) -> bool:
    """Per-user autostart that needs no administrator rights.

    HKEY_CURRENT_USER, so it is this employee's own setting and Windows asks
    nobody's permission. Chosen over a Startup-folder shortcut because a .lnk
    needs COM to create, and a .cmd there flashes a console window at every
    single sign-in.

    Weaker than a scheduled task: no restart-if-it-dies, and it appears in Task
    Manager's Startup tab where it can be switched off. But autostart that
    works beats autostart that was refused, and the refusal was silent enough
    that a machine could record nothing for weeks before anyone asked why.
    """
    try:
        import winreg  # noqa: PLC0415 - Windows only

        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            0,
            winreg.KEY_SET_VALUE,
        ) as key:
            winreg.SetValueEx(key, "MyDeskTime", 0, winreg.REG_SZ, f'"{tracker}"')
        log.info("autostart registered in the per-user run key")
        return True
    except OSError:
        log.exception("could not register autostart by any method")
        return False


def do_interactive_setup(config: AgentConfig) -> int:
    """Walk somebody through enrolling, for a launch with no arguments.

    The alternative was printing a usage line and exiting, which on a windowed
    build meant printing nothing at all. This is what an employee handed a
    binary and an enrolment key actually needs.
    """
    print("=" * 66)
    print("  MyDeskTime setup")
    print("=" * 66)
    print()
    print("This machine is not yet linked to anyone. Your administrator will")
    print("have given you an enrolment key.")
    print()

    # The server is already filled in for this deployment, so the usual answer
    # is simply Enter. It stays editable because the same build gets pointed at
    # a staging server often enough to be worth one keystroke.
    default = config.server_url or ""
    prompt = (f"Server address (press Enter for {default}): " if default
              else "Server address: ")
    server = input(prompt).strip() or default
    if not server:
        print("\nA server address is required. Nothing has been changed.")
        _pause()
        return 2
    config.server_url = server.rstrip("/")
    config.save()

    print()
    print("  1. I have an enrolment key")
    print("  2. Sign in with my work email and password")
    choice = input("\nChoose 1 or 2 [1]: ").strip() or "1"
    print()

    if choice == "2":
        result = do_login(config, None, None, accept=False)
    else:
        key = input("Enrolment key: ").strip()
        if not key:
            print("\nNo key entered. Nothing has been changed.")
            _pause()
            return 2
        result = do_enroll(config, key, accept=False)

    if result == 0:
        print()
        if _register_autostart():
            # Started now, not at the next sign-in. Telling somebody their
            # machine will begin recording tomorrow invites them to wonder
            # whether it worked at all, and leaves a day of nothing in the
            # console that looks like a fault.
            started = _start_tracker()
            print("Setup complete. MyDeskTime is running now" if started
                  else "Setup complete.")
            print("and starts automatically each time you sign in." if started
                  else "It starts automatically the next time you sign in.")
            print("Look for its icon near the clock.")
        else:
            # Say what is actually true. Claiming autostart that was never
            # registered is how a machine ends up reporting nothing for a week.
            print("Enrolled, but this machine could not be set to start")
            print("MyDeskTime automatically. Tell your administrator, and start")
            print("it by hand with sentinel-agent.exe until that is fixed.")
    _pause()
    return result


def _pause() -> None:
    """Hold the console open so the result can be read.

    Without this the window a double-click opened closes the instant the
    program ends, taking the success or the error with it.
    """
    try:
        input("\nPress Enter to close this window.")
    except (EOFError, OSError):
        pass


def do_status(config: AgentConfig) -> int:
    spool = Spool(SPOOL_PATH)
    segments, shots = spool.counts()
    spool.close()

    print(f"Agent      : {__version__} on {platform_name()}")
    print(f"Server     : {config.server_url}")
    print(f"Workspace  : {config.org_slug or '(not set)'}")
    print(f"Enrolled   : {'yes' if config.enrolled else 'no'}")
    if config.enrolled:
        print(f"Employee   : {config.user_name} ({config.user_email or 'no email'})")
        print(f"Company    : {config.org_name}")
        print(f"Device id  : {config.device_id}")
    print(f"Machine id : {config.machine_id}")
    print(f"Queued     : {segments} segments, {shots} screenshots")
    # The question an admin actually opens --status to answer, when the
    # dashboard shows a machine online and no screenshots from it.
    if config.policy.screenshot_enabled:
        blocked = capture_blocker()
        print(f"Screenshots: {'BLOCKED - ' + blocked if blocked else 'working'}")
    else:
        print("Screenshots: off by policy")
    print(f"Log file   : {LOG_PATH}")
    print("\nPolicy")
    for key, value in vars(config.policy).items():
        if key == "notice_text":
            value = (str(value)[:60] + "...") if value else ""
        print(f"  {key:<26} {value}")
    return 0


def _can_prompt() -> bool:
    """True when a keystroke typed now would actually reach this process.

    Only a frozen Windows build can fail this. The tracker is packaged with
    console=False so nothing flashes on the desktop at every sign-in, and
    Windows then attaches no console. getpass does not degrade to sys.stdin
    there — win_getpass opens CONIN$ directly — so it blocks forever on a
    handle no keystroke can ever reach. A double-clicked enrolment hangs
    invisibly: no prompt, no error, no exit. Measured, not assumed.

    GetConsoleMode on the standard input handle is the question that matters,
    and the only one that survives every launcher: it succeeds exactly when
    that handle is a console Windows will deliver keys to. GetConsoleWindow
    looks like the obvious check and is wrong — it returns NULL under a
    pseudoconsole, so it fails every Git Bash, Windows Terminal and CI shell,
    which is a far more common way to run this than Explorer is.
    """
    if not getattr(sys, "frozen", False) or sys.platform != "win32":
        return True
    import ctypes  # noqa: PLC0415 - Windows-only, imported where it is used

    handle = ctypes.windll.kernel32.GetStdHandle(-10)  # STD_INPUT_HANDLE
    if not handle or handle == ctypes.c_void_p(-1).value:
        return False
    mode = ctypes.c_uint()
    return bool(ctypes.windll.kernel32.GetConsoleMode(handle, ctypes.byref(mode)))


def _tell(message: str, title: str = "MyDeskTime") -> None:
    """Say something to whoever launched this, through whatever channel exists.

    stderr when there is one — CI, a redirected shell, an MDM push all have one
    and nobody there to click OK. A message box only when there is no other
    channel at all, which is the double-clicked-from-Explorer case.
    """
    try:
        if sys.stderr is not None:
            print(message, file=sys.stderr)
            return
    except (OSError, ValueError):
        pass

    if sys.platform == "win32":
        import ctypes  # noqa: PLC0415

        ctypes.windll.user32.MessageBoxW(None, message, title, 0x40)


def _open_setup_console() -> bool:
    """Relaunch the setup twin in its own console window.

    The tracker is windowed and cannot prompt. Rather than telling somebody to
    open a command prompt and type a path — which is a hostile instruction for
    the employee this is aimed at — start the console build for them, so a
    double-click produces the window they expected.
    """
    if sys.platform != "win32" or not getattr(sys, "frozen", False):
        return False

    setup = Path(sys.executable).with_name("MyDeskTime-Setup.exe")
    if not setup.exists():
        return False

    CREATE_NEW_CONSOLE = 0x00000010
    try:
        subprocess.Popen([str(setup)], creationflags=CREATE_NEW_CONSOLE)  # noqa: S603
        return True
    except OSError:
        log.exception("could not start %s", setup)
        return False


def _console_required() -> int:
    """Explain, in whichever channel this process actually has, what to do.

    Two different people hit this. Someone who double-clicked the tracker needs
    sending to the setup binary. Someone already *in* the setup binary, in a
    terminal Windows does not consider a console — MSYS, Git Bash, MinTTY, all
    of which emulate a tty with pipes — needs sending to cmd.exe instead.
    Telling the second group to run the program they are already running is the
    kind of advice that gets a support ticket.
    """
    log.error("interactive command needs a console; none attached")

    in_setup = os.path.basename(sys.executable).lower().startswith("mydesktime-setup")
    if in_setup:
        message = (
            "This terminal cannot accept a hidden password.\n\n"
            "Windows only delivers keystrokes to a real console, and MSYS, Git "
            "Bash and MinTTY emulate one with pipes.\n\n"
            "Run the same command from cmd.exe or PowerShell instead."
        )
    else:
        message = (
            "MyDeskTime has to be set up once from a command prompt.\n\n"
            "Open the folder this program is in and run:\n\n"
            "    MyDeskTime-Setup.exe --login you@company.com --org <workspace>\n\n"
            "After that this program starts by itself at every sign-in and "
            "needs no further attention."
        )

    _tell(message, "MyDeskTime \u2014 setup needed")
    return 2


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="sentinel-agent", description="MyDeskTime desktop agent"
    )
    parser.add_argument("--server", help="API base URL, e.g. https://mydesktime.example.com")
    parser.add_argument("--login", nargs="?", const="", metavar="EMAIL",
                        help="sign in with your work email and password")
    parser.add_argument("--org", metavar="SLUG", help="workspace name, e.g. acme")
    parser.add_argument("--enroll", metavar="KEY", help="bind this machine with an enrollment key")
    parser.add_argument("--accept-notice", action="store_true",
                        help="accept the monitoring notice non-interactively")
    parser.add_argument("--status", action="store_true", help="print state and exit")
    parser.add_argument("--selftest", action="store_true",
                        help="report which tracking capabilities work here, then exit")
    parser.add_argument("--once", action="store_true",
                        help="take one sample, sync, and exit (smoke test)")
    parser.add_argument("--interval", type=float, help="override the sample interval in seconds")
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args(argv)

    setup_logging(args.log_level)
    config = AgentConfig.load()

    if args.server:
        config.server_url = args.server.rstrip("/")
        config.save()
    if args.interval:
        config.sample_interval_s = max(0.2, args.interval)

    if args.org:
        config.org_slug = args.org.strip().lower()
        config.save()

    if args.selftest:
        # Reachable from the packaged build on purpose. The macOS and Linux
        # trackers depend on permissions that are granted per machine, so
        # "does this work here" is a question an admin has to answer on the
        # laptop in front of them — with the bundle they were shipped, not a
        # checkout they do not have.
        from agent import selftest  # noqa: PLC0415 - only needed for this one flag

        return selftest.main()

    if args.status:
        return do_status(config)
    if args.login is not None or args.enroll:
        # Only these two prompt — for a password, a workspace, or consent to
        # the monitoring notice. --status and --selftest merely print, and
        # printing into a pipe is a perfectly ordinary thing to ask for, so
        # they are deliberately not gated here.
        if not _can_prompt():
            return _console_required()
        result = (
            do_login(config, args.login or None, args.org, args.accept_notice)
            if args.login is not None
            else do_enroll(config, args.enroll, args.accept_notice)
        )
        # Any successful enrolment sets up autostart, not just the interactive
        # one. A machine bound with --enroll from a script previously came up
        # tracking nothing until somebody launched the tracker by hand, and the
        # only sign was an absence of data.
        if result == 0 and not _register_autostart():
            print("\nNote: could not set MyDeskTime to start automatically.")
            print("Start it with sentinel-agent.exe until an administrator fixes that.")
        return result

    if not config.enrolled:
        # A launch with no arguments on an unenrolled machine is somebody who
        # just opened the program. Walk them through it where we can.
        if _can_prompt():
            return do_interactive_setup(config)

        # No console: this is the windowed tracker, double-clicked. Open the
        # console twin so they get the prompt they were expecting, and only
        # explain in a dialog if even that is unavailable.
        if _open_setup_console():
            return 0

        _tell(
            "MyDeskTime is not set up on this machine yet.\n\n"
            "Open the folder this program is in and run MyDeskTime-Setup.exe, "
            "which will ask for your server address and enrolment key.",
            "MyDeskTime \u2014 setup needed",
        )
        return 1

    # Only the tracking loop takes the lock. --status, --selftest and the
    # enrolment commands are short-lived and read-only, and blocking them while
    # the agent runs would make the agent impossible to inspect.
    lock = SingleInstance(SPOOL_PATH.parent)
    try:
        lock.acquire()
    except AlreadyRunning:
        # Not an error worth shouting about — the usual cause is the autostart
        # entry firing while somebody also double-clicked the icon. Exiting
        # quietly is the correct behaviour; what must not happen is two
        # trackers both recording the same hours.
        log.info("another MyDeskTime agent is already running on this machine; exiting")
        print("MyDeskTime is already running.")
        return 0

    agent = Agent(config)
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, agent.request_stop)
        except (ValueError, OSError):
            pass  # not the main thread, or unsupported on this platform

    if args.once:
        agent.tick(config.sample_interval_s)
        sample = agent._last_sample
        if sample is not None:
            print(f"sample: app={sample.app_name!r} exec={sample.app_exec!r} "
                  f"title={sample.window_title[:60]!r} url={sample.url_domain} "
                  f"idle={sample.idle_s}s locked={sample.locked}")
        agent.shutdown(datetime.now(timezone.utc))
        return 0

    return agent.run()


if __name__ == "__main__":
    raise SystemExit(main())
