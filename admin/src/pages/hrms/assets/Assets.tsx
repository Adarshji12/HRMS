import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import '../../../styles/assets.css'
import { api, ApiError } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { canAdminister, useAuth } from '../../../lib/auth'
import { dateTime } from '../../../lib/format'
import type { User } from '../../../lib/types'
import { Empty, EmptyState, ErrorNote, Loading, StatTile } from '../../../components/ui'
import { IconCard, IconReturn } from '../../../components/Icons'

/* ---------------------------------------------------------------- types ---
   Page-local, as Timesheets.tsx does. These mirror app/schemas/assets.py
   exactly; `lib/types.ts` is lead-owned and does not carry them. */

export interface Asset {
  id: string
  asset_tag: string
  category: string
  serial_number: string | null
  purchase_date: string | null
  status: string
  created_at: string
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

export const CATEGORY_LABEL: Record<string, string> = {
  laptop: 'Laptop',
  monitor: 'Monitor',
  sim: 'SIM',
  id_card: 'ID card',
  other: 'Other',
}

export const ASSET_STATUS_LABEL: Record<string, string> = {
  available: 'Available',
  assigned: 'Issued',
  under_repair: 'Under repair',
  retired: 'Retired',
}

/** The three statuses an asset can be *put into*. `assigned` is absent on
 *  purpose: an asset becomes issued by opening a custody row and no other way,
 *  which is what stops the register and the ledger telling two stories. */
const SETTABLE_STATUSES = ['available', 'under_repair', 'retired'] as const

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

export function AssetStatusPill({ value }: { value: string }) {
  return (
    <span className={`as-pill as-${value}`}>
      <span className="as-pill-dot" style={{ background: 'currentColor' }} />
      {ASSET_STATUS_LABEL[value] ?? value}
    </span>
  )
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

  const assets = useQuery<Asset[]>('assets', () => api.get<Asset[]>('/assets'), {
    enabled: allowed,
  })
  const people = useQuery<User[]>('employees', () => api.get<User[]>('/admin/employees'), {
    enabled: allowed,
  })

  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Asset | null>(null)
  const [assigning, setAssigning] = useState<Asset | null>(null)
  const [returning, setReturning] = useState<Asset | null>(null)
  const [ledgerFor, setLedgerFor] = useState<Asset | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)

  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [category, setCategory] = useState('')
  const [holderId, setHolderId] = useState('')

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
      if (!needle) return true
      return (
        a.asset_tag.toLowerCase().includes(needle) ||
        (a.serial_number ?? '').toLowerCase().includes(needle) ||
        (a.current_holder_name ?? '').toLowerCase().includes(needle)
      )
    })
  }, [assets.data, q, status, category, holderId])

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

  const counts = useMemo(() => {
    const all = assets.data ?? []
    const by = (s: string) => all.filter((a) => a.status === s).length
    return {
      total: all.length,
      available: by('available'),
      assigned: by('assigned'),
      repair: by('under_repair'),
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
            body="Who is holding which machine, and what the company paid for it, is administrator-only. Ask an administrator if you need a device issued, or open My assets to see what you are holding."
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

  const filtered = q !== '' || status !== '' || category !== '' || holderId !== ''

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Assets</h1>
          <p className="page-sub">
            The register, and the custody ledger behind it.
          </p>
        </div>
        <div className="head-actions">
          <button
            className="btn btn-primary"
            onClick={() => {
              setEditing(null)
              setAdding((v) => !v)
            }}
          >
            {adding ? 'Cancel' : 'Book in an asset'}
          </button>
        </div>
      </div>

      {(assets.data ?? []).length > 0 && (
        <div className="grid grid-tiles" style={{ marginBottom: 14 }}>
          <StatTile label="On the register" value={String(counts.total)} />
          <StatTile label="Available" value={String(counts.available)} accent="var(--status-good)" />
          <StatTile
            label="Issued"
            value={String(counts.assigned)}
            meta={counts.assigned ? 'custody open' : undefined}
            accent="var(--brand)"
          />
          <StatTile
            label="Under repair"
            value={String(counts.repair)}
            meta={counts.repair ? 'cannot be issued' : undefined}
            accent={counts.repair ? 'var(--status-warn)' : undefined}
          />
        </div>
      )}

      {(adding || editing) && (
        <AssetForm
          key={editing?.id ?? 'new'}
          asset={editing}
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

      <div className="filter-row">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search tag, serial or holder…"
          aria-label="Search the register"
          style={{ minWidth: 220 }}
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
          {Object.entries(CATEGORY_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select value={holderId} onChange={(e) => setHolderId(e.target.value)} aria-label="Holder">
          <option value="">Anyone holding</option>
          {holders.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
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
              body="Clear the filters, or book the asset in if it has never been recorded."
            />
          ) : (
            <EmptyState
              icon={<IconCard size={22} />}
              title="No assets on the register yet"
              body="Book in the laptops, monitors, SIMs and ID cards the company owns. Once an asset exists you can issue it to somebody, and the ledger will answer “who had this in March” for as long as the asset does."
              action={
                <button className="btn btn-primary" onClick={() => setAdding(true)}>
                  Book in the first asset
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
                  <th>Held by</th>
                  <th>Since</th>
                  <th style={{ textAlign: 'right' }}>Custody</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((asset) => (
                  <tr key={asset.id} className={asset.current_assignment_id ? 'as-row-open' : undefined}>
                    <td>
                      <div className="as-tag">{asset.asset_tag}</div>
                      {asset.serial_number && <div className="as-serial">{asset.serial_number}</div>}
                    </td>
                    <td className="as-cat">{CATEGORY_LABEL[asset.category] ?? asset.category}</td>
                    <td>
                      <AssetStatusPill value={asset.status} />
                    </td>
                    <td>
                      {asset.current_holder_name ?? <span className="as-muted">nobody</span>}
                    </td>
                    <td className="as-when">
                      {asset.assigned_at ? dateTime(asset.assigned_at) : '—'}
                    </td>
                    <td>
                      <div className="as-actions">
                        <AssetRowActions
                          asset={asset}
                          onAssign={() => {
                            setRowError(null)
                            setAssigning(asset)
                            setReturning(null)
                            scrollToPanel()
                          }}
                          onReturn={() => {
                            setRowError(null)
                            setReturning(asset)
                            setAssigning(null)
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

      {ledgerFor && (
        <section className="card" style={{ marginTop: 14 }}>
          <div className="card-head">
            <h2 className="card-title">Custody history — {ledgerFor.asset_tag}</h2>
            <div className="card-tools">
              <button className="btn btn-sm" onClick={() => setLedgerFor(null)}>
                Close
              </button>
            </div>
          </div>
          <CustodyLedger path={`/assets/${ledgerFor.id}/history`} />
        </section>
      )}
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
  onLedger,
  onEdit,
  onDelete,
}: {
  asset: Asset
  onAssign: () => void
  onReturn: () => void
  onLedger: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const held = asset.current_assignment_id !== null
  return (
    <>
      {held ? (
        <button className="btn btn-sm" onClick={onReturn}>
          <IconReturn size={13} /> Record return
        </button>
      ) : asset.status === 'available' ? (
        <button className="btn btn-sm btn-primary" onClick={onAssign}>
          Issue
        </button>
      ) : (
        /* under_repair and retired are not issuable, and saying so beats
           offering a button the server will refuse. */
        <span className="as-muted">
          {asset.status === 'under_repair' ? 'In the repair queue' : 'Written off'}
        </span>
      )}
      <button className="btn btn-sm" onClick={onLedger}>
        History
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
  onCancel,
  onDone,
}: {
  asset: Asset | null
  onCancel: () => void
  onDone: () => void
}) {
  const held = asset?.current_assignment_id != null
  const [form, setForm] = useState({
    asset_tag: asset?.asset_tag ?? '',
    category: asset?.category ?? 'laptop',
    serial_number: asset?.serial_number ?? '',
    purchase_date: asset?.purchase_date ?? '',
    status: asset && asset.status !== 'assigned' ? asset.status : 'available',
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const body = {
      asset_tag: form.asset_tag.trim(),
      category: form.category,
      serial_number: form.serial_number.trim() || null,
      purchase_date: form.purchase_date || null,
      status: form.status,
    }
    try {
      if (asset) await api.patch(`/assets/${asset.id}`, body)
      else await api.post('/assets', body)
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
        <h2 className="card-title">{asset ? `Edit ${asset.asset_tag}` : 'Book in an asset'}</h2>
      </div>
      {error && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="settings-grid">
        <label className="setting">
          Asset tag
          <input
            value={form.asset_tag}
            onChange={(e) => setForm({ ...form, asset_tag: e.target.value })}
            placeholder="LAP-0142"
            required
            autoFocus
          />
          <span className="setting-hint">The sticker on the machine. Unique per company.</span>
        </label>
        <label className="setting">
          Category
          <select
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
          >
            {Object.entries(CATEGORY_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="setting">
          Serial number
          <input
            value={form.serial_number}
            onChange={(e) => setForm({ ...form, serial_number: e.target.value })}
          />
        </label>
        <label className="setting">
          Purchase date
          <input
            type="date"
            value={form.purchase_date}
            onChange={(e) => setForm({ ...form, purchase_date: e.target.value })}
          />
          <span className="setting-hint">Procurement only — the holder never sees it.</span>
        </label>
        <label className="setting">
          Status
          <select
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value })}
            disabled={held}
          >
            {SETTABLE_STATUSES.map((value) => (
              <option key={value} value={value}>
                {ASSET_STATUS_LABEL[value]}
              </option>
            ))}
          </select>
          <span className="setting-hint">
            {held
              ? 'Issued, so the ledger owns the status. Record the return to move it to repair or retirement.'
              : '“Issued” is not in this list: an asset becomes issued by handing it to somebody.'}
          </span>
        </label>
      </div>

      <div className="btn-group" style={{ marginTop: 14 }}>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : asset ? 'Save changes' : 'Book it in'}
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
      setError(errorText(err, `Could not issue ${asset.asset_tag}`))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="as-panel" onSubmit={submit}>
      <div className="as-panel-head">
        <div>
          <h2 className="as-panel-title">Issue {asset.asset_tag}</h2>
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
          Issue to
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
          {busy ? 'Issuing…' : 'Issue asset'}
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
