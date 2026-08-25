# Deployment and operations

How MyDeskTime is running in production, and how to change it.

Written as a handover: someone picking this up cold — a colleague, or a fresh
Claude session with no memory of how it got here — should be able to deploy,
roll back and diagnose from this file alone.

Last verified: **21 August 2026**, version **1.1** live.

---

## Where it runs

| | |
|---|---|
| Host | `103.59.180.126` (`vmmb-chatbot`), root SSH |
| Console | <http://103.59.180.126:4200> |
| Directory | `/opt/mdt-fastapi` |
| Compose project | `mdt2` |
| Compose file | `docker-compose.deploy.yml` |
| Live version | `mydesktime-api:1.1`, `mydesktime-console:1.1` |

Every command below runs from `/opt/mdt-fastapi` and needs both flags:

```bash
docker compose -f docker-compose.deploy.yml -p mdt2 <command>
```

The `-p mdt2` is not optional. Without it, Compose picks a project name from
the directory and will not find the running containers.

### Services

| Service | Role |
|---|---|
| `db` | PostgreSQL 16. Not published — nothing outside the network needs it |
| `migrate` | Runs `alembic upgrade head` once, then exits. Everything waits for it |
| `api` | The application |
| `console` | nginx serving the built UI, proxying `/api` to `api:8000` |
| `jobs` | Scheduler: alerts every 15 min, retention hourly |

`migrate` showing **Exited (0)** is correct, not a failure.

### Volumes — this is the data

```
mdt2_pgdata     PostgreSQL
mdt2_storage    screenshot files
```

Containers are disposable; these are not. They survive every deploy.

---

## The box was not empty

A previous vendor's system is **still on this host**, stopped but intact:

```
mydesktime-webapp   port 4200   stopped during our cutover
mydesktime-api      port 3000   still running
mydesktime-db       postgres:17 still running, 3 weeks of their data
mydesktime-redis    still running
```

Their data lives in `mydesktime_postgres_data` — a different volume from ours.
A `pg_dumpall` backup is at `/root/mydesktime-backup/`.

**Do not run `docker compose down -v` anywhere on this host.** The `-v` deletes
volumes. `down` on its own is safe; `up -d` brings everything back with data
intact. It is only the `-v` that is unrecoverable.

Leave the old containers stopped rather than removed until the client confirms
they are finished with them — restarting one is the fastest rollback available
and costs nothing to keep.

---

## Deploying a new version

Images are built on a workstation and carried over as a tar. There is no
registry, so the images never sit on a third party's server.

### 1. Build (on the workstation)

```powershell
git add -A && git commit -m "..." && git tag v1.2

docker build -t mydesktime-api:1.2 ./server
docker build -t mydesktime-console:1.2 ./admin
docker save -o mydesktime-1.2.tar mydesktime-api:1.2 mydesktime-console:1.2
```

**Always a new version number.** Reusing a tag overwrites the old image and
destroys the rollback.

**`-o`, never `>`.** PowerShell applies text encoding to redirection and
silently corrupts the archive; you find out when `docker load` fails after
transferring 160 MB.

### 2. Transfer

WinSCP to `/tmp`, **Binary** transfer mode. Text mode rewrites line endings and
corrupts the tar.

If the server is behind a jump host, use WinSCP's Advanced → Connection →
Tunnel: the main fields are the *destination*, the tunnel fields are the *jump
host*. That ordering catches everyone out.

### 3. Deploy

```bash
cd /opt/mdt-fastapi

# Back up first if the release carries a migration
docker compose -f docker-compose.deploy.yml -p mdt2 exec -T db \
  pg_dump -U sentinel sentinel > /root/mydesktime-backup/pre-v1.2-$(date +%F).sql

docker load -i /tmp/mydesktime-1.2.tar

# This is the whole deploy: point the stack at the new tags
sed -i 's/^API_IMAGE=.*/API_IMAGE=mydesktime-api:1.2/' .env
sed -i 's/^CONSOLE_IMAGE=.*/CONSOLE_IMAGE=mydesktime-console:1.2/' .env

docker compose -f docker-compose.deploy.yml -p mdt2 up -d
```

Compose destroys the old containers and creates new ones from the new images.
Migrations run automatically in `migrate` before the API starts. Expect 5–10
seconds of downtime.

### 4. Verify

```bash
docker compose -f docker-compose.deploy.yml -p mdt2 ps
docker compose -f docker-compose.deploy.yml -p mdt2 logs migrate | tail -5
curl -sI http://localhost:4200/ | head -1
```

### Rollback

```bash
sed -i 's/^API_IMAGE=.*/API_IMAGE=mydesktime-api:1.1/' .env
sed -i 's/^CONSOLE_IMAGE=.*/CONSOLE_IMAGE=mydesktime-console:1.1/' .env
docker compose -f docker-compose.deploy.yml -p mdt2 up -d
```

Seconds, because the previous image is still on disk. **Keep the last two
versions**; prune older ones deliberately, never during a deploy.

Migrations do not roll back with the image. If the new version added a column
and you revert, the schema is ahead of the code — the API refuses to start
rather than failing on a random query later, and recovery needs
`alembic downgrade`. Hence the backup in step 3.

---

## Configuration

`/opt/mdt-fastapi/.env`, mode 600:

```
ENVIRONMENT=production
SECRET_KEY=<64 hex chars>
POSTGRES_PASSWORD=<32 hex chars>
BASE_DOMAIN=103.59.180.126
PUBLIC_SCHEME=http
CONSOLE_PORT=4200
API_IMAGE=mydesktime-api:1.1
CONSOLE_IMAGE=mydesktime-console:1.1
```

Generate secrets with `openssl rand -hex 32`. **Never reuse the ones from a
workstation**, and never commit this file.

The API deliberately refuses to start when `ENVIRONMENT=production` and either
the `SECRET_KEY` is the development default or the database is SQLite. Those
checks run before anything opens a connection, so the error names the actual
mistake rather than reporting a database failure.

---

## First-run setup

```bash
docker compose -f docker-compose.deploy.yml -p mdt2 exec api python -m app.platform_setup
```

Prints the platform admin's password **once**. Copy it immediately; every write
in the platform console is blocked until it is changed.

Then <http://103.59.180.126:4200/platform/login> → add the company. Adding a
company returns the owner's password once, on screen.

---

## Onboarding an employee

1. Console → **Employees → Add employee**. Only name and email are required.
   A password is *only* needed if that person will sign in to see their own
   numbers — tracking does not use it.
2. On their row in the Employees list, press **Set up**. That panel has the
   installer download, their enrolment key, the server address and the steps,
   with a **Copy instructions** button that produces the whole thing as text to
   paste into an email. **Install agent** in the page header is the same panel
   without a key, for sending the software ahead of time.
3. They unzip and double-click **`MyDeskTime-Setup.exe`**, press Enter for the
   server, paste the key, type `accept`.

That is the only thing they ever run. The tracker starts immediately and again
at every sign-in. `sentinel-agent.exe` in the same folder is started
automatically and must never be deleted.

### Making the download work

The console serves whatever is in `/opt/mdt-fastapi/agent-dist`, bind-mounted
read-only into the API container at `/data/agent`. Publishing a new agent build
is a file copy — no image rebuild, no restart:

```bash
mkdir -p /opt/mdt-fastapi/agent-dist
# scp MyDeskTime-Agent-Windows.zip to /opt/mdt-fastapi/agent-dist/
```

**The filename has to say which platform it is for** — it must contain
`windows`, `macos` or `linux`. A bundle named anything else is not offered, and
the panel lists what it skipped and why, so this fails visibly rather than
quietly. The console shows each build's size and SHA-256; the hash is worth
passing on, because the binaries are not code-signed and "click Run anyway" is
otherwise the only assurance an employee has.

An empty directory is a normal state — the panel says no build is present
rather than erroring.

The live server address is compiled into the agent
(`agent/agent/config.py`, `DEFAULT_SERVER`), so the employee only presses
Enter. Rebuild with `MYDESKTIME_SERVER=...` to target a different deployment.

### Checking a machine

```powershell
& "$env:LOCALAPPDATA\Programs\MyDeskTime\MyDeskTime-Setup.exe" --status
& "$env:LOCALAPPDATA\Programs\MyDeskTime\MyDeskTime-Setup.exe" --selftest
```

Autostart uses a Scheduled Task where possible and a per-user registry Run key
otherwise — `schtasks /SC ONLOGON` needs administrator rights and fails for
most employees, so the fallback is the normal path, not the exception:

```powershell
Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name MyDeskTime
Get-ScheduledTask -TaskName "MyDeskTime Agent"
```

Both empty means that machine will not start tracking at the next sign-in.

---

## Maintenance

Run inside the `api` container.

```bash
# What is wrong with the stored data, and what fixes it. Reports only.
docker compose -f docker-compose.deploy.yml -p mdt2 exec api python -m app.services.dataaudit

# Remove segments recorded twice by concurrent trackers. Dry run first.
... exec api python -m app.services.deoverlap --dry-run

# Force a retention purge now (the scheduler does this hourly anyway)
... exec api python -m app.services.retention

# Run alerts and retention once, for a manual check
... exec api python -m app.scheduler --once
```

`dataaudit` is the one to run when the numbers look wrong. It checks for
overlapping segments, lock-screen time banked as work, implausible segment
lengths, duplicate screenshots and activity recorded outside the configured
working hours — every way a dashboard can be wrong while nothing errors.

### Retention

Screenshot and activity retention are set per company in **Settings →
Screenshots / Activity**. The purge deletes the image files and thumbnails
before the database rows, and runs hourly in the `jobs` container. `0` means
keep forever.

---

## Known gaps

**No HTTPS.** Port 4200 is plain HTTP on the public internet. Enrolment keys,
employee passwords and screenshots all cross it unencrypted. This is the most
serious outstanding item — for a product that captures people's screens it is
not a rough edge. The fix needs one DNS record from the client
(`track.theircompany.com` → `103.59.180.126`, plus a wildcard), after which a
Caddy service can issue and renew certificates automatically. Nothing else is
blocking it.

**Agent binaries are unsigned.** SmartScreen shows "unknown publisher" on every
install. Fixed by an Authenticode certificate; the CI signing step is already
written and waits on the certificate existing.

**macOS and Linux agents are not built.** PyInstaller cannot cross-compile.
`.github/workflows/agent-build.yml` builds all four targets — push a tag
matching `agent-v*`. Neither tracker has run on real hardware; `--selftest` on
those machines reports which platform APIs actually work.

**No forgot-password flow.** An admin resets a password from the employee's
detail page (**Edit employee**). There is no self-service reset.

**Old vendor stack** still occupies roughly 6 GB in stopped containers and
images. Clear it deliberately once the client confirms, never during a deploy.

---

## Diagnosing

```bash
docker compose -f docker-compose.deploy.yml -p mdt2 ps
docker compose -f docker-compose.deploy.yml -p mdt2 logs api --tail 50
docker compose -f docker-compose.deploy.yml -p mdt2 logs jobs --tail 20
```

Every API response carries an `X-Request-ID`, and the log lines for that
request carry the same id — so a report of "it failed at 14:02" can be tied to
exact lines.

**The console shows "Session expired" for a wrong platform password**, because
any 401 from a platform endpoint clears the token and redirects. Test the
credential directly before assuming the session is at fault:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST http://localhost:4200/api/v1/platform/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"superadmin@mydesktime.local","password":"..."}'
```

**An employee reporting no data after 18:00** is almost always the working-hours
policy, not a fault. Outside the configured window the agent runs and collects
nothing, deliberately.

---

## Tests

```bash
cd server && pytest              # 127 tests
cd agent  && pytest tests/       # 4 tests
cd admin  && npx tsc --noEmit
```

`.github/workflows/ci.yml` runs these plus Postgres migrations up and down, a
model-drift check, and builds both images.

The suite exists mainly to hold two properties that are expensive to lose:
tenant isolation (one company reaching another's data), and retention actually
deleting the image files it promises to delete.
