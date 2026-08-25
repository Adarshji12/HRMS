"""Attributing tracked time to projects.

Called at ingest for every segment, and again by the reclassify job when rules
change. The ordering rule is the whole design: a **rule may never overwrite what
a human decided**. ``ProjectSource.rank`` encodes that, and every write goes
through :func:`apply` which checks it.

Billability is resolved once, at attribution time, and then frozen on the
segment. Deriving it live from the project would mean flipping a project to
non-billable silently rewrites last month's invoiced totals.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import ActivitySegment, Project, ProjectRule, ProjectSource, Task


@dataclass(frozen=True)
class Attribution:
    project_id: uuid.UUID | None
    task_id: uuid.UUID | None
    source: ProjectSource | None
    is_billable: bool


@dataclass(frozen=True)
class _Rule:
    match_type: str
    pattern: str
    project_id: uuid.UUID
    task_id: uuid.UUID | None
    priority: int


class Attributor:
    """Built once per ingest batch, then applied to every segment in it."""

    def __init__(
        self,
        rules: list[_Rule],
        billable_projects: dict[uuid.UUID, bool],
        billable_tasks: dict[uuid.UUID, bool | None],
    ) -> None:
        # Priority first, then longest pattern: "acme-web-admin" beats
        # "acme-web" without anyone hand-managing priority numbers.
        self._rules = sorted(rules, key=lambda r: (-r.priority, -len(r.pattern)))
        self._billable_projects = billable_projects
        self._billable_tasks = billable_tasks

    @classmethod
    def for_org(cls, db: Session, org_id: uuid.UUID) -> "Attributor":
        rules = [
            _Rule(r.match_type, r.pattern.lower().strip(), r.project_id, r.task_id, r.priority)
            for r in db.scalars(select(ProjectRule).where(ProjectRule.org_id == org_id)).all()
        ]
        projects = {
            p.id: p.is_billable
            for p in db.scalars(select(Project).where(Project.org_id == org_id)).all()
        }
        tasks = {
            t.id: t.is_billable
            for t in db.scalars(select(Task).where(Task.org_id == org_id)).all()
        }
        return cls(rules, projects, tasks)

    def billable(self, project_id: uuid.UUID | None, task_id: uuid.UUID | None) -> bool:
        if project_id is None:
            return False
        # A task only overrides the project when it says something explicit;
        # None means "inherit", not "not billable".
        task_flag = self._billable_tasks.get(task_id) if task_id else None
        if task_flag is not None:
            return task_flag
        return self._billable_projects.get(project_id, False)

    def resolve(
        self,
        *,
        app_exec: str = "",
        url_domain: str | None = None,
        window_title: str = "",
        repo_name: str | None = None,
        selected_project_id: uuid.UUID | None = None,
        selected_task_id: uuid.UUID | None = None,
    ) -> Attribution:
        # The employee's own selection beats any pattern match.
        if selected_project_id is not None:
            return Attribution(
                selected_project_id,
                selected_task_id,
                ProjectSource.SELECTION,
                self.billable(selected_project_id, selected_task_id),
            )

        app = (app_exec or "").lower().strip()
        domain = (url_domain or "").lower().strip().removeprefix("www.")
        title = (window_title or "").lower()
        repo = (repo_name or "").lower().strip()

        for rule in self._rules:
            hit = False
            if rule.match_type == "repo":
                hit = bool(repo) and repo == rule.pattern
            elif rule.match_type == "domain":
                hit = bool(domain) and (
                    domain == rule.pattern or domain.endswith("." + rule.pattern)
                )
            elif rule.match_type == "app":
                hit = bool(app) and app == rule.pattern
            elif rule.match_type == "title":
                hit = bool(title) and rule.pattern in title

            if hit:
                return Attribution(
                    rule.project_id,
                    rule.task_id,
                    ProjectSource.RULE,
                    self.billable(rule.project_id, rule.task_id),
                )

        return Attribution(None, None, None, False)


def apply(segment: ActivitySegment, attribution: Attribution) -> bool:
    """Write an attribution onto a segment if it outranks what is already there.

    Returns True if the segment changed. This is the only place attribution is
    written, so the precedence rule cannot be bypassed by a caller that forgot.
    """
    if attribution.project_id is None or attribution.source is None:
        return False

    if segment.project_source is not None:
        try:
            existing = ProjectSource(segment.project_source)
        except ValueError:
            existing = ProjectSource.RULE
        if existing.rank > attribution.source.rank:
            return False
        if (
            existing.rank == attribution.source.rank
            and segment.project_id == attribution.project_id
            and segment.task_id == attribution.task_id
        ):
            return False

    segment.project_id = attribution.project_id
    segment.task_id = attribution.task_id
    segment.project_source = attribution.source.value
    segment.is_billable = attribution.is_billable
    return True


def set_manual(
    segment: ActivitySegment,
    project_id: uuid.UUID | None,
    task_id: uuid.UUID | None,
    attributor: Attributor,
) -> None:
    """Explicit human assignment. Always wins, including clearing."""
    segment.project_id = project_id
    segment.task_id = task_id
    segment.project_source = ProjectSource.MANUAL.value if project_id else None
    segment.is_billable = attributor.billable(project_id, task_id)
