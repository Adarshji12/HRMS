"""Agent-local state: server URL, device credentials and the cached policy.

Two things live here that must survive a reboot — the device token and the
machine id. Everything else (intervals, thresholds) is server-owned and merely
cached so the agent keeps behaving sensibly while offline.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import socket
import sys
import uuid
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path

APP_DIR_NAME = "Sentinel"


def data_dir() -> Path:
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    path = base / APP_DIR_NAME
    path.mkdir(parents=True, exist_ok=True)
    return path


CONFIG_PATH = data_dir() / "agent.json"
#: The server this build ships pointing at. Change it here (or override with
#: MYDESKTIME_SERVER) when packaging for a different deployment.
DEFAULT_SERVER = os.environ.get("MYDESKTIME_SERVER", "http://103.59.180.126:4200")

SPOOL_PATH = data_dir() / "spool.db"
LOG_PATH = data_dir() / "agent.log"


@dataclass
class Policy:
    """Mirror of the server's OrgSettings. Defaults are conservative: if the
    agent has never reached the server, it collects little and screenshots
    nothing."""

    screenshot_enabled: bool = False
    screenshot_interval_s: int = 600
    screenshot_randomize: bool = True
    screenshot_quality: int = 60
    screenshot_max_width: int = 1600
    capture_all_monitors: bool = True
    idle_threshold_s: int = 180
    track_urls: bool = True
    track_window_titles: bool = True
    min_segment_s: int = 3
    sync_interval_s: int = 60
    notice_required: bool = True
    notice_text: str = ""
    work_day_start: str = "09:00"
    work_day_end: str = "18:00"
    track_outside_hours: bool = True

    @classmethod
    def from_server(cls, payload: dict) -> "Policy":
        known = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in payload.items() if k in known})


@dataclass
class AgentConfig:
    #: Where a fresh install points before anyone has been asked.
    #:
    #: Set to the deployment an employee is actually joining, so the setup
    #: prompt offers the right answer and they only have to press Enter. Typing
    #: a URL from a printout is the step people get wrong, and a wrong server
    #: fails in a way that looks like a broken program rather than a typo.
    server_url: str = DEFAULT_SERVER
    device_id: str | None = None
    # The machine's credential. Note there is deliberately no password field:
    # the employee's password is used once at sign-in and never persisted, so a
    # stolen laptop yields a revocable device token and nothing else.
    device_token: str | None = None
    machine_id: str = ""
    user_name: str = ""
    user_email: str = ""
    org_name: str = ""
    # Tenant slug. Sent on every request so the agent works whether or not the
    # server URL carries the subdomain.
    org_slug: str = ""
    notice_accepted: bool = False
    policy: Policy = field(default_factory=Policy)

    # Local-only knobs, not server-controlled.
    sample_interval_s: float = 1.0
    segment_max_s: int = 900
    verify_tls: bool = True
    # Where to look for git working copies when attributing developer time.
    # Empty means "use the built-in defaults" — see gitcontext.default_roots().
    repo_search_roots: list[str] = field(default_factory=list)

    @property
    def enrolled(self) -> bool:
        return bool(self.device_token and self.device_id)

    def save(self, path: Path = CONFIG_PATH) -> None:
        payload = asdict(self)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        tmp.replace(path)  # atomic: a crash mid-write must not lose the token
        if sys.platform != "win32":
            path.chmod(0o600)

    @classmethod
    def load(cls, path: Path = CONFIG_PATH) -> "AgentConfig":
        if not path.exists():
            cfg = cls(machine_id=stable_machine_id())
            cfg.save(path)
            return cfg
        # utf-8-sig, not utf-8: Windows tooling (PowerShell, Notepad, several MDM
        # agents) writes JSON with a BOM, and a plain utf-8 read would make the
        # agent unrunnable after an admin edits its config by hand.
        raw = json.loads(path.read_text(encoding="utf-8-sig"))
        policy = Policy.from_server(raw.pop("policy", {}) or {})
        known = {f.name for f in fields(cls)} - {"policy"}
        cfg = cls(policy=policy, **{k: v for k, v in raw.items() if k in known})
        if not cfg.machine_id:
            cfg.machine_id = stable_machine_id()
            cfg.save(path)
        return cfg


def _windows_machine_guid() -> str | None:
    try:
        import winreg

        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE,
            r"SOFTWARE\Microsoft\Cryptography",
            0,
            winreg.KEY_READ | winreg.KEY_WOW64_64KEY,
        ) as key:
            value, _ = winreg.QueryValueEx(key, "MachineGuid")
            return str(value)
    except OSError:
        return None


def stable_machine_id() -> str:
    """Identifier that survives reinstalls of the agent but differs per machine.

    Hashed rather than raw so the server never stores a directly-identifying
    hardware id.
    """
    parts = [platform.node() or socket.gethostname(), sys.platform]
    if sys.platform == "win32":
        parts.append(_windows_machine_guid() or "")
    elif sys.platform == "linux":
        for candidate in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
            try:
                parts.append(Path(candidate).read_text(encoding="utf-8").strip())
                break
            except OSError:
                continue
    if not any(parts[2:]):
        parts.append(f"{uuid.getnode():012x}")
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:32]
