/* Payroll: the month, the payslips in it, and the outputs that come off it.
   Also the employee's own "My payslips", which shares the payslip card.

   The four server truths this file is built around are stated on the page
   component below, where the state machine they describe is actually rendered. */

import { useCallback, useState } from 'react'
import { api, download, downloadPost, openPrintable } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { money } from '../../../lib/format'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import type { PayRun, PayRunDetail, PayrollRegister, Payslip } from '../../../lib/types'
import '../../../styles/payroll.css'

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export function periodName(run: { period_year: number; period_month: number }): string {
  return `${MONTHS[run.period_month - 1]} ${run.period_year}`
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'paid' ? 'ok'
      : status === 'approved' ? 'go'
        : status === 'computed' ? 'warn'
          : status === 'cancelled' ? 'bad'
            : 'muted'
  return (
    <span className={`pr-status pr-status-${tone}`}>
      {status.replace(/^./, (c) => c.toUpperCase())}
    </span>
  )
}

/**
 * The payroll month.
 *
 * This page was a list of runs you expanded one at a time, which is the wrong
 * shape for how payroll is actually done. Nobody browses pay runs. They work
 * *one month* — the current one — from end to end, and the only other months
 * that matter are the one behind it and the one in front. A list made the month
 * something you had to find before you could start.
 *
 * So the month is the page: a strip of the financial year across the top, one
 * month selected, and everything below it about that month. The four server
 * truths the old page was built around are unchanged and still govern
 * everything here:
 *
 * 1. **Compute is a replace.** Pressing it again rebuilds every payslip from
 *    current data. The control says "Recompute" once a run has been computed.
 * 2. **Approval freezes.** After it there is no compute control at all.
 * 3. **Paying moves money elsewhere** — loan instalments settle and expense
 *    claims reimburse on that transition, and the confirmation says so.
 * 4. **Skipped employees are shown.** People with no salary structure are left
 *    out of the run, and the omission is visible rather than silent.
 *
 * One thing this page deliberately does NOT have: lock/unlock and release/hold
 * switches over inputs and payslips. Those are a different product's state
 * machine. This server's is `draft → computed → approved → paid`, and the
 * stage rows below render exactly that — the real transitions, with the real
 * `can_*` flags the server resolved, rather than switches that would look
 * authoritative and toggle nothing.
 */

const MONTH_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/** Last day of a month, so the strip can print the period it covers. */
function monthEnd(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

/**
 * The twelve cells of an Indian financial year, April to March.
 *
 * April rather than January because that is the year payroll is run against —
 * tax declarations, Form 16 and the statutory returns all break there, and a
 * strip that ran January to December would put the two halves of one payroll
 * year on two different screens.
 */
function financialYear(startYear: number): Array<{ year: number; month: number }> {
  return Array.from({ length: 12 }, (_, index) => {
    const month = ((index + 3) % 12) + 1
    return { year: month >= 4 ? startYear : startYear + 1, month }
  })
}

/** Which financial year a date falls in — April starts it. */
function fyOf(year: number, month: number): number {
  return month >= 4 ? year : year - 1
}

export default function PayRuns() {
  const runsQ = useQuery<PayRun[]>('pay-runs', () => api.get<PayRun[]>('/payruns'))
  const [error, setError] = useState<string | null>(null)

  const now = new Date()
  const thisYear = now.getFullYear()
  const thisMonth = now.getMonth() + 1

  const [fy, setFy] = useState(() => fyOf(thisYear, thisMonth))
  const [picked, setPicked] = useState(() => ({ year: thisYear, month: thisMonth }))

  const months = financialYear(fy)
  const runs = runsQ.data ?? []
  /* Keyed lookup rather than a find per cell: the strip renders twelve cells and
     a company with three years of history has thirty-six runs. */
  const byPeriod = new Map(runs.map((run) => [`${run.period_year}-${run.period_month}`, run]))
  const run = byPeriod.get(`${picked.year}-${picked.month}`) ?? null

  const periodLabel = `${MONTH_SHORT[picked.month - 1]} ${picked.year}`
  const longLabel = `${['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'][picked.month - 1]} ${picked.year}`

  function step(delta: number) {
    setFy((year) => year + delta)
  }

  return (
    <div className="page pr-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Payroll</h1>
          <p className="page-sub">
            One run a month: open it, compute, review, approve, then record the payment.
            Everything on this page is about {longLabel}.
          </p>
        </div>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      {/* ------------------------------------------------------- the strip -- */}
      <section className="card pr-strip-card">
        <div className="pr-strip">
          <button
            className="pr-strip-step"
            onClick={() => step(-1)}
            aria-label={`Financial year ${fy - 1}–${String(fy).slice(2)}`}
            title="Previous financial year"
          >
            ‹
          </button>

          <div className="pr-strip-months" role="tablist" aria-label="Payroll month">
            {months.map((cell) => {
              const cellRun = byPeriod.get(`${cell.year}-${cell.month}`)
              const on = cell.year === picked.year && cell.month === picked.month
              const current = cell.year === thisYear && cell.month === thisMonth
              return (
                <button
                  key={`${cell.year}-${cell.month}`}
                  role="tab"
                  aria-selected={on}
                  className={`pr-month${on ? ' is-on' : ''}${cellRun ? ' has-run' : ''}`}
                  onClick={() => setPicked(cell)}
                >
                  <span className="pr-month-name">{MONTH_SHORT[cell.month - 1]}</span>
                  <span className="pr-month-year">{cell.year}</span>
                  {/* The status of the month's run, as a word rather than a
                      colour on its own — a dot alone cannot tell "computed"
                      from "approved", which is the distinction that matters. */}
                  {cellRun && <span className="pr-month-state">{cellRun.status}</span>}
                  {current && !cellRun && <span className="pr-month-now">now</span>}
                </button>
              )
            })}
          </div>

          <button
            className="pr-strip-step"
            onClick={() => step(1)}
            aria-label={`Financial year ${fy + 1}–${String(fy + 2).slice(2)}`}
            title="Next financial year"
          >
            ›
          </button>
        </div>
        <p className="pr-strip-foot">Financial year {fy}–{String(fy + 1).slice(2)}</p>
      </section>

      {/* ------------------------------------------------------ the period -- */}
      <section className="card pr-period">
        <div className="pr-period-id">
          <h2 className="pr-period-name">{longLabel}</h2>
          <p className="pr-period-meta">
            Covers 1 {periodLabel} to {monthEnd(picked.year, picked.month)} {periodLabel}
            {run?.pay_date ? ` · pay date ${run.pay_date}` : ''}
          </p>
        </div>
        {run ? <StatusPill status={run.status} /> : <span className="pr-period-none">Not opened</span>}
      </section>

      {runsQ.loading ? (
        <Loading />
      ) : runsQ.error ? (
        <ErrorNote>{runsQ.error}</ErrorNote>
      ) : run ? (
        <>
          <div className="pr-overview">
            <section className="card pr-panel">
              <h3 className="card-title">Payout details</h3>
              <div className="pr-figure">
                <span className="pr-figure-value">{money(run.total_net)}</span>
                <span className="pr-figure-label">Net pay</span>
              </div>
              <dl className="pr-facts">
                <div>
                  <dt>Gross pay</dt>
                  <dd>{money(run.total_gross)}</dd>
                </div>
                <div>
                  <dt>Deductions</dt>
                  <dd>{money(run.total_deductions)}</dd>
                </div>
                <div>
                  <dt>Pay date</dt>
                  <dd>{run.pay_date ?? 'not set'}</dd>
                </div>
              </dl>
            </section>

            <section className="card pr-panel">
              <h3 className="card-title">Employee details</h3>
              <div className="pr-figure">
                <span className="pr-figure-value">{run.employee_count}</span>
                <span className="pr-figure-label">
                  {run.employee_count === 1 ? 'payslip in this run' : 'payslips in this run'}
                </span>
              </div>
              <dl className="pr-facts">
                <div>
                  <dt>Computed</dt>
                  <dd>{run.computed_by_name ?? (run.computed_at ? 'yes' : 'not yet')}</dd>
                </div>
                <div>
                  <dt>Approved</dt>
                  <dd>{run.approved_by_name ?? (run.approved_at ? 'yes' : 'not yet')}</dd>
                </div>
                <div>
                  <dt>Paid</dt>
                  <dd>{run.paid_by_name ?? (run.paid_at ? 'yes' : 'not yet')}</dd>
                </div>
              </dl>
            </section>

            <section className="card pr-panel">
              <h3 className="card-title">Stage</h3>
              {/* The server's own state machine, read off the run rather than
                  re-derived here. A stage the run has passed reads as done; the
                  one it is at reads as next; the rest are simply not yet. */}
              <ul className="pr-stages">
                <Stage name="Opened" done meta="The month exists and can be computed." />
                <Stage
                  name="Computed"
                  done={Boolean(run.computed_at)}
                  next={run.can_compute && !run.computed_at}
                  meta={
                    run.computed_at
                      ? `${run.employee_count} payslips built.`
                      : 'Builds a payslip for everyone with a salary structure.'
                  }
                />
                <Stage
                  name="Approved"
                  done={Boolean(run.approved_at)}
                  next={run.can_approve}
                  meta={run.approved_at ? 'Figures are frozen.' : 'Freezes the figures for good.'}
                />
                <Stage
                  name="Paid"
                  done={Boolean(run.paid_at)}
                  next={run.can_pay}
                  meta={
                    run.paid_at
                      ? run.payment_reference ?? 'Recorded.'
                      : 'Settles loan instalments and expense claims.'
                  }
                />
              </ul>
            </section>
          </div>

          <RunBody runId={run.id} onChanged={runsQ.reload} onError={setError} />
        </>
      ) : (
        <OpenMonth
          year={picked.year}
          month={picked.month}
          label={longLabel}
          onDone={() => runsQ.reload()}
          onError={setError}
        />
      )}
    </div>
  )
}

function Stage({
  name,
  done,
  next,
  meta,
}: {
  name: string
  done?: boolean
  next?: boolean
  meta: string
}) {
  return (
    <li className={`pr-stage${done ? ' is-done' : ''}${next ? ' is-next' : ''}`}>
      <span className="pr-stage-mark" aria-hidden="true" />
      <span className="pr-stage-body">
        <span className="pr-stage-name">
          {name}
          {/* The word, not only the tint. */}
          <span className="pr-stage-state">{done ? 'done' : next ? 'next' : 'waiting'}</span>
        </span>
        <span className="pr-stage-meta">{meta}</span>
      </span>
    </li>
  )
}

/**
 * Opening the month that is on screen.
 *
 * The period is not a field any more. It was a month input beside a submit
 * button, which meant the month you had chosen at the top of the page and the
 * month you were about to open were two separate answers that could disagree.
 * Only the pay date is asked for, because only the pay date is unknown.
 */
function OpenMonth({
  year,
  month,
  label,
  onDone,
  onError,
}: {
  year: number
  month: number
  label: string
  onDone: () => void
  onError: (message: string) => void
}) {
  const [payDate, setPayDate] = useState('')
  const [busy, setBusy] = useState(false)

  async function create() {
    setBusy(true)
    try {
      await api.post<PayRun>('/payruns', {
        period_year: year,
        period_month: month,
        pay_date: payDate || null,
      })
      onDone()
    } catch (caught) {
      onError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card pr-open">
      <div className="pr-open-body">
        <h2 className="card-title">{label} is not open yet</h2>
        <p className="pr-open-note">
          Opening a month creates the run. Nothing is computed and nobody is paid until you
          say so.
        </p>
      </div>
      <div className="pr-row">
        <label className="pr-field">
          <span className="pr-field-label">Pay date</span>
          <input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
          <span className="pr-field-hint">
            When salaries are credited — often the 1st of the next month. Can be set later.
          </span>
        </label>
        <button className="btn btn-primary" disabled={busy} onClick={create}>
          {busy ? 'Opening…' : `Open ${label}`}
        </button>
      </div>
    </section>
  )
}


function RunBody({
  runId,
  onChanged,
  onError,
}: {
  runId: string
  onChanged: () => void
  onError: (message: string) => void
}) {
  const detailQ = useQuery<PayRunDetail>(`pay-run-${runId}`, () =>
    api.get<PayRunDetail>(`/payruns/${runId}`),
  )
  const [busy, setBusy] = useState(false)
  const [reference, setReference] = useState('')
  const [openSlip, setOpenSlip] = useState<string | null>(null)

  const act = useCallback(
    async (run: () => Promise<unknown>) => {
      setBusy(true)
      try {
        await run()
        detailQ.reload()
        onChanged()
      } catch (caught) {
        onError((caught as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [detailQ, onChanged, onError],
  )

  if (detailQ.loading) return <div className="pr-run-body"><Loading /></div>
  if (detailQ.error) return <div className="pr-run-body"><ErrorNote>{detailQ.error}</ErrorNote></div>
  if (!detailQ.data) return null
  const run = detailQ.data

  return (
    <div className="pr-run-body">
      {/* No gross/deductions/net tiles here any more. The payout panel at the
          top of the page carries those three figures, and repeating them 200px
          lower made the page look like it held two different totals. */}

      {/* The checklist belongs before the compute, and goes away after it: once
          payslips exist, the question stops being "is the month ready" and
          becomes "is the run right", which is what the two panels below answer. */}
      {run.payslips.length === 0 && <Readiness runId={run.id} />}

      <Exceptions run={run} />

      {/* Variance is the pre-approval check. Shown while a decision is still
          open — after payment it is history, and the register is the better
          place to read history. */}
      {run.payslips.length > 0 && run.status !== 'paid' && <Variance runId={run.id} />}

      {!run.payslips.length ? (
        <Empty>
          Nothing computed yet. Compute builds a payslip for everybody with a
          salary structure covering this month.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Employee</th><th className="num">Days</th>
                <th className="num">Gross</th><th className="num">Deductions</th>
                <th className="num">Net</th><th />
              </tr>
            </thead>
            <tbody>
              {run.payslips.map((slip) => (
                <tr key={slip.id}>
                  <td>
                    <div className="pr-title">{slip.user_name}</div>
                    {slip.employee_code && <div className="muted">{slip.employee_code}</div>}
                  </td>
                  <td className="num">
                    {slip.payable_days}/{slip.month_days}
                    {slip.lop_milli_days > 0 && (
                      <div className="pr-warn">
                        {(slip.lop_milli_days / 1000).toFixed(1)}d LOP
                      </div>
                    )}
                  </td>
                  <td className="num">
                    {money(slip.gross)}
                    {slip.gross !== slip.full_gross && (
                      <div className="muted">of {money(slip.full_gross)}</div>
                    )}
                  </td>
                  <td className="num">{money(slip.total_deductions)}</td>
                  <td className="num"><strong>{money(slip.net)}</strong></td>
                  <td className="row-actions">
                    <button className="btn small" onClick={() =>
                      setOpenSlip(openSlip === slip.id ? null : slip.id)}>
                      {openSlip === slip.id ? 'Hide' : 'Payslip'}
                    </button>
                    <button className="btn small"
                            onClick={() =>
                              openPrintable(`/payruns/payslips/${slip.id}/print`)
                                .catch((caught) => onError((caught as Error).message))}>
                      Print
                    </button>
                    {/* Read from the payslip, not from the run's status: filing
                        is a separate step after approval, so "approved" does
                        not mean the employee has a copy. */}
                    {slip.document_id && <span className="pr-filed">Filed</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openSlip && <PayslipDetail payslipId={openSlip} onError={onError} />}

      <div className="pr-actions">
        {run.can_compute && (
          <button className="btn primary" disabled={busy}
                  onClick={() => act(() =>
                    api.post(`/payruns/${run.id}/compute`, { overrides: [] }))}>
            {run.payslips.length ? 'Recompute' : 'Compute'}
          </button>
        )}
        {run.can_approve && (
          <button className="btn primary" disabled={busy}
                  onClick={() => act(() => api.post(`/payruns/${run.id}/approve`))}>
            Approve
          </button>
        )}
        {run.can_pay && (
          <>
            <input placeholder="Payment reference" value={reference}
                   onChange={(e) => setReference(e.target.value)} />
            <button className="btn primary" disabled={busy}
                    onClick={() => act(() => api.post(`/payruns/${run.id}/pay`, {
                      payment_reference: reference || null,
                    }))}>
              Mark as paid
            </button>
            <span className="muted">
              This also settles the loan instalments and expense claims on these
              payslips.
            </span>
          </>
        )}
        {run.can_cancel && (
          <button className="btn danger" disabled={busy}
                  onClick={() => act(() => api.post(`/payruns/${run.id}/cancel`))}>
            Cancel run
          </button>
        )}
        {run.status === 'approved' && (
          <span className="muted">
            Approved{run.approved_by_name ? ` by ${run.approved_by_name}` : ''} —
            the figures are fixed and cannot be recomputed.
          </span>
        )}
      </div>

      {(run.status === 'approved' || run.status === 'paid') && (
        <Outputs run={run} busy={busy} act={act} onError={onError} />
      )}
    </div>
  )
}

/**
 * The four things about a month that somebody has to act on.
 *
 * Every one is derived from the payslips already on screen — no extra request,
 * and no count read out of a field the server does not send (D-026). They are
 * cards rather than a paragraph because they are *lists*: "three people were
 * left out" is not actionable, and "these three people were left out" is.
 *
 * A card with nothing in it still renders, saying so. That is the point of the
 * grid: an empty "Zero or negative net" is a fact worth being told before you
 * approve a run, and a card that vanished when it was clean would leave you
 * wondering whether it had been checked at all.
 */
/* ------------------------------------------------- before and after ------ */

interface Check {
  key: string
  title: string
  severity: 'blocking' | 'warning' | 'info'
  detail: string
  count: number
  names: string[]
}

interface VarianceRow {
  user_id: string
  name: string
  previous_net: number
  current_net: number
  previous_gross: number
  current_gross: number
  delta: number
  percent: number
  reasons: string[]
}

interface VarianceReport {
  previous_period: string | null
  threshold_percent: number
  moved: VarianceRow[]
  unchanged: number
  total_delta: number
}

/**
 * The pre-payroll checklist.
 *
 * Everything that has to be true before a month is computed, and **nothing here
 * blocks anything**: each check has a legitimate "yes, I know" — a consultant
 * with no bank row, somebody who genuinely earned nothing. A hard gate on any
 * of them would be a gate people learn to work around, so this reports and the
 * payroll manager decides.
 *
 * Blocking checks are listed first and open by default; the rest stay shut,
 * because a checklist where everything shouts is one nobody reads.
 */
function Readiness({ runId }: { runId: string }) {
  const checksQ = useQuery<Check[]>(`pay-readiness-${runId}`, () =>
    api.get<Check[]>(`/payruns/${runId}/readiness`),
  )
  const [open, setOpen] = useState<string | null>(null)

  if (checksQ.loading) return <Loading label="Checking the month…" />
  if (checksQ.error) return <ErrorNote>{checksQ.error}</ErrorNote>

  const checks = checksQ.data ?? []
  const blocking = checks.filter((c) => c.severity === 'blocking' && c.count > 0)
  const warnings = checks.filter((c) => c.severity === 'warning' && c.count > 0)
  const info = checks.filter((c) => c.severity === 'info' && c.count > 0)
  const clear = checks.filter((c) => c.count === 0)

  return (
    <section className="card pr-checks">
      <div className="pr-checks-head">
        <div>
          <h2 className="card-title">Before you compute</h2>
          <p className="pr-checks-sub">
            {blocking.length === 0 && warnings.length === 0
              ? 'Nothing needs attention. Compute when you are ready.'
              : `${blocking.length} to fix, ${warnings.length} to look at. None of it stops you computing.`}
          </p>
        </div>
        <span className={`pr-checks-badge${blocking.length ? ' is-blocking' : warnings.length ? ' is-warning' : ' is-clear'}`}>
          {blocking.length ? `${blocking.length} blocking` : warnings.length ? `${warnings.length} to review` : 'Ready'}
        </span>
      </div>

      <ul className="pr-check-list">
        {[...blocking, ...warnings, ...info].map((check) => (
          <li key={check.key} className={`pr-check is-${check.severity}`}>
            <button
              className="pr-check-head"
              onClick={() => setOpen((current) => (current === check.key ? null : check.key))}
              aria-expanded={open === check.key}
            >
              <span className="pr-check-mark" aria-hidden="true" />
              <span className="pr-check-title">{check.title}</span>
              <span className="pr-check-count">{check.count}</span>
            </button>
            {open === check.key && (
              <div className="pr-check-body">
                <p className="pr-check-detail">{check.detail}</p>
                <ul className="pr-check-names">
                  {check.names.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                  {check.count > check.names.length && (
                    <li className="muted">
                      …and {check.count - check.names.length} more
                    </li>
                  )}
                </ul>
              </div>
            )}
          </li>
        ))}

        {clear.length > 0 && (
          <li className="pr-check is-clear">
            <span className="pr-check-head">
              <span className="pr-check-mark" aria-hidden="true" />
              <span className="pr-check-title">
                {clear.length} check{clear.length === 1 ? '' : 's'} clear
              </span>
              <span className="pr-check-count">✓</span>
            </span>
          </li>
        )}
      </ul>
    </section>
  )
}

/**
 * What moved since last month, and why.
 *
 * The check a payroll manager actually runs before approving. The exceptions
 * list answers "is anything wrong with this run"; this answers the different
 * and more useful question — "is anything *different* from last month, and do I
 * know why". A salary revision, a joiner, a month of unpaid leave and a
 * fat-fingered override all look identical in a register and obvious here.
 */
function Variance({ runId }: { runId: string }) {
  const [threshold, setThreshold] = useState(10)
  const reportQ = useQuery<VarianceReport>(`pay-variance-${runId}-${threshold}`, () =>
    api.get<VarianceReport>(`/payruns/${runId}/variance?threshold_percent=${threshold}`),
  )

  if (reportQ.loading) return <Loading label="Comparing with last month…" />
  if (reportQ.error) return <ErrorNote>{reportQ.error}</ErrorNote>
  const report = reportQ.data
  if (!report) return null

  return (
    <section className="card pr-variance">
      <div className="pr-checks-head">
        <div>
          <h2 className="card-title">What changed since last month</h2>
          <p className="pr-checks-sub">
            {report.previous_period
              ? `Compared with ${report.previous_period}. ${report.unchanged} unchanged.`
              : 'No earlier run to compare against — everybody here is new.'}
          </p>
        </div>
        <label className="pr-field pr-threshold">
          <span className="pr-field-label">Flag moves over</span>
          <select value={threshold} onChange={(e) => setThreshold(Number(e.target.value))}>
            {[0, 5, 10, 20, 50].map((value) => (
              <option key={value} value={value}>
                {value === 0 ? 'anything' : `${value}%`}
              </option>
            ))}
          </select>
        </label>
      </div>

      {report.moved.length === 0 ? (
        <Empty>
          Nobody moved by more than {report.threshold_percent}%. That is the answer you want
          on an ordinary month.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Employee</th>
                <th className="num">Last month</th>
                <th className="num">This month</th>
                <th className="num">Change</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {report.moved.map((row) => (
                <tr key={row.user_id}>
                  <td className="pr-title">{row.name}</td>
                  <td className="num">
                    {row.previous_net ? money(row.previous_net) : <span className="muted">—</span>}
                  </td>
                  <td className="num">{money(row.current_net)}</td>
                  <td className={`num ${row.delta < 0 ? 'pr-down' : 'pr-up'}`}>
                    {row.delta >= 0 ? '+' : '−'}
                    {money(Math.abs(row.delta))}
                    {row.previous_net > 0 && <div className="muted">{row.percent}%</div>}
                  </td>
                  <td>
                    <ul className="pr-reasons">
                      {row.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function Exceptions({ run }: { run: PayRunDetail }) {
  const lop = run.payslips.filter((slip) => slip.lop_milli_days > 0)
  /* Zero and negative are one card, not two: both mean "this person's
     deductions ate their pay", and the fix is the same conversation. */
  const nothing = run.payslips.filter((slip) => slip.net <= 0)
  const unfiled = run.payslips.filter((slip) => !slip.document_id)
  const filedStage = run.status === 'approved' || run.status === 'paid'

  return (
    <div className="pr-exceptions">
      <ExceptionCard
        title="No salary structure"
        count={run.skipped.length}
        empty="Everybody active has a salary structure covering this month."
        note="Left out of the run. Set their salary, then recompute."
        names={run.skipped.map((row) => String(row.full_name))}
      />
      <ExceptionCard
        title="Loss of pay"
        count={lop.length}
        empty="Nobody lost a day this month."
        note="Unpaid days have prorated these payslips."
        names={lop.map((slip) => `${slip.user_name} · ${(slip.lop_milli_days / 1000).toFixed(1)}d`)}
      />
      <ExceptionCard
        title="Zero or negative net"
        count={nothing.length}
        empty="Every payslip pays out something."
        note="Deductions have taken the whole of the pay. Check before approving."
        names={nothing.map((slip) => `${slip.user_name} · ${money(slip.net)}`)}
        alarming
      />
      <ExceptionCard
        title="Payslip not filed"
        count={filedStage ? unfiled.length : 0}
        empty={
          filedStage
            ? 'Every payslip is filed to its employee record.'
            : 'Filing happens after approval.'
        }
        note="Approved, but no copy in the employee's documents yet."
        names={filedStage ? unfiled.map((slip) => String(slip.user_name)) : []}
      />
    </div>
  )
}

function ExceptionCard({
  title,
  count,
  empty,
  note,
  names,
  alarming,
}: {
  title: string
  count: number
  empty: string
  note: string
  names: string[]
  alarming?: boolean
}) {
  /* Five, then a count. A card that lists forty names stops being a summary and
     the table below it is the place to read forty names. */
  const shown = names.slice(0, 5)
  return (
    <section className={`pr-exception${count > 0 && alarming ? ' is-alarming' : ''}`}>
      <div className="pr-exception-head">
        <h3 className="pr-exception-title">{title}</h3>
        <span className="pr-exception-count">{count}</span>
      </div>
      {count === 0 ? (
        <p className="pr-exception-empty">{empty}</p>
      ) : (
        <>
          <ul className="pr-exception-list">
            {shown.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
          {names.length > shown.length && (
            <p className="pr-exception-more">and {names.length - shown.length} more.</p>
          )}
          <p className="pr-exception-note">{note}</p>
        </>
      )}
    </section>
  )
}

function PayslipDetail({
  payslipId,
  onError,
}: {
  payslipId: string
  onError: (message: string) => void
}) {
  const slipQ = useQuery<Payslip>(`payslip-${payslipId}`, () =>
    api.get<Payslip>(`/payruns/payslips/${payslipId}`),
  )
  if (slipQ.loading) return <Loading />
  if (slipQ.error) {
    onError(slipQ.error)
    return null
  }
  if (!slipQ.data) return null
  return <PayslipCard slip={slipQ.data} />
}

/** The payslip itself. Shared with the employee's own view. */
export function PayslipCard({ slip }: { slip: Payslip }) {
  const earnings = slip.lines.filter((line) => line.kind === 'earning')
  const deductions = slip.lines.filter((line) => line.kind === 'deduction')
  /* Employer contributions are a third kind: nobody is paid them and nobody has
     them taken away, so they sit apart from both columns and touch neither
     gross nor net. They are shown because they are the other half of what this
     person costs. */
  const employer = slip.lines.filter((line) => line.kind === 'employer')

  return (
    <section className="card pr-payslip">
      <div className="pr-revision-head">
        <div>
          <div className="pr-title">{slip.user_name}</div>
          <div className="muted">
            {slip.period_label}
            {slip.payable_days !== slip.month_days
              ? ` · ${slip.payable_days} of ${slip.month_days} days paid`
              : ''}
            {slip.note ? ` · ${slip.note}` : ''}
          </div>
        </div>
      </div>

      <div className="pr-payslip-cols">
        <div>
          <h3 className="pr-subhead">Earnings</h3>
          <table className="table pr-components">
            <tbody>
              {earnings.map((line) => (
                <tr key={line.id}>
                  <td>
                    <div className="pr-code">{line.code}</div>
                    <div className="muted">{line.name}{line.detail ? ` · ${line.detail}` : ''}</div>
                  </td>
                  <td className="num">{money(line.amount)}</td>
                </tr>
              ))}
              <tr className="pr-total-row">
                <td>Gross</td><td className="num">{money(slip.gross)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div>
          <h3 className="pr-subhead">Deductions</h3>
          {deductions.length ? (
            <table className="table pr-components">
              <tbody>
                {deductions.map((line) => (
                  <tr key={line.id}>
                    <td>
                      <div className="pr-code">{line.code}</div>
                      <div className="muted">
                        {line.name}{line.detail ? ` · ${line.detail}` : ''}
                      </div>
                    </td>
                    <td className="num">{money(line.amount)}</td>
                  </tr>
                ))}
                <tr className="pr-total-row">
                  <td>Total</td><td className="num">{money(slip.total_deductions)}</td>
                </tr>
              </tbody>
            </table>
          ) : (
            <p className="muted">Nothing deducted this month.</p>
          )}
        </div>
        {employer.length > 0 && (
          <div>
            <h3 className="pr-subhead">Paid by the company</h3>
            <table className="table pr-components">
              <tbody>
                {employer.map((line) => (
                  <tr key={line.id}>
                    <td>
                      <div className="pr-code">{line.code}</div>
                      <div className="muted">
                        {line.name}{line.detail ? ` · ${line.detail}` : ''}
                      </div>
                    </td>
                    <td className="num">{money(line.amount)}</td>
                  </tr>
                ))}
                <tr className="pr-total-row">
                  <td>Total</td>
                  <td className="num">{money(slip.employer_contributions)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="pr-net">
        Net pay <strong>{money(slip.net)}</strong>
        {slip.employer_contributions > 0 && (
          <div className="pr-ctc">
            Cost to company {money(slip.gross + slip.employer_contributions)}
          </div>
        )}
      </div>
      <p className="muted">
        Income tax (TDS) is not computed yet. This payslip is gross less the
        deductions shown.
      </p>
    </section>
  )
}

/** Everything a signed-off run produces.
 *
 *  Only shown once the run is frozen, because that is when the server will
 *  produce any of it — a register or a filing from a draft would be figures
 *  nobody signed off, and offering buttons that always fail is worse than not
 *  offering them.
 *
 *  The bank file is a POST, not a link: it decrypts every account on the run and
 *  writes an audit row, and a GET would be prefetched and logged. */
function Outputs({
  run,
  busy,
  act,
  onError,
}: {
  run: PayRunDetail
  busy: boolean
  act: (fn: () => Promise<unknown>) => Promise<void>
  onError: (message: string) => void
}) {
  const [showRegister, setShowRegister] = useState(false)
  const stamp = run.period_label

  function fail(caught: unknown) {
    onError((caught as Error).message)
  }

  return (
    <>
      <div className="pr-outputs">
        <button className="btn small" onClick={() => setShowRegister((v) => !v)}>
          {showRegister ? 'Hide register' : 'Register'}
        </button>
        <button className="btn small"
                onClick={() =>
                  download(`/payruns/${run.id}/register.csv`,
                           `payroll-register-${stamp}.csv`).catch(fail)}>
          Register CSV
        </button>
        <button className="btn small"
                onClick={() =>
                  downloadPost(`/payruns/${run.id}/bank-file`,
                               `bank-transfer-${stamp}.csv`).catch(fail)}>
          Bank file
        </button>
        <button className="btn small"
                onClick={() =>
                  download(`/payruns/${run.id}/pf-ecr`, `pf-ecr-${stamp}.txt`)
                    .catch(fail)}>
          PF ECR
        </button>
        <button className="btn small"
                onClick={() =>
                  download(`/payruns/${run.id}/esi-return`, `esi-${stamp}.csv`)
                    .catch(fail)}>
          ESI return
        </button>
        <button className="btn small" disabled={busy}
                onClick={() => act(() =>
                  api.post(`/payruns/${run.id}/file-payslips`))}>
          File payslips
        </button>
        <span className="muted">
          Filing puts a copy of each payslip in that employee’s documents. Running
          it twice is harmless.
        </span>
      </div>

      {showRegister && <RegisterTable runId={run.id} onError={onError} />}
    </>
  )
}

function RegisterTable({
  runId,
  onError,
}: {
  runId: string
  onError: (message: string) => void
}) {
  const registerQ = useQuery<PayrollRegister>(`register-${runId}`, () =>
    api.get<PayrollRegister>(`/payruns/${runId}/register`),
  )

  if (registerQ.loading) return <Loading />
  if (registerQ.error) {
    onError(registerQ.error)
    return null
  }
  if (!registerQ.data) return null
  const reg = registerQ.data

  const cell = (value: number) => (value ? money(value) : <span className="muted">—</span>)

  return (
    <>
      {reg.discrepancies.length > 0 && (
        <ErrorNote>
          The register does not agree with the run’s stored totals:{' '}
          {reg.discrepancies.join('; ')}. The register is summed from the
          payslips, so trust it over the summary above and investigate.
        </ErrorNote>
      )}
      <div className="table-wrap pr-register">
        <table className="table">
          <thead>
            <tr>
              <th>Employee</th><th className="num">Days</th>
              {reg.earning_codes.map((code) => <th key={code} className="num">{code}</th>)}
              <th className="num">Gross</th>
              {reg.deduction_codes.map((code) => <th key={code} className="num">{code}</th>)}
              <th className="num">Deductions</th><th className="num">Net</th>
              {reg.employer_codes.map((code) => (
                <th key={code} className="num is-employer">{code}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {reg.rows.map((row) => (
              <tr key={row.user_id}>
                <td>
                  <div className="pr-title">{row.name}</div>
                  {row.employee_code && <div className="muted">{row.employee_code}</div>}
                </td>
                <td className="num">{row.payable_days}/{row.month_days}</td>
                {reg.earning_codes.map((code) => (
                  <td key={code} className="num">{cell(row.earnings[code] ?? 0)}</td>
                ))}
                <td className="num">{money(row.gross)}</td>
                {reg.deduction_codes.map((code) => (
                  <td key={code} className="num">{cell(row.deductions[code] ?? 0)}</td>
                ))}
                <td className="num">{money(row.total_deductions)}</td>
                <td className="num"><strong>{money(row.net)}</strong></td>
                {reg.employer_codes.map((code) => (
                  <td key={code} className="num is-employer">
                    {cell(row.employer[code] ?? 0)}
                  </td>
                ))}
              </tr>
            ))}
            <tr className="pr-total-row">
              <td>Total</td><td />
              {reg.earning_codes.map((code) => (
                <td key={code} className="num">{money(reg.totals.earnings[code] ?? 0)}</td>
              ))}
              <td className="num">{money(reg.totals.gross)}</td>
              {reg.deduction_codes.map((code) => (
                <td key={code} className="num">{money(reg.totals.deductions[code] ?? 0)}</td>
              ))}
              <td className="num">{money(reg.totals.total_deductions)}</td>
              <td className="num">{money(reg.totals.net)}</td>
              {reg.employer_codes.map((code) => (
                <td key={code} className="num is-employer">
                  {money(reg.totals.employer[code] ?? 0)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </>
  )
}


/* --- employee self-service ------------------------------------------------ */

/** "My payslips" — approved and paid runs only. A draft is a working figure. */
export function MyPayslips() {
  const slipsQ = useQuery<Payslip[]>('my-payslips', () =>
    api.get<Payslip[]>('/payruns/payslips/mine'),
  )
  const [open, setOpen] = useState<string | null>(null)

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>My payslips</h1>
          <p className="muted">Every month that has been signed off.</p>
        </div>
      </header>

      {slipsQ.loading ? (
        <Loading />
      ) : slipsQ.error ? (
        <ErrorNote>{slipsQ.error}</ErrorNote>
      ) : !slipsQ.data?.length ? (
        <Empty>No payslips yet.</Empty>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Period</th><th className="num">Gross</th>
                  <th className="num">Deductions</th><th className="num">Net</th><th />
                </tr>
              </thead>
              <tbody>
                {slipsQ.data.map((slip) => (
                  <tr key={slip.id}>
                    <td>{slip.period_label}</td>
                    <td className="num">{money(slip.gross)}</td>
                    <td className="num">{money(slip.total_deductions)}</td>
                    <td className="num"><strong>{money(slip.net)}</strong></td>
                    <td className="row-actions">
                      <button className="btn small" onClick={() =>
                        setOpen(open === slip.id ? null : slip.id)}>
                        {open === slip.id ? 'Hide' : 'View'}
                      </button>
                      <button className="btn small"
                              onClick={() =>
                                openPrintable(`/payruns/payslips/${slip.id}/print`)
                                  .catch(() => undefined)}>
                        Print
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {open && (
            <PayslipCard slip={slipsQ.data.find((slip) => slip.id === open)!} />
          )}
        </>
      )}
    </div>
  )
}
