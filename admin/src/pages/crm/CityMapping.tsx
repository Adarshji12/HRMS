/* District → City mapping — the City Master in CRM Settings.
 *
 * States down the left with how many cities each holds; the chosen state's
 * cities on the right with the district each belongs to, filterable by
 * district. Shares its layout (and its dmap- styles) with DistrictMapping.
 */

import { useMemo, useState } from 'react'
import '../../styles/crm.css'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/useQuery'
import { ErrorNote, Loading } from '../../components/ui'
import { IconBuilding, IconDownload, IconEdit, IconPlus, IconSearch, IconTrash } from '../../components/Icons'
import { crm, crmError } from './api'
import { Dialog, Field } from './parts'

interface State { id: string; name: string; gst_code: string | null }
interface District { id: string; name: string; state_id: string }
interface City { id: string; name: string; state_id: string; district_id: string | null; is_active: boolean }

export default function CityMapping() {
  const states = useQuery<State[]>('crm-geo-states', () => crm.masters<State>('states'))
  const districts = useQuery<District[]>('crm-geo-districts', () => crm.masters<District>('districts'))
  const cities = useQuery<City[]>('crm-geo-cities', () => crm.masters<City>('cities'))

  const [stateQ, setStateQ] = useState('')
  const [cityQ, setCityQ] = useState('')
  const [districtId, setDistrictId] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [editing, setEditing] = useState<City | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [loadingIndia, setLoadingIndia] = useState(false)

  const districtName = useMemo(
    () => new Map((districts.data ?? []).map((d) => [d.id, d.name])),
    [districts.data],
  )
  const citiesByState = useMemo(() => {
    const map = new Map<string, City[]>()
    for (const c of cities.data ?? []) {
      const list = map.get(c.state_id) ?? []
      list.push(c)
      map.set(c.state_id, list)
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name))
    return map
  }, [cities.data])

  const sortedStates = useMemo(
    () => [...(states.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [states.data],
  )
  const shownStates = sortedStates.filter((s) => !stateQ.trim() || s.name.toLowerCase().includes(stateQ.trim().toLowerCase()))
  const current = sortedStates.find((s) => s.id === picked) ?? sortedStates[0] ?? null
  const stateDistricts = (districts.data ?? [])
    .filter((d) => d.state_id === current?.id)
    .sort((a, b) => a.name.localeCompare(b.name))
  const needle = cityQ.trim().toLowerCase()
  const list = (current ? citiesByState.get(current.id) ?? [] : [])
    .filter((c) => !districtId || c.district_id === districtId)
    .filter((c) => !needle || c.name.toLowerCase().includes(needle))

  const total = cities.data?.length ?? 0
  const statesWithCities = citiesByState.size

  function reload() {
    states.reload()
    districts.reload()
    cities.reload()
  }

  async function loadIndia() {
    setLoadingIndia(true)
    setError(null)
    setNote(null)
    try {
      const added = await api.post<{ states: number; districts: number; cities: number; renamed?: number }>('/crm/geography/india', {})
      const parts = [
        added.cities && `${added.cities} cit${added.cities === 1 ? 'y' : 'ies'}`,
        added.districts && `${added.districts} district${added.districts === 1 ? '' : 's'}`,
        added.states && `${added.states} state${added.states === 1 ? '' : 's'}`,
      ].filter(Boolean)
      setNote(parts.length ? `Added ${parts.join(', ')}.` : 'Everything was already here — nothing to add.')
      reload()
    } catch (err) {
      setError(crmError(err, 'The city list could not be loaded'))
    } finally {
      setLoadingIndia(false)
    }
  }

  async function remove(c: City) {
    if (!window.confirm(`Delete the city “${c.name}”?`)) return
    setError(null)
    try {
      await crm.deleteMaster('cities', c.id)
      reload()
    } catch (err) {
      setError(crmError(err, 'That city could not be deleted'))
    }
  }

  if (states.error || cities.error) return <ErrorNote>{states.error ?? cities.error}</ErrorNote>
  if (!states.data || !cities.data || !districts.data) return <Loading />

  return (
    <section className="card dmap">
      <header className="dmap-head">
        <span className="dmap-tile" aria-hidden><IconBuilding size={18} /></span>
        <div className="dmap-titles">
          <h2>District → City Mapping</h2>
          <p>Pick a state to manage its cities. Each city belongs to one district.</p>
        </div>
        <span className="dmap-total">
          {total} cit{total === 1 ? 'y' : 'ies'} across {statesWithCities} state{statesWithCities === 1 ? '' : 's'}
        </span>
        <button className="btn btn-sm" onClick={() => void loadIndia()} disabled={loadingIndia}
                title="Adds any of India's states, districts and cities that are missing. Nothing you have is changed.">
          <IconDownload size={14} /> {loadingIndia ? 'Loading…' : 'Load India cities'}
        </button>
      </header>

      {(error || note) && (
        <div className="dmap-msg">
          {error ? <ErrorNote>{error}</ErrorNote> : <div className="notice notice-ok">{note}</div>}
        </div>
      )}

      <div className="dmap-body">
        <aside className="dmap-states">
          <label className="dmap-search">
            <IconSearch size={14} />
            <input value={stateQ} onChange={(e) => setStateQ(e.target.value)} placeholder="Filter states…"
                   aria-label="Filter states" />
          </label>
          <ul className="dmap-state-list">
            {shownStates.map((s) => {
              const n = citiesByState.get(s.id)?.length ?? 0
              const on = current?.id === s.id
              return (
                <li key={s.id}>
                  <button type="button" className={`dmap-state${on ? ' is-on' : ''}`} aria-current={on ? 'true' : undefined}
                          onClick={() => { setPicked(s.id); setCityQ(''); setDistrictId('') }}>
                    <span className="dmap-state-name">
                      {s.name}
                      {s.gst_code && <small>({s.gst_code})</small>}
                    </span>
                    <span className={`dmap-count${n === 0 ? ' is-zero' : ''}`}>{n}</span>
                  </button>
                </li>
              )
            })}
            {shownStates.length === 0 && <li className="dmap-none">No state matches.</li>}
          </ul>
        </aside>

        <div className="dmap-main">
          <div className="dmap-main-head">
            <h3>{current?.name ?? 'No states yet'}</h3>
            <select className="dmap-district-filter" value={districtId} onChange={(e) => setDistrictId(e.target.value)}
                    aria-label="Filter by district">
              <option value="">All districts</option>
              {stateDistricts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <label className="dmap-search dmap-search-right">
              <IconSearch size={14} />
              <input value={cityQ} onChange={(e) => setCityQ(e.target.value)} placeholder="Search cities…"
                     aria-label="Search cities" />
            </label>
            <button className="btn btn-primary btn-sm" disabled={!current} onClick={() => setEditing('new')}>
              <IconPlus size={14} /> Add City
            </button>
          </div>

          <div className="table-wrap dmap-table-wrap">
            <table className="dmap-table">
              <thead>
                <tr>
                  <th>City</th>
                  <th>District</th>
                  <th className="c">Status</th>
                  <th className="r">Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.id} className={c.is_active ? undefined : 'is-off'}>
                    <td className="crm-strong">{c.name}</td>
                    <td className="crm-muted">
                      {c.district_id ? districtName.get(c.district_id) ?? '—' : <span className="crm-muted">No district</span>}
                    </td>
                    <td className="c">
                      <span className={`crm-state ${c.is_active ? 'crm-state-good' : 'crm-state-idle'}`}>
                        {c.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td>
                      <div className="crm-row-actions">
                        <button className="crm-icon-btn" title="Edit" aria-label={`Edit ${c.name}`} onClick={() => setEditing(c)}>
                          <IconEdit size={15} />
                        </button>
                        <button className="crm-icon-btn dmap-del" title="Delete" aria-label={`Delete ${c.name}`} onClick={() => void remove(c)}>
                          <IconTrash size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {list.length === 0 && (
                  <tr>
                    <td colSpan={4} className="dmap-empty">
                      {needle || districtId
                        ? 'No city matches that filter.'
                        : total === 0
                          ? <>No cities yet. Press <b>Load India cities</b> to add the list, or add them one by one.</>
                          : 'No cities in this state yet.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {editing && current && (
        <CityDialog
          city={editing === 'new' ? null : editing}
          state={current}
          districts={stateDistricts}
          defaultDistrict={districtId}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload() }}
        />
      )}
    </section>
  )
}

function CityDialog({ city, state, districts, defaultDistrict, onClose, onSaved }: {
  city: City | null
  state: State
  districts: District[]
  defaultDistrict: string
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(city?.name ?? '')
  const [districtId, setDistrictId] = useState(city?.district_id ?? defaultDistrict)
  const [active, setActive] = useState(city?.is_active ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    if (!name.trim()) { setError('Give the city a name.'); return }
    setBusy(true)
    setError(null)
    const body = {
      name: name.trim(),
      state_id: city?.state_id ?? state.id,
      district_id: districtId || null,
      is_active: active,
    }
    try {
      if (city) await crm.updateMaster('cities', city.id, body)
      else await crm.createMaster('cities', body)
      onSaved()
    } catch (err) {
      setError(crmError(err, 'That city could not be saved'))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={city ? `Edit ${city.name}` : `Add a city to ${state.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : city ? 'Save' : 'Add city'}
          </button>
        </>
      }
    >
      <div className="crm-form">
        {error && <div className="crm-form-wide"><ErrorNote>{error}</ErrorNote></div>}
        <Field label="City name">
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Kochi" />
        </Field>
        <Field label="District">
          <select value={districtId} onChange={(e) => setDistrictId(e.target.value)}>
            <option value="">— None —</option>
            {districts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        <div className="crm-field crm-form-wide">
          <label className="crm-check">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Active — offered in dropdowns
          </label>
        </div>
      </div>
    </Dialog>
  )
}
