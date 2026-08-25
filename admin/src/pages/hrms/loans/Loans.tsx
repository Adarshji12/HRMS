/* Loans and advances — mine, the administration queue, and the shared detail.

   Four server truths this file is built around:

   1. **`outstanding_amount` is computed, not stored.** Every mutation returns
      the whole loan, so nothing here adds up instalments to find the balance. If
      it did, the figure on screen could disagree with the ledger.

   2. **Sanctioning and disbursing are two acts.** The buttons are gated on
      `can_review` and `can_disburse`, which the server resolves — a loan sits
      visibly at "approved, not yet paid out" in between, because that is the
      state an employee rings up about.

   3. **The schedule only exists after disbursement.** Before that a loan shows
      its *projected* repayable figure and no instalment rows, which is why the
      empty state says so rather than rendering an empty table.

   4. **A waiver is not a repayment.** They are different actions with different
      wording here, and the ledger shows waived rows distinctly, because
      reporting a written-down amount as recovered would overstate collections. */

import { useCallback, useState } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { money, toPaise } from '../../../lib/format'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import type {
  Loan,
  LoanDetail,
  LoanSummary,
  LoanType,
} from '../../../lib/types'
import '../../../styles/loans.css'

const TYPES: LoanType[] = [
  'salary_advance', 'personal_loan', 'emergency_loan', 'travel_advance', 'other',
]

export function label(value: string): string {
  return value.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'closed' ? 'ok'
      : status === 'active' ? 'go'
        : status === 'approved' ? 'warn'
          : status === 'requested' ? 'muted'
            : 'bad'
  return <span className={`ln-pill ln-pill-${tone}`}>{label(status)}</span>
}

/** Basis points as a percentage: 1200 → "12%". */
function rate(bps: number): string {
  if (!bps) return 'interest-free'
  return `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}% p.a.`
}

/* --- my loans -------------------------------------------------------------- */

export default function MyLoans() {
  const loansQ = useQuery<Loan[]>('my-loans', () => api.get<Loan[]>('/loans?mine=true'))
  const summaryQ = useQuery<LoanSummary>('my-loans-summary', () =>
    api.get<LoanSummary>('/loans/summary'),
  )
  const [open, setOpen] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(() => {
    loansQ.reload()
    summaryQ.reload()
  }, [loansQ, summaryQ])

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>My loans &amp; advances</h1>
          <p className="muted">
            What you have borrowed, what is left to repay, and the month each
            instalment comes out.
          </p>
        </div>
        <button className="btn primary" onClick={() => setAsking((v) => !v)}>
          {asking ? 'Close' : 'Request an advance'}
        </button>
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}

      {summaryQ.data && (
        <div className="ln-tiles">
          <Tile label="You still owe" value={money(summaryQ.data.outstanding_amount)}
                meta={`${summaryQ.data.active_count} active`} />
          <Tile label="Repaid" value={money(summaryQ.data.repaid_amount)}
                meta="across all loans" />
          <Tile label="Awaiting a decision"
                value={String(summaryQ.data.awaiting_decision)}
                meta="with the administrator" />
        </div>
      )}

      {asking && (
        <RequestForm
          onDone={() => { setAsking(false); reload() }}
          onError={setError}
        />
      )}

      {loansQ.loading ? (
        <Loading />
      ) : loansQ.error ? (
        <ErrorNote>{loansQ.error}</ErrorNote>
      ) : !loansQ.data?.length ? (
        <Empty>You have no loans or advances.</Empty>
      ) : (
        <LoanList loans={loansQ.data} open={open}
                  onToggle={(id) => setOpen(open === id ? null : id)}
                  onChanged={reload} />
      )}
    </div>
  )
}

/* --- administration -------------------------------------------------------- */

export function LoanAdmin() {
  const loansQ = useQuery<Loan[]>('all-loans', () => api.get<Loan[]>('/loans'))
  const summaryQ = useQuery<LoanSummary>('all-loans-summary', () =>
    api.get<LoanSummary>('/loans/summary'),
  )
  const [open, setOpen] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  const reload = useCallback(() => {
    loansQ.reload()
    summaryQ.reload()
  }, [loansQ, summaryQ])

  const rows = (loansQ.data ?? []).filter(
    (loan) => !filter || loan.status === filter,
  )

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Loans &amp; advances</h1>
          <p className="muted">
            Sanction a request, disburse it, and record repayments against the
            schedule.
          </p>
        </div>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}
                aria-label="Filter by status">
          <option value="">All statuses</option>
          {['requested', 'approved', 'active', 'closed', 'rejected',
            'cancelled', 'written_off'].map((s) => (
            <option key={s} value={s}>{label(s)}</option>
          ))}
        </select>
      </header>

      {summaryQ.data && (
        <div className="ln-tiles">
          <Tile label="Outstanding" value={money(summaryQ.data.outstanding_amount)}
                meta={`${summaryQ.data.active_count} active loans`} />
          <Tile label="Recovered" value={money(summaryQ.data.repaid_amount)}
                meta="excludes waivers" />
          <Tile label="Awaiting sanction"
                value={String(summaryQ.data.awaiting_decision)} meta="requests" />
        </div>
      )}

      {loansQ.loading ? (
        <Loading />
      ) : loansQ.error ? (
        <ErrorNote>{loansQ.error}</ErrorNote>
      ) : !rows.length ? (
        <Empty>{filter ? 'Nothing with that status.' : 'No loans yet.'}</Empty>
      ) : (
        <LoanList loans={rows} open={open}
                  onToggle={(id) => setOpen(open === id ? null : id)}
                  onChanged={reload} showOwner />
      )}
    </div>
  )
}

/** What payroll would deduct next month — the query a pay run will make. */
export function LoanDeductions() {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7))
  const rowsQ = useQuery<import('../../../lib/types').DeductionRow[]>(
    `deductions-${month}`,
    () => api.get(`/loans/deductions?month=${month}-01`),
  )
  const total = (rowsQ.data ?? []).reduce((sum, row) => sum + row.amount, 0)

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Loan deductions</h1>
          <p className="muted">
            Instalments falling due in one month, across every active loan. This
            is what a pay run will deduct.
          </p>
        </div>
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)}
               aria-label="Month" />
      </header>

      {rowsQ.loading ? (
        <Loading />
      ) : rowsQ.error ? (
        <ErrorNote>{rowsQ.error}</ErrorNote>
      ) : !rowsQ.data?.length ? (
        <Empty>Nothing falls due that month.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Employee</th><th>Loan</th><th>Instalment</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rowsQ.data.map((row) => (
                <tr key={row.instalment_id}>
                  <td>{row.user_name}</td>
                  <td>{label(row.loan_type)}</td>
                  <td>{row.sequence} of {row.instalment_count}</td>
                  <td className="num">{money(row.amount)}</td>
                </tr>
              ))}
              <tr className="ln-total-row">
                <td colSpan={3}>Total</td>
                <td className="num">{money(total)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/* --- shared ---------------------------------------------------------------- */

function Tile({ label: name, value, meta }: { label: string; value: string; meta: string }) {
  return (
    <div className="ln-tile">
      <div className="ln-tile-label">{name}</div>
      <div className="ln-tile-value">{value}</div>
      <div className="ln-tile-meta">{meta}</div>
    </div>
  )
}

function LoanList({
  loans,
  open,
  onToggle,
  onChanged,
  showOwner = false,
}: {
  loans: Loan[]
  open: string | null
  onToggle: (id: string) => void
  onChanged: () => void
  showOwner?: boolean
}) {
  return (
    <div className="ln-list">
      {loans.map((loan) => (
        <div key={loan.id} className={`ln-card${open === loan.id ? ' is-open' : ''}`}>
          <button className="ln-card-head" onClick={() => onToggle(loan.id)}>
            <div className="ln-card-title">
              <div className="ln-title">
                {label(loan.loan_type)}
                {showOwner && loan.user_name ? ` · ${loan.user_name}` : ''}
              </div>
              <div className="muted">
                {money(loan.approved_principal ?? loan.principal)} over{' '}
                {loan.instalment_count} months · {rate(loan.interest_rate_bps)}
                {loan.next_due_on ? ` · next ${loan.next_due_on.slice(0, 7)}` : ''}
              </div>
            </div>
            <div className="ln-card-amount">
              {loan.status === 'active' || loan.status === 'closed' ? (
                <>
                  <div>{money(loan.outstanding_amount)}</div>
                  <div className="ln-sub">
                    {loan.instalments_paid}/{loan.instalments_total} paid
                  </div>
                </>
              ) : (
                <div>{money(loan.total_repayable)}</div>
              )}
            </div>
            <StatusPill status={loan.status} />
          </button>
          {open === loan.id && <LoanBody loanId={loan.id} onChanged={onChanged} />}
        </div>
      ))}
    </div>
  )
}

function LoanBody({ loanId, onChanged }: { loanId: string; onChanged: () => void }) {
  const detailQ = useQuery<LoanDetail>(`loan-${loanId}`, () =>
    api.get<LoanDetail>(`/loans/${loanId}`),
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [reference, setReference] = useState('')

  const act = useCallback(
    async (run: () => Promise<unknown>) => {
      setBusy(true)
      setError(null)
      try {
        await run()
        setNote('')
        setReference('')
        detailQ.reload()
        onChanged()
      } catch (caught) {
        setError((caught as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [detailQ, onChanged],
  )

  if (detailQ.loading) return <div className="ln-card-body"><Loading /></div>
  if (detailQ.error) return <div className="ln-card-body"><ErrorNote>{detailQ.error}</ErrorNote></div>
  if (!detailQ.data) return null
  const loan = detailQ.data

  return (
    <div className="ln-card-body">
      {error && <ErrorNote>{error}</ErrorNote>}

      {loan.purpose && <p className="muted">{loan.purpose}</p>}
      {loan.review_note && (
        <p className={loan.status === 'rejected' ? 'ln-warn' : 'muted'}>
          {loan.reviewer_name ? `${loan.reviewer_name}: ` : ''}{loan.review_note}
        </p>
      )}
      {loan.status === 'approved' && (
        <p className="ln-warn">
          Sanctioned{loan.approved_principal !== loan.principal
            ? ` at ${money(loan.approved_principal ?? 0)} of ${money(loan.principal)} requested`
            : ''} — not yet paid out.
        </p>
      )}
      {loan.status === 'written_off' && (
        <p className="ln-warn">Written off — {loan.closure_note}</p>
      )}

      {loan.instalments.length ? (
        <div className="table-wrap">
          <table className="table ln-schedule">
            <thead>
              <tr>
                <th>#</th><th>Due</th><th className="num">Amount</th>
                <th>Status</th><th>Reference</th><th />
              </tr>
            </thead>
            <tbody>
              {loan.instalments.map((row) => (
                <tr key={row.id} className={row.is_overdue ? 'is-overdue' : ''}>
                  <td>{row.sequence}</td>
                  <td>{row.due_on.slice(0, 7)}</td>
                  <td className="num">
                    {money(row.amount)}
                    {row.paid_amount !== null && row.paid_amount !== row.amount && (
                      <div className="ln-warn">paid {money(row.paid_amount)}</div>
                    )}
                  </td>
                  <td>
                    {row.status === 'paid' ? <span className="ln-ok">Paid</span>
                      : row.status === 'waived' ? <span className="ln-warn">Waived</span>
                        : row.is_overdue ? <span className="ln-bad">Overdue</span>
                          : <span className="muted">Pending</span>}
                  </td>
                  <td className="muted">{row.reference ?? row.note ?? '—'}</td>
                  <td className="row-actions">
                    {loan.can_record_repayment && row.status === 'pending' && (
                      <Repay instalmentId={row.id} busy={busy} act={act} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>
          The repayment schedule is created when the loan is paid out — it is
          anchored to the disbursement date, so it does not exist yet.
        </Empty>
      )}

      <div className="ln-actions">
        <div className="ln-total">
          {loan.status === 'active' || loan.status === 'closed' ? (
            <>Outstanding <strong>{money(loan.outstanding_amount)}</strong> of{' '}
              {money(loan.total_repayable)}</>
          ) : (
            <>Repayable <strong>{money(loan.total_repayable)}</strong></>
          )}
        </div>

        {loan.can_review && (
          <Sanction loan={loan} busy={busy} note={note} setNote={setNote} act={act} />
        )}
        {loan.can_disburse && (
          <>
            <input placeholder="Payment reference" value={reference}
                   onChange={(e) => setReference(e.target.value)} />
            <button className="btn primary" disabled={busy}
                    onClick={() => act(() =>
                      api.post(`/loans/${loan.id}/disburse`, { reference }))}>
              Disburse &amp; start schedule
            </button>
          </>
        )}
        {loan.status === 'active' && loan.can_record_repayment && (
          <button className="btn" disabled={busy}
                  onClick={() => act(() =>
                    api.post(`/loans/${loan.id}/settle`, { reference: reference || null }))}>
            Settle in full
          </button>
        )}
        {loan.can_cancel && (
          <button className="btn" disabled={busy}
                  onClick={() => act(() => api.post(`/loans/${loan.id}/cancel`))}>
            Cancel request
          </button>
        )}
        {loan.can_write_off && (
          <>
            <input placeholder="Reason for write-off" value={note}
                   onChange={(e) => setNote(e.target.value)} />
            <button className="btn danger" disabled={busy || !note.trim()}
                    onClick={() => act(() =>
                      api.post(`/loans/${loan.id}/write-off`, { note }))}>
              Write off
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function Sanction({
  loan,
  busy,
  note,
  setNote,
  act,
}: {
  loan: LoanDetail
  busy: boolean
  note: string
  setNote: (value: string) => void
  act: (run: () => Promise<unknown>) => Promise<void>
}) {
  const [amount, setAmount] = useState('')
  const [count, setCount] = useState('')
  const paise = amount.trim() ? toPaise(amount) : null

  return (
    <>
      <input placeholder={`Sanction ${money(loan.principal)} — or less`}
             value={amount} inputMode="decimal"
             onChange={(e) => setAmount(e.target.value)} />
      <input placeholder={`${loan.instalment_count} months`} value={count}
             inputMode="numeric" onChange={(e) => setCount(e.target.value)} />
      <input placeholder="Note — required to refuse" value={note}
             onChange={(e) => setNote(e.target.value)} />
      <button className="btn primary" disabled={busy}
              onClick={() => act(() => api.post(`/loans/${loan.id}/review`, {
                status: 'approved',
                approved_principal: paise && paise > 0 ? paise : null,
                instalment_count: count.trim() ? Number(count) : null,
                review_note: note.trim() || null,
              }))}>
        Sanction
      </button>
      <button className="btn danger" disabled={busy || !note.trim()}
              onClick={() => act(() => api.post(`/loans/${loan.id}/review`, {
                status: 'rejected', review_note: note,
              }))}>
        Refuse
      </button>
    </>
  )
}

function Repay({
  instalmentId,
  busy,
  act,
}: {
  instalmentId: string
  busy: boolean
  act: (run: () => Promise<unknown>) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')

  if (!open) {
    return (
      <button className="btn small" disabled={busy} onClick={() => setOpen(true)}>
        Record
      </button>
    )
  }
  return (
    <div className="ln-repay">
      <input placeholder="Reference" value={reference}
             onChange={(e) => setReference(e.target.value)} />
      <button className="btn small primary" disabled={busy}
              onClick={() => act(() =>
                api.post(`/loans/instalments/${instalmentId}/repay`, {
                  reference: reference || null,
                }))}>
        Paid
      </button>
      <input placeholder="Reason to waive" value={note}
             onChange={(e) => setNote(e.target.value)} />
      <button className="btn small" disabled={busy || !note.trim()}
              onClick={() => act(() =>
                api.post(`/loans/instalments/${instalmentId}/repay`, {
                  waive: true, note,
                }))}>
        Waive
      </button>
    </div>
  )
}

function RequestForm({
  onDone,
  onError,
}: {
  onDone: () => void
  onError: (message: string) => void
}) {
  const [loanType, setLoanType] = useState<LoanType>('salary_advance')
  const [amount, setAmount] = useState('')
  const [count, setCount] = useState('6')
  const [purpose, setPurpose] = useState('')
  const [busy, setBusy] = useState(false)

  const paise = toPaise(amount)
  const months = Number(count)
  const ready = Boolean(paise && paise > 0 && months > 0 && months <= 120)

  async function submit() {
    setBusy(true)
    try {
      await api.post('/loans', {
        loan_type: loanType,
        principal: paise,
        instalment_count: months,
        purpose: purpose.trim() || null,
      })
      onDone()
    } catch (caught) {
      onError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card ln-request">
      <h2 className="card-title">Request an advance</h2>
      <div className="ln-row">
        <select value={loanType} onChange={(e) => setLoanType(e.target.value as LoanType)}
                aria-label="Type">
          {TYPES.map((type) => <option key={type} value={type}>{label(type)}</option>)}
        </select>
        <input placeholder="Amount" value={amount} inputMode="decimal"
               className={amount && paise === null ? 'is-bad' : ''}
               onChange={(e) => setAmount(e.target.value)} aria-label="Amount in rupees" />
        <input placeholder="Months" value={count} inputMode="numeric"
               onChange={(e) => setCount(e.target.value)} aria-label="Instalments" />
        <input placeholder="What is it for?" value={purpose}
               onChange={(e) => setPurpose(e.target.value)} />
        <button className="btn primary" disabled={!ready || busy} onClick={submit}>
          {busy ? 'Sending…' : 'Request'}
        </button>
      </div>
      {ready && (
        <p className="muted">
          Roughly {money(Math.round((paise as number) / months))} a month for{' '}
          {months} months, deducted from payroll. An administrator sanctions the
          amount and the term.
        </p>
      )}
    </section>
  )
}
