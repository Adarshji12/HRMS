"""Entry point for the compiled build.

Nuitka compiles a program, not a command line, so the server is started from
here rather than by `uvicorn app.main:app`. That also removes the string
"app.main:app" from the deployment, which would otherwise be an invitation to
try importing the module by hand.

Reload is deliberately not wired up: this exists only for the compiled
production build, and a reloader that watches for source files there would be
watching for files that are not present.
"""

from __future__ import annotations

import os
import sys


def main() -> int:
    import uvicorn

    from app.main import app

    host = os.environ.get("HOST", "0.0.0.0")  # noqa: S104 - containers bind all interfaces
    port = int(os.environ.get("PORT", "8000"))
    # One worker per process. Scaling is by running more containers, which the
    # orchestrator already knows how to do, rather than by a worker count baked
    # into a binary the operator cannot edit.
    uvicorn.run(
        app,
        host=host,
        port=port,
        proxy_headers=True,
        forwarded_allow_ips="*",
        log_config=None,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
