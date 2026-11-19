/* Branch Master — the company's sites: head office, regional offices, plants.
 *
 * Laid out like the Department and Designation masters: one card, search and
 * the add button in its head, edit / delete as icons on the row. The address is
 * picked from the Geography master. A location (the geofenced office Attendance
 * uses) can belong to a branch; deleting a branch leaves its locations standing.
 */

import { useMemo, useState, type ReactNode } from 'react'
import '../../styles/crm.css'
import '../../styles/org.css'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/useQuery'
import { canAdminister, useAuth } from '../../lib/auth'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconBuilding, IconEdit, IconPlus, IconSearch, IconTrash } from '../../components/Icons'
import { Dialog, Field } from '../crm/parts'
import { ColumnSettings, useColumns, type ColumnDef } from '../../components/ViewSettings'
import { NameSelect, placeOptions, useGeoMasters, type Place } from './orgKit'

export interface Branch {
  id: string
  name: string
  code: string | null
  address: string | null
  country: string | null
  state: string | null
  district: string | null
  city: string | null
  pincode: string | null
  phone: string | null
  email: string | null
  is_head_office: boolean
  is_active: boolean
  location_count: number
}

type BranchColumn = ColumnDef & { td: (row: Branch) => ReactNode; className?: string; thClass?: string }
const dash = <span className="crm-muted">—</span>
const BRANCH_COLUMNS: BranchColumn[] = [
  { key: 'branch', label: 'Branch', locked: true, td: (b) => (
    <>
      <span className="crm-strong">{b.name}</span>
      {b.is_head_office && <span className="crm-state crm-state-good" style={{ marginLeft: 8 }}>Head office</span>}
      {b.address && <div className="crm-sub">{b.address}</div>}
    </>
  ) },
  { key: 'code', label: 'Code', className: 'crm-muted', td: (b) => b.code ?? dash },
  { key: 'place', label: 'City', td: (b) => [b.city, b.state].filter(Boolean).join(', ') || dash },
  { key: 'phone', label: 'Phone', td: (b) => b.phone ?? dash },
  { key: 'locations', label: 'Locations', className: 'crm-num dm-count', thClass: 'crm-num', td: (b) => b.location_count },
  { key: 'status', label: 'Status', td: (b) => (
    <span className={`crm-state ${b.is_active ? 'crm-state-good' : 'crm-state-idle'}`}>{b.is_active ? 'Active' : 'Inactive'}</span>
  ) },
  { key: 'email', label: 'Email', initial: false, td: (b) => b.email ?? dash },
  { key: 'pincode', label: 'Pincode', initial: false, td: (b) => b.pincode ?? dash },
  { key: 'district', label: 'District', initial: false, td: (b) => b.district ?? dash },
  { key: 'country', label: 'Country', initial: false, td: (b) => b.country ?? dash },
]

/** `readOnly` shows the list without add, edit or delete — as on HR Settings, where the
 *  masters are only listed; the Master menu is where they are kept. */
export default function BranchMaster({ readOnly = false }: { readOnly?: boolean }) {
  const columns = useColumns('branches', BRANCH_COLUMNS)
  const { user } = useAuth()
  const isAdmin = canAdminister(user) && !readOnly
  const branches = useQuery<Branch[]>('branches', () => api.get<Branch[]>('/org/branches'))
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<Branch | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (branches.data ?? []).filter((b) =>
      !needle || [b.name, b.code, b.city, b.state].some((v) => (v ?? '').toLowerCase().includes(needle)))
  }, [branches.data, q])

  async function remove(branch: Branch) {
    const sites = branch.location_count ? `\n\nIts ${branch.location_count} location${branch.location_count === 1 ? '' : 's'} stay, no longer under a branch.` : ''
    if (!window.confirm(`Delete “${branch.name}”?${sites}`)) return
    setError(null)
    try {
      await api.del(`/org/branches/${branch.id}`)
      branches.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That branch could not be deleted')
    }
  }

  const total = branches.data?.length ?? 0

  return (
    <div className="crm">
      <section className="card dm-card">
        <div className="dm-head">
          <span className="dm-tile dm-tile-violet"><IconBuilding size={18} /></span>
          <div className="dm-heading">
            <h1 className="dm-title">Branch Master</h1>
            <p className="crm-sub">The company’s sites. Locations can belong to a branch.</p>
          </div>
          <div className="dm-tools">
            <div className="crm-search dm-search">
              <IconSearch size={15} />
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)}
                     placeholder="Search branches…" aria-label="Search branches" />
            </div>
            <span className="crm-sub crm-nowrap">{total} branch{total === 1 ? '' : 'es'}</span>
            <ColumnSettings defs={BRANCH_COLUMNS} order={columns.pref.order} hidden={columns.pref.hidden}
                            onSave={columns.save} onReset={columns.reset} />
            {isAdmin && (
              <button className="btn btn-primary" onClick={() => setEditing('new')}>
                <IconPlus size={15} /> Add Branch
              </button>
            )}
          </div>
        </div>

        {(error || branches.error) && <div className="dm-error"><ErrorNote>{error ?? branches.error}</ErrorNote></div>}

        {branches.loading && !branches.data ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState
            title={q ? 'No branch matches that search' : 'No branches yet'}
            body={q ? 'Try a different name, city or code.' : 'Add the company’s offices and plants, head office first.'}
            action={isAdmin && !q ? <button className="btn btn-primary" onClick={() => setEditing('new')}>Add the first one</button> : undefined}
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {(columns.visible as BranchColumn[]).map((col) => <th key={col.key} className={col.thClass}>{col.label}</th>)}
                  {isAdmin && <th style={{ textAlign: 'right' }}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.id}>
                    {(columns.visible as BranchColumn[]).map((col) => <td key={col.key} className={col.className}>{col.td(b)}</td>)}
                    {isAdmin && (
                      <td>
                        <div className="crm-row-actions">
                          <button className="crm-icon-btn" onClick={() => setEditing(b)} aria-label={`Edit ${b.name}`} title="Edit">
                            <IconEdit size={16} />
                          </button>
                          <button className="crm-icon-btn dm-delete" onClick={() => remove(b)} aria-label={`Delete ${b.name}`} title="Delete">
                            <IconTrash size={16} />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing && (
        <BranchDialog
          branch={editing === 'new' ? null : editing}
          firstBranch={total === 0}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); branches.reload() }}
        />
      )}
    </div>
  )
}

const EMAIL = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]{2,}$/

function BranchDialog({
  branch, firstBranch, onClose, onSaved,
}: {
  branch: Branch | null
  firstBranch: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const geo = useGeoMasters()
  const [form, setForm] = useState({
    name: branch?.name ?? '',
    code: branch?.code ?? '',
    address: branch?.address ?? '',
    country: branch?.country ?? 'India',
    state: branch?.state ?? '',
    district: branch?.district ?? '',
    city: branch?.city ?? '',
    pincode: branch?.pincode ?? '',
    phone: branch?.phone ?? '',
    email: branch?.email ?? '',
    // The first branch a company adds is, nearly always, its head office.
    is_head_office: branch?.is_head_office ?? firstBranch,
    is_active: branch?.is_active ?? true,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))
  const place: Place = { country: form.country, state: form.state, district: form.district, city: form.city }
  const opt = placeOptions(geo, place)
  const emailBad = form.email.trim() !== '' && !EMAIL.test(form.email.trim())

  async function save() {
    if (!form.name.trim()) return setError('Give the branch a name.')
    if (emailBad) return setError('Enter a valid email address.')
    setBusy(true)
    setError(null)
    const body = { ...form, name: form.name.trim() }
    try {
      if (branch) await api.patch(`/org/branches/${branch.id}`, body)
      else await api.post('/org/branches', body)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That branch could not be saved')
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={branch ? `Edit ${branch.name}` : 'Add Branch'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !form.name.trim()}>
            {busy ? 'Saving…' : branch ? 'Save' : 'Add'}
          </button>
        </>
      }
    >
      <div className="crm-form">
        {error && <div className="crm-form-wide"><ErrorNote>{error}</ErrorNote></div>}
        <Field label="Branch name" required>
          <input value={form.name} placeholder="Pune Office" autoFocus onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Short code">
          <input value={form.code} maxLength={12} placeholder="PNQ" onChange={(e) => set({ code: e.target.value.toUpperCase() })} />
        </Field>
        <Field label="Address" wide>
          <input value={form.address} placeholder="Street, building, area" onChange={(e) => set({ address: e.target.value })} />
        </Field>

        <div className="crm-form-wide om-geo">
          <NameSelect label="Country" value={form.country} placeholder="— Select —"
                      options={geo.countries.map((c) => c.name)}
                      onChange={(v) => set({ country: v, state: '', district: '', city: '' })} />
          <NameSelect label="State" value={form.state} placeholder="— Select —" options={opt.states.map((s) => s.name)}
                      onChange={(v) => set({ state: v, district: '', city: '' })} />
          <NameSelect label="District" value={form.district} disabled={!opt.state}
                      placeholder={opt.state ? '— Select —' : 'Pick a state first'} options={opt.districts.map((d) => d.name)}
                      onChange={(v) => set({ district: v, city: '' })} />
          <NameSelect label="City" value={form.city} disabled={!opt.state}
                      placeholder={opt.state ? '— Select —' : 'Pick a state first'} options={opt.cities.map((c) => c.name)}
                      onChange={(v) => set({ city: v })} />
          <Field label="Pincode">
            <input value={form.pincode} maxLength={12} inputMode="numeric" onChange={(e) => set({ pincode: e.target.value })} />
          </Field>
        </div>

        <Field label="Phone">
          <input value={form.phone} inputMode="tel" onChange={(e) => set({ phone: e.target.value })} />
        </Field>
        <Field label="Email" hint={emailBad ? 'Enter a valid email address' : undefined}>
          <input type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} />
        </Field>

        <div className="crm-field crm-form-wide om-checks">
          <label className="crm-check">
            <input type="checkbox" checked={form.is_head_office} onChange={(e) => set({ is_head_office: e.target.checked })} />
            This is the head office
          </label>
          <label className="crm-check">
            <input type="checkbox" checked={form.is_active} onChange={(e) => set({ is_active: e.target.checked })} />
            Offered when adding an employee
          </label>
        </div>
      </div>
    </Dialog>
  )
}
