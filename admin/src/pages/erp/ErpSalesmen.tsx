/* Master -> ERP Master -> Salesman: who sells for you, with area or beat, commission % and a monthly target.
 * A ledger keeps its salesman; every new sale bill for it starts with them. */

import { useState, type ReactNode } from 'react'
import { useQuery } from '../../lib/useQuery'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconBuilding, IconEdit, IconPlus, IconSearch, IconTrash } from '../../components/Icons'
import { ColumnSettings, FieldSettings, useColumns, useFieldModes, type ColumnDef, type FieldDef, type FieldSection } from '../../components/ViewSettings'
import ImportExport, { type IoColumn } from '../../components/ImportExport'
import FilterPopup, { FilterField } from '../../components/FilterPopup'
import { Dialog, Field, useAccess, useRun } from './parts'
import { erp, rupees, type Salesman } from './api'

type Show = 'active' | 'inactive' | 'all'

const COLUMNS: Array<ColumnDef & { td: (s: Salesman) => ReactNode; className?: string }> = [
  { key: 'code', label: 'Code', locked: false, td: (s) => <span className="crm-code">{s.code}</span> },
  { key: 'name', label: 'Salesman', locked: true, td: (s) => <b>{s.name}</b> },
  { key: 'mobile', label: 'Mobile', td: (s) => s.mobile ?? '—' },
  { key: 'area', label: 'Area / Beat', td: (s) => s.area_beat ?? '—' },
  { key: 'commission', label: 'Commission %', className: 'crm-nowrap', td: (s) => `${Number(s.commission_pct)}%` },
  { key: 'target', label: 'Monthly target', className: 'crm-nowrap', td: (s) => (s.monthly_target ? rupees(s.monthly_target) : '—') },
  { key: 'ledgers', label: 'Ledgers', td: (s) => String(s.ledgers) },
  { key: 'login', label: 'Login', td: (s) => (s.allow_login ? 'Allowed' : '—') },
  { key: 'email', label: 'Email', initial: false, td: (s) => s.email ?? '—' },
  { key: 'status', label: 'Status', initial: false, td: (s) => (s.is_active ? 'Active' : 'Inactive') },
]

const SECTIONS: FieldSection[] = [{ id: 'main', label: 'Salesman' }]
const FIELDS: FieldDef[] = [
  { key: 'code', label: 'Code', section: 'main', optionalOnly: true },
  { key: 'name', label: 'Salesman name', section: 'main', fixed: true },
  { key: 'mobile', label: 'Mobile', section: 'main' },
  { key: 'email', label: 'Email', section: 'main' },
  { key: 'area', label: 'Area / Beat', section: 'main' },
  { key: 'commission', label: 'Commission %', section: 'main', optionalOnly: true },
  { key: 'target', label: 'Monthly target', section: 'main' },
  { key: 'login', label: 'Allow salesman login', section: 'main', optionalOnly: true },
]

const IO: IoColumn<Salesman>[] = [
  { key: 'code', label: 'Code', sample: 'RK', get: (s) => s.code },
  { key: 'name', label: 'Salesman name', required: true, sample: 'Ravi Kumar', get: (s) => s.name },
  { key: 'mobile', label: 'Mobile', sample: '9876543210', get: (s) => s.mobile },
  { key: 'email', label: 'Email', sample: '', get: (s) => s.email },
  { key: 'area_beat', label: 'Area / Beat', sample: 'Sanganer, Tonk Road', get: (s) => s.area_beat },
  { key: 'commission_pct', label: 'Commission %', sample: '2.5', get: (s) => s.commission_pct },
  { key: 'monthly_target', label: 'Monthly target', sample: '100000', get: (s) => s.monthly_target },
]
const num = (v: string, label: string, fallback: string | null) => {
  const t = (v ?? '').replace(/[,₹%\s]/g, '')
  if (!t) return fallback
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`${label} must be a number`)
  return t
}
const buildFromRow = (r: Record<string, string>) => ({
  code: r.code || null, name: r.name, mobile: r.mobile || null, email: r.email || null, area_beat: r.area_beat || null,
  commission_pct: num(r.commission_pct, 'Commission %', '0'), monthly_target: num(r.monthly_target, 'Monthly target', null),
  allow_login: false, is_active: true,
})

export default function Salesmen() {
  const { can } = useAccess()
  const manage = can('can_manage_erp_masters')
  const columns = useColumns('erp-salesmen', COLUMNS)
  const [q, setQ] = useState('')
  const [show, setShow] = useState<Show>('active')
  const [editing, setEditing] = useState<Salesman | 'new' | null>(null)
  const list = useQuery(`erp-salesmen-${q}-${show}`, () => erp.salesmen({ q: q.trim() || undefined, active: show === 'all' ? undefined : show === 'active' }))
  const removing = useRun(() => list.reload())
  const [login, setLogin] = useState('')
  const [hasLedgers, setHasLedgers] = useState('')
  const extra = (show !== 'active' ? 1 : 0) + (login ? 1 : 0) + (hasLedgers ? 1 : 0)
  const rows = (list.data ?? []).filter((m) =>
    (!login || (login === 'yes') === m.allow_login) && (!hasLedgers || (hasLedgers === 'yes') === m.ledgers > 0))

  function remove(s: Salesman) {
    if (!window.confirm(`Delete the salesman “${s.name}”? This cannot be undone.`)) return
    void removing.run(() => erp.deleteSalesman(s.id), 'That salesman could not be deleted')
  }

  return (
    <>
      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '14px 18px', flexWrap: 'wrap' }}>
          <div>
            <h2 className="card-title" style={{ margin: 0 }}>Salesman</h2>
            <p className="muted-sm" style={{ margin: '2px 0 0' }}>
              {rows.length} salesmen · Who sells for you: area or beat, commission % and monthly target. A ledger keeps its salesman; every new sale bill starts with them.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <ImportExport name="salesmen" columns={IO} rows={rows} canImport={manage} build={buildFromRow}
              save={(b) => erp.saveSalesman(b)} onDone={() => list.reload()} />
            <ColumnSettings defs={COLUMNS} order={columns.pref.order} hidden={columns.pref.hidden}
              onSave={columns.save} onReset={columns.reset} />
            {manage && <button className="btn btn-primary" onClick={() => setEditing('new')}><IconPlus size={15} /> New salesman</button>}
          </div>
        </div>
        <div className="crm-bar itl-bar" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="crm-search">
            <IconSearch size={15} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search salesmen" aria-label="Search salesmen" />
          </div>
          <FilterPopup count={extra} onReset={() => { setShow('active'); setLogin(''); setHasLedgers('') }}>
              <FilterField label="Status">
                <select value={show} onChange={(e) => setShow(e.target.value as Show)}>
                  <option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All</option>
                </select>
              </FilterField>
              <FilterField label="Login">
                <select value={login} onChange={(e) => setLogin(e.target.value)}>
                  <option value="">Any</option><option value="yes">Allowed</option><option value="no">Not allowed</option>
                </select>
              </FilterField>
              <FilterField label="Ledgers">
                <select value={hasLedgers} onChange={(e) => setHasLedgers(e.target.value)}>
                  <option value="">Any</option><option value="yes">With ledgers</option><option value="no">Without ledgers</option>
                </select>
              </FilterField>
          </FilterPopup>
        </div>
        {list.error && <ErrorNote>{list.error}</ErrorNote>}
        {removing.error && <div style={{ margin: 10 }}><ErrorNote>{removing.error}</ErrorNote></div>}
        {!list.data ? <Loading /> : rows.length === 0 ? (
          <EmptyState icon={<IconBuilding size={22} />} title={q ? 'Nothing matches' : 'No salesmen yet'}
            body={q ? 'Change the search.' : 'Add the first salesman, then choose them on a ledger.'} />
        ) : (
          <div className="table-wrap"><table className="itl">
            <thead><tr>
              {columns.visible.map((c) => <th key={c.key}>{c.label}</th>)}
              {manage && <th className="itl-c-act">Actions</th>}
            </tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className={s.is_active ? '' : 'is-off'}>
                  {columns.visible.map((c) => {
                    const def = COLUMNS.find((d) => d.key === c.key)!
                    return <td key={c.key} className={def.className}>{def.td(s)}</td>
                  })}
                  {manage && (
                    <td className="itl-c-act">
                      <div className="crm-row-actions itl-actions">
                        <button className="crm-icon-btn" onClick={() => setEditing(s)} title="Edit" aria-label={`Edit ${s.name}`}><IconEdit size={14} /></button>
                        <button className="crm-icon-btn crm-icon-danger" onClick={() => remove(s)} disabled={removing.busy} title="Delete" aria-label={`Delete ${s.name}`}><IconTrash size={14} /></button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>
      {editing && <SalesmanForm salesman={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload() }} />}
    </>
  )
}

/** Add or edit a salesman. Also opened from a ledger's Salesman field. */
export function SalesmanForm({ salesman, onClose, onSaved }: { salesman: Salesman | null; onClose: () => void; onSaved: (s: Salesman) => void }) {
  const fields = useFieldModes('erp-salesman-form', FIELDS)
  const fm = fields.mode
  const rq = (k: string) => fm(k) === 'mandatory'
  const [f, setF] = useState({
    code: salesman?.code ?? '', name: salesman?.name ?? '', mobile: salesman?.mobile ?? '', email: salesman?.email ?? '',
    area_beat: salesman?.area_beat ?? '', commission_pct: salesman ? String(Number(salesman.commission_pct)) : '0',
    monthly_target: salesman?.monthly_target ? String(Number(salesman.monthly_target)) : '', allow_login: salesman?.allow_login ?? false,
    is_active: salesman?.is_active ?? true,
  })
  const { busy, error, run } = useRun()
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((c) => ({ ...c, [k]: v }))

  const digits = f.mobile.replace(/[\s\-()]/g, '').replace(/^\+91/, '')
  const problems: Record<string, string> = {}
  if (f.mobile && !/^[6-9]\d{9}$/.test(digits)) problems.mobile = 'Enter a valid 10-digit mobile number.'
  if (f.email && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(f.email)) problems.email = 'Enter a valid email address.'
  if (f.commission_pct && Number(f.commission_pct) > 100) problems.commission = 'Commission cannot be more than 100%.'
  const empty: Record<string, boolean> = { mobile: !f.mobile.trim(), email: !f.email.trim(), area: !f.area_beat.trim(), target: !f.monthly_target.trim() }
  const needed = Object.keys(empty).some((k) => rq(k) && fm(k) !== 'hide' && empty[k])
  const missing = !f.name.trim() || needed
  const invalid = Object.keys(problems).length > 0
  const err = (k: string): ReactNode => (problems[k] ? <span style={{ color: '#dc2626' }}>{problems[k]}</span> : undefined)

  function save() {
    const body = {
      code: f.code.trim() || null, name: f.name.trim(), mobile: f.mobile.trim() || null, email: f.email.trim() || null,
      area_beat: f.area_beat.trim() || null, commission_pct: f.commission_pct || '0',
      monthly_target: f.monthly_target.trim() || null, allow_login: f.allow_login, is_active: f.is_active,
    }
    void run(async () => onSaved(await erp.saveSalesman(body, salesman?.id)), 'That salesman could not be saved')
  }

  const nodes: Record<string, ReactNode> = {
    code: fm('code') !== 'hide' && (
      <Field label="Code"><input value={f.code} maxLength={24} placeholder="RK" onChange={(e) => set('code', e.target.value.toUpperCase())} /></Field>
    ),
    name: (
      <Field label="Salesman name" required><input value={f.name} maxLength={120} autoFocus onChange={(e) => set('name', e.target.value)} /></Field>
    ),
    mobile: fm('mobile') !== 'hide' && (
      <Field label="Mobile" required={rq('mobile')} hint={err('mobile')}>
        <input value={f.mobile} inputMode="tel" maxLength={16} placeholder="98765 43210" onChange={(e) => set('mobile', e.target.value.replace(/[^\d+\s\-()]/g, ''))} />
      </Field>
    ),
    email: fm('email') !== 'hide' && (
      <Field label="Email" required={rq('email')} hint={err('email')}><input value={f.email} inputMode="email" onChange={(e) => set('email', e.target.value)} /></Field>
    ),
    area: fm('area') !== 'hide' && (
      <Field label="Area / Beat" required={rq('area')}><input value={f.area_beat} maxLength={160} placeholder="Sanganer, Tonk Road" onChange={(e) => set('area_beat', e.target.value)} /></Field>
    ),
    commission: fm('commission') !== 'hide' && (
      <Field label="Commission %" hint={err('commission') ?? 'On sales before GST, net of returns'}>
        <input value={f.commission_pct} inputMode="decimal" onChange={(e) => set('commission_pct', e.target.value.replace(/[^\d.]/g, ''))} />
      </Field>
    ),
    target: fm('target') !== 'hide' && (
      <Field label="Monthly target (₹)" required={rq('target')}>
        <input value={f.monthly_target} inputMode="decimal" onChange={(e) => set('monthly_target', e.target.value.replace(/[^\d.]/g, ''))} />
      </Field>
    ),
    login: fm('login') !== 'hide' && (
      <div style={{ gridColumn: '1 / -1' }}>
        <label className="crm-check"><input type="checkbox" checked={f.allow_login} onChange={(e) => set('allow_login', e.target.checked)} /> Allow salesman login</label>
      </div>
    ),
  }

  return (
    <Dialog wide title={salesman ? `Edit salesman · ${salesman.code}` : 'New salesman'} subtitle="Add a salesman to the list" onClose={onClose}
            footer={<>
              {error && <span className="error">{error}</span>}
              {!error && missing && <span className="lf-foot-note lf-foot-link">Salesman name required</span>}
              {!error && !missing && invalid && <span className="lf-foot-note lf-foot-link">Check the fields marked in red</span>}
              <button className="btn crm-push" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || missing || invalid} onClick={save}>{busy ? 'Saving…' : salesman ? 'Save' : 'Add salesman'}</button>
            </>}>
      <div style={{ display: 'grid', gap: 14, padding: '8px 24px 20px', overflowY: 'auto', minHeight: 0, flex: 1, alignContent: 'start' }}>
        <div className="lf-settings">
          <FieldSettings defs={FIELDS} sections={SECTIONS} modes={fields.modes} order={fields.order}
                         onSave={fields.save} onReset={fields.reset} title="Salesman fields" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1.4fr', gap: 14 }}>
          {fields.orderOf('main').map((key) => <div key={key} style={{ display: 'contents' }}>{nodes[key]}</div>)}
        </div>
        {salesman && (
          <label className="crm-check"><input type="checkbox" checked={f.is_active} onChange={(e) => set('is_active', e.target.checked)} /> Active</label>
        )}
      </div>
    </Dialog>
  )
}

