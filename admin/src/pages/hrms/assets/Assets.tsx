import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import '../../../styles/assets.css'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { canAdminister, useAuth } from '../../../lib/auth'
import { dateTime } from '../../../lib/format'
import type { User } from '../../../lib/types'
import { Empty, EmptyState, ErrorNote, Loading, StatTile } from '../../../components/ui'
import { IconCard, IconDownload, IconReturn } from '../../../components/Icons'
import {
  ASSET_STATUS_LABEL,
  AssetStatusPill,
  CATEGORY_LABEL,
  CYCLE_LABEL,
  RENEWAL_STATE_LABEL,
  RenewForm,
  RenewalPill,
  categoryLabel,
  day,
  dueText,
  errorText,
  exportAssetsCsv,
  paiseToInput,
  parseRupees,
  rupees,
  toCategorySlug,
  todayISODate,
  type Asset,
  type AssetAssignment,
  type AssetRenewal,
} from './assetLib'

export { CATEGORY_LABEL, errorText }
export type { Asset, AssetAssignment }

/** The three statuses an asset can be *put into*. `assigned` is absent on
 *  purpose: an asset becomes issued by opening a custody row and no other way,
 *  which is what stops the register and the ledger telling two stories. */
const SETTABLE_STATUSES = ['available', 'under_repair', 'retired'] as const

/**
 * The HRMS permission flags (D-002) are not on `UserOut` yet, so `/auth/me`
 * does not return them and the field reads `undefined` here. The flags
 * **restrict, never grant**, so absent means "not restricted" — and the role
 * check beside it still gates the page. Once the lead widens `UserOut` this
 * starts honouring the flag with no change to the call sites.
 */
export function permits(user: User | null, flag: string): boolean {
  if (!user) return false
  return (user as unknown as Record<string, unknown>)[flag] !== false
}

/* The assign/return panels open above the register, which can be a long way
   from the row that was clicked. Bring them into view rather than leaving the
   admin wondering whether the button did anything. */
function scrollToPanel() {
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

/** `<input type="datetime-local">` → an ISO instant the API will read as UTC. */
function localToISO(value: string): string | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

/* ----------------------------------------------------------------- page --- */

export default function Assets() {
  const { user } = useAuth()
  const allowed = canAdminister(user) && permits(user, 'can_manage_assets')
  const [params, setParams] = useSearchParams()

  const assets = useQuery<Asset[]>('assets', () => api.get<Asset[]>('/assets'), {
    enabled: allowed,
  })
  const people = useQuery<User[]>('employees', () => api.get<User[]>('/admin/employees'), {
    enabled: allowed,
  })

  /* `?new=1` opens the add form straight away — the dashboard's "Add asset"
     button lands here. */
  const [adding, setAdding] = useState(params.get('new') === '1')
  const [editing, setEditing] = useState<Asset | null>(null)
  const [assigning, setAssigning] = useState<Asset | null>(null)
  const [returning, setReturning] = useState<Asset | null>(null)
  const [renewing, setRenewing] = useState<Asset | null>(null)
  const [ledgerFor, setLedgerFor] = useState<Asset | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)

  const [q, setQ] = useState('')
  const [status, setStatus] = useState(params.get('status') ?? '')
  const [category, setCategory] = useState(params.get('category') ?? '')
  const [holderId, setHolderId] = useState('')
  const [renewal, setRenewal] = useState(params.get('renewal') ?? '')

  /* Filtered in the browser rather than re-fetched per dropdown, the same call
     Employees.tsx makes: a register is a few hundred rows, and the endpoint's
     status/category/holder query params would cost a round trip per keystroke
     without being any more correct. */
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (assets.data ?? []).filter((a) => {
      if (status && a.status !== status) return false
      if (category && a.category !== category) return false
      if (holderId && a.current_holder_id !== holderId) return false
      if (renewal === 'attention' && !['overdue', 'due'].includes(a.renewal_state)) return false
      if (renewal && renewal !== 'attention' && a.renewal_state !== renewal) return false
      if (!needle) return true
      return [
        a.asset_tag,
        a.name,
        a.serial_number,
        a.current_holder_name,
        a.brand,
        a.model_name,
        a.vendor,
        a.location,
        a.invoice_number,
      ].some((v) => (v ?? '').toLowerCase().includes(needle))
    })
  }, [assets.data, q, status, category, holderId, renewal])

  /* Holders come from the register itself, not the roster: the set of people
     actually holding something is far shorter, and it cannot contain a name
     that matches no asset. */
  const holders = useMemo(() => {
    const seen = new Map<string, string>()
    for (const a of assets.data ?? []) {
      if (a.current_holder_id) seen.set(a.current_holder_id, a.current_holder_name ?? 'Unknown')
    }
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]))
  }, [assets.data])

  /* Every category in use plus the built-in ones, so a custom category a
     company added ("delivery_van") shows up in the filter too. */
  const categories = useMemo(() => {
    const all = new Set(Object.keys(CATEGORY_LABEL))
    for (const a of assets.data ?? []) all.add(a.category)
    return [...all].sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b)))
  }, [assets.data])

  const counts = useMemo(() => {
    const all = assets.data ?? []
    const by = (s: string) => all.filter((a) => a.status === s).length
    return {
      total: all.length,
      available: by('available'),
      assigned: by('assigned'),
      repair: by('under_repair'),
      attention: all.filter((a) => a.renewal_state === 'overdue' || a.renewal_state === 'due').length,
    }
  }, [assets.data])

  if (!allowed) {
    return (
      <div>
        <div className="page-head">
          <h1 className="page-title">Assets</h1>
        </div>
        <section className="card">
          <EmptyState
            icon={<IconCard size={22} />}
            title="The asset register is not open to your account"
            body="Who is holding which asset, and what the company paid for it, is administrator-only. Ask an administrator if you need a device issued, or open My assets to see what you are holding."
          />
        </section>
      </div>
    )
  }

  if (assets.error) return <ErrorNote>{errorText(assets.error, 'Could not load the register')}</ErrorNote>

  function refresh() {
    setRowError(null)
    assets.reload()
  }

  function closePanels() {
    setAssigning(null)
    setReturning(null)
    setRenewing(null)
  }

  const filtered = q !== '' || status !== '' || category !== '' || holderId !== '' || renewal !== ''

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">All assets</h1>
          <p className="page-sub">
            Everything the company owns — hardware, licences, subscriptions, vehicles — who has it,
            and when it is due for renewal.
          </p>
        </div>
        <div className="head-actions">
          <button
            className="btn"
            disabled={rows.length === 0}
            onClick={() => exportAssetsCsv(`assets-${todayISODate()}.csv`, rows)}
          >
            <IconDownload size={14} /> Export
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              setEditing(null)
              setAdding((v) => !v)
              if (params.get('new')) setParams({}, { replace: true })
            }}
          >
            {adding ? 'Cancel' : '+ Add asset'}
          </button>
        </div>
      </div>

      {(assets.data ?? []).length > 0 && (
        <div className="grid grid-tiles" style={{ marginBottom: 14 }}>
          <StatTile label="Total assets" value={String(counts.total)} />
          <StatTile label="Available" value={String(counts.available)} accent="var(--status-good)" />
          <StatTile label="Assigned" value={String(counts.assigned)} accent="var(--brand)" />
          <StatTile
            label="Under repair"
            value={String(counts.repair)}
            meta={counts.repair ? 'cannot be assigned' : undefined}
            accent={counts.repair ? 'var(--status-warn)' : undefined}
          />
          <StatTile
            label="Renewal due / overdue"
            value={String(counts.attention)}
            meta={counts.attention ? 'needs action' : 'all on track'}
            accent={counts.attention ? 'var(--status-bad)' : undefined}
          />
        </div>
      )}

      {(adding || editing) && (
        <AssetForm
          key={editing?.id ?? 'new'}
          asset={editing}
          people={people.data ?? []}
          categories={categories}
          onCancel={() => {
            setAdding(false)
            setEditing(null)
          }}
          onDone={() => {
            setAdding(false)
            setEditing(null)
            refresh()
          }}
        />
      )}

      {assigning && (
        <AssignForm
          asset={assigning}
          people={people.data ?? []}
          onCancel={() => setAssigning(null)}
          onDone={() => {
            setAssigning(null)
            refresh()
          }}
        />
      )}

      {returning && (
        <ReturnForm
          asset={returning}
          onCancel={() => setReturning(null)}
          onDone={() => {
            setReturning(null)
            refresh()
          }}
        />
      )}

      {renewing && (
        <RenewForm
          asset={renewing}
          onCancel={() => setRenewing(null)}
          onDone={() => {
            setRenewing(null)
            refresh()
          }}
        />
      )}

      <div className="filter-row">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search tag, name, serial, holder, vendor…"
          aria-label="Search the register"
          style={{ minWidth: 240 }}
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          {Object.entries(ASSET_STATUS_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {categories.map((value) => (
            <option key={value} value={value}>
              {categoryLabel(value)}
            </option>
          ))}
        </select>
        <select value={holderId} onChange={(e) => setHolderId(e.target.value)} aria-label="Assigned to">
          <option value="">Assigned to anyone</option>
          {holders.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <select value={renewal} onChange={(e) => setRenewal(e.target.value)} aria-label="Renewal">
          <option value="">Any renewal</option>
          <option value="attention">Due + overdue</option>
          {(['overdue', 'due', 'upcoming', 'ok', 'none'] as const).map((value) => (
            <option key={value} value={value}>
              {RENEWAL_STATE_LABEL[value]}
            </option>
          ))}
        </select>
        <span className="filter-count">
          {rows.length} of {(assets.data ?? []).length}
        </span>
        {filtered && (
          <button
            className="filter-reset"
            onClick={() => {
              setQ('')
              setStatus('')
              setCategory('')
              setHolderId('')
              setRenewal('')
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {rowError && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNote>{rowError}</ErrorNote>
        </div>
      )}

      {holderId && (
        <HolderHistory
          userId={holderId}
          name={holders.find(([id]) => id === holderId)?.[1] ?? 'this employee'}
        />
      )}

      <section className="card" style={{ opacity: assets.refetching ? 0.6 : 1 }}>
        {rows.length === 0 ? (
          assets.loading ? (
            <Loading />
          ) : filtered ? (
            <EmptyState
              icon={<IconCard size={22} />}
              title="Nothing on the register matches"
              body="Clear the filters, or add the asset if it has never been recorded."
            />
          ) : (
            <EmptyState
              icon={<IconCard size={22} />}
              title="No assets on the register yet"
              body="Add anything the company owns — laptops, phones, furniture, software licences, domains, insurance policies. Give it a renewal date and it shows up on the dashboard when it falls due."
              action={
                <button className="btn btn-primary" onClick={() => setAdding(true)}>
                  Add the first asset
                </button>
              }
            />
          )
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Category</th>
                  <th>Status</th>
                  <th>Assigned to</th>
                  <th>Renewal</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((asset) => (
                  <tr key={asset.id} className={asset.current_assignment_id ? 'as-row-open' : undefined}>
                    <td>
                      <div className="as-tag">{asset.asset_tag}</div>
                      {asset.name && <div className="as-name">{asset.name}</div>}
                      {(asset.serial_number || asset.location) && (
                        <div className="as-serial">
                          {[asset.serial_number, asset.location].filter(Boolean).join(' · ')}
                        </div>
                      )}
                    </td>
                    <td className="as-cat">{categoryLabel(asset.category)}</td>
                    <td>
                      <AssetStatusPill value={asset.status} />
                    </td>
                    <td>
                      {asset.current_holder_name ?? <span className="as-muted">nobody</span>}
                      {asset.assigned_at && (
                        <div className="as-when">since {dateTime(asset.assigned_at)}</div>
                      )}
                    </td>
                    <td>
                      <RenewalPill asset={asset} />
                      {asset.renewal_date && asset.renewal_state !== 'none' && (
                        <div className="as-when">
                          {day(asset.renewal_date)} · {dueText(asset)}
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="as-actions">
                        <AssetRowActions
                          asset={asset}
                          onAssign={() => {
                            setRowError(null)
                            closePanels()
                            setAssigning(asset)
                            scrollToPanel()
                          }}
                          onReturn={() => {
                            setRowError(null)
                            closePanels()
                            setReturning(asset)
                            scrollToPanel()
                          }}
                          onRenew={() => {
                            setRowError(null)
                            closePanels()
                            setRenewing(asset)
                            scrollToPanel()
                          }}
                          onLedger={() =>
                            setLedgerFor((current) => (current?.id === asset.id ? null : asset))
                          }
                          onEdit={() => {
                            setAdding(false)
                            setEditing(asset)
                            scrollToPanel()
                          }}
                          onDelete={async () => {
                            if (!window.confirm(`Delete ${asset.asset_tag} from the register?`)) return
                            try {
                              await api.del(`/assets/${asset.id}`)
                              refresh()
                            } catch (err) {
                              setRowError(
                                errorText(err, `Could not delete ${asset.asset_tag}`),
                              )
                            }
                          }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {ledgerFor && <AssetDetail asset={ledgerFor} onClose={() => setLedgerFor(null)} />}
    </div>
  )
}

/** Everything recorded about one asset: its details, custody history and
 *  renewal history, side by side. */
function AssetDetail({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const facts: Array<[string, ReactNode]> = [
    ['Name', asset.name ?? '—'],
    ['Category', categoryLabel(asset.category)],
    ['Brand / model', [asset.brand, asset.model_name].filter(Boolean).join(' ') || '—'],
    ['Serial', asset.serial_number ?? '—'],
    ['Location', asset.location ?? '—'],
    ['Vendor', asset.vendor ?? '—'],
    ['Invoice', asset.invoice_number ?? '—'],
    ['Purchased', day(asset.purchase_date)],
    ['Purchase cost', rupees(asset.purchase_cost_paise)],
    ['Warranty till', day(asset.warranty_expiry)],
    ['Renewal due', asset.renewal_date ? `${day(asset.renewal_date)} (${dueText(asset)})` : 'Not tracked'],
    ['Renewal cycle', asset.renewal_date ? CYCLE_LABEL[asset.renewal_cycle] ?? asset.renewal_cycle : '—'],
    ['Renewal cost', rupees(asset.renewal_cost_paise)],
  ]
  return (
    <section className="card" style={{ marginTop: 14 }}>
      <div className="card-head">
        <h2 className="card-title">
          {asset.asset_tag}
          {asset.name ? ` — ${asset.name}` : ''}
        </h2>
        <div className="card-tools">
          <button className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <dl className="as-facts">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {asset.notes && <div className="as-note" style={{ marginBottom: 14 }}>{asset.notes}</div>}
      <div className="grid grid-2">
        <div>
          <h3 className="as-subhead">Assignment history</h3>
          <CustodyLedger path={`/assets/${asset.id}/history`} />
        </div>
        <div>
          <h3 className="as-subhead">Renewal history</h3>
          <RenewalLedger assetId={asset.id} />
        </div>
      </div>
    </section>
  )
}

function RenewalLedger({ assetId }: { assetId: string }) {
  const path = `/assets/${assetId}/renewals`
  const history = useQuery<AssetRenewal[]>(path, () => api.get<AssetRenewal[]>(path))
  if (history.loading) return <Loading />
  if (history.error) return <ErrorNote>{errorText(history.error, 'Could not load renewals')}</ErrorNote>
  const rows = history.data ?? []
  if (rows.length === 0) return <Empty>No renewal recorded yet.</Empty>
  return (
    <div className="as-ledger">
      {rows.map((row) => (
        <div className="as-entry" key={row.id}>
          <span className="as-dot" aria-hidden="true" />
          <div>
            <div className="as-entry-head">
              <span className="as-entry-who">Renewed {day(row.renewed_on)}</span>
              {row.cost_paise != null && <span className="as-cat">{rupees(row.cost_paise)}</span>}
            </div>
            <div className="as-entry-when">
              Due {day(row.previous_due)} → {row.next_due ? day(row.next_due) : 'tracking stopped'}
              {row.renewed_by_name ? ` · by ${row.renewed_by_name}` : ''}
            </div>
            {(row.reference || row.note) && (
              <div className="as-note">{[row.reference, row.note].filter(Boolean).join(' — ')}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

/* --------------------------------------------------------------- actions --- */

/**
 * An asset with an open assignment gets no assign affordance at all.
 *
 * The server refuses it and the partial unique index refuses it underneath —
 * the constraint is real either way. Hiding the button is about not offering a
 * move that cannot be made: a button that always 409s is a bug, not a guard.
 */
function AssetRowActions({
  asset,
  onAssign,
  onReturn,
  onRenew,
  onLedger,
  onEdit,
  onDelete,
}: {
  asset: Asset
  onAssign: () => void
  onReturn: () => void
  onRenew: () => void
  onLedger: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const held = asset.current_assignment_id !== null
  return (
    <>
      {held ? (
        <button className="btn btn-sm" onClick={onReturn}>
          <IconReturn size={13} /> Return
        </button>
      ) : asset.status === 'available' ? (
        <button className="btn btn-sm btn-primary" onClick={onAssign}>
          Assign
        </button>
      ) : (
        /* under_repair and retired are not issuable, and saying so beats
           offering a button the server will refuse. */
        <span className="as-muted">
          {asset.status === 'under_repair' ? 'In the repair queue' : 'Written off'}
        </span>
      )}
      {asset.renewal_state !== 'none' && (
        <button
          className={`btn btn-sm${asset.renewal_state === 'overdue' || asset.renewal_state === 'due' ? ' btn-primary' : ''}`}
          onClick={onRenew}
        >
          Renew
        </button>
      )}
      <button className="btn btn-sm" onClick={onLedger}>
        Details
      </button>
      <button className="btn btn-sm" onClick={onEdit}>
        Edit
      </button>
      {!held && (
        <button className="btn btn-sm" onClick={onDelete}>
          Delete
        </button>
      )}
    </>
  )
}

/* ------------------------------------------------------------ register --- */

function AssetForm({
  asset,
  people,
  categories,
  onCancel,
  onDone,
}: {
  asset: Asset | null
  people: User[]
  categories: string[]
  onCancel: () => void
  onDone: () => void
}) {
  const held = asset?.current_assignment_id != null
  const [form, setForm] = useState({
    asset_tag: asset?.asset_tag ?? '',
    name: asset?.name ?? '',
    category: asset?.category ?? 'laptop',
    brand: asset?.brand ?? '',
    model_name: asset?.model_name ?? '',
    serial_number: asset?.serial_number ?? '',
    location: asset?.location ?? '',
    status: asset && asset.status !== 'assigned' ? asset.status : 'available',
    vendor: asset?.vendor ?? '',
    invoice_number: asset?.invoice_number ?? '',
    purchase_date: asset?.purchase_date ?? '',
    purchase_cost: paiseToInput(asset?.purchase_cost_paise),
    warranty_expiry: asset?.warranty_expiry ?? '',
    renewal_date: asset?.renewal_date ?? '',
    renewal_cycle: asset?.renewal_cycle ?? 'yearly',
    renewal_cost: paiseToInput(asset?.renewal_cost_paise),
    reminder_days: String(asset?.reminder_days ?? 30),
    auto_renew: asset?.auto_renew ?? false,
    notes: asset?.notes ?? '',
  })
  const [tracksRenewal, setTracksRenewal] = useState(Boolean(asset?.renewal_date))
  const [customCategory, setCustomCategory] = useState('')
  const [assignTo, setAssignTo] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))
  const isCustom = form.category === '__custom'

  async function submit(event: FormEvent) {
    event.preventDefault()
    const category = isCustom ? toCategorySlug(customCategory) : form.category
    if (!category) {
      setError('Type a name for the new category')
      return
    }
    const purchaseCost = parseRupees(form.purchase_cost)
    const renewalCost = parseRupees(form.renewal_cost)
    if ((form.purchase_cost.trim() && purchaseCost == null) || (form.renewal_cost.trim() && renewalCost == null)) {
      setError('Enter amounts as plain numbers, e.g. 45000 or 1299.50')
      return
    }
    if (tracksRenewal && !form.renewal_date) {
      setError('Give the next renewal date, or untick “This asset needs renewal”')
      return
    }
    setBusy(true)
    setError(null)
    const body = {
      asset_tag: form.asset_tag.trim(),
      name: form.name.trim() || null,
      category,
      brand: form.brand.trim() || null,
      model_name: form.model_name.trim() || null,
      serial_number: form.serial_number.trim() || null,
      location: form.location.trim() || null,
      status: form.status,
      vendor: form.vendor.trim() || null,
      invoice_number: form.invoice_number.trim() || null,
      purchase_date: form.purchase_date || null,
      purchase_cost_paise: purchaseCost,
      warranty_expiry: form.warranty_expiry || null,
      renewal_date: tracksRenewal ? form.renewal_date : null,
      renewal_cycle: tracksRenewal ? form.renewal_cycle : 'none',
      renewal_cost_paise: tracksRenewal ? renewalCost : null,
      reminder_days: Math.max(0, Math.min(365, Number(form.reminder_days) || 0)),
      auto_renew: tracksRenewal && form.auto_renew,
      notes: form.notes.trim() || null,
    }
    try {
      if (asset) {
        await api.patch(`/assets/${asset.id}`, body)
      } else {
        const created = await api.post<Asset>('/assets', body)
        if (assignTo && form.status === 'available') {
          try {
            await api.post('/assets/assign', { asset_id: created.id, user_id: assignTo })
          } catch (err) {
            setError(`Asset saved, but it could not be assigned: ${errorText(err, 'unknown error')}`)
            setBusy(false)
            return
          }
        }
      }
      onDone()
    } catch (err) {
      setError(errorText(err, 'Could not save the asset'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card" style={{ marginBottom: 16 }} onSubmit={submit}>
      <div className="card-head">
        <h2 className="card-title">{asset ? `Edit ${asset.asset_tag}` : 'Add an asset'}</h2>
      </div>
      {error && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <h3 className="as-subhead">Basic details</h3>
      <div className="settings-grid">
        <label className="setting">
          Asset tag / ID *
          <input
            value={form.asset_tag}
            onChange={(e) => set({ asset_tag: e.target.value })}
            placeholder="LAP-0142"
            required
            maxLength={64}
            autoFocus
          />
          <span className="setting-hint">Your own label or sticker number. Unique per company.</span>
        </label>
        <label className="setting">
          Asset name
          <input
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="Dell Latitude 5420 / Microsoft 365 / Office AC"
            maxLength={160}
          />
        </label>
        <label className="setting">
          Category *
          <select value={form.category} onChange={(e) => set({ category: e.target.value })}>
            {categories.map((value) => (
              <option key={value} value={value}>
                {categoryLabel(value)}
              </option>
            ))}
            <option value="__custom">+ New category…</option>
          </select>
          {isCustom && (
            <input
              style={{ marginTop: 6 }}
              value={customCategory}
              onChange={(e) => setCustomCategory(e.target.value)}
              placeholder="e.g. Delivery van, CCTV camera"
              required
            />
          )}
        </label>
        <label className="setting">
          Brand / make
          <input value={form.brand} onChange={(e) => set({ brand: e.target.value })} maxLength={120} />
        </label>
        <label className="setting">
          Model
          <input value={form.model_name} onChange={(e) => set({ model_name: e.target.value })} maxLength={120} />
        </label>
        <label className="setting">
          Serial / licence key / reg. no.
          <input value={form.serial_number} onChange={(e) => set({ serial_number: e.target.value })} maxLength={120} />
        </label>
        <label className="setting">
          Location
          <input
            value={form.location}
            onChange={(e) => set({ location: e.target.value })}
            placeholder="Head office, 2nd floor"
            maxLength={160}
          />
        </label>
        <label className="setting">
          Status
          <select value={form.status} onChange={(e) => set({ status: e.target.value })} disabled={held}>
            {SETTABLE_STATUSES.map((value) => (
              <option key={value} value={value}>
                {ASSET_STATUS_LABEL[value]}
              </option>
            ))}
          </select>
          <span className="setting-hint">
            {held
              ? 'Assigned, so the status follows the assignment. Record the return to change it.'
              : '“Assigned” is set by assigning the asset to someone.'}
          </span>
        </label>
      </div>

      <h3 className="as-subhead">Purchase &amp; warranty</h3>
      <div className="settings-grid">
        <label className="setting">
          Vendor / supplier
          <input value={form.vendor} onChange={(e) => set({ vendor: e.target.value })} maxLength={160} />
        </label>
        <label className="setting">
          Invoice number
          <input value={form.invoice_number} onChange={(e) => set({ invoice_number: e.target.value })} maxLength={80} />
        </label>
        <label className="setting">
          Purchase date
          <input type="date" value={form.purchase_date} onChange={(e) => set({ purchase_date: e.target.value })} />
        </label>
        <label className="setting">
          Purchase cost (₹)
          <input
            value={form.purchase_cost}
            onChange={(e) => set({ purchase_cost: e.target.value })}
            inputMode="decimal"
            placeholder="0.00"
          />
        </label>
        <label className="setting">
          Warranty valid till
          <input type="date" value={form.warranty_expiry} onChange={(e) => set({ warranty_expiry: e.target.value })} />
        </label>
      </div>

      <h3 className="as-subhead">Renewal</h3>
      <label className="as-check">
        <input type="checkbox" checked={tracksRenewal} onChange={(e) => setTracksRenewal(e.target.checked)} />
        This asset needs renewal (licence, subscription, domain, insurance, AMC, registration…)
      </label>
      {tracksRenewal && (
        <div className="settings-grid" style={{ marginTop: 10 }}>
          <label className="setting">
            Next renewal date *
            <input
              type="date"
              value={form.renewal_date}
              onChange={(e) => set({ renewal_date: e.target.value })}
              required
            />
          </label>
          <label className="setting">
            Renews every
            <select value={form.renewal_cycle} onChange={(e) => set({ renewal_cycle: e.target.value })}>
              {Object.entries(CYCLE_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="setting">
            Renewal cost (₹)
            <input
              value={form.renewal_cost}
              onChange={(e) => set({ renewal_cost: e.target.value })}
              inputMode="decimal"
              placeholder="0.00"
            />
          </label>
          <label className="setting">
            Remind me (days before)
            <input
              type="number"
              min={0}
              max={365}
              value={form.reminder_days}
              onChange={(e) => set({ reminder_days: e.target.value })}
            />
            <span className="setting-hint">Shows as “Due soon” on the dashboard from this many days out.</span>
          </label>
          <label className="as-check" style={{ alignSelf: 'center' }}>
            <input type="checkbox" checked={form.auto_renew} onChange={(e) => set({ auto_renew: e.target.checked })} />
            Auto-renews with the vendor
          </label>
        </div>
      )}

      {!asset && (
        <>
          <h3 className="as-subhead">Assign (optional)</h3>
          <div className="settings-grid">
            <label className="setting">
              Assign to employee
              <select
                value={assignTo}
                onChange={(e) => setAssignTo(e.target.value)}
                disabled={form.status !== 'available'}
              >
                <option value="">Keep unassigned</option>
                {people
                  .filter((p) => p.is_active)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.full_name}
                    </option>
                  ))}
              </select>
              <span className="setting-hint">You can also assign it later from the list.</span>
            </label>
          </div>
        </>
      )}

      <label className="setting" style={{ marginTop: 14, display: 'grid' }}>
        Notes
        <textarea
          value={form.notes}
          onChange={(e) => set({ notes: e.target.value })}
          rows={3}
          maxLength={4000}
          placeholder="Accessories included, account login owner, policy number…"
        />
      </label>

      <div className="btn-group" style={{ marginTop: 14 }}>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : asset ? 'Save changes' : 'Save asset'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/* -------------------------------------------------------------- custody --- */

function AssignForm({
  asset,
  people,
  onCancel,
  onDone,
}: {
  asset: Asset
  people: User[]
  onCancel: () => void
  onDone: () => void
}) {
  const [userId, setUserId] = useState('')
  const [assignedAt, setAssignedAt] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post('/assets/assign', {
        asset_id: asset.id,
        user_id: userId,
        assigned_at: localToISO(assignedAt),
        assigned_condition_note: note.trim() || null,
      })
      onDone()
    } catch (err) {
      setError(errorText(err, `Could not assign ${asset.asset_tag}`))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="as-panel" onSubmit={submit}>
      <div className="as-panel-head">
        <div>
          <h2 className="as-panel-title">Assign {asset.asset_tag}</h2>
          <p className="as-panel-sub">
            Opens a custody row. Only one can be open per asset, so this asset cannot be issued
            again until it is returned.
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
          Assign to
          <select value={userId} onChange={(e) => setUserId(e.target.value)} required>
            <option value="">Choose an employee…</option>
            {people
              .filter((p) => p.is_active)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.full_name}
                </option>
              ))}
          </select>
        </label>
        <label className="setting">
          Handed over
          <input
            type="datetime-local"
            value={assignedAt}
            onChange={(e) => setAssignedAt(e.target.value)}
          />
          <span className="setting-hint">
            Leave blank for now. Set it to record a handover that physically happened earlier —
            it cannot be dated in the future.
          </span>
        </label>
        <label className="setting" style={{ gridColumn: '1 / -1' }}>
          Condition at handover
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="Charger and sleeve included, screen unmarked…"
          />
          <span className="setting-hint">
            The holder can read this for as long as they hold the asset — it is what they will be
            asked about when it comes back.
          </span>
        </label>
      </div>

      <div className="btn-group" style={{ marginTop: 14 }}>
        <button className="btn btn-primary" disabled={busy || !userId}>
          {busy ? 'Assigning…' : 'Assign asset'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/**
 * Recording a return, with the resulting status as an explicit decision.
 *
 * "Returned" and "available again" are two different events. A laptop handed
 * back with a cracked screen belongs in `under_repair`, and the API takes
 * `resulting_status` for exactly that reason — but it defaults to `available`,
 * and a default is the failure this form exists to prevent: the admin clicks
 * through, the broken machine lands back in the pool, and the next joiner gets
 * it. So nothing is pre-selected and the submit stays disabled until somebody
 * says which of the three happened.
 */
function ReturnForm({
  asset,
  onCancel,
  onDone,
}: {
  asset: Asset
  onCancel: () => void
  onDone: () => void
}) {
  const [resulting, setResulting] = useState<string | null>(null)
  const [returnedAt, setReturnedAt] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const choices: Array<{ value: string; label: string; hint: string }> = [
    {
      value: 'available',
      label: 'Back in the pool',
      hint: 'Came back working. Can be issued to the next person.',
    },
    {
      value: 'under_repair',
      label: 'Needs repair',
      hint: 'Damaged or faulty. Cannot be issued until somebody fixes it and marks it available.',
    },
    {
      value: 'retired',
      label: 'Written off',
      hint: 'End of life. Stays on the register, keeps its history, is never issued again.',
    },
  ]

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!resulting) return
    setBusy(true)
    setError(null)
    try {
      await api.post(`/assets/${asset.id}/return`, {
        returned_at: localToISO(returnedAt),
        returned_condition_note: note.trim() || null,
        resulting_status: resulting,
      })
      onDone()
    } catch (err) {
      setError(errorText(err, `Could not record the return of ${asset.asset_tag}`))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="as-panel" onSubmit={submit}>
      <div className="as-panel-head">
        <div>
          <h2 className="as-panel-title">
            Record the return of {asset.asset_tag}
            {asset.current_holder_name ? ` from ${asset.current_holder_name}` : ''}
          </h2>
          <p className="as-panel-sub">
            Closes the custody row. Getting it back and it being available again are two
            different things, so say which one this was.
          </p>
        </div>
      </div>
      {error && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="as-choices" role="radiogroup" aria-label="What happens to the asset now">
        {choices.map((choice) => (
          <label key={choice.value} className="as-choice">
            <input
              type="radio"
              name="resulting_status"
              value={choice.value}
              checked={resulting === choice.value}
              onChange={() => setResulting(choice.value)}
            />
            <span>
              <span className="as-choice-label">{choice.label}</span>
              <span className="as-choice-hint">{choice.hint}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="settings-grid" style={{ marginTop: 14 }}>
        <label className="setting">
          Handed back
          <input
            type="datetime-local"
            value={returnedAt}
            onChange={(e) => setReturnedAt(e.target.value)}
          />
          <span className="setting-hint">
            Leave blank for now. It cannot be in the future, or before the handover.
          </span>
        </label>
        <label className="setting" style={{ gridColumn: '1 / -1' }}>
          Condition on return
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="Dent on the lid, charger missing…"
          />
          <span className="setting-hint">
            Kept on the ledger for the register. This note is written about the employee, so they
            never see it.
          </span>
        </label>
      </div>

      <div className="btn-group" style={{ marginTop: 14 }}>
        <button className="btn btn-primary" disabled={busy || !resulting}>
          {busy ? 'Recording…' : 'Record return'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {!resulting && (
        <p className="as-panel-sub" style={{ marginTop: 8 }}>
          Choose what happens to the asset to continue.
        </p>
      )}
    </form>
  )
}

/* --------------------------------------------------------------- ledger --- */

function CustodyLedger({ path, empty }: { path: string; empty?: ReactNode }) {
  const history = useQuery<AssetAssignment[]>(path, () => api.get<AssetAssignment[]>(path))

  if (history.loading) return <Loading />
  if (history.error) return <ErrorNote>{errorText(history.error, 'Could not load the ledger')}</ErrorNote>
  const rows = history.data ?? []
  if (rows.length === 0) {
    return <Empty>{empty ?? 'Never issued to anybody. The ledger starts at the first handover.'}</Empty>
  }

  return (
    <div className="as-ledger">
      {rows.map((row) => (
        <div className="as-entry" key={row.id}>
          <span className={`as-dot${row.is_open ? ' as-dot-open' : ''}`} aria-hidden="true" />
          <div>
            <div className="as-entry-head">
              <span className="as-entry-who">{row.user_name ?? 'Former employee'}</span>
              {row.asset_tag && <span className="as-cat">{row.asset_tag}</span>}
              {row.is_open && <span className="as-pill as-assigned">Holding now</span>}
            </div>
            <div className="as-entry-when">
              {dateTime(row.assigned_at)} → {row.returned_at ? dateTime(row.returned_at) : 'open'}
            </div>
            {row.assigned_condition_note && (
              <div className="as-note">
                <span className="as-note-label">At handover</span>
                {row.assigned_condition_note}
              </div>
            )}
            {row.returned_condition_note && (
              <div className="as-note">
                <span className="as-note-label">On return</span>
                {row.returned_condition_note}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

/** Everything one person has ever held — the "what is this leaver still
 *  carrying" question, answered from the same ledger. */
function HolderHistory({ userId, name }: { userId: string; name: string }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="card" style={{ marginBottom: 14 }}>
      <div className="card-head">
        <h2 className="card-title">Everything {name} has held</h2>
        <div className="card-tools">
          <button className="btn btn-sm" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>
      {open && (
        <CustodyLedger
          path={`/assets/users/${userId}/history`}
          empty={`${name} has never been issued an asset.`}
        />
      )}
    </section>
  )
}
