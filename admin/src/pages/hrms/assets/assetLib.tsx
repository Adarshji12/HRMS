import { useState, type FormEvent } from 'react'
import { api, ApiError } from '../../../lib/api'
import { money, toPaise } from '../../../lib/format'
import { ErrorNote } from '../../../components/ui'

/* ---------------------------------------------------------------- types ---
   Shared by the asset pages. These mirror app/schemas/assets.py exactly. */

export type RenewalState = 'none' | 'ok' | 'upcoming' | 'due' | 'overdue'

export interface Asset {
  id: string
  asset_tag: string
  category: string
  serial_number: string | null
  purchase_date: string | null
  status: string
  created_at: string

  name: string | null
  brand: string | null
  model_name: string | null
  vendor: string | null
  invoice_number: string | null
  purchase_cost_paise: number | null
  location: string | null
  warranty_expiry: string | null
  renewal_date: string | null
  renewal_cycle: string
  renewal_cost_paise: number | null
  reminder_days: number
  auto_renew: boolean
  notes: string | null

  /** Derived server-side against today, so every screen agrees on "due". */
  renewal_state: RenewalState
  days_to_renewal: number | null
  warranty_state: 'none' | 'ok' | 'expiring' | 'expired'

  /** All four are null together when nobody holds the asset. */
  current_holder_id: string | null
  current_holder_name: string | null
  current_assignment_id: string | null
  assigned_at: string | null
}

export interface AssetAssignment {
  id: string
  asset_id: string
  user_id: string
  assigned_at: string
  returned_at: string | null
  assigned_condition_note: string | null
  returned_condition_note: string | null
  is_open: boolean
  user_name: string | null
  asset_tag: string | null
  asset_category: string | null
}

export interface AssetRenewal {
  id: string
  asset_id: string
  renewed_on: string
  previous_due: string | null
  next_due: string | null
  cost_paise: number | null
  reference: string | null
  note: string | null
  renewed_by_name: string | null
  asset_tag: string | null
  asset_name: string | null
  created_at: string
}

/* --------------------------------------------------------------- labels --- */

/** The categories offered out of the box. The API accepts any lower-case
 *  slug, so "Other…" in the form lets a company track whatever it owns. */
export const CATEGORY_LABEL: Record<string, string> = {
  laptop: 'Laptop',
  desktop: 'Desktop',
  monitor: 'Monitor',
  mobile: 'Mobile phone',
  tablet: 'Tablet',
  sim: 'SIM',
  id_card: 'ID card',
  printer: 'Printer / scanner',
  networking: 'Networking',
  furniture: 'Furniture',
  vehicle: 'Vehicle',
  machinery: 'Machinery / equipment',
  software_license: 'Software licence',
  subscription: 'Subscription',
  domain_hosting: 'Domain / hosting',
  insurance: 'Insurance policy',
  amc: 'AMC / service contract',
  other: 'Other',
}

export function categoryLabel(value: string): string {
  if (CATEGORY_LABEL[value]) return CATEGORY_LABEL[value]
  const words = value.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** "Delivery van" → "delivery_van", the slug the API stores. */
export function toCategorySlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
}

export const ASSET_STATUS_LABEL: Record<string, string> = {
  available: 'Available',
  assigned: 'Assigned',
  under_repair: 'Under repair',
  retired: 'Retired',
}

export const CYCLE_LABEL: Record<string, string> = {
  none: 'One-off (no cycle)',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  half_yearly: 'Half-yearly',
  yearly: 'Yearly',
  two_years: 'Every 2 years',
  three_years: 'Every 3 years',
}

export const RENEWAL_STATE_LABEL: Record<RenewalState, string> = {
  none: 'Not tracked',
  ok: 'On track',
  upcoming: 'Upcoming',
  due: 'Due soon',
  overdue: 'Overdue',
}

/* -------------------------------------------------------------- helpers --- */

/**
 * A 403 or 409 from this API may carry a typed body — `{reason, message}`.
 * `api.ts` flattens a non-string `detail` to JSON text, so unwrap it here and
 * render the sentence the server wrote. Never a bare status code.
 */
export function errorText(err: unknown, fallback: string): string {
  const raw = err instanceof ApiError || err instanceof Error ? err.message : String(err ?? '')
  if (!raw) return fallback
  if (raw.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as { message?: unknown; reason?: unknown }
      if (typeof parsed.message === 'string') return parsed.message
      if (typeof parsed.reason === 'string') return parsed.reason
    } catch {
      /* Not JSON after all — fall through and show what we were given. */
    }
  }
  return raw
}

export function rupees(paise: number | null | undefined): string {
  return paise == null ? '—' : money(paise)
}

/** Paise → the plain rupee string a form input should show. */
export function paiseToInput(paise: number | null | undefined): string {
  return paise == null ? '' : String(paise / 100)
}

export function parseRupees(input: string): number | null {
  return input.trim() === '' ? null : toPaise(input)
}

/** `2026-10-20` → `20 Oct 2026`, without a timezone shift on a bare date. */
export function day(iso: string | null | undefined): string {
  if (!iso) return '—'
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return iso
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

export function todayISODate(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function dueText(asset: Pick<Asset, 'days_to_renewal' | 'renewal_state'>): string {
  const d = asset.days_to_renewal
  if (d == null || asset.renewal_state === 'none') return ''
  if (d < 0) return `${-d} day${d === -1 ? '' : 's'} overdue`
  if (d === 0) return 'due today'
  return `in ${d} day${d === 1 ? '' : 's'}`
}

/** Turn rows into a CSV download. Quotes every cell so commas and newlines in
 *  free-text notes cannot break the columns. */
export function downloadCsv(filename: string, header: string[], rows: Array<Array<string | number | null>>) {
  const cell = (v: string | number | null) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const text = [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')
  const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function exportAssetsCsv(filename: string, assets: Asset[]) {
  downloadCsv(
    filename,
    [
      'Asset tag', 'Name', 'Category', 'Brand', 'Model', 'Serial', 'Status', 'Assigned to',
      'Assigned on', 'Location', 'Vendor', 'Invoice', 'Purchase date', 'Purchase cost (₹)',
      'Warranty till', 'Renewal due', 'Renewal cycle', 'Renewal cost (₹)', 'Renewal status', 'Notes',
    ],
    assets.map((a) => [
      a.asset_tag,
      a.name,
      categoryLabel(a.category),
      a.brand,
      a.model_name,
      a.serial_number,
      ASSET_STATUS_LABEL[a.status] ?? a.status,
      a.current_holder_name,
      a.assigned_at ? a.assigned_at.slice(0, 10) : null,
      a.location,
      a.vendor,
      a.invoice_number,
      a.purchase_date,
      a.purchase_cost_paise == null ? null : a.purchase_cost_paise / 100,
      a.warranty_expiry,
      a.renewal_date,
      a.renewal_date ? CYCLE_LABEL[a.renewal_cycle] ?? a.renewal_cycle : null,
      a.renewal_cost_paise == null ? null : a.renewal_cost_paise / 100,
      RENEWAL_STATE_LABEL[a.renewal_state],
      a.notes,
    ]),
  )
}

/* ----------------------------------------------------------- components --- */

export function AssetStatusPill({ value }: { value: string }) {
  return (
    <span className={`as-pill as-${value}`}>
      <span className="as-pill-dot" style={{ background: 'currentColor' }} />
      {ASSET_STATUS_LABEL[value] ?? value}
    </span>
  )
}

export function RenewalPill({ asset }: { asset: Pick<Asset, 'renewal_state' | 'days_to_renewal'> }) {
  if (asset.renewal_state === 'none') return <span className="as-muted">—</span>
  return (
    <span className={`as-pill as-rn-${asset.renewal_state}`} title={dueText(asset)}>
      <span className="as-pill-dot" style={{ background: 'currentColor' }} />
      {RENEWAL_STATE_LABEL[asset.renewal_state]}
    </span>
  )
}

/**
 * Record a renewal. With a cycle the next due date is pre-computed by the
 * server from the previous due date, so leaving it blank is the normal case.
 */
export function RenewForm({
  asset,
  onCancel,
  onDone,
}: {
  asset: Asset
  onCancel: () => void
  onDone: () => void
}) {
  const hasCycle = asset.renewal_cycle !== 'none'
  const [renewedOn, setRenewedOn] = useState(todayISODate())
  const [nextDue, setNextDue] = useState('')
  const [cost, setCost] = useState(paiseToInput(asset.renewal_cost_paise))
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  const [stop, setStop] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const costPaise = parseRupees(cost)
    if (cost.trim() !== '' && costPaise == null) {
      setError('Enter the renewal cost as a number')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.post(`/assets/${asset.id}/renew`, {
        renewed_on: renewedOn || null,
        next_due: stop ? null : nextDue || null,
        cost_paise: costPaise,
        reference: reference.trim() || null,
        note: note.trim() || null,
        stop_tracking: stop,
      })
      onDone()
    } catch (err) {
      setError(errorText(err, `Could not renew ${asset.asset_tag}`))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="as-panel" onSubmit={submit}>
      <div className="as-panel-head">
        <div>
          <h2 className="as-panel-title">
            Renew {asset.name ? `${asset.name} (${asset.asset_tag})` : asset.asset_tag}
          </h2>
          <p className="as-panel-sub">
            Currently due {day(asset.renewal_date)}
            {asset.renewal_date ? ` — ${dueText(asset)}` : ''}. Cycle:{' '}
            {CYCLE_LABEL[asset.renewal_cycle] ?? asset.renewal_cycle}.
          </p>
        </div>
      </div>
      {error && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      <div className="settings-grid">
        <label className="setting">
          Renewed on
          <input type="date" value={renewedOn} onChange={(e) => setRenewedOn(e.target.value)} />
        </label>
        <label className="setting">
          Next due date
          <input
            type="date"
            value={nextDue}
            onChange={(e) => setNextDue(e.target.value)}
            disabled={stop}
            required={!hasCycle && !stop}
          />
          <span className="setting-hint">
            {hasCycle
              ? 'Leave blank to move it one cycle on from the current due date.'
              : 'No cycle is set, so enter the new expiry date.'}
          </span>
        </label>
        <label className="setting">
          Amount paid (₹)
          <input value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" placeholder="0.00" />
        </label>
        <label className="setting">
          Reference / receipt no.
          <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
        </label>
        <label className="setting" style={{ gridColumn: '1 / -1' }}>
          Note
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} />
        </label>
        <label className="as-check" style={{ gridColumn: '1 / -1' }}>
          <input type="checkbox" checked={stop} onChange={(e) => setStop(e.target.checked)} />
          Not renewing any more — stop tracking renewals for this asset
        </label>
      </div>
      <div className="btn-group" style={{ marginTop: 14 }}>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : stop ? 'Stop tracking' : 'Record renewal'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
