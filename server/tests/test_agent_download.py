"""The console's agent download.

The interesting cases are all about what the directory contains: a build that is
not there yet, files that are not deliverables, and a name supplied by a client
that must never become a path.
"""

from __future__ import annotations

import hashlib
import zipfile

import pytest

from app.core.config import settings
from app.services import agentdist


@pytest.fixture
def dist_dir(tmp_path, monkeypatch):
    """Point the setting at a scratch directory, and clear the digest cache.

    The cache is keyed on path, mtime and size — a fresh tmp_path per test would
    normally be enough, but clearing it keeps the tests independent of that
    happening to be true.
    """
    monkeypatch.setattr(settings, "agent_dist_dir", tmp_path)
    agentdist._digests.clear()
    return tmp_path


def make_bundle(directory, name: str, payload: bytes = b"agent-bytes") -> bytes:
    path = directory / name
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("MyDeskTime-Setup.exe", payload)
    return path.read_bytes()


def test_no_build_yet_is_an_empty_list_not_an_error(client, tenants, dist_dir):
    """A deployment with no agent copied in is a normal state, not a 500."""
    response = client.get("/api/v1/admin/agent/bundles", headers=tenants[0].headers())
    assert response.status_code == 200
    assert response.json()["bundles"] == []


def test_a_missing_directory_is_also_survivable(client, tenants, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "agent_dist_dir", tmp_path / "does-not-exist")
    response = client.get("/api/v1/admin/agent/bundles", headers=tenants[0].headers())
    assert response.status_code == 200
    assert response.json()["bundles"] == []


def test_bundles_are_listed_with_a_checksum(client, tenants, dist_dir):
    raw = make_bundle(dist_dir, "MyDeskTime-Agent-Windows.zip")

    response = client.get("/api/v1/admin/agent/bundles", headers=tenants[0].headers())
    assert response.status_code == 200
    bundles = response.json()["bundles"]
    assert len(bundles) == 1

    bundle = bundles[0]
    assert bundle["name"] == "MyDeskTime-Agent-Windows.zip"
    assert bundle["platform"] == "Windows"
    assert bundle["size"] == len(raw)
    # The hash has to be of the bytes actually served, or it assures nothing.
    assert bundle["sha256"] == hashlib.sha256(raw).hexdigest()


def test_platform_is_read_from_the_name(client, tenants, dist_dir):
    make_bundle(dist_dir, "mydesktime-agent-windows-amd64.zip")
    make_bundle(dist_dir, "mydesktime-agent-macos-arm64.zip")
    make_bundle(dist_dir, "mydesktime-agent-linux-amd64.zip")

    response = client.get("/api/v1/admin/agent/bundles", headers=tenants[0].headers())
    platforms = {b["platform"] for b in response.json()["bundles"]}
    assert platforms == {"Windows", "macOS", "Linux"}


def test_files_that_name_no_platform_are_reported_not_offered(client, tenants, dist_dir):
    """A build directory accumulates junk; the console must not offer it."""
    make_bundle(dist_dir, "MyDeskTime-Agent-Windows.zip")
    make_bundle(dist_dir, "test.zip")
    make_bundle(dist_dir, "sentinel-agent.zip")

    body = client.get("/api/v1/admin/agent/bundles", headers=tenants[0].headers()).json()
    assert [b["name"] for b in body["bundles"]] == ["MyDeskTime-Agent-Windows.zip"]
    # Not silently: somebody who copied a build in and cannot see it is told why.
    assert body["ignored"] == ["sentinel-agent.zip", "test.zip"]


def test_non_archives_are_ignored_entirely(client, tenants, dist_dir):
    (dist_dir / "windows-notes.txt").write_text("not a deliverable")
    (dist_dir / "build-windows.log").write_text("nor this")

    body = client.get("/api/v1/admin/agent/bundles", headers=tenants[0].headers()).json()
    assert body["bundles"] == []
    assert body["ignored"] == []


def test_download_serves_the_bytes(client, tenants, dist_dir):
    raw = make_bundle(dist_dir, "MyDeskTime-Agent-Windows.zip")

    response = client.get(
        "/api/v1/admin/agent/bundles/MyDeskTime-Agent-Windows.zip/download",
        headers=tenants[0].headers(),
    )
    assert response.status_code == 200
    assert response.content == raw
    assert "attachment" in response.headers["content-disposition"]


def test_download_of_a_missing_build_is_a_404(client, tenants, dist_dir):
    response = client.get(
        "/api/v1/admin/agent/bundles/MyDeskTime-Agent-Windows.zip/download",
        headers=tenants[0].headers(),
    )
    assert response.status_code == 404
    assert response.json()["detail"]["reason"] == "bundle_missing"


@pytest.mark.parametrize(
    "attempt",
    [
        "../../.env",
        "..%2f..%2f.env",
        "....//....//.env",
        "%2e%2e%2f.env",
    ],
)
def test_a_name_is_never_treated_as_a_path(client, tenants, dist_dir, attempt):
    """The download resolves against the listing, so traversal has nothing to hit."""
    make_bundle(dist_dir, "MyDeskTime-Agent-Windows.zip")
    (dist_dir.parent / ".env").write_text("SECRET_KEY=should-never-be-served")

    response = client.get(
        f"/api/v1/admin/agent/bundles/{attempt}/download",
        headers=tenants[0].headers(),
    )
    assert response.status_code in (404, 400, 405)
    assert b"should-never-be-served" not in response.content


def test_a_file_the_listing_skipped_cannot_be_downloaded(client, tenants, dist_dir):
    """Not offered means not reachable, not merely hidden from the list."""
    make_bundle(dist_dir, "test.zip")
    response = client.get(
        "/api/v1/admin/agent/bundles/test.zip/download", headers=tenants[0].headers()
    )
    assert response.status_code == 404


def test_the_download_needs_a_session(client, tenants, dist_dir):
    """The tenant is resolvable; what is missing is the credential."""
    acme, _ = tenants
    make_bundle(dist_dir, "MyDeskTime-Agent-Windows.zip")
    response = client.get(
        "/api/v1/admin/agent/bundles/MyDeskTime-Agent-Windows.zip/download",
        headers={"X-Org-Slug": acme.slug},
    )
    assert response.status_code == 401


def test_an_employee_may_fetch_their_own_installer(client, tenants, dist_dir):
    """Deliberate: the bundle holds no secret, and a replacement laptop should
    not need an administrator to re-send the software."""
    acme, _ = tenants
    make_bundle(dist_dir, "MyDeskTime-Agent-Windows.zip")
    response = client.get(
        "/api/v1/admin/agent/bundles", headers=acme.headers(acme.employee_token)
    )
    assert response.status_code == 200
    assert len(response.json()["bundles"]) == 1


def test_the_digest_is_recomputed_when_the_build_changes(dist_dir):
    """A rebuild at the same path must not be served the old hash."""
    first = make_bundle(dist_dir, "MyDeskTime-Agent-Windows.zip", b"build-one")
    before = agentdist.list_bundles()[0].sha256
    assert before == hashlib.sha256(first).hexdigest()

    path = dist_dir / "MyDeskTime-Agent-Windows.zip"
    path.unlink()
    second = make_bundle(dist_dir, "MyDeskTime-Agent-Windows.zip", b"build-two-is-longer")
    assert second != first

    after = agentdist.list_bundles()[0].sha256
    assert after == hashlib.sha256(second).hexdigest()
    assert after != before
