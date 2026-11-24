/* Master -> ERP Master -> Ledger: a party's own account — name, group, station,
 * opening balance, credit terms, tax and bank details. Nothing posts to a ledger
 * yet, so its balance is its opening balance. */

import { Fragment, useState, type ReactNode } from 'react'
import { useQuery } from '../../lib/useQuery'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconBuilding, IconEdit, IconPlus, IconSearch, IconTrash } from '../../components/Icons'
import { ColumnSettings, FieldSettings, useColumns, useFieldModes, type ColumnDef, type FieldDef, type FieldSection } from '../../components/ViewSettings'
import ImportExport, { type IoColumn } from '../../components/ImportExport'
import FilterPopup, { FilterField } from '../../components/FilterPopup'
import { crm } from '../crm/api'
import TreeSelect from '../../components/TreeSelect'
import { Dialog, Field, useAccess, useRun } from './parts'

import { erp, rupees, type AccountGroup, type Ledger, type Salesman } from './api'
import { SalesmanForm } from './ErpSalesmen'

/** The first list in the Account group dropdown: who the ledger is a party to. */
export const PARTY_GROUPS: Array<[string, string]> = [
  ['Sundry Debtors', 'Sundry Debtors — customer'],
  ['Sundry Creditors', 'Sundry Creditors — supplier'],
  ['Sundry Debtors & Creditors', 'Both — customer and supplier'],
]
const LEDGER_TYPES: Array<[Ledger['ledger_type'], string]> = [
  ['unregistered', 'Unregistered'], ['registered', 'Registered'], ['composition', 'Composition'],
  ['consumer', 'Consumer'], ['overseas', 'Overseas'],
]
const BILL_AT: Array<[Ledger['bill_at'], string]> = [
  ['sale_bill_setting', 'As Sale Bill Setting'], ['mrp', 'MRP'], ['retail', 'Retail rate'],
  ['wholesale', 'Wholesale rate'], ['special', 'Special rate'],
]

const BLANK = {
  code: '', name: '', account_group: 'Sundry Debtors', station: '', mail_to: '', address1: '', address2: '', address3: '',
  country: 'India', state: '', city: '', pincode: '', category: '', balancing_method: 'bill_by_bill',
  opening_balance: '', opening_type: 'dr', credit_days: '0', credit_limit: '', mobile: '', whatsapp: '', mobile1: '',
  ledger_type: 'unregistered', gstin: '', pan: '', contact_person: '', designation: '', email: '', dob: '',
  anniversary: '', website: '', bank_holder: '', bank_name: '', bank_account: '', ifsc: '', bank_branch: '',
  bill_at: 'sale_bill_setting', salesman: '', area_route: '', notes: '', is_active: true,
}
type Form = typeof BLANK

const balanceText = (l: Ledger) => {
  const n = Number(l.balance || 0)
  return n === 0 ? '—' : `${rupees(n)} ${l.balance_type === 'cr' ? 'Cr' : 'Dr'}`
}

const COLUMNS: Array<ColumnDef & { td: (l: Ledger) => ReactNode; className?: string }> = [
  { key: 'name', label: 'Ledger name', locked: true, td: (l) => (
    <>
      <b>{l.name}</b>
      {l.account_group && <span className="crm-sub"> · {l.account_group}</span>}
    </>
  ) },
  { key: 'code', label: 'Code', initial: false, td: (l) => <span className="crm-code">{l.code}</span> },
  { key: 'station', label: 'Station', td: (l) => l.station ?? '—' },
  { key: 'mobile', label: 'Mobile', initial: false, td: (l) => l.mobile ?? '—' },
  { key: 'gstin', label: 'GSTIN', initial: false, td: (l) => l.gstin ?? '—' },
  { key: 'balance', label: '₹ Balance', className: 'crm-nowrap', td: (l) => balanceText(l) },
  { key: 'group', label: 'Account group', initial: false, td: (l) => l.account_group },
  { key: 'state', label: 'State', initial: false, td: (l) => l.state ?? '—' },
  { key: 'city', label: 'City', initial: false, td: (l) => l.city ?? '—' },
  { key: 'pincode', label: 'PIN code', initial: false, td: (l) => l.pincode ?? '—' },
  { key: 'email', label: 'Email', initial: false, td: (l) => l.email ?? '—' },
  { key: 'pan', label: 'PAN', initial: false, td: (l) => l.pan ?? '—' },
  { key: 'type', label: 'Ledger type', initial: false, td: (l) => LEDGER_TYPES.find(([k]) => k === l.ledger_type)?.[1] ?? l.ledger_type },
  { key: 'contact', label: 'Contact person', initial: false, td: (l) => l.contact_person ?? '—' },
  { key: 'category', label: 'Category', initial: false, td: (l) => l.category ?? '—' },
  { key: 'days', label: 'Credit days', initial: false, className: 'crm-nowrap', td: (l) => String(l.credit_days) },
  { key: 'limit', label: 'Credit limit', initial: false, className: 'crm-nowrap', td: (l) => (l.credit_limit ? rupees(l.credit_limit) : '—') },
  { key: 'salesman', label: 'Salesman', initial: false, td: (l) => l.salesman ?? '—' },
  { key: 'route', label: 'Area / Route', initial: false, td: (l) => l.area_route ?? '—' },
  { key: 'status', label: 'Status', initial: false, td: (l) => (l.is_active ? 'Active' : 'Inactive') },
]

/** What the ledger form can show, make mandatory or hide. The name, group,
 *  station, state and mobile number are what the server needs. */
const LEDGER_SECTIONS: FieldSection[] = [
  { id: 'general', label: 'General info' },
  { id: 'balance', label: 'Balance' },
  { id: 'numbers', label: 'Contact numbers' },
  { id: 'tax', label: 'GST / Tax Details' },
  { id: 'contact', label: 'Contact Info' },
  { id: 'bank', label: 'Bank Details' },
  { id: 'others', label: 'Others' },
]
const LEDGER_FIELDS: FieldDef[] = [
  { key: 'name', label: 'Ledger name', section: 'general', fixed: true },
  { key: 'account_group', label: 'Account group', section: 'general', fixed: true },
  { key: 'station', label: 'Station', section: 'general', fixed: true },
  { key: 'mail_to', label: 'Mail to', section: 'general' },
  { key: 'address', label: 'Address', section: 'general' },
  { key: 'country', label: 'Country', section: 'general' },
  { key: 'state', label: 'State', section: 'general', fixed: true },
  { key: 'city', label: 'City', section: 'general' },
  { key: 'pincode', label: 'PIN code', section: 'general' },
  { key: 'category', label: 'Ledger category', section: 'general' },
  { key: 'balancing_method', label: 'Balancing method', section: 'balance', optionalOnly: true },
  { key: 'opening_balance', label: 'Opening balance', section: 'balance' },
  { key: 'credit_days', label: 'Credit days', section: 'balance' },
  { key: 'credit_limit', label: 'Credit limit', section: 'balance' },
  { key: 'mobile', label: 'Mobile no.', section: 'numbers', fixed: true },
  { key: 'whatsapp', label: 'WhatsApp no.', section: 'numbers' },
  { key: 'mobile1', label: 'Mobile no. 1', section: 'numbers' },
  { key: 'ledger_type', label: 'Ledger type', section: 'tax', optionalOnly: true },
  { key: 'gstin', label: 'GSTIN', section: 'tax' },
  { key: 'pan', label: 'PAN', section: 'tax' },
  { key: 'contact_person', label: 'Contact person', section: 'contact' },
  { key: 'designation', label: 'Designation', section: 'contact' },
  { key: 'email', label: 'Email', section: 'contact' },
  { key: 'dob', label: 'Date of birth', section: 'contact' },
  { key: 'anniversary', label: 'Anniversary date', section: 'contact' },
  { key: 'website', label: 'Website', section: 'contact' },
  { key: 'bank_holder', label: 'Account holder name', section: 'bank' },
  { key: 'bank_name', label: 'Bank name', section: 'bank' },
  { key: 'bank_account', label: 'Account no.', section: 'bank' },
  { key: 'ifsc', label: 'IFSC', section: 'bank' },
  { key: 'bank_branch', label: 'Branch', section: 'bank' },
  { key: 'bill_at', label: 'Bill at', section: 'others', optionalOnly: true },
  { key: 'salesman', label: 'Salesman', section: 'others' },
  { key: 'area_route', label: 'Area / Route', section: 'others' },
  { key: 'notes', label: 'Notes', section: 'others' },
]

const IO: IoColumn<Ledger>[] = [
  { key: 'name', label: 'Ledger name', required: true, sample: 'Gupta Medical', get: (l) => l.name },
  { key: 'account_group', label: 'Account group', required: true, sample: 'Sundry Debtors', get: (l) => l.account_group },
  { key: 'station', label: 'Station', sample: 'Chittorgarh Town', get: (l) => l.station },
  { key: 'state', label: 'State', required: true, sample: 'Rajasthan', get: (l) => l.state },
  { key: 'city', label: 'City', sample: '', get: (l) => l.city },
  { key: 'pincode', label: 'PIN code', sample: '302039', get: (l) => l.pincode },
  { key: 'address1', label: 'Address', sample: '', get: (l) => l.address1 },
  { key: 'mobile', label: 'Mobile no.', required: true, sample: '9098789878', get: (l) => l.mobile },
  { key: 'email', label: 'Email', sample: '', get: (l) => l.email },
  { key: 'gstin', label: 'GSTIN', sample: '', get: (l) => l.gstin },
  { key: 'pan', label: 'PAN', sample: '', get: (l) => l.pan },
  { key: 'opening_balance', label: 'Opening balance', sample: '0', get: (l) => l.opening_balance },
  { key: 'opening_type', label: 'Dr / Cr', sample: 'dr', get: (l) => l.opening_type },
  { key: 'credit_days', label: 'Credit days', sample: '0', get: (l) => l.credit_days },
]

const num = (v: string, label: string, fallback = '0') => {
  const t = (v ?? '').replace(/[,₹\s]/g, '')
  if (!t) return fallback
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`${label} must be a number`)
  return t
}
const buildFromRow = (r: Record<string, string>) => {
  const dc = (r.opening_type ?? '').trim().toLowerCase()
  if (dc && dc !== 'dr' && dc !== 'cr') throw new Error('Dr / Cr must be dr or cr')
  return {
    ...toBody({ ...BLANK, ...r, opening_type: dc || 'dr', credit_days: num(r.credit_days, 'Credit days'),
      opening_balance: num(r.opening_balance, 'Opening balance') } as Form),
  }
}
const toBody = (f: Form) => ({
  code: f.code || null, name: f.name.trim(), account_group: f.account_group, station: f.station || null,
  mail_to: f.mail_to || null, address1: f.address1 || null, address2: f.address2 || null, address3: f.address3 || null,
  country: f.country || null, state: f.state || null, city: f.city || null, pincode: f.pincode || null,
  category: f.category || null, balancing_method: f.balancing_method,
  opening_balance: f.opening_balance === '' ? '0' : f.opening_balance, opening_type: f.opening_type,
  credit_days: Number(f.credit_days || 0), credit_limit: f.credit_limit === '' ? null : f.credit_limit,
  mobile: f.mobile || null, whatsapp: f.whatsapp || null, mobile1: f.mobile1 || null,
  ledger_type: f.ledger_type, gstin: f.gstin || null, pan: f.pan || null,
  contact_person: f.contact_person || null, designation: f.designation || null, email: f.email || null,
  dob: f.dob || null, anniversary: f.anniversary || null, website: f.website || null,
  bank_holder: f.bank_holder || null, bank_name: f.bank_name || null, bank_account: f.bank_account || null,
  ifsc: f.ifsc || null, bank_branch: f.bank_branch || null, bill_at: f.bill_at,
  salesman: f.salesman || null, area_route: f.area_route || null, notes: f.notes || null, is_active: f.is_active,
})

export default function Ledgers() {
  const { can } = useAccess()
  const manage = can('can_manage_erp_masters')
  const columns = useColumns('erp-ledgers', COLUMNS)
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<Ledger | 'new' | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const list = useQuery(`erp-ledgers-${q}`, () => erp.ledgers({ q: q.trim() || undefined }))
  const removing = useRun(() => list.reload())
  const [status, setStatus] = useState<'all' | 'active' | 'inactive'>('all')
  const [groupF, setGroupF] = useState('')
  const [typeF, setTypeF] = useState('')
  const [stateF, setStateF] = useState('')
  const all = list.data ?? []
  const extra = (status !== 'all' ? 1 : 0) + (groupF ? 1 : 0) + (typeF ? 1 : 0) + (stateF ? 1 : 0)
  const rows = all.filter((l) =>
    (status === 'all' || (status === 'active') === l.is_active) && (!groupF || l.account_group === groupF)
    && (!typeF || l.ledger_type === typeF) && (!stateF || l.state === stateF))
  const current = rows.find((l) => l.id === picked) ?? rows[0]

  function remove(l: Ledger) {
    if (!window.confirm(`Delete the ledger “${l.name}”? This cannot be undone.`)) return
    void removing.run(() => erp.deleteLedger(l.id), 'That ledger could not be deleted')
  }

  return (
    <>
      <div className="crm-bar itl-bar">
        <div className="crm-search">
          <IconSearch size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, code, station, mobile, GSTIN" aria-label="Search ledgers" />
        </div>
        <FilterPopup count={extra} onReset={() => { setStatus('all'); setGroupF(''); setTypeF(''); setStateF('') }}>
          <FilterField label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value as 'all' | 'active' | 'inactive')}>
              <option value="all">All</option><option value="active">Active</option><option value="inactive">Inactive</option>
            </select>
          </FilterField>
          <FilterField label="Account group">
            <select value={groupF} onChange={(e) => setGroupF(e.target.value)}>
              <option value="">Any</option>
              {[...new Set(all.map((l) => l.account_group))].sort().map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </FilterField>
          <FilterField label="Ledger type">
            <select value={typeF} onChange={(e) => setTypeF(e.target.value)}>
              <option value="">Any</option>
              {LEDGER_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </FilterField>
          <FilterField label="State">
            <select value={stateF} onChange={(e) => setStateF(e.target.value)}>
              <option value="">Any</option>
              {[...new Set(all.map((l) => l.state).filter((x): x is string => !!x))].sort().map((st) => <option key={st} value={st}>{st}</option>)}
            </select>
          </FilterField>
        </FilterPopup>
        {list.data && <span className="itl-count">Total no. of ledgers: {rows.length}</span>}
        <div className="crm-push" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <ImportExport name="ledgers" columns={IO} rows={rows} canImport={manage} build={buildFromRow}
            save={(b) => erp.saveLedger(b)} onDone={() => list.reload()} />
          <ColumnSettings defs={COLUMNS} order={columns.pref.order} hidden={columns.pref.hidden}
            onSave={columns.save} onReset={columns.reset} />
          {manage && <button className="btn btn-primary" onClick={() => setEditing('new')}><IconPlus size={15} /> Create</button>}
        </div>
      </div>
      {list.error && <ErrorNote>{list.error}</ErrorNote>}
      {removing.error && <div style={{ marginBottom: 10 }}><ErrorNote>{removing.error}</ErrorNote></div>}

      <section className="card itl-card">
        {!list.data ? <Loading /> : rows.length === 0 ? (
          <EmptyState icon={<IconBuilding size={22} />} title={q ? 'Nothing matches' : 'No ledgers yet'}
            body={q ? 'Change the search.' : 'A ledger is a customer, supplier or any other account you keep books for.'} />
        ) : (
          <div className="table-wrap"><table className="itl">
            <thead><tr>
              {columns.visible.map((c) => <th key={c.key}>{c.label}</th>)}
              {manage && <th className="itl-c-act">Action</th>}
            </tr></thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id} onClick={() => setPicked(l.id)} style={{ cursor: 'pointer' }}
                    className={l.id === current?.id ? 'is-picked' : undefined}>
                  {columns.visible.map((c) => {
                    const def = COLUMNS.find((d) => d.key === c.key)!
                    return <td key={c.key} className={def.className}>{def.td(l)}</td>
                  })}
                  {manage && (
                    <td className="itl-c-act" onClick={(e) => e.stopPropagation()}>
                      <div className="crm-row-actions itl-actions">
                        <button className="crm-icon-btn" onClick={() => setEditing(l)} title="Edit" aria-label={`Edit ${l.name}`}>
                          <IconEdit size={14} />
                        </button>
                        <button className="crm-icon-btn crm-icon-danger" onClick={() => remove(l)} disabled={removing.busy}
                          title="Delete" aria-label={`Delete ${l.name}`}>
                          <IconTrash size={14} />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>

      {current && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14, marginTop: 14 }}>
          <Panel title="Address">
            <Fact k="Mail to" v={current.mail_to || current.name} />
            <Fact k="Address" v={[current.address1, current.address2, current.address3].filter(Boolean).join(', ')} />
            <Fact k="Station" v={[current.station, current.pincode].filter(Boolean).join(' – ')} />
            <Fact k="Contact" v={current.mobile} />
            <Fact k="Email" v={current.email} />
            <Fact k="A/C group" v={current.account_group} />
          </Panel>
          <Panel title="Tax & other info">
            <Fact k="GSTIN" v={current.gstin} />
            <Fact k="PAN" v={current.pan} />
            <Fact k="Type" v={LEDGER_TYPES.find(([k]) => k === current.ledger_type)?.[1]} />
            <Fact k="State" v={current.state} />
            <Fact k="Cr. days" v={current.credit_days ? String(current.credit_days) : null} />
            <Fact k="Cr. limit" v={current.credit_limit ? rupees(current.credit_limit) : null} />
            <Fact k="Bill at" v={BILL_AT.find(([k]) => k === current.bill_at)?.[1]} />
          </Panel>
          <Panel title="Current status">
            <Fact k="Opening" v={balanceText(current)} />
            <Fact k="Balance" v={balanceText(current)} />
          </Panel>
        </div>
      )}

      {editing && (
        <LedgerForm ledger={editing === 'new' ? null : editing} known={rows.map((l) => l.account_group)} onClose={() => setEditing(null)}
                    onSaved={(l) => { setEditing(null); setPicked(l.id); list.reload() }} />
      )}
    </>
  )
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '10px 16px', fontWeight: 700, fontSize: 12, letterSpacing: '.06em', textTransform: 'uppercase', background: 'var(--surface-2)' }}>{title}</div>
      <dl style={{ margin: 0, padding: '10px 16px', display: 'grid', gap: 6 }}>{children}</dl>
    </section>
  )
}
function Fact({ k, v }: { k: string; v?: string | null }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 8, fontSize: 13 }}>
      <dt className="muted-sm">{k}</dt><dd style={{ margin: 0 }}>{v || '—'}</dd>
    </div>
  )
}

/* ----------------------------------------------------------------------------- form */

type Tab = 'tax' | 'contact' | 'bank' | 'others'

export function LedgerForm({ ledger, known, initialGroup, onClose, onSaved }: { ledger: Ledger | null; known: string[]; initialGroup?: string; onClose: () => void; onSaved: (l: Ledger) => void }) {
  const [addingGroup, setAddingGroup] = useState(false)
  const groups = useQuery<AccountGroup[]>('erp-account-groups', () => erp.accountGroups())
  const [addingTown, setAddingTown] = useState(false)
  const [addingMan, setAddingMan] = useState(false)
  const men = useQuery<Salesman[]>('erp-ledger-salesmen', () => erp.salesmen({ active: true }))
  const towns = useQuery<Town[]>('erp-ledger-towns', () => crm.masters<Town>('cities'))
  const [f, setF] = useState<Form>(() => {
    if (!ledger) return initialGroup ? { ...BLANK, account_group: initialGroup } : BLANK
    const next: Record<string, unknown> = { ...BLANK }
    for (const k of Object.keys(BLANK)) {
      const v = (ledger as unknown as Record<string, unknown>)[k]
      next[k] = v === null || v === undefined ? (BLANK as Record<string, unknown>)[k] : typeof v === 'number' ? String(v) : v
    }
    return next as Form
  })
  const [tab, setTab] = useState<Tab>('tax')
  const [sameWa, setSameWa] = useState(!ledger || !ledger.whatsapp || ledger.whatsapp === ledger.mobile)
  const { busy, error, run } = useRun()
  const states = useQuery<Array<{ id: string; name: string; is_active?: boolean }>>('crm-master-states-all', () => crm.masters('states'))
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((cur) => ({ ...cur, [k]: v }))
  const text = (k: keyof Form) => String(f[k] ?? '')
  const digits = (s: string) => s.replace(/[\s\-()]/g, '').replace(/^\+91/, '')

  const problems: Record<string, string> = {}
  if (f.mobile && !/^[6-9]\d{9}$/.test(digits(f.mobile))) problems.mobile = 'Enter a valid 10-digit mobile number.'
  if (!sameWa && f.whatsapp && !/^[6-9]\d{9}$/.test(digits(f.whatsapp))) problems.whatsapp = 'Enter a valid 10-digit number.'
  if (f.mobile1 && !/^[6-9]\d{9}$/.test(digits(f.mobile1))) problems.mobile1 = 'Enter a valid 10-digit number.'
  if (f.pincode && !/^\d{6}$/.test(f.pincode)) problems.pincode = 'PIN code must be 6 digits.'
  if (f.email && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(f.email)) problems.email = 'Enter a valid email address.'
  if (f.gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(f.gstin)) problems.gstin = 'Not a valid GSTIN.'
  if (f.pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(f.pan)) problems.pan = 'Not a valid PAN.'
  if (f.ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(f.ifsc)) problems.ifsc = 'IFSC is 11 characters, like SBIN0001234.'
  /* Typing or picking a town that is on the geography list fills its state, city and PIN. */
  function pickTown(name: string) {
    const hit = (towns.data ?? []).find((t) => t.name.toLowerCase() === name.trim().toLowerCase())
    setF((cur) => ({
      ...cur, station: name,
      ...(hit ? { state: hit.state_name ?? cur.state, city: hit.name, pincode: hit.pincode ?? cur.pincode } : {}),
    }))
  }
  const groupRows = groups.data ?? []
  const groupNames = new Set([...PARTY_GROUPS.map(([v]) => v), ...groupRows.map((g) => g.name)])
  // A group a ledger already carries that is no longer on the list still has to show.
  const strays = [...new Set([...known, f.account_group])].filter((g) => g && !groupNames.has(g)).sort()
  const fields = useFieldModes('erp-ledger-form', LEDGER_FIELDS)
  const fm = fields.mode
  const rq = (k: string) => fm(k) === 'mandatory'
  const empty: Record<string, boolean> = {
    mail_to: !f.mail_to.trim(), address: !f.address1.trim(), country: !f.country.trim(), city: !f.city.trim(),
    pincode: !f.pincode.trim(), category: !f.category.trim(), opening_balance: f.opening_balance === '',
    credit_days: f.credit_days === '' || f.credit_days === '0', credit_limit: f.credit_limit === '',
    whatsapp: !sameWa && !f.whatsapp.trim(), mobile1: !f.mobile1.trim(), gstin: !f.gstin.trim(), pan: !f.pan.trim(),
    contact_person: !f.contact_person.trim(), designation: !f.designation.trim(), email: !f.email.trim(),
    dob: !f.dob, anniversary: !f.anniversary, website: !f.website.trim(), bank_holder: !f.bank_holder.trim(),
    bank_name: !f.bank_name.trim(), bank_account: !f.bank_account.trim(), ifsc: !f.ifsc.trim(),
    bank_branch: !f.bank_branch.trim(), salesman: !f.salesman.trim(), area_route: !f.area_route.trim(),
    notes: !f.notes.trim(),
  }
  const needed = Object.keys(empty).some((k) => rq(k) && fm(k) !== 'hide' && empty[k])
  const missing = !f.name.trim() || !f.account_group || !f.state || !f.station.trim() || !f.mobile.trim() || needed
  const invalid = Object.keys(problems).length > 0
  const err = (k: string): ReactNode => (problems[k] ? <span style={{ color: '#dc2626' }}>{problems[k]}</span> : undefined)

  function save() {
    const body = toBody({ ...f, whatsapp: sameWa ? f.mobile : f.whatsapp })
    void run(async () => onSaved(await erp.saveLedger(body, ledger?.id)), 'That ledger could not be saved')
  }

  const grid = (cols: string): React.CSSProperties => ({ display: 'grid', gridTemplateColumns: cols, gap: 14 })
  const wide: React.CSSProperties = { gridColumn: '1 / -1' }
  const phone = (k: 'mobile' | 'whatsapp' | 'mobile1') => (e: React.ChangeEvent<HTMLInputElement>) =>
    set(k, e.target.value.replace(/[^\d+\s\-()]/g, ''))

  /* Every field as an element, so the order a person arranged in Settings can
     place them. A hidden field is nothing at all. */
  const nodes: Record<string, ReactNode> = {
    name: (
      <div style={wide}><Field label="Ledger name" required>
        <input value={f.name} maxLength={200} autoFocus onChange={(e) => set('name', e.target.value)} placeholder="e.g. Gupta Medical Hall" />
      </Field></div>
    ),
    account_group: (
      <Field label="Account group" required hint={f.account_group.startsWith('Sundry') ? 'Each party keeps its own account under this group' : undefined}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
          <TreeSelect value={f.account_group} onChange={(v) => set('account_group', v)} searchPlaceholder="Search account groups…"
                      options={[
                        { header: 'Party — customer or supplier' },
                        ...PARTY_GROUPS.map(([v, l]) => ({ key: v, label: l, bold: true })),
                        { header: 'Account groups' },
                        ...groupRows.map((g) => ({ key: g.name, label: g.name, depth: g.depth, bold: g.depth < 2 })),
                        ...(strays.length ? [{ header: 'Other' }, ...strays.map((g) => ({ key: g, label: g }))] : []),
                      ]} />
          <button type="button" className="btn vw-refresh" title="Add an account group" aria-label="Add an account group"
                  onClick={() => setAddingGroup(true)}>
            <IconPlus size={14} />
          </button>
        </div>
      </Field>
    ),
    station: (
      <Field label="Station" required hint="Town or city, from the geography master">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
          <TreeSelect value={f.station} onChange={pickTown} placeholder="Search town…" searchPlaceholder="Search towns…"
                      options={[
                        ...(towns.data ?? []).filter((t) => t.is_active !== false)
                          .map((t) => ({ key: t.name, label: t.name, sub: [t.district_name, t.state_name].filter(Boolean).join(', ') })),
                        // A station already on the ledger that is not on the list still has to show.
                        ...(f.station && !(towns.data ?? []).some((t) => t.name === f.station) ? [{ key: f.station, label: f.station }] : []),
                      ]} />
          <button type="button" className="btn vw-refresh" title="Add a town" aria-label="Add a town" onClick={() => setAddingTown(true)}>
            <IconPlus size={14} />
          </button>
        </div>
      </Field>
    ),
    mail_to: fm('mail_to') !== 'hide' && (
      <div style={wide}><Field label="Mail to" required={rq('mail_to')} hint="Name to print on letters and documents, if not the ledger name">
        <input value={f.mail_to} maxLength={200} placeholder="Name to print, if not the ledger name" onChange={(e) => set('mail_to', e.target.value)} />
      </Field></div>
    ),
    address: fm('address') !== 'hide' && (
      <div style={wide}><Field label="Address" required={rq('address')}>
        <div style={{ display: 'grid', gap: 8 }}>
          <input value={f.address1} maxLength={200} onChange={(e) => set('address1', e.target.value)} placeholder="Shop / building, street" />
          <input value={f.address2} maxLength={200} onChange={(e) => set('address2', e.target.value)} placeholder="Area, landmark" />
          <input value={f.address3} maxLength={200} onChange={(e) => set('address3', e.target.value)} placeholder="Line 3" />
        </div>
      </Field></div>
    ),
    country: fm('country') !== 'hide' && (
      <Field label="Country" required={rq('country')}>
        <input value={f.country} maxLength={80} placeholder="India" onChange={(e) => set('country', e.target.value)} />
      </Field>
    ),
    state: (
      <Field label="State" required>
        <select value={f.state} onChange={(e) => set('state', e.target.value)}>
          <option value="">{states.loading ? 'Loading…' : 'Choose state'}</option>
          {f.state && !(states.data ?? []).some((s) => s.name === f.state) && <option value={f.state}>{f.state}</option>}
          {(states.data ?? []).filter((s) => s.is_active !== false).map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
        </select>
      </Field>
    ),
    city: fm('city') !== 'hide' && (
      <Field label="City" required={rq('city')}>
        <input value={f.city} maxLength={120} placeholder="e.g. Jaipur" onChange={(e) => set('city', e.target.value)} />
      </Field>
    ),
    pincode: fm('pincode') !== 'hide' && (
      <Field label="PIN code" required={rq('pincode')} hint={err('pincode')}>
        <input value={f.pincode} maxLength={6} inputMode="numeric" placeholder="6-digit PIN code" onChange={(e) => set('pincode', e.target.value.replace(/\D/g, ''))} />
      </Field>
    ),
    category: fm('category') !== 'hide' && (
      <Field label="Ledger category" required={rq('category')} hint="Picks the company discount">
        <input value={f.category} maxLength={80} onChange={(e) => set('category', e.target.value)} placeholder="Others" />
      </Field>
    ),

    balancing_method: fm('balancing_method') !== 'hide' && (
      <div style={wide}><Field label="Balancing method" hint={f.balancing_method === 'bill_by_bill' ? 'Receipts settle bills one by one' : 'Receipts are held on account'}>
        <select value={f.balancing_method} onChange={(e) => set('balancing_method', e.target.value)}>
          <option value="bill_by_bill">Bill by bill</option>
          <option value="on_account">On account</option>
        </select>
      </Field></div>
    ),
    opening_balance: fm('opening_balance') !== 'hide' && (
      <div style={wide}><Field label="Opening balance" required={rq('opening_balance')} hint={f.opening_type === 'dr' ? 'Dr — they owe you' : 'Cr — you owe them'}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: 8 }}>
          <input value={f.opening_balance} inputMode="decimal" placeholder="0.00"
                 onChange={(e) => set('opening_balance', e.target.value.replace(/[^\d.]/g, ''))} />
          <select value={f.opening_type} onChange={(e) => set('opening_type', e.target.value)}>
            <option value="dr">Dr</option><option value="cr">Cr</option>
          </select>
        </div>
      </Field></div>
    ),
    credit_days: fm('credit_days') !== 'hide' && (
      <Field label="Credit days" required={rq('credit_days')}>
        <input value={f.credit_days} inputMode="numeric" placeholder="0" onChange={(e) => set('credit_days', e.target.value.replace(/\D/g, '').slice(0, 3))} />
      </Field>
    ),
    credit_limit: fm('credit_limit') !== 'hide' && (
      <Field label="Credit limit ₹" required={rq('credit_limit')}>
        <input value={f.credit_limit} inputMode="decimal" placeholder="No limit" onChange={(e) => set('credit_limit', e.target.value.replace(/[^\d.]/g, ''))} />
      </Field>
    ),

    mobile: (
      <Field label="Mobile no." required hint={err('mobile')}>
        <input value={f.mobile} inputMode="tel" maxLength={16} placeholder="+91 9876543210" onChange={phone('mobile')} />
      </Field>
    ),
    whatsapp: fm('whatsapp') !== 'hide' && (
      <Field label="WhatsApp no." required={rq('whatsapp') && !sameWa} hint={err('whatsapp')}>
        <input value={sameWa ? f.mobile : f.whatsapp} disabled={sameWa} inputMode="tel" maxLength={16}
               onChange={phone('whatsapp')} placeholder="+91 9876543210" />
        <label className="crm-check" style={{ marginTop: 6 }}>
          <input type="checkbox" checked={sameWa} onChange={(e) => setSameWa(e.target.checked)} /> Same as mobile
        </label>
      </Field>
    ),
    mobile1: fm('mobile1') !== 'hide' && (
      <Field label="Mobile no. 1" required={rq('mobile1')} hint={err('mobile1')}>
        <input value={f.mobile1} inputMode="tel" maxLength={16} placeholder="Another number" onChange={phone('mobile1')} />
      </Field>
    ),

    ledger_type: fm('ledger_type') !== 'hide' && (
      <Field label="Ledger type" hint="Decides B2B or B2C in GSTR-1">
        <select value={f.ledger_type} onChange={(e) => set('ledger_type', e.target.value)}>
          {LEDGER_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </Field>
    ),
    gstin: fm('gstin') !== 'hide' && (
      <Field label="GSTIN" required={rq('gstin')} hint={err('gstin') ?? 'Leave empty if unregistered'}>
        <input value={f.gstin} maxLength={15} placeholder="27AAAAA0000A1Z5" onChange={(e) => set('gstin', e.target.value.toUpperCase())} />
      </Field>
    ),
    pan: fm('pan') !== 'hide' && (
      <Field label="PAN" required={rq('pan')} hint={err('pan')}>
        <input value={f.pan} maxLength={10} placeholder="AAAAA0000A" onChange={(e) => set('pan', e.target.value.toUpperCase())} />
      </Field>
    ),

    contact_person: fm('contact_person') !== 'hide' && (
      <Field label="Contact person" required={rq('contact_person')}><input value={f.contact_person} maxLength={60} placeholder="Full name" onChange={(e) => set('contact_person', e.target.value)} /></Field>
    ),
    designation: fm('designation') !== 'hide' && (
      <Field label="Designation" required={rq('designation')}><input value={f.designation} maxLength={80} onChange={(e) => set('designation', e.target.value)} placeholder="Proprietor" /></Field>
    ),
    email: fm('email') !== 'hide' && (
      <Field label="Email" required={rq('email')} hint={err('email')}><input value={text('email')} onChange={(e) => set('email', e.target.value)} inputMode="email" placeholder="accounts@example.com" /></Field>
    ),
    dob: fm('dob') !== 'hide' && (
      <Field label="Date of birth" required={rq('dob')} hint="For birthday wishes"><input type="date" value={f.dob} onChange={(e) => set('dob', e.target.value)} /></Field>
    ),
    anniversary: fm('anniversary') !== 'hide' && (
      <Field label="Anniversary date" required={rq('anniversary')} hint="For anniversary wishes"><input type="date" value={f.anniversary} onChange={(e) => set('anniversary', e.target.value)} /></Field>
    ),
    website: fm('website') !== 'hide' && (
      <Field label="Website" required={rq('website')}><input value={f.website} maxLength={200} onChange={(e) => set('website', e.target.value)} placeholder="www.example.com" /></Field>
    ),

    bank_holder: fm('bank_holder') !== 'hide' && (
      <Field label="Account holder name" required={rq('bank_holder')}><input value={f.bank_holder} maxLength={160} placeholder="Name on the account" onChange={(e) => set('bank_holder', e.target.value)} /></Field>
    ),
    bank_name: fm('bank_name') !== 'hide' && (
      <Field label="Bank name" required={rq('bank_name')}><input value={f.bank_name} maxLength={160} placeholder="e.g. State Bank of India" onChange={(e) => set('bank_name', e.target.value)} /></Field>
    ),
    bank_account: fm('bank_account') !== 'hide' && (
      <Field label="Account no." required={rq('bank_account')}><input value={f.bank_account} maxLength={40} inputMode="numeric" placeholder="Account number" onChange={(e) => set('bank_account', e.target.value.replace(/\D/g, ''))} /></Field>
    ),
    ifsc: fm('ifsc') !== 'hide' && (
      <Field label="IFSC" required={rq('ifsc')} hint={err('ifsc')}><input value={f.ifsc} maxLength={11} placeholder="SBIN0001234" onChange={(e) => set('ifsc', e.target.value.toUpperCase())} /></Field>
    ),
    bank_branch: fm('bank_branch') !== 'hide' && (
      <Field label="Branch" required={rq('bank_branch')}><input value={f.bank_branch} maxLength={160} placeholder="Branch name" onChange={(e) => set('bank_branch', e.target.value)} /></Field>
    ),

    bill_at: fm('bill_at') !== 'hide' && (
      <Field label="Bill at" hint="Follows Sale Bill Setting › Billing rate">
        <select value={f.bill_at} onChange={(e) => set('bill_at', e.target.value)}>
          {BILL_AT.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </Field>
    ),
    salesman: fm('salesman') !== 'hide' && (
      <Field label="Salesman" required={rq('salesman')} hint="Starts every new sale bill for this party">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
          <select value={f.salesman} onChange={(e) => set('salesman', e.target.value)}>
            <option value="">— None —</option>
            {f.salesman && !(men.data ?? []).some((m) => m.name === f.salesman) && <option value={f.salesman}>{f.salesman}</option>}
            {(men.data ?? []).map((m) => <option key={m.id} value={m.name}>{m.name}</option>)}
          </select>
          <button type="button" className="btn vw-refresh" title="Add a salesman" aria-label="Add a salesman" onClick={() => setAddingMan(true)}>
            <IconPlus size={14} />
          </button>
        </div>
      </Field>
    ),
    area_route: fm('area_route') !== 'hide' && (
      <Field label="Area / Route" required={rq('area_route')}><input value={f.area_route} maxLength={120} placeholder="e.g. Sanganer, Tonk Road" onChange={(e) => set('area_route', e.target.value)} /></Field>
    ),
    notes: fm('notes') !== 'hide' && (
      <div style={wide}><Field label="Notes" required={rq('notes')}><textarea rows={2} value={f.notes} placeholder="Anything to remember about this party" onChange={(e) => set('notes', e.target.value)} /></Field></div>
    ),
  }
  const fieldsOf = (section: string) =>
    fields.orderOf(section).map((key) => <Fragment key={key}>{nodes[key]}</Fragment>)

  const tabs = ([['tax', 'GST / Tax Details'], ['contact', 'Contact Info'], ['bank', 'Bank Details'], ['others', 'Others']] as Array<[Tab, string]>)
    .filter(([k]) => LEDGER_FIELDS.some((d) => d.section === k && fm(d.key) !== 'hide'))
  const shownTab = tabs.some(([k]) => k === tab) ? tab : tabs[0]?.[0]

  return (
    <Dialog wide title={ledger ? `Edit ledger · ${ledger.code}` : 'Create ledger'}
            subtitle="A customer or supplier, with its own account in the books"
            onClose={onClose}
            footer={<>
              {error && <span className="error">{error}</span>}
              {!error && missing && <span className="lf-foot-note lf-foot-link">Fill in the fields marked <b className="lf-req">*</b></span>}
              {!error && !missing && invalid && <span className="lf-foot-note lf-foot-link">Check the fields marked in red</span>}
              <button className="btn crm-push" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || missing || invalid} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
            </>}>
      <div style={{ display: 'grid', gap: 16, padding: '8px 24px 20px', overflowY: 'auto', minHeight: 0, flex: 1, alignContent: 'start' }}>
        <div className="lf-settings">
          <FieldSettings defs={LEDGER_FIELDS} sections={LEDGER_SECTIONS} modes={fields.modes} order={fields.order}
                         onSave={fields.save} onReset={fields.reset} title="Ledger fields" />
        </div>
        <div style={grid('minmax(0,1.6fr) minmax(0,1fr)')}>
          <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
            <h4 className="muted-sm" style={{ margin: 0, letterSpacing: '.06em', textTransform: 'uppercase' }}>General info</h4>
            <div style={grid('1fr 1fr')}>{fieldsOf('general')}</div>
          </div>
          <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
            <h4 className="muted-sm" style={{ margin: 0, letterSpacing: '.06em', textTransform: 'uppercase' }}>Balance</h4>
            <div style={grid('1fr 1fr')}>{fieldsOf('balance')}</div>
            <h4 className="muted-sm" style={{ margin: '6px 0 0', letterSpacing: '.06em', textTransform: 'uppercase' }}>Contact numbers</h4>
            <div style={{ display: 'grid', gap: 14 }}>{fieldsOf('numbers')}</div>
          </div>
        </div>

        {tabs.length > 0 && (
          <div role="tablist" style={{ display: 'flex', gap: 18, borderBottom: '1px solid var(--border)' }}>
            {tabs.map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={shownTab === k} onClick={() => setTab(k)}
                      style={{ border: 0, background: 'none', padding: '8px 2px', cursor: 'pointer', font: 'inherit', fontWeight: shownTab === k ? 700 : 500,
                               color: shownTab === k ? 'var(--brand)' : 'var(--text-secondary)', borderBottom: shownTab === k ? '2px solid var(--brand)' : '2px solid transparent', marginBottom: -1 }}>
                {label}
              </button>
            ))}
          </div>
        )}
        {shownTab && <div style={grid('1fr 1fr 1fr')}>{fieldsOf(shownTab)}</div>}
      </div>
      {addingMan && (
        <SalesmanForm salesman={null} onClose={() => setAddingMan(false)}
                      onSaved={(m) => { setAddingMan(false); men.reload(); set('salesman', m.name); if (m.area_beat && !f.area_route) set('area_route', m.area_beat) }} />
      )}
      {addingTown && (
        <NewTownDialog onClose={() => setAddingTown(false)}
                       onAdded={(t) => { setAddingTown(false); towns.reload(); setF((cur) => ({ ...cur, station: t.name, city: t.name, state: t.state_name ?? cur.state, pincode: t.pincode ?? cur.pincode })) }} />
      )}
      {addingGroup && (
        <NewGroupDialog groups={groupRows} onClose={() => setAddingGroup(false)}
                        onAdded={(g) => { setAddingGroup(false); groups.reload(); set('account_group', g.name) }} />
      )}
    </Dialog>
  )
}

interface Town { id: string; name: string; state_id: string; state_name: string | null; district_id: string | null; district_name: string | null; pincode: string | null; is_active?: boolean }

/** A town or village ledgers can be at. Added to the geography master for this company only. */
function NewTownDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (t: Town) => void }) {
  const [stateId, setStateId] = useState('')
  const [districtId, setDistrictId] = useState('')
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')
  const states = useQuery<Array<{ id: string; name: string; is_active?: boolean }>>('crm-master-states-all', () => crm.masters('states'))
  const districts = useQuery<Array<{ id: string; name: string; state_id: string }>>('erp-town-districts', () => crm.masters('districts'))
  const { busy, error, run } = useRun()
  const shown = (districts.data ?? []).filter((d) => d.state_id === stateId)
  const pinBad = pin !== '' && !/^\d{6}$/.test(pin)
  return (
    <Dialog narrow title="New city / town" subtitle="A town or village your ledgers can be at; added for your organisation only" onClose={onClose}
            footer={<>
              {error && <span className="error">{error}</span>}
              <button className="btn crm-push" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || !stateId || !name.trim() || pinBad}
                      onClick={() => void run(async () => onAdded(await crm.createMaster<Town>('cities', {
                        name: name.trim(), state_id: stateId, district_id: districtId || null, pincode: pin || null,
                      })), 'That town could not be added')}>
                <IconPlus size={14} /> {busy ? 'Adding…' : 'Add Town'}
              </button>
            </>}>
      <div style={{ display: 'grid', gap: 14, padding: '8px 24px 20px', overflowY: 'auto', minHeight: 0, flex: 1, alignContent: 'start' }}>
        <Field label="State" required>
          <select value={stateId} autoFocus onChange={(e) => { setStateId(e.target.value); setDistrictId('') }}>
            <option value="">Choose state</option>
            {(states.data ?? []).filter((s) => s.is_active !== false).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="District">
          <select value={districtId} disabled={!stateId} onChange={(e) => setDistrictId(e.target.value)}>
            <option value="">{stateId ? (shown.length ? 'Choose district' : 'No districts for this state') : 'Choose a state first'}</option>
            {shown.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        <Field label="Town / Village name" required>
          <input value={name} maxLength={120} placeholder="Chomu" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="PIN code" hint={pinBad ? <span style={{ color: '#dc2626' }}>PIN code must be 6 digits.</span> : undefined}>
          <input value={pin} maxLength={6} inputMode="numeric" placeholder="303702" onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
        </Field>
      </div>
    </Dialog>
  )
}

/** A heading ledgers sit under: its name, and the group it rolls up into. */
export function NewGroupDialog({ groups, initialParent, onClose, onAdded }: { groups: AccountGroup[]; initialParent?: string; onClose: () => void; onAdded: (g: AccountGroup) => void }) {
  const [name, setName] = useState('')
  const [parent, setParent] = useState(initialParent ?? '')
  const { busy, error, run } = useRun()
  return (
    <Dialog narrow title="New account group" subtitle="A heading ledgers sit under — it holds no postings itself" onClose={onClose}
            footer={<>
              {error && <span className="error">{error}</span>}
              <button className="btn crm-push" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || !name.trim() || !parent}
                      onClick={() => void run(async () => onAdded(await erp.addAccountGroup({ name: name.trim(), parent_id: parent })), 'That group could not be added')}>
                <IconPlus size={14} /> {busy ? 'Adding…' : 'Add Group'}
              </button>
            </>}>
      <div style={{ display: 'grid', gap: 14, padding: '8px 24px 20px', overflowY: 'auto', minHeight: 0, flex: 1, alignContent: 'start' }}>
        <Field label="Group name" required>
          <input value={name} maxLength={80} autoFocus placeholder="Branch Expenses" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Under" required hint="The group it rolls up into">
          <TreeSelect value={parent} onChange={setParent} placeholder="Choose a group" searchPlaceholder="Search account groups…"
                      options={groups.map((g) => ({ key: g.id, label: g.name, depth: g.depth, bold: g.depth < 2 }))} />
        </Field>
      </div>
    </Dialog>
  )
}
