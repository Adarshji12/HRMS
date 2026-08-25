"""The scheduler that alerts and retention had been missing.

Retention deletes employee data on a promise the console makes to
administrators and the notice makes to staff. A scheduler that silently stops
running, or silently runs nothing, breaks that promise quietly — so the
failure modes are tested, not just the happy path.
"""

from __future__ import annotations

import time

from app.scheduler import Job, Runner, build_jobs, main


def test_jobs_are_not_due_before_their_first_delay():
    job = Job("x", every_seconds=60, run=lambda: None, delay=30)
    now = time.monotonic()
    job.schedule(now, first=True)
    assert not job.due(now)
    assert job.due(now + 31)


def test_a_job_reschedules_itself_after_running():
    calls = []
    job = Job("x", every_seconds=60, run=lambda: calls.append(1))
    runner = Runner([job])
    runner.tick(time.monotonic())
    runner.tick(time.monotonic())  # immediately again — must not run twice
    assert len(calls) == 1


def test_one_failing_job_does_not_stop_the_other():
    """A mail outage must not also mean data stops being deleted."""
    def boom():
        raise RuntimeError("smtp is down")

    ran = []
    runner = Runner([
        Job("alerts", every_seconds=60, run=boom),
        Job("retention", every_seconds=60, run=lambda: ran.append(1)),
    ])
    runner.tick(time.monotonic())
    assert ran == [1]


def test_a_failing_job_is_retried_on_its_next_tick():
    """It must not be dropped from the schedule after one failure."""
    attempts = []

    def flaky():
        attempts.append(1)
        raise RuntimeError("still down")

    job = Job("alerts", every_seconds=0, run=flaky)
    runner = Runner([job])
    runner.tick(time.monotonic())
    runner.tick(time.monotonic())
    assert len(attempts) == 2


def test_stop_is_honoured():
    runner = Runner([])
    runner.request_stop()
    assert runner.serve() == 0


def test_once_actually_runs_every_job():
    """--once used to schedule each job into the future and then exit having
    done nothing, which is the worst way for a cron entry to fail: silently."""
    ran = []
    runner = Runner([
        Job("a", every_seconds=900, run=lambda: ran.append("a"), delay=30),
        Job("b", every_seconds=3600, run=lambda: ran.append("b"), delay=120),
    ])
    for job in runner.jobs:
        job._next = 0.0
    runner.tick(time.monotonic())
    assert sorted(ran) == ["a", "b"]


def test_the_real_jobs_are_wired_up():
    # Exact equality, not a subset check, and deliberately so: this test exists
    # because the two original jobs were both fully written and neither had a
    # runner, so alerts never fired and retention never deleted anything. A
    # subset assertion would let the next job repeat that exact history.
    #
    # The cost is that adding a job means editing this line, which is the point.
    names = {j.name for j in build_jobs()}
    assert names == {
        "alerts",
        "retention",
        # HRMS. attendance_status is hourly rather than nightly because it acts
        # on org-local time (D-003); the other two are daily.
        "attendance_status",
        "leave_accrual",
        "comp_off_expiry",
    }


def test_once_exits_zero_against_a_real_database(capsys):
    assert main(["--once"]) == 0
