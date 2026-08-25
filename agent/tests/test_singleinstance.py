"""One agent per machine.

Two trackers on one desktop both sample the same foreground window every
second. The segments never collide — each carries its own client_uid, so the
idempotent ingest accepts all of them — they just overlap, and the server sums
durations. Observed on a real machine: ten concurrent instances turned five
hours of work into thirty-six.
"""

from __future__ import annotations

import pytest

from agent.singleinstance import AlreadyRunning, SingleInstance


def test_a_second_instance_is_refused(tmp_path):
    first = SingleInstance(tmp_path, name="mydesktime-test-a")
    first.acquire()
    try:
        with pytest.raises(AlreadyRunning):
            SingleInstance(tmp_path, name="mydesktime-test-a").acquire()
    finally:
        first.release()


def test_the_lock_is_released_on_exit(tmp_path):
    """Otherwise one crash blocks every future start until a reboot."""
    with SingleInstance(tmp_path, name="mydesktime-test-b"):
        pass
    # Must not raise.
    second = SingleInstance(tmp_path, name="mydesktime-test-b")
    second.acquire()
    second.release()


def test_different_names_do_not_collide(tmp_path):
    """The lock is per application, not per directory."""
    a = SingleInstance(tmp_path, name="mydesktime-test-c")
    b = SingleInstance(tmp_path, name="mydesktime-test-d")
    a.acquire()
    try:
        b.acquire()
        b.release()
    finally:
        a.release()


def test_release_is_safe_to_call_twice(tmp_path):
    lock = SingleInstance(tmp_path, name="mydesktime-test-e")
    lock.acquire()
    lock.release()
    lock.release()
