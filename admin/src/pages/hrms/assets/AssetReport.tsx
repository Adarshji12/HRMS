import { useMemo, useState, type FormEvent } from 'react'
import '../../../styles/assets.css'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { canAdminister, useAuth } from '../../../lib/auth'
import { dateTime } from '../../../lib/format'
import type { User } from '../../../lib/types'
import { EmptyState, ErrorNote, Loading } from '../../../components/ui'
import { IconCard, IconDownload } from '../../../components/Icons'
import {
  AssetStatusPill,
  RenewalPill,
  categoryLabel,
  day,
  downloadCsv,
  errorText,
  rupees,
  todayISODate,
  type Asset,
} from './assetLib'
import { permits } from './Assets'

type View = 'employee' | 'category' | 'stock'

interface Group {
  userId: string
  name: string
  email: string | null
  assets: Asset[]
  value: number
}

export default function AssetReport() {
  const { user } = useAuth()
  const allowed = canAdminister(user) && permits(user, 'can_manage_assets')
  const assets = useQuery<Asset[]>('assets', () => api.get<Asset[]>('/assets'), { enabled: allowed })
  const people = useQuery<User[]>('employees', () => api.get<User[]>('/admin/employees'), { enabled: allowed })

  const [view, setView] = useState<View>('employee')
  const [q, setQ] = useState('')
  const [showEmpty, setShowEmpty] = useState(false)
  const [assignFor, setAssignFor] = useState<string | null>(null)

  const all = useMemo(() => assets.data ?? [], [assets.data])
  const available = useMemo(() => all.filter((a) => a.status === 'available'), [all])

  /* One group per person holding something, plus — when asked — every active
     employee holding nothing, which is the "who still needs a laptop" list. */
  const groups = useMemo(() => {
    const map = new Map<string, Group>()
    for (const a of all) {
      if (!a.current_holder_id) continue
      const g = map.get(a.current_holder_id) ?? {
        userId: a.current_holder_id,
        name: a.current_holder_name ?? 'Unknown',
        email: null,
        assets: [],
        value: 0,
      }
      g.assets.push(a)
      g.value += a.purchase_cost_paise ?? 0
      map.set(a.current_holder_id, g)
    }
    for (const p of people.data ?? []) {
      const g = map.get(p.id)
      if (g) g.email = p.email
      else if (showEmpty && p.is_active) {
        map.set(p.id, { userId: p.id, name: p.full_name, email: p.email, assets: [], value: 0 })
      }
    }
    const needle = q.trim().toLowerCase()
    return [...map.values()]
      .filter(
        (g) =>
          !needle ||
          g.name.toLowerCase().includes(needle) ||
          (g.email ?? '').toLowerCase().includes(needle) ||
          g.assets.some((a) => `${a.asset_tag} ${a.name ?? ''}`.toLowerCase().includes(needle)),
      )
      .sort((a, b) => b.assets.length - a.assets.length || a.name.localeCompare(b.name))
  }, [all, people.data, showEmpty, q])

  const byCategory = useMemo(() => {
    const map = new Map<string, { total: number; assigned: number; available: number; repair: number; retired: number; value: number }>()
    for (const a of all) {
      const row = map.get(a.category) ?? { total: 0, assigned: 0, available: 0, repair: 0, retired: 0, value: 0 }
      row.total += 1
      if (a.status === 'assigned') row.assigned += 1
      else if (a.status === 'available') row.available += 1
      else if (a.status === 'under_repair') row.repair += 1
      else if (a.status === 'retired') row.retired += 1
      if (a.status !== 'retired') row.value += a.purchase_cost_paise ?? 0
      map.set(a.category, row)
    }
    return [...map.entries()].sort((a, b) => b[1].total - a[1].total)
  }, [all])

  if (!allowed) {
    return (
      <section className="card">
        <EmptyState icon={<IconCard size={22} />} title="Asset reports are administrator-only" body="" />
      </section>
    )
  }
  if (assets.error) return <ErrorNote>{errorText(assets.error, 'Could not load the report')}</ErrorNote>
  if (assets.loading && !assets.data) return <Loading />

  const assignedCount = all.filter((a) => a.current_holder_id).length
  const holderCount = groups.filter((g) => g.assets.length > 0).length

  function exportCsv() {
    if (view === 'employee') {
      const rows: Array<Array<string | number | null>> = []
      for (const g of groups) {
        if (g.assets.length === 0) rows.push([g.name, g.email, 0, null, null, null, null, null])
        for (const a of g.assets) {
          rows.push([
            g.name, g.email, g.assets.length, a.asset_tag, a.name, categoryLabel(a.category),
            a.serial_number, a.assigned_at ? a.assigned_at.slice(0, 10) : null,
          ])
        }
      }
      downloadCsv(`asset-assignments-${todayISODate()}.csv`,
        ['Employee', 'Email', 'Assets held', 'Asset tag', 'Asset name', 'Category', 'Serial', 'Assigned on'], rows)
    } else if (view === 'category') {
      downloadCsv(`assets-by-category-${todayISODate()}.csv`,
        ['Category', 'Total', 'Assigned', 'Available', 'Under repair', 'Retired', 'Value (₹)'],
        byCategory.map(([k, r]) => [categoryLabel(k), r.total, r.assigned, r.available, r.repair, r.retired, r.value / 100]))
    } else {
      downloadCsv(`available-assets-${todayISODate()}.csv`,
        ['Asset tag', 'Name', 'Category', 'Serial', 'Location', 'Purchase date', 'Cost (₹)'],
        available.map((a) => [a.asset_tag, a.name, categoryLabel(a.category), a.serial_number, a.location,
          a.purchase_date, a.purchase_cost_paise == null ? null : a.purchase_cost_paise / 100]))
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Assignment report</h1>
          <p className="page-sub">
            {assignedCount} of {all.length} assets assigned to {holderCount}{' '}
            {holderCount === 1 ? 'person' : 'people'} · {available.length} available to assign
          </p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => window.print()}>
            Print
          </button>
          <button className="btn btn-primary" onClick={exportCsv}>
            <IconDownload size={14} /> Export CSV
          </button>
        </div>
      </div>

      <div className="filter-row">
        <div className="btn-group">
          <button className={`btn btn-sm${view === 'employee' ? ' btn-primary' : ''}`} onClick={() => setView('employee')}>
            By employee
          </button>
          <button className={`btn btn-sm${view === 'category' ? ' btn-primary' : ''}`} onClick={() => setView('category')}>
            By category
          </button>
          <button className={`btn btn-sm${view === 'stock' ? ' btn-primary' : ''}`} onClick={() => setView('stock')}>
            Available stock ({available.length})
          </button>
        </div>
        {view === 'employee' && (
          <>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search employee or asset…"
              style={{ minWidth: 220 }}
            />
            <label className="as-check">
              <input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} />
              Include employees with no assets
            </label>
          </>
        )}
      </div>

      {view === 'employee' &&
        (groups.length === 0 ? (
          <section className="card">
            <EmptyState
              icon={<IconCard size={22} />}
              title="Nobody is holding an asset"
              body="Tick “Include employees with no assets” to assign one from here."
            />
          </section>
        ) : (
          groups.map((g) => (
            <section className="card" key={g.userId} style={{ marginBottom: 12 }}>
              <div className="card-head as-group-head">
                <div>
                  <h2 className="card-title">{g.name}</h2>
                  <div className="as-group-meta">
                    {g.email ? `${g.email} · ` : ''}
                    {g.assets.length} {g.assets.length === 1 ? 'asset' : 'assets'}
                    {g.value ? ` · ${rupees(g.value)}` : ''}
                  </div>
                </div>
                <div className="card-tools as-noprint">
                  <button
                    className="btn btn-sm"
                    disabled={available.length === 0}
                    title={available.length === 0 ? 'No available asset to assign' : undefined}
                    onClick={() => setAssignFor((cur) => (cur === g.userId ? null : g.userId))}
                  >
                    {assignFor === g.userId ? 'Cancel' : '+ Assign asset'}
                  </button>
                </div>
              </div>
              {assignFor === g.userId && (
                <QuickAssign
                  userId={g.userId}
                  name={g.name}
                  available={available}
                  onDone={() => {
                    setAssignFor(null)
                    assets.reload()
                  }}
                />
              )}
              {g.assets.length === 0 ? (
                <p className="as-muted" style={{ fontSize: 13, margin: 0 }}>No assets assigned.</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Asset</th>
                        <th>Category</th>
                        <th>Serial</th>
                        <th>Assigned on</th>
                        <th>Renewal</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.assets.map((a) => (
                        <tr key={a.id}>
                          <td>
                            <div className="as-tag">{a.asset_tag}</div>
                            {a.name && <div className="as-name">{a.name}</div>}
                          </td>
                          <td className="as-cat">{categoryLabel(a.category)}</td>
                          <td>{a.serial_number ?? <span className="as-muted">—</span>}</td>
                          <td className="as-when">{a.assigned_at ? dateTime(a.assigned_at) : '—'}</td>
                          <td>
                            <RenewalPill asset={a} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ))
        ))}

      {view === 'category' && (
        <section className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Category</th>
                  <th style={{ textAlign: 'right' }}>Total</th>
                  <th style={{ textAlign: 'right' }}>Assigned</th>
                  <th style={{ textAlign: 'right' }}>Available</th>
                  <th style={{ textAlign: 'right' }}>Under repair</th>
                  <th style={{ textAlign: 'right' }}>Retired</th>
                  <th style={{ textAlign: 'right' }}>Value</th>
                </tr>
              </thead>
              <tbody>
                {byCategory.map(([k, r]) => (
                  <tr key={k}>
                    <td>{categoryLabel(k)}</td>
                    <td style={{ textAlign: 'right' }}>{r.total}</td>
                    <td style={{ textAlign: 'right' }}>{r.assigned}</td>
                    <td style={{ textAlign: 'right' }}>{r.available}</td>
                    <td style={{ textAlign: 'right' }}>{r.repair}</td>
                    <td style={{ textAlign: 'right' }}>{r.retired}</td>
                    <td style={{ textAlign: 'right' }}>{rupees(r.value)}</td>
                  </tr>
                ))}
                <tr>
                  <td><b>Total</b></td>
                  <td style={{ textAlign: 'right' }}><b>{all.length}</b></td>
                  <td style={{ textAlign: 'right' }}><b>{byCategory.reduce((s, [, r]) => s + r.assigned, 0)}</b></td>
                  <td style={{ textAlign: 'right' }}><b>{byCategory.reduce((s, [, r]) => s + r.available, 0)}</b></td>
                  <td style={{ textAlign: 'right' }}><b>{byCategory.reduce((s, [, r]) => s + r.repair, 0)}</b></td>
                  <td style={{ textAlign: 'right' }}><b>{byCategory.reduce((s, [, r]) => s + r.retired, 0)}</b></td>
                  <td style={{ textAlign: 'right' }}><b>{rupees(byCategory.reduce((s, [, r]) => s + r.value, 0))}</b></td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      {view === 'stock' && (
        <section className="card">
          {available.length === 0 ? (
            <EmptyState icon={<IconCard size={22} />} title="No available assets" body="Everything is assigned, under repair or retired." />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Category</th>
                    <th>Serial</th>
                    <th>Location</th>
                    <th>Purchased</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {available.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <div className="as-tag">{a.asset_tag}</div>
                        {a.name && <div className="as-name">{a.name}</div>}
                      </td>
                      <td className="as-cat">{categoryLabel(a.category)}</td>
                      <td>{a.serial_number ?? <span className="as-muted">—</span>}</td>
                      <td>{a.location ?? <span className="as-muted">—</span>}</td>
                      <td className="as-when">{day(a.purchase_date)}</td>
                      <td>
                        <AssetStatusPill value={a.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  )
}

/** Assign one of the available assets to this employee, from the report. */
function QuickAssign({
  userId,
  name,
  available,
  onDone,
}: {
  userId: string
  name: string
  available: Asset[]
  onDone: () => void
}) {
  const [assetId, setAssetId] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post('/assets/assign', {
        asset_id: assetId,
        user_id: userId,
        assigned_condition_note: note.trim() || null,
      })
      onDone()
    } catch (err) {
      setError(errorText(err, `Could not assign to ${name}`))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="as-panel as-noprint" onSubmit={submit} style={{ marginBottom: 12 }}>
      {error && (
        <div style={{ marginBottom: 10 }}>
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      <div className="settings-grid">
        <label className="setting">
          Asset to assign to {name}
          <select value={assetId} onChange={(e) => setAssetId(e.target.value)} required>
            <option value="">Choose an available asset…</option>
            {available.map((a) => (
              <option key={a.id} value={a.id}>
                {a.asset_tag}
                {a.name ? ` — ${a.name}` : ''} ({categoryLabel(a.category)})
              </option>
            ))}
          </select>
        </label>
        <label className="setting">
          Condition at handover
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="Charger included…" />
        </label>
      </div>
      <div className="btn-group" style={{ marginTop: 10 }}>
        <button className="btn btn-primary" disabled={busy || !assetId}>
          {busy ? 'Assigning…' : 'Assign'}
        </button>
      </div>
    </form>
  )
}
