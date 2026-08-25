"""The packaged agent bundles the console offers for download.

A directory scan, not a database table. The bundles are build artifacts dropped
in by a deploy, and a table would only be a second place for the same fact to
live — one that goes stale the moment somebody copies a new zip in without
remembering to register it.

Two things this module is careful about:

* **No path from user input.** A download is resolved by matching against the
  listing this module produced, never by joining a client-supplied name onto a
  directory. There is therefore no traversal to get wrong.
* **A checksum with every bundle.** The Windows binaries are not code-signed
  yet, so SmartScreen calls them an unknown publisher and an employee has been
  told to click through that warning. The least we can do is give the
  administrator a hash they can read down the phone, so "click Run anyway" is
  not the only assurance anyone has.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from app.core.config import settings

log = logging.getLogger("sentinel.agentdist")

#: Extensions worth offering. Anything else in the directory — a stray .tar, a
#: PyInstaller work folder — is not a deliverable and is ignored rather than
#: listed as a download that will confuse whoever clicks it.
BUNDLE_SUFFIXES = (".zip", ".tar.gz", ".dmg", ".exe")

#: Filename fragment -> what to call it, and what the person downloading needs
#: to know before they start. Order matters: the first match wins.
PLATFORMS: tuple[tuple[str, str, str], ...] = (
    ("windows", "Windows", "Windows 10 or 11, 64-bit"),
    ("win", "Windows", "Windows 10 or 11, 64-bit"),
    ("macos", "macOS", "macOS 12 or later"),
    ("darwin", "macOS", "macOS 12 or later"),
    ("linux", "Linux", "Most 64-bit distributions"),
)

#: Hashing 20 MB on every page load is wasted work when the file changes about
#: once a month. Keyed on identity *and* mtime/size, so a rebuilt bundle at the
#: same path is never served a stale hash.
_digests: dict[tuple[str, int, int], str] = {}


@dataclass(frozen=True)
class Bundle:
    #: The file name. Also the id the download endpoint takes, which is safe
    #: precisely because it is only ever compared against this listing.
    name: str
    platform: str
    requirement: str
    size: int
    modified_at: datetime
    sha256: str
    path: Path

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "platform": self.platform,
            "requirement": self.requirement,
            "size": self.size,
            "modified_at": self.modified_at.isoformat(),
            "sha256": self.sha256,
        }


def _platform_for(name: str) -> tuple[str, str] | None:
    """The platform a bundle's *name* declares, or None if it declares none.

    A name that does not say which platform it is for is not offered as a
    download. Every build script already names them this way, and the rule earns
    its keep on the way in: a build directory accumulates work folders, test
    archives and half-finished experiments, and "MyDeskTime for Unknown" sitting
    in the console next to the real thing is worse than not listing it.

    Nothing is dropped silently — see ``ignored_names``.
    """
    lowered = name.lower()
    for fragment, label, requirement in PLATFORMS:
        if fragment in lowered:
            return label, requirement
    return None


def _digest(path: Path, stat) -> str:
    key = (str(path), int(stat.st_mtime), stat.st_size)
    cached = _digests.get(key)
    if cached is not None:
        return cached
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    _digests[key] = digest.hexdigest()
    return _digests[key]


def _is_bundle(path: Path) -> bool:
    if not path.is_file():
        return False
    name = path.name.lower()
    return any(name.endswith(suffix) for suffix in BUNDLE_SUFFIXES)


def list_bundles() -> list[Bundle]:
    """Every downloadable bundle, newest build first.

    A missing directory is not an error. A deployment that has not had an agent
    build copied in yet is a normal state, and the console says so — rather than
    the whole Employees page failing because a folder is absent.
    """
    root = settings.agent_dist_dir
    if not root.is_dir():
        return []

    bundles: list[Bundle] = []
    for path in sorted(root.iterdir()):
        if not _is_bundle(path):
            continue
        matched = _platform_for(path.name)
        if matched is None:
            continue
        platform, requirement = matched
        try:
            stat = path.stat()
            bundles.append(
                Bundle(
                    name=path.name,
                    platform=platform,
                    requirement=requirement,
                    size=stat.st_size,
                    modified_at=datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc),
                    sha256=_digest(path, stat),
                    path=path,
                )
            )
        except OSError:
            # One unreadable file must not take the whole list with it.
            log.warning("could not read agent bundle %s", path, exc_info=True)

    # Newest first: after a rebuild, the thing an administrator wants is the one
    # that just appeared, not whatever sorts first alphabetically.
    bundles.sort(key=lambda b: b.modified_at, reverse=True)
    return bundles


def ignored_names() -> list[str]:
    """Archives in the directory whose names do not name a platform.

    Reported to the console rather than dropped quietly: somebody who copies a
    build in and cannot find it should be told why in the place they are
    looking, not left to guess at the naming rule.
    """
    root = settings.agent_dist_dir
    if not root.is_dir():
        return []
    return sorted(
        path.name
        for path in root.iterdir()
        if _is_bundle(path) and _platform_for(path.name) is None
    )


def find(name: str) -> Bundle | None:
    """Resolve a download by name, against the listing rather than the filesystem."""
    return next((b for b in list_bundles() if b.name == name), None)
