"""Browser identification and URL normalisation.

The agent records the *domain* by default and the full URL only when the org
enables it, because a full URL is far more revealing (search terms, document
names, ticket titles) than the site being visited.
"""

from __future__ import annotations

import re
from urllib.parse import urlparse

# executable (lowercased, no path) -> canonical browser name
BROWSER_EXECUTABLES: dict[str, str] = {
    "chrome.exe": "chrome",
    "msedge.exe": "edge",
    "firefox.exe": "firefox",
    "brave.exe": "brave",
    "opera.exe": "opera",
    "vivaldi.exe": "vivaldi",
    "iexplore.exe": "ie",
    "safari": "safari",
    "google chrome": "chrome",
    "microsoft edge": "edge",
    "chromium": "chromium",
    "chrome": "chrome",
    "firefox": "firefox",
    "brave-browser": "brave",
    "opera": "opera",
    "vivaldi-bin": "vivaldi",
}

# Titles that mean "a browser window with no useful URL in it".
_NOISE_TITLES = {"", "new tab", "start page", "about:blank", "speed dial"}

_URL_IN_TITLE = re.compile(r"\b((?:https?://)?(?:[\w-]+\.)+[a-z]{2,})(?:/\S*)?", re.I)

# Site names browsers put in the title where the domain is unambiguous. This is
# a fallback for when UI Automation is unavailable; it is deliberately small,
# because guessing wrong is worse than recording nothing.
_TITLE_HINTS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bYouTube\b", re.I), "youtube.com"),
    (re.compile(r"\bGitHub\b", re.I), "github.com"),
    (re.compile(r"\bGitLab\b", re.I), "gitlab.com"),
    (re.compile(r"\bStack Overflow\b", re.I), "stackoverflow.com"),
    (re.compile(r"\bLinkedIn\b", re.I), "linkedin.com"),
    (re.compile(r"\bReddit\b|^r/", re.I), "reddit.com"),
    (re.compile(r"\bNetflix\b", re.I), "netflix.com"),
    (re.compile(r"\bTwitch\b", re.I), "twitch.tv"),
    (re.compile(r"\bInstagram\b", re.I), "instagram.com"),
    (re.compile(r"\bFacebook\b", re.I), "facebook.com"),
    (re.compile(r"\bGoogle Docs\b|Google Sheets|Google Slides", re.I), "docs.google.com"),
    (re.compile(r"\bGmail\b|^Inbox \(", re.I), "mail.google.com"),
    (re.compile(r"\bJira\b|\bConfluence\b", re.I), "atlassian.net"),
]


def identify_browser(app_exec: str, app_name: str = "") -> str | None:
    key = (app_exec or "").lower().strip()
    if key in BROWSER_EXECUTABLES:
        return BROWSER_EXECUTABLES[key]
    name = (app_name or "").lower().strip()
    return BROWSER_EXECUTABLES.get(name)


def domain_of(url: str | None) -> str | None:
    if not url:
        return None
    candidate = url.strip()
    if "://" not in candidate:
        candidate = "http://" + candidate
    try:
        host = urlparse(candidate).hostname
    except ValueError:
        return None
    if not host:
        return None
    host = host.lower().removeprefix("www.")
    # Reject things that are not really hosts (file paths, localhost-only names).
    return host if "." in host else None


def normalise_url(url: str | None) -> str | None:
    """Strip query and fragment.

    Query strings carry search terms and session tokens; the path alone is
    already at the edge of what a monitoring tool should retain.
    """
    if not url:
        return None
    candidate = url.strip()
    if "://" not in candidate:
        candidate = "https://" + candidate
    try:
        parts = urlparse(candidate)
    except ValueError:
        return None
    if not parts.hostname:
        return None
    return f"{parts.scheme}://{parts.hostname}{parts.path or ''}"[:2000]


def url_from_title(title: str) -> str | None:
    """Last-resort guess when UI Automation gave us nothing.

    Browsers show "<page title> - <Browser>", which rarely contains the URL, so
    this only fires on an explicit hostname in the title or a known site name.
    """
    if not title or title.strip().lower() in _NOISE_TITLES:
        return None

    # Drop the trailing " - Google Chrome" / " — Mozilla Firefox" suffix.
    body = re.split(r"\s+[-—]\s+(?:Google Chrome|Microsoft.\s?Edge|Mozilla Firefox|Brave|Opera|Vivaldi|Chromium)\b",
                    title)[0]

    match = _URL_IN_TITLE.search(body)
    if match:
        host = domain_of(match.group(1))
        if host:
            return f"https://{host}"

    for pattern, host in _TITLE_HINTS:
        if pattern.search(body):
            return f"https://{host}"
    return None
