"""Productivity classification.

Rules are evaluated highest-priority-first; ties break on pattern length so a
specific rule ("mail.google.com") outranks a general one ("google.com") without
the admin having to hand-manage priority numbers.

Domain rules match the host and any subdomain of it: a rule for "youtube.com"
matches "m.youtube.com" but not "notyoutube.com".
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import MatchType, Productivity, ProductivityRule

DEFAULT_RULES: list[tuple[str, str, str, str]] = [
    # (match_type, pattern, productivity, label)
    (MatchType.APP.value, "code.exe", Productivity.PRODUCTIVE.value, "VS Code"),
    (MatchType.APP.value, "devenv.exe", Productivity.PRODUCTIVE.value, "Visual Studio"),
    (MatchType.APP.value, "pycharm64.exe", Productivity.PRODUCTIVE.value, "PyCharm"),
    (MatchType.APP.value, "idea64.exe", Productivity.PRODUCTIVE.value, "IntelliJ"),
    (MatchType.APP.value, "windowsterminal.exe", Productivity.PRODUCTIVE.value, "Terminal"),
    (MatchType.APP.value, "excel.exe", Productivity.PRODUCTIVE.value, "Excel"),
    (MatchType.APP.value, "winword.exe", Productivity.PRODUCTIVE.value, "Word"),
    (MatchType.APP.value, "outlook.exe", Productivity.PRODUCTIVE.value, "Outlook"),
    (MatchType.APP.value, "slack.exe", Productivity.NEUTRAL.value, "Slack"),
    (MatchType.APP.value, "teams.exe", Productivity.NEUTRAL.value, "Teams"),
    (MatchType.APP.value, "explorer.exe", Productivity.NEUTRAL.value, "File Explorer"),
    (MatchType.APP.value, "steam.exe", Productivity.UNPRODUCTIVE.value, "Steam"),
    (MatchType.DOMAIN.value, "github.com", Productivity.PRODUCTIVE.value, "GitHub"),
    (MatchType.DOMAIN.value, "gitlab.com", Productivity.PRODUCTIVE.value, "GitLab"),
    (MatchType.DOMAIN.value, "stackoverflow.com", Productivity.PRODUCTIVE.value, "Stack Overflow"),
    (MatchType.DOMAIN.value, "atlassian.net", Productivity.PRODUCTIVE.value, "Jira/Confluence"),
    (MatchType.DOMAIN.value, "docs.google.com", Productivity.PRODUCTIVE.value, "Google Docs"),
    (MatchType.DOMAIN.value, "mail.google.com", Productivity.PRODUCTIVE.value, "Gmail"),
    (MatchType.DOMAIN.value, "google.com", Productivity.NEUTRAL.value, "Google"),
    (MatchType.DOMAIN.value, "linkedin.com", Productivity.NEUTRAL.value, "LinkedIn"),
    (MatchType.DOMAIN.value, "youtube.com", Productivity.UNPRODUCTIVE.value, "YouTube"),
    (MatchType.DOMAIN.value, "netflix.com", Productivity.UNPRODUCTIVE.value, "Netflix"),
    (MatchType.DOMAIN.value, "facebook.com", Productivity.UNPRODUCTIVE.value, "Facebook"),
    (MatchType.DOMAIN.value, "instagram.com", Productivity.UNPRODUCTIVE.value, "Instagram"),
    (MatchType.DOMAIN.value, "x.com", Productivity.UNPRODUCTIVE.value, "X"),
    (MatchType.DOMAIN.value, "reddit.com", Productivity.UNPRODUCTIVE.value, "Reddit"),
    (MatchType.DOMAIN.value, "tiktok.com", Productivity.UNPRODUCTIVE.value, "TikTok"),
    (MatchType.DOMAIN.value, "twitch.tv", Productivity.UNPRODUCTIVE.value, "Twitch"),
]


@dataclass(frozen=True)
class _Rule:
    match_type: str
    pattern: str
    productivity: str
    priority: int


class Classifier:
    """Built once per request batch, then applied to every segment in it."""

    def __init__(self, rules: list[_Rule]) -> None:
        # Sort once: priority desc, then longest pattern first.
        self._rules = sorted(rules, key=lambda r: (-r.priority, -len(r.pattern)))

    @classmethod
    def for_org(cls, db: Session, org_id: uuid.UUID) -> "Classifier":
        rows = db.scalars(
            select(ProductivityRule).where(ProductivityRule.org_id == org_id)
        ).all()
        return cls(
            [
                _Rule(r.match_type, r.pattern.lower().strip(), r.productivity, r.priority)
                for r in rows
            ]
        )

    def classify(
        self,
        *,
        app_exec: str = "",
        url_domain: str | None = None,
        window_title: str = "",
        is_idle: bool = False,
    ) -> str:
        if is_idle:
            return Productivity.NEUTRAL.value

        app = (app_exec or "").lower().strip()
        domain = (url_domain or "").lower().strip().removeprefix("www.")
        title = (window_title or "").lower()

        for rule in self._rules:
            if rule.match_type == MatchType.DOMAIN.value:
                # A browser tab on a matched domain classifies on the domain even
                # if the browser executable itself has an app rule.
                if domain and (domain == rule.pattern or domain.endswith("." + rule.pattern)):
                    return rule.productivity
            elif rule.match_type == MatchType.APP.value:
                # Only fall through to the app rule when the segment is not a
                # browser tab we could have classified by domain.
                if app and app == rule.pattern and not domain:
                    return rule.productivity
            elif rule.match_type == MatchType.TITLE.value:
                if title and rule.pattern in title:
                    return rule.productivity

        return Productivity.NEUTRAL.value


def seed_default_rules(db: Session, org_id: uuid.UUID) -> int:
    existing = {
        (r.match_type, r.pattern)
        for r in db.scalars(
            select(ProductivityRule).where(ProductivityRule.org_id == org_id)
        ).all()
    }
    added = 0
    for match_type, pattern, productivity, label in DEFAULT_RULES:
        if (match_type, pattern) in existing:
            continue
        db.add(
            ProductivityRule(
                org_id=org_id,
                match_type=match_type,
                pattern=pattern,
                productivity=productivity,
                label=label,
                priority=0,
            )
        )
        added += 1
    return added
