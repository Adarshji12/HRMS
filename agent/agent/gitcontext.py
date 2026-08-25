"""Repository and branch detection for developer activity.

An editor does not tell outside processes which folder it has open, so this
works backwards: the project name is parsed out of the window title (every
mainstream editor puts it there), then matched against real git working copies
found under configured search roots. The branch is read from ``.git/HEAD``.

That indirection is deliberate. Parsing the title alone would report a
"repository" that is really just a folder name, and inventing repositories that
do not exist is worse than reporting none — a Coding Activity report nobody
trusts is a report nobody reads.

**Lines of code is not measured here and cannot be.** It is not observable from
outside the editor, and deriving it from keystrokes rewards verbose code. If you
need it, ship a VS Code extension or read it from git server-side.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

# "main.py - myproject - Visual Studio Code"
# "myproject – IntelliJ IDEA"
# "main.py (myproject) - Sublime Text"
_EDITORS = re.compile(
    r"\s[-–—]\s(?:Visual Studio Code|VSCodium|Cursor|IntelliJ IDEA|PyCharm|WebStorm|"
    r"GoLand|RubyMine|CLion|Rider|Android Studio|Sublime Text|Atom|Neovim|Vim|Emacs)"
    r"(?:\s*\[.*\])?\s*$",
    re.I,
)

EDITOR_EXECUTABLES = {
    "code.exe", "codium.exe", "cursor.exe", "devenv.exe", "idea64.exe", "pycharm64.exe",
    "webstorm64.exe", "goland64.exe", "rider64.exe", "studio64.exe", "sublime_text.exe",
    "nvim.exe", "gvim.exe", "emacs.exe",
    "code", "codium", "cursor", "idea", "pycharm", "webstorm", "sublime_text", "nvim", "vim",
    "Code", "Electron",
}

# Refresh a cached branch no more often than this — a developer switches branch
# a few times a day, and .git/HEAD would otherwise be read once per second.
BRANCH_TTL_S = 30
# Directory scan is the expensive part; keep the result for the whole session
# unless the folder disappears.
_MAX_SCAN_DEPTH = 3


@dataclass
class GitInfo:
    repo_name: str | None = None
    branch_name: str | None = None
    file_path: str | None = None


def is_editor(app_exec: str, app_name: str = "") -> bool:
    key = (app_exec or "").lower()
    return key in {e.lower() for e in EDITOR_EXECUTABLES} or "code" in (app_name or "").lower()


def parse_title(title: str) -> tuple[str | None, str | None]:
    """Return (project_name, file_name) parsed from an editor window title."""
    if not title:
        return None, None

    body = _EDITORS.sub("", title).strip()
    if not body:
        return None, None

    # VS Code marks unsaved work with a leading bullet.
    body = body.lstrip("●•* ").strip()

    # "file.py (myproject)" — Sublime's shape.
    bracketed = re.match(r"^(?P<file>[^()]+)\((?P<project>[^()]+)\)\s*$", body)
    if bracketed:
        return bracketed.group("project").strip(), bracketed.group("file").strip()

    # "file.py - myproject" — the common shape once the editor suffix is gone.
    parts = [p.strip() for p in re.split(r"\s[-–—]\s", body) if p.strip()]
    if len(parts) >= 2:
        return parts[-1], parts[0]
    if len(parts) == 1:
        # A workspace with no file open: the single part is the project.
        return (parts[0], None) if "." not in parts[0] else (None, parts[0])
    return None, None


class GitResolver:
    """Maps a project name to a real repository, with caching."""

    def __init__(self, search_roots: list[str] | None = None) -> None:
        self.search_roots = [Path(r).expanduser() for r in (search_roots or default_roots())]
        self._repo_paths: dict[str, Path | None] = {}
        self._branches: dict[Path, tuple[str | None, float]] = {}

    def resolve(self, title: str) -> GitInfo:
        project, file_name = parse_title(title)
        if not project:
            return GitInfo(file_path=file_name)

        path = self._find_repo(project)
        if path is None:
            # Known folder name but no git working copy: report neither, rather
            # than a repository that does not exist.
            return GitInfo(file_path=file_name)

        return GitInfo(repo_name=path.name, branch_name=self._branch(path), file_path=file_name)

    # -- internals ----------------------------------------------------------

    def _find_repo(self, project: str) -> Path | None:
        if project in self._repo_paths:
            return self._repo_paths[project]

        found: Path | None = None
        for root in self.search_roots:
            if not root.is_dir():
                continue
            candidate = root / project
            if (candidate / ".git").exists():
                found = candidate
                break
            found = self._scan(root, project, depth=1)
            if found is not None:
                break

        self._repo_paths[project] = found
        if found is None:
            log.debug("no git working copy found for project %r", project)
        return found

    def _scan(self, root: Path, project: str, depth: int) -> Path | None:
        if depth > _MAX_SCAN_DEPTH:
            return None
        try:
            entries = list(root.iterdir())
        except OSError:
            return None
        for entry in entries:
            if not entry.is_dir() or entry.name.startswith("."):
                continue
            if entry.name == project and (entry / ".git").exists():
                return entry
            nested = self._scan(entry, project, depth + 1)
            if nested is not None:
                return nested
        return None

    def _branch(self, repo: Path) -> str | None:
        cached = self._branches.get(repo)
        now = time.monotonic()
        if cached is not None and now - cached[1] < BRANCH_TTL_S:
            return cached[0]

        branch: str | None = None
        head = repo / ".git" / "HEAD"
        try:
            content = head.read_text(encoding="utf-8", errors="replace").strip()
            if content.startswith("ref:"):
                branch = content.split("/", 2)[-1]
            elif content:
                # Detached HEAD: show the short commit rather than nothing, so a
                # bisect session is not silently blank.
                branch = f"detached@{content[:8]}"
        except OSError:
            branch = None

        self._branches[repo] = (branch, now)
        return branch


def default_roots() -> list[str]:
    """Where working copies usually live. Overridable in agent.json."""
    home = Path.home()
    return [
        str(home / "Projects"), str(home / "projects"), str(home / "src"),
        str(home / "dev"), str(home / "Documents" / "GitHub"), str(home / "repos"),
        "C:/Projects", "C:/src", "C:/dev",
    ]
