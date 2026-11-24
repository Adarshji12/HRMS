/* Master -> Inventory Masters: Sub Categories, Units, HSN / SAC, Racks and Bill Series.
 * One screen, set up per list: a name, a description, what it sits under, and a few values of its own. */

import { useState, type ReactNode } from 'react'
import { useQuery } from '../../lib/useQuery'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconBuilding, IconEdit, IconPlus, IconSearch, IconTrash } from '../../components/Icons'
import { ColumnSettings, FieldSettings, useColumns, useFieldModes, type ColumnDef, type FieldDef, type FieldSection } from '../../components/ViewSettings'
import ImportExport, { type IoColumn } from '../../components/ImportExport'
import FilterPopup, { FilterField } from '../../components/FilterPopup'
import { crm } from '../crm/api'
import { Dialog, Field, useAccess, useRun } from './parts'
import { erp, type Lookup } from './api'

export type LookupKind = 'subcategory' | 'unit' | 'hsn' | 'rack' | 'billseries'
type Show = 'active' | 'inactive' | 'all'

const SERIES_TYPES: Array<[string, string]> = [
  ['sale', 'Sale bill'], ['purchase', 'Purchase bill'], ['sale_return', 'Sale return'],
  ['purchase_return', 'Purchase return'], ['order', 'Order'],
]

interface Spec {
  title: string
  one: string
  nameLabel: string
  namePlaceholder: string
  blurb: string
  /** What the row sits under, if anything. */
  parent?: { label: string; hint: string }
}

const SPECS: Record<LookupKind, Spec> = {
  subcategory: { title: 'Sub Categories', one: 'sub category', nameLabel: 'Sub category', namePlaceholder: 'Salted', blurb: 'A second level under an item category.', parent: { label: 'Category', hint: 'The category it belongs to' } },
  unit: { title: 'Units', one: 'unit', nameLabel: 'Code', namePlaceholder: 'STRIP', blurb: 'Units of measure. The UQC is what GSTR-1 reports.' },
  hsn: { title: 'HSN / SAC', one: 'HSN / SAC code', nameLabel: 'Code', namePlaceholder: '3004', blurb: 'Codes with the GST they carry, so an item takes its rate from its code. SAC codes (services) start with 99.' },
  rack: { title: 'Racks', one: 'rack', nameLabel: 'Rack name', namePlaceholder: 'FRIDGE CHEST', blurb: 'Racks, shelves and fridges inside each store. Set which items sit where under Update Master › Rack Update.', parent: { label: 'Store', hint: 'The store it is in' } },
  billseries: { title: 'Bill Series', one: 'bill series', nameLabel: 'Series name', namePlaceholder: 'Retail invoice', blurb: 'The numbering a kind of bill follows.' },
}

const UQC = [
  'BAG', 'BAL', 'BDL', 'BKL', 'BOU', 'BOX', 'BTL', 'BUN', 'CAN', 'CBM', 'CCM', 'CMS', 'CTN', 'DOZ', 'DRM', 'GGK', 'GMS', 'GRS', 'GYD',
  'KGS', 'KLR', 'KME', 'LTR', 'MLT', 'MTR', 'MTS', 'NOS', 'OTH', 'PAC', 'PCS', 'PRS', 'QTL', 'ROL', 'SET', 'SQF', 'SQM', 'SQY', 'TBS',
  'TGM', 'THD', 'TON', 'TUB', 'UGS', 'UNT', 'YDS',
]

const seriesLabel = (k: unknown) => SERIES_TYPES.find(([v]) => v === k)?.[1] ?? String(k ?? '—')

function columnsFor(kind: LookupKind): Array<ColumnDef & { td: (l: Lookup) => ReactNode; className?: string }> {
  const spec = SPECS[kind]
  const base: Array<ColumnDef & { td: (l: Lookup) => ReactNode; className?: string }> = [
    { key: 'name', label: kind === 'rack' ? 'Rack' : spec.nameLabel, locked: true, td: (l) => <b>{l.name}</b> },
  ]
  if (spec.parent) base.push({ key: 'parent', label: spec.parent.label, td: (l) => l.parent_name ?? '—' })
  if (kind === 'hsn') {
    base.push({ key: 'type', label: 'Type', td: (l) => (l.data.type === 'sac' ? 'SAC · Services' : 'HSN · Goods') })
  }
  if (kind === 'unit') {
    base.push({ key: 'unitname', label: 'Unit', td: (l) => l.description ?? '—' })
    base.push({ key: 'uqc', label: 'UQC', td: (l) => String(l.data.uqc ?? '—') })
    base.push({ key: 'decimals', label: 'Decimals', className: 'crm-nowrap', td: (l) => String(l.data.decimals ?? 0) })
  }
  if (kind === 'unit') base.push({ key: 'items', label: 'Items', className: 'crm-nowrap', td: (l) => String(l.items ?? 0) })
  if (kind === 'billseries') {
    base.push({ key: 'type', label: 'Numbers', td: (l) => seriesLabel(l.data.type) })
    base.push({ key: 'prefix', label: 'Prefix', td: (l) => String(l.data.prefix || '—') })
    base.push({ key: 'next', label: 'Next number', className: 'crm-nowrap', td: (l) => String(l.data.next ?? 1) })
  }
  if (kind !== 'unit' && kind !== 'rack') base.push({ key: 'description', label: 'Description', td: (l) => l.description ?? '—' })
  if (kind === 'hsn') {
    base.push({ key: 'gst', label: 'GST %', className: 'crm-nowrap', td: (l) => String(Number(l.data.gst ?? 0)) })
    base.push({ key: 'short', label: 'Short name', initial: false, td: (l) => String(l.data.short_name ?? '—') })
    base.push({ key: 'uqc', label: 'UQC', initial: false, td: (l) => String(l.data.uqc ?? '—') })
    base.push({ key: 'items', label: 'Items', initial: false, className: 'crm-nowrap', td: (l) => String(l.items ?? 0) })
  }
  base.push({ key: 'status', label: 'Status', initial: false, td: (l) => (l.is_active ? 'Active' : 'Inactive') })
  return base
}

export default function Lookups({ kind }: { kind: LookupKind }) {
  const spec = SPECS[kind]
  const { can } = useAccess()
  const manage = can('can_manage_erp_masters')
  const defs = columnsFor(kind)
  const columns = useColumns(`erp-lookup-${kind}`, defs)
  const [q, setQ] = useState('')
  const [show, setShow] = useState<Show>('active')
  const [editing, setEditing] = useState<Lookup | 'new' | null>(null)
  const list = useQuery(`erp-lookup-${kind}-${q}-${show}`, () => erp.lookups(kind, { q: q.trim() || undefined, active: show === 'all' ? undefined : show === 'active' }))
  const removing = useRun(() => list.reload())
  /* The one extra filter each list has: what it sits under, its GST rate, what it numbers, or its decimals. */
  const [facet, setFacet] = useState('')
  const all = list.data ?? []
  const facetOf = (l: Lookup): string =>
    kind === 'hsn' ? String(Number(l.data.gst ?? 0)) : kind === 'billseries' ? String(l.data.type ?? '')
      : kind === 'unit' ? (Number(l.data.decimals ?? 0) > 0 ? 'decimal' : 'whole') : l.parent_name ?? ''
  const facetLabel = kind === 'hsn' ? 'GST %' : kind === 'billseries' ? 'Numbers' : kind === 'unit' ? 'Decimals' : spec.parent?.label ?? ''
  const facetOptions: Array<[string, string]> =
    kind === 'unit' ? [['whole', 'Whole numbers'], ['decimal', 'Decimals allowed']]
      : kind === 'billseries' ? SERIES_TYPES
        : kind === 'hsn' ? [...new Set(all.map(facetOf))].sort((a, b) => Number(a) - Number(b)).map((v) => [v, `${v}%`] as [string, string])
          : [...new Set(all.map(facetOf).filter(Boolean))].sort().map((v) => [v, v] as [string, string])
  const extra = (show !== 'active' ? 1 : 0) + (facet ? 1 : 0)
  const rows = facet ? all.filter((l) => facetOf(l) === facet) : all
  const io: IoColumn<Lookup>[] = [
    { key: 'name', label: spec.nameLabel, required: true, sample: spec.namePlaceholder, get: (l) => l.name },
    ...(spec.parent ? [{ key: 'parent_name', label: spec.parent.label, required: true, sample: '', get: (l: Lookup) => l.parent_name }] : []),
    { key: 'description', label: 'Description', sample: '', get: (l) => l.description },
  ]

  function remove(l: Lookup) {
    if (!window.confirm(`Delete the ${spec.one} “${l.name}”? This cannot be undone.`)) return
    void removing.run(() => erp.deleteLookup(kind, l.id), `That ${spec.one} could not be deleted`)
  }

  return (
    <>
      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '14px 18px', flexWrap: 'wrap' }}>
          <div>
            <h2 className="card-title" style={{ margin: 0 }}>{spec.title}</h2>
            <p className="muted-sm" style={{ margin: '2px 0 0' }}>{rows.length} {rows.length === 1 ? spec.one : `${spec.one}s`.replace('HSN / SAC codes', 'HSN / SAC codes')} · {spec.blurb}</p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <ImportExport name={spec.title.toLowerCase()} columns={io} rows={rows} canImport={manage}
              build={(r) => ({ name: r.name, parent_name: r.parent_name || null, description: r.description || null, data: {}, is_active: true })}
              save={(b) => erp.saveLookup(kind, b)} onDone={() => list.reload()} />
            <ColumnSettings defs={defs} order={columns.pref.order} hidden={columns.pref.hidden} onSave={columns.save} onReset={columns.reset} />
            {manage && <button className="btn btn-primary" onClick={() => setEditing('new')}><IconPlus size={15} /> New {spec.one}</button>}
          </div>
        </div>
        <div className="crm-bar itl-bar" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="crm-search">
            <IconSearch size={15} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${spec.title.toLowerCase()}`} aria-label={`Search ${spec.title}`} />
          </div>
          <FilterPopup count={extra} onReset={() => { setShow('active'); setFacet('') }}>
              <FilterField label="Status">
                <select value={show} onChange={(e) => setShow(e.target.value as Show)}>
                  <option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All</option>
                </select>
              </FilterField>
              {facetOptions.length > 0 && (
                <FilterField label={facetLabel}>
                  <select value={facet} onChange={(e) => setFacet(e.target.value)}>
                    <option value="">Any</option>
                    {facetOptions.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </FilterField>
              )}
          </FilterPopup>
        </div>
        {list.error && <ErrorNote>{list.error}</ErrorNote>}
        {removing.error && <div style={{ margin: 10 }}><ErrorNote>{removing.error}</ErrorNote></div>}
        {!list.data ? <Loading /> : rows.length === 0 ? (
          <EmptyState icon={<IconBuilding size={22} />} title={q ? 'Nothing matches' : `No ${spec.title.toLowerCase()} yet`} body={q ? 'Change the search.' : spec.blurb} />
        ) : (
          <div className="table-wrap"><table className="itl">
            <thead><tr>
              {columns.visible.map((c) => <th key={c.key}>{c.label}</th>)}
              {manage && <th className="itl-c-act">Actions</th>}
            </tr></thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id} className={l.is_active ? '' : 'is-off'}>
                  {columns.visible.map((c) => {
                    const def = defs.find((d) => d.key === c.key)!
                    return <td key={c.key} className={def.className}>{def.td(l)}</td>
                  })}
                  {manage && (
                    <td className="itl-c-act">
                      <div className="crm-row-actions itl-actions">
                        <button className="crm-icon-btn" onClick={() => setEditing(l)} title="Edit" aria-label={`Edit ${l.name}`}><IconEdit size={14} /></button>
                        <button className="crm-icon-btn crm-icon-danger" onClick={() => remove(l)} disabled={removing.busy} title="Delete" aria-label={`Delete ${l.name}`}><IconTrash size={14} /></button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>
      {editing && <LookupForm kind={kind} row={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload() }} />}
    </>
  )
}

/** What each list's form can show, make mandatory or hide. The fields a row cannot do without are fixed. */
function lookupFields(kind: LookupKind): { sections: FieldSection[]; defs: FieldDef[] } {
  const main = (key: string, label: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, label, section: 'main', ...extra })
  const sections: FieldSection[] = [{ id: 'main', label: SPECS[kind].title }]
  const defs: FieldDef[] =
    kind === 'unit' ? [main('name', 'Code', { fixed: true }), main('unitname', 'Unit name', { fixed: true }), main('uqc', 'GST UQC'), main('decimals', 'Decimals', { optionalOnly: true })]
      : kind === 'hsn' ? [main('name', 'HSN / SAC code', { fixed: true }), main('type', 'Type', { optionalOnly: true }), main('gst', 'GST rate %', { optionalOnly: true }),
        main('short', 'Short name'), main('uqc', 'UQC', { fixed: true }), main('description', 'Description')]
        : kind === 'rack' ? [main('name', 'Rack name', { fixed: true }), main('parent', 'Store', { fixed: true })]
          : spec_parent(kind) ? [main('name', SPECS[kind].nameLabel, { fixed: true }), main('parent', SPECS[kind].parent!.label, { fixed: true }), main('description', 'Description')]
            : [main('name', SPECS[kind].nameLabel, { fixed: true }), main('description', 'Description')]
  return { sections, defs }
}
const spec_parent = (kind: LookupKind) => Boolean(SPECS[kind].parent)

function LookupForm({ kind, row, onClose, onSaved }: { kind: LookupKind; row: Lookup | null; onClose: () => void; onSaved: (l: Lookup) => void }) {
  const spec = SPECS[kind]
  const [f, setF] = useState({
    name: row?.name ?? '', description: row?.description ?? '', parent: row?.parent_name ?? '', is_active: row?.is_active ?? true,
    decimals: String(row?.data.decimals ?? 0), uqc: String(row?.data.uqc ?? ''), gst: row?.data.gst != null ? String(Number(row.data.gst)) : '18',
    hsnType: String(row?.data.type ?? 'hsn'), short: String(row?.data.short_name ?? ''), type: String(row?.data.type ?? 'sale'),
    prefix: String(row?.data.prefix ?? ''), next: String(row?.data.next ?? '1'),
  })
  const { busy, error, run } = useRun()
  const { sections: fieldSections, defs: fieldDefs } = lookupFields(kind)
  const fields = useFieldModes(`erp-lookup-${kind}-form`, fieldDefs)
  const fm = fields.mode
  const rq = (k: string) => fm(k) === 'mandatory'
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((c) => ({ ...c, [k]: v }))
  const cats = useQuery<Array<{ id: string; name: string; is_active?: boolean }>>('inv-lookup-categories', () => crm.masters('item-categories'), { enabled: kind === 'subcategory' })
  const stores = useQuery('inv-lookup-stores', () => erp.warehouses(), { enabled: kind === 'rack' })
  const parents = kind === 'subcategory'
    ? (cats.data ?? []).filter((c) => c.is_active !== false).map((c) => c.name)
    : (stores.data ?? []).map((w) => w.name)
  if (f.parent && !parents.includes(f.parent)) parents.push(f.parent)

  const hsnBad = kind === 'hsn' && f.name.trim() !== '' && !/^\d{2,8}$/.test(f.name.replace(/\s/g, ''))
  const isSac = kind === 'hsn' && f.hsnType === 'sac'
  const sacMismatch = kind === 'hsn' && /^\d{2,8}$/.test(f.name) && isSac !== f.name.startsWith('99')
  const lacking: Record<string, boolean> = { description: !f.description.trim(), short: !f.short.trim(), uqc: kind === 'unit' && !f.uqc, decimals: f.decimals === '' }
  const needed = Object.keys(lacking).some((k) => fieldDefs.some((d) => d.key === k) && rq(k) && fm(k) !== 'hide' && lacking[k])
  const missing = !f.name.trim() || (!!spec.parent && !f.parent) || (kind === 'unit' && !f.description.trim()) || (kind === 'hsn' && !isSac && !f.uqc) || needed
  const invalid = hsnBad || sacMismatch

  function save() {
    const data: Record<string, unknown> =
      kind === 'unit' ? { uqc: f.uqc || null, decimals: Number(f.decimals || 0) }
        : kind === 'hsn' ? { gst: Number(f.gst || 0), type: f.hsnType, uqc: isSac ? 'NA' : f.uqc || null, short_name: f.short.trim() || null }
          : kind === 'billseries' ? { type: f.type, prefix: f.prefix, next: Number(f.next || 1) } : {}
    void run(async () => onSaved(await erp.saveLookup(kind, {
      name: f.name.trim(), description: f.description.trim() || null, parent_name: f.parent || null, data, is_active: f.is_active,
    }, row?.id)), `That ${spec.one} could not be saved`)
  }

  const wide = (node: ReactNode) => <div style={{ gridColumn: '1 / -1' }}>{node}</div>
  const nodes: Record<string, ReactNode> = {
    name: kind === 'hsn' ? (
      <Field label="HSN / SAC code" required hint={hsnBad ? <span style={{ color: '#dc2626' }}>An HSN / SAC code is 2 to 8 digits.</span> : sacMismatch ? <span style={{ color: '#dc2626' }}>SAC codes start with 99; HSN codes do not.</span> : undefined}>
        <input value={f.name} maxLength={8} autoFocus placeholder={spec.namePlaceholder}
               onChange={(e) => { const v = e.target.value.replace(/\D/g, ''); setF((c) => ({ ...c, name: v, hsnType: v.length >= 2 ? (v.startsWith('99') ? 'sac' : 'hsn') : c.hsnType })) }} />
      </Field>
    ) : wide(
      <Field label={spec.nameLabel} required>
        <input value={f.name} maxLength={120} autoFocus placeholder={spec.namePlaceholder} onChange={(e) => set('name', e.target.value)} />
      </Field>
    ),
    type: kind === 'hsn' && fm('type') !== 'hide' && (
      <Field label="Type">
        <select value={f.hsnType} onChange={(e) => set('hsnType', e.target.value)}>
          <option value="hsn">HSN — Goods</option><option value="sac">SAC — Services</option>
        </select>
      </Field>
    ),
    parent: !!spec.parent && wide(
      <Field label={spec.parent.label} required hint={spec.parent.hint}>
        <select value={f.parent} onChange={(e) => set('parent', e.target.value)}>
          <option value="">{`Choose ${spec.parent.label.toLowerCase()}`}</option>
          {parents.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </Field>
    ),
    gst: kind === 'hsn' && fm('gst') !== 'hide' && (
      <Field label="GST rate %" required>
        <select value={f.gst} onChange={(e) => set('gst', e.target.value)}>
          {['0', '0.1', '0.25', '3', '5', '12', '18', '28', '40'].map((r) => <option key={r} value={r}>{r}%</option>)}
          {!['0', '0.1', '0.25', '3', '5', '12', '18', '28', '40'].includes(f.gst) && <option value={f.gst}>{f.gst}%</option>}
        </select>
      </Field>
    ),
    short: kind === 'hsn' && fm('short') !== 'hide' && (
      <Field label="Short name" required={rq('short')}><input value={f.short} maxLength={40} placeholder="Medicines" onChange={(e) => set('short', e.target.value)} /></Field>
    ),
    uqc: kind === 'hsn' ? wide(
      <Field label="UQC" required={!isSac} hint="GSTR-1 reports quantity against it · services use NA">
        <select value={isSac ? 'NA' : f.uqc} disabled={isSac} onChange={(e) => set('uqc', e.target.value)}>
          <option value="">Select UQC</option>
          {isSac && <option value="NA">NA</option>}
          {UQC.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
      </Field>
    ) : kind === 'unit' && fm('uqc') !== 'hide' && (
      <Field label="GST UQC" required={rq('uqc')}>
        <select value={f.uqc} onChange={(e) => set('uqc', e.target.value)}>
          <option value="">—</option>
          {UQC.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
      </Field>
    ),
    decimals: kind === 'unit' && fm('decimals') !== 'hide' && (
      <Field label="Decimals" hint="0 for whole units">
        <input value={f.decimals} inputMode="numeric" maxLength={1} onChange={(e) => set('decimals', e.target.value.replace(/\D/g, ''))} />
      </Field>
    ),
    unitname: kind === 'unit' && wide(
      <Field label="Unit name" required><input value={f.description} maxLength={240} placeholder="Strip" onChange={(e) => set('description', e.target.value)} /></Field>
    ),
    description: kind !== 'unit' && kind !== 'rack' && fm('description') !== 'hide' && wide(
      <Field label="Description" required={rq('description')}>
        {kind === 'hsn'
          ? <textarea rows={3} value={f.description} maxLength={240} onChange={(e) => set('description', e.target.value)} />
          : <input value={f.description} maxLength={240} onChange={(e) => set('description', e.target.value)} />}
      </Field>
    ),
  }

  return (
    <Dialog medium title={row ? `Edit ${spec.one}` : `New ${spec.one}`} onClose={onClose}
            footer={<>
              {error && <span className="error">{error}</span>}
              {!error && missing && <span className="lf-foot-note lf-foot-link">{kind === 'unit' ? 'Code, Unit name required' : kind === 'hsn' ? 'HSN / SAC code, UQC required' : spec.parent ? `${spec.nameLabel}, ${spec.parent.label} required` : `${spec.nameLabel} required`}</span>}
              <button className="btn crm-push" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || missing || invalid} onClick={save}>{busy ? 'Saving…' : row ? 'Save' : `Add ${spec.one}`}</button>
            </>}>
      <div style={{ display: 'grid', gap: 14, padding: '8px 24px 20px', overflowY: 'auto', minHeight: 0, flex: 1, alignContent: 'start' }}>
        <div className="lf-settings">
          <FieldSettings defs={fieldDefs} sections={fieldSections} modes={fields.modes} order={fields.order}
                         onSave={fields.save} onReset={fields.reset} title={`${spec.title} fields`} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          {fields.orderOf('main').map((key) => <div key={key} style={{ display: 'contents' }}>{nodes[key]}</div>)}
        </div>
        {row && <label className="crm-check"><input type="checkbox" checked={f.is_active} onChange={(e) => set('is_active', e.target.checked)} /> Active</label>}
      </div>
    </Dialog>
  )
}

