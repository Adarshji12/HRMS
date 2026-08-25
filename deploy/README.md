# Deploying v1.2 without disturbing what is running

`DEPLOYMENT.md` describes the normal 1.0 → 1.1 deploy, where the whole thing is
"point the stack at the new tags". **v1.2 is not that deploy.** It carries a
schema migration and needs a compose change, and both of those can hurt a
working system if done casually. These scripts exist so they are not.

Run them in order. Each one prints what it found and stops if something is
wrong. Nothing before `04-deploy.sh` changes anything on the running stack.

| | | Changes anything? |
|---|---|---|
| `01-preflight.sh` | Disk, health, versions, row counts | No — read only |
| `02-backup.sh` | Dump the database **and prove it restores** | No — throwaway container |
| `03-rehearse-migration.sh` | Run the v1.2 migration on a copy of your data | No — isolated network |
| `04-deploy.sh` | The deploy | Yes |
| `05-verify.sh` | Confirm it worked and nothing was lost | No — read only |
| `99-rollback.sh` | Back to 1.1, schema included | Yes, on demand |

---

## Transfer

WinSCP to `/tmp`, **Binary** mode, as usual:

- `mydesktime-1.2.tar` — 160 MB
- `MyDeskTime-Agent-Windows.zip` — 19.9 MB (from `agent/dist/`)
- this whole `deploy/` folder

Then, **before running anything**:

```bash
cd /tmp/deploy
sed -i 's/\r$//' *.sh          # Binary mode keeps Windows line endings;
                               # bash reports "\r: command not found" otherwise
chmod +x *.sh
```

---

## Run

```bash
cd /tmp/deploy
bash 01-preflight.sh           # read the output before continuing
bash 02-backup.sh
bash 03-rehearse-migration.sh  # proves the migration works on YOUR data
bash 04-deploy.sh
bash 05-verify.sh
```

Expect roughly 5–10 seconds where the console is unreachable while containers
are recreated. **Agents keep collecting through it** — they spool locally and
re-upload, so no tracking data is lost to the deploy window.

---

## The four things that could actually hurt you

**1. Disk.** `docker load` writes ~600 MB. If `/` fills, PostgreSQL stops being
able to write and you have an outage caused by a deploy that had not started.
`01-preflight.sh` refuses to continue below 3 GB free.

**2. Overwriting the compose file.** The repository's copy of
`docker-compose.deploy.yml` was untracked until this release, so nothing proves
it matches what has been live on this host since the cutover. If it differs in
a volume name or a published port, `up -d` would recreate containers against
the wrong volumes and it would look exactly like data loss.

`04-deploy.sh` therefore **edits your file** — inserting one line — rather than
replacing it, keeps a timestamped copy, and diffs the fully rendered
`docker compose config` before and after. If anything other than the agent
mount changed, it restores your file and stops.

**3. The migration.** `migrate` runs before `api` starts, so a failure there
means the API never comes up — with the old containers already gone.
`03-rehearse-migration.sh` runs the exact migration against a restored copy of
production in an isolated container first, so you know the answer before it
matters. It rehearses the *rollback* too.

**4. Rollback is not just a tag change.** After v1.2 the database is at
`a3f1c72b9d04` and 1.1's code expects `fab25be2393b`; 1.1 will refuse to start
rather than fail on a random query later. `99-rollback.sh` reverses the schema
before bringing 1.1 back. Do not roll back by editing `.env` alone.

---

## Never, on this host

- **`docker compose down -v`** — the `-v` deletes volumes. Unrecoverable, and
  the old vendor's three weeks of data is on this box too.
- **`docker system prune` / `docker image prune -a`** — would remove the 1.1
  images that are your rollback, and the old vendor's stopped stack.
- **Anything without `-p mdt2`** — Compose would take the project name from the
  directory, not find the running containers, and create a second stack with
  new empty volumes. It looks precisely like total data loss.

### Reclaiming space, if pre-flight says you are tight

Deliberately, and never during a deploy. Keep the last two versions:

```bash
docker image rm mydesktime-api:1.0 mydesktime-console:1.0
```

The old vendor's ~6 GB stays until the client confirms they are done with it.

---

## What changes on the server

| Path | Change |
|---|---|
| `/opt/mdt-fastapi/docker-compose.deploy.yml` | one line added under `api.volumes` |
| `/opt/mdt-fastapi/.env` | `API_IMAGE`, `CONSOLE_IMAGE` → `1.2` |
| `/opt/mdt-fastapi/agent-dist/` | new, holds the agent bundle |
| database | new `plans` table, seeded with the three built-in plans |

Nothing else. No existing row is altered by the migration — it only creates a
table. `mdt2_pgdata` and `mdt2_storage` are untouched.

## Publishing a new agent build later

A file copy. No image rebuild, no restart:

```bash
cp MyDeskTime-Agent-Windows.zip /opt/mdt-fastapi/agent-dist/
chmod 644 /opt/mdt-fastapi/agent-dist/MyDeskTime-Agent-Windows.zip
```

The filename must contain `windows`, `macos` or `linux` or the console will not
offer it — and will say so, listing what it skipped.
