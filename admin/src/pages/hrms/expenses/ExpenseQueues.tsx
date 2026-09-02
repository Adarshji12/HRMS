/* The two queues on the other side of a claim: approval, and payment.

   Two pages in one file because they are the same list with a different action
   and a different permission — and keeping them together makes it obvious that
   they are *two* steps rather than one. A manager saying the spend was
   legitimate and finance saying the money has left are different acts, usually
   days apart by different people; `approved` and `reimbursed` are separate
   statuses for that reason, and "approved but unpaid" is the state every
   employee chases.

   Both reuse `ClaimList` from MyExpenses, so a reviewer sees exactly the lines
   and receipts the claimant submitted — a reviewer looking at a summarised
   version of what they are approving is how wrong approvals happen. */

import { useCallback, useState } from 'react'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { money } from '../../../lib/format'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import type { ExpenseClaim, ExpenseSummary } from '../../../lib/types'
import { ClaimList } from './MyExpenses'
import '../../../styles/expenses.css'

export function ExpenseReview() {
  const queueQ = useQuery<ExpenseClaim[]>('expense-review', () =>
    api.get<ExpenseClaim[]>('/expenses/review'),
  )
  const summaryQ = useQuery<ExpenseSummary>('expense-review-summary', () =>
    api.get<ExpenseSummary>('/expenses/summary'),
  )
  const [open, setOpen] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const reload = useCallback(() => {
    queueQ.reload()
    summaryQ.reload()
  }, [queueQ, summaryQ])

  const decide = useCallback(
    async (claimId: string, status: 'approved' | 'rejected') => {
      setBusy(true)
      setError(null)
      try {
        await api.post(`/expenses/${claimId}/review`, {
          status,
          review_note: note.trim() || null,
        })
        setNote('')
        setOpen(null)
        reload()
      } catch (caught) {
        setError((caught as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [note, reload],
  )

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Expense approvals</h1>
          <p className="muted">
            Claims from your team awaiting a decision.
          </p>
        </div>
        {summaryQ.data && (
          <div className="ex-headline">
            {summaryQ.data.awaiting_review} awaiting ·{' '}
            {money(summaryQ.data.by_status.submitted?.amount ?? 0)}
          </div>
        )}
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}

      {queueQ.loading ? (
        <Loading />
      ) : queueQ.error ? (
        <ErrorNote>{queueQ.error}</ErrorNote>
      ) : !queueQ.data?.length ? (
        <Empty>Nothing waiting on you.</Empty>
      ) : (
        <>
          <ClaimList
            claims={queueQ.data}
            open={open}
            onToggle={(id) => setOpen(open === id ? null : id)}
            onChanged={reload}
            showOwner
          />
          {open && (
            <section className="card ex-decide">
              <h2 className="card-title">Decision</h2>
              <div className="ex-row">
                <input
                  placeholder="Note — required to reject, optional to approve"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
                <button className="btn primary" disabled={busy}
                        onClick={() => decide(open, 'approved')}>
                  Approve
                </button>
                <button className="btn danger" disabled={busy || !note.trim()}
                        onClick={() => decide(open, 'rejected')}>
                  Reject
                </button>
              </div>
              <p className="muted">
                Rejecting needs a reason — without one the same claim comes back
                tomorrow.
              </p>
            </section>
          )}
        </>
      )}
    </div>
  )
}

export function ExpensePayments() {
  const queueQ = useQuery<ExpenseClaim[]>('expense-payments', () =>
    api.get<ExpenseClaim[]>('/expenses/payments'),
  )
  const [open, setOpen] = useState<string | null>(null)
  const [reference, setReference] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const owed = (queueQ.data ?? []).reduce(
    (total, claim) => total + (claim.approved_amount ?? claim.total_amount),
    0,
  )

  async function pay(claimId: string) {
    setBusy(true)
    setError(null)
    try {
      await api.post(`/expenses/${claimId}/reimburse`, {
        payment_reference: reference.trim() || null,
      })
      setReference('')
      setOpen(null)
      queueQ.reload()
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Expense payments</h1>
          <p className="muted">
            Approved claims not yet paid.
          </p>
        </div>
        <div className="ex-headline">{money(owed)} outstanding</div>
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}

      {queueQ.loading ? (
        <Loading />
      ) : queueQ.error ? (
        <ErrorNote>{queueQ.error}</ErrorNote>
      ) : !queueQ.data?.length ? (
        <Empty>Nothing outstanding.</Empty>
      ) : (
        <>
          <ClaimList
            claims={queueQ.data}
            open={open}
            onToggle={(id) => setOpen(open === id ? null : id)}
            onChanged={queueQ.reload}
            showOwner
          />
          {open && (
            <section className="card ex-decide">
              <h2 className="card-title">Record payment</h2>
              <div className="ex-row">
                <input
                  placeholder="Reference — UTR, payroll cycle, cheque number"
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                />
                <button className="btn primary" disabled={busy} onClick={() => pay(open)}>
                  Mark as paid
                </button>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
