"""HTTP client for the ingest API.

Failure handling is deliberately coarse: anything the agent cannot fix by
retrying (revoked device, refused notice) raises a distinct exception the main
loop acts on; everything else is a transient ``ServerUnavailable`` that leaves
the spool untouched so the data is retried later.
"""

from __future__ import annotations

import logging
from pathlib import Path

import requests

from agent import __version__

log = logging.getLogger(__name__)

TIMEOUT = (5, 30)  # (connect, read) seconds


class ServerUnavailable(RuntimeError):
    """Transient: network down, 5xx, timeout. Keep the data and retry."""


class DeviceRevoked(RuntimeError):
    """Terminal: the admin disabled this device. Stop collecting."""


class NoticeRequired(RuntimeError):
    def __init__(self, notice_text: str) -> None:
        super().__init__("monitoring notice must be accepted")
        self.notice_text = notice_text


class AuthFailed(RuntimeError):
    """The stored token is not valid — re-enrolment is required."""


class ApiClient:
    def __init__(
        self,
        base_url: str,
        token: str | None = None,
        verify: bool = True,
        org_slug: str = "",
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.org_slug = org_slug
        self._session = requests.Session()
        self._session.verify = verify
        self._session.headers["User-Agent"] = f"MyDeskTimeAgent/{__version__}"

    def set_token(self, token: str) -> None:
        self.token = token

    def set_org(self, slug: str) -> None:
        self.org_slug = slug

    # -----------------------------------------------------------------------

    def _headers(self) -> dict:
        headers: dict[str, str] = {}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        if self.org_slug:
            # The device token already names its organisation, so this is
            # belt-and-braces for runtime calls — but /login needs it, because
            # an email is only unique within one tenant.
            headers["X-Org-Slug"] = self.org_slug
        return headers

    def _request(self, method: str, path: str, **kwargs) -> requests.Response:
        url = f"{self.base_url}/api/v1{path}"
        headers = {**self._headers(), **kwargs.pop("headers", {})}
        try:
            response = self._session.request(
                method, url, headers=headers, timeout=TIMEOUT, **kwargs
            )
        except requests.RequestException as exc:
            raise ServerUnavailable(str(exc)) from exc

        if response.status_code == 401:
            raise AuthFailed(_detail(response))
        if response.status_code == 403:
            raise DeviceRevoked(_detail(response))
        if response.status_code >= 500:
            raise ServerUnavailable(f"HTTP {response.status_code}")
        return response

    # -- enrolment ----------------------------------------------------------

    def enroll(self, payload: dict) -> dict:
        return self._bind("/agent/enroll", payload, "The enrollment key was not accepted.")

    def login(self, payload: dict) -> dict:
        return self._bind("/agent/login", payload, "That email and password were not accepted.")

    def _bind(self, path: str, payload: dict, auth_message: str) -> dict:
        """Shared by enrol and login: both trade a credential for a device token."""
        try:
            response = self._session.post(
                f"{self.base_url}/api/v1{path}",
                json=payload,
                headers=self._headers(),
                timeout=TIMEOUT,
            )
        except requests.RequestException as exc:
            raise ServerUnavailable(str(exc)) from exc

        if response.status_code == 412:
            body = response.json().get("detail", {})
            raise NoticeRequired(body.get("notice_text", "") if isinstance(body, dict) else "")
        if response.status_code == 401:
            raise AuthFailed(auth_message)
        if response.status_code == 402:
            # Subscription lapsed or company suspended: retrying will not help.
            raise DeviceRevoked(_detail(response))
        if response.status_code in (400, 404):
            raise AuthFailed(_detail(response))
        if response.status_code >= 500:
            raise ServerUnavailable(f"HTTP {response.status_code}")
        response.raise_for_status()
        return response.json()

    # -- runtime ------------------------------------------------------------

    def heartbeat(self, queued_items: int, capture_blocked: str | None = None) -> dict:
        # capture_blocked travels with every heartbeat rather than being sent
        # once at startup: whoever is looking at the dashboard needs to know
        # the machine is collecting nothing *now*, and a one-off message sent
        # before they logged in is not an answer to that.
        response = self._request(
            "POST", "/agent/heartbeat",
            json={
                "agent_version": __version__,
                "queued_items": queued_items,
                "capture_blocked": capture_blocked,
            },
        )
        response.raise_for_status()
        return response.json()

    def projects(self) -> list[dict]:
        """Projects this employee may log time against."""
        response = self._request("GET", "/agent/projects")
        response.raise_for_status()
        return response.json()

    def session_start(self, started_at: str) -> None:
        self._request("POST", "/agent/session/start", json={"started_at": started_at})

    def session_end(self, ended_at: str) -> None:
        self._request("POST", "/agent/session/end", json={"ended_at": ended_at})

    def send_segments(self, segments: list[dict]) -> set[str]:
        """Returns the set of client_uids the server has taken responsibility for.

        Rejected items are logged and also treated as accepted — they are
        malformed and will never succeed, so retrying them forever would block
        the queue behind them.
        """
        response = self._request("POST", "/agent/activity", json={"segments": segments})
        if response.status_code == 422:
            log.error("ingest rejected the batch outright: %s", _detail(response))
            return {s["client_uid"] for s in segments}
        response.raise_for_status()
        body = response.json()

        accepted = set(body.get("accepted", []))
        rejected = body.get("rejected", {})
        for uid, reason in rejected.items():
            log.warning("segment %s rejected: %s", uid[:8], reason)
        return accepted | set(rejected)

    def upload_screenshot(self, meta: dict, image_path: Path) -> bool:
        import json

        with image_path.open("rb") as handle:
            response = self._request(
                "POST", "/agent/screenshot",
                data={"meta": json.dumps(meta)},
                files={"file": (image_path.name, handle, "image/jpeg")},
            )
        if response.status_code in (413, 422):
            log.warning("screenshot %s refused: %s", meta.get("client_uid", "?")[:8],
                        _detail(response))
            return True  # unfixable; drop it
        response.raise_for_status()
        return True


def _detail(response: requests.Response) -> str:
    try:
        return str(response.json().get("detail", response.text))[:300]
    except ValueError:
        return response.text[:300]
