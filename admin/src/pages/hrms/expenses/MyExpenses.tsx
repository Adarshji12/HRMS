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
import { api, download, openPrintable } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { money, toPaise } from '../../../lib/format'
import { Empty, ErrorNote, Loading } from '../../../components/ui'
import { IconPlus } from '../../../components/Icons'
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

  async function create(body: Record<string, unknown>) {
    setError(null)
    try {
      const claim = await api.post<ExpenseClaimDetail>('/expenses', body)
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
        <button className="btn primary ex-new" onClick={() => setCreating(true)}>
          <IconPlus size={15} /> New claim
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
  onCreate: (body: Record<string, unknown>) => void
  onCancel: () => void
}) {
  const month = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
  const [kind, setKind] = useState<'general' | 'conveyance'>('general')
  const [title, setTitle] = useState('')
  const [grade, setGrade] = useState('')
  const [location, setLocation] = useState('')
  const [project, setProject] = useState('')
  const conveyance = kind === 'conveyance'
  const finalTitle = title.trim() || (conveyance ? `Local conveyance - ${month}` : '')
  const create = () => onCreate({
    title: finalTitle, claim_type: kind,
    ...(conveyance ? { employee_grade: grade.trim() || null, work_location: location.trim() || null, project_label: project.trim() || null } : {}),
  })
  return (
    <section className="card ex-newclaim">
      <h2 className="card-title">New claim</h2>
      <div className="ecv-kinds" role="radiogroup" aria-label="Claim type">
        <button type="button" role="radio" aria-checked={!conveyance} className={!conveyance ? 'is-on' : ''} onClick={() => setKind('general')}>
          <b>General claim</b><span>Travel, meals, supplies - one line per receipt</span>
        </button>
        <button type="button" role="radio" aria-checked={conveyance} className={conveyance ? 'is-on' : ''} onClick={() => setKind('conveyance')}>
          <b>Local conveyance claim</b><span>Journeys to customers: from, to, mode, fare, food and parking</span>
        </button>
      </div>
      <div className="ex-row">
        <input
          autoFocus
          placeholder={conveyance ? `Local conveyance - ${month}` : 'What is this claim for? e.g. Client visit, Mumbai'}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && finalTitle) create()
          }}
        />
        {conveyance && (
          <>
            <input placeholder="Employee grade" value={grade} onChange={(e) => setGrade(e.target.value)} aria-label="Employee grade" />
            <input placeholder="Location, e.g. Noida" value={location} onChange={(e) => setLocation(e.target.value)} aria-label="Location" />
            <input placeholder="Project" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project" />
          </>
        )}
        <button className="btn primary" disabled={!finalTitle} onClick={create}>
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

      {claim.claim_type === 'conveyance' && (
        <div className="ecv-head">
          <span><em>Employee</em><b>{claim.user_name ?? '-'}</b></span>
          <span><em>Grade</em><b>{claim.employee_grade || '-'}</b></span>
          <span><em>Location</em><b>{claim.work_location || '-'}</b></span>
          <span><em>Project</em><b>{claim.project_label || '-'}</b></span>
        </div>
      )}

      {claim.can_edit && (claim.claim_type === 'conveyance' ? (
        <ConveyanceAddLine claimId={claim.id} busy={busy} act={act} />
      ) : (
        <AddLine
          claimId={claim.id}
          categories={categoriesQ.data ?? []}
          busy={busy}
          act={act}
        />
      ))}

      {claim.claim_type === 'conveyance'
        ? <ConveyanceTable claim={claim} busy={busy} act={act} />
        : <LineTable claim={claim} busy={busy} act={act} />}

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
        <button className="btn" disabled={busy}
                onClick={() => void openPrintable(`/expenses/${claim.id}/print`).catch((caught) => setError((caught as Error).message))}>
          Print claim form
        </button>
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
      <input placeholder="0.00" value={amount} type="number" data-spin min={0} step="any"
             className={amount && paise === null ? 'is-bad' : ''}
             onChange={(e) => setAmount(e.target.value)} aria-label="Amount in rupees" />
      <button className="btn primary" disabled={!ready || busy} onClick={add}>
        Add
      </button>
    </div>
  )
}

/* ------------------------------------------------- local conveyance form --- */

const MODES = ['Metro/Auto', 'Cab', 'Bus', 'Train', 'Own vehicle']
const rupee = (paise: number | null | undefined, currency?: string) => money(paise ?? 0, currency)

/** One journey: date and times, from and to, customer and SO number, mode, distance, fare, food and parking. */
function ConveyanceAddLine({
  claimId,
  busy,
  act,
}: {
  claimId: string
  busy: boolean
  act: (run: () => Promise<unknown>) => Promise<void>
}) {
  const today = new Date().toISOString().slice(0, 10)
  const blank = { spent_on: today, start: '', end: '', from: '', to: '', customer: '', so: '', mode: 'Metro/Auto', km: '', rate: '', fare: '', food: '', parking: '', remarks: '' }
  const [f, setF] = useState(blank)
  const set = (patch: Partial<typeof blank>) => setF((p) => ({ ...p, ...patch }))

  const km = f.km.trim() ? Number(f.km) : null
  const rate = toPaise(f.rate)
  // Own vehicle is paid by the kilometre: with a distance and a rate and no fare typed, the fare is their product.
  const computed = km && rate ? Math.round(km * rate) : null
  const fare = toPaise(f.fare) ?? computed ?? 0
  const food = toPaise(f.food) ?? 0
  const parking = toPaise(f.parking) ?? 0
  const grand = fare + food + parking
  const ready = Boolean(f.from.trim() && f.to.trim() && grand > 0)

  async function add() {
    await act(() =>
      api.post(`/expenses/${claimId}/lines`, {
        spent_on: f.spent_on,
        start_time: f.start || null,
        end_time: f.end || null,
        from_location: f.from.trim(),
        to_location: f.to.trim(),
        customer_name: f.customer.trim() || null,
        so_number: f.so.trim() || null,
        conveyance_mode: f.mode.trim() || null,
        distance_km: km,
        rate_per_km: rate,
        conveyance_amount: fare,
        food_amount: food,
        parking_amount: parking,
        remarks: f.remarks.trim() || null,
      }),
    )
    // Dates and the mode carry over: a day's journeys are usually entered together.
    setF({ ...blank, spent_on: f.spent_on, mode: f.mode })
  }

  return (
    <div className="ecv-add">
      <div className="ecv-grid">
        <label>Date<input type="date" value={f.spent_on} max={today} onChange={(e) => set({ spent_on: e.target.value })} /></label>
        <label>Start time<input type="time" value={f.start} onChange={(e) => set({ start: e.target.value })} /></label>
        <label>End time<input type="time" value={f.end} onChange={(e) => set({ end: e.target.value })} /></label>
        <label className="is-2">From (start location)<input value={f.from} maxLength={160} placeholder="Noida Sec-62" onChange={(e) => set({ from: e.target.value })} /></label>
        <label className="is-2">To (end location)<input value={f.to} maxLength={160} placeholder="CDOT, Chattarpur" onChange={(e) => set({ to: e.target.value })} /></label>
        <label>Customer<input value={f.customer} maxLength={160} onChange={(e) => set({ customer: e.target.value })} /></label>
        <label>SO no<input value={f.so} maxLength={60} onChange={(e) => set({ so: e.target.value })} /></label>
        <label>Mode of conveyance
          <input list="ecv-modes" value={f.mode} maxLength={60} onChange={(e) => set({ mode: e.target.value })} />
          <datalist id="ecv-modes">{MODES.map((m) => <option key={m} value={m} />)}</datalist>
        </label>
        <label>Distance (km)<input type="number" min={0} step="any" value={f.km} onChange={(e) => set({ km: e.target.value })} /></label>
        <label>Rate per km (as per policy)<input type="number" min={0} step="any" value={f.rate} onChange={(e) => set({ rate: e.target.value })} /></label>
        <label>Fare (total)<input type="number" min={0} step="any" value={f.fare} placeholder={computed ? String(computed / 100) : '0'} onChange={(e) => set({ fare: e.target.value })} /></label>
        <label>Food bill<input type="number" min={0} step="any" value={f.food} placeholder="0" onChange={(e) => set({ food: e.target.value })} /></label>
        <label>Parking / toll<input type="number" min={0} step="any" value={f.parking} placeholder="0" onChange={(e) => set({ parking: e.target.value })} /></label>
        <label className="is-2">Remarks<input value={f.remarks} maxLength={300} onChange={(e) => set({ remarks: e.target.value })} /></label>
      </div>
      <div className="ecv-add-foot">
        <span>Grand total for this journey <strong>{money(grand)}</strong></span>
        <button className="btn primary" disabled={!ready || busy} onClick={add}>Add journey</button>
      </div>
    </div>
  )
}

/** The journeys as the form lays them out, with its totals row. */
function ConveyanceTable({
  claim,
  busy,
  act,
}: {
  claim: ExpenseClaimDetail
  busy: boolean
  act: (run: () => Promise<unknown>) => Promise<void>
}) {
  if (!claim.lines.length) return <Empty>No journeys on this claim yet. Add the first one above.</Empty>
  const sum = (pick: (l: ExpenseClaimDetail['lines'][number]) => number | null | undefined) =>
    claim.lines.reduce((n, l) => n + (pick(l) ?? 0), 0)
  const lines = [...claim.lines].sort((a, b) => (a.spent_on + (a.start_time ?? '')).localeCompare(b.spent_on + (b.start_time ?? '')))
  return (
    <div className="table-wrap">
      <table className="table ecv-table">
        <thead>
          <tr>
            <th>Date</th><th>Time</th><th>From</th><th>To</th><th>Customer</th><th>SO no</th><th>Mode</th>
            <th className="num">Km</th><th className="num">Fare</th><th className="num">Food</th><th className="num">Parking</th>
            <th className="num">Grand total</th><th>Remarks</th><th />
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id}>
              <td>{l.spent_on}</td>
              <td className="muted">{[l.start_time, l.end_time].filter(Boolean).join(' - ') || '-'}</td>
              <td>{l.from_location}</td><td>{l.to_location}</td>
              <td>{l.customer_name || '-'}</td><td>{l.so_number || '-'}</td><td>{l.conveyance_mode || '-'}</td>
              <td className="num">{l.distance_km ?? '-'}</td>
              <td className="num">{rupee(l.conveyance_amount, claim.currency)}</td>
              <td className="num">{l.food_amount ? rupee(l.food_amount, claim.currency) : '-'}</td>
              <td className="num">{l.parking_amount ? rupee(l.parking_amount, claim.currency) : '-'}</td>
              <td className="num"><strong>{rupee(l.amount, claim.currency)}</strong></td>
              <td className="muted">{l.remarks || ''}</td>
              <td className="row-actions">
                {claim.can_edit && (
                  <button className="btn small danger" disabled={busy} onClick={() => act(() => api.del(`/expenses/lines/${l.id}`))}>Remove</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={8}><strong>Total</strong></td>
            <td className="num"><strong>{rupee(sum((l) => l.conveyance_amount), claim.currency)}</strong></td>
            <td className="num"><strong>{rupee(sum((l) => l.food_amount), claim.currency)}</strong></td>
            <td className="num"><strong>{rupee(sum((l) => l.parking_amount), claim.currency)}</strong></td>
            <td className="num"><strong>{rupee(claim.total_amount, claim.currency)}</strong></td>
            <td colSpan={2} />
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
