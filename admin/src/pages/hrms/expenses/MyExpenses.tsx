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
import { Dialog } from '../../crm/parts'
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

  /* Create claim does the whole job: the claim, every journey, and the submission for approval. A journey that fails
     stops it before the submit, so a half-filled claim is never sent to an approver. */
  async function create(body: Record<string, unknown>, journeys: Array<Record<string, unknown>> = []) {
    setError(null)
    try {
      const claim = await api.post<ExpenseClaimDetail>('/expenses', body)
      let complete = true
      for (let i = 0; i < journeys.length; i += 1) {
        try {
          await api.post(`/expenses/${claim.id}/lines`, journeys[i])
        } catch (caught) {
          setError(`The claim was created as a draft, but journey ${i + 1} could not be added: ${(caught as Error).message}`)
          complete = false
          break
        }
      }
      if (complete && journeys.length > 0) {
        try {
          await api.post(`/expenses/${claim.id}/submit`)
        } catch (caught) {
          setError(`The claim was created but could not be submitted for approval: ${(caught as Error).message}`)
        }
      }
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

type JourneyRow = {
  spent_on: string; start: string; end: string; from: string; to: string; customer: string; mode: string
  km: string; rate: string; fare: string; food: string; parking: string; remarks: string
}

const blankRow = (spent_on: string, mode = 'Metro/Auto'): JourneyRow => ({
  spent_on, start: '', end: '', from: '', to: '', customer: '', mode, km: '', rate: '', fare: '', food: '', parking: '', remarks: '',
})

/** One journey row as the amounts it adds up to: the fare (or distance x rate when no fare is typed), food, parking. */
function rowAmounts(r: JourneyRow) {
  const km = r.km.trim() ? Number(r.km) : null
  const rate = toPaise(r.rate)
  const computed = km && rate ? Math.round(km * rate) : null
  // With a distance and a rate the fare is worked out and cannot be typed over; without them it is entered.
  const fare = computed ?? toPaise(r.fare) ?? 0
  const food = toPaise(r.food) ?? 0
  const parking = toPaise(r.parking) ?? 0
  return { km, rate, computed, fare, food, parking, grand: fare + food + parking }
}

/** The fields of one journey, shared by the New claim popup and the add-journey popup. */
function JourneyFields({ r, today, onChange }: { r: JourneyRow; today: string; onChange: (patch: Partial<JourneyRow>) => void }) {
  const a = rowAmounts(r)
  return (
        <div className="ecv-fields">
          <label className="ecv-f">Date
            <input type="date" value={r.spent_on} max={today} onChange={(e) => onChange({ spent_on: e.target.value })} /></label>
          <label className="ecv-f">Start time
            <input type="time" value={r.start} onChange={(e) => onChange({ start: e.target.value })} /></label>
          <label className="ecv-f">End time
            <input type="time" value={r.end} onChange={(e) => onChange({ end: e.target.value })} /></label>
          <label className="ecv-f">Mode of conveyance
            <select value={r.mode} onChange={(e) => onChange({ mode: e.target.value })}>
              {[...MODES, ...(MODES.includes(r.mode) ? [] : [r.mode])].map((m) => <option key={m} value={m}>{m}</option>)}
            </select></label>

          <label className="ecv-f ecv-w2">From (start location)
            <input value={r.from} maxLength={160} placeholder="Noida Sec-62" onChange={(e) => onChange({ from: e.target.value })} /></label>
          <label className="ecv-f ecv-w2">To (end location)
            <input value={r.to} maxLength={160} placeholder="CDOT, Chattarpur" onChange={(e) => onChange({ to: e.target.value })} /></label>

          <label className="ecv-f ecv-w2">Customer name
            <input value={r.customer} maxLength={160} onChange={(e) => onChange({ customer: e.target.value })} /></label>
          <label className="ecv-f">Distance (km)
            <input type="number" min={0} step="any" value={r.km} onChange={(e) => onChange({ km: e.target.value })} /></label>
          <label className="ecv-f">Rate per km
            <input type="number" min={0} step="any" value={r.rate} onChange={(e) => onChange({ rate: e.target.value })} /></label>

          <label className="ecv-f">Total fare
            {a.computed !== null ? (
              <input readOnly className="ecv-ro" value={money(a.computed)} />
            ) : (
              <input type="number" min={0} step="any" value={r.fare} placeholder="0" onChange={(e) => onChange({ fare: e.target.value })} />
            )}
            <small className="ecv-hint">{a.computed !== null ? `Calculated: ${r.km} km x ${r.rate} per km` : 'Type the fare, or give a distance and rate'}</small></label>
          <label className="ecv-f">Food bill
            <input type="number" min={0} step="any" value={r.food} placeholder="0" onChange={(e) => onChange({ food: e.target.value })} /></label>
          <label className="ecv-f">Parking / toll
            <input type="number" min={0} step="any" value={r.parking} placeholder="0" onChange={(e) => onChange({ parking: e.target.value })} /></label>
          <label className="ecv-f">Grand total
            <input readOnly value={a.grand ? money(a.grand) : ''} placeholder="0.00" className="ecv-ro" />
            <small className="ecv-hint">Fare + food + parking</small></label>

          <label className="ecv-f ecv-w4">Remarks
            <input value={r.remarks} maxLength={300} onChange={(e) => onChange({ remarks: e.target.value })} /></label>
        </div>
  )
}

/** New claim, as a popup: the local conveyance claim form, one card for every journey. */
function NewClaim({
  onCreate,
  onCancel,
}: {
  onCreate: (body: Record<string, unknown>, journeys: Array<Record<string, unknown>>) => Promise<void>
  onCancel: () => void
}) {
  const today = new Date().toISOString().slice(0, 10)
  const month = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
  const [title, setTitle] = useState('')
  const [rows, setRows] = useState<JourneyRow[]>([blankRow(today)])
  const [busy, setBusy] = useState(false)

  const filled = rows.filter((r) => r.from.trim() || r.to.trim() || r.fare.trim() || r.food.trim() || r.parking.trim() || r.km.trim())
  const bad = filled.some((r) => !r.from.trim() || !r.to.trim() || rowAmounts(r).grand <= 0)
  const total = filled.reduce((n, r) => n + rowAmounts(r).grand, 0)
  const finalTitle = title.trim() || `Local conveyance - ${month}`
  const ready = filled.length > 0 && !bad

  const setRow = (i: number, patch: Partial<JourneyRow>) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)))
  const addRow = () => setRows((rs) => [...rs, blankRow(rs[rs.length - 1]?.spent_on ?? today, rs[rs.length - 1]?.mode)])
  const removeRow = (i: number) => setRows((rs) => (rs.length > 1 ? rs.filter((_, k) => k !== i) : rs))

  async function create() {
    setBusy(true)
    try {
      await onCreate(
        { title: finalTitle, claim_type: 'conveyance' },
        filled.map((r) => {
          const a = rowAmounts(r)
          return {
            spent_on: r.spent_on, start_time: r.start || null, end_time: r.end || null,
            from_location: r.from.trim(), to_location: r.to.trim(), customer_name: r.customer.trim() || null,
            conveyance_mode: r.mode.trim() || null, distance_km: a.km, rate_per_km: a.rate,
            conveyance_amount: a.fare, food_amount: a.food, parking_amount: a.parking, remarks: r.remarks.trim() || null,
          }
        }),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title="New conveyance claim" subtitle="Add a card for every journey. Your name, code, grade and location come from your profile." wide onClose={onCancel}
            footer={<>
              <span className="ecv-dlg-total">Total claim <strong>{money(total)}</strong></span>
              <button className="btn" onClick={onCancel}>Cancel</button>
              <button className="btn btn-primary" disabled={!ready || busy} onClick={() => void create()}>{busy ? 'Submitting...' : 'Create & submit claim'}</button>
            </>}>
      <div className="ecv-dlg-body">
        <label className="ecv-f">Claim name
          <input value={title} autoFocus placeholder={`Local conveyance - ${month}`} onChange={(e) => setTitle(e.target.value)} />
        </label>

        {rows.map((r, i) => {
          const a = rowAmounts(r)
          return (
            <section className="ecv-card" key={i}>
              <header>
                <b>Journey {i + 1}</b>
                <span className="ecv-card-sum">{a.grand ? money(a.grand) : ''}</span>
                {rows.length > 1 && <button type="button" className="ecv-x" onClick={() => removeRow(i)} aria-label={`Remove journey ${i + 1}`} title="Remove this journey">&times;</button>}
              </header>
              <JourneyFields r={r} today={today} onChange={(patch) => setRow(i, patch)} />
            </section>
          )
        })}

        <div className="ecv-dlg-actions">
          <button type="button" className="btn" onClick={addRow}>+ Add journey</button>
          {bad && <span className="ecv-dlg-bad">Every journey needs a from, a to and an amount.</span>}
        </div>
      </div>
    </Dialog>
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
  const [addingJourney, setAddingJourney] = useState(false)

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

      {claim.claim_type === 'conveyance' && (claim.can_review || claim.can_reimburse) && (
        <div className="ecv-head">
          <span><em>Employee</em><b>{claim.user_name ?? '-'}{claim.user_code ? ` (${claim.user_code})` : ''}</b></span>
          <span><em>Grade</em><b>{claim.employee_grade || claim.user_designation || '-'}</b></span>
          <span><em>Location</em><b>{claim.work_location || claim.user_location || '-'}</b></span>
          <span><em>Department</em><b>{claim.user_department || '-'}</b></span>
        </div>
      )}

      {claim.can_edit && (claim.claim_type === 'conveyance' ? (
        <div className="ecv-addbar">
          <button className="btn" disabled={busy} onClick={() => setAddingJourney(true)}>+ Add journey</button>
        </div>
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

      {addingJourney && <AddJourneyDialog claimId={claim.id} act={act} onClose={() => setAddingJourney(false)} />}

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

/** Add one journey to an open claim, in a popup with the same fields as the New claim form. */
function AddJourneyDialog({ claimId, act, onClose }: {
  claimId: string
  act: (run: () => Promise<unknown>) => Promise<void>
  onClose: () => void
}) {
  const today = new Date().toISOString().slice(0, 10)
  const [r, setR] = useState<JourneyRow>(blankRow(today))
  const [busy, setBusy] = useState(false)
  const a = rowAmounts(r)
  const ready = Boolean(r.from.trim() && r.to.trim() && a.grand > 0)

  async function add() {
    setBusy(true)
    await act(() =>
      api.post(`/expenses/${claimId}/lines`, {
        spent_on: r.spent_on, start_time: r.start || null, end_time: r.end || null,
        from_location: r.from.trim(), to_location: r.to.trim(), customer_name: r.customer.trim() || null,
        conveyance_mode: r.mode.trim() || null, distance_km: a.km, rate_per_km: a.rate,
        conveyance_amount: a.fare, food_amount: a.food, parking_amount: a.parking, remarks: r.remarks.trim() || null,
      }),
    )
    setBusy(false)
    onClose()
  }

  return (
    <Dialog title="Add a journey" wide onClose={onClose}
            footer={<>
              <span className="ecv-dlg-total">Grand total for this journey <strong>{money(a.grand)}</strong></span>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={!ready || busy} onClick={() => void add()}>{busy ? 'Adding...' : 'Add journey'}</button>
            </>}>
      <div className="ecv-dlg-body">
        <section className="ecv-card">
          <JourneyFields r={r} today={today} onChange={(patch) => setR((cur) => ({ ...cur, ...patch }))} />
        </section>
      </div>
    </Dialog>
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
            <th>Date</th><th>Time</th><th>From</th><th>To</th><th>Customer</th><th>Mode</th>
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
              <td>{l.customer_name || '-'}</td><td>{l.conveyance_mode || '-'}</td>
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
            <td colSpan={7}><strong>Total</strong></td>
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
