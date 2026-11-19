/* Location Master — the geofenced sites Attendance checks punches against.
 *
 * The same records as Attendance → Locations, listed here so the company's
 * structure is set up in one place: a location belongs to a branch and has an
 * address picked from the Geography master. The geofence (latitude, longitude,
 * radius) is only used once attendance location checks are switched on, so it is
 * optional here; a site with no coordinates is listed but verifies nobody.
 */

import { useMemo, useState, type ReactNode } from 'react'
import '../../styles/crm.css'
import '../../styles/org.css'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/useQuery'
import { canAdminister, useAuth } from '../../lib/auth'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconEdit, IconPin, IconPlus, IconSearch, IconTrash } from '../../components/Icons'
import { Dialog, Field } from '../crm/parts'
import { ColumnSettings, useColumns, type ColumnDef } from '../../components/ViewSettings'
import type { OfficeLocation } from '../hrms/attendance/MyAttendance'
import type { Branch } from './BranchMaster'
import { NameSelect, placeOptions, useGeoMasters, type Place } from './orgKit'

type LocationColumn = ColumnDef & { td: (row: OfficeLocation) => ReactNode; className?: string; thClass?: string }
const dash = <span className="crm-muted">—</span>
const LOCATION_COLUMNS: LocationColumn[] = [
  { key: 'location', label: 'Location', locked: true, td: (l) => (
    <>
      <span className="crm-strong">{l.name}</span>
      {l.address && <div className="crm-sub">{l.address}</div>}
    </>
  ) },
  { key: 'branch', label: 'Branch', className: 'crm-muted', td: (l) => l.branch_name ?? dash },
  { key: 'place', label: 'City', td: (l) => [l.city, l.state].filter(Boolean).join(', ') || dash },
  { key: 'geofence', label: 'Geofence', className: 'crm-muted', td: (l) => (
    l.lat === null || l.lng === null ? 'Not mapped' : `${l.radius_m} m`
  ) },
  { key: 'status', label: 'Status', td: (l) => (
    <span className={`crm-state ${l.is_active ? 'crm-state-good' : 'crm-state-idle'}`}>{l.is_active ? 'Active' : 'Inactive'}</span>
  ) },
  { key: 'coords', label: 'Coordinates', initial: false, className: 'muted-sm', td: (l) => (
    l.lat === null || l.lng === null ? dash : `${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}`
  ) },
  { key: 'district', label: 'District', initial: false, td: (l) => l.district ?? dash },
]

/** `readOnly` shows the list without add, edit or delete — as on HR Settings, where the
 *  masters are only listed; the Master menu is where they are kept. */
export default function LocationMaster({ readOnly = false }: { readOnly?: boolean }) {
  const columns = useColumns('locations', LOCATION_COLUMNS)
  const { user } = useAuth()
  const isAdmin = canAdminister(user) && !readOnly
  const locations = useQuery<OfficeLocation[]>('att-locations-admin', () => api.get<OfficeLocation[]>('/attendance/locations'))
  const branches = useQuery<Branch[]>('branches', () => api.get<Branch[]>('/org/branches'))
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<OfficeLocation | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (locations.data ?? []).filter((l) =>
      !needle || [l.name, l.branch_name, l.city, l.state].some((v) => (v ?? '').toLowerCase().includes(needle)))
  }, [locations.data, q])

  async function remove(location: OfficeLocation) {
    if (!window.confirm(`Delete “${location.name}”?`)) return
    setError(null)
    try {
      await api.del(`/attendance/locations/${location.id}`)
      locations.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That location could not be deleted')
    }
  }

  const total = locations.data?.length ?? 0

  return (
    <div className="crm">
      <section className="card dm-card">
        <div className="dm-head">
          <span className="dm-tile dm-tile-violet"><IconPin size={18} /></span>
          <div className="dm-heading">
            <h1 className="dm-title">Location Master</h1>
            <p className="crm-sub">Sites inside a branch. The geofence is used once attendance location checks are on.</p>
          </div>
          <div className="dm-tools">
            <div className="crm-search dm-search">
              <IconSearch size={15} />
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)}
                     placeholder="Search locations…" aria-label="Search locations" />
            </div>
            <span className="crm-sub crm-nowrap">{total} location{total === 1 ? '' : 's'}</span>
            <ColumnSettings defs={LOCATION_COLUMNS} order={columns.pref.order} hidden={columns.pref.hidden}
                            onSave={columns.save} onReset={columns.reset} />
            {isAdmin && (
              <button className="btn btn-primary" onClick={() => setEditing('new')}>
                <IconPlus size={15} /> Add Location
              </button>
            )}
          </div>
        </div>

        {(error || locations.error) && <div className="dm-error"><ErrorNote>{error ?? locations.error}</ErrorNote></div>}

        {locations.loading && !locations.data ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState
            title={q ? 'No location matches that search' : 'No locations yet'}
            body={q ? 'Try a different name, branch or city.' : 'Add the sites people work from, under the branch they belong to.'}
            action={isAdmin && !q ? <button className="btn btn-primary" onClick={() => setEditing('new')}>Add the first one</button> : undefined}
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {(columns.visible as LocationColumn[]).map((col) => <th key={col.key} className={col.thClass}>{col.label}</th>)}
                  {isAdmin && <th style={{ textAlign: 'right' }}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={l.id}>
                    {(columns.visible as LocationColumn[]).map((col) => <td key={col.key} className={col.className}>{col.td(l)}</td>)}
                    {isAdmin && (
                      <td>
                        <div className="crm-row-actions">
                          <button className="crm-icon-btn" onClick={() => setEditing(l)} aria-label={`Edit ${l.name}`} title="Edit">
                            <IconEdit size={16} />
                          </button>
                          <button className="crm-icon-btn dm-delete" onClick={() => remove(l)} aria-label={`Delete ${l.name}`} title="Delete">
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
        <LocationDialog
          location={editing === 'new' ? null : editing}
          branches={branches.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); locations.reload() }}
        />
      )}
    </div>
  )
}

function LocationDialog({
  location, branches, onClose, onSaved,
}: {
  location: OfficeLocation | null
  branches: Branch[]
  onClose: () => void
  onSaved: () => void
}) {
  const geo = useGeoMasters()
  const [form, setForm] = useState({
    name: location?.name ?? '',
    branch_id: location?.branch_id ?? '',
    address: location?.address ?? '',
    state: location?.state ?? '',
    district: location?.district ?? '',
    city: location?.city ?? '',
    lat: location?.lat === null || location?.lat === undefined ? '' : String(location.lat),
    lng: location?.lng === null || location?.lng === undefined ? '' : String(location.lng),
    radius_m: String(location?.radius_m ?? 200),
    is_active: location?.is_active ?? true,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))
  const place: Place = { country: '', state: form.state, district: form.district, city: form.city }
  const opt = placeOptions(geo, place)

  async function save() {
    if (!form.name.trim()) return setError('Give the location a name.')
    const hasLat = form.lat.trim() !== ''
    const hasLng = form.lng.trim() !== ''
    if (hasLat !== hasLng) return setError('Give both latitude and longitude, or neither.')
    const lat = hasLat ? Number(form.lat) : null
    const lng = hasLng ? Number(form.lng) : null
    if ((lat !== null && (!Number.isFinite(lat) || Math.abs(lat) > 90)) || (lng !== null && (!Number.isFinite(lng) || Math.abs(lng) > 180))) {
      return setError('Latitude is between -90 and 90, longitude between -180 and 180.')
    }
    const radius = Number(form.radius_m)
    if (!Number.isInteger(radius) || radius < 25 || radius > 20000) return setError('Radius is between 25 and 20,000 metres.')
    setBusy(true)
    setError(null)
    const body = {
      name: form.name.trim(),
      branch_id: form.branch_id || null,
      address: form.address.trim() || null,
      state: form.state || null,
      district: form.district || null,
      city: form.city || null,
      lat, lng, radius_m: radius, is_active: form.is_active,
    }
    try {
      if (location) await api.patch(`/attendance/locations/${location.id}`, body)
      else await api.post('/attendance/locations', body)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That location could not be saved')
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={location ? `Edit ${location.name}` : 'Add Location'}
      medium
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !form.name.trim()}>
            {busy ? 'Saving…' : location ? 'Save' : 'Add'}
          </button>
        </>
      }
    >
      <div className="crm-form">
        {error && <div className="crm-form-wide"><ErrorNote>{error}</ErrorNote></div>}
        <Field label="Location name" required>
          <input value={form.name} placeholder="Plant 2" autoFocus onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Belongs to branch">
          <select value={form.branch_id} onChange={(e) => set({ branch_id: e.target.value })}>
            <option value="">— None —</option>
            {branches.filter((b) => b.is_active || b.id === form.branch_id).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Field>
        <Field label="Address" wide>
          <input value={form.address} onChange={(e) => set({ address: e.target.value })} />
        </Field>
        <NameSelect label="State" value={form.state} placeholder="— Select —" options={opt.states.map((s) => s.name)}
                    onChange={(v) => set({ state: v, district: '', city: '' })} />
        <NameSelect label="District" value={form.district} disabled={!opt.state}
                    placeholder={opt.state ? '— Select —' : '— Pick a state first —'} options={opt.districts.map((d) => d.name)}
                    onChange={(v) => set({ district: v, city: '' })} />
        <NameSelect label="City" value={form.city} disabled={!opt.state}
                    placeholder={opt.state ? '— Select —' : '— Pick a state first —'} options={opt.cities.map((c) => c.name)}
                    onChange={(v) => set({ city: v })} />

        <div className="crm-form-wide om-geofence">
          <span className="om-geofence-title">Geofence — used once attendance is switched on</span>
          <div className="om-geofence-grid">
            <Field label="Latitude">
              <input value={form.lat} inputMode="decimal" placeholder="18.5204" onChange={(e) => set({ lat: e.target.value })} />
            </Field>
            <Field label="Longitude">
              <input value={form.lng} inputMode="decimal" placeholder="73.8567" onChange={(e) => set({ lng: e.target.value })} />
            </Field>
            <Field label="Radius (m)">
              <input value={form.radius_m} inputMode="numeric" onChange={(e) => set({ radius_m: e.target.value })} />
            </Field>
          </div>
        </div>

        <div className="crm-field crm-form-wide om-checks">
          <label className="crm-check">
            <input type="checkbox" checked={form.is_active} onChange={(e) => set({ is_active: e.target.checked })} />
            Offered when adding an employee
          </label>
        </div>
      </div>
    </Dialog>
  )
}
