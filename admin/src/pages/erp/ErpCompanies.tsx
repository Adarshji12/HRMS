/* Master -> Inventory Masters -> Companies: the makers your items come from — what a pharmacy or
 * distributor calls "company". Kept in the same list the item form and opportunities pick a company from. */

import { useState, type ReactNode } from 'react'
import { useQuery } from '../../lib/useQuery'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconBuilding, IconClose, IconEdit, IconPlus, IconSearch, IconTrash } from '../../components/Icons'
import { ColumnSettings, FieldSettings, useColumns, useFieldModes, type ColumnDef, type FieldDef, type FieldSection } from '../../components/ViewSettings'
import ImportExport, { type IoColumn } from '../../components/ImportExport'
import FilterPopup, { FilterField } from '../../components/FilterPopup'
import { crm } from '../crm/api'
import { Dialog, Field, useAccess, useRun } from './parts'

interface Contact { name: string | null; mobile: string | null; email: string | null }
interface Company {
  id: string
  name: string
  is_active: boolean
  short_name: string | null
  contacts: Contact[] | null
  min_margin_pct: string | null
  expiry_receive_days: number | null
  dump_days: number | null
  website: string | null
  notes: string | null
}
type Show = 'active' | 'inactive' | 'all'

const first = (c: Company, k: keyof Contact) => c.contacts?.find((x) => x[k])?.[k] ?? null
const more = (c: Company) => ((c.contacts?.length ?? 0) > 1 ? <span className="muted-sm"> +{(c.contacts?.length ?? 0) - 1}</span> : null)

const COLUMNS: Array<ColumnDef & { td: (c: Company) => ReactNode; className?: string }> = [
  { key: 'name', label: 'Company', locked: true, td: (c) => <b>{c.name}</b> },
  { key: 'short', label: 'Short name', td: (c) => c.short_name ?? '—' },
  { key: 'contact', label: 'Contact', td: (c) => <>{first(c, 'name') ?? '—'}{more(c)}</> },
  { key: 'mobile', label: 'Mobile', className: 'crm-nowrap', td: (c) => first(c, 'mobile') ?? '—' },
  { key: 'email', label: 'Email', td: (c) => first(c, 'email') ?? '—' },
  { key: 'margin', label: 'Min. margin %', initial: false, className: 'crm-nowrap', td: (c) => (c.min_margin_pct ? `${Number(c.min_margin_pct)}%` : '—') },
  { key: 'expiry', label: 'Expiry receive (days)', initial: false, td: (c) => (c.expiry_receive_days ?? '—') },
  { key: 'dump', label: 'Dump days', initial: false, td: (c) => (c.dump_days ?? '—') },
  { key: 'website', label: 'Website', initial: false, td: (c) => c.website ?? '—' },
  { key: 'notes', label: 'Notes', initial: false, td: (c) => c.notes ?? '—' },
  { key: 'status', label: 'Status', initial: false, td: (c) => (c.is_active ? 'Active' : 'Inactive') },
]

const IO: IoColumn<Company>[] = [
  { key: 'name', label: 'Company name', required: true, sample: 'Cipla Ltd', get: (c) => c.name },
  { key: 'short_name', label: 'Short name', sample: 'CIPLA', get: (c) => c.short_name },
  { key: 'contact', label: 'Contact person', sample: '', get: (c) => first(c, 'name') },
  { key: 'mobile', label: 'Mobile', sample: '', get: (c) => first(c, 'mobile') },
  { key: 'email', label: 'Email', sample: '', get: (c) => first(c, 'email') },
  { key: 'website', label: 'Website', sample: '', get: (c) => c.website },
]

export default function Companies() {
  const { can } = useAccess()
  const manage = can('can_manage_erp_masters')
  const columns = useColumns('erp-companies', COLUMNS)
  const [q, setQ] = useState('')
  const [show, setShow] = useState<Show>('active')
  const [hasContact, setHasContact] = useState('')
  const [editing, setEditing] = useState<Company | 'new' | null>(null)
  const list = useQuery<Company[]>('erp-companies', () => crm.masters<Company>('item-companies'))
  const removing = useRun(() => list.reload())
  const needle = q.trim().toLowerCase()
  const all = list.data ?? []
  const rows = all.filter((c) =>
    (show === 'all' || (show === 'active') === c.is_active)
    && (!hasContact || (hasContact === 'yes') === ((c.contacts?.length ?? 0) > 0))
    && (!needle || [c.name, c.short_name, first(c, 'name'), first(c, 'mobile'), first(c, 'email')].some((x) => x && x.toLowerCase().includes(needle))))
  const extra = (show !== 'active' ? 1 : 0) + (hasContact ? 1 : 0)

  function remove(c: Company) {
    if (!window.confirm(`Delete the company “${c.name}”? This cannot be undone.`)) return
    void removing.run(() => crm.deleteMaster('item-companies', c.id), 'That company could not be deleted')
  }

  return (
    <>
      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '14px 18px', flexWrap: 'wrap' }}>
          <div>
            <h2 className="card-title" style={{ margin: 0 }}>Companies</h2>
            <p className="muted-sm" style={{ margin: '2px 0 0' }}>
              {rows.length} {rows.length === 1 ? 'company' : 'companies'} · The makers your items come from — what a pharmacy or distributor calls “company”.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <ImportExport name="companies" columns={IO} rows={rows} canImport={manage}
              build={(r) => ({
                name: r.name, short_name: r.short_name || null, is_active: true,
                contacts: r.contact || r.mobile || r.email ? [{ name: r.contact || null, mobile: r.mobile || null, email: r.email || null }] : [],
                website: r.website || null,
              })}
              save={(b) => crm.createMaster('item-companies', b)} onDone={() => list.reload()} />
            <ColumnSettings defs={COLUMNS} order={columns.pref.order} hidden={columns.pref.hidden} onSave={columns.save} onReset={columns.reset} />
            {manage && <button className="btn btn-primary" onClick={() => setEditing('new')}><IconPlus size={15} /> New company</button>}
          </div>
        </div>
        <div className="crm-bar itl-bar" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="crm-search">
            <IconSearch size={15} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search companies" aria-label="Search companies" />
          </div>
          <FilterPopup count={extra} onReset={() => { setShow('active'); setHasContact('') }}>
            <FilterField label="Status">
              <select value={show} onChange={(e) => setShow(e.target.value as Show)}>
                <option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All</option>
              </select>
            </FilterField>
            <FilterField label="Contact">
              <select value={hasContact} onChange={(e) => setHasContact(e.target.value)}>
                <option value="">Any</option><option value="yes">Has a contact</option><option value="no">No contact</option>
              </select>
            </FilterField>
          </FilterPopup>
        </div>
        {list.error && <ErrorNote>{list.error}</ErrorNote>}
        {removing.error && <div style={{ margin: 10 }}><ErrorNote>{removing.error}</ErrorNote></div>}
        {!list.data ? <Loading /> : rows.length === 0 ? (
          <EmptyState icon={<IconBuilding size={22} />} title={needle || extra ? 'Nothing matches' : 'No companies yet'}
            body={needle || extra ? 'Change the search or the filters.' : 'Add the makers your items come from.'} />
        ) : (
          <div className="table-wrap"><table className="itl">
            <thead><tr>
              {columns.visible.map((c) => <th key={c.key}>{c.label}</th>)}
              {manage && <th className="itl-c-act">Actions</th>}
            </tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className={c.is_active ? '' : 'is-off'}>
                  {columns.visible.map((col) => {
                    const def = COLUMNS.find((d) => d.key === col.key)!
                    return <td key={col.key} className={def.className}>{def.td(c)}</td>
                  })}
                  {manage && (
                    <td className="itl-c-act">
                      <div className="crm-row-actions itl-actions">
                        <button className="crm-icon-btn" onClick={() => setEditing(c)} title="Edit" aria-label={`Edit ${c.name}`}><IconEdit size={14} /></button>
                        <button className="crm-icon-btn crm-icon-danger" onClick={() => remove(c)} disabled={removing.busy} title="Delete" aria-label={`Delete ${c.name}`}><IconTrash size={14} /></button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>
      {editing && <CompanyForm company={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload() }} />}
    </>
  )
}

const SECTIONS: FieldSection[] = [{ id: 'main', label: 'Company' }]
const FIELDS: FieldDef[] = [
  { key: 'name', label: 'Company name', section: 'main', fixed: true },
  { key: 'short', label: 'Short name', section: 'main' },
  { key: 'contacts', label: 'Contacts', section: 'main' },
  { key: 'margin', label: 'Min. margin %', section: 'main' },
  { key: 'expiry', label: 'Expiry receive (days)', section: 'main' },
  { key: 'dump', label: 'Dump days', section: 'main' },
  { key: 'website', label: 'Website', section: 'main' },
  { key: 'notes', label: 'Notes', section: 'main' },
]

const blankContact = (): Contact => ({ name: '', mobile: '', email: '' })

function CompanyForm({ company, onClose, onSaved }: { company: Company | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: company?.name ?? '', short_name: company?.short_name ?? '', website: company?.website ?? '', notes: company?.notes ?? '',
    margin: company?.min_margin_pct ? String(Number(company.min_margin_pct)) : '', expiry: company?.expiry_receive_days != null ? String(company.expiry_receive_days) : '',
    dump: company?.dump_days != null ? String(company.dump_days) : '', is_active: company?.is_active ?? true,
  })
  const [contacts, setContacts] = useState<Contact[]>(company?.contacts?.length ? company.contacts.map((c) => ({ name: c.name ?? '', mobile: c.mobile ?? '', email: c.email ?? '' })) : [blankContact()])
  const { busy, error, run } = useRun()
  const fields = useFieldModes('erp-company-form', FIELDS)
  const fm = fields.mode
  const rq = (k: string) => fm(k) === 'mandatory'
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((c) => ({ ...c, [k]: v }))
  const setContact = (i: number, patch: Partial<Contact>) => setContacts((cur) => cur.map((c, at) => (at === i ? { ...c, ...patch } : c)))

  const ten = (s: string) => s.replace(/[\s\-()]/g, '').replace(/^\+91/, '')
  const contactBad = contacts.map((c) => ({
    mobile: !!c.mobile && !/^[6-9]\d{9}$/.test(ten(c.mobile)),
    email: !!c.email && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(c.email),
  }))
  const marginBad = f.margin !== '' && Number(f.margin) > 100
  const invalid = marginBad || contactBad.some((b) => b.mobile || b.email)
  const empty: Record<string, boolean> = {
    short: !f.short_name.trim(), contacts: !contacts.some((c) => c.name || c.mobile || c.email), margin: f.margin === '',
    expiry: f.expiry === '', dump: f.dump === '', website: !f.website.trim(), notes: !f.notes.trim(),
  }
  const missing = !f.name.trim() || Object.keys(empty).some((k) => rq(k) && fm(k) !== 'hide' && empty[k])

  function save() {
    const body = {
      name: f.name.trim(), short_name: f.short_name.trim() || null, website: f.website.trim() || null, notes: f.notes.trim() || null,
      min_margin_pct: f.margin === '' ? null : f.margin, expiry_receive_days: f.expiry === '' ? null : Number(f.expiry),
      dump_days: f.dump === '' ? null : Number(f.dump), is_active: f.is_active,
      contacts: contacts.map((c) => ({ name: c.name || null, mobile: c.mobile || null, email: c.email || null })),
    }
    void run(async () => {
      if (company) await crm.updateMaster('item-companies', company.id, body)
      else await crm.createMaster('item-companies', body)
      onSaved()
    }, 'That company could not be saved')
  }

  const red = (t: string) => <span style={{ color: '#dc2626' }}>{t}</span>
  const digits = (k: 'expiry' | 'dump') => (e: React.ChangeEvent<HTMLInputElement>) => set(k, e.target.value.replace(/\D/g, '').slice(0, 4))

  const span = (n: number, node: ReactNode) => <div style={{ gridColumn: `span ${n}` }}>{node}</div>
  const nodes: Record<string, ReactNode> = {
    name: span(4, <Field label="Company name" required><input value={f.name} maxLength={80} autoFocus placeholder="Cipla Ltd" onChange={(e) => set('name', e.target.value)} /></Field>),
    short: fm('short') !== 'hide' && span(2, <Field label="Short name" required={rq('short')}><input value={f.short_name} maxLength={20} placeholder="CIPLA" onChange={(e) => set('short_name', e.target.value.toUpperCase())} /></Field>),
    contacts: fm('contacts') !== 'hide' && span(6, (
        <div>
          <div className="muted-sm" style={{ fontWeight: 600, marginBottom: 6 }}>Contacts{rq('contacts') && <span className="lf-req"> *</span>}</div>
          <div style={{ display: 'grid', gap: 10, padding: 12, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface-2)' }}>
            {contacts.map((c, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.2fr auto', gap: 10, alignItems: 'start' }}>
                <Field label={i === 0 ? 'Contact person' : ''}><input value={c.name ?? ''} maxLength={120} placeholder="Name" onChange={(e) => setContact(i, { name: e.target.value })} /></Field>
                <Field label={i === 0 ? 'Mobile' : ''} hint={contactBad[i]?.mobile ? red('Enter a valid 10-digit mobile number.') : undefined}>
                  <input value={c.mobile ?? ''} inputMode="tel" maxLength={16} placeholder="98XXXXXXXX" onChange={(e) => setContact(i, { mobile: e.target.value.replace(/[^\d+\s\-()]/g, '') })} />
                </Field>
                <Field label={i === 0 ? 'Email' : ''} hint={contactBad[i]?.email ? red('Enter a valid email address.') : undefined}>
                  <input value={c.email ?? ''} inputMode="email" placeholder="name@example.com" onChange={(e) => setContact(i, { email: e.target.value })} />
                </Field>
                <div style={{ paddingTop: i === 0 ? 22 : 0 }}>
                  {i === contacts.length - 1 && contacts.length < 10 ? (
                    <button type="button" className="btn vw-refresh" title="Add another contact" aria-label="Add another contact" onClick={() => setContacts((cur) => [...cur, blankContact()])}><IconPlus size={14} /></button>
                  ) : (
                    <button type="button" className="btn vw-refresh" title="Remove this contact" aria-label="Remove this contact" onClick={() => setContacts((cur) => cur.filter((_, at) => at !== i))}><IconClose size={14} /></button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
    )),
    margin: fm('margin') !== 'hide' && span(2, (
      <Field label="Min. margin %" required={rq('margin')} hint={marginBad ? red('Margin cannot be more than 100%.') : undefined}>
        <input value={f.margin} inputMode="decimal" onChange={(e) => set('margin', e.target.value.replace(/[^\d.]/g, ''))} />
      </Field>
    )),
    expiry: fm('expiry') !== 'hide' && span(2, <Field label="Expiry receive (days)" required={rq('expiry')} hint="Takes back expired stock"><input value={f.expiry} inputMode="numeric" onChange={digits('expiry')} /></Field>),
    dump: fm('dump') !== 'hide' && span(2, <Field label="Dump days" required={rq('dump')} hint="Before expiry, stock goes to dump"><input value={f.dump} inputMode="numeric" onChange={digits('dump')} /></Field>),
    website: fm('website') !== 'hide' && span(6, <Field label="Website" required={rq('website')}><input value={f.website} maxLength={200} placeholder="www.cipla.com" onChange={(e) => set('website', e.target.value)} /></Field>),
    notes: fm('notes') !== 'hide' && span(6, <Field label="Notes" required={rq('notes')}><textarea rows={3} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>),
  }

  return (
    <Dialog wide title={company ? `Edit company · ${company.name}` : 'New company'} subtitle={company ? undefined : 'Add a company to the list'} onClose={onClose}
            footer={<>
              {error && <span className="error">{error}</span>}
              {!error && missing && <span className="lf-foot-note lf-foot-link">Company name required</span>}
              {!error && !missing && invalid && <span className="lf-foot-note lf-foot-link">Check the fields marked in red</span>}
              <button className="btn crm-push" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || missing || invalid} onClick={save}>{busy ? 'Saving…' : company ? 'Save' : 'Add company'}</button>
            </>}>
      <div style={{ display: 'grid', gap: 14, padding: '8px 24px 20px', overflowY: 'auto', minHeight: 0, flex: 1, alignContent: 'start' }}>
        <div className="lf-settings">
          <FieldSettings defs={FIELDS} sections={SECTIONS} modes={fields.modes} order={fields.order}
                         onSave={fields.save} onReset={fields.reset} title="Company fields" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: 14 }}>
          {fields.orderOf('main').map((key) => <div key={key} style={{ display: 'contents' }}>{nodes[key]}</div>)}
        </div>
        {company && <label className="crm-check"><input type="checkbox" checked={f.is_active} onChange={(e) => set('is_active', e.target.checked)} /> Active</label>}
      </div>
    </Dialog>
  )
}

