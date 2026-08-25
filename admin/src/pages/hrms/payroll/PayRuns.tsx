/* Pay runs — open a month, compute it, approve it, pay it.

   Four server truths this file is built around:

   1. **Compute is a replace.** Pressing it again rebuilds every payslip from
      current data. The button says "Recompute" once a run has been computed, so
      it is clear that is what it does rather than implying it adds.

   2. **Approval freezes.** After it there is no compute control at all — the
      server refuses, and the UI does not offer an action that always fails.

   3. **Paying moves money elsewhere.** Loan instalments settle and expense
      claims reimburse on that transition. The confirmation says so, because an
      administrator pressing "Mark as paid" is doing more than changing a
      status.

   4. **Skipped employees are shown.** People with no salary structure are left
      out of the run — right, since a ₹0 payslip reads as a decision — and the
      run detail lists them so the omission is visible rather than silent. */

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

export default function PayRuns() {
  const runsQ = useQuery<PayRun[]>('pay-runs', () => api.get<PayRun[]>('/payruns'))
  const [open, setOpen] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Pay runs</h1>
          <p className="muted">
            One run a month. Compute it, review the payslips, approve, then
            record the payment — approving and paying are separate because they
            are separate events.
          </p>
        </div>
        <button className="btn primary" onClick={() => setCreating((v) => !v)}>
          {creating ? 'Close' : 'Open a month'}
        </button>
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}

      {creating && (
        <NewRun
          onDone={(id) => { setCreating(false); setOpen(id); runsQ.reload() }}
          onError={setError}
        />
      )}

      {runsQ.loading ? (
        <Loading />
      ) : runsQ.error ? (
        <ErrorNote>{runsQ.error}</ErrorNote>
      ) : !runsQ.data?.length ? (
        <Empty>No pay runs yet. Open a month to start.</Empty>
      ) : (
        <div className="pr-runs">
          {runsQ.data.map((run) => (
            <div key={run.id}
                 className={`card pr-run${open === run.id ? ' is-open' : ''}`}>
              <button className="pr-run-head" onClick={() =>
                setOpen(open === run.id ? null : run.id)}>
                <div className="pr-run-title">
                  <div className="pr-title">{periodName(run)}</div>
                  <div className="muted">
                    {run.employee_count} {run.employee_count === 1 ? 'payslip' : 'payslips'}
                    {run.pay_date ? ` · paid ${run.pay_date}` : ''}
                    {run.payment_reference ? ` · ${run.payment_reference}` : ''}
                  </div>
                </div>
                <div className="pr-run-amount">
                  <div>{money(run.total_net)}</div>
                  <div className="pr-sub">net</div>
                </div>
                <StatusPill status={run.status} />
              </button>
              {open === run.id && (
                <RunBody runId={run.id} onChanged={runsQ.reload} onError={setError} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function NewRun({
  onDone,
  onError,
}: {
  onDone: (id: string) => void
  onError: (message: string) => void
}) {
  const now = new Date()
  const [period, setPeriod] = useState(
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
  )
  const [payDate, setPayDate] = useState('')
  const [busy, setBusy] = useState(false)

  async function create() {
    const [year, month] = period.split('-').map(Number)
    setBusy(true)
    try {
      const run = await api.post<PayRun>('/payruns', {
        period_year: year,
        period_month: month,
        pay_date: payDate || null,
      })
      onDone(run.id)
    } catch (caught) {
      onError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card pr-form">
      <h2 className="card-title">Open a month</h2>
      <div className="pr-row">
        <label className="pr-field">
          <span className="pr-field-label">Period</span>
          <input type="month" value={period}
                 onChange={(e) => setPeriod(e.target.value)} />
        </label>
        <label className="pr-field">
          <span className="pr-field-label">Pay date</span>
          <input type="date" value={payDate}
                 onChange={(e) => setPayDate(e.target.value)} />
          <span className="pr-field-hint">
            When salaries are credited — often the 1st of the next month.
          </span>
        </label>
        <button className="btn primary" disabled={busy || !period} onClick={create}>
          Open
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
      <div className="pr-tiles">
        <Tile label="Gross" value={money(run.total_gross)}
              meta={`${run.employee_count} employees`} />
        <Tile label="Deductions" value={money(run.total_deductions)}
              meta="statutory and loans; TDS still to come" />
        <Tile label="Net payable" value={money(run.total_net)}
              meta={run.pay_date ? `on ${run.pay_date}` : 'pay date not set'} />
      </div>

      {run.skipped.length > 0 && (
        <p className="pr-warn">
          Left out for want of a salary structure:{' '}
          {run.skipped.map((row) => row.full_name).join(', ')}. Set their salary
          and recompute.
        </p>
      )}

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


function Tile({ label, value, meta }: { label: string; value: string; meta: string }) {
  return (
    <div className="pr-tile">
      <div className="pr-tile-label">{label}</div>
      <div className="pr-tile-value">{value}</div>
      <div className="pr-tile-meta">{meta}</div>
    </div>
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
