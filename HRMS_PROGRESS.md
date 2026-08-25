# HRMS build — where we are

**Goal.** Close the gap between this product and a full HRMS (benchmarked
against greytHR), keeping the desktop-agent activity monitoring that greytHR
does not have as the differentiator.

**Method.** One complete module at a time — migration, models, schemas, service,
router, console UI, tests, full suite green — rather than many half-built ones. A
module is not "done" until it is reachable from the nav, gated in Super Admin,
and covered by tests that go through the real HTTP surface.

**Last updated:** 24 August 2026 · migration head `b2d6f9a48c17` ·
**1224 tests passing**, 3 skipped.

---

## 1. Status at a glance

| # | Module | Key | State | Tests |
|---|---|---|---|---|
| 1 | Activity & Timesheets | *(ungated)* | shipped before this effort | — |
| 2 | Billing & Subscriptions | *(ungated)* | shipped before this effort | — |
| 3 | Attendance — punch, geofence, shifts | `attendance` | shipped before this effort | — |
| 4 | Regularization | `regularization` | shipped before this effort | — |
| 5 | Leave — types, balances, holidays | `leave` | shipped before this effort | — |
| 6 | Onboarding | `onboarding` | shipped before this effort | — |
| 7 | Offboarding + clearance + **computed F&F** | `offboarding` | clearance shipped earlier; **settlement done this effort** | 24 |
| 8 | Assets | `assets` | shipped before this effort | — |
| 9 | Helpdesk | `helpdesk` | shipped before this effort | — |
| — | **Per-company module grants** | *(Super Admin)* | **done this effort** | 11 |
| 10 | **Core HR** — master record, documents, directory | `core_hr` | **done this effort** | 31 + 12 |
| 11 | **Letters & mail merge** | `letters` | **done this effort** | 28 |
| 12 | **Expense claims & reimbursement** | `expenses` | **done this effort** | 36 |
| 13 | **Loans & advances** | `loans` | **done this effort** | 41 |
| 14 | Payroll + Indian statutory | `payroll` | **done — checkpoints 1–5** | 138 |
| 15 | **Approval kernel + unified queue** | — | **done this effort** | 27 |
| 16 | **Performance / appraisals** | `performance` | **done this effort** | 30 |
| 17 | Recruitment / ATS | `recruitment` | planned | — |
| 18 | **Communication & engagement** | `engagement` | **done this effort** | 28 |
| 19 | Ad-hoc report builder | — | planned | — |

**Explicitly out of scope** (the user excluded these):

- Native mobile app — geo-punch works via mobile browser Geolocation.
- Biometric / smart-card / facial device integration — `check_in_source` leaves
  room in the schema, nothing is built.

---

## 2. What was built in this effort

### 2.1 Per-company module grants

Module gating existed but was **per-plan only** — you could say "the Standard
plan includes Leave", not "give this one customer one extra module".

- `organizations.module_grants` (JSON) holds tri-state overrides:
  `{"leave": false}`. A key present wins; a key **absent** inherits the plan.
- Tri-state, not boolean, because "inherit" has to be representable. With
  granted/revoked lists, toggling a switch on and off again silently pins the
  company to a value the plan no longer controls.
- One registry ([`app/core/modules.py`](server/app/core/modules.py)) drives the
  plan editor, the Super Admin panel, the 402 message and the console nav. New
  modules appear in all four automatically.
- Super Admin panel is a three-way **Plan / On / Off** control per module, not a
  checkbox — a checkbox cannot express "follow the plan, now and later".
- New tenant endpoint `GET /org/modules` so the console can hide nav for
  disabled modules. Authenticated: which modules a company bought is commercial
  information about that company.

Files: [`core/modules.py`](server/app/core/modules.py) ·
[`services/subscriptions.py`](server/app/services/subscriptions.py) `allows_module` ·
[`api/v1/superadmin.py`](server/app/api/v1/superadmin.py) ·
[`CompanyModules.tsx`](admin/src/pages/platform/CompanyModules.tsx) ·
migration `e2a9c4d71b88`

### 2.2 Core HR (`core_hr`)

The employee **master record**, distinct from the **account** (`users`) and from
the **onboarding checklist**.

- `employee_profiles` — one-to-one with `users`, holding personal details,
  addresses, emergency contact, statutory identity, bank, employment,
  probation/confirmation, background verification.
- `employee_documents` — the **lifetime** document file, deliberately separate
  from `onboarding_documents` (which is archived with its checklist).
- Statutory numbers (PAN, Aadhaar, bank account) are **encrypted at rest** and
  **masked in every response**. Revealing one is a separate audited `POST`.
- Directory open to every employee — safe because of the *shape* of the
  response, not the audience: no DOB, no address, no statutory field.
- Two reports: probation due, documents expiring.

**A manager cannot read their report's master record.** This is the one module
where the reporting hierarchy grants nothing — line management is not a reason to
hold somebody's Aadhaar. There is a test asserting it, with a comment saying that
if it ever fails because someone "made it consistent", the consistency is the bug.

Files: [`models/corehr.py`](server/app/models/corehr.py) ·
[`services/corehr.py`](server/app/services/corehr.py) ·
[`api/v1/corehr.py`](server/app/api/v1/corehr.py) ·
[`core/crypto.py`](server/app/core/crypto.py) (extracted from the mail service) ·
[`MyProfile.tsx`](admin/src/pages/hrms/people/MyProfile.tsx) ·
migration `f3b7d1a90c45`

### 2.3 Lifecycle seams

Four connections that were missing, each invisible until it bit:

1. **Verifying an onboarding document files a copy** into the permanent record.
   Bytes are **copied, not shared** — `onboarding.delete_document` removes the
   object, so a shared key would leave the permanent row pointing at nothing.
2. **Completing onboarding starts probation** and computes `probation_end_on`.
   Without it nothing ever moved `confirmation_status` off `not_applicable` and
   the probation-due report stayed permanently empty.
3. **Completing offboarding marks the profile terminated.** Otherwise a departed
   employee's profile still reads "Confirmed".
4. **Employees list links to the HR record** — two records, one row.

All three hooks live in `services/corehr.py`, not in onboarding/offboarding,
because those are Core HR's tables. All are forgiving: they run at the end of an
operation that already succeeded and must never fail it. There is a test that
corrupts the source storage key and asserts the **verification still returns 200**.

Files: [`services/corehr.py`](server/app/services/corehr.py) (`promote_document`,
`file_bytes`, `start_probation`, `mark_exited`) ·
[`services/storage.py`](server/app/services/storage.py) (`read()` added to both
backends) · [`tests/test_corehr_lifecycle.py`](server/tests/test_corehr_lifecycle.py)

### 2.4 Letters & mail merge (`letters`)

- `letter_templates` — bodies with `{{merge.fields}}`; five starters seedable.
- `issued_letters` — **stores its own rendered text**. A letter states facts as
  of the day it was signed; re-rendering would rewrite a document a bank already
  holds. Same rule as `timesheet_approvals` freezing its totals.
- Reference numbers `DEMO/HR/2026/0001`, unique per company, allocated **at
  issue** — that is what distinguishes "issued" from "somebody opened a preview".
- Issuing files a copy into the employee's documents, via `corehr.file_bytes`.
- Revoking deletes nothing — not the body, not the number, not the filed copy.
- Self-service: employees request letters from templates HR marked requestable,
  producing a **draft** for HR, never an issued letter.

**A minimal `{{field}}` substituter, not Jinja2.** The template author is a
customer; Jinja2 would hand them expressions and traversal inside a multi-tenant
process. Substitution is single-pass so a *value* containing `{{...}}` stays text.

**PAN / Aadhaar / bank are not mergeable.** One merge field would defeat the
encryption, the masking and the reveal audit at once.

Files: [`services/lettermerge.py`](server/app/services/lettermerge.py) ·
[`models/letters.py`](server/app/models/letters.py) ·
[`services/letters.py`](server/app/services/letters.py) ·
[`api/v1/letters.py`](server/app/api/v1/letters.py) ·
[`Letters.tsx`](admin/src/pages/hrms/letters/Letters.tsx) ·
migration `a4c8e2f13b70`

### 2.5 Expense claims (`expenses`)

- `expense_categories` — what the company reimburses, with **per-category**
  `requires_receipt` and `max_amount`. Per category rather than company-wide
  because a taxi fare and a laptop do not warrant the same evidence, and a single
  global switch gets set for the strictest case then ignored.
- `expense_claims` / `expense_lines` — a covering claim and the items on it.
- **All money is integer paise**, matching billing. `money()` and `toPaise()` in
  `lib/format` are the only places a float appears, both at the very edge.

Four rules the tests are weighted towards, because each would cost real money:

1. **The total is server-computed.** `recompute_total` is the only writer, called
   after every line mutation. No request body can carry a total, and every line
   endpoint returns the *whole claim* so the client never sums anything itself.
2. **Submitting freezes the lines.** A manager who approved ₹4,000 must not find
   the claim now says ₹40,000. Editing, deleting or adding a line after
   submission is a typed 409.
3. **Nobody approves their own claim** — not even an owner — and the review queue
   excludes it rather than offering an action that always fails.
4. **Approving and paying are separate acts.** `can_approve_expenses` for
   managers, `can_reimburse_expenses` for administrators only. A manager
   approving their team's spend *and* recording it as paid is the segregation this
   keeps. "Approved but unpaid" is a first-class state because it is the one every
   employee chases.

Scope comes from `services/hierarchy` — unlike Core HR, where a manager gets
nothing, an expense claim *is* a management matter, so the reporting subtree is
the right scope.

Files: [`models/expenses.py`](server/app/models/expenses.py) ·
[`services/expenses.py`](server/app/services/expenses.py) ·
[`api/v1/expenses.py`](server/app/api/v1/expenses.py) ·
[`MyExpenses.tsx`](admin/src/pages/hrms/expenses/MyExpenses.tsx) ·
[`ExpenseQueues.tsx`](admin/src/pages/hrms/expenses/ExpenseQueues.tsx) ·
migration `b5d9f3a24c81`

### 2.6 Loans & advances (`loans`)

- `loans` — the agreement: type, principal requested, principal sanctioned,
  term, rate in **integer basis points**, and the lifecycle.
- `loan_instalments` — the repayment ledger, one row per month.

Five rules the tests are weighted towards:

1. **The schedule sums to the total repayable, exactly.** `split_amount` spreads
   the remainder one paise at a time across the *earliest* instalments, so
   nothing is lost to rounding and every instalment is within one paise of the
   others. A test asserts this for every count from 1 to 60 across six totals.
2. **The schedule is built at disbursement, not approval.** Approval is a
   promise; the first deduction month depends on when the money actually left.
   A unique constraint on `(loan_id, sequence)` is the backstop — a rebuilt
   schedule must not double the obligation.
3. **Outstanding is derived**, summed from unpaid instalments on read.
   Deliberately the opposite of `expense_claims.total_amount`, which is stored
   *because* approval freezes it; a balance is supposed to move.
4. **A waiver is not a repayment.** It settles the schedule without being
   counted as recovered, so a written-down amount never overstates collections.
   `write_off` is likewise distinct from `closed` — forgiven is not repaid.
5. **A manager cannot see a report's loan.** Same judgement Core HR makes about
   a home address, and the opposite of expenses. Sanctioning is administrators
   only: approving a taxi fare is line management, committing the company to lend
   is not.

Interest is **simple, on the original principal**, and defaults to zero.
Reducing balance is not implemented and the docstring says so rather than
implying otherwise.

`GET /loans/deductions` answers "what does payroll deduct this month" — built
and tested before payroll exists, so the ledger is proven against its real
consumer rather than an assumption about one.

Files: [`models/loans.py`](server/app/models/loans.py) ·
[`services/loans.py`](server/app/services/loans.py) ·
[`api/v1/loans.py`](server/app/api/v1/loans.py) ·
[`Loans.tsx`](admin/src/pages/hrms/loans/Loans.tsx) ·
migration `c6e1a4b35d92`

### 2.7 Payroll — checkpoint 1: salary structures

Payroll is being built in checkpoints rather than one pass. This is the first:
the salary structure everything else will read.

- `pay_components` — the company's catalogue: basic, HRA, conveyance, special
  allowance. Each carries **how it is calculated** and, more importantly, three
  flags: `is_pf_wage`, `is_esi_wage`, `is_taxable`. Those three are the entire
  interface between a company's salary design and statutory computation. Nothing
  downstream infers them from a component's name — "Basic" is a convention, and
  an engine that guesses from a string is one rename away from a wrong filing.
- `salary_structures` — **effective-dated and never edited**. A revision is a new
  row; the previous one is closed the day before the new one starts. The whole
  timeline is recomputed on every write, because a correction can be backdated
  *between* two existing revisions and patching only the neighbour leaves the one
  after it claiming a period it no longer covers.
- `salary_structure_components` — resolved amounts **and the rule that produced
  them**, snapshotted. Editing the catalogue changes the next structure and
  nothing about the last, so a payslip reprinted next year still explains itself.

**The resolver balances exactly.** Components compute in dependency order —
fixed, then % of gross, then % of basic, then the `balance` component absorbs the
remainder. If the percentages already exceed gross that is an error the person
sees, not a negative allowance quietly absorbing it. At most one component may be
`basic` and at most one may be `balance`; two of either is a coin toss, not a
configuration.

**`can_manage_payroll` is the one flag in this codebase that defaults FALSE.**
Every other flag restricts a capability that already existed, so defaulting true
preserves behaviour. Payroll had none to preserve, and defaulting true would have
handed every administrator every salary the moment the migration ran. The account
owner holds it implicitly in `services/payroll.can_manage`, so a workspace can
never lock itself out of its own payroll. A manager never gets it — approving
somebody's leave and their expenses is not a reason to know what they earn.

There is deliberately **no endpoint that lists everybody's salary**.
`/payroll/uncovered` lists the people *without* a structure and carries no
amounts.

Also fixed here: the permission flags added by Core HR, Letters, Expenses and
Loans had never been surfaced in the employee editor — the forms still carried
only the original four. All eleven are now editable, and `UserCreate` /
`UserUpdate` / `UserOut` accept and return them.

Files: [`models/payroll.py`](server/app/models/payroll.py) ·
[`services/payroll.py`](server/app/services/payroll.py) ·
[`api/v1/payroll.py`](server/app/api/v1/payroll.py) ·
[`SalaryStructures.tsx`](admin/src/pages/hrms/payroll/SalaryStructures.tsx) ·
[`PayComponents.tsx`](admin/src/pages/hrms/payroll/PayComponents.tsx) ·
migration `d7f2b5c46e03`

### 2.8 Payroll — checkpoint 2: pay runs and payslips

Turning a salary structure into money paid.

- `pay_runs` — one per company per month, enforced by a unique constraint.
  Lifecycle draft → computed → **approved** → **paid**, with the last two
  separate for the same reason expenses and loans split them: signing off a
  payroll and the money leaving the bank are different events, days apart.
- `payslips` — one per employee per run, storing their own resolved totals.
- `payslip_lines` — every line carries a **`source`** and a `source_id`. A
  ₹6,480 deduction is not just a deduction: it is instalment 3 of 8 of a
  specific loan, reachable from the row rather than reconstructed by matching
  amounts. The statutory sources (`pf`, `esi`, `tds`…) are declared now so
  checkpoint 3 needs no migration.

**Compute is a replace, not a merge.** Recomputing deletes every payslip and
rebuilds from current data — merging leaves a payslip for somebody who has since
left and a line for a loan that closed, and those are the rows nobody notices
until the bank file is wrong.

**Proration preserves the total.** Loss of pay scales each component and hands
the rounding remainder out by largest remainder, the same discipline
`loans.split_amount` uses, so components still sum to the prorated gross exactly.
A full month short-circuits and does no arithmetic at all. Tested for every
payable-day count across four month lengths.

**Loss of pay is derived from the leave module**, in leave's own milli-day unit
so nothing converts at the boundary — approved applications of an unpaid type,
counting only the working days that fall *inside* the period. An override exists
for what leave cannot know, and the payslip records that a human decided.

**Paying applies the side effects, once, through the recorded ids.** Loan
instalments settle, a loan whose last instalment lands closes itself, and
approved expense claims become reimbursed. An instalment somebody settled by hand
between approval and payment is left alone.

**Employees with no structure are skipped and listed.** Skipping is right — a ₹0
payslip reads as a decision — but silence about it is not, so the run detail names
them.

A bug this found: `SessionLocal` is `autoflush=False`, so the "is this loan fully
repaid" count did not see the instalment just marked paid, and a loan whose final
instalment settled through payroll stayed open. Fixed with an explicit flush.

Files: [`models/payrun.py`](server/app/models/payrun.py) ·
[`services/payrun.py`](server/app/services/payrun.py) ·
[`api/v1/payrun.py`](server/app/api/v1/payrun.py) ·
[`PayRuns.tsx`](admin/src/pages/hrms/payroll/PayRuns.tsx) ·
migration `e8a3c6d57f14`

### 2.9 Payroll — checkpoint 3: statutory deductions

PF, ESI, professional tax and LWF, computed onto every payslip.

- `statutory_configs` — one row per company. Rates in **basis points**, ceilings
  and thresholds in paise, every one of them a column rather than a constant
  because all of them have moved before. `pf_enabled` and `esi_enabled` default
  **false**: a company that has not configured statutory must not have deductions
  start appearing the month after the migration.
- `professional_tax_slabs` — many rows, because PT is a state tax and no two
  states agree. `applies_in_month` exists because several states charge
  differently in one month of the year (Maharashtra's February), and a config
  that cannot say so forces an annual manual correction.
- `employee_profiles.pf_applicable` / `esi_applicable` — **nullable** booleans
  where the null is load-bearing: it means "follow the company", the answer for
  almost everybody. A director or an international contractor is why they exist.

**`services/statutory.compute` is a pure function.** No session, no ORM. Statutory
rules are the part of payroll people check against a printed circular, and a
function that also queries and writes cannot be read against one. Every figure in
its tests was worked by hand.

The four rules and where each is easy to get wrong:

* **PF is on PF wages, not gross** — the components a company flagged. The
  ₹15,000 ceiling is optional because contributing on full wages is equally
  legitimate; the *pension* cap is a separate switch because it stays capped even
  when EPF does not. That is how the scheme works and one switch could not
  express it.
* **The employer's 12% splits** into EPS and EPF for the ECR filing. The pension
  slice rounds first and EPF takes the remainder, so the two always add back to
  the employer total exactly.
* **ESI is a threshold, not a ceiling.** At ₹21,000 it stops entirely; below it
  both sides pay on the whole wage. The opposite of PF, and the mistake somebody
  makes once.
* **Statutory bases come from the structure lines only.** Reimbursing somebody's
  taxi fare must not raise their PF, their ESI or their professional-tax band —
  there is a test for exactly that.

**Employer contributions are a third payslip line kind.** Neither an earning nor a
deduction: nobody is paid them and nobody has them taken away, so summing
earnings and deductions ignores them automatically rather than needing a filter
at every call site. They are also what finally makes **CTC** computable — the
figure checkpoint 1 declined to invent while employer contributions did not exist.

Also closed here: the guard checkpoint 1 promised — a salary structure a payslip
was computed from can no longer be deleted.

Files: [`models/statutory.py`](server/app/models/statutory.py) ·
[`services/statutory.py`](server/app/services/statutory.py) ·
[`api/v1/statutory.py`](server/app/api/v1/statutory.py) ·
[`StatutorySettings.tsx`](admin/src/pages/hrms/payroll/StatutorySettings.tsx) ·
migration `f9b4d7e68a25`

### 2.10 Payroll — checkpoint 4a: income tax and TDS

Declarations, the regime choice, and TDS on the payslip. Form 16 and the
year-end reconciliation are 4b.

**Slabs live in code** ([`core/taxslabs.py`](server/app/core/taxslabs.py)), not in
every tenant's database. They are national law, not customer configuration — and
a new Finance Act rarely changes only the numbers, so a new year needs a code
change anyway. What it must never do is guess: an unknown year **raises** rather
than falling back, because a payslip computed against last year's slabs is wrong
in a way nobody notices until assessment. FY 2026-27 is marked `provisional`
because its rates were carried forward, and the flag reaches the screen so it
says so rather than implying certainty.

**`services/incometax` is pure arithmetic**, like `services/statutory`. Every
figure in its tests was worked by hand:

| | |
|---|---|
| ₹12L, new regime | standard ₹75,000 → taxable ₹11.25L → ₹52,500 slab tax → **wiped by the 87A rebate** |
| ₹20L, new regime | taxable ₹19.25L → ₹1,85,000 → 4% cess → **₹1,92,400** |
| ₹10L, old regime, full 80C + PT | taxable ₹7,97,600 → ₹72,020 → cess → **₹74,900.80** |

Order matters and is not negotiable: slabs, then rebate, then surcharge, then
cess. Rebate before surcharge, because a liability rebated to zero has nothing to
surcharge. Cess on tax *plus* surcharge.

**TDS is a projection, not a monthly slab.** The year's estimated liability, less
what has already been deducted, over the months that remain. That is why somebody's
TDS moves when they declare in December — the remaining months absorb the whole
correction. A payroll dividing the annual figure by twelve would under-deduct all
year and then take an impossible amount in March. Year-to-date figures come from
this company's own **frozen** payslips; a draft run is a working figure and
projecting against one would make this month depend on a month nobody approved.

**Declared and verified are two columns, not one.** An employer honours the
declaration until proofs are due and the verified figure after. `verified_amount`
is nullable and the null is load-bearing: nobody has checked, which differs from
zero, meaning checked and nothing stood up. Collapsing them loses the answer to
"why did my TDS jump in February".

**The regime choice is the employee's, and there is no administrator route to
it** — not a guarded one, none. HR verifies amounts it did not enter.

**The comparison is the feature.** The estimate returns *both* regimes always.
The live run found the case that matters: at ₹24L with ₹1.75L of deductions the
**new** regime is still cheaper (₹2,92,500 against ₹4,83,600) — an employee who
assumes "I have 80C, so the old regime is better" would lose ₹1.9 lakh.

Proof documents live in the **Core HR document file**, not a second store, and a
document belonging to somebody else is refused as proof of your claim.

Files: [`core/taxslabs.py`](server/app/core/taxslabs.py) ·
[`services/incometax.py`](server/app/services/incometax.py) ·
[`services/declarations.py`](server/app/services/declarations.py) ·
[`models/incometax.py`](server/app/models/incometax.py) ·
[`api/v1/incometax.py`](server/app/api/v1/incometax.py) ·
[`TaxDeclaration.tsx`](admin/src/pages/hrms/payroll/TaxDeclaration.tsx) ·
migration `a1c5e8f79b36`

### 2.11 Payroll — checkpoint 4b: Form 16 and the year end

**Senior-citizen slabs**, built from the ordinary old-regime table rather than
written out three times: only the nil band moves, and three hand-copied tables
are three places for a Finance Act to be applied to two of them. ₹8L old regime:
**₹65,000** ordinary, **₹62,400** senior, **₹52,000** super-senior.

Age is taken at **31 March**, per the Act — somebody turning 60 that month is a
senior citizen for the whole year, and getting it wrong mis-taxes them for
eleven months. A missing date of birth is the ordinary band rather than an error;
refusing to run payroll over a missing birthday would be absurd.

**Reconciliation** adds up a financial year from **frozen payslips only** —
salary paid, TDS taken, PF both sides — and compares it against the liability
those figures imply. A draft is a working figure, and a March reconciliation that
moves when somebody recomputes is worse than none.

> **The counter-intuitive part, and the UI says it in words:** part-way through a
> year the balance reads as *over-deducted*. TDS is taken against a twelve-month
> projection while the reconciliation computes tax on the months actually paid,
> so in July four months of deduction sit against four months of a liability the
> rebate may wipe. It only means "over-deducted" once the year is complete.
> `months_covered` is what tells a reader which they are looking at. A test
> asserts the negative balance and explains why.

**Form 16 Part B is frozen at issue** — the fifth instance of that rule here,
after timesheet approvals, issued letters, salary structures and payslips. Every
figure is copied; a later payroll does not move a certificate somebody has filed
a return against. There is a test that issues, runs another month, and asserts
the certificate is unchanged while the live reconciliation has moved on.

**A correction is a revision, not an edit.** Revision 2 gets its own reference
number and supersedes revision 1, which stays readable — somebody may already
have filed against it.

**The PAN is masked on the row and full only on the rendered certificate**, read
through Core HR's decryption rather than stored a second time. A Form 16 without
the PAN is not usable for filing; a second plaintext copy would defeat the
encryption the profile bothers with.

**Part A is deliberately not produced.** It is TRACES-generated against the
employer's TAN and downloaded from the income-tax portal. Rendering something
that looked like it would let an employee file against a document no tax
authority has seen — the certificate says so in its footer.

Files: [`core/taxslabs.py`](server/app/core/taxslabs.py) (age bands) ·
[`models/form16.py`](server/app/models/form16.py) ·
[`services/form16.py`](server/app/services/form16.py) ·
[`api/v1/form16.py`](server/app/api/v1/form16.py) ·
[`YearEnd.tsx`](admin/src/pages/hrms/payroll/YearEnd.tsx) ·
migration `b2d6f9a48c17`

### 2.12 Payroll — checkpoint 5: delivery

What a signed-off month produces. Six outputs, one rule holding them together:
**every one of them refuses a run that is not frozen.** A register, a bank file
or an ECR built from a draft is figures nobody approved, and a recompute would
move them after somebody acted on them. The one exception is the printable
payslip, which renders a draft happily — *reviewing* what a draft produces is
the point of reviewing one; it is **filing** that requires approval.

**The register is summed from the payslip lines, not read from the run.** The
run stores its own totals, and the register compares the two and reports any
disagreement in a `discrepancies` list rather than silently preferring one. A
register is exactly the document somebody is checking; a register that quietly
agreed with a wrong total would be worse than no register. The console shows the
list above the table and says which side to trust.

**Columns are carried separately from rows.** Not everybody has every component,
so each row's `earnings` / `deductions` / `employer` maps are sparse and
`earning_codes` / `deduction_codes` / `employer_codes` give the table a stable
column order. The alternative — every row carrying every code at zero — makes
"this person does not get HRA" and "this person's HRA is nil" the same thing.

**Amounts stay in paise on the wire; the CSV converts to rupees.** Two different
edges, two deliberate choices: JSON is read by the console, a spreadsheet is read
by a person. The PF ECR goes further and rounds to **whole rupees**, because
that is what the EPFO portal accepts.

**The bank file is a POST although it reads nothing.** It decrypts every account
on the run and writes an audit row. A GET would be prefetched by the browser,
retried by a proxy, and logged with its URL. The console has a `downloadPost`
helper purely so the endpoint did not have to become a GET to suit the client.
It refuses by name when anybody on the run has no account or IFSC — a partial
bank file is a payroll where some people are not paid and nobody notices.

**ESI is a threshold, not a ceiling** — this is where it shows. The return
carries only people inside the scheme; somebody over ₹21,000 is not in it at a
reduced rate, they are simply not in it. The PF ECR likewise refuses without a
UAN, because the portal keys on it.

**Filing is idempotent.** `file-payslips` marks each payslip with the document it
wrote and skips those that have one, so running it twice does not give anybody
two payslips for one month. The count returned is how many were *newly* filed —
zero means they already were, which is information, not a failure.

**`document_id` is on the payslip response**, and the console reads it rather
than inferring from the run's status: approval and filing are separate steps, so
"approved" does not mean the employee has their copy. A live drive caught this —
the field existed on the model and was missing from the schema, which a
database-level assertion in the test suite had been passing straight through.
The test now asserts it through the HTTP surface.

Files: [`services/payoutputs.py`](server/app/services/payoutputs.py) ·
[`schemas/payoutputs.py`](server/app/schemas/payoutputs.py) ·
[`api/v1/payoutputs.py`](server/app/api/v1/payoutputs.py) ·
[`PayRuns.tsx`](admin/src/pages/hrms/payroll/PayRuns.tsx) ·
migration `c3e7a1b59d28`

### 2.13 Offboarding — the settlement stops being a stub

The exit module has carried a settlement record since before payroll existed,
and its own docstring said plainly that **nothing in this repository computes a
settlement**. That was true and is no longer. Salary structures, statutory
deductions, loans, expense claims and a tax position all exist, which is
everything a settlement is made of.

**A proposal is computed; a settlement is recorded. They are different things
and they are stored differently.** `GET .../settlement/proposal` reads live data
and writes nothing. HR looks at it, argues with it, and then
`POST .../settlement/accept` writes the lines. The three stored numbers are
still stored exactly as recorded and still not derived from each other —
ex-gratia, a waived recovery, a rounding to the nearest thousand, and the figure
actually paid is the one that matters. **The typed-in route is not deprecated**;
`is_manually_entered` keeps the two apart, and now reads from `computed_at`
rather than being hard-coded `True`.

**Accepting recomputes rather than taking the client's figures.** A proposal the
browser has been holding for twenty minutes may have been overtaken by a
reimbursed claim or a repaid loan. There is a test that settles a loan between
the proposal and the accept and asserts the loan line is gone.

What a settlement is made of, and the reasoning in each:

| Line | Basis |
|---|---|
| Final month's salary | the structure, prorated to the last working day |
| Leave encashment | encashable balances × (basic ÷ 26), both configurable |
| Gratuity | 15 days per completed year ÷ 26, ₹20,00,000 ceiling |
| Notice | contractual notice vs notice actually served |
| Unpaid expense claims | approved and never reimbursed |
| Statutory | PF / ESI / PT on the final salary |
| Loans | full outstanding balance |

**The most expensive mistake this module could make is paying the last month
twice** — once through payroll, once through the settlement — and both documents
would look right on their own. So the proposal checks for a **frozen** pay run
covering the exit month and suppresses the salary line with a warning when it
finds one. A *draft* run does not suppress it: a draft can still be recomputed
to exclude the leaver, so it is not evidence anybody has been paid.

**Income tax is not a line, deliberately.** Taxing a settlement correctly means
re-projecting the whole year with the settlement in it, and gratuity and leave
encashment have their own exemptions. A plausible TDS figure here would be a
wrong one. The proposal reports the year-to-date position as context and says in
words that the treatment needs review.

**Refusals versus warnings.** No last working day and no salary structure are
refusals — every figure is "as at" that date, and a settlement of ₹0 reads as a
decision. A missing notice period, a missing joining date, no statutory config
and no encashable leave type are **warnings**, listed in `warnings` so nobody
mistakes an empty line for a computed zero. `warnings` is never empty: the tax
note is always the last entry.

**Net can be negative** and is not clamped. A leaver with a large loan owes the
company money; showing ₹0 writes a debt off without anybody deciding to.

**Gratuity rounds where the Act rounds and not where it does not.**
`completed_years` returns years *and* leftover months rather than one rounded
figure, because eligibility does not round (four years eleven months is not five)
while the calculation does (s.4(2): six months or more counts as a year). One
number would get one of the two wrong.

Three columns of policy had to exist first, and each default is the cautious
direction: `leave_types.is_encashable` defaults **False** (paying out casual and
sick balances is the expensive way to be wrong), `statutory_configs.
gratuity_enabled` defaults **False** (a large number appearing unasked is not a
good default), and `employee_profiles.notice_period_days` is **nullable, not
defaulted** — "not recorded" and "none required" must stay different, or a
settlement recovers pay against a number nobody set.

> **Four schema gaps this work exposed, all the same shape as the payslip's
> `document_id`:** a column existed, the service read it, and no Pydantic schema
> carried it — so the console could not set it and the flag was dead. It caught
> `is_encashable`, `notice_period_days` and all five gratuity/encashment
> settings. A model column is not a feature until a schema carries it and a
> screen shows it. Every one of them now has a control.

One pre-existing bug fixed on the way: clearing a numeric field on the
employment editor sent `''`, which the server's `int | None` rejects — so
`probation_months` could never be emptied. The blank is converted at the
boundary now.

Files: [`models/settlement.py`](server/app/models/settlement.py) ·
[`services/settlement.py`](server/app/services/settlement.py) ·
[`schemas/settlement.py`](server/app/schemas/settlement.py) ·
[`api/v1/offboarding.py`](server/app/api/v1/offboarding.py) (two routes) ·
[`Offboarding.tsx`](admin/src/pages/hrms/offboarding/Offboarding.tsx) ·
[`StatutorySettings.tsx`](admin/src/pages/hrms/payroll/StatutorySettings.tsx) ·
[`LeaveSettings.tsx`](admin/src/pages/hrms/leave/LeaveSettings.tsx) ·
migration `d4f8b2c60e39`

### 2.13 One decision kernel, and the drift it made visible

Six things here are approved by somebody: leave, timesheets, attendance
regularizations, expense claims, loans and the exit settlement. Each was written
on its own, and by the time the sixth arrived they answered the same three
questions differently without anybody having chosen to.

**What the refactor found, which is the point of having done it:**

| | leave | timesheet | regularization | expense | loan |
|---|---|---|---|---|---|
| refuses a second decision | yes | **no** | yes | yes | yes |
| self-review guarded in | **router** | **router** | service | service | service |
| owner exempt from self-review | yes | yes | yes | no | no |
| reason required on rejection | **no** | yes | yes | yes | yes |
| "not awaiting a decision" code | `already_decided` | — | `already_decided` | `not_submitted` | `not_pending` |

Three of those are bugs and three are legitimate differences, and before this
there was nowhere the two kinds could be told apart.

**The bug worth the whole exercise: a timesheet could be approved twice.** The
second approval rebuilt the sheet and re-froze whatever the totals were by then,
overwriting figures payroll may already have run against, with nothing recording
that the first decision had ever been made. It had **no test coverage at all** —
no test file in the repository touched timesheet approval — which is exactly how
it went five flows without the guard the other four had.

**A rule enforced in the router is a rule the next caller does not get.** Leave
and timesheets checked self-review in the handler, so it applied to that one
route and to nothing else that decided the same record. Both are in the service
now.

**What the kernel owns, and deliberately no more:** refusing a second decision,
refusing self-review, requiring a reason on a rejection, and stamping and
auditing identically. What a sanctioned principal may be, what a leave debit
does, which attendance rows an approval rewrites — those are not workflow, they
are the thing being approved, and they stayed put as callbacks.

**Side effects run before the stamp**, and that ordering is now the kernel's
contract rather than each flow's preference. Leave documented why:
`debit_for_application` re-reads status from the database to detect a concurrent
approval, and a flushed "approved" would make the loser of that race think it
had won. Every other flow is indifferent, so the one that is not decides for all
of them.

**Reason codes and audit actions are preserved, not unified.** `not_submitted`
and `not_pending` are on the wire and clients key on them; renaming them to make
a table look neater is breaking an API for tidiness. Audit actions likewise:
splitting `expenses.reviewed` into `.approved`/`.rejected` would leave a
company's log split at the deploy boundary with no way to query "every expense
decision". Timesheets are the one flow whose log **already** distinguished the
two, so they keep that — the same argument read the other way round.

**The settlement is in the policy table but is not decidable.** It is amended
rather than decided, through an endpoint that also sets the paid date and the
UTR; it has no `reviewed_at` and no rejection. Calling `decide` on it raises a
`RuntimeError` rather than half-writing a settlement. It stays in the table
because it belongs in the **queue** — a draft settlement really is waiting for
somebody, and a "what is waiting for me" list that omitted it would lie by
omission.

**The unified queue.** `services/approvals.py` asks each flow for its own queue
and normalises the answers; `GET /approvals` and `/approvals/counts` serve them.
The safety argument is that **each flow's own permission rule decides what it
contributes** — a viewer who may not approve expense claims contributes nothing
from expenses, does not get a 403 that kills the whole queue, and does not get a
peek at spending through a door the expenses module did not open. A flow's own
"you may not" is swallowed; any other error propagates, because a silently
dropped lane reads as "nothing waiting".

**The console already had a merged inbox**, covering three of the six, whose own
header argued against a combined decide endpoint — correctly, and this work does
not add one. It gained the two missing lanes (expenses, loans) and keeps
fetching each module's own review endpoint for the rows, because it shows what
each decision turns on: the balance a leave approval spends, the totals a
timesheet approval freezes, how many lines a claim has. A flat cross-module shape
cannot carry that, and a queue showing the request without the facts behind it is
a queue that approves by reflex. The flat endpoint serves the **count**, which
cannot be had any other way without fetching five queues on every page load.

> **A gate the extension broke, and the fix.** The inbox was gated on
> `canViewTeam`, right while it held leave, attendance and timesheets — all a
> manager's business. Expenses and loans are not: somebody in finance who
> sanctions spending is routinely nobody's manager, and the gate would have
> hidden their own queue from them. There is a `canApproveSomething` helper and
> an `approverOnly` nav flag now.

Files: [`services/workflow.py`](server/app/services/workflow.py) ·
[`services/approvals.py`](server/app/services/approvals.py) ·
[`api/v1/approvals.py`](server/app/api/v1/approvals.py) ·
[`services/timesheets.py`](server/app/services/timesheets.py) (`decide`, moved
out of the router) ·
[`ApprovalsInbox.tsx`](admin/src/pages/hrms/home/ApprovalsInbox.tsx) ·
no migration — this refactor adds no columns

### 2.14 Performance — appraisals

Not the `MyPerformance` screen, which is activity analytics. This is the annual
conversation: what somebody was asked to achieve, what they and their manager
think happened, and the rating that comes out of it.

**A cycle carries its own rating scale, and a review freezes it.** Companies move
from 1-5 to 1-4 and relabel their points, and last year's ratings must not
silently rescale. `rating_max` is copied onto the review at finalisation, the
tenth freeze in this system. A "4" without the scale it was given on is a digit,
not a rating.

**Weights are basis points and must total 10,000** — refused at submission with
the shortfall named, exactly the way a salary structure refuses components that
do not come to gross. The live drive showed the message: *"The goal weights come
to 80% and must come to 100%. Add 20%."* A weighted mean over weights that do not
sum is a number with no meaning that still renders as a rating.

**Scores are integer hundredths.** `sum(weight_bps × rating) × 100 //
sum(weight_bps)` — one division at the end, no float anywhere. 30%×4 + 50%×3 +
20%×5 is `370` on the wire and 3.70 on screen.

**An unrated goal does not drag the mean toward zero.** The weights renormalise
over what was actually rated, because "not rated" and "rated lowest" are
different states and the model keeps them different — null, never 0. The rating
picker clears on a second click for the same reason: there has to be a way back
from a rating set by accident.

**The computed score does not overrule the manager.** `overall_rating` is stored
as given. When it differs from the arithmetic by a whole point or more, the
service demands a written reason — not because the manager is wrong, but because
"the numbers said 2.00 and the rating is 4" is the most challenged sentence in
any appraisal and somebody should have written down why *before* it is
challenged. The console shows the reason field before the finalise button rather
than as an error after it.

**Three turns, and one rule about each:**

1. **Only the employee writes their own half.** Not their manager, not HR. "I
   did not say that" is unanswerable once somebody else can write it.
2. **The manager decides**, through the approval kernel — a seventh flow that
   cost one policy entry and got every guard the other six have, plus a place in
   the unified queue. `returned` is a real state rather than a synonym for
   draft: somebody whose review comes back needs to know it was looked at.
3. **Somebody finalises**, which freezes it. Finalisation is deliberately *not*
   kernel-driven: it is a second decision on a record whose one set of reviewer
   columns the manager's decision already used, and `workflow.PERFORMANCE` says
   so rather than leaving the omission to be guessed at.

**Goals cannot move once the employee has rated against them.** Shifting the
target after the fact is the thing an appraisal system must not permit.

**Finalising and sharing are separate**, because HR finalises a batch in one
afternoon and releases them when the increment letters are ready. Before release
the rating fields are **removed from the employee's payload**, not flagged — a
client that receives a number will eventually render it. The page says why the
section is blank, since a blank panel after a finalised review reads as a bug.

**A competency's name is copied onto the rating**, the same discipline payslip
lines use. Renaming "Ownership" to "Accountability" must not rewrite what
somebody was rated on three years ago. The catalogue is company-wide rather than
per-cycle — a framework re-entered every year drifts — and competencies are
deactivated rather than deleted, enforced by a RESTRICT on the rating table.

> **One test worth calling out.** Every other test in the file would pass
> identically if the router were registered without `require_module`, because
> the fixture's company resolves to a plan that allows everything.
> `test_the_module_gate_actually_bites` restricts the plan and asserts the 402.
> A module gate nobody tests is a module gate that quietly is not there.

Files: [`models/performance.py`](server/app/models/performance.py) ·
[`services/performance.py`](server/app/services/performance.py) ·
[`schemas/performance.py`](server/app/schemas/performance.py) ·
[`api/v1/performance.py`](server/app/api/v1/performance.py) ·
[`MyReview.tsx`](admin/src/pages/hrms/performance/MyReview.tsx) ·
[`Appraisals.tsx`](admin/src/pages/hrms/performance/Appraisals.tsx) ·
migration `e5a9c3d71f4a` · flag `can_manage_performance`

### 2.15 Engagement — announcements, pulse surveys, recognition

Most of this module is ordinary. One part of it is not, and that part decided
the shape of everything around it.

**Anonymity is structural, not a promise.** A survey that says "your answers are
anonymous" and stores a `user_id` beside each answer is anonymous until somebody
with database access is curious, or a subpoena arrives, or a well-meaning
engineer adds a "who has not responded yet" report and joins the two tables.

So for an anonymous survey **the response row carries no user id at all**.
Preventing a second submission still works — through `survey_participants`, a
separate table recording *that* somebody answered and never *what*. The two
tables share no key. The guarantee is that the join is impossible, not that
nobody writes it.

That is why "who has not answered yet" is a first-class endpoint reading only
the participant table. Chasing non-responders is legitimate and necessary, and
it must not require touching anything that knows what anybody said. Building
that report was the thing most likely to break the guarantee, so it was built
first and given its own door.

**There is no function anywhere in the module that takes a survey and returns
who said what.** Not a private one, not a debug one. Submitting returns **204
with no body**, because a response id in the reply would be a handle to the
thing that must not be linkable to the person holding it. And the submission is
deliberately *not* audited against the actor — an audit row saying "X submitted
to anonymous survey Y at 14:03" beside a response timestamped 14:03 is exactly
the join the module exists to prevent.

**Results are refused below a floor, not warned about.** A warning is something
a reader scrolls past while the number underneath it is still on their screen.
The live drive showed the threshold doing its job:

```
after 1 response(s): WITHHELD
after 2 response(s): WITHHELD
after 3 response(s): WITHHELD
after 4 response(s): mean 4.00
after 5 response(s): mean 3.60
```

**Free text is held to a higher bar than ratings** — the floor plus two. A
sentence carries voice, detail and grievance and identifies its author in a way
a "4" does not. In the same drive, five ratings showed a mean and a
distribution while five written answers stayed withheld.

**An audience too small to ever show a result is refused at the door.** An
anonymous survey of three people can never display anything, and letting it run
would collect answers under a promise the system then cannot keep.

**`is_anonymous` is frozen when the survey opens** — the only field that cannot
be corrected, and the right trade: flipping it afterwards would retroactively
expose people who answered believing otherwise. The population is frozen at the
same moment, so somebody moving department mid-survey does not silently leave
the group it was measuring, and a trend across two quarters compares the same
people.

> **Where the promise is stated matters as much as whether it is kept.** The
> banner above an anonymous survey describes the mechanism — no identity is
> stored with the answer, results withheld below N — rather than the word
> "anonymous", which everybody has learned to disbelieve. And a withheld result
> occupies the space the numbers would have, with a sentence in it: a greyed
> empty chart is indistinguishable from a loading failure, and somebody will
> either file a bug or conclude that nobody answered.

The rest, briefly:

**Read and acknowledged are different columns**, because they are different
questions. "97% have read it" is not an answer to "has everybody accepted the
new expenses policy". Both timestamps are stamped once and never rewritten by a
later visit — both are evidence. The reach report's "outstanding" list means
*has not done what was asked*, which is acknowledging where that was required
and reading otherwise.

**Publishing is one-way.** Un-publishing a post people have read would leave the
read receipts as evidence about a document that officially never existed;
archiving takes it off the feed and keeps it readable.

**Recognition has no permission gate** — recognition only administrators may
give is not recognition, it is an award. A private one is visible to the two
people in it and to nobody else, administrators included: a quiet thank you HR
can read is not a quiet thank you, and knowing it might be read is enough to
stop some being sent. It can cite a competency from the appraisal catalogue,
which is the point of the two living in one product — "Ownership: she took the
incident at 2am" is a sentence that belongs in a review, and re-typing it from
memory in March is how it gets lost.

Files: [`models/engagement.py`](server/app/models/engagement.py) ·
[`services/engagement.py`](server/app/services/engagement.py) ·
[`schemas/engagement.py`](server/app/schemas/engagement.py) ·
[`api/v1/engagement.py`](server/app/api/v1/engagement.py) ·
[`Engagement.tsx`](admin/src/pages/hrms/engagement/Engagement.tsx) ·
[`EngagementAdmin.tsx`](admin/src/pages/hrms/engagement/EngagementAdmin.tsx) ·
migration `f6b1d4e82a5c` · flag `can_manage_engagement`

### 2.16 Small consolidations

- `add_months` existed in `services/leave` and was duplicated into
  `services/corehr` for probation dates. Both now delegate to
  [`core/dates.py`](server/app/core/dates.py) — one place the February edge is
  reasoned about.
- `core/crypto.py` was extracted from `services/mailconfig`, which held the only
  Fernet in the codebase, when statutory identity became a second thing needing
  encryption at rest.
- `corehr.file_bytes` was extracted from `promote_document` so document
  promotion and letter filing share one writer.

---

## 3. Conventions any new module must follow

Derived from the existing code, not invented. A module that breaks one of these
is inconsistent with everything around it.

1. **Thin handlers.** Every rule lives in `app/services/<module>.py`. A router
   resolves who is asking and who they are asking about, then calls the service.
   A rule in a handler is a bug.
2. **Typed refusals.** Services raise `<Module>Error(code, message, status)`;
   routers turn it into `{"reason": ..., "message": ...}` so the console branches
   on a code, never on prose.
3. **Identity never comes from a request body.** No `user_id` on a self-service
   path; the subject is the authenticated caller. Privileged "on behalf of"
   filing is a **separate endpoint** with its own permission, so the unprivileged
   one has no code path to the privilege.
4. **Cross-tenant miss is 404, not 403.** A 403 confirms the id exists somewhere.
5. **Permission flags restrict, never grant.** Role check runs first; the flag
   narrows it. Default `True`, so existing accounts keep what they had.
6. **Register the module in `core/modules.py`** and gate the router with
   `require_module("<key>")` in `api/v1/router.py`.
7. **Audit every state change**, with field *names* for sensitive data and never
   values.
8. **Frozen records stay frozen.** Anything signed off — an approved timesheet,
   an issued letter — stores its own snapshot rather than re-deriving.
9. **Tests go through the real HTTP surface**, two tenants always, and assert on
   setup calls so a wrong endpoint fails at its cause rather than three
   assertions later.

### Permission flags so far

`can_view_screenshots` · `can_approve_timesheets` · `can_export_data` ·
`can_manage_projects` · `can_approve_leave` · `can_approve_regularization` ·
`can_manage_assets` · `can_manage_onboarding` · `can_manage_helpdesk` ·
**`can_manage_people`** · **`can_issue_letters`** ·
**`can_approve_expenses`** · **`can_reimburse_expenses`** ·
**`can_approve_loans`** · **`can_disburse_loans`** ·
**`can_manage_payroll`** (the only one defaulting **false**) ·
`can_view_team` · `can_administer`

---

## 4. Known limits and deferred decisions

| Thing | Current state | Why |
|---|---|---|
| PDF generation | Letters render **HTML** with a print stylesheet | No renderer installed; weasyprint needs native libs on Windows. Browser "Save as PDF" produces the artefact. A renderer can slot in behind the same interface. |
| ~~Approval flows~~ | **Done.** One kernel, six policies, a unified queue | See §2.13. The three genuine differences between flows are now declared rather than accidental; the three bugs are fixed. |
| Reports | 13 types behind one engine; no user-defined builder | Engine design is sound, catalogue is thin. Item 19. |
| `SECRET_KEY` rotation | Makes encrypted statutory values unreadable | Documented and deliberate in `core/crypto.py`; a second key is a second thing to lose. |
| Salary in letters | No salary merge field | Payroll now exists — a salary certificate is buildable and simply has not been added to the merge field set yet. |
| Multi-currency expenses | One currency per deployment (INR) | There is no FX table and no rate source. A claim in USD beside one in INR, both totalled as if the same unit, is worse than not offering the field. |
| Expense claim age | Fixed 365-day window | One number, not a policy engine. A company needing a different window will say so. |
| Loan interest | Simple, on the original principal | Reducing balance needs an amortisation table and a rule for missed instalments; not worth inventing for a feature whose common case is an interest-free advance. |
| Loan eligibility | No salary-multiple limit | Now buildable — a salary structure exists. Deferred until pay runs land so the limit is checked against a figure a pay run agrees with. |
| CTC | Not stored or shown | Cost to company is gross plus employer PF, ESI and gratuity — none of which exist until checkpoint 2. A `ctc` column now would be a number nobody could compute correctly. |
| ~~Structure deletion~~ | **Fixed in checkpoint 3** | A structure a payslip used is refused with `structure_in_use`. |
| Marginal relief on surcharge | Not implemented | It applies only just above each surcharge threshold and needs an iterative comparison; an approximate version is worse than a documented absence. Companies with employees near ₹50 lakh should check those by hand. |
| FY 2026-27 rates | Carried forward, flagged `provisional` | Their Finance Act was not known when this was written. The flag reaches the UI. |
| Perquisites, other income, previous employer | Not modelled | Each is a real part of a full Form 16 with its own rules. Named in `models/incometax` so the absence is visible rather than assumed. |
| ~~Senior-citizen slabs~~ | **Done in 4b** | 60+ and 80+ bands, age taken at 31 March. |
| Form 16 Part A | Not produced | TRACES-generated against the employer's TAN and downloaded from the income-tax portal. Producing a lookalike would let somebody file against a document no tax authority has seen. |
| Statutory rate history | One config row, not effective-dated | A payslip freezes its own lines and an approved run cannot be recomputed, so past months are already correct at their old rates. Effective-dating this table is the right answer for a year-end reconciliation across a rate change; it is not needed to be correct today. |
| Bank file format | One CSV layout | Every bank ingests a different one. The layout is a single function in `payoutputs`; a company whose bank wants another will say which. |
| PF ECR / ESI return | Text and CSV built from the payslip lines | Neither is submitted programmatically — the portals take an upload. Producing the file is the part that can be got wrong; uploading it is not. |
| Settlement tax | Not computed; the year-to-date position is reported instead | Gratuity and leave encashment have their own exemptions and the whole year needs re-projecting with the settlement in it. A plausible figure would be a wrong one, and a wrong one in a settlement is the number somebody files a return against. |
| Settlement line editing | Accept, or type the three numbers by hand — no per-line edit | The negotiated case is a different figure, not a different line, and the typed-in route already covers it. A line editor would make the itemisation something somebody could write rather than something the system computed. |
| Unified decide endpoint | There is none, and there should not be | A `POST /approvals/{id}/decide` would be a sixth answer to "whose data may this manager see" and a second place a leave balance gets debited. The queue reads; the flows decide. |
| Leave rejections need no reason | Every other flow requires one | Moving a rule is not the moment to invent one. Recorded in `workflow.LEAVE.reason_on_reject` with a test asserting it is deliberate, so whoever changes it does so on purpose. |
| Timesheet queue window | The inbox looks at this week and last | Timesheets have no "everything pending" endpoint — approval is per period. An older unsubmitted sheet is unreachable from the inbox. |
| 360° feedback | Not built. A review has two sides — the employee and their manager | Peer and skip-level feedback is a different data shape (many writers, one subject, usually anonymous) and anonymity is a promise this schema cannot currently keep. Worth doing properly rather than as a third rating column. |
| Goal cascading | Goals are set per person, not inherited from a manager's | Cascading needs a parent link and a rule for what happens when the parent is reweighted mid-cycle. One column, several decisions; not guessed at. |
| Calibration | No cross-team rating distribution or forced ranking | A calibration meeting is a process, not a screen, and the ratings it produces already have a home. A distribution report is the useful half and belongs with the report builder (item 19). |
| Survey trends across cycles | Each survey stands alone; no quarter-on-quarter chart | Comparing two anonymous surveys means comparing two frozen populations, which the model supports — but a trend line that silently spans a reorganisation is a worse answer than no trend line. Belongs with the report builder (item 19), where the population can be stated. |
| Announcement attachments | Body text only | Documents have a home already, and an attachment here would be a second uploader with its own retention rules. A link to a filed document is the cheaper and more honest join. |
| Survey reminders | No nudge to non-responders | The outstanding list exists and is named; wiring it to the notification dispatcher is small. Left out because an automatic reminder on an anonymous survey needs a decision about how often is chasing and how often is pressure. |
| Attendance and payroll | Only unpaid *leave* affects days paid | Absence recorded as attendance rather than leave does not yet reduce pay. Needs a decision about which is authoritative before it is wired. |

---

## 5. Next step

**Eighteen of nineteen modules are complete.** One remains:

**19 — Ad-hoc report builder.** Last on purpose: its value depends entirely on
everything else existing, and it now has payroll registers, appraisal ratings,
settlements, approval history and survey results to draw on that it would not
have had six modules ago.

One thing it will have to be careful about, which did not exist before this
module: **a report builder that can query `survey_responses` would undo the
anonymity guarantee in a single afternoon.** Whatever schema it exposes must
either omit those tables or expose them only through the same suppression rules
`services/engagement.results` applies. That is a design constraint on item 19,
not an afterthought.

Two decisions still open, neither blocking:

* **Attendance does not affect pay.** Only unpaid leave reduces days paid;
  absence recorded as attendance does not.
* **Leave rejections require no reason**, alone among the seven approval flows.
