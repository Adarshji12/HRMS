# HRMS Expansion — Team, Ownership and Phase Board

Execution record for the build specified in [HRMS_EXPANSION_PLAN.md](HRMS_EXPANSION_PLAN.md).
Ten senior engineers, one codebase. This file is how that stays true.

Architecture constraints come from [ARCHITECTURE.md](ARCHITECTURE.md) and are
binding, not advisory.

---

## 1. The team

Ten workstreams, each owned end-to-end by one senior engineer (10+ years).
Ownership means: you write it, you test it, you fix it in review.

| # | Role | Owns | Phases |
|---|---|---|---|
| 1 | **Tech Lead / Principal** | Shared files, migrations, integration, review, architecture doc | all |
| 2 | Sr. Backend — Attendance & Geofence | `attendance`, `geofence`, shifts, office locations | 0, 1 |
| 3 | Sr. Backend — Regularization | `regularization`, approval flow | 0, 2 |
| 4 | Sr. Backend — Leave | `leave`, balances, accrual, holidays, comp-off | 0, 4 |
| 5 | Sr. Backend — Onboarding | `onboarding`, templates, documents | 0, 6 |
| 6 | Sr. Backend — Offboarding | `offboarding`, clearance, F&F stub | 0, 7 |
| 7 | Sr. Backend — Assets | `assets`, custody lifecycle | 0, 8 |
| 8 | Sr. Backend — Helpdesk | `helpdesk`, tickets, comment visibility | 0, 9 |
| 9 | Sr. Frontend | All new console pages, employee/manager dashboards | 3, 5, 6–10 |
| 10 | QA / Test Engineer | Tenant isolation, concurrency tests, seed data | 0–11 |

### Why the split is by domain, not by layer

Every engineer owns a vertical slice — model, schema, service, router, tests —
rather than "all the models" or "all the routers". A layer split would make every
phase a four-way handoff and every merge a conflict. A domain split means the
only shared surface is the integration seam, and the lead owns that.

---

## 2. File ownership

**The rule that makes parallel work safe: nobody edits a file they do not own.**
An engineer needing a change in a shared file reports it; the lead applies it.
This is why seven people can write schema simultaneously without a single merge
conflict.

### Owned by exactly one engineer

| Path | Owner |
|---|---|
| `server/app/models/attendance.py`, `schemas/attendance.py`, `services/attendance.py`, `services/geofence.py`, `api/v1/attendance.py` | Dev 2 |
| `…/regularization.py` (model, schema, service, router) | Dev 3 |
| `…/leave.py` (model, schema, service, router) | Dev 4 |
| `…/onboarding.py` (model, schema, service, router) | Dev 5 |
| `…/offboarding.py` (model, schema, service, router) | Dev 6 |
| `…/assets.py` (model, schema, service, router) | Dev 7 |
| `…/helpdesk.py` (model, schema, service, router) | Dev 8 |
| `admin/src/pages/hrms/**` | Dev 9 |
| `server/tests/test_hrms_*.py` | Dev 10 |

### Lead-only (integration seam)

`models/__init__.py` · `api/v1/router.py` · `app/scheduler.py` · `core/config.py` ·
`models/user.py` · `app/seed.py` · `alembic/versions/**` · `admin/src/App.tsx` ·
`admin/src/lib/nav.tsx` · `services/report_builder.py` · `services/notifications.py` ·
`ARCHITECTURE.md`

Alembic migrations are lead-only for a specific reason: seven engineers
autogenerating migrations in parallel produces seven heads and a merge nobody can
review. One author, one linear history, one migration per logical change — which
is the granularity the existing twelve migrations already set.

---

## 3. Working agreement

Beyond the [ARCHITECTURE.md](ARCHITECTURE.md) conventions, which are assumed:

1. **Additive only.** No existing column, table, env var or endpoint changes
   meaning. New env vars are fallbacks, never live values for a configured tenant.
2. **Every new table carries `org_id`**, FK to `organizations` with
   `ondelete="CASCADE"` and an index — no exceptions, even where it looks
   redundant, because `test_tenant_isolation.py` will assert it.
3. **Thin handlers.** Logic lives in `services/`. A router function that contains
   business rules is a review failure.
4. **Named constraints, always.** SQLite cannot `ALTER`, so Alembic rebuilds the
   table and needs every constraint named to recreate it.
5. **Enums are `str, enum.Enum` stored as `String(N)`** — never SQLAlchemy
   `Enum()`, matching `Role`, `ProjectStatus`, `ApprovalStatus`.
6. **Money in paise**, integer, column suffixed `_paise`.
7. **Comments explain why, never what.** Document the decision and the failure it
   prevents. This codebase reads well and it stays that way.
8. **Do not touch:** the agent, the activity/timesheet/billing pipeline, the
   naming isolation in ARCHITECTURE.md §15, or `deploy/` (frozen — see §19).

---

## 4. Phase board

Phases run in order. A phase is done when its backend, UI and tests are wired —
never half-wired between layers.

| Phase | Scope | Owners | Status |
|---|---|---|---|
| **0** | Schema & contracts — models, schemas, migrations, seed | Devs 2–8, 10, Lead | ✅ complete |
| **1** | Attendance core — geofence, punch, nightly status job | Dev 2 | ✅ complete |
| **2** | Regularization — lifecycle, hierarchy approval, non-optional alert | Dev 3 | ✅ complete |
| **3** | Attendance + regularization UI | Dev 9a | ✅ complete |
| **4** | Leave backend — accrual, comp-off expiry, row-locked debit | Dev 4 | ✅ complete |
| **5** | Leave UI | Dev 9b | ✅ complete |
| **6** | Onboarding — templates, instances, documents, pre-boarding | Dev 5, Dev 9d | ✅ complete |
| **7** | Offboarding — clearance, device revocation, F&F stub | Dev 6, Dev 9d | ✅ complete |
| **8** | Assets — custody lifecycle, single-open-assignment invariant | Dev 7, Dev 9c | ✅ complete |
| **9** | Helpdesk — tickets, internal-note visibility split | Dev 8, Dev 9c | ✅ complete |
| **10** | Dashboards & reports — employee home, approvals inbox, 8 reports, plan gating | Dev 9e, Lead | ✅ complete |
| **11** | Hardening — isolation across every new table, fold into ARCHITECTURE.md | Dev 10, Lead | 🟡 one item open |

### Final totals

| | |
|---|---|
| Backend modules | **7 of 7** — attendance, regularization, leave, onboarding, offboarding, assets, helpdesk |
| New API routes | **105** (223 total across 17 routers) |
| New tables / migrations | **26 / 9** — additive, reversible, verified against real seeded data |
| Console pages | **18**, wired into routes + nav; typecheck and production build clean |
| Reports | **21** (13 original + 8 HRMS), every one executing against seeded data |
| Alert kinds | **17**, five of them non-optional |
| Scheduler jobs | **5** (2 original + 3 HRMS) |
| Tests | **847 passing, 3 skipped** — 127 baseline, 268 module tests, 452 isolation cases |

### Phase 11 — what the isolation sweep proved

`test_hrms_isolation.py`: 49 functions, **452 cases**, and **no isolation hole
found** across all seven modules.

Worth recording *how* it was proved, because a weaker version of each of these
passes while proving nothing:

- **Schema coverage walks `Base.metadata`, not a list of names**, so a table
  added in a later phase fails automatically rather than being silently
  uncovered. No HRMS table needed an exemption; the three pre-existing ones
  (`audit_logs`/`mail_settings` nullable `org_id`, `screenshots` unindexed) are
  asserted to *still be real*, so they cannot silently widen.
- **Both tenants are seeded before every read test.** A filter returning `[]` to
  everybody would pass a single-tenant version of this suite.
- **Leak checks recurse the whole JSON body** for any foreign UUID, not just the
  top-level `id`.
- **Every write test re-reads the row from a fresh session.** A status-code-only
  check would accept a 403 that had already committed.
- **Foreign ids planted in the request body** — own token, own host, own row in
  the URL, one field naming another tenant's row — followed by a sweep of every
  `Uuid` column for a stray cross-tenant pointer. The sweep has a **positive
  control** that plants one and requires it to be found, so a sweep that silently
  checked nothing would fail.
- **Per-org uniqueness is proved by collision**: both tenants create `LAP-001`,
  `Casual`, `General` and issue the same asset tag at once. A global unique index
  would break the second company to onboard — a bug you only meet in production.

### Still open in Phase 11

The manual demo-tenant walkthrough as owner, admin, manager and employee. Everything
else in the phase is done.

### Phase 0 — what shipped

26 new tables, 8 migrations, 82 exported model names, no service or router code
(Phase 0 is deliberately schema-only).

| Migration | Creates |
|---|---|
| `b1f0a9c8d7e6` | `users`: `status` + 5 permission flags (hand-written, see below) |
| `c4e1a7b02f11` | `regularization_requests` |
| `d5f2b8c13e22` | `office_locations`, `attendance_settings`, `shifts`, `shift_assignments`, `attendance_records` |
| `e6a3c9d24f33` | `leave_settings`, `leave_types`, `holidays`, `leave_balances`, `leave_applications`, `optional_holiday_opt_ins`, `comp_off_credits` |
| `f7b4d0e35a44` | `onboarding_templates`, `onboarding_template_tasks`, `onboarding_instances`, `onboarding_tasks`, `onboarding_documents` |
| `a8c5e1f46b55` | `offboarding_requests`, `offboarding_tasks`, `offboarding_fnf` |
| `b9d6f2a57c66` | `assets`, `asset_assignments` |
| `c0e7a3b68d77` | `helpdesk_categories`, `helpdesk_tickets`, `helpdesk_comments` |

Eight migrations rather than one, per §12. They were **sliced mechanically** from
a single autogenerate run rather than split by hand — 561 rendered lines divided
by eye is how a `create_index` goes missing — and the slicer asserts that every
table is claimed by exactly one migration.

**The `users` migration is hand-written**, and this is the one defect
autogenerate introduced. It renders the six new columns as
`add_column(..., nullable=False)` with **no** `server_default`. The model's
Python-side `default=` is applied by the ORM on insert and does nothing during
`ALTER TABLE`, so the generated version fails on any database that already
contains one user — i.e. every real one. `eb76bedd2dae` hit the same wall when it
added the first four permission flags and solved it with
`batch_alter_table` + `server_default`; this migration follows that precedent.

**Verified, not assumed:**

- `alembic upgrade head` on a **fresh** database — 20 migrations, clean.
- `alembic upgrade head` on a **copy of the real seeded dev database** (6 users,
  2,525 activity segments) — clean, and all six existing users backfilled to
  `status='active'` with flags on, which is the check the `server_default` fix
  exists for.
- **Full down/up round trip** (8 down, 8 up) with all rows intact.
- All three partial unique indexes present in `sqlite_master` **with their
  predicates**, and behaviourally tested: a second open asset assignment is
  rejected while re-assignment after return is accepted; a second pending
  regularization is rejected while re-filing after a rejection is accepted.
  Presence is not behaviour, so both were exercised with real rows.
- `app.seed` populates **all 26 new tables** on a fresh database and is
  idempotent across repeated runs. Coverage is asserted from the mappers, not
  eyeballed, so a table added in a later phase and never seeded fails the seed.
- Existing test suite green — **127 passed** — and the FastAPI app constructs
  against the new metadata.

Re-verified end to end after the D-024 reversal, since that reversal changed two
models and therefore two migrations.

---

## 5. Decision log

Decisions the spec left open, or explicitly asked to be settled early. Recorded
here so they are not re-litigated or quietly drifted from.

### D-001 · The "Attendance" report name collision — **resolved in Phase 0**

The spec (§10) required this be settled now rather than discovered in Phase 10:
the existing report catalogue already ships a report named **Attendance**, built
from device activity, and the new punch-based module deserves that name more.

**Decision:** retitle the existing report to **"Device Activity Presence"** and
leave its catalogue key `attendance` unchanged.

**Why the key stays:** the console puts the selected report key in the URL
(`?r=<key>`), so changing it silently breaks every bookmarked or shared link to
that report. A key that no longer matches its title is a small internal oddity;
a dead link somebody saved is a user-visible regression. The title is the part
anyone actually reads.

The spec's option (b) — merging both into one "Attendance Summary" showing
punch status and device signal side by side, which would expose proxy attendance
(punched in, no device activity all day) — is the better long-term answer and is
recorded as a **named Phase 10 follow-up**, exactly as the spec permits. It is
not silently dropped.

### D-002 · New permission flags — **implemented in Phase 0**

`can_approve_leave`, `can_approve_regularization`, `can_manage_assets`,
`can_manage_onboarding`, `can_manage_helpdesk` added to `users`, following the
existing flag semantics precisely: they **restrict, never grant**, and default
`True`, so existing accounts keep the behaviour they had and no backfill migration
is needed.

Leave approval and regularization approval are deliberately **separate** flags.
They are separate decisions in most companies: the team lead who signs off "you
were in the office at 09:15" is routinely not the person who signs off "you may
take nine days off", because only one of those spends a balance.

### D-003 · Org-local midnight for the nightly attendance job

The spec (§8) offered two approaches and asked for an explicit choice. **Taken:
option (a)** — the job wakes hourly and acts only on organisations whose local
time is currently in the target window. `organizations.timezone` already exists,
so this is barely more code than a fixed UTC run, and it means attendance
finalises at actual local midnight rather than at a different local hour per
tenant. To be documented in the job's own docstring, per the spec.

### D-004 · Regularization does not reuse `ApprovalStatus`

Dev 3 declined to reuse `timesheet.ApprovalStatus` (`draft`/`submitted`/
`approved`/`rejected`) and defined a three-member `RegularizationStatus`
(`pending`/`approved`/`rejected`). **Upheld.**

Regularization has no draft state, and the spec, API and UI all say `pending`.
Reuse would mean either persisting `"submitted"` under a UI reading "pending",
or admitting `"draft"` as a legal value every service then has to defend against.
An enum's value *is* its set of legal states; borrowing one whose states are
wrong is aliasing, not reuse. It would also couple the two lifecycles — if
timesheets later add a `RECALLED` state, regularization silently inherits a
state it has no code for.

### D-005 · Duplicate-pending is a database constraint, not a service check

Partial unique index on `(org_id, user_id, date) WHERE status = 'pending'`.

A plain `UniqueConstraint` would be wrong twice over: it forbids re-filing after
a rejection, and forbids correcting an already-approved day. A service-layer
check is a read-then-write, so two double-clicked submits interleave through it,
the manager's queue shows two identical rows, both get approved, and the second
write silently overwrites the first — an unattributable attendance edit, which
is the single failure this table exists to prevent.

**Cost accepted:** the predicate is dialect-specific and Alembic autogenerate
does not reliably emit it, so the Phase 0 migration is hand-corrected to carry
`sqlite_where` / `postgresql_where`. A one-time cost paid by one person, against
a race reproducible on any slow connection.

### D-006 · Re-filing against an already-approved day is allowed

The spec is silent here. **Ruling:** correcting a bad correction is legitimate.
Approving a later request overwrites `attendance_records` again and repoints
`regularization_id` at the newest approved request.

`attendance_records.regularization_id` is therefore a **convenience pointer, not
history** — after a second approval it names only the latest one. The durable
record is `regularization_requests`. Any audit view queries that table by
`(user_id, date)`; nothing may follow the FK and call the result an audit trail.

### D-007 · Regularization approval owns the attendance-row upsert

The spec has approval writing into `attendance_records` but never says who owns
the row when the day has none — which is exactly the wholly-missed-day case
regularization exists for.

**Ruling:** approval creates the row if absent. Consequently, a **Phase 1
constraint on the nightly status job**: it must never overwrite a row whose
`check_in_source = 'regularized'`. A human decision outranks a derived one —
the same rule `attribution.py` already enforces for project attribution.

### D-008 · Column naming — `reviewed_by_user_id`, not `reviewed_by`

The spec uses `reviewed_by` as shorthand. The column is `reviewed_by_user_id`,
matching `TimesheetApproval`, because the two tables get read side by side.
`created_by_user_id` added on the same precedent (`TimeEntry` has one, because a
manager or HR filing on someone's behalf is legitimate and must stay visible).

Services and frontend code against `reviewed_by_user_id` / `created_by_user_id`.

`ondelete` on both preserves the audit trail rather than the name: a reviewer who
leaves the company must not delete the record of their decision, so
`reviewer_name` can read `None` on a decided row while `reviewed_at` survives as
proof. Manager queues render the timestamp, not only the name.

### D-009 · Module policy does not go on `org_settings`

`geofence_enforcement` lives in a new `attendance_settings` table; leave-year
policy lives in a new `leave_settings` table. Neither goes on `org_settings`.

**Why, and this now governs every future module:** `org_settings` is the payload
the desktop agent pulls on *every heartbeat*, and the public shape of
`OrgSettingsOut`. Widening a hot agent-facing contract with policy the agent
never reads is wrong on the merits, not merely inconvenient. Both new tables use
`org_id` as the **primary key** (1:1 enforced by the database, as `OrgSettings`
itself does), not a plain indexed FK.

**A missing row means defaults, never a backfill.** No `attendance_settings` row
resolves to `flag_only`; no `leave_settings` row resolves to a January policy
year and unlimited optional-holiday opt-ins. This is what keeps the migration
additive for the tenants that already exist.

### D-010 · Spec contradiction: is attendance status stored or computed?

§2.3 says late/absent/half-day are "computed at read time… never stored". §2.4
says `status` is "computed nightly by a job". Same column, opposite answers.

**Resolved so both halves are true:** the six-value day classification
(`present`/`absent`/`half_day`/`on_leave`/`holiday`/`weekly_off`) **is stored**,
because a month-end report for a whole company must not re-derive thirty days per
employee. Late/early verdicts are **not stored** and are computed at read time
against the shift in force.

**The consequence the spec does not mention:** `half_day` is in the stored enum,
so the nightly job does store a half-day decision. Backdating a shift assignment
therefore obliges the shift service to re-trigger the job for the affected range,
or a corrected rota silently leaves stale `half_day` rows behind it. Phase 1 owes
that re-trigger.

### D-011 · `shift_assignments` is this codebase's *first* effective-dated table

The spec and the team brief both told Dev 2 to "reuse the effective-dated-row
idiom already in the codebase". **There is no such idiom** — zero occurrences of
`effective_from`/`effective_to`/`valid_from` anywhere in `app/`. Verified.
`WorkSchedule` is a plain entity behind a current-value pointer
(`users.schedule_id`) with no history at all.

Implemented as effective-dated anyway, because the requirement is right even
where the cited precedent is imaginary: the nightly job recomputes a past date
and must ask *which shift was this person on on 14 March*. `WorkSchedule` gets
away with a current-value pointer only because timesheet approvals freeze their
totals at sign-off; attendance has no such snapshot, so the same pattern would
silently mark a whole past rota's night shifts late.

Open question for later: whether `users.schedule_id` eventually follows. The
codebase currently has two answers to one question.

### D-012 · Units — minutes and milli-days, never floats

- `half_day_threshold_hours` (spec) is stored as `half_day_threshold_minutes`.
  4.5 hours is a normal threshold, so an hours column has to be a float, and
  every duration in this codebase is already integer minutes. The spec's name
  survives as a model property, so the §2.3 API contract is unchanged.
- Leave balances are **milli-days** (1/1000 day), integer, suffixed
  `_milli_days` exactly as money is suffixed `_paise`. Integer days cannot
  express the half-day the spec mandates. Minutes look natural next to
  `TimeEntry.minutes` and are **wrong**: a leave day is a policy unit, not a
  duration, so pegging balances to minutes silently re-values everyone's accrued
  leave the moment their `WorkSchedule` moves from 8h to 7.5h. The day is the
  stable unit; only its subdivision needs precision.
- `MAX_WORKED_MINUTES_PER_DAY = 960` (16h), not 24h. A forgotten check-out
  running to midnight would otherwise book a full day of overtime for someone who
  left at six — and payroll reads that column.

### D-013 · §3.1 (leave) is not implementable as written — gaps filled

Three additions, all approved as corrections rather than scope creep:

- **`optional_holiday_opt_ins`** — §3.1 specifies `holidays.is_optional` but no
  table for the opt-in, which makes the flag decorative: the stamping job could
  only treat an optional holiday as off for everyone or for nobody.
- **`leave_applications.duration_milli_days`**, computed at apply time and
  frozen. If approval and cancellation each recompute it, a holiday-calendar edit
  in between makes the debit and the credit-back different numbers, and the
  balance drifts by exactly the days somebody added to the calendar.
- **`debited_at`**, an idempotency latch stamped inside the same locked
  transaction as the debit — turning "never drop the lock" into something the
  data enforces against a double-click.

Also missing from §3.2's alert list: **`leave_cancelled`**. A manager who
approved leave and rearranged cover around it must be told when the employee
withdraws it; `leave_decided` does not cover it, because the decision was already
made. Added in Phase 4.

### D-014 · Geofence `required` mode may not lock a tenant out

Raised by Dev 2 in Phase 0 and briefed as a binding constraint from Phase 1
onward: §2.2 lets an admin switch `geofence_enforcement` to `required` with
**zero active office locations**, which blocks every punch in the company and has
no guard in the spec.

**Ruling:** `required` is refused unless the org has at least one active office
location, and the refusal returns a typed `{reason, message}` body the console
can render — not a bare 4xx. The guard has two halves, because blocking the
settings change alone is not enough: deleting or deactivating the **last** active
location while already in `required` mode is the same lockout arriving from the
other direction, and is refused too.

The console surfaces `active_location_count` and disables the option *before*
submit, so the refusal is explained rather than discovered.

> **Numbering note.** This ruling was briefed to the engineers as "D-014" and is
> cited as D-014 in eight places across `services/attendance.py`,
> `api/v1/attendance.py` and the settings page — but the number was also used in
> this log for the partial-index ruling, which now lives at **D-027**. Caught by
> Dev 9a, who noticed "see D-014" resolved to two unrelated rulings. The document
> moved rather than the code, because no code ever cited D-014 for the indexes.

### D-027 · Partial unique indexes — verified, not assumed

Three modules depend on them (`regularization_requests` pending-per-day,
`asset_assignments` open-per-asset, `offboarding_requests` open-per-user). A
plain `UniqueConstraint` in any of the three is a severe silent bug: it would
forbid re-filing after a rejection, brick asset re-assignment forever, and
prevent a rehire's second exit.

Dev 3 warned autogenerate would drop the predicate; Dev 7 reported it survives,
but verified against Alembic 1.19.1 while **1.14.0 is what is actually pinned and
installed**. Settled by testing the pinned version directly:

- SQLite 3.53.1 emits and enforces `CREATE UNIQUE INDEX … WHERE …`.
- Alembic **1.14.0** autogenerate does render `sqlite_where=` and
  `postgresql_where=`.

So no hand-edit is required. The generated migration is still read by eye before
it lands, because the failure mode is silent and severe.

### D-015 · Two modules, one column name

Dev 5 and Dev 6 both dodged the SQL reserved word `order` independently and
landed on different names (`sort_order` vs `order_index`). Standardised on
**`sort_order`**, with offboarding renaming rather than onboarding — not because
it is the better name (`order_index` is arguably more precise) but because
onboarding is already referenced across a module boundary by the load-bearing
`it_setup` literal, so it has the wider blast radius. Rename the module with
fewer external references.

### D-016 · `users.status` added; `is_active` untouched

Both Dev 5 and Dev 6 blocked on a column the spec assumes exists. §4.1 wants
pre-boarding users at `pending_setup` and §4.2 moves leavers to `inactive`, but
`users` had only `is_active: bool`. The spec was remembering
`organizations.status`.

Added `UserStatus` (`pending_setup`/`active`/`inactive`), `String(24)`,
**default `active`** — the default is what makes this additive rather than a
silent mass-reclassification of every existing account.

**`is_active` remains the sole authentication gate.** `status` is descriptive
workflow state only. If login ever consults both, there are two switches that can
disagree about whether a person may log in — precisely the failure the spec
itself warns about for device revocation. A pre-boarding hire is neither active
nor departed, which is exactly why a boolean could not carry this.

### D-017 · Offboarding does not subclass onboarding

§4.2's "same shape as onboarding tasks" is a trap and is **not** an instruction to
import or subclass. The two diverge immediately: offboarding anchors on
`last_working_day` rather than `joining_date`, has clearance semantics onboarding
lacks, and shares no template rows. Two parallel table sets with duplicated shape
is correct; one polymorphic set with a `kind` discriminator would cost more inside
a single sprint.

Offboarding also has **no template table** — §4.2 names only three tables. The
default checklist lives as a module constant that Phase 7 copies into per-request
rows. Per-department exit templates are a named follow-up, not a Phase 0 gap.

### D-018 · `TimestampMixin` provides only `created_at`

The team brief claimed it provided `updated_at` too. It does not, and
`updated_at` exists nowhere in this repository. Caught independently by Dev 6 and
Dev 8; brief corrected. No engineer had relied on it.

**`updated_at` is deliberately NOT being added to the mixin**, despite three
modules wanting it: it would silently alter every existing table in the repo,
which is exactly what additive-only forbids. `AuditLog` is the answer instead —
and writing to it on every F&F edit and every balance adjustment is now a Phase 7
and Phase 4 requirement.

### D-019 · Helpdesk keeps an empty dependency graph

`source_module` (String) + `source_ref` (Uuid) added as nullable columns with
**no foreign key**, so "dispute this rejection" can deep-link without helpdesk
depending on any module. The missing FK is the point: §6 requires that any module
can raise a ticket but models nothing for it, so the thing someone reaches for
under deadline is a real FK to `regularization_requests`, which destroys the
self-contained property permanently. A dangling ref must render as "linked item
unavailable", never a 500.

Internal-note visibility is enforced by **type**, not naming: the employee-facing
comment schema types `is_internal` as `Literal[False]`, so validating an internal
row into it raises rather than discloses. Comment counts live only on staff
schemas — telling an employee their ticket has twelve comments when they can read
four discloses that eight notes about them exist.

**Recorded risk for Phase 10:** the boolean means the visibility decision is
re-made on every read path forever. A bulk export, a search endpoint or a report
builder issuing `SELECT *` does not pass through those schemas. If any of the
three ships, reconsider the two-table split.

### D-020 · `attendance_records.status` defaults to `present` — a trap on the D-007 path

The default is **right** for the punch path: a row exists because somebody
punched, so they were present until the nightly job refines it.

It is **wrong** for the path D-007 just made mandatory. Regularization approval
creates the row for a wholly-missed day, and if that service forgets to set
`status`, the day silently becomes `present` with no punches on it — a fabricated
attendance record, produced by the feature whose entire purpose is correcting
attendance honestly.

**Not fixed by changing the default** (Dev 2's argument against nullable stands:
it would push a "what does NULL mean" branch into every report and export).
Instead, **binding on Phase 2**: the regularization service sets `status`
explicitly on any row it creates, and a test asserts a regularized missed day is
never left `present`. A test, not a comment — comments do not fail builds.

### D-021 · D-018 extended: the attendance write-back also needs `AuditLog`

D-018 named `AuditLog` as the answer to having no `updated_at`, and listed Phase 4
(balance adjustments) and Phase 7 (F&F edits). It **missed Phase 2**.

After a regularization is approved, the attendance row shows a corrected
`check_out_at` with nothing recording when it was corrected — the only timestamp
is `regularization_requests.reviewed_at`, reachable through a `SET NULL` pointer
that D-006 explicitly says is **not history**. Same class of silent mutation as
the other two. Phase 2 writes an `AuditLog` row on every attendance write-back.

### D-022 · Comp-off has two sources of truth for one number

`comp_off_credits` rows and the comp-off `leave_balances` row both describe the
same entitlement, and nothing reconciles them — seeding required hand-tuning
`accrued_milli_days` to match the credits, with nothing to catch a mismatch.

**Binding on Phase 4:** pick one and write it down — either credits write through
to the balance inside the same locked transaction as every other debit, or the
comp-off balance is derived from credits and never stored. Two independent
numbers for one entitlement will drift in production, and this is the module the
spec itself calls financial-adjacent.

**Settled in Phase 4 — the credit ledger is the single source of truth.**
`comp_off_credits` is the ledger; the comp-off `leave_balances` row is a
**projection** of it, written only by the credit lifecycle (granting adds to
`accrued_milli_days`, expiry subtracts), inside the same locked transaction as
any other write to that row. `adjust_balance` refuses a comp-off type outright
and points the caller at the credit endpoints, so the number has exactly one way
to move.

The "derive it and never store it" alternative was rejected for two reasons
worth keeping: `LeaveBalance.balance_milli_days` is a model property with a fixed
formula that every schema and report already reads, and making it lie for one
leave type is worse than storing a projection; and the debit path would then need
two shapes — a locked-row debit for ordinary types, a ledger scan for comp-off —
which is a branch in the one function that must not have one.

The cost of a projection is drift, so drift is made a **test** failure rather
than a production discovery: `reconcile_comp_off()` recomputes the projection
from the ledger and returns the difference, asserting
`accrued_milli_days == sum(credit_milli_days WHERE expired_at IS NULL)`.

### D-023 · `offboarding_tasks.due_offset_days` is upheld

QA read the offset sitting beside `due_on` as redundant provenance that goes
stale when `last_working_day` moves. **Overruled.** Offboarding has no template
table (D-017), so the offset must live on the task row or recomputing `due_on`
after an LWD change is impossible. Onboarding keeps its offset on the template
precisely because it *has* one.

**Binding on Phase 7:** moving `last_working_day` recomputes every `due_on`, with
a test. The column stays.

### D-024 · Task assignee is `assignee_user_id` — *ruling reversed once*

`OnboardingTask` and `OffboardingTask` had two spellings for one concept, at the
same seam D-015 exists to close.

**First ruling (wrong):** standardise on `assigned_user_id`, onboarding as the
anchor, same blast-radius tie-break as D-015.

**Reversed.** That tie-break weighed blast radius only *within the HRMS modules*.
The repo's pre-existing task table already spells this `assignee_user_id` —
`models/project.py:159`, `schemas/project.py:78`/`:90`, and
`api/v1/projects.py:346`, which also gives the derived display field its name,
`assignee_name`. Additive-only means that table cannot move. So the first ruling
would not have removed the two-spellings problem; it would have **relocated** it
and left the repo permanently split. Applied repo-wide the correct anchor is the
pre-existing one, which is also the only one referenced from a router.

**Final:** all three task tables use `assignee_user_id` / `assignee` /
`assignee_name`. Both HRMS modules renamed to match `project.py`.

Two things worth keeping from how this went wrong:

- The right anchor for a naming decision is the **widest** existing reference,
  and "widest" means repo-wide, not within the work in front of you. Checking
  that costs one grep.
- D-015 caught `sort_order` and missed this one entirely. Two engineers solving
  the same problem in parallel diverge on naming more than once, so the seam
  needs auditing **as a class** at the end of a phase, not case by case as
  someone happens to notice.

**Deliberately not standardised:** `helpdesk_tickets.assigned_to`. It is a ticket
assignee rather than a checklist task, and §6 names that column explicitly.
Recorded here so the next person to notice it finds a decision rather than an
oversight.

### D-025 · Seed data is not behind `--demo-data`

The Phase 0 criterion is stated for plain `app.seed`, and the whole HRMS tenant is
~200 rows against `--demo-data`'s tens of thousands of activity segments. Putting
it behind the flag would leave 26 tables empty on the default invocation, which
defeats the purpose.

Coverage is **enforced, not eyeballed**: `verify_hrms_coverage()` derives the
table list from the mappers, counts every one org-scoped, and exits loudly naming
any empty table. A table added in a later phase and never seeded now fails the
seed.

### D-026 · Internal notes are admin-or-assignee, not staff-at-large

Found in Phase 9 by the engineer who built the disclosure defences, reviewing his
own module: `can_manage_helpdesk` defaults `True` and staff resolves to every
`TeamViewer`, so **out of the box every manager in the company could read every
internal note on every ticket — including a grievance filed about themselves.**

The `Literal[False]` schema split from Phase 0 is airtight against the employee
and completely open to the peer manager. It defends the wrong boundary on its
own.

**Ruling:** reading internal notes requires helpdesk staff **and**
(`can_administer` **or** being the ticket's assignee). Writing one requires the
same right — a note you could not read back is not a useful thing to be able to
write. Everything else staff already do (queue, triage, assign, priority, public
replies, resolve) is unchanged.

Chosen over a `restricted` flag on `HelpdeskCategory` because it needs no schema
change, fails closed on the grievance case, and degrades sensibly: a shared HR
queue assigns a ticket before working it, which is what you want anyway. The
category flag remains a **Phase 10 addition to this floor**, not a replacement.

Three things the implementation surfaced that the ruling did not anticipate:

- **There were three read paths, not one.** Ticket detail, the queue (per row),
  and — the one that would have leaked — **every staff write echoes the ticket
  back**, so each mutation is also a read path. The leak would have come back
  through the door marked "write".
- **A non-entitled staff caller gets the redacted shape, not a 403.** A refusal
  would itself confirm there are notes to refuse. The *write* is refused with a
  403, which is safe in a way the read refusal is not: the caller already knows
  what they tried to write, so it discloses nothing about the ticket.
- **Absent key, not zero.** The queue omits count keys on rows you may not read
  rather than zeroing them, because "0 internal notes" is an assertion about a
  ticket and a confident zero teaches the reader as much as a confident eight.

Not fixed by D-026 and still open for Phase 10: a future export, search endpoint
or report builder issuing `SELECT *` over `helpdesk_comments` bypasses the
service entirely. The service is the only door, and that is a convention rather
than a constraint (the risk D-019 already recorded).

### D-028 · A regularized attendance row is frozen — and that is a real hole

D-007 says the nightly job must never overwrite a row whose source is
`regularized`. Correct, and it has a consequence nobody spotted until Phase 2 was
built: **the row is frozen against everything, forever.**

So if leave is approved for a date that was regularized *earlier*, the attendance
row keeps the status regularization stamped and never becomes `on_leave` — the
leave path declines to touch a human decision, and the nightly job declines too.
Same for a rota backdated across a corrected day.

**Ruling:** the freeze stands — a derived job must not overwrite a human
decision, and that is the whole point of D-007. What changes is that
**regularization approval classifies the day once, at approval time, with full
precedence** (holiday and weekly-off outranking a worked day), using the
attendance module's own classifier rather than a second one. A later *human*
decision — approving leave for that date — is entitled to reclassify it; a
*derived* one is not.

Closing the leave-after-regularization case is a named **Phase 10** follow-up.
Recorded rather than left as folklore, because the symptom (a day that refuses to
become `on_leave`) looks like a leave bug and will be debugged in the wrong
module.

### D-029 · `create_employee` silently dropped every HRMS permission flag

Found by Dev 5 while building Phase 6. `UserCreate` accepted all five new flags
and the `User(...)` construction in `admin.py` copied only the original four, so
**creating an employee with `can_manage_onboarding: false` produced one with it
set to `true`** — the model default.

A restriction that is silently not applied is worse than one that is refused,
because the screen said it worked. `update_employee` never had the bug: it uses a
generic `setattr` loop, which is why the fix needed applying in exactly one
place.

Fixed, along with the gap that made pre-boarding unreachable through the API:
`status` was on the column (D-016) but on no schema, so §4.1's "pre-boarding user
creation" could not be performed by any caller and the console could not render a
pre-joiner. `status` now appears on `UserOut`/`UserCreate`/`UserUpdate` with a
validator rejecting values outside `UserStatus` — the column is a plain `String`
mirroring `organizations.status`, so nothing below the edge would have caught a
typo becoming a permanent state that no query filters on.

### D-030 · Attendance's day helpers are public API

Regularization has to classify a day it just corrected and must get **the same
answer as the nightly job** — holiday and weekly-off outranking a worked day, in
the same order. Dev 3 reached past `_record_for`, `_DayContext`, `_classify` and
`_as_utc` to do it, and said so rather than quietly duplicating them.

Duplicating would have been the worse sin: a second classifier drifts the first
time either side changes, and the failure is a regularised Sunday quietly reading
`present`. But a cross-module dependency on underscore names is one rename away
from breaking silently.

All four are now public (`record_for`, `DayContext`, `classify`, `as_utc`) with
the reason documented at the definition. Zero cross-module private references
remain.

### D-031 · Per-employee page hiding does not apply to the HRMS modules

Three separate frontend engineers flagged that the new nav entries carry no
`page:` key and that `PAGE_GUARDS` has no entry for attendance, helpdesk, assets
or onboarding. Investigated, and the answer is that it **should not** — recorded
so it reads as a decision rather than an oversight anyone else has to re-discover.

Per-employee page hiding is the wrong tool for a self-service module. Hiding
Attendance from someone stops them punching in; hiding Onboarding stops a new
hire completing their own checklist. The guard would not restrict a view, it
would remove the employee's ability to do their job.

The org-level question — "this company did not buy Assets" — is a different
question with a different mechanism: `require_module`, attached at router
registration. Confusing the two would give two half-working switches instead of
one working one.

**One real bug did fall out of the investigation.** `leave.py` has always called
`deny_page(viewer, "leave")` in six places, but `PAGE_GUARDS` had no `"leave"`
key — so the guard worked and the *sentence* did not: a refused employee was told
"Your account is not permitted to **leave**." The fallback renders the raw key,
which is fine in a log and not to a person. Key added.

### D-032 · The holiday calendar is not leave data

`GET /leave/holidays` sat behind `deny_page("leave")` like every other read in
the module. Wrong: when the office is shut is **company-wide information**. An
employee switched out of the Leave page still needs to know the building closes
on Friday, and the home screen's next-holiday card exists for precisely that.

Hiding a page must not hide a public fact. Nothing in that endpoint is scoped to
the viewer's balances — it returns the org's calendar plus the viewer's own
opt-ins — so there is no leave data to leak. Guard removed; the other five reads
in the module keep theirs.

### D-033 · Two shapes of "collection scoped to a foreign id"

QA found the seven modules answer one question two ways — both non-disclosing,
neither wrong, but drifting:

- `/assets/users/{id}/history` returns **`200 []`** for another tenant's user id.
- `/leave/applications?user_id=` and `/leave/comp-offs?user_id=` return **`404`**.

**Ruling: both stay, and the distinction is the URL shape.** An id in the
*path* names a resource, so an unknown or foreign one is a `404` — the same
answer as "no such thing", which is what keeps it non-disclosing. An id in a
*query string* is a filter, and a filter that matches nothing legitimately
returns an empty list; `200 []` there is not a claim that the person exists.

The existing suites already assume that split, so this codifies what is there
rather than changing behaviour. The next collection-by-foreign-id endpoint picks
by asking which of the two it is.

### D-034 · bcrypt cost is configurable, and production refuses a cheap one

The isolation suite added ~6 minutes of CI, almost all of it bcrypt: several
hundred accounts hashed at the production cost factor, proving only that bcrypt
is slow.

`BCRYPT_ROUNDS` now defaults to **12** and the test suite sets **4**, taking that
file from 6m08s to 1m57s. The obvious objection — that this is one copied `.env`
away from making every stored password cheap to crack — is answered the way this
codebase already answers it for `SECRET_KEY` and SQLite: **`main.py` refuses to
start** in production on a reduced factor. A comment would not have been enough,
because nothing about a running system with cheap hashes looks different.

---

## 6. Known gaps carried deliberately

Named here so Phase 10/11 does not quietly balloon into building them, per
spec §14:

- **Payroll and statutory compliance (PF, ESI, TDS)** — not started. The
  offboarding F&F table is manual entry only, by design.
- **Biometric / attendance-hardware integration** — `check_in_source` leaves
  room for it; no integration built.
- **Performance management and appraisals** — out of scope entirely.
- **Native mobile app** — geo-punch works through the mobile browser
  Geolocation API.

Smaller inconsistencies found in QA, recorded rather than churned:

- `comp_off_credits.expires_at` is a `Date` while `expired_at` is a `DateTime`.
  The `_at` suffix on a `Date` reads as a bug every time somebody meets it. The
  name came from the spec; the type is deliberate (a comp-off expires at the end
  of a local calendar day, and a `DateTime` would make "expires today" depend on
  the hour).
- `offboarding_fnf.currency` is the only currency column in a product whose
  `organizations` table has no currency field, so it can express a state nothing
  else in the system can honour.
