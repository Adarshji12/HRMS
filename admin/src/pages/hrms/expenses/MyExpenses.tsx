/* Expense claims — mine, and the detail view every screen here reuses.

   Four server truths this file is built around:

   1. **The total is server-computed.** Every line mutation returns the *whole
      claim*, so this file never adds up amounts itself. If it did, the number on
      screen could disagree with the number a manager approves.

   2. **Submitting freezes the lines.** The edit controls are gated on
      `can_edit`, which the server resolves — not on `status === 'draft'`
      re-derived here. Two implementations of one rule diverge.

   3. **Receipts are per line and replace on re-upload.** A line is one expense;
      the server refuses submission when a category demands a receipt and the
      line has none, so `receipt_required` is rendered as a visible gap rather
      than left for the submit to fail on.

   4. **Amounts are integer paise.** `money()` formats at the very edge and
      `toPaise()` parses at the other; nothing in between does arithmetic on a
      formatted value. */

import { useCallback, useState } from 'react'
import { api, download } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { money, toPaise } from '../../../lib/format'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import type {
  ExpenseCategory,
  ExpenseClaimDetail,
  ExpenseClaim,
  ExpenseSummary,
} from '../../../lib/types'
import '../../../styles/expenses.css'

export function statusLabel(value: string): string {
  return value.replace(/^./, (c) => c.toUpperCase())
}

export function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'reimbursed' ? 'ok'
      : status === 'approved' ? 'go'
        : status === 'rejected' || status === 'cancelled' ? 'bad'
          : status === 'submitted' ? 'warn'
            : 'muted'
  return <span className={`ex-pill ex-pill-${tone}`}>{statusLabel(status)}</span>
}

export default function MyExpenses() {
  const claimsQ = useQuery<ExpenseClaim[]>('my-claims', () =>
    api.get<ExpenseClaim[]>('/expenses?mine=true'),
  )
  const summaryQ = useQuery<ExpenseSummary>('my-claims-summary', () =>
    api.get<ExpenseSummary>('/expenses/summary'),
  )
  const [open, setOpen] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const reload = useCallback(() => {
    claimsQ.reload()
    summaryQ.reload()
  }, [claimsQ, summaryQ])

  async function create(title: string) {
    setError(null)
    try {
      const claim = await api.post<ExpenseClaimDetail>('/expenses', { title })
      setCreating(false)
      setOpen(claim.id)
      reload()
    } catch (caught) {
      setError((caught as Error).message)
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>My expenses</h1>
          <p className="muted">
            Add the lines, attach the receipts, then submit. Nothing is visible
            to your manager until you do.
          </p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>
          New claim
        </button>
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}

      {summaryQ.data && (
        <div className="ex-tiles">
          <Tile label="Owed to you"
                value={money(summaryQ.data.outstanding_amount)}
                meta={`${summaryQ.data.outstanding_count} approved, awaiting payment`} />
          <Tile label="With your manager"
                value={String(summaryQ.data.by_status.submitted?.count ?? 0)}
                meta={money(summaryQ.data.by_status.submitted?.amount ?? 0)} />
          <Tile label="Drafts"
                value={String(summaryQ.data.by_status.draft?.count ?? 0)}
                meta="not yet submitted" />
          <Tile label="Paid this period"
                value={money(summaryQ.data.by_status.reimbursed?.amount ?? 0)}
                meta={`${summaryQ.data.by_status.reimbursed?.count ?? 0} claims`} />
        </div>
      )}

      {creating && <NewClaim onCreate={create} onCancel={() => setCreating(false)} />}

      {claimsQ.loading ? (
        <Loading />
      ) : claimsQ.error ? (
        <ErrorNote>{claimsQ.error}</ErrorNote>
      ) : !claimsQ.data?.length ? (
        <Empty>No claims yet.</Empty>
      ) : (
        <ClaimList
          claims={claimsQ.data}
          open={open}
          onToggle={(id) => setOpen(open === id ? null : id)}
          onChanged={reload}
        />
      )}
    </div>
  )
}

function Tile({ label, value, meta }: { label: string; value: string; meta: string }) {
  return (
    <div className="ex-tile">
      <div className="ex-tile-label">{label}</div>
      <div className="ex-tile-value">{value}</div>
      <div className="ex-tile-meta">{meta}</div>
    </div>
  )
}

function NewClaim({
  onCreate,
  onCancel,
}: {
  onCreate: (title: string) => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState('')
  return (
    <section className="card ex-newclaim">
      <h2 className="card-title">New claim</h2>
      <div className="ex-row">
        <input
          autoFocus
          placeholder="What is this claim for? e.g. Client visit, Mumbai"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && title.trim()) onCreate(title.trim())
          }}
        />
        <button className="btn primary" disabled={!title.trim()}
                onClick={() => onCreate(title.trim())}>
          Create
        </button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </section>
  )
}

/** The claim list, reused by My expenses, the review queue and payments. */
export function ClaimList({
  claims,
  open,
  onToggle,
  onChanged,
  showOwner = false,
}: {
  claims: ExpenseClaim[]
  open: string | null
  onToggle: (id: string) => void
  onChanged: () => void
  showOwner?: boolean
}) {
  return (
    <div className="ex-list">
      {claims.map((claim) => (
        <div key={claim.id} className={`ex-card${open === claim.id ? ' is-open' : ''}`}>
          <button className="ex-card-head" onClick={() => onToggle(claim.id)}>
            <div className="ex-card-title">
              <div className="ex-title">{claim.title}</div>
              <div className="muted">
                {showOwner && claim.user_name ? `${claim.user_name} · ` : ''}
                {claim.line_count} {claim.line_count === 1 ? 'item' : 'items'}
                {claim.project_name ? ` · ${claim.project_name}` : ''}
                {claim.created_by_name ? ` · filed by ${claim.created_by_name}` : ''}
              </div>
            </div>
            <div className="ex-card-amount">{money(claim.total_amount, claim.currency)}</div>
            <StatusPill status={claim.status} />
          </button>
          {open === claim.id && <ClaimDetail claimId={claim.id} onChanged={onChanged} />}
        </div>
      ))}
    </div>
  )
}

function ClaimDetail({ claimId, onChanged }: { claimId: string; onChanged: () => void }) {
  const detailQ = useQuery<ExpenseClaimDetail>(`claim-${claimId}`, () =>
    api.get<ExpenseClaimDetail>(`/expenses/${claimId}`),
  )
  const categoriesQ = useQuery<ExpenseCategory[]>('expense-categories', () =>
    api.get<ExpenseCategory[]>('/expenses/categories?active_only=true'),
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /* Every mutation returns the whole claim, so the local copy is replaced from
     the response rather than patched — which is what keeps the displayed total
     equal to the server's. */
  const act = useCallback(
    async (run: () => Promise<unknown>) => {
      setBusy(true)
      setError(null)
      try {
        await run()
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

  if (detailQ.loading) return <div className="ex-card-body"><Loading /></div>
  if (detailQ.error) return <div className="ex-card-body"><ErrorNote>{detailQ.error}</ErrorNote></div>
  if (!detailQ.data) return null
  const claim = detailQ.data

  return (
    <div className="ex-card-body">
      {error && <ErrorNote>{error}</ErrorNote>}

      {claim.review_note && (
        <p className={claim.status === 'rejected' ? 'ex-warn' : 'muted'}>
          {claim.reviewer_name ? `${claim.reviewer_name}: ` : ''}{claim.review_note}
        </p>
      )}
      {claim.status === 'reimbursed' && (
        <p className="ex-ok">
          Paid{claim.reimbursed_at ? ` on ${claim.reimbursed_at.slice(0, 10)}` : ''}
          {claim.payment_reference ? ` · ${claim.payment_reference}` : ''}
        </p>
      )}

      <LineTable claim={claim} busy={busy} act={act} />

      {claim.can_edit && (
        <AddLine
          claimId={claim.id}
          categories={categoriesQ.data ?? []}
          busy={busy}
          act={act}
        />
      )}

      <div className="ex-actions">
        <div className="ex-total">
          Total <strong>{money(claim.total_amount, claim.currency)}</strong>
          {claim.approved_amount !== null && claim.approved_amount !== claim.total_amount && (
            <span className="ex-warn">
              {' '}· approved at {money(claim.approved_amount, claim.currency)}
            </span>
          )}
        </div>
        {claim.can_submit && (
          <button className="btn primary" disabled={busy}
                  onClick={() => act(() => api.post(`/expenses/${claim.id}/submit`))}>
            Submit for approval
          </button>
        )}
        {claim.can_cancel && (
          <button className="btn" disabled={busy}
                  onClick={() => act(() => api.post(`/expenses/${claim.id}/cancel`))}>
            {claim.status === 'draft' ? 'Cancel claim' : 'Withdraw'}
          </button>
        )}
        {claim.can_edit && (
          <button className="btn danger" disabled={busy}
                  onClick={() => act(() => api.del(`/expenses/${claim.id}`))}>
            Delete draft
          </button>
        )}
      </div>
    </div>
  )
}

function LineTable({
  claim,
  busy,
  act,
}: {
  claim: ExpenseClaimDetail
  busy: boolean
  act: (run: () => Promise<unknown>) => Promise<void>
}) {
  const [error, setError] = useState<string | null>(null)

  if (!claim.lines.length) {
    return <Empty>Nothing on this claim yet.</Empty>
  }

  return (
    <>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="table-wrap">
        <table className="table ex-lines">
          <thead>
            <tr>
              <th>Date</th><th>What</th><th>Category</th>
              <th>Receipt</th><th className="num">Amount</th><th />
            </tr>
          </thead>
          <tbody>
            {claim.lines.map((line) => (
              <tr key={line.id}>
                <td>{line.spent_on}</td>
                <td>
                  <div>{line.description}</div>
                  {line.merchant && <div className="muted">{line.merchant}</div>}
                </td>
                <td>{line.category_name}</td>
                <td>
                  {line.has_receipt ? (
                    <button
                      className="link-btn"
                      onClick={() =>
                        download(`/expenses/lines/${line.id}/receipt`,
                                 line.receipt_name || 'receipt')
                          .catch((caught) => setError((caught as Error).message))
                      }
                    >
                      {line.receipt_name || 'View'}
                    </button>
                  ) : line.receipt_required ? (
                    /* The server refuses submission on this, so it is shown as a
                       gap to close rather than left for the submit to fail on. */
                    <span className="ex-warn">Required</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="num">{money(line.amount, claim.currency)}</td>
                <td className="row-actions">
                  {claim.can_edit && (
                    <>
                      <ReceiptButton lineId={line.id} busy={busy} act={act}
                                     hasReceipt={line.has_receipt} />
                      <button className="btn small danger" disabled={busy}
                              onClick={() => act(() =>
                                api.del(`/expenses/lines/${line.id}`))}>
                        Remove
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function ReceiptButton({
  lineId,
  busy,
  act,
  hasReceipt,
}: {
  lineId: string
  busy: boolean
  act: (run: () => Promise<unknown>) => Promise<void>
  hasReceipt: boolean
}) {
  return (
    <label className={`btn small${busy ? ' is-disabled' : ''}`}>
      {hasReceipt ? 'Replace' : 'Receipt'}
      <input
        type="file"
        hidden
        disabled={busy}
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (!file) return
          const form = new FormData()
          form.append('file', file)
          // Cleared so choosing the same file twice fires again — a replace
          // after a failed upload is the common case.
          event.target.value = ''
          void act(() => api.upload(`/expenses/lines/${lineId}/receipt`, form))
        }}
      />
    </label>
  )
}

function AddLine({
  claimId,
  categories,
  busy,
  act,
}: {
  claimId: string
  categories: ExpenseCategory[]
  busy: boolean
  act: (run: () => Promise<unknown>) => Promise<void>
}) {
  const today = new Date().toISOString().slice(0, 10)
  const [categoryId, setCategoryId] = useState('')
  const [spentOn, setSpentOn] = useState(today)
  const [description, setDescription] = useState('')
  const [merchant, setMerchant] = useState('')
  const [amount, setAmount] = useState('')

  const paise = toPaise(amount)
  const ready = Boolean(categoryId && description.trim() && paise && paise > 0)

  async function add() {
    await act(() =>
      api.post(`/expenses/${claimId}/lines`, {
        category_id: categoryId,
        spent_on: spentOn,
        description: description.trim(),
        merchant: merchant.trim() || null,
        amount: paise,
      }),
    )
    setDescription('')
    setMerchant('')
    setAmount('')
  }

  if (!categories.length) {
    return (
      <Empty>
        No expense categories are set up yet. An administrator adds them under
        Expense settings.
      </Empty>
    )
  }

  return (
    <div className="ex-addline">
      <input type="date" value={spentOn} max={today}
             onChange={(e) => setSpentOn(e.target.value)} aria-label="Date" />
      <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}
              aria-label="Category">
        <option value="">Category…</option>
        {categories.map((category) => (
          <option key={category.id} value={category.id}>
            {category.name}
            {category.max_amount ? ` (max ${money(category.max_amount)})` : ''}
          </option>
        ))}
      </select>
      <input placeholder="What was it for?" value={description}
             onChange={(e) => setDescription(e.target.value)} aria-label="Description" />
      <input placeholder="Merchant" value={merchant}
             onChange={(e) => setMerchant(e.target.value)} aria-label="Merchant" />
      <input placeholder="0.00" value={amount} inputMode="decimal"
             className={amount && paise === null ? 'is-bad' : ''}
             onChange={(e) => setAmount(e.target.value)} aria-label="Amount in rupees" />
      <button className="btn primary" disabled={!ready || busy} onClick={add}>
        Add
      </button>
    </div>
  )
}
