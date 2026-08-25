"""The runner for the two periodic jobs.

    python -m app.scheduler              # run forever
    python -m app.scheduler --once       # run anything due now, then exit

Both jobs already existed and neither had a caller. Alerts therefore never
fired, and retention never deleted anything — while the console told
administrators screenshots were kept for N days and the employee notice told
staff the same. An unenforced retention window is a promise being broken, so
this is a correctness fix rather than a convenience.

A loop in a container rather than cron, because the deployment unit is already
a container: cron inside one needs a second process manager, and cron outside
one needs a host with the application installed. Either way the schedule lives
somewhere the application does not, and drifts.

Not APScheduler or Celery: two jobs on fixed intervals do not justify a broker.
When there is a third job that needs retries or fan-out, that is the moment to
reach for one — not before.
"""

from __future__ import annotations

import argparse
import logging
import signal
import sys
import time
from dataclasses import dataclass, field
from typing import Callable

log = logging.getLogger("sentinel.scheduler")


@dataclass
class Job:
    name: str
    every_seconds: int
    run: Callable[[], object]
    #: Seconds after start before the first run. Staggered so the two jobs do
    #: not contend for the same connections on a cold start.
    delay: int = 0
    _next: float = field(default=0.0, init=False)

    def due(self, now: float) -> bool:
        return now >= self._next

    def schedule(self, now: float, first: bool = False) -> None:
        self._next = now + (self.delay if first else self.every_seconds)


def _run_alerts() -> object:
    from app.alerts import run  # imported lazily so --help needs no database

    return run()


def _run_retention() -> object:
    from app.services.retention import purge_all

    return purge_all()


def _run_attendance_status() -> object:
    from app.services.attendance import stamp_statuses_for_local_hour

    return stamp_statuses_for_local_hour()


def _run_leave_accrual() -> object:
    from app.services.leave import accrue_monthly

    return accrue_monthly()


def _run_comp_off_expiry() -> object:
    from app.services.leave import expire_comp_offs

    return expire_comp_offs()


def build_jobs() -> list[Job]:
    return [
        # Fifteen minutes: the agent-silence rule fires after 30, so a longer
        # period would mean an alert arriving an hour after the machine went
        # quiet, by which time the person has usually noticed themselves.
        Job("alerts", every_seconds=15 * 60, run=_run_alerts, delay=30),
        # Hourly rather than nightly. A nightly job means a retention window
        # is honoured to within a day, and it also means one enormous delete
        # after a busy period instead of a steady trickle.
        Job("retention", every_seconds=60 * 60, run=_run_retention, delay=120),

        # --- HRMS ------------------------------------------------------------
        # Hourly, not nightly, and that is the whole design (D-003). The job
        # finalises the *previous local day* for the organisations whose local
        # clock has just passed the target hour, so a company in IST has its day
        # closed after that day actually ended for them. A single fixed-UTC run
        # would stamp "absent" for an IST tenant at 05:30 local — half an hour
        # before the person it just marked absent walks in.
        Job("attendance_status", every_seconds=60 * 60, run=_run_attendance_status, delay=180),

        # Daily rather than monthly even though the policy is monthly. The job
        # credits a cumulative target, so running it more often than needed is a
        # no-op and a missed month is caught up rather than lost. A job that is
        # only correct if it fires exactly twelve times a year is a job that
        # silently shortchanges people the first time a deploy overlaps the 1st.
        Job("leave_accrual", every_seconds=24 * 60 * 60, run=_run_leave_accrual, delay=240),

        Job("comp_off_expiry", every_seconds=24 * 60 * 60, run=_run_comp_off_expiry, delay=300),
    ]


class Runner:
    def __init__(self, jobs: list[Job]) -> None:
        self.jobs = jobs
        self._stop = False

    def request_stop(self, *_: object) -> None:
        # Containers are stopped with SIGTERM. Without this the process is
        # killed mid-delete after the grace period, which for the retention
        # job means a half-finished purge.
        log.info("stop requested; finishing the current job")
        self._stop = True

    def tick(self, now: float) -> None:
        for job in self.jobs:
            if not job.due(now):
                continue
            started = time.monotonic()
            try:
                result = job.run()
                log.info("%s finished in %.1fs: %s", job.name, time.monotonic() - started, result)
            except Exception:
                # One failing job must never stop the other, and must never
                # stop the loop: a mail server outage should not also mean
                # retention silently stops being enforced.
                log.exception("%s failed after %.1fs", job.name, time.monotonic() - started)
            finally:
                job.schedule(time.monotonic())

    def serve(self) -> int:
        now = time.monotonic()
        for job in self.jobs:
            job.schedule(now, first=True)
            log.info("scheduled %s every %ds (first run in %ds)",
                     job.name, job.every_seconds, job.delay)
        while not self._stop:
            self.tick(time.monotonic())
            # One second of granularity is plenty for jobs measured in minutes,
            # and it keeps shutdown responsive.
            time.sleep(1)
        return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="app.scheduler", description=__doc__)
    parser.add_argument("--once", action="store_true",
                        help="run every job once and exit, for cron or a manual check")
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=args.log_level.upper(),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )

    runner = Runner(build_jobs())

    if args.once:
        # Force every job due. schedule() sets the *next* run, so calling it
        # here would push each job into the future and --once would do nothing
        # at all — silently, which is the worst way for a cron entry to fail.
        for job in runner.jobs:
            job._next = 0.0
        runner.tick(time.monotonic())
        return 0

    signal.signal(signal.SIGTERM, runner.request_stop)
    signal.signal(signal.SIGINT, runner.request_stop)
    log.info("scheduler started")
    return runner.serve()


if __name__ == "__main__":
    sys.exit(main())
