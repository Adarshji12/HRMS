/* Master -> ERP Master -> Walk-in Customers: cash customers kept as a simple list, not as ledgers. */

import { useState, type ReactNode } from 'react'
import { useQuery } from '../../lib/useQuery'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconBuilding, IconEdit, IconPlus, IconSearch, IconTrash } from '../../components/Icons'
import { ColumnSettings, FieldSettings, useColumns, useFieldModes, type ColumnDef, type FieldDef, type FieldSection } from '../../components/ViewSettings'
import RowShare from '../../components/RowShare'
import ImportExport, { type IoColumn } from '../../components/ImportExport'
import FilterPopup, { FilterField } from '../../components/FilterPopup'
import { Dialog, Field, newestFirst, useAccess, useRun } from './parts'
import { erp, rupees, type Walkin } from './api'

type Show = 'active' | 'inactive' | 'all'

const day = (iso: string | null) => (iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—')
const added = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })

const COLUMNS: Array<ColumnDef & { td: (w: Walkin) => ReactNode; className?: string }> = [
  { key: 'name', label: 'Name', locked: true, td: (w) => <b>{w.name}</b> },
  { key: 'mobile', label: 'Mobile', className: 'crm-nowrap', td: (w) => w.mobile ?? '—' },
  { key: 'whatsapp', label: 'WhatsApp', className: 'crm-nowrap', td: (w) => w.whatsapp ?? '—' },
  { key: 'email', label: 'Email', td: (w) => w.email ?? '—' },
  { key: 'dob', label: 'Date of birth', className: 'crm-nowrap', td: (w) => day(w.dob) },
  { key: 'anniversary', label: 'Anniversary', className: 'crm-nowrap', td: (w) => day(w.anniversary) },
  { key: 'remark', label: 'Remark', td: (w) => w.remark ?? '—' },
  { key: 'added', label: 'Added on', className: 'crm-nowrap', td: (w) => added(w.created_at) },
  { key: 'bills', label: 'Bills', initial: false, td: (w) => String(w.bills) },
  { key: 'bought', label: 'Total bought', initial: false, className: 'crm-nowrap', td: (w) => (Number(w.total_bought) ? rupees(w.total_bought) : '—') },
  { key: 'last', label: 'Last bill', initial: false, className: 'crm-nowrap', td: (w) => (w.last_bill ? day(w.last_bill) : '—') },
]

const SECTIONS: FieldSection[] = [{ id: 'main', label: 'Walk-in customer' }]
const FIELDS: FieldDef[] = [
  { key: 'name', label: 'Name', section: 'main', fixed: true },
  { key: 'email', label: 'Email', section: 'main' },
  { key: 'mobile', label: 'Mobile', section: 'main' },
  { key: 'whatsapp', label: 'WhatsApp', section: 'main' },
  { key: 'dob', label: 'Date of birth', section: 'main' },
  { key: 'anniversary', label: 'Anniversary date', section: 'main' },
  { key: 'remark', label: 'Remark', section: 'main' },
]

const IO: IoColumn<Walkin>[] = [
  { key: 'name', label: 'Name', required: true, sample: 'Asha Verma', get: (w) => w.name },
  { key: 'mobile', label: 'Mobile', sample: '9876543210', get: (w) => w.mobile },
  { key: 'whatsapp', label: 'WhatsApp', sample: '', get: (w) => w.whatsapp },
  { key: 'email', label: 'Email', sample: '', get: (w) => w.email },
  { key: 'dob', label: 'Date of birth', sample: '1990-05-14', get: (w) => w.dob },
  { key: 'anniversary', label: 'Anniversary', sample: '', get: (w) => w.anniversary },
  { key: 'remark', label: 'Remark', sample: '', get: (w) => w.remark },
]
const isoDate = (v: string, label: string) => {
  const t = (v ?? '').trim()
  if (!t) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new Error(`${label} must be written as YYYY-MM-DD`)
  return t
}
const buildFromRow = (r: Record<string, string>) => ({
  name: r.name, mobile: r.mobile || null, whatsapp: r.whatsapp || null, email: r.email || null,
  dob: isoDate(r.dob, 'Date of birth'), anniversary: isoDate(r.anniversary, 'Anniversary'), remark: r.remark || null, is_active: true,
})


export default function Walkins() {
  const { can } = useAccess()
  const manage = can('can_manage_erp_masters')
  const columns = useColumns('erp-walkins', COLUMNS)
  const [q, setQ] = useState('')
  const [show, setShow] = useState<Show>('active')
  const [editing, setEditing] = useState<Walkin | 'new' | null>(null)
  const list = useQuery(`erp-walkins-${q}-${show}`, () => erp.walkins({ q: q.trim() || undefined, active: show === 'all' ? undefined : show === 'active' }))
  const removing = useRun(() => list.reload())
  const [hasMobile, setHasMobile] = useState('')
  const [hasEmail, setHasEmail] = useState('')
  const [month, setMonth] = useState('')
  const extra = (show !== 'active' ? 1 : 0) + (hasMobile ? 1 : 0) + (hasEmail ? 1 : 0) + (month ? 1 : 0)
  const rows = newestFirst(list.data ?? []).filter((w) =>
    (!hasMobile || (hasMobile === 'yes') === !!w.mobile) && (!hasEmail || (hasEmail === 'yes') === !!w.email)
    && (!month || (w.dob ? String(Number(w.dob.slice(5, 7))) === month : false)))

  function remove(w: Walkin) {
    if (!window.confirm(`Delete the walk-in customer “${w.name}”? This cannot be undone.`)) return
    void removing.run(() => erp.deleteWalkin(w.id), 'That customer could not be deleted')
  }

  return (
    <>
      <section className="card" style={{ padding: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '14px 18px', flexWrap: 'wrap' }}>
          <h2 className="card-title" style={{ margin: 0 }}>Walk-In Customers</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <ImportExport name="walk-in customers" columns={IO} rows={rows} canImport={manage} build={buildFromRow}
              save={(b) => erp.saveWalkin(b)} onDone={() => list.reload()} />
            <ColumnSettings defs={COLUMNS} order={columns.pref.order} hidden={columns.pref.hidden}
              onSave={columns.save} onReset={columns.reset} />
            {manage && <button className="btn btn-primary" onClick={() => setEditing('new')}><IconPlus size={15} /> New walk-in customer</button>}
          </div>
        </div>
        <div className="crm-bar itl-bar" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="crm-search">
            <IconSearch size={15} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search walk-in customers" aria-label="Search walk-in customers" />
          </div>
          <FilterPopup count={extra} onReset={() => { setShow('active'); setHasMobile(''); setHasEmail(''); setMonth('') }}>
              <FilterField label="Status">
                <select value={show} onChange={(e) => setShow(e.target.value as Show)}>
                  <option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All</option>
                </select>
              </FilterField>
              <FilterField label="Mobile">
                <select value={hasMobile} onChange={(e) => setHasMobile(e.target.value)}>
                  <option value="">Any</option><option value="yes">Has a mobile</option><option value="no">No mobile</option>
                </select>
              </FilterField>
              <FilterField label="Email">
                <select value={hasEmail} onChange={(e) => setHasEmail(e.target.value)}>
                  <option value="">Any</option><option value="yes">Has an email</option><option value="no">No email</option>
                </select>
              </FilterField>
              <FilterField label="Birthday in">
                <select value={month} onChange={(e) => setMonth(e.target.value)}>
                  <option value="">Any month</option>
                  {['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
                    .map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
                </select>
              </FilterField>
          </FilterPopup>
        </div>
        {list.error && <ErrorNote>{list.error}</ErrorNote>}
        {removing.error && <div style={{ margin: 10 }}><ErrorNote>{removing.error}</ErrorNote></div>}
        {!list.data ? <Loading /> : rows.length === 0 ? (
          <EmptyState icon={<IconBuilding size={22} />} title={q ? 'Nothing matches' : 'No walk-in customers yet'}
            body={q ? 'Change the search.' : 'Add a walk-in customer to keep their contact and the dates worth a greeting.'} />
        ) : (
          <div className="table-wrap"><table className="itl">
            <thead><tr>
              {columns.visible.map((c) => <th key={c.key}>{c.label}</th>)}
              {manage && <th className="itl-c-act">Actions</th>}
            </tr></thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.id} className={w.is_active ? '' : 'is-off'}>
                  {columns.visible.map((c) => {
                    const def = COLUMNS.find((d) => d.key === c.key)!
                    return <td key={c.key} className={def.className}>{def.td(w)}</td>
                  })}
                  {manage && (
                    <td className="itl-c-act">
                      <div className="crm-row-actions itl-actions">
                        <RowShare name="walk-in customer" title={w.name} columns={IO} row={w} />
                        <button className="crm-icon-btn" onClick={() => setEditing(w)} title="Edit" aria-label={`Edit ${w.name}`}><IconEdit size={14} /></button>
                        <button className="crm-icon-btn crm-icon-danger" onClick={() => remove(w)} disabled={removing.busy} title="Delete" aria-label={`Delete ${w.name}`}><IconTrash size={14} /></button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>
      {editing && <WalkinForm walkin={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload() }} />}
    </>
  )
}

function WalkinForm({ walkin, onClose, onSaved }: { walkin: Walkin | null; onClose: () => void; onSaved: (w: Walkin) => void }) {
  const fields = useFieldModes('erp-walkin-form', FIELDS)
  const fm = fields.mode
  const rq = (k: string) => fm(k) === 'mandatory'
  const [f, setF] = useState({
    name: walkin?.name ?? '', mobile: walkin?.mobile ?? '', whatsapp: walkin?.whatsapp ?? '', email: walkin?.email ?? '',
    dob: walkin?.dob ?? '', anniversary: walkin?.anniversary ?? '', remark: walkin?.remark ?? '', is_active: walkin?.is_active ?? true,
  })
  // WhatsApp is the mobile number unless the box is unticked.
  const [sameWa, setSameWa] = useState(!walkin || !walkin.whatsapp || walkin.whatsapp === walkin.mobile)
  const { busy, error, run } = useRun()
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((c) => ({ ...c, [k]: v }))
  const ten = (s: string) => s.replace(/[\s\-()]/g, '').replace(/^\+91/, '')

  const problems: Record<string, string> = {}
  if (f.mobile && !/^[6-9]\d{9}$/.test(ten(f.mobile))) problems.mobile = 'Enter a valid 10-digit mobile number.'
  if (!sameWa && f.whatsapp && !/^[6-9]\d{9}$/.test(ten(f.whatsapp))) problems.whatsapp = 'Enter a valid 10-digit number.'
  if (f.email && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(f.email)) problems.email = 'Enter a valid email address.'
  if (f.dob && f.dob > new Date().toISOString().slice(0, 10)) problems.dob = 'Date of birth cannot be in the future.'
  const empty: Record<string, boolean> = { mobile: !f.mobile.trim(), whatsapp: !(sameWa ? f.mobile : f.whatsapp).trim(), email: !f.email.trim(), dob: !f.dob, anniversary: !f.anniversary, remark: !f.remark.trim() }
  const needed = Object.keys(empty).some((k) => rq(k) && fm(k) !== 'hide' && empty[k])
  const missing = !f.name.trim() || needed
  const invalid = Object.keys(problems).length > 0
  const err = (k: string): ReactNode => (problems[k] ? <span style={{ color: '#dc2626' }}>{problems[k]}</span> : undefined)

  function save() {
    const body = {
      name: f.name.trim(), mobile: f.mobile.trim() || null, whatsapp: (sameWa ? f.mobile : f.whatsapp).trim() || null, email: f.email.trim() || null,
      dob: f.dob || null, anniversary: f.anniversary || null, remark: f.remark.trim() || null, is_active: f.is_active,
    }
    void run(async () => onSaved(await erp.saveWalkin(body, walkin?.id)), 'That customer could not be saved')
  }

  const wide: React.CSSProperties = { gridColumn: '1 / -1' }
  const phone = (k: 'mobile' | 'whatsapp') => (e: React.ChangeEvent<HTMLInputElement>) => set(k, e.target.value.replace(/[^\d+\s\-()]/g, ''))
  const nodes: Record<string, ReactNode> = {
    name: <Field label="Name" required><input value={f.name} maxLength={160} autoFocus onChange={(e) => set('name', e.target.value)} /></Field>,
    mobile: fm('mobile') !== 'hide' && (
      <Field label="Mobile" required={rq('mobile')} hint={err('mobile')}><input value={f.mobile} inputMode="tel" maxLength={16} placeholder="98765 43210" onChange={phone('mobile')} /></Field>
    ),
    whatsapp: fm('whatsapp') !== 'hide' && (
      <div>
        <Field label="WhatsApp" required={rq('whatsapp')} hint={sameWa ? undefined : err('whatsapp')}><input value={sameWa ? f.mobile : f.whatsapp} disabled={sameWa} inputMode="tel" maxLength={16} placeholder="Same as mobile" onChange={phone('whatsapp')} /></Field>
        <label className="crm-check" style={{ marginTop: 6 }}><input type="checkbox" checked={sameWa} onChange={(e) => { setSameWa(e.target.checked); if (!e.target.checked && !f.whatsapp) set('whatsapp', f.mobile) }} /> Same as mobile</label>
      </div>
    ),
    email: fm('email') !== 'hide' && (
      <Field label="Email" required={rq('email')} hint={err('email')}><input value={f.email} inputMode="email" placeholder="name@example.com" onChange={(e) => set('email', e.target.value)} /></Field>
    ),
    dob: fm('dob') !== 'hide' && (
      <Field label="Date of birth" required={rq('dob')} hint={err('dob')}><input type="date" value={f.dob} onChange={(e) => set('dob', e.target.value)} /></Field>
    ),
    anniversary: fm('anniversary') !== 'hide' && (
      <Field label="Anniversary date" required={rq('anniversary')}><input type="date" value={f.anniversary} onChange={(e) => set('anniversary', e.target.value)} /></Field>
    ),
    remark: fm('remark') !== 'hide' && (
      <div style={wide}><Field label="Remark" required={rq('remark')}><textarea rows={3} value={f.remark} onChange={(e) => set('remark', e.target.value)} /></Field></div>
    ),
  }

  return (
    <Dialog wide title={walkin ? 'Edit walk-in customer' : 'New walk-in customer'} subtitle={walkin ? undefined : 'Add a walk-in customer to the list'} onClose={onClose}
            footer={<>
              {error && <span className="error">{error}</span>}
              {!error && missing && <span className="lf-foot-note lf-foot-link">Name required</span>}
              {!error && !missing && invalid && <span className="lf-foot-note lf-foot-link">Check the fields marked in red</span>}
              <button className="btn crm-push" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || missing || invalid} onClick={save}>{busy ? 'Saving…' : walkin ? 'Save' : 'Add walk-in customer'}</button>
            </>}>
      <div style={{ display: 'grid', gap: 14, padding: '8px 24px 20px', overflowY: 'auto', minHeight: 0, flex: 1, alignContent: 'start' }}>
        <div className="lf-settings">
          <FieldSettings defs={FIELDS} sections={SECTIONS} modes={fields.modes} order={fields.order}
                         onSave={fields.save} onReset={fields.reset} title="Walk-in customer fields" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          {fields.orderOf('main').map((key) => <div key={key} style={{ display: 'contents' }}>{nodes[key]}</div>)}
        </div>
        {walkin && <label className="crm-check"><input type="checkbox" checked={f.is_active} onChange={(e) => set('is_active', e.target.checked)} /> Active</label>}
      </div>
    </Dialog>
  )
}

