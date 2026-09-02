/* Payroll — the month at a glance, and the one thing to do next.
 *
 * The module had eight screens and no front door. Somebody opening Payroll
 * landed on the salary-structure register, which is a reference table, not an
 * answer to the question they arrived with: *where is this month up to, and
 * what is waiting on me.*
 *
 * So this page answers exactly that, in the order somebody asks it:
 *
 * 1. **Where is this month.** One card, one status, one button — and the button
 *    is the next real step rather than a menu of every step.
 * 2. **What it costs.** Gross, deductions, net, and what the company pays on
 *    top, which is the number that never appears on a payslip and is the one
 *    finance is asked for.
 * 3. **What the statutory dues are**, because they are due on dates that have
 *    nothing to do with payday.
 * 4. **The year so far**, so a month can be read against the ones before it.
 *
 * Nothing here computes, approves or pays. Every action is a link into the run,
 * which is where the decisions and the audit trail already live — a second
 * place to approve payroll would be a second place to get it wrong.
 */

import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import '../../../styles/payroll.css'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { canAdminister, useAuth } from '../../../lib/auth'
import { money } from '../../../lib/format'
import { EmptyState, ErrorNote, Loading } from '../../../components/ui'
import {
  IconAlert,
  IconCard,
  IconCheck,
  IconChart,
  IconSheet,
  IconUsers,
} from '../../../components/Icons'

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

interface PayRun {
  id: string
  period_year: number
  period_month: number
  status: 'draft' | 'computed' | 'approved' | 'paid' | 'cancelled'
  pay_date: string | null
  total_gross: number
  total_deductions: number
  total_net: number
  employee_count: number
}

interface Check {
  key: string
  title: string
  severity: 'blocking' | 'warning' | 'info'
  count: number
}

interface RunDetail extends PayRun {
  payslips: Array<{
    id: string
    user_name: string
    net: number
    employer_contributions: number
    lines: Array<{ kind: string; code: string; name: string; amount: number; source: string }>
  }>
  skipped: Array<{ full_name: string }>
}

/** What the next click should be, given where the run has got to. */
const NEXT_STEP: Record<PayRun['status'], { label: string; why: string }> = {
  draft: { label: 'Compute this month', why: 'The month is open. Nothing is calculated yet.' },
  computed: {
    label: 'Review and approve',
    why: 'Payslips exist and nothing is committed. This is the moment to check what moved.',
  },
  approved: {
    label: 'Pay and file payslips',
    why: 'Approved and frozen. Generate the bank file, then record the payment.',
  },
  paid: { label: 'Open the run', why: 'Paid. Payslips are with employees.' },
  cancelled: { label: 'Open the run', why: 'This run was abandoned.' },
}

export default function PayrollOverview() {
  const { user } = useAuth()
  const allowed = canAdminister(user)

  const runsQ = useQuery<PayRun[]>('pay-runs', () => api.get<PayRun[]>('/payruns'), {
    enabled: allowed,
  })

  const now = new Date()
  const runs = useMemo(
    () =>
      [...(runsQ.data ?? [])]
        .filter((run) => run.status !== 'cancelled')
        .sort((a, b) =>
          b.period_year * 12 + b.period_month - (a.period_year * 12 + a.period_month),
        ),
    [runsQ.data],
  )

  /* The current month's run if it has been opened, otherwise the most recent
     one. Falling back matters on the 1st: a company that has not opened the new
     month should see last month finished rather than an empty page. */
  const current =
    runs.find(
      (run) =>
        run.period_year === now.getFullYear() && run.period_month === now.getMonth() + 1,
    ) ?? runs[0] ?? null

  const detailQ = useQuery<RunDetail>(
    `pay-overview-${current?.id ?? 'none'}`,
    () => api.get<RunDetail>(`/payruns/${current!.id}`),
    { enabled: Boolean(current) },
  )
  const checksQ = useQuery<Check[]>(
    `pay-overview-checks-${current?.id ?? 'none'}`,
    () => api.get<Check[]>(`/payruns/${current!.id}/readiness`),
    { enabled: Boolean(current) },
  )

  /* Statutory deductions, split out of the payslip lines by their source. Read
     from the lines rather than recomputed, so this can never disagree with what
     was actually deducted.

     Called here, above every early return, and not beside the figures it feeds.
     React counts hooks per render, so a hook after a conditional `return` runs
     on some renders and not others — which crashes the page the moment the
     query resolves. */
  const statutory = useMemoStatutory(detailQ.data)

  if (!allowed) {
    return (
      <div className="page">
        <div className="page-head">
          <h1 className="page-title">Payroll</h1>
        </div>
        <section className="card">
          <EmptyState
            icon={<IconCard size={22} />}
            title="Payroll is not open to your account"
            body="Salaries are administrator-only. Your own payslips and salary are on My salary and My payslips."
          />
        </section>
      </div>
    )
  }

  if (runsQ.loading) return <Loading label="Reading your pay runs…" />
  if (runsQ.error) return <ErrorNote>{runsQ.error}</ErrorNote>

  const detail = detailQ.data
  const checks = checksQ.data ?? []
  const blocking = checks.filter((c) => c.severity === 'blocking' && c.count > 0)
  const warnings = checks.filter((c) => c.severity === 'warning' && c.count > 0)

  /* The employer's own cost, which appears on no payslip: PF, ESI and gratuity
     the company pays on top of the gross. Finance is asked for this number far
     more often than for the net. */
  const employerCost = (detail?.payslips ?? []).reduce(
    (sum, slip) => sum + (slip.employer_contributions ?? 0),
    0,
  )

  const thisFy = runs.filter((run) => inFinancialYearOf(run, now))
  const ytdNet = thisFy.reduce((sum, run) => sum + run.total_net, 0)
  const ytdGross = thisFy.reduce((sum, run) => sum + run.total_gross, 0)

  return (
    <div className="page pr-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Payroll</h1>
          <p className="page-sub">
            Where this month stands, what it costs, and what is waiting on you.
          </p>
        </div>
        <div className="head-actions">
          <Link className="btn" to="/payroll">
            Salary structures
          </Link>
          <Link className="btn btn-primary" to="/payroll/runs">
            Open pay runs
          </Link>
        </div>
      </div>

      {!current ? (
        <section className="card">
          <EmptyState
            icon={<IconCard size={22} />}
            title="No pay run yet"
            body="Payroll starts by opening a month. Nothing is computed and nobody is paid until you say so — opening it just creates the run."
            action={
              <Link className="btn btn-primary" to="/payroll/runs">
                Open a month
              </Link>
            }
          />
        </section>
      ) : (
        <>
          {/* ------------------------------------------------ this month -- */}
          <section className="card pr-now">
            <div className="pr-now-head">
              <div>
                <div className="pr-now-label">Current pay run</div>
                <h2 className="pr-now-title">
                  {MONTHS[current.period_month - 1]} {current.period_year}
                </h2>
                <p className="pr-now-why">{NEXT_STEP[current.status].why}</p>
              </div>
              <div className="pr-now-side">
                <span className={`pr-pill is-${current.status}`}>{current.status}</span>
                <Link className="btn btn-primary" to="/payroll/runs">
                  {NEXT_STEP[current.status].label}
                </Link>
              </div>
            </div>

            <div className="pr-now-figures">
              <Figure label="Employees" value={String(current.employee_count)} icon={<IconUsers size={15} />} />
              <Figure label="Gross" value={money(current.total_gross)} />
              <Figure label="Deductions" value={money(current.total_deductions)} />
              <Figure label="Net payable" value={money(current.total_net)} strong />
              <Figure
                label="Employer cost on top"
                value={money(employerCost)}
                hint="PF, ESI and gratuity the company pays — on no payslip"
              />
            </div>
          </section>

          {/* --------------------------------------------- what is waiting -- */}
          <div className="grid grid-2 pr-overview-grid">
            <section className="card">
              <div className="card-head">
                <h2 className="card-title">Waiting on you</h2>
              </div>
              {checksQ.loading ? (
                <Loading />
              ) : checksQ.error ? (
                /* A failed check must never read as a clear one. "Nothing is
                   blocking this month" on top of a request that did not answer
                   is the most dangerous sentence this page could print. */
                <div style={{ padding: 'var(--space-5)' }}>
                  <ErrorNote>
                    The checklist could not be read, so this month has not been checked.{' '}
                    {checksQ.error}
                  </ErrorNote>
                </div>
              ) : blocking.length === 0 && warnings.length === 0 ? (
                <div className="pr-clear">
                  <IconCheck size={18} />
                  <div>
                    <div className="pr-title">Nothing is blocking this month</div>
                    <p className="muted">
                      Every active employee has a salary and a bank account, and no leave or
                      attendance decision is outstanding.
                    </p>
                  </div>
                </div>
              ) : (
                <ul className="pr-waiting">
                  {[...blocking, ...warnings].map((check) => (
                    <li key={check.key} className={`pr-waiting-row is-${check.severity}`}>
                      <span className="pr-waiting-mark" aria-hidden="true">
                        <IconAlert size={14} />
                      </span>
                      <span className="pr-waiting-title">{check.title}</span>
                      <span className="pr-waiting-count">{check.count}</span>
                    </li>
                  ))}
                  <li className="pr-waiting-foot">
                    <Link to="/payroll/runs">See the full checklist →</Link>
                  </li>
                </ul>
              )}
            </section>

            <section className="card">
              <div className="card-head">
                <h2 className="card-title">Statutory this month</h2>
                <span className="muted">deducted from the payslips above</span>
              </div>
              {statutory.length === 0 ? (
                <Empty>Nothing computed yet, so there is nothing to remit.</Empty>
              ) : (
                <ul className="pr-statutory">
                  {statutory.map((row) => (
                    <li key={row.code}>
                      <span className="pr-statutory-name">{row.name}</span>
                      <span className="pr-statutory-amount">{money(row.amount)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          {/* ------------------------------------------------- the year --- */}
          <section className="card">
            <div className="card-head">
              <h2 className="card-title">This financial year</h2>
              <span className="muted">
                {thisFy.length} run{thisFy.length === 1 ? '' : 's'} · {money(ytdGross)} gross ·{' '}
                {money(ytdNet)} paid
              </span>
            </div>
            {runs.length === 0 ? (
              <Empty>No runs yet.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Month</th>
                      <th className="num">People</th>
                      <th className="num">Gross</th>
                      <th className="num">Deductions</th>
                      <th className="num">Net</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.slice(0, 12).map((run) => (
                      <tr key={run.id}>
                        <td className="pr-title">
                          {MONTHS[run.period_month - 1]} {run.period_year}
                        </td>
                        <td className="num">{run.employee_count}</td>
                        <td className="num">{money(run.total_gross)}</td>
                        <td className="num">{money(run.total_deductions)}</td>
                        <td className="num">{money(run.total_net)}</td>
                        <td>
                          <span className={`pr-pill is-${run.status}`}>{run.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Where to go next, named rather than left to the rail. */}
          <section className="card pr-jump">
            <Link to="/payroll/runs" className="pr-jump-link">
              <IconSheet size={16} /> Pay runs, register and bank file
            </Link>
            <Link to="/payroll" className="pr-jump-link">
              <IconCard size={16} /> Salary structures
            </Link>
            <Link to="/payroll/components" className="pr-jump-link">
              <IconChart size={16} /> Pay components
            </Link>
            <Link to="/payroll/tax" className="pr-jump-link">
              <IconCheck size={16} /> Tax declarations
            </Link>
            <Link to="/payroll/year-end" className="pr-jump-link">
              <IconSheet size={16} /> Year end &amp; Form 16
            </Link>
          </section>
        </>
      )}
    </div>
  )
}

function Figure({
  label,
  value,
  hint,
  icon,
  strong,
}: {
  label: string
  value: string
  hint?: string
  icon?: React.ReactNode
  strong?: boolean
}) {
  return (
    <div className={`pr-figure${strong ? ' is-strong' : ''}`}>
      <div className="pr-figure-label">
        {icon}
        {label}
      </div>
      <div className="pr-figure-value">{value}</div>
      {hint && <div className="pr-figure-hint">{hint}</div>}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="empty">{children}</p>
}

/** The statutory deductions on this run, read off the payslip lines.
 *
 * Read rather than recomputed: recomputing would be a second implementation of
 * PF and ESI, and the two would disagree on exactly the month somebody changed
 * a slab. */
function useMemoStatutory(detail: RunDetail | undefined) {
  return useMemo(() => {
    const NAMES: Record<string, string> = {
      pf: 'Provident Fund',
      esi: 'ESI',
      professional_tax: 'Professional Tax',
      lwf: 'Labour Welfare Fund',
      tds: 'Income tax (TDS)',
    }
    const totals = new Map<string, number>()
    for (const slip of detail?.payslips ?? []) {
      for (const line of slip.lines) {
        if (line.source in NAMES && line.kind === 'deduction') {
          totals.set(line.source, (totals.get(line.source) ?? 0) + line.amount)
        }
      }
    }
    return [...totals]
      .filter(([, amount]) => amount > 0)
      .map(([code, amount]) => ({ code, name: NAMES[code], amount }))
      .sort((a, b) => b.amount - a.amount)
  }, [detail])
}

/** Whether a run falls in the financial year the given date sits in (Apr–Mar). */
function inFinancialYearOf(run: PayRun, when: Date): boolean {
  const fy = when.getMonth() + 1 >= 4 ? when.getFullYear() : when.getFullYear() - 1
  const runFy = run.period_month >= 4 ? run.period_year : run.period_year - 1
  return fy === runFy
}
