# MyDeskTime — Workforce Analytics

Multi-tenant employee time and activity tracking. Three components:

| Component | Stack | Path |
|---|---|---|
| API server | Python 3.12 · FastAPI · SQLAlchemy 2 · Alembic · Postgres/SQLite | [server/](server/) |
| Admin console | React 18 · Vite · TypeScript | [admin/](admin/) |
| Desktop agent | Python 3.12 · pywin32 / pyobjc / python-xlib | [agent/](agent/) |

The desktop agent is not optional. Foreground-window enumeration, window titles,
browser URLs and screen capture are all OS-level APIs — no browser can reach them.

---

> **Building the HRMS out?** See [HRMS_PROGRESS.md](HRMS_PROGRESS.md) — which
> modules are done, what is next, and the conventions a new module must follow.

> **Running this in production?** See [DEPLOYMENT.md](DEPLOYMENT.md) —
> where it runs, how to deploy a new version, how to roll back, and
> what is still outstanding.

## Quick start

```bash
# 1. server
cd server
python -m venv .venv && .venv\Scripts\activate     # source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env
alembic upgrade head
python -m app.seed --demo-data          # demo company, staff, projects, activity
python -m app.platform_setup            # Super Admin — password printed once
uvicorn app.main:app --reload --port 8000

# 2. console
cd admin && npm install && npm run dev

# 3. agent
cd agent
python -m venv .venv && .venv\Scripts\activate
pip install -r requirements.txt
python -m agent.main --login you@acme.demo --org demo --server http://127.0.0.1:8000
python -m agent.main
```

| Surface | URL | Credentials |
|---|---|---|
| Company console | http://demo.localhost:5173 | `admin@acme.demo` / `admin12345` |
| Signup | http://localhost:5173/signup | — |
| Super Admin | http://localhost:5173/platform | printed by `app.platform_setup` |
| API docs | http://localhost:8000/docs | — |

Demo activity spans roughly the last week; set date filters to that range.

---

## Multi-tenancy

Tenants live at `<slug>.<BASE_DOMAIN>`. In development `*.localhost` resolves to
127.0.0.1 in every modern browser, so `demo.localhost:5173` works with no DNS
setup. Requests resolve their tenant from the `Host` header, falling back to an
`X-Org-Slug` header for API clients.

**Login is tenant-scoped.** Email is unique *within* an organisation, not
globally, so a global lookup would return an arbitrary one of several matching
accounts. A bearer token additionally carries its `org` and is rejected on any
other tenant — two independent checks, because one missed filter in one handler
would otherwise be a cross-tenant leak.

Super Admin lives in a separate `platform_admins` table with its own token type.
An operator has no `org_id`, and every tenant query filters on one — a platform
role inside `users` would need an exception in each of those filters.

---

## What it does

**Tracking.** Foreground app, window title, browser URL/domain, idle time, and an
input-activity percentage. Screenshots on a fixed or randomised interval, with
optional server-side blur.

**Attribution.** Time lands on projects three ways, in strict precedence:
manual assignment > the employee's tray selection > pattern rules (app, domain,
window title, git repository). A rule guesses, so it never overwrites what a
person decided.

**Timesheets.** Derived from tracked activity plus manual entries — reported
separately as well as summed. Overtime is computed per day against each
employee's work schedule. Approval freezes the totals at the signed-off figure.

**Reports.** Thirteen types behind one engine: each definition returns columns
and rows, so one table renders all of them and one writer exports all of them.
Durations show as `7h 30m` on screen and decimal hours in CSV, because a
spreadsheet cannot sum the former.

**Alerts.** The SMTP connector is configured in the platform console (Super Admin
-> Email connector), not in the environment: one place to set it, changeable
without shell access or a restart, with a test-send button and the password
encrypted at rest. Email is then driven by a separate process
(`python -m app.alerts run`) on a cron or Scheduled Task, never by the web app — an in-process scheduler fires once
per uvicorn worker and dies silently with it. Every alert goes through one
dispatcher that claims a de-duplication key before sending, so a condition that
stays true ("this agent has been silent since 16:02") produces one message, not
one per tick. People set their own preferences at `/notifications`; security and
pay-related notices cannot be switched off.

**Billing.** ₹5,000/year base + ₹200/employee/month, integer paise throughout,
18% GST. Razorpay checkout with webhook confirmation; with no API keys configured
it runs a simulated flow so signup is testable end to end.

---

## How tracking works

```
 ┌───────────────┐   1s sample loop     ┌──────────────┐
 │ OS foreground │ ───────────────────► │  Segmenter   │
 │ window + idle │                      │ merges runs  │
 └───────────────┘                      └──────┬───────┘
                                               │ segments
 ┌───────────────┐   interval capture          ▼
 │ Screen grab   │ ──────────────────► ┌──────────────┐  offline-safe
 │ (jpeg, scaled)│                     │ SQLite spool │  survives reboot
 └───────────────┘                     └──────┬───────┘
                                              │ batched HTTPS
                                              ▼
                                    ┌────────────────────┐
                                    │ FastAPI ingest API │
                                    │ classify → attribute│
                                    └────────────────────┘
```

Consecutive samples describing the same thing collapse into one segment with
`duration`, `active` and `idle` seconds — one row per second per employee would
be ~30k rows/day/head.

**Offline.** Everything is written to a local SQLite spool first and deleted only
once the server acknowledges it. Ingest is idempotent on `client_uid`, so a
half-failed upload replays without double-counting.

---

## Storage

`STORAGE_BACKEND=local` (default) or `s3`. Both sit behind one interface; nothing
outside `services/storage.py` builds a path or knows which is in use.

Local streams bytes through the API, enforcing access control per request. S3
issues a short-lived presigned URL and redirects — but only after the same
permission check. Works with AWS S3, MinIO, Cloudflare R2 and Wasabi via
`S3_ENDPOINT_URL`.

---

## Database migrations

Alembic owns the schema. The application does **not** create tables — it refuses
to start if the database revision does not match the code, rather than silently
patching over a missing migration.

```bash
alembic upgrade head
alembic revision --autogenerate -m "add x"
alembic current
```

Two things that will bite you otherwise, both already handled:

- **Constraints are named** by a convention on `Base.metadata`. SQLite rebuilds
  tables to alter them, and that requires every constraint to have a name.
- **`departments`/`teams`/`users` have a genuine FK cycle**, broken with
  `use_alter=True`. SQLite tolerates the cycle; Postgres refuses the schema.

When adding a `NOT NULL` column to a populated table, set `server_default` —
`default=` is Python-side only and the migration will fail.

---

## Compliance — read before deploying

Screenshot and URL monitoring is lawful in most jurisdictions **only with prior
notice to the monitored employee**, and under GDPR additionally requires a lawful
basis, a retention limit and usually a DPIA. The controls are on by default:

- `notice_required` — enrolment is refused with HTTP 412 until the employee
  acknowledges the notice, and the timestamp is stored against them.
- Always-visible tray icon while tracking. Do not remove it.
- Retention limits enforced by `python -m app.services.retention`, not merely
  displayed. Run it daily.
- `blur_screenshots` for lower-intrusion deployments.
- Per-org audit log of every settings change, enrolment and screenshot viewed.
- Suspending a company deactivates its agents — collection stops, not just the
  dashboard.

**Never captured:** keystroke content, clipboard, file contents, microphone or
camera. Input activity is derived from last-input *timestamps*, not a keyboard
hook, so no keystroke data exists anywhere in this system to leak or subpoena.

This is a workplace analytics tool for organisations monitoring their own managed
devices with employee notice. It is not built for covert surveillance.

---

## Known gaps

- **macOS and Linux agents are unvalidated.** Written against their platform APIs
  but never run on real hardware. Treat as needing a validation pass.
- **Wayland is unsupported** — it denies clients access to other windows. The
  Linux tracker raises there and the agent degrades to a null tracker rather than
  silently reporting nothing.
- **Browser URLs** use UI Automation (Windows) and AppleScript (macOS), with
  window-title heuristics as a fallback. For production accuracy, ship the
  companion browser extension.
- **Lines of code is not measured** and will not be. It is not observable from
  outside the editor, and keystroke-derived estimates reward verbose code. The
  Coding Activity report covers repository, branch and time instead.
- **No rate limiting on `/signup/*`.** Public endpoints — put nginx or Cloudflare
  limits in front before launch.
- **Email is sent synchronously.** Move to a queue before real volume.
- **`app.seed --reset` drops every table.** Development only.
