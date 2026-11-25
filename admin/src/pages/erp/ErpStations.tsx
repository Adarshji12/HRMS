/* Master -> Geography -> Stations: the towns your ledgers are at, with how many ledgers each has.
 * A station is a city of the geography master; this is its ERP view. A station in use cannot be deleted. */

import { useMemo, useState } from 'react'
import { useQuery } from '../../lib/useQuery'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconBuilding, IconEdit, IconPlus, IconSearch, IconTrash } from '../../components/Icons'
import { ColumnSettings, useColumns, type ColumnDef } from '../../components/ViewSettings'
import RowShare from '../../components/RowShare'
import ImportExport, { type IoColumn } from '../../components/ImportExport'
import { crm } from '../crm/api'
import { Dialog, Field, newestFirst, useAccess, useRun } from './parts'
import { erp, type Station } from './api'

const COLUMNS: Array<ColumnDef & { td: (s: Station) => React.ReactNode; className?: string }> = [
  { key: 'name', label: 'Station', locked: true, td: (s) => <b>{s.name}</b> },
  { key: 'district', label: 'District', td: (s) => s.district_name ?? '—' },
  { key: 'state', label: 'State', td: (s) => s.state_name ?? '—' },
  { key: 'pincode', label: 'PIN code', className: 'crm-nowrap', td: (s) => s.pincode ?? '—' },
  { key: 'ledgers', label: 'Ledgers', className: 'crm-nowrap', td: (s) => String(s.ledgers) },
  { key: 'source', label: 'Source', td: (s) => (
    <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: 999, fontSize: 11, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase',
                   background: s.source === 'custom' ? 'var(--brand-soft)' : 'var(--surface-2)', color: s.source === 'custom' ? 'var(--brand)' : 'var(--text-secondary)' }}>
      {s.source === 'custom' ? 'Custom' : 'Standard'}
    </span>
  ) },
]

const IO: IoColumn<Station>[] = [
  { key: 'name', label: 'Station', required: true, sample: 'Chomu', get: (s) => s.name },
  { key: 'state', label: 'State', required: true, sample: 'Rajasthan', get: (s) => s.state_name },
  { key: 'district', label: 'District', sample: 'Jaipur', get: (s) => s.district_name },
  { key: 'pincode', label: 'PIN code', sample: '303702', get: (s) => s.pincode },
]

interface StateRow { id: string; name: string; is_active?: boolean }
interface DistrictRow { id: string; name: string; state_id: string }

export default function Stations() {
  const { can } = useAccess()
  const manage = can('can_manage_erp_masters')
  const columns = useColumns('erp-stations', COLUMNS)
  const [q, setQ] = useState('')
  const [stateId, setStateId] = useState('')
  const [districtId, setDistrictId] = useState('')
  const [customOnly, setCustomOnly] = useState(false)
  const [editing, setEditing] = useState<Station | 'new' | null>(null)
  const list = useQuery<Station[]>('erp-stations', () => erp.stations())
  const states = useQuery<StateRow[]>('erp-stations-states', () => crm.masters<StateRow>('states'))
  const districts = useQuery<DistrictRow[]>('erp-stations-districts', () => crm.masters<DistrictRow>('districts'))
  const removing = useRun(() => list.reload())
  const all = list.data ?? []
  const needle = q.trim().toLowerCase()
  const rows = useMemo(() => newestFirst(all).filter((s) =>
    (!stateId || s.state_id === stateId) && (!districtId || s.district_id === districtId) && (!customOnly || s.source === 'custom')
    && (!needle || [s.name, s.district_name, s.pincode].some((x) => x && x.toLowerCase().includes(needle)))), [all, stateId, districtId, customOnly, needle])
  const districtChoices = (districts.data ?? []).filter((d) => !stateId || d.state_id === stateId)

  function remove(s: Station) {
    if (!window.confirm(`Delete the station “${s.name}”? This cannot be undone.`)) return
    void removing.run(() => erp.deleteStation(s.id), 'That station could not be deleted')
  }

  return (
    <>
      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '12px 18px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="muted-sm" style={{ display: 'inline-grid', placeItems: 'center', width: 34, height: 34, borderRadius: 10, background: 'var(--brand-soft)', color: 'var(--brand)' }}><IconBuilding size={16} /></span>
            <p className="muted-sm" style={{ margin: 0 }}>The towns your ledgers are at, with how many ledgers each has. A station in use cannot be deleted.</p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <ImportExport name="stations" columns={IO} rows={rows} canImport={false} build={() => ({})} save={async () => undefined} onDone={() => list.reload()} />
            <ColumnSettings defs={COLUMNS} order={columns.pref.order} hidden={columns.pref.hidden} onSave={columns.save} onReset={columns.reset} />
            {manage && <button className="btn btn-primary" onClick={() => setEditing('new')}><IconPlus size={15} /> New station</button>}
          </div>
        </div>
        <div className="crm-bar itl-bar" style={{ borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
          <div className="crm-search">
            <IconSearch size={15} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Town, district or PIN…" aria-label="Search stations" />
          </div>
          <select value={stateId} onChange={(e) => { setStateId(e.target.value); setDistrictId('') }} aria-label="State" style={{ maxWidth: 220 }}>
            <option value="">All states</option>
            {(states.data ?? []).filter((s) => s.is_active !== false).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select value={districtId} onChange={(e) => setDistrictId(e.target.value)} aria-label="District" style={{ maxWidth: 220 }}>
            <option value="">All districts</option>
            {districtChoices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <label className="crm-check"><input type="checkbox" checked={customOnly} onChange={(e) => setCustomOnly(e.target.checked)} /> Added by us only</label>
          <span className="itl-count crm-push">Total: {rows.length}</span>
        </div>
        {list.error && <ErrorNote>{list.error}</ErrorNote>}
        {removing.error && <div style={{ margin: 10 }}><ErrorNote>{removing.error}</ErrorNote></div>}
        {!list.data ? <Loading /> : rows.length === 0 ? (
          <EmptyState icon={<IconBuilding size={22} />} title={all.length ? 'Nothing matches' : 'No stations yet'}
            body={all.length ? 'Change the search or the filters.' : 'Load the India list on the Geography master, or add a town here.'} />
        ) : (
          <div className="table-wrap"><table className="itl">
            <thead><tr>
              {columns.visible.map((c) => <th key={c.key}>{c.label}</th>)}
              {manage && <th className="itl-c-act">Action</th>}
            </tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  {columns.visible.map((c) => {
                    const def = COLUMNS.find((d) => d.key === c.key)!
                    return <td key={c.key} className={def.className}>{def.td(s)}</td>
                  })}
                  {manage && (
                    <td className="itl-c-act">
                      <div className="crm-row-actions itl-actions">
                        <RowShare name="station" title={s.name} columns={IO} row={s} />
                        <button className="crm-icon-btn" onClick={() => setEditing(s)} title="Edit" aria-label={`Edit ${s.name}`}><IconEdit size={14} /></button>
                        <button className="crm-icon-btn crm-icon-danger" onClick={() => remove(s)} disabled={removing.busy || s.ledgers > 0}
                                title={s.ledgers > 0 ? `${s.ledgers} ledger${s.ledgers === 1 ? '' : 's'} at this station` : 'Delete'} aria-label={`Delete ${s.name}`}><IconTrash size={14} /></button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>
      {editing && (
        <StationForm station={editing === 'new' ? null : editing} states={states.data ?? []} districts={districts.data ?? []}
                     onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload() }} />
      )}
    </>
  )
}

function StationForm({ station, states, districts, onClose, onSaved }: {
  station: Station | null; states: StateRow[]; districts: DistrictRow[]; onClose: () => void; onSaved: () => void
}) {
  const [f, setF] = useState({ state_id: station?.state_id ?? '', district_id: station?.district_id ?? '', name: station?.name ?? '', pincode: station?.pincode ?? '' })
  const { busy, error, run } = useRun()
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((c) => ({ ...c, [k]: v }))
  const choices = districts.filter((d) => d.state_id === f.state_id)
  const pinBad = f.pincode !== '' && !/^\d{6}$/.test(f.pincode)
  // A district is asked for when the state has any; a state with none can still take a town.
  const needsDistrict = choices.length > 0
  const missing = !f.state_id || !f.name.trim() || (needsDistrict && !f.district_id)

  function save() {
    void run(async () => {
      await erp.saveStation({ name: f.name.trim(), state_id: f.state_id, district_id: f.district_id || null, pincode: f.pincode || null }, station?.id)
      onSaved()
    }, 'That station could not be saved')
  }

  return (
    <Dialog narrow title={station ? 'Edit city / town' : 'New city / town'} subtitle="A town or village your ledgers can be at; added for your organisation only" onClose={onClose}
            footer={<>
              {error && <span className="error">{error}</span>}
              <button className="btn crm-push" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || missing || pinBad} onClick={save}>{busy ? 'Saving…' : station ? 'Save' : 'Add Town'}</button>
            </>}>
      <div style={{ display: 'grid', gap: 14, padding: '8px 24px 20px', overflowY: 'auto', minHeight: 0, flex: 1, alignContent: 'start' }}>
        <Field label="State" required>
          <select value={f.state_id} autoFocus onChange={(e) => setF((c) => ({ ...c, state_id: e.target.value, district_id: '' }))}>
            <option value="">Choose state</option>
            {states.filter((s) => s.is_active !== false).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="District" required={needsDistrict}>
          <select value={f.district_id} disabled={!f.state_id} onChange={(e) => set('district_id', e.target.value)}>
            <option value="">{f.state_id ? (needsDistrict ? 'Choose district' : 'No districts for this state') : 'Choose a state first'}</option>
            {choices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        <Field label="Town / Village name" required>
          <input value={f.name} maxLength={120} placeholder="Chomu" onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="PIN code" hint={pinBad ? <span style={{ color: '#dc2626' }}>PIN code must be 6 digits.</span> : undefined}>
          <input value={f.pincode} maxLength={6} inputMode="numeric" placeholder="303702" onChange={(e) => set('pincode', e.target.value.replace(/\D/g, ''))} />
        </Field>
      </div>
    </Dialog>
  )
}

