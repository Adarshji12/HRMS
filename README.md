# HRDeskTimeSol

Multi-tenant **HRMS + workforce-analytics SaaS**. One product with two halves that
share a tenant, a permission model and a database: a full HR suite (people,
attendance, leave, payroll, expenses, performance, lifecycle) and a desktop
time-and-activity tracker that most HRMS products do not have.

| Component | Stack | Path | Size |
|---|---|---|---|
| API server | Python 3.12 · FastAPI 0.115 · SQLAlchemy 2 · Alembic · Postgres/SQLite | [server/](server/) | ~66.7k LOC |
| Admin console | React 18 · TypeScript 5.7 · Vite 6 · plain CSS | [admin/](admin/) | ~68.7k LOC |
| Desktop agent | Python 3.12 · pywin32 / pyobjc / python-xlib | [agent/](agent/) | ~3.5k LOC |

**Measured surface** (regenerated from the code, not estimated):

| | |
|---|---|
| API operations | **475** across 371 paths, 35 routers, 380 response schemas |
| Database tables | **120** |
| Alembic migrations | **43** |
| Console pages | **88** components over **93** routes |
| Gateable modules | **15**, all live |
| Permissions | **19** keys × **4** data scopes |
| Approval flows | **7**, of which **6** support multi-level chains |
| Report types | **21** behind one engine |
| Background jobs | **6** |
| Notification kinds | **17** |
| Server tests | **1774 passed, 4 skipped** (6m32s) |

The desktop agent is not optional for the tracking half. Foreground-window
enumeration, window titles, browser URLs and screen capture are all OS-level
APIs — no browser can reach them. The HRMS half works fully without it.

> Companion docs: [ARCHITECTURE.md](ARCHITECTURE.md) (design decisions),
> [DEPLOYMENT.md](DEPLOYMENT.md) (running it in production),
> [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) (tokens, components, every page),
> [HRMS_PROGRESS.md](HRMS_PROGRESS.md) (module status and conventions).

---

## 1. Quick start

```bash
# 1. API
cd server
python -m venv .venv && .venv\Scripts\activate     # source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env
alembic upgrade head
python -m app.seed --demo-data          # demo company, staff, projects, activity
python -m app.platform_setup            # Super Admin — password printed once
uvicorn app.main:app --reload --port 8000

# 2. Console
cd admin && npm install && npm run dev

# 3. Agent (optional — only for time tracking)
cd agent
python -m venv .venv && .venv\Scripts\activate
pip install -r requirements.txt
python -m agent.main --login you@acme.demo --org demo --server http://127.0.0.1:8000
python -m agent.main
```

| Surface | URL | Credentials |
|---|---|---|
| Company console | `http://demo.localhost:5180` | `admin@acme.demo` / `admin12345` |
| Public signup | `http://localhost:5180/signup` | — |
| Super Admin | `http://localhost:5180/platform` | printed by `app.platform_setup` |
| API docs | `http://localhost:8000/docs` | — |

Demo activity spans roughly the last week; set date filters to that range.

---

## 2. Architecture

```
                      ┌──────────────────────────────────────────┐
   employee laptop    │            FastAPI  (server/)            │
  ┌───────────────┐   │                                          │
  │ Desktop agent │──►│  /api/v1/agent/*     device token        │
  │  SQLite spool │   │  ─────────────────────────────────────   │
  └───────────────┘   │  /api/v1/*           user bearer token   │◄── React console
                      │  /api/v1/platform/*  operator token      │◄── Super Admin
                      │                                          │
                      │  tenancy → auth → RBAC → plan gate       │
                      └───────────┬──────────────┬───────────────┘
                                  │              │
                     ┌────────────▼───┐   ┌──────▼────────────┐
                     │ Postgres       │   │ Object storage    │
                     │ 120 tables     │   │ local | S3/R2     │
                     └────────────────┘   └───────────────────┘
                                  ▲
                     ┌────────────┴─────────────┐
                     │ Scheduler — 6 jobs       │
                     │ alerts · retention ·     │
                     │ attendance · accrual ·   │
                     │ comp-off · CRM reminders │
                     └──────────────────────────┘
```

**Every request passes four gates, in this order.** They are separate on purpose
— each answers a different question, and collapsing any two of them is how a
cross-tenant leak gets written.

| Gate | Question | Where |
|---|---|---|
| Tenancy | *Which company is this request about?* | [tenancy.py](server/app/api/tenancy.py) |
| Authentication | *Who is calling, and is their token valid **on this tenant**?* | [deps.py](server/app/api/deps.py) `get_current_user` |
| Authorization | *May this person do this, and whose data may they see?* | `deny_unless` → `User.has()` → `OrgRole` |
| Entitlement | *Has this company paid for this module?* | `require_module` in [router.py](server/app/api/v1/router.py) |

---

## 3. Multi-tenancy and identity

Tenants live at `<slug>.<BASE_DOMAIN>`. In development `*.localhost` resolves to
127.0.0.1 in every modern browser, so `demo.localhost:5180` works with no DNS
setup. A request resolves its tenant from the `Host` header, falling back to an
`X-Org-Slug` header for API clients and the dev proxy.

Resolution is **not** an authorization decision — naming a tenant grants nothing.
It only decides which organisation's user table a login is checked against.

**Login is tenant-scoped.** Email is unique *within* an organisation, not
globally, so a global lookup would return an arbitrary one of several matching
accounts. A bearer token additionally carries its `org` and is rejected on any
other tenant — two independent checks, because one missed filter in one handler
would otherwise be a cross-tenant leak.

**Three token types, three principals:**

| Principal | Table | Token carries | Endpoint family |
|---|---|---|---|
| Employee / admin | `users` | `sub`, `org` | everything under `/api/v1` |
| Device | `devices` | device id | `/api/v1/agent/*` |
| Platform operator | `platform_admins` | `sub`, no org | `/api/v1/platform/*` |

Super Admin lives in a separate table with its own token type. An operator has no
`org_id`, and every tenant query filters on one — a platform role inside `users`
would need an exception in each of those filters.

---

## 4. Authorization — roles, permissions, data scope

Permissions used to live on the *person*: nineteen booleans on every `users` row,
ticked one employee at a time. They now live on a **named role** per company
(`org_roles`), and a role separates three things real companies vary
independently.

### 4.1 What you can do — the permission set

```
can_view_screenshots      can_approve_timesheets     can_export_data
can_manage_projects       can_approve_leave          can_approve_regularization
can_punch_anywhere        can_manage_assets          can_manage_onboarding
can_manage_helpdesk       can_manage_people          can_issue_letters
can_approve_expenses      can_reimburse_expenses     can_approve_loans
can_disburse_loans        can_manage_payroll         can_manage_performance
can_manage_engagement
```

An absent key is `False`, so a permission added to the product later defaults to
off for every role that predates it — the safe direction.

### 4.2 What you can see — `DataScope`

Genuinely new, and the reason the rework was worth doing. The old model
*inferred* scope from role level, so somebody who must see the whole company's
expenses but manages nobody could only be expressed by making them an
administrator — handing them payroll and settings to solve a reporting problem.

| Scope | Sees |
|---|---|
| `self` | their own record only |
| `team` | their reporting subtree, plus any team or department they head |
| `department` | their whole department |
| `company` | everyone |

Resolved in exactly one place: `services/hierarchy.visible_user_ids`.

### 4.3 Which built-in level it stands in for — `base_role`

The coarse `can_administer` / `can_view_team` checks predate named roles and are
load-bearing in about a hundred places, so every custom role declares which of
the four built-ins it behaves as rather than those checks being rewritten.

**Four built-in roles**, seeded per organisation and undeletable:

| Role | Base | Scope | Permissions |
|---|---|---|---|
| Owner | `owner` | company | all 19, plus owner-only settings (outbound mail, billing) |
| Administrator | `admin` | company | all except `can_manage_payroll` — salaries never come free with a role |
| Manager | `manager` | team | screenshots, timesheets, export, projects, leave, regularization, expenses |
| Employee | `employee` | self | none |

### 4.4 Resolution order

Per-person overrides still exist (`users.permission_overrides`) for the one
exception a whole role should not be created for:

```
permission_overrides[flag]  →  org_role.allows(flag)  →  legacy column
```

One change in `deps.deny_unless` routed all 44 existing check sites through this
without touching any of them.

---

## 5. Modules and plan gating

15 gateable modules, declared once in [core/modules.py](server/app/core/modules.py)
and read by four consumers: the plan catalogue, the Super Admin grants screen,
`require_module`, and the console navigation. A module that is one entry there
appears in all four automatically — the only way to ship a half-registered module
is to not add it at all.

| Key | Module | Group | What it owns |
|---|---|---|---|
| `core_hr` | Core HR | People | Employee master records, statutory identity, documents, probation, directory |
| `letters` | Letters | People | Offer, appointment, confirmation, experience, relieving letters from templates |
| `attendance` | Attendance | Workforce | Punch in/out, geofenced offices, shift schedules |
| `regularization` | Regularization | Workforce | Wrong/missing punch corrections, manager-decided |
| `leave` | Leave | Workforce | Leave types, balances, holiday calendar, applications |
| `onboarding` | Onboarding | Lifecycle | Joining checklists, task templates, document collection |
| `offboarding` | Offboarding | Lifecycle | Exit workflow, departmental clearance, full-and-final |
| `expenses` | Expense claims | Operations | Claims with receipts, approval, reimbursement tracking |
| `payroll` | Payroll | Operations | Structures, components, pay runs, statutory, TDS, Form 16 |
| `loans` | Loans & advances | Operations | Advances with instalment schedule and outstanding balance |
| `assets` | Assets | Operations | Asset register and per-employee custody |
| `performance` | Performance | Operations | Appraisal cycles, weighted goals, competencies, reviews |
| `engagement` | Engagement | Operations | Announcements with read receipts, anonymous pulse surveys, recognition |
| `helpdesk` | Helpdesk | Operations | Employee tickets and HR support queue |
| `crm` | CRM & Lead Generation | Revenue | Leads, follow-ups, field visits, support desk, customers, quotations, WhatsApp reminders |

**The gate is attached once per module in `api/v1/router.py`**, not inside each
router — one line in the file the lead owns, so no module author can forget it or
apply it to five of their six routes. An empty `plan.modules` means *every*
module, so nothing is gated until an operator deliberately restricts a plan.

Deliberately **ungated**: `auth`, `agent`, `admin`, `org`, `roles`, `projects`,
`timesheets`, `notifications`, `chat`, `meetings`, `approvals`, `chains`,
`reports`. The activity/timesheet pipeline predates gating and is what the
product *is* — a company with no modules granted still tracks time. Chat and
meetings are how a workspace runs itself, not something anyone buys. The
approvals queue and chain configuration are views over whichever flows a company
already has: gating them on one module would hide leave requests from a company
that never bought expenses.

**Three plans** ([core/plans.py](server/app/core/plans.py)), editable by an
operator without a deploy:

| Plan | Seats | Screenshot retention | Storage | Price |
|---|---|---|---|---|
| Free Trial | 1–5 | 14 days | 2 GB | ₹0 for 14 days |
| Standard | 1–500 | 90 days | 250 GB | ₹5,000/yr + ₹200/employee/month |
| Enterprise | 100–100,000 | 10 years | 10 TB | same, plus SSO/SCIM, DPA, custom retention |

Integer paise throughout, 18% GST. Razorpay checkout with webhook confirmation;
with no API keys configured it runs a simulated flow so signup is testable end to
end.

---

## 6. The API surface — 475 operations

`GET 199 · POST 186 · DELETE 37 · PATCH 31 · PUT 22`

| Prefix | Ops | Owns |
|---|---:|---|
| `/api/v1/crm` | 57 | Leads, statuses, sources, dispositions, follow-ups, visits, customers, quotations + lines, products, plans, reminders, geography, public intake webhook |
| `/api/v1/admin` | 31 | Employee CRUD, devices, enrolment keys, org settings, tracking policy, productivity rules, screenshots, dashboard summary |
| `/api/v1/platform` | 25 | Super Admin: companies, suspend/activate, module grants, plans, subscriptions, mail connector, health, audit |
| `/api/v1/org` | 21 | Departments, teams, designations, shifts, work schedules, office locations, holidays |
| `/api/v1/leave` | 21 | Types, balances, applications, decisions, holiday calendar, optional-holiday opt-ins, comp-off |
| `/api/v1/expenses` | 20 | Categories, claims, lines, receipts, approval, reimbursement, payments |
| `/api/v1/helpdesk` | 20 | Categories, tickets, comments, assignment, queue |
| `/api/v1/attendance` | 19 | Punch in/out, work mode, geofence check, records, settings, team view |
| `/api/v1/payruns` | 18 | Pay runs, compute, approve, pay, payslips, bank file and payslip PDF outputs |
| `/api/v1/onboarding` | 18 | Templates, template tasks, instances, tasks, document collection |
| `/api/v1/performance` | 18 | Review cycles, goals, competencies, ratings, reviews |
| `/api/v1/engagement` | 17 | Announcements + read receipts, surveys, questions, responses, recognitions |
| `/api/v1/projects` | 16 | Projects, members, attribution rules, time entries |
| `/api/v1/letters` | 16 | Templates, merge fields, issue, download |
| `/api/v1/offboarding` | 15 | Exit requests, clearance tasks, full-and-final + lines |
| `/api/v1/chat` | 14 | Channels, members, messages, read markers |
| `/api/v1/people` | 14 | Employee profiles, statutory identity, documents, probation, directory |
| `/api/v1/loans` | 11 | Loans, instalment schedule, approval, disbursement, payroll deduction |
| `/api/v1/tax` | 11 | Income-tax declarations and items |
| `/api/v1/payroll` | 10 | Salary structures + components, pay components |
| `/api/v1/assets` | 10 | Asset register, assignment, custody history |
| `/api/v1/workflow` | 10 | Chain levels, effective chain, per-record chain, rules, preview, escalation sweep |
| `/api/v1/agent` | 9 | Enrol, login, config, projects, heartbeat, session start/end, activity batch, screenshot |
| `/api/v1/timesheets` | 8 | Timesheet build, submit, approve, entries |
| `/api/v1/signup` | 7 | Plans, quote, slug check, start, trial, confirm, simulate payment |
| `/api/v1/statutory` | 6 | PF/ESI/PT config, professional-tax slabs |
| `/api/v1/form16` | 6 | Form 16 generation and download |
| `/api/v1/roles` | 5 | Named roles CRUD, permission catalogue |
| `/api/v1/meetings` | 5 | Meetings, invitees |
| `/api/v1/regularization` | 5 | Correction requests and decisions |
| `/api/v1/auth` | 3 | Tenant info, login, me |
| `/api/v1/notifications` | 3 | Preferences, catalogue |
| `/api/v1/reports` | 3 | Report catalogue, run, export |
| `/api/v1/approvals` | 2 | Unified pending queue, counts |
| `/health` | 1 | Liveness |

Regenerate any time:

```bash
cd server
.venv/Scripts/python.exe -c "from app.main import app; import json; print(json.dumps(app.openapi()))" > openapi.json
```

The console reaches all of it through one client,
[admin/src/lib/api.ts](admin/src/lib/api.ts), which attaches the bearer token and
`X-Org-Slug` to every call and surfaces the server's machine-readable
`{reason, message}` refusals as a typed `ApiError`.

---

## 7. Core flows

### 7.1 New company onboarding (public signup)

```
company details → admin details → plan → payment → activation → login
```

Runs on the marketing host, so nothing here uses tenant resolution — the tenant
does not exist yet. Everything is public and written defensively: existence of a
slug is the only thing these endpoints will confirm, and an abandoned signup can
be resumed but never hijacked.

| Step | Call | Result |
|---|---|---|
| 1 | `GET /signup/plans` | public plan catalogue |
| 2 | `GET /signup/check-slug?slug=acme` | availability only |
| 3 | `POST /signup/quote` | seats × plan → base + seats + 18% GST |
| 4a | `POST /signup/trial` | 14-day trial, no payment, activated immediately |
| 4b | `POST /signup/start` | creates a Razorpay order; the org stays pending |
| 5 | `POST /signup/confirm` *(or `/webhook`)* | verifies the signature, activates |
| 6 | — | seeds `OrgSettings`, the 4 built-in roles, default productivity rules, the owner user and an enrolment key; sends the welcome mail |
| 7 | `POST /auth/login` on `acme.<domain>` | first login |

With no Razorpay keys configured, `POST /signup/simulate-payment/{order_id}`
completes the flow so the whole path is testable locally.

### 7.2 Agent enrolment and sync

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
                                    ┌──────────────────────┐
                                    │ FastAPI ingest       │
                                    │ classify → attribute │
                                    └──────────────────────┘
```

1. `POST /agent/enroll` with a 16-character enrolment key, **or**
   `POST /agent/login` with the employee's own credentials. Both return a device
   token. Enrolment is refused with **HTTP 412** until the employee has
   acknowledged the monitoring notice — the timestamp is stored against them.
2. `GET /agent/config` — tracking policy (screenshot interval, blur, idle
   threshold, working hours). Re-read on every heartbeat, so a policy change
   applies with no redeploy and no agent update.
3. `POST /agent/heartbeat` — updates `last_seen_at`, reports whether screen
   capture is blocked by the OS, and returns the current policy **with the
   employee's work schedule applied as an override**, so choosing 10:00–19:00 for
   the support team actually changes when their agents collect. A lapsed or
   suspended organisation revokes here, and the agent stops and wipes its spool
   rather than queueing data forever against an account that cannot receive it.
4. `POST /agent/session/start` and `/session/end` — work sessions.
5. `POST /agent/activity` — up to 500 segments per batch. The server deduplicates
   on `client_uid` in a single query, then classifies each segment (productive /
   neutral / unproductive) and attributes it to a project. Both the classifier
   and the attributor are built once per batch, not per segment — a 200-segment
   upload would otherwise be 400 extra queries.
6. `POST /agent/screenshot` — multipart JPEG, scaled and optionally blurred.

**Nothing is uploaded straight from memory.** Every segment and screenshot is
committed to the local SQLite spool first and removed only once the server
acknowledges it, so an agent runs for days without a network and loses nothing. A
crash mid-upload duplicates rather than drops, and ingest is idempotent.
Screenshot *bytes* live as files beside the spool database rather than as blobs,
so a few hundred 200 KB captures do not bloat a user's SQLite file.

**Segmentation.** One row per second per employee would be ~30k rows/day/head.
Consecutive samples describing the same thing collapse into one segment carrying
its active/idle split. A segment closes when the focused app, window title or URL
changes; when the machine crosses the idle threshold or returns from it; or at
`max_segment_s`, so a long unattended stretch still appears on the timeline at a
sane granularity.

**Attribution precedence**, strict: manual assignment > the employee's tray
selection > pattern rules (app, domain, window title, git repository). A rule
guesses, so it never overwrites what a person decided.

### 7.3 Approvals — one kernel, seven flows, six chains

Seven things in this system are approved by somebody. They were written
separately and drifted: the self-review guard lived in the router for two flows
and the service for three; the owner exemption was inconsistent; timesheet
approval had no already-decided guard at all, so approving one twice silently
re-froze a different set of minutes over the first decision.
[services/workflow.py](server/app/services/workflow.py) is now a single decision
kernel those flows declare their rules to.

**The kernel owns exactly four things**, and deliberately no more:

1. Refusing a second decision on a decided record.
2. Refusing self-review, per the flow's declared policy.
3. Requiring a reason on rejection — a rejection with no reason guarantees the
   identical request comes back tomorrow.
4. Stamping and auditing the decision identically everywhere.

Everything else stays in the flow's own service: what a leave debit does, which
attendance rows an approval rewrites. Those are not workflow, they are the thing
being approved.

| Flow | Chain-capable | Side effect on final approval |
|---|---|---|
| `leave` | yes | debits the balance |
| `timesheet` | yes | freezes the totals |
| `regularization` | yes | rewrites the attendance row |
| `expense` | yes | moves to reimbursable |
| `loan` | yes | opens the instalment schedule |
| `performance` | yes | publishes the review |
| `settlement` | no | full-and-final payout |

**Multi-level chains** ([services/chains.py](server/app/services/chains.py))
decide *who decides next* — up to five levels, configured per flow and optionally
per department at `/settings/approvals`. A level says **how** to find its
reviewer: the requester's manager, that manager's manager, the department head, a
named person, or anybody holding the flow's capability. Relationships rather than
names, because a chain naming Priya breaks the day Priya changes team.

Three rules worth knowing:

- **No configured chain means exactly the behaviour that came before.** Every
  function returns `None` or `[]` when a flow has no levels, the kernel takes its
  original single-step path, and no step rows are written. That is the correct
  default rather than a compatibility shim — a two-person company routing leave
  through three levels is a company where nothing gets approved.
- **A rung resolving to nobody is written unassigned and the chain stops there.**
  It is not skipped: a level with no reviewer is a configuration problem somebody
  must see, and skipping it would approve things through a gate that was supposed
  to exist, silently — the worst of the three options.
- **A rung resolving to the requester is skipped**, and recorded as such. Common
  at the top of a reporting tree, where the department head's own claim routes to
  the department head.

An intermediate approval leaves the record **untouched and still pending** — it
has not been approved, it has been approved by one person — and the side effect
does not run. Only the last rung stamps the record. A department chain
**replaces** the company one for its people; it does not add to it.
`POST /workflow/sweep` escalates rungs that have gone unanswered.

`GET /approvals` is the unified queue across whichever flows a company has, each
flow's adapter applying its own permission rule.

### 7.4 Attendance — punch to day close

[services/attendance.py](server/app/services/attendance.py) owns every write to
`attendance_records` that is *not* a regularization; the approval path owns that
one, and the two must not both claim a row.

1. **Punch in** — `POST /attendance/punch-in` with a work mode
   (`office` / `work_from_home` / `on_duty`) and optional coordinates.
2. **Geofence is evaluated per work mode.** Each mode carries its own enforcement
   setting, so an office punch can be required to be on site while a
   work-from-home punch is not. **A punch outside every geofence is a success** —
   the row is written, `is_geo_verified_*` is `False`, and `check_in_distance_m`
   records how far. Only `geofence_enforcement = required` refuses, and it is the
   one mode that can lock a tenant out. Denied geolocation is the normal path,
   not the error path.
3. **Punch out** — worked minutes computed against the shift in force that day.
4. **The `attendance_status` job closes the previous local day, hourly.** Hourly
   rather than nightly, and that is the whole design: it finalises the previous
   day for the organisations whose *local* clock has just passed the target hour.
   A single fixed-UTC run would stamp "absent" for an IST tenant at 05:30 local —
   half an hour before the person it just marked absent walks in.
5. A row whose `check_in_source` or `check_out_source` is `regularized` is **never
   touched** by anything derived. A human decision outranks a computed one.

A missing `attendance_settings` row means defaults, and stays missing — reading
policy never inserts, because a lazy insert turns every GET into a write and
races itself under two concurrent punches.

The stored `status` is a day classification, never a verdict about punctuality:
late/early/half-day verdicts are computed at read time against that day's shift
and are never persisted.

### 7.5 Payroll — draft to bank file

```
draft ──compute──► computed ──approve──► approved ──pay──► paid
  ▲                    │
  └──── recompute ─────┘        (frozen from `approved` onward)
```

Five rules that matter:

- **Compute is a replace, not a merge.** Recomputing a draft deletes every
  payslip and builds them again from current data. Merging would leave a payslip
  for somebody who has since left and a stale line for a loan that closed —
  precisely the rows nobody notices until the bank file is wrong.
- **Approval freezes.** After it, nothing recomputes and no line changes. The
  fourth instance of that rule in this codebase, after timesheet approvals,
  issued letters and salary structures, and for the same reason each time: the
  figure that was signed off must not move.
- **Paying applies side effects, once.** Loan instalments become paid, expense
  claims become reimbursed — on the `paid` transition, not on approval, because
  those are statements that money moved and it has not moved yet at approval.
- **Loss of pay is derived, not typed.** Unpaid approved leave is summed from the
  leave module in the milli-days unit leave already uses, so nothing converts at
  the boundary. An override exists for what leave cannot know about, and it is
  recorded *as* an override rather than silently replacing the derived figure.
- **Every line sums to the payslip and every payslip to the run.** Proration
  divides and division loses paise, so earnings use the same largest-remainder
  method as the loan schedule and still add to the prorated gross exactly.

Statutory deductions (PF, ESI, professional tax) are computed by
[services/statutory.py](server/app/services/statutory.py) from the **structure
lines only** — reimbursing somebody's taxi fare must not raise their PF, their
ESI or their professional-tax band.

**TDS is a projection, not a monthly slab**: the year's estimated liability less
what has already been deducted, spread over the months that remain. That is why
somebody's TDS moves when they declare an investment in December — the remaining
months absorb the whole correction. Year-to-date figures come from this company's
own earlier payslips, so a mid-year salary revision re-projects from the month it
takes effect.

### 7.6 The other module flows, one line each

| Flow | Path |
|---|---|
| **Leave** | apply → chain → approve → balance debited. The accrual job credits a cumulative target daily; comp-off credits expire on their own job |
| **Regularization** | employee flags a wrong or missing punch → manager decides → attendance row rewritten and locked against derived writes |
| **Expenses** | claim + lines + receipts → chain → approved → reimbursed → payment recorded, or settled through a pay run |
| **Loans** | request → chain → approve → disburse → instalment schedule → deducted per pay run until closed |
| **Onboarding** | template → instance per joiner → tasks and document collection → completion |
| **Offboarding** | exit request → departmental clearance tasks → full-and-final with lines → settlement |
| **Performance** | review cycle → weighted goals and competencies → ratings → review → chain → published |
| **Engagement** | announcements with read receipts · anonymous pulse surveys · peer recognition |
| **Helpdesk** | ticket → category → assignment → comments → resolution |
| **Assets** | register → assignment to an employee → custody history → return |
| **Letters** | template + merge fields → issued against an employee → immutable once issued |
| **CRM** | lead → status and disposition → follow-ups and field visits → customer → quotation + lines → scheduled WhatsApp reminders |

---

## 8. Console navigation

15 module groups plus two top-level rows, 76 links, one source of truth in
[admin/src/lib/nav.tsx](admin/src/lib/nav.tsx) — which also drives the breadcrumb,
the command palette and the module navbar. Every row points at *the first page
the reader can actually open*, not a fixed one: an employee holds none of
Payroll's administration pages, so a row hard-wired to `/payroll/runs` would be a
link into a permission bounce.

| Module | Pages |
|---|---|
| **Dashboard** | Company · Time & Work · Attendance · Leave · Expenses |
| *Home* | `/home` — top-level row |
| *Approvals* | `/approvals` — top-level row |
| **Teams** | Chat · Meetings |
| **Employee** | Employees · Hierarchy · Directory ‖ Letters · Letter templates ‖ My profile · My letters |
| **Workforce Management** | Overview ‖ My attendance · Team attendance ‖ My leave · Team leave |
| **Payroll** | My salary · My payslips · Tax declaration · My Form 16 ‖ Overview · Pay runs · Salary structures · Pay components · Tax declarations · Year end & Form 16 |
| **Expenses** | My expenses · Approvals · Payments ‖ My loans · Loans & advances · Loan deductions |
| **Workflow** | Approval chains |
| **Desk Monitor** | Timesheets · Time & Activity · Apps & Websites · Screenshots · Projects · Reports |
| **Asset Management** | My assets · All assets |
| **Helpdesk** | Helpdesk · Ticket queue |
| **Joiners & Leavers** | My onboarding · Onboarding · Offboarding |
| **Noticeboard** | Noticeboard · Communication |
| **Performance** | My performance · My review · Appraisals |
| **CRM** | Lead Dashboard · My Leads · My Follow-ups · My Visits · My Support Center ‖ My Customers · Quotations · Daily Reminders · Settings |
| **Settings** | Company profile · Roles & Permissions · Teams & Departments · Notifications · Email setup · Subscription & Billing ‖ Desk Monitor · Attendance · Leave · Expenses · Payroll |

`‖` marks a section break within the module navbar.

**Chrome without extra URLs.** Module pages are wrapped in a pathless React
Router layout route rendering
[ModulePanel](admin/src/components/ModulePanel.tsx), which adds the horizontal
navbar without changing any address. It renders a bare `<Outlet/>` when a module
has one visible page — a bar holding the single page you are already looking at
is chrome answering a question nobody asked, and it happens for real: an
employee's Settings is Notifications alone.

---

## 9. Frontend architecture

**Three runtime dependencies**: `react`, `react-dom`, `react-router-dom`. No
component library, no state library, no CSS framework.

**Plain global CSS.** No Tailwind, no CSS Modules, no CSS-in-JS. Vite
concatenates every stylesheet into one bundle, so **there is no scoping** — a
class name is global whether or not it was written that way. Prefix every module
stylesheet (`.pnl-*`, `.crm-*`, `.hr-*`) and grep before inventing a class.

**Design tokens** live in [admin/src/styles.css](admin/src/styles.css): spacing,
type, radius, motion and duration scales, plus two palettes that must never be
mixed — `--brand-*` for chrome and `--prod` / `--seq-*` / `--series-*` for data.
Theming is three-state: `system` (no attribute), `[data-theme="light"]`,
`[data-theme="dark"]`.

**Navigation is one visual language at two levels.** The module navbar
(`.pnl-bar`) and the in-page tab strip (`.tabs`) are the same object — a card of
pills with a brand-tinted selection. A strip nested under a module navbar drops
to `--surface-2` with no shadow, so the two read as two levels of one system
rather than two components. The selected pill travels on both axes, so it lands
correctly on a bar that has wrapped to a second row.

Full catalogue of tokens, components and all 88 pages:
[DESIGN_SYSTEM.md](DESIGN_SYSTEM.md).

---

## 10. Background jobs

Six jobs on fixed intervals in [app/scheduler.py](server/app/scheduler.py). A loop
in a container rather than cron, because the deployment unit is already a
container: cron inside one needs a second process manager, cron outside one needs
a host with the application installed, and either way the schedule lives
somewhere the application does not and drifts. Not APScheduler or Celery — six
jobs on fixed intervals do not justify a broker.

| Job | Every | Why that interval |
|---|---|---|
| `alerts` | 15 min | the agent-silence rule fires after 30, so a longer period means an alert arriving an hour after the machine went quiet |
| `retention` | 1 hour | hourly, not nightly: a nightly job honours a retention window only to within a day, and dumps one enormous delete instead of a steady trickle |
| `attendance_status` | 1 hour | closes the previous **local** day per organisation — see §7.4 |
| `leave_accrual` | 24 hours | daily though the policy is monthly: it credits a cumulative target, so extra runs are no-ops and a missed month is caught up. A job that is only correct if it fires exactly twelve times a year silently shortchanges people the first time a deploy overlaps the 1st |
| `comp_off_expiry` | 24 hours | expires comp-off credits past their window |
| `crm_reminders` | 1 hour | a reminder carries a time of day in the *organisation's* timezone; idempotent per reminder per day, so twelve runs cost eleven no-ops rather than eleven duplicate sends |

```bash
python -m app.scheduler          # run forever, in its own container
python -m app.scheduler --once   # anything due now, then exit
```

`RUN_JOBS_IN_PROCESS=true` runs them in a thread inside the API instead, for
free-tier hosting with no worker dyno. **Only correct under a single uvicorn
worker** — adding workers without also moving the scheduler back out means
duplicate alert mail.

---

## 11. Notifications and email

17 kinds behind one dispatcher
([services/notifications.py](server/app/services/notifications.py)), each
declaring its audience (employee / manager / admin) and whether it can be
switched off:

```
agent_silent · timesheet_decided · timesheet_due · approvals_pending
weekly_summary · billing_attention · capacity_warning · device_enrolled
regularization_submitted · regularization_decided · leave_applied
leave_decided · leave_cancelled · leave_balance_low · ticket_assigned
ticket_resolved · offboarding_completed
```

Every alert **claims a de-duplication key before sending**, so a condition that
stays true ("this agent has been silent since 16:02") produces one message, not
one per tick. People set their own preferences at `/notifications`; security and
pay-related notices cannot be switched off.

**The SMTP connector is configured in the platform console** (Super Admin → Email
connector), not in the environment: one place to set it, changeable without shell
access or a restart, with a test-send button and the password encrypted at rest.
With no connector configured, messages are written to the log rather than being
sent — nothing silently disappears.

---

## 12. Reports

21 types behind one engine. Each definition returns columns and rows, so one
table renders all of them and one writer exports all of them. Durations show as
`7h 30m` on screen and decimal hours in CSV, because a spreadsheet cannot sum the
former.

| Group | Reports |
|---|---|
| Time | Time · Activity · Device Activity Presence · Idle Time · Timesheet |
| Productivity | Productivity · Application · Website · Screenshot |
| People | Employee · Team |
| Work | Project · Coding Activity |
| Attendance | Late/Early Log · Regularization Log |
| Leave | Leave Balance · Leave Applications · Holiday Utilization |
| Assets | Asset Register · Assignment History |
| Onboarding | Onboarding Status |

"Device Activity Presence" keeps the key `attendance` because the console puts it
in the URL and changing it would break every saved link — the HRMS Attendance
module is ground truth about whether somebody was at work, and the two must not
share a title.

---

## 13. Data model

120 tables, by area:

| Area | Tables |
|---|---|
| Tenancy & identity | `organizations` `users` `org_settings` `org_roles` `platform_admins` `audit_logs` |
| Org structure | `departments` `teams` `designations` `shifts` `work_schedules` `shift_assignments` `office_locations` `holidays` |
| Tracking | `devices` `activity_segments` `screenshots` `work_sessions` `productivity_rules` |
| Projects & time | `projects` `project_members` `project_rules` `tasks` `time_entries` `timesheet_approvals` |
| Core HR | `employee_profiles` `employee_documents` |
| Attendance | `attendance_records` `attendance_settings` `regularization_requests` |
| Leave | `leave_types` `leave_settings` `leave_balances` `leave_applications` `comp_off_credits` `optional_holiday_opt_ins` |
| Payroll | `salary_structures` `salary_structure_components` `pay_components` `pay_runs` `payslips` `payslip_lines` `statutory_configs` `professional_tax_slabs` `tax_declarations` `tax_declaration_items` `form16s` |
| Money | `expense_categories` `expense_claims` `expense_lines` `loans` `loan_instalments` `payments` |
| Lifecycle | `onboarding_templates` `onboarding_template_tasks` `onboarding_instances` `onboarding_tasks` `onboarding_documents` `offboarding_requests` `offboarding_tasks` `offboarding_fnf` `offboarding_fnf_lines` |
| Approvals | `workflow_levels` `workflow_rules` `workflow_steps` |
| Performance | `review_cycles` `performance_goals` `performance_reviews` `competencies` `competency_ratings` |
| Engagement | `announcements` `announcement_reads` `surveys` `survey_questions` `survey_participants` `survey_responses` `survey_answers` `recognitions` |
| Assets & helpdesk | `assets` `asset_assignments` `helpdesk_categories` `helpdesk_tickets` `helpdesk_comments` |
| Letters | `letter_templates` `issued_letters` |
| Collaboration | `chat_channels` `chat_channel_members` `chat_messages` `chat_reads` `meetings` `meeting_invitees` |
| CRM | 24 tables, all `crm_*` |
| Billing & platform | `plans` `subscriptions` `mail_settings` `notification_prefs` `notification_log` |

---

## 14. Storage

`STORAGE_BACKEND=local` (default) or `s3`. Both sit behind one interface; nothing
outside [services/storage.py](server/app/services/storage.py) builds a path or
knows which is in use.

Local streams bytes through the API, enforcing access control per request. S3
issues a short-lived presigned URL and redirects — **but only after the same
permission check**. Works with AWS S3, MinIO, Cloudflare R2 and Wasabi via
`S3_ENDPOINT_URL`, with signature v4 (required by MinIO and newer AWS regions).

---

## 15. Migrations

Alembic owns the schema, 43 revisions. The application does **not** create tables
— it refuses to start if the database revision does not match the code, rather
than silently patching over a missing migration.

```bash
alembic upgrade head
alembic revision --autogenerate -m "add x"
alembic current
```

Three things that will bite you otherwise, all already handled:

- **Constraints are named** by a convention on `Base.metadata`. SQLite rebuilds
  tables to alter them, and that requires every constraint to have a name.
- **`departments` / `teams` / `users` have a genuine FK cycle**, broken with
  `use_alter=True`. SQLite tolerates the cycle; Postgres refuses the schema.
- **Adding a `NOT NULL` column to a populated table needs `server_default`** —
  `default=` is Python-side only and the migration will fail.

---

## 16. Testing

```bash
cd server && .venv/Scripts/python.exe -m pytest    # 1774 passed, 4 skipped, ~6m30s
cd admin  && npx tsc --noEmit && npm run build
```

46 server test modules. CI ([.github/workflows/ci.yml](.github/workflows/ci.yml))
runs the suite on SQLite for speed **and** exercises the migrations against
Postgres 16 — SQLite forgives things Postgres does not, so passing on SQLite
alone proves less than it appears to. The suite exists because a tenant-isolation
audit found the boundary intact; running it on every push is what keeps it that
way without anyone re-checking by hand.

The console has no unit tests. It is verified by driving the real application
with Playwright (`playwright-core` is a devDependency) and reading computed
styles — measured, not asserted.

---

## 17. Deployment

| Target | File | Shape |
|---|---|---|
| Docker Compose | [docker-compose.deploy.yml](docker-compose.deploy.yml) | 5 services: db · migrate · api · console · jobs |
| Render (free tier) | [render.yaml](render.yaml) | 3 services: Postgres · Docker web service · static site |
| Scripted release | [deploy/](deploy/) | preflight → backup → rehearse migration → deploy → verify → rollback |

The Render blueprint documents its own substitutions: `preDeployCommand` replaces
the migrate service, `RUN_JOBS_IN_PROCESS=true` replaces the jobs worker, and
**object storage is mandatory** — a free web service has no disk, so the local
backend would write captures into a container filesystem discarded on every
deploy and every wake from sleep. Expect the API to sleep after 15 minutes idle;
no data is lost when it does, because the agent spools locally and drains on the
next successful sync.

Full runbook: [DEPLOYMENT.md](DEPLOYMENT.md).

---

## 18. Compliance — read before deploying

Screenshot and URL monitoring is lawful in most jurisdictions **only with prior
notice to the monitored employee**, and under GDPR additionally requires a lawful
basis, a retention limit and usually a DPIA. The controls are on by default:

- `notice_required` — enrolment is refused with HTTP 412 until the employee
  acknowledges the notice, and the timestamp is stored against them.
- Always-visible tray icon while tracking. Do not remove it.
- Retention limits **enforced** by the hourly job, not merely displayed. An
  unenforced retention window is a promise being broken.
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

## 19. Known gaps

**Product**

- **No rate limiting on `/signup/*`.** Public endpoints — put nginx or Cloudflare
  limits in front before launch, or they are a free way to enumerate slugs and
  mint junk organisations. The router says so itself.
- **Email is sent synchronously.** Move to a queue before real volume.
- **macOS and Linux agents are unvalidated.** Written against their platform APIs
  but never run on real hardware. Treat as needing a validation pass.
- **Wayland is unsupported** — it denies clients access to other windows. The
  Linux tracker raises there and degrades to a null tracker rather than silently
  reporting nothing.
- **Browser URLs** use UI Automation (Windows) and AppleScript (macOS), with
  window-title heuristics as a fallback. Ship the companion browser extension for
  production accuracy.
- **Lines of code is not measured** and will not be. It is not observable from
  outside the editor, and keystroke-derived estimates reward verbose code. The
  Coding Activity report covers repository, branch and time instead.
- **`app.seed --reset` drops every table.** Development only.

**Repository state**

- `main` is 3 commits deep with **107 modified and 64 untracked files
  uncommitted** — the HRMS console rework, the RBAC migrations and `render.yaml`
  are all local only. A Render deploy from GitHub today builds the tree as of
  `216e86f`, which is why the last attempt failed on a missing Dockerfile.
- Two migrations (`c4e18a72d9f3_work_mode_punch`, `d5f29b41c7ea_named_roles`) are
  applied locally but not pushed.
- PWA icon PNGs are still the old violet mark; they are binary assets needing a
  re-export.
