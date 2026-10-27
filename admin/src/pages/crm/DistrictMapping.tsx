/* State → District mapping — the District Master in CRM Settings.
 *
 * States down the left with how many districts each holds; the chosen state's
 * districts on the right, each with how many cities sit under it. A company
 * that has no districts yet loads India's full list in one click
 * (POST /crm/geography/india), which only ever adds what is missing.
 */

import { useMemo, useState } from 'react'
import '../../styles/crm.css'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/useQuery'
import { ErrorNote, Loading } from '../../components/ui'
import { IconBuilding, IconDownload, IconEdit, IconPlus, IconSearch, IconTrash } from '../../components/Icons'
import { crm, crmError } from './api'
import { Dialog, Field } from './parts'

interface State { id: string; name: string; gst_code: string | null; is_active: boolean }
interface District { id: string; name: string; state_id: string; is_active: boolean }
interface City { id: string; district_id: string | null }

export default function DistrictMapping() {
  const states = useQuery<State[]>('crm-geo-states', () => crm.masters<State>('states'))
  const districts = useQuery<District[]>('crm-geo-districts', () => crm.masters<District>('districts'))
  const cities = useQuery<City[]>('crm-geo-cities', () => crm.masters<City>('cities'))

  const [stateQ, setStateQ] = useState('')
  const [districtQ, setDistrictQ] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [editing, setEditing] = useState<District | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [loadingIndia, setLoadingIndia] = useState(false)

  const byState = useMemo(() => {
    const map = new Map<string, District[]>()
    for (const d of districts.data ?? []) {
      const list = map.get(d.state_id) ?? []
      list.push(d)
      map.set(d.state_id, list)
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name))
    return map
  }, [districts.data])

  const cityCount = useMemo(() => {
    const map = new Map<string, number>()
    for (const c of cities.data ?? []) if (c.district_id) map.set(c.district_id, (map.get(c.district_id) ?? 0) + 1)
    return map
  }, [cities.data])

  const sortedStates = useMemo(
    () => [...(states.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [states.data],
  )
  const shownStates = sortedStates.filter((s) => !stateQ.trim() || s.name.toLowerCase().includes(stateQ.trim().toLowerCase()))
  const current = sortedStates.find((s) => s.id === picked) ?? sortedStates[0] ?? null
  const list = (current ? byState.get(current.id) ?? [] : [])
    .filter((d) => !districtQ.trim() || d.name.toLowerCase().includes(districtQ.trim().toLowerCase()))

  const totalDistricts = districts.data?.length ?? 0
  const statesWithDistricts = byState.size

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
      const added = await api.post<{ states: number; districts: number }>('/crm/geography/india', {})
      setNote(added.districts || added.states
        ? `Added ${added.districts} district${added.districts === 1 ? '' : 's'}${added.states ? ` and ${added.states} state${added.states === 1 ? '' : 's'}` : ''}.`
        : 'Everything was already here — nothing to add.')
      reload()
    } catch (err) {
      setError(crmError(err, 'The district list could not be loaded'))
    } finally {
      setLoadingIndia(false)
    }
  }

  async function remove(d: District) {
    if (!window.confirm(`Delete the district “${d.name}”?`)) return
    setError(null)
    try {
      await crm.deleteMaster('districts', d.id)
      reload()
    } catch (err) {
      setError(crmError(err, 'That district could not be deleted'))
    }
  }

  if (states.error || districts.error) return <ErrorNote>{states.error ?? districts.error}</ErrorNote>
  if (!states.data || !districts.data) return <Loading />

  return (
    <section className="card dmap">
      <header className="dmap-head">
        <span className="dmap-tile" aria-hidden><IconBuilding size={18} /></span>
        <div className="dmap-titles">
          <h2>State → District Mapping</h2>
          <p>Pick a state to manage its districts. Cities are mapped underneath each district.</p>
        </div>
        <span className="dmap-total">
          {totalDistricts} district{totalDistricts === 1 ? '' : 's'} across {statesWithDistricts} state{statesWithDistricts === 1 ? '' : 's'}
        </span>
        <button className="btn btn-sm" onClick={() => void loadIndia()} disabled={loadingIndia}
                title="Adds any of India's states, union territories and districts that are missing. Nothing you have is changed.">
          <IconDownload size={14} /> {loadingIndia ? 'Loading…' : 'Load India districts'}
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
              const n = byState.get(s.id)?.length ?? 0
              const on = current?.id === s.id
              return (
                <li key={s.id}>
                  <button type="button" className={`dmap-state${on ? ' is-on' : ''}`} onClick={() => { setPicked(s.id); setDistrictQ('') }}
                          aria-current={on ? 'true' : undefined}>
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
            <label className="dmap-search dmap-search-right">
              <IconSearch size={14} />
              <input value={districtQ} onChange={(e) => setDistrictQ(e.target.value)} placeholder="Search districts…"
                     aria-label="Search districts" />
            </label>
            <button className="btn btn-primary btn-sm" disabled={!current} onClick={() => setEditing('new')}>
              <IconPlus size={14} /> Add District
            </button>
          </div>

          <div className="table-wrap dmap-table-wrap">
            <table className="dmap-table">
              <thead>
                <tr>
                  <th>District</th>
                  <th className="c">Cities</th>
                  <th className="c">Status</th>
                  <th className="r">Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.map((d) => {
                  const n = cityCount.get(d.id) ?? 0
                  return (
                    <tr key={d.id} className={d.is_active ? undefined : 'is-off'}>
                      <td className="crm-strong">{d.name}</td>
                      <td className="c">{n ? n : <span className="crm-muted">none</span>}</td>
                      <td className="c">
                        <span className={`crm-state ${d.is_active ? 'crm-state-good' : 'crm-state-idle'}`}>
                          {d.is_active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td>
                        <div className="crm-row-actions">
                          <button className="crm-icon-btn" title="Edit" aria-label={`Edit ${d.name}`} onClick={() => setEditing(d)}>
                            <IconEdit size={15} />
                          </button>
                          <button className="crm-icon-btn dmap-del" title="Delete" aria-label={`Delete ${d.name}`} onClick={() => void remove(d)}>
                            <IconTrash size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
                {list.length === 0 && (
                  <tr>
                    <td colSpan={4} className="dmap-empty">
                      {districtQ.trim()
                        ? 'No district matches that search.'
                        : totalDistricts === 0
                          ? <>No districts yet. Press <b>Load India districts</b> to add the full list, or add them one by one.</>
                          : 'No districts in this state yet.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {editing && current && (
        <DistrictDialog
          district={editing === 'new' ? null : editing}
          state={current}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload() }}
        />
      )}
    </section>
  )
}

function DistrictDialog({ district, state, onClose, onSaved }: {
  district: District | null
  state: State
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(district?.name ?? '')
  const [active, setActive] = useState(district?.is_active ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    if (!name.trim()) { setError('Give the district a name.'); return }
    setBusy(true)
    setError(null)
    const body = { name: name.trim(), state_id: district?.state_id ?? state.id, is_active: active }
    try {
      if (district) await crm.updateMaster('districts', district.id, body)
      else await crm.createMaster('districts', body)
      onSaved()
    } catch (err) {
      setError(crmError(err, 'That district could not be saved'))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={district ? `Edit ${district.name}` : `Add a district to ${state.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : district ? 'Save' : 'Add district'}
          </button>
        </>
      }
    >
      <div className="crm-form">
        {error && <div className="crm-form-wide"><ErrorNote>{error}</ErrorNote></div>}
        <Field label="District name" wide>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Ernakulam" />
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
