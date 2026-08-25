"""One agent per machine, enforced.

Nothing previously stopped a second copy from starting, and two trackers on one
desktop both sample the same foreground window every second. The segments do
not collide — each carries its own client_uid, so the idempotent ingest accepts
every one — they simply overlap, and the server sums durations. Two instances
therefore report roughly double the hours actually worked.

That is the worst shape a bug can take in this product: the number it exists to
produce is wrong, in the employer's favour, with nothing anywhere reporting an
error. Observed on a real machine at ten concurrent instances after repeated
manual launches, turning 5 hours of work into 36.

It happens without anyone doing anything strange: the autostart entry fires at
login while the employee also double-clicks the icon, or an installer re-runs
while the agent is live.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

log = logging.getLogger(__name__)


class AlreadyRunning(RuntimeError):
    """Another agent already holds the lock on this machine."""


class SingleInstance:
    """Hold an exclusive, OS-level lock for the lifetime of the process.

    Deliberately not a pidfile containing a number: a stale pid after a crash
    or a power cut blocks every future start, and the usual fix — checking
    whether that pid is alive — races and can match an unrelated process that
    has since been given the same id. Both mechanisms below are released by the
    kernel when the process dies, however it dies.
    """

    def __init__(self, state_dir: Path, name: str = "mydesktime-agent") -> None:
        self.name = name
        self.path = state_dir / f"{name}.lock"
        self._handle = None
        self._file = None

    def acquire(self) -> None:
        """Raise AlreadyRunning if another instance holds the lock."""
        if sys.platform == "win32":
            self._acquire_windows()
        else:
            self._acquire_posix()
        log.debug("instance lock held (%s)", self.path)

    def _acquire_windows(self) -> None:
        import ctypes  # noqa: PLC0415 - Windows only
        from ctypes import wintypes  # noqa: PLC0415

        ERROR_ALREADY_EXISTS = 183
        kernel32 = ctypes.windll.kernel32
        kernel32.CreateMutexW.restype = wintypes.HANDLE

        # "Local\" rather than "Global\": the agent runs per user, and two
        # people signed in to the same machine each need their own tracker.
        # A global mutex would let the first person to log in silently stop
        # the second from being monitored at all.
        self._handle = kernel32.CreateMutexW(None, False, f"Local\\{self.name}")
        if not self._handle:
            # Never fail closed on an unexpected API error: refusing to track
            # is worse than the risk of a duplicate.
            log.warning("could not create the instance mutex; continuing")
            return
        if kernel32.GetLastError() == ERROR_ALREADY_EXISTS:
            raise AlreadyRunning

    def _acquire_posix(self) -> None:
        import fcntl  # noqa: PLC0415 - POSIX only

        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Kept open for the process lifetime; the lock dies with the fd.
        self._file = self.path.open("w")
        try:
            fcntl.flock(self._file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            self._file.close()
            self._file = None
            raise AlreadyRunning from exc
        self._file.write(str(_pid()))
        self._file.flush()

    def release(self) -> None:
        if self._handle is not None:
            import ctypes  # noqa: PLC0415

            ctypes.windll.kernel32.ReleaseMutex(self._handle)
            ctypes.windll.kernel32.CloseHandle(self._handle)
            self._handle = None
        if self._file is not None:
            self._file.close()
            self._file = None

    def __enter__(self) -> "SingleInstance":
        self.acquire()
        return self

    def __exit__(self, *_: object) -> None:
        self.release()


def _pid() -> int:
    import os  # noqa: PLC0415

    return os.getpid()
