"""The live delivery layer: who is connected, and what gets pushed to them.

**In-process, and that is a deployment invariant rather than a shortcut.** The
registry below is a dictionary in one Python process. It is correct because this
application runs a single uvicorn worker — the same precondition
``app/scheduler.py`` already documents and depends on for in-process jobs. Add
``--workers`` without also moving this out and the failure is quiet and
confusing: a message posted on worker A is delivered to nobody connected to
worker B, so chat "works" for two people and not for a third, depending on
which process their socket landed on.

When that day comes the fix is a broker — Redis pub/sub — and it is the *same*
decision as moving the scheduler out, not a second one. Both are gated on the
same "one worker" line in ``render.yaml``.

**The socket is a delivery channel, not a command channel.** Nothing a client
sends over it is acted on. Posting a message is an HTTP ``POST`` that runs the
ordinary auth, validation and rule path; this layer only pushes what that path
has already accepted. That means the socket has no write surface to get wrong,
and it means a browser with a broken socket loses live updates rather than the
ability to speak — it can still post, and it still sees its own message.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections import defaultdict

from fastapi import WebSocket

log = logging.getLogger(__name__)


class Hub:
    """Open sockets, indexed by the user they belong to.

    One person routinely has several — a laptop, a phone, a second tab — so the
    value is a set rather than a single socket. A push to a user goes to all of
    them, which is what makes a message read on the laptop appear on the phone.
    """

    def __init__(self) -> None:
        self._sockets: dict[uuid.UUID, set[WebSocket]] = defaultdict(set)
        # Guards the dictionary itself. Connections open and close from
        # different request tasks, and `send_to` iterates while they do.
        self._lock = asyncio.Lock()

    async def join(self, user_id: uuid.UUID, socket: WebSocket) -> None:
        async with self._lock:
            self._sockets[user_id].add(socket)

    async def leave(self, user_id: uuid.UUID, socket: WebSocket) -> None:
        async with self._lock:
            live = self._sockets.get(user_id)
            if not live:
                return
            live.discard(socket)
            # Drop the key rather than leaving an empty set behind: this dict is
            # the only thing that grows for the life of the process.
            if not live:
                self._sockets.pop(user_id, None)

    async def send_to(self, user_ids: list[uuid.UUID], payload: dict) -> None:
        """Push one payload to everyone in the list who happens to be connected.

        Best effort, deliberately. A send that fails means a socket that has
        gone away without saying so, and the right response is to forget it —
        not to fail the HTTP request that triggered the push. The message is
        already committed; delivery is the part that is allowed to be lossy,
        because the client re-reads history on reconnect.
        """
        async with self._lock:
            targets = [
                (user_id, socket)
                for user_id in set(user_ids)
                for socket in self._sockets.get(user_id, ())
            ]

        dead: list[tuple[uuid.UUID, WebSocket]] = []
        for user_id, socket in targets:
            try:
                await socket.send_json(payload)
            except Exception:  # noqa: BLE001 — any send failure is a dead socket
                dead.append((user_id, socket))

        for user_id, socket in dead:
            await self.leave(user_id, socket)
            log.debug("dropped a closed chat socket for %s", user_id)

    def connected(self, user_id: uuid.UUID) -> bool:
        return bool(self._sockets.get(user_id))


#: Module-level, because there is one process and therefore one hub. Imported
#: rather than injected: a second instance would be a second, invisible set of
#: connections that nothing ever pushes to.
hub = Hub()
