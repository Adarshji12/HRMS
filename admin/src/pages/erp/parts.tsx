/* The pieces more than one ERP screen needs.

   The ERP sits inside the CRM's visual language rather than inventing a third
   one: `CrmPage` puts `.crm` on the root, and every rule in `styles/crm.css`
   applies. What is ERP-specific is here — the document states, the line editor
   every document uses, and the reason prompt behind every cancel, reject and
   reversal (the PRD requires a reason on all of them, and so does the server). */

import { useState, type ReactNode } from 'react'
import '../../styles/crm.css'
import { useQuery } from '../../lib/useQuery'
import { shortDate } from '../../lib/format'
import { IconClose, IconPlus } from '../../components/Icons'
import { CrmPage, Dialog, Field } from '../crm/parts'
import { erp, erpError, qtyText, rupees, type Access, type Capability, type ChainStep, type Item } from './api'

export { Dialog, Drawer, Field, Stat, Stats } from '../crm/parts'

export function ErpPage(props: { title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return <CrmPage {...props} />
}

/* ----------------------------------------------------------------- access --- */

const NONE = {} as Access

/** What this person may do. Buttons they cannot use are not shown — the server
 *  refuses them anyway, and a button that only ever errors is a broken page. */
export function useAccess(): { can: (flag: Capability) => boolean; loaded: boolean; any: boolean } {
  const q = useQuery('erp-access', () => erp.access())
  const data = q.data ?? NONE
  return {
    can: (flag) => Boolean(data[flag]),
    loaded: q.data !== undefined,
    any: Object.values(data).some(Boolean),
  }
}

/* ----------------------------------------------------------------- states --- */

const TONE: Record<string, string> = {
  active: 'good', approved: 'good', posted: 'good', received: 'good', delivered: 'good',
  verified: 'good', awarded: 'good', dispatched: 'good', invoiced: 'good', ready: 'good', in_stock: 'good',
  submitted: 'warn', pending: 'warn', partially_received: 'warn', partially_dispatched: 'warn',
  in_transit: 'warn', on_hold: 'warn', acknowledged: 'warn', issued: 'warn',
  rejected: 'bad', blacklisted: 'bad', suspended: 'bad', reversed: 'bad', overdue: 'bad',
}

const LABEL: Record<string, string> = {
  partially_received: 'Part received',
  partially_dispatched: 'Part dispatched',
  in_transit: 'In transit',
  on_hold: 'On hold',
  in_stock: 'In stock',
  credit_note: 'Credit note',
  purchase_requisition: 'Requisition',
  approved: 'Approved',
}

export function label(value: string): string {
  return LABEL[value] ?? value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, ' ')
}

export function ErpState({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="crm-muted">—</span>
  return <span className={`crm-state crm-state-${TONE[value] ?? 'idle'}`}>{label(value)}</span>
}

export function Money({ value }: { value: string | number | null | undefined }) {
  return <span className="crm-nowrap">{rupees(value)}</span>
}

export function DateText({ iso }: { iso: string | null | undefined }) {
  return iso ? <span className="crm-nowrap">{shortDate(iso)}</span> : <span className="crm-muted">—</span>
}

export function Facts({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <div className="crm-facts" style={{ padding: 0, marginBottom: 16 }}>
      {items.map(([k, v]) => (
        <div key={k}>
          <div className="crm-fact-label">{k}</div>
          <div className="crm-fact-value">{v ?? '—'}</div>
        </div>
      ))}
    </div>
  )
}

export function Tabs<T extends string>({ value, onChange, items }: {
  value: T
  onChange: (v: T) => void
  items: Array<{ key: T; label: string; count?: number }>
}) {
  return (
    <div className="crm-seg" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
      {items.map((t) => (
        <button key={t.key} className={value === t.key ? 'crm-seg-on' : ''} onClick={() => onChange(t.key)}>
          {t.label}
          {t.count !== undefined && <span className="crm-seg-count">{t.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function Note({ tone = 'warn', children }: { tone?: 'warn' | 'ok'; children: ReactNode }) {
  return <div className={`notice notice-${tone}`} style={{ marginBottom: 12 }}>{children}</div>
}

/* --------------------------------------------------------------- the chain --- */

export function ChainView({ steps }: { steps: ChainStep[] }) {
  if (!steps.length) return null
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="crm-fact-label" style={{ marginBottom: 6 }}>Approval chain</div>
      <ol style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
        {steps.map((s) => (
          <li key={s.id}>
            Level {s.level}: <ErpState value={s.status} />{' '}
            <span className="crm-muted">
              {s.acted_by_name ?? s.reviewer_name ?? s.reviewer_rule.replace(/_/g, ' ')}
              {s.note ? ` — ${s.note}` : ''}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

/* ------------------------------------------------------------- running it --- */

/** One async action with its busy flag and its error, so a page with eight
 *  buttons does not carry eight pairs of state. */
export function useRun(onDone?: () => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function run<T>(fn: () => Promise<T>, fallback = 'That did not work'): Promise<T | undefined> {
    setBusy(true)
    setError(null)
    try {
      const out = await fn()
      onDone?.()
      return out
    } catch (err) {
      setError(erpError(err, fallback))
      return undefined
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, setError, run }
}

/** The prompt behind every cancel, reject, reversal and override. */
export function ReasonDialog({ title, hint, confirm = 'Confirm', danger, onClose, onSubmit }: {
  title: string
  hint?: string
  confirm?: string
  danger?: boolean
  onClose: () => void
  onSubmit: (reason: string) => Promise<unknown>
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function go() {
    setBusy(true)
    setError(null)
    try {
      await onSubmit(reason.trim())
      onClose()
    } catch (err) {
      setError(erpError(err, 'That did not work'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog title={title} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Back</button>
        <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={busy || !reason.trim()} onClick={() => void go()}>
          {busy ? 'Working…' : confirm}
        </button>
      </>
    }>
      <div style={{ padding: '0 20px 8px' }}>
        <Field label="Reason" hint={hint ?? 'Kept on the record with your name.'}>
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </Field>
        {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
      </div>
    </Dialog>
  )
}

/** Approve / reject for any document waiting on the viewer. Rejection asks why. */
export function DecideBar({ onDecide }: { onDecide: (approve: boolean, note?: string) => Promise<unknown> }) {
  const [rejecting, setRejecting] = useState(false)
  const { busy, error, run } = useRun()
  return (
    <>
      <button className="btn btn-primary" disabled={busy} onClick={() => void run(() => onDecide(true))}>Approve</button>
      <button className="btn btn-danger" disabled={busy} onClick={() => setRejecting(true)}>Reject</button>
      {error && <span className="error">{error}</span>}
      {rejecting && (
        <ReasonDialog title="Reject" confirm="Reject" danger onClose={() => setRejecting(false)}
          hint="The requester sees this — say what would make it approvable."
          onSubmit={(reason) => onDecide(false, reason)} />
      )}
    </>
  )
}

/* ------------------------------------------------------------ line editor --- */

export interface EditLine {
  key: string
  item_id: string
  description: string
  quantity: string
  rate: string
  gst_percent: string
}

export function blankLine(): EditLine {
  return { key: Math.random().toString(36).slice(2), item_id: '', description: '', quantity: '1', rate: '0', gst_percent: '18' }
}

export function useItems(itemType?: 'goods' | 'service') {
  return useQuery(`erp-items-${itemType ?? 'all'}`, () => erp.items({ active_only: true, item_type: itemType }))
}

/** Quantity × rate with GST, for documents that are priced. `rateKey` lets a
 *  requisition use its estimate and everything else its rate. */
export function LineEditor({ lines, onChange, priced = true, items, rateFrom = 'sale_price' }: {
  lines: EditLine[]
  onChange: (lines: EditLine[]) => void
  priced?: boolean
  items: Item[]
  rateFrom?: 'sale_price' | 'standard_cost'
}) {
  const set = (key: string, patch: Partial<EditLine>) =>
    onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)))

  const total = lines.reduce((sum, l) => {
    const taxable = Number(l.quantity || 0) * Number(l.rate || 0)
    return sum + taxable * (1 + Number(l.gst_percent || 0) / 100)
  }, 0)

  return (
    <div>
      <div className="table-wrap">
        <table className="crm-lines">
          <thead>
            <tr>
              <th>Item / description</th>
              <th className="crm-num">Qty</th>
              {priced && <th className="crm-num">Rate</th>}
              {priced && <th className="crm-num">GST %</th>}
              {priced && <th className="crm-num">Amount</th>}
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const taxable = Number(l.quantity || 0) * Number(l.rate || 0)
              return (
                <tr key={l.key}>
                  <td className="crm-line-name-cell">
                    <select value={l.item_id} onChange={(e) => {
                      const item = items.find((i) => i.id === e.target.value)
                      set(l.key, item
                        ? { item_id: item.id, description: item.name, rate: item[rateFrom], gst_percent: item.gst_percent }
                        : { item_id: '' })
                    }}>
                      <option value="">— free text —</option>
                      {items.map((i) => <option key={i.id} value={i.id}>{i.code} · {i.name}</option>)}
                    </select>
                    <input value={l.description} placeholder="Description" onChange={(e) => set(l.key, { description: e.target.value })} />
                  </td>
                  <td className="crm-line-qty"><input inputMode="decimal" value={l.quantity} onChange={(e) => set(l.key, { quantity: e.target.value })} /></td>
                  {priced && <td className="crm-line-rate"><input inputMode="decimal" value={l.rate} onChange={(e) => set(l.key, { rate: e.target.value })} /></td>}
                  {priced && <td className="crm-line-gst"><input inputMode="decimal" value={l.gst_percent} onChange={(e) => set(l.key, { gst_percent: e.target.value })} /></td>}
                  {priced && <td className="crm-num crm-nowrap">{rupees(taxable * (1 + Number(l.gst_percent || 0) / 100))}</td>}
                  <td>
                    <button className="crm-icon-btn" aria-label="Remove line" disabled={lines.length === 1}
                      onClick={() => onChange(lines.filter((x) => x.key !== l.key))}>
                      <IconClose size={14} />
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', marginTop: 8 }}>
        <button className="btn btn-sm" onClick={() => onChange([...lines, blankLine()])}><IconPlus size={14} /> Add line</button>
        {priced && <span className="crm-push crm-strong">Estimated total {rupees(total)}</span>}
      </div>
    </div>
  )
}

export function linesPayload(lines: EditLine[], rateKey = 'rate') {
  return lines.map((l) => ({
    item_id: l.item_id || null,
    description: l.description || null,
    quantity: l.quantity,
    [rateKey]: l.rate,
    gst_percent: l.gst_percent,
  }))
}

/** A document's lines, read-only. */
export function LinesTable({ lines, extra }: {
  lines: Array<{ id: string; item_code?: string | null; description: string; quantity: string; rate?: string; amount?: string }>
  extra?: Array<{ head: string; cell: (line: never) => ReactNode }>
}) {
  return (
    <div className="table-wrap" style={{ marginBottom: 14 }}>
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th className="crm-num">Qty</th>
            {lines.some((l) => l.rate !== undefined) && <th className="crm-num">Rate</th>}
            {extra?.map((e) => <th key={e.head} className="crm-num">{e.head}</th>)}
            {lines.some((l) => l.amount !== undefined) && <th className="crm-num">Amount</th>}
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id}>
              <td>{l.item_code && <span className="crm-code">{l.item_code}</span>} {l.description}</td>
              <td className="crm-num">{qtyText(l.quantity)}</td>
              {l.rate !== undefined && <td className="crm-num">{rupees(l.rate)}</td>}
              {extra?.map((e) => <td key={e.head} className="crm-num">{e.cell(l as never)}</td>)}
              {l.amount !== undefined && <td className="crm-num">{rupees(l.amount)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
