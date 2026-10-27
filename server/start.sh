#!/bin/sh
# Single-instance start: migrate, then serve. Used by render.yaml because the
# free plan has no preDeployCommand. Never use this with several replicas —
# they would race each other through the migrations.
set -e
alembic upgrade head
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --proxy-headers
