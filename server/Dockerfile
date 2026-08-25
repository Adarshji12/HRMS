# MyDeskTime API.
#
# Two stages so the build tools that compile psycopg and bcrypt do not ship to
# production: the runtime image gets the built wheels and nothing else.

FROM python:3.12-slim AS build

# psycopg needs libpq to build; bcrypt needs a compiler.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential libpq-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY requirements.txt .
RUN pip wheel --no-cache-dir --wheel-dir /wheels -r requirements.txt


FROM python:3.12-slim

# libpq5 is the runtime half of libpq-dev; curl is for the healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpq5 curl \
    && rm -rf /var/lib/apt/lists/*

# Never root. A container escape from an unprivileged process is a much
# smaller problem than one from root, and nothing here needs the privilege.
RUN useradd --create-home --uid 10001 hrdesktimesol

COPY --from=build /wheels /wheels
COPY requirements.txt .
RUN pip install --no-cache-dir --no-index --find-links=/wheels -r requirements.txt \
    && rm -rf /wheels requirements.txt

WORKDIR /app
COPY --chown=hrdesktimesol:hrdesktimesol alembic.ini ./
COPY --chown=hrdesktimesol:hrdesktimesol alembic ./alembic
COPY --chown=hrdesktimesol:hrdesktimesol app ./app

# Screenshots land here when STORAGE_BACKEND=local. Mount a volume over it, or
# switch to S3 — a container filesystem is not somewhere to keep evidence.
RUN mkdir -p /data/storage && chown hrdesktimesol:hrdesktimesol /data/storage

# The packaged agent bundles the console offers for download. Deliberately not
# baked into this image: the agent is built by a different job on a different
# schedule, and copying a new one in should not mean rebuilding the API. Empty
# is a valid state — the console says so rather than failing.
RUN mkdir -p /data/agent && chown hrdesktimesol:hrdesktimesol /data/agent
ENV STORAGE_DIR=/data/storage \
    AGENT_DIST_DIR=/data/agent \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

USER hrdesktimesol
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8000/health || exit 1

# No --reload, and no migrations on start: the schema is applied by the
# `migrate` service so that N replicas do not race each other to run it.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
