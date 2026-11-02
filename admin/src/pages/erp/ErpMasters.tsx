/* Masters — items, warehouses, vendors and the customer's financial account.
 *
 * Customers are not created here. They are the CRM's, and this screen only adds
 * what billing needs beside them: credit terms, the hold, delivery sites. */

import { useEffect, useState } from 'react'
import { Navigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '../../lib/useQuery'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconBriefcase, IconBuilding, IconCamera, IconCard, IconCheck, IconClose, IconEdit, IconPlus, IconSearch, IconSheet, IconTrash, IconUser } from '../../components/Icons'
import {
  erp, erpError, qtyText, rupees,
  type CustomerAccount, type Item, type Vendor, type Warehouse,
} from './api'
import { DateText, Dialog, Drawer, ErpPage, ErpState, Facts, Field, Note, ReasonDialog, Tabs, useAccess, useRun } from './parts'
import { MasterTrail } from '../masters/MasterBack'
import { crm } from '../crm/api'

type Tab = 'items' | 'warehouses' | 'vendors' | 'customers'

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'items', label: 'Items' }, { key: 'warehouses', label: 'Warehouses' },
  { key: 'vendors', label: 'Vendors' }, { key: 'customers', label: 'Customer accounts' },
]

/* Opened from the ERP rail (/erp/masters): all four lists as tabs. Opened from
   the Master menu (/masters/erp/<list>): that one list on its own page, inside
   the Master section rather than the ERP module, the way each Master card row
   opens a single list. */
export default function ErpMasters() {
  const [params] = useSearchParams()
  const { tab: routeTab } = useParams()
  const only = TABS.find((t) => t.key === routeTab)
  const [picked, setTab] = useState<Tab>('items')
  // The old Master links were /erp/masters?tab=…, which opened inside ERP.
  const legacy = TABS.find((t) => t.key === params.get('tab'))
  if (!routeTab && legacy) return <Navigate to={`/masters/erp/${legacy.key}`} replace />
  if (routeTab && !only) return <Navigate to="/masters" replace />
  const tab = only?.key ?? picked
  return (
    <>
      {/* Only the Master section's single-list view gets the way back; the ERP
          menu opens the tabbed page, and there "back to Master" would be a detour. */}
      {only && (
        <MasterTrail crumbs={[
          { label: 'Master', to: '/masters' },
          { label: 'ERP Master', to: '/masters' },
          { label: only.label },
        ]} />
      )}
      {only ? (
        /* Opened from Master: the list alone, under the Back button — its
           name is in the top bar. */
        <div className="crm">
          {tab === 'items' && <Items />}
          {tab === 'warehouses' && <Warehouses />}
          {tab === 'vendors' && <Vendors />}
          {tab === 'customers' && <Customers />}
        </div>
      ) : (
        <ErpPage
          title="Masters"
          subtitle="Created once, referenced everywhere — and deactivated, never deleted, once in use"
        >
          <Tabs value={tab} onChange={setTab} items={TABS} />
          {tab === 'items' && <Items />}
          {tab === 'warehouses' && <Warehouses />}
          {tab === 'vendors' && <Vendors />}
          {tab === 'customers' && <Customers />}
        </ErpPage>
      )}
    </>
  )
}

function Search({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="crm-search" style={{ marginBottom: 12, maxWidth: 360 }}>
      <IconSearch size={15} />
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  )
}

/* ------------------------------------------------------------------ items --- */

const ITEM_BLANK = {
  code: '', name: '', description: '', item_type: 'goods', category: '', uom: 'Nos', hsn_sac: '',
  gst_percent: '18', purchase_gst_percent: '18', weight_kg: '0', volume_m3: '0', make: '', model: '', part_number: '', is_serialized: false, warranty_months: 0,
  standard_cost: '0', sale_price: '0', reorder_level: '0', min_level: '0', max_level: '0', is_active: true,
  image: null as string | null, barcode: '',
}

function Items() {
  const { can } = useAccess()
  const manage = can('can_manage_erp_masters')
  const [q, setQ] = useState('')
  const [type, setType] = useState<'' | 'goods' | 'service'>('')
  const [state, setState] = useState<'' | 'active' | 'inactive'>('')
  const list = useQuery(`erp-items-list-${q}`, () => erp.items({ q: q.trim() || undefined }))
  const [editing, setEditing] = useState<Item | 'new' | null>(null)
  const removing = useRun(() => list.reload())
  const rows = (list.data ?? []).filter((i) =>
    (!type || i.item_type === type) && (!state || (state === 'active') === i.is_active))
  function remove(i: Item) {
    if (!window.confirm(`Delete the item “${i.name}”? This cannot be undone.`)) return
    void removing.run(() => erp.deleteItem(i.id), 'That item could not be deleted')
  }
  return (
    <>
      <div className="crm-bar itl-bar">
        <Search value={q} onChange={setQ} placeholder="Search code, name, make, part number" />
        <select value={type} onChange={(e) => setType(e.target.value as typeof type)} aria-label="Type">
          <option value="">All types</option>
          <option value="goods">Goods</option>
          <option value="service">Services</option>
        </select>
        <select value={state} onChange={(e) => setState(e.target.value as typeof state)} aria-label="Status">
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        {list.data && <span className="itl-count">{rows.length} of {list.data.length} items</span>}
        {manage && (
          <button className="btn btn-primary crm-push" onClick={() => setEditing('new')}><IconPlus size={15} /> New item</button>
        )}
      </div>
      {list.error && <ErrorNote>{list.error}</ErrorNote>}
      {removing.error && <div style={{ marginBottom: 10 }}><ErrorNote>{removing.error}</ErrorNote></div>}
      <section className="card itl-card">
        {!list.data ? <Loading /> : list.data.length === 0 ? (
          <EmptyState icon={<IconBuilding size={22} />} title="No items yet" body="Add what you buy, stock and sell. Services are items too — they are simply never stocked." />
        ) : rows.length === 0 ? (
          <EmptyState icon={<IconSearch size={22} />} title="Nothing matches" body="Change the search or the filters." />
        ) : (
          <div className="table-wrap"><table className="itl">
            <thead><tr>
              <th className="itl-c-item">Item</th><th>Type</th><th>Make / model</th><th>HSN / SAC</th><th>UOM</th>
              <th className="crm-num">GST</th><th className="crm-num">Cost</th><th className="crm-num">Price</th>
              <th className="crm-num">Stock</th><th>Status</th>
              {manage && <th className="itl-c-act">Actions</th>}
            </tr></thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id} className={i.is_active ? '' : 'is-off'}>
                  <td className="itl-c-item">
                    <span className="itl-item">
                      <span className="itl-thumb" aria-hidden>{i.image ? <img src={i.image} alt="" /> : <IconBuilding size={14} />}</span>
                      <span className="itl-name">
                        <b title={i.name}>{i.name}</b>
                        <small><span className="crm-code">{i.code}</span>{i.category ? ` · ${i.category}` : ''}{i.is_serialized ? ' · serialised' : ''}</small>
                      </span>
                    </span>
                  </td>
                  <td><span className={`itl-type is-${i.item_type}`}>{i.item_type === 'goods' ? 'Goods' : 'Service'}</span></td>
                  <td className="itl-muted" title={[i.make, i.model].filter(Boolean).join(' ') || undefined}>{[i.make, i.model].filter(Boolean).join(' ') || '—'}</td>
                  <td className="itl-mono">{i.hsn_sac || '—'}</td>
                  <td>{i.uom}</td>
                  <td className="crm-num">{Number(i.gst_percent)}%</td>
                  <td className="crm-num">{rupees(i.standard_cost)}</td>
                  <td className="crm-num itl-price">{rupees(i.sale_price)}</td>
                  <td className={`crm-num${i.below_reorder ? ' itl-low' : ''}`} title={i.below_reorder ? 'At or below the reorder level' : undefined}>
                    {i.item_type === 'goods' ? qtyText(i.available_qty) : '—'}
                  </td>
                  <td><ErpState value={i.is_active ? 'active' : 'inactive'} /></td>
                  {manage && (
                    <td className="itl-c-act">
                      <div className="crm-row-actions itl-actions">
                        <button className="crm-icon-btn" onClick={() => setEditing(i)} title="Edit" aria-label={`Edit ${i.name}`}>
                          <IconEdit size={14} />
                        </button>
                        <button className="crm-icon-btn crm-icon-danger" onClick={() => remove(i)} disabled={removing.busy}
                          title="Delete" aria-label={`Delete ${i.name}`}>
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
      {editing && <ItemForm item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload() }} />}
    </>
  )
}

const UNITS = ['Nos', 'Pcs', 'Box', 'Set', 'Kg', 'Mtr', 'Ltr', 'Hrs', 'Month', 'Year']
const GST_RATES = ['0', '5', '12', '18', '28']

function ItemForm({ item, onClose, onSaved }: { item: Item | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<Record<string, unknown>>(
    item ? { ...ITEM_BLANK, ...item, tags: item.tags ?? [] } : { ...ITEM_BLANK, tags: [] },
  )
  const { busy, error, run } = useRun()
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }))
  const value = (k: string) => String(form[k] ?? '')
  /* Master -> ERP Master -> Item Categories. The item keeps the name, so a
     category typed before the list existed still shows as an option. */
  const categories = useQuery<Array<{ id: string; name: string; is_active: boolean }>>(
    'crm-master-item-categories', () => crm.masters('item-categories'),
  )
  const category = value('category')
  const categoryNames = (categories.data ?? []).filter((c) => c.is_active).map((c) => c.name)
  /* Master -> ERP Master -> Companies, stored on the item as its make. */
  const companies = useQuery<Array<{ id: string; name: string; is_active: boolean }>>(
    'crm-master-item-companies', () => crm.masters('item-companies'),
  )
  const make = value('make')
  const companyNames = (companies.data ?? []).filter((c) => c.is_active).map((c) => c.name)
  const goods = form.item_type === 'goods'
  const gst = String(Number(form.gst_percent || 0))
  const purchaseGst = String(Number(form.purchase_gst_percent ?? form.gst_percent ?? 0))
  const cost = Number(form.standard_cost || 0)
  const price = Number(form.sale_price || 0)
  const margin = cost > 0 && price > 0 ? ((price - cost) / price) * 100 : null
  const ready = Boolean(String(form.code).trim() && String(form.name).trim())

  const incl = price * (1 + Number(gst) / 100)

  return (
    <Dialog wide title={item ? `Edit item · ${item.code}` : 'New item'}
      onClose={onClose} footer={
      <>
        <span className="itx-req"><b>*</b> Required</span>
        {error && <span className="error">{error}</span>}
        <span className="crm-push" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !ready}
          onClick={() => void run(async () => { await erp.saveItem(goods ? form : { ...form, barcode: null }, item?.id); onSaved() })}>
          <IconCheck size={14} /> {busy ? 'Saving…' : item ? 'Save changes' : 'Save item'}
        </button>
      </>
    }>
      <div className="itx">
        {/* ---------------------------------------------- the item at a glance */}
        <aside className="itx-side">
          <ImagePicker value={(form.image as string | null) ?? null} onChange={(v) => set('image', v)} />
          <div className="itx-type" role="radiogroup" aria-label="Item type">
            {([['goods', 'Goods'], ['service', 'Service']] as const).map(([key, label]) => (
              <button key={key} type="button" role="radio" aria-checked={form.item_type === key}
                className={form.item_type === key ? 'is-on' : ''}
                title={key === 'goods' ? 'Stocked, received and issued' : 'Billed, never stocked'}
                onClick={() => set('item_type', key)}>
                {label}
              </button>
            ))}
          </div>
          <dl className="itx-summary">
            <div><dt>Sale price incl. GST</dt><dd>{rupees(incl)}<small> / {value('uom') || 'unit'}</small></dd></div>
            <div>
              <dt>Margin</dt>
              <dd className={margin === null ? 'is-none' : margin < 0 ? 'is-low' : 'is-good'}>
                {margin === null ? '—' : `${margin.toFixed(1)}%`}
                {margin !== null && <small> · {rupees(price - cost)}</small>}
              </dd>
            </div>
            <div><dt>Sales / purchase tax</dt><dd>{gst}% / {purchaseGst}%</dd></div>
          </dl>
          <div className="itx-switches">
            <label className="itf-switch">
              <input type="checkbox" checked={Boolean(form.is_active)} onChange={(e) => set('is_active', e.target.checked)} />
              <span className="itf-switch-track" aria-hidden />
              <span>{form.is_active ? 'Active' : 'Inactive'}</span>
            </label>
            {goods && (
              <label className="itf-switch" title="Each unit gets its own serial on receipt, issue and invoice.">
                <input type="checkbox" checked={Boolean(form.is_serialized)} onChange={(e) => set('is_serialized', e.target.checked)} />
                <span className="itf-switch-track" aria-hidden />
                <span>Track serial numbers</span>
              </label>
            )}
          </div>
        </aside>

        {/* ------------------------------------------------------- the details */}
        <div className="itx-main">
          <section className="itx-section">
            <h3 className="itx-title"><IconSheet size={14} /> Basic details</h3>
            <div className="itx-grid">
              <Field label="Reference / SKU *">
                <input value={value('code')} onChange={(e) => set('code', e.target.value.toUpperCase())}
                  placeholder="e.g. CAM-4MP-01" maxLength={40} autoFocus={!item} className="itx-mono" />
              </Field>
              <Field label="Item name *" wide>
                <input value={value('name')} onChange={(e) => set('name', e.target.value)}
                  placeholder="As it should print on documents" maxLength={200} />
              </Field>
              <Field label="Category">
                <select value={category} onChange={(e) => set('category', e.target.value)}>
                  <option value="">{categoryNames.length ? 'Select category' : 'None yet — add in Master'}</option>
                  {category && !categoryNames.includes(category) && <option value={category}>{category}</option>}
                  {categoryNames.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </Field>
              <Field label="Unit">
                <select value={value('uom')} onChange={(e) => set('uom', e.target.value)}>
                  {!UNITS.includes(value('uom')) && <option value={value('uom')}>{value('uom')}</option>}
                  {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
              </Field>
              {/* A service has nothing to scan. */}
              {goods && (
                <Field label="Barcode">
                  <input value={value('barcode')} onChange={(e) => set('barcode', e.target.value)}
                    placeholder="EAN / UPC — scan or type" maxLength={64} />
                </Field>
              )}
              <div className={`crm-field ${goods ? 'crm-form-wide' : 'itx-span-3'}`}>
                <span className="crm-field-label">Tags</span>
                <TagInput tags={(form.tags as string[]) ?? []} onChange={(next) => set('tags', next)} />
              </div>
              <div className="crm-field itx-full">
                <span className="crm-field-label">Description</span>
                <input value={value('description')} onChange={(e) => set('description', e.target.value)}
                  placeholder="Specification or notes (optional)" />
              </div>
            </div>
          </section>

          <section className="itx-section">
            <h3 className="itx-title"><IconCard size={14} /> Pricing &amp; tax</h3>
            <div className="itx-grid itx-grid-5">
              <Field label="Sale price">
                <span className="itf-affix"><i>₹</i>
                  <input inputMode="decimal" value={value('sale_price')} onChange={(e) => set('sale_price', e.target.value)} />
                </span>
              </Field>
              <Field label="Sales tax">
                <select value={gst} onChange={(e) => {
                  // A purchase rate still equal to the old sales rate was never
                  // set on its own, so it follows.
                  const next = e.target.value
                  setForm((f) => ({
                    ...f, gst_percent: next,
                    ...(String(Number(f.purchase_gst_percent ?? 0)) === gst ? { purchase_gst_percent: next } : {}),
                  }))
                }}>
                  {!GST_RATES.includes(gst) && <option value={gst}>GST {gst}%</option>}
                  {GST_RATES.map((r) => <option key={r} value={r}>GST {r}%</option>)}
                </select>
              </Field>
              <Field label="Cost">
                <span className="itf-affix"><i>₹</i>
                  <input inputMode="decimal" value={value('standard_cost')} onChange={(e) => set('standard_cost', e.target.value)} />
                </span>
              </Field>
              <Field label="Purchase tax">
                <select value={purchaseGst} onChange={(e) => set('purchase_gst_percent', e.target.value)}>
                  {!GST_RATES.includes(purchaseGst) && <option value={purchaseGst}>GST {purchaseGst}%</option>}
                  {GST_RATES.map((r) => <option key={r} value={r}>GST {r}%</option>)}
                </select>
              </Field>
              <Field label={goods ? 'HSN code' : 'SAC code'}>
                <input value={value('hsn_sac')} onChange={(e) => set('hsn_sac', e.target.value)} className="itx-mono"
                  placeholder={goods ? 'e.g. 8525' : 'e.g. 998313'} maxLength={16} inputMode="numeric" />
              </Field>
            </div>
          </section>

          {goods && (
            <section className="itx-section">
              <h3 className="itx-title"><IconBriefcase size={14} /> Product &amp; logistics</h3>
              <div className="itx-grid itx-grid-3">
                <Field label="Company (make / OEM)">
                  <select value={make} onChange={(e) => set('make', e.target.value)}>
                    <option value="">{companyNames.length ? 'Select company' : 'None yet — add in Master'}</option>
                    {make && !companyNames.includes(make) && <option value={make}>{make}</option>}
                    {companyNames.map((name) => <option key={name} value={name}>{name}</option>)}
                  </select>
                </Field>
                <Field label="Model">
                  <input value={value('model')} onChange={(e) => set('model', e.target.value)} placeholder="Model" />
                </Field>
                <Field label="Part number">
                  <input value={value('part_number')} onChange={(e) => set('part_number', e.target.value)} placeholder="Part no." className="itx-mono" />
                </Field>
                <Field label="Warranty">
                  <span className="itf-affix is-suffix">
                    <input inputMode="numeric" value={String(form.warranty_months ?? 0)}
                      onChange={(e) => set('warranty_months', Number(e.target.value.replace(/\D/g, '')) || 0)} />
                    <i>months</i>
                  </span>
                </Field>
                <Field label="Weight">
                  <span className="itf-affix is-suffix">
                    <input inputMode="decimal" value={value('weight_kg')} placeholder="0.00"
                      onChange={(e) => set('weight_kg', e.target.value)} />
                    <i>kg</i>
                  </span>
                </Field>
                <Field label="Volume">
                  <span className="itf-affix is-suffix">
                    <input inputMode="decimal" value={value('volume_m3')} placeholder="0.00"
                      onChange={(e) => set('volume_m3', e.target.value)} />
                    <i>m³</i>
                  </span>
                </Field>
              </div>
            </section>
          )}
        </div>
      </div>
    </Dialog>
  )
}

/** Free tags: Enter or a comma adds one, Backspace on an empty box takes the
 *  last one off. */
function TagInput({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState('')
  function add(raw: string) {
    const tag = raw.trim().slice(0, 40)
    if (tag && !tags.some((t) => t.toLowerCase() === tag.toLowerCase()) && tags.length < 20) onChange([...tags, tag])
    setDraft('')
  }
  return (
    <div className="itf-tags">
      {tags.map((tag) => (
        <span key={tag} className="itf-tag">
          {tag}
          <button type="button" onClick={() => onChange(tags.filter((t) => t !== tag))} aria-label={`Remove ${tag}`}>×</button>
        </span>
      ))}
      <input value={draft} placeholder={tags.length ? '' : 'Add a tag, press Enter'}
        onChange={(e) => (e.target.value.endsWith(',') ? add(e.target.value.slice(0, -1)) : setDraft(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); add(draft) }
          if (e.key === 'Backspace' && !draft && tags.length) onChange(tags.slice(0, -1))
        }}
        onBlur={() => draft && add(draft)} aria-label="Tags" />
    </div>
  )
}

/** The item's picture. Shrunk in the browser to 320px on its long side and
 *  stored as a data URL, so a phone photo costs ~20 KB, not 4 MB. */
function ImagePicker({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const [problem, setProblem] = useState<string | null>(null)
  function pick(file: File | undefined) {
    if (!file) return
    if (!file.type.startsWith('image/')) { setProblem('Choose a picture file.'); return }
    setProblem(null)
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const scale = Math.min(1, 320 / Math.max(img.width, img.height))
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(img.width * scale)
        canvas.height = Math.round(img.height * scale)
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        onChange(canvas.toDataURL('image/jpeg', 0.85))
      }
      img.onerror = () => setProblem('That picture could not be read.')
      img.src = String(reader.result)
    }
    reader.readAsDataURL(file)
  }
  return (
    <div className="itf-photo">
      <label className={`itf-photo-box${value ? ' has-image' : ''}`} title={value ? 'Replace the photo' : 'Add a photo'}>
        <input type="file" accept="image/*" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = '' }} />
        {value ? <img src={value} alt="Item" /> : (
          <span className="itf-photo-icon" aria-hidden>
            <IconCamera size={34} />
            <span className="itf-photo-plus"><IconPlus size={13} /></span>
          </span>
        )}
      </label>
      {value
        ? <button type="button" className="link-btn itf-photo-link" onClick={() => onChange(null)}>Remove</button>
        : <span className="itf-photo-link">Add photo</span>}
      {problem && <span className="error">{problem}</span>}
    </div>
  )
}

/* ------------------------------------------------------------- warehouses --- */

function Warehouses() {
  const { can } = useAccess()
  const list = useQuery('erp-warehouses', () => erp.warehouses())
  const [editing, setEditing] = useState<Warehouse | 'new' | null>(null)
  const manage = can('can_manage_erp_masters')
  const removing = useRun(() => list.reload())
  function remove(w: Warehouse) {
    if (!window.confirm(`Delete the warehouse “${w.name}”? This cannot be undone.`)) return
    void removing.run(() => erp.deleteWarehouse(w.id), 'That warehouse could not be deleted')
  }
  return (
    <>
      <div className="crm-bar">
        {manage && <button className="btn btn-primary crm-push" onClick={() => setEditing('new')}><IconPlus size={15} /> New warehouse</button>}
      </div>
      {removing.error && <div style={{ marginBottom: 10 }}><ErrorNote>{removing.error}</ErrorNote></div>}
      <section className="card wh-card">
        {!list.data ? <Loading /> : list.data.length === 0 ? (
          <EmptyState icon={<IconBuilding size={22} />} title="No warehouses yet" body="Warehouses, hubs, branches, project sites and engineer kits all hold stock." />
        ) : (
          <div className="table-wrap"><table>
            <thead><tr>
              <th style={{ width: '32%' }}>Name</th><th>Description</th>
              {manage && <th className="wh-actions-head">Actions</th>}
            </tr></thead>
            <tbody>{list.data.map((w) => (
              <tr key={w.id}>
                <td><b>{w.name}</b></td>
                <td>{w.description || <span className="crm-muted">—</span>}</td>
                {manage && (
                  <td>
                    <div className="crm-row-actions wh-actions">
                      <button className="crm-icon-btn" onClick={() => setEditing(w)}
                        title="Edit" aria-label={`Edit ${w.name}`}>
                        <IconEdit size={15} />
                      </button>
                      <button className="crm-icon-btn crm-icon-danger" onClick={() => remove(w)}
                        disabled={removing.busy} title="Delete" aria-label={`Delete ${w.name}`}>
                        <IconTrash size={15} />
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      {editing && <WarehouseForm wh={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload() }} />}
    </>
  )
}

function WarehouseForm({ wh, onClose, onSaved }: { wh: Warehouse | null; onClose: () => void; onSaved: () => void }) {
  /* Name and description only. The code is numbered by the server, and an
     edit sends just these two so kind, address and state stay as they are. */
  const [form, setForm] = useState({ name: wh?.name ?? '', description: wh?.description ?? '' })
  const { busy, error, run } = useRun()
  return (
    <Dialog title={wh ? `Edit warehouse · ${wh.code}` : 'New warehouse'} onClose={onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !form.name.trim()}
          onClick={() => void run(async () => { await erp.saveWarehouse(form, wh?.id); onSaved() })}>
          {busy ? 'Saving…' : wh ? 'Save changes' : 'Save warehouse'}
        </button>
      </>
    }>
      <div className="itf">
        <div className="itf-grid itf-grid-1">
          <Field label="Name *">
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Main Warehouse, Pune" maxLength={160} autoFocus />
          </Field>
          <Field label="Description">
            <textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Location, purpose or notes (optional)" />
          </Field>
        </div>
      </div>
    </Dialog>
  )
}

/* ---------------------------------------------------------------- vendors --- */

const VENDOR_BLANK = {
  legal_name: '', vendor_type: 'distributor', category: '', gstin: '', pan: '', contact_name: '', email: '',
  phone: '', address: '', state: '', payment_terms_days: 30, advance_allowed: false, is_msme: false,
  msme_number: '', agreement_expiry: '',
}

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase())
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()
const VENDOR_TYPE_LABEL: Record<string, string> = {
  oem: 'OEM', distributor: 'Distributor', service_partner: 'Service partner', transporter: 'Transporter', other: 'Other',
}
type VendorView = '' | 'active' | 'awaiting' | 'msme' | 'blocked'

function Vendors() {
  const { can } = useAccess()
  const manage = can('can_manage_erp_masters')
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [type, setType] = useState('')
  const [view, setView] = useState<VendorView>('')
  // One load; the cards, the search and the filters all work on it.
  const list = useQuery('erp-vendors-all', () => erp.vendors({}))
  const [open, setOpen] = useState<Vendor | null>(null)
  const [creating, setCreating] = useState(false)
  const all = list.data ?? []
  const needle = q.trim().toLowerCase()
  const inView = (v: Vendor, w: VendorView) =>
    !w || (w === 'active' && v.status === 'active') || (w === 'awaiting' && (v.status === 'draft' || v.status === 'pending'))
    || (w === 'msme' && v.is_msme) || (w === 'blocked' && (v.status === 'suspended' || v.status === 'blacklisted'))
  const rows = all.filter((v) => inView(v, view) && (!status || v.status === status) && (!type || v.vendor_type === type)
    && (!needle || [v.code, v.legal_name, v.gstin, v.pan, v.category, v.contact_name, v.phone, v.email, v.state]
      .some((x) => x && x.toLowerCase().includes(needle))))
  const count = (w: VendorView) => all.filter((v) => inView(v, w)).length
  const pick = (w: VendorView) => { setView((cur) => (cur === w ? '' : w)); setStatus('') }
  const filtered = Boolean(q || status || type || view)
  const cards: [VendorView, string, string, string][] = [
    ['', 'All vendors', `${all.length}`, `${new Set(all.map((v) => v.category).filter(Boolean)).size} categories`],
    ['active', 'Active', `${count('active')}`, 'Ready for purchase orders'],
    ['awaiting', 'Awaiting approval', `${count('awaiting')}`, 'Draft or submitted'],
    ['msme', 'MSME', `${count('msme')}`, 'Pay within 45 days'],
    ['blocked', 'On hold', `${count('blocked')}`, 'Suspended or blacklisted'],
  ]
  return (
    <>
      <div className="vdl-kpis">
        {cards.map(([key, label, value, sub]) => (
          <button key={label} type="button" className={`vdl-kpi is-${key || 'all'}${view === key && (key || !filtered) ? ' is-on' : ''}`}
            onClick={() => pick(key)}>
            <span>{label}</span><b>{list.data ? value : '—'}</b><small>{sub}</small>
          </button>
        ))}
      </div>

      <div className="crm-bar itl-bar">
        <Search value={q} onChange={setQ} placeholder="Search name, code, GSTIN, PAN, contact, category" />
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Vendor type">
          <option value="">All types</option>
          {VENDOR_TYPES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <select value={status} onChange={(e) => { setStatus(e.target.value); setView('') }} aria-label="Status">
          <option value="">Any status</option>
          {[['draft', 'Draft'], ['pending', 'Awaiting approval'], ['active', 'Active'], ['suspended', 'Suspended'], ['blacklisted', 'Blacklisted']]
            .map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        {filtered && <button type="button" className="btn btn-sm" onClick={() => { setQ(''); setStatus(''); setType(''); setView('') }}>Clear</button>}
        {list.data && <span className="itl-count">{rows.length} of {all.length} vendors</span>}
        {manage && <button className="btn btn-primary crm-push" onClick={() => setCreating(true)}><IconPlus size={15} /> New vendor</button>}
      </div>
      {list.error && <ErrorNote>{list.error}</ErrorNote>}

      <section className="card itl-card">
        {!list.data ? <Loading /> : all.length === 0 ? (
          <EmptyState icon={<IconBuilding size={22} />} title="No vendors" body="A vendor is purchasable once somebody other than its creator approves it." />
        ) : rows.length === 0 ? (
          <EmptyState icon={<IconSearch size={22} />} title="Nothing matches" body="Change the search or the filters." />
        ) : (
          <div className="table-wrap"><table className="itl vdl">
            <thead><tr>
              <th className="vdl-c-name">Vendor</th><th>Type</th><th>Contact</th><th>State</th><th>GSTIN / PAN</th>
              <th className="crm-num">Terms</th><th className="crm-num">Score</th><th>Status</th><th className="itl-c-act">Actions</th>
            </tr></thead>
            <tbody>{rows.map((v) => (
              <tr key={v.id} onClick={() => setOpen(v)} className={`vdl-row${v.status === 'blacklisted' || v.status === 'suspended' ? ' is-off' : ''}`}>
                <td className="vdl-c-name">
                  <span className="itl-item">
                    <span className={`vdl-avatar is-${v.vendor_type}`} aria-hidden>{initials(v.legal_name)}</span>
                    <span className="itl-name">
                      <b title={v.legal_name}>{v.legal_name}</b>
                      <small><span className="crm-code">{v.code}</span>{v.category ? ` · ${v.category}` : ''}</small>
                    </span>
                  </span>
                </td>
                <td>
                  <span className={`vdl-type is-${v.vendor_type}`}>{VENDOR_TYPE_LABEL[v.vendor_type] ?? v.vendor_type}</span>
                  {v.is_msme && <span className="vdl-tag" title={v.msme_number ?? 'MSME'}>MSME</span>}
                </td>
                <td className="vdl-contact">
                  {v.contact_name ? <b>{v.contact_name}</b> : <span className="itl-muted">—</span>}
                  {(v.phone || v.email) && <small title={v.email ?? undefined}>{v.phone ?? v.email}</small>}
                </td>
                <td className="itl-muted">{v.state ? titleCase(v.state) : '—'}</td>
                <td className="vdl-tax">
                  <span className="itl-mono">{v.gstin ?? '—'}</span>
                  {v.pan && <small>PAN {v.pan}</small>}
                </td>
                <td className="crm-num">{v.payment_terms_days} days{v.advance_allowed && <small className="vdl-sub">Advance OK</small>}</td>
                <td className="crm-num">{v.performance_score != null ? <span className="vdl-score">{Number(v.performance_score).toFixed(1)}</span> : <span className="itl-muted">—</span>}</td>
                <td>
                  <ErpState value={v.status} />
                  {v.agreement_expired && <small className="vdl-warn">Agreement expired</small>}
                </td>
                <td className="itl-c-act" onClick={(e) => e.stopPropagation()}>
                  <div className="crm-row-actions itl-actions">
                    <button className="crm-icon-btn" onClick={() => setOpen(v)} title="Open" aria-label={`Open ${v.legal_name}`}><IconSheet size={14} /></button>
                  </div>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      {creating && <VendorForm vendor={null} onClose={() => setCreating(false)} onSaved={(v) => { setCreating(false); list.reload(); setOpen(v) }} />}
      {open && <VendorDrawer vendor={open} onClose={() => setOpen(null)} onChanged={(v) => { setOpen(v); list.reload() }} />}
    </>
  )
}

const VENDOR_TYPES = [
  ['oem', 'OEM / manufacturer'], ['distributor', 'Distributor'], ['service_partner', 'Service partner'],
  ['transporter', 'Transporter'], ['other', 'Other'],
] as const

function VendorForm({ vendor, onClose, onSaved }: { vendor: Vendor | null; onClose: () => void; onSaved: (v: Vendor) => void }) {
  const [form, setForm] = useState<Record<string, string | number | boolean | null>>(
    vendor ? { ...VENDOR_BLANK, ...vendor } as never : VENDOR_BLANK)
  const { busy, error, run } = useRun()
  const set = (k: string, v: string | number | boolean) => setForm({ ...form, [k]: v })
  const value = (k: string) => String(form[k] ?? '')
  /* Master -> ERP Master -> Item Categories, the same list items use. */
  const categories = useQuery<Array<{ id: string; name: string; is_active: boolean }>>(
    'crm-master-item-categories', () => crm.masters('item-categories'),
  )
  const category = value('category')
  const categoryNames = (categories.data ?? []).filter((c) => c.is_active).map((c) => c.name)
  const body = { ...form }
  delete body.banks
  return (
    <Dialog wide title={vendor ? `Edit vendor · ${vendor.code}` : 'New vendor'} onClose={onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        <button className="btn crm-push" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !String(form.legal_name).trim()}
          onClick={() => void run(async () => onSaved(await erp.saveVendor(body, vendor?.id)))}>
          {busy ? 'Saving…' : vendor ? 'Save changes' : 'Save vendor'}
        </button>
      </>
    }>
      <div className="itf">
        <section className="itf-section">
          <header className="itf-head">
            <span className="itf-icon" aria-hidden><IconBuilding size={15} /></span>
            <h3 className="itf-title">Company details</h3>
          </header>
          <div className="itf-grid">
            <Field label="Legal name *" wide>
              <input value={value('legal_name')} onChange={(e) => set('legal_name', e.target.value)}
                placeholder="As registered for GST" maxLength={200} autoFocus={!vendor} />
            </Field>
            <Field label="Vendor type">
              <select value={value('vendor_type')} onChange={(e) => set('vendor_type', e.target.value)}>
                {VENDOR_TYPES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </Field>
            <Field label="Category">
              <select value={category} onChange={(e) => set('category', e.target.value)}>
                <option value="">{categoryNames.length ? 'Select category' : 'None yet — add in Master'}</option>
                {category && !categoryNames.includes(category) && <option value={category}>{category}</option>}
                {categoryNames.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </Field>
            <Field label="GSTIN">
              <input value={value('gstin')} onChange={(e) => set('gstin', e.target.value.toUpperCase())}
                placeholder="27AAAAA0000A1Z5" maxLength={15} />
            </Field>
            <Field label="PAN">
              <input value={value('pan')} onChange={(e) => set('pan', e.target.value.toUpperCase())}
                placeholder="AAAAA0000A" maxLength={10} />
            </Field>
            <Field label="State">
              <input value={value('state')} onChange={(e) => set('state', e.target.value)} placeholder="e.g. Maharashtra" />
            </Field>
            <Field label="Agreement expiry">
              <input type="date" value={value('agreement_expiry')} onChange={(e) => set('agreement_expiry', e.target.value)} />
            </Field>
          </div>
        </section>

        <section className="itf-section">
          <header className="itf-head">
            <span className="itf-icon" aria-hidden><IconUser size={15} /></span>
            <h3 className="itf-title">Contact</h3>
          </header>
          <div className="itf-grid">
            <Field label="Contact person">
              <input value={value('contact_name')} onChange={(e) => set('contact_name', e.target.value)} placeholder="Full name" />
            </Field>
            <Field label="Phone">
              <input type="tel" inputMode="tel" value={value('phone')} onChange={(e) => set('phone', e.target.value)} placeholder="+91 98765 43210" />
            </Field>
            <Field label="Email" wide>
              <input type="email" value={value('email')} onChange={(e) => set('email', e.target.value)} placeholder="accounts@vendor.com" />
            </Field>
            <div className="itf-full">
              <Field label="Address">
                <input value={value('address')} onChange={(e) => set('address', e.target.value)} placeholder="Street, city, PIN code" />
              </Field>
            </div>
          </div>
        </section>

        <section className="itf-section">
          <header className="itf-head">
            <span className="itf-icon" aria-hidden><IconCard size={15} /></span>
            <h3 className="itf-title">Terms &amp; compliance</h3>
          </header>
          <div className="itf-grid">
            <Field label="Payment terms">
              <span className="itf-affix is-suffix">
                <input inputMode="numeric" value={String(form.payment_terms_days)}
                  onChange={(e) => set('payment_terms_days', Number(e.target.value.replace(/\D/g, '')) || 0)} />
                <i>days</i>
              </span>
            </Field>
            {form.is_msme && (
              <Field label="Udyam number">
                <input value={value('msme_number')} onChange={(e) => set('msme_number', e.target.value.toUpperCase())}
                  placeholder="UDYAM-MH-00-0000000" maxLength={19} />
              </Field>
            )}
          </div>
          <div className="itf-options">
            <label className="itf-option">
              <span>
                <b>MSME registered</b>
                <small>Payments are due within 45 days under the MSMED Act.</small>
              </span>
              <span className="itf-switch">
                <input type="checkbox" checked={Boolean(form.is_msme)} onChange={(e) => set('is_msme', e.target.checked)} />
                <span className="itf-switch-track" aria-hidden />
              </span>
            </label>
            <label className="itf-option">
              <span>
                <b>Advances allowed</b>
                <small>Purchase orders may be paid before delivery.</small>
              </span>
              <span className="itf-switch">
                <input type="checkbox" checked={Boolean(form.advance_allowed)} onChange={(e) => set('advance_allowed', e.target.checked)} />
                <span className="itf-switch-track" aria-hidden />
              </span>
            </label>
          </div>
        </section>
      </div>
    </Dialog>
  )
}

/** A vendor, opened from the list: a centred view, not a side sheet. Who
 *  they are and how to reach them on the left; terms, performance and the
 *  approval trail on the right; actions in the header. */
function VendorDrawer({ vendor, onClose, onChanged }: { vendor: Vendor; onClose: () => void; onChanged: (v: Vendor) => void }) {
  const { can } = useAccess()
  const { busy, error, run } = useRun()
  const [editing, setEditing] = useState(false)
  const [prompt, setPrompt] = useState<null | { title: string; act: (reason: string) => Promise<Vendor> }>(null)
  const [adding, setAdding] = useState(false)
  const [bank, setBank] = useState({ account_name: '', account_number: '', ifsc: '', bank_name: '' })
  const act = (fn: () => Promise<Vendor>) => void run(async () => onChanged(await fn()))
  const manage = can('can_manage_erp_masters')
  const verify = can('can_verify_vendors')
  const nested = editing || Boolean(prompt)
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !nested) onClose() }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [nested, onClose])

  const v = vendor
  const score = v.performance_score != null ? Number(v.performance_score) : null
  const ifscOk = /^[A-Z]{4}0[A-Z0-9]{6}$/.test(bank.ifsc.trim().toUpperCase())
  const steps: [boolean, string, string | null][] = [
    [true, 'Created', v.created_by_name ? `by ${v.created_by_name}` : null],
    [v.status !== 'draft', 'Submitted for approval', v.status === 'draft' ? 'Not yet' : null],
    [Boolean(v.approved_by_name) || v.status === 'active', v.status === 'pending' ? 'Awaiting approval' : 'Approved',
      v.approved_by_name ? `by ${v.approved_by_name}` : v.status === 'pending' ? 'By somebody other than the creator' : null],
  ]

  return (
    <div className="vdv-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !nested && onClose()}>
      <div className="vdv" role="dialog" aria-modal="true" aria-label={v.legal_name}>
        <header className="vdv-head">
          <span className={`vdl-avatar vdv-avatar is-${v.vendor_type}`} aria-hidden>{initials(v.legal_name)}</span>
          <div className="vdv-ident">
            <h2>{v.legal_name}</h2>
            <div className="vdv-meta">
              <span className="crm-code">{v.code}</span>
              <ErpState value={v.status} />
              <span className={`vdl-type is-${v.vendor_type}`}>{VENDOR_TYPE_LABEL[v.vendor_type] ?? v.vendor_type}</span>
              {v.is_msme && <span className="vdl-tag">MSME</span>}
              {v.category && <span className="vdv-cat">{v.category}</span>}
            </div>
          </div>
          <div className="vdv-tools">
            {manage && <button className="btn btn-sm" onClick={() => setEditing(true)}><IconEdit size={14} /> Edit</button>}
            {v.status === 'draft' && manage && (
              <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(() => erp.submitVendor(v.id))}>Submit for approval</button>
            )}
            {v.status === 'pending' && verify && (
              <>
                <button className="btn btn-sm" onClick={() => setPrompt({ title: 'Send back to draft', act: (r) => erp.decideVendor(v.id, false, r) })}>Send back</button>
                <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(() => erp.decideVendor(v.id, true))}><IconCheck size={14} /> Approve</button>
              </>
            )}
            {v.status === 'active' && verify && (
              <>
                <button className="btn btn-sm" onClick={() => setPrompt({ title: 'Suspend vendor', act: (r) => erp.vendorStatus(v.id, 'suspended', r) })}>Suspend</button>
                <button className="btn btn-sm vdv-danger" onClick={() => setPrompt({ title: 'Blacklist vendor', act: (r) => erp.vendorStatus(v.id, 'blacklisted', r) })}>Blacklist</button>
              </>
            )}
            {(v.status === 'suspended' || v.status === 'blacklisted') && verify && (
              <button className="btn btn-sm btn-primary" onClick={() => setPrompt({ title: 'Reactivate vendor', act: (r) => erp.vendorStatus(v.id, 'active', r) })}>Reactivate</button>
            )}
            <button className="crm-icon-btn vdv-close" onClick={onClose} aria-label="Close"><IconClose size={16} /></button>
          </div>
        </header>
        {error && <div className="vdv-error"><ErrorNote>{error}</ErrorNote></div>}

        <div className="vdv-body">
          <main className="vdv-main">
            {(v.status_reason || v.agreement_expired) && (
              <div className="vdv-notes">
                {v.status_reason && <Note>{v.status_reason}</Note>}
                {v.agreement_expired && <Note>The vendor agreement / OEM authorisation has expired.</Note>}
              </div>
            )}
            <section className="vdv-card">
              <h3>Business details</h3>
              <dl className="vdv-facts">
                <div><dt>GSTIN</dt><dd className="vdv-mono">{v.gstin ?? '—'}</dd></div>
                <div><dt>PAN</dt><dd className="vdv-mono">{v.pan ?? '—'}</dd></div>
                <div><dt>Vendor type</dt><dd>{VENDOR_TYPES.find(([k]) => k === v.vendor_type)?.[1] ?? v.vendor_type}</dd></div>
                <div><dt>Category</dt><dd>{v.category ?? '—'}</dd></div>
                <div><dt>State</dt><dd>{v.state ? titleCase(v.state) : '—'}</dd></div>
                <div><dt>MSME</dt><dd>{v.is_msme ? (v.msme_number ?? 'Yes') : 'No'}</dd></div>
                <div className="is-wide"><dt>Address</dt><dd>{v.address ?? '—'}</dd></div>
              </dl>
            </section>

            <section className="vdv-card">
              <h3>Contact</h3>
              <div className="vdv-contact">
                <span className="vdv-person"><IconUser size={15} /><b>{v.contact_name ?? 'No contact person'}</b></span>
                {v.phone && <a href={`tel:${v.phone}`}>{v.phone}</a>}
                {v.email && <a href={`mailto:${v.email}`}>{v.email}</a>}
              </div>
            </section>

            <section className="vdv-card">
              <div className="vdv-card-head">
                <h3>Bank accounts</h3>
                {manage && !adding && <button className="btn btn-sm" onClick={() => setAdding(true)}><IconPlus size={13} /> Add account</button>}
              </div>
              <p className="vdv-hint">Every change is a new account, verified by somebody other than whoever entered it.</p>
              {v.banks.length === 0 && !adding && <p className="vdv-empty">No bank account yet.</p>}
              {v.banks.length > 0 && (
                <ul className="vdv-banks">
                  {v.banks.map((b) => (
                    <li key={b.id} className={b.status === 'superseded' || b.status === 'rejected' ? 'is-off' : ''}>
                      <span className="vdv-bank-ic"><IconCard size={15} /></span>
                      <div className="vdv-bank">
                        <b>{b.account_name}</b>
                        <small><span className="vdv-mono">{b.account_number}</span> · {b.ifsc}{b.bank_name ? ` · ${b.bank_name}` : ''}</small>
                        <small>Added by {b.created_by_name ?? '—'}{b.verified_by_name ? ` · checked by ${b.verified_by_name}` : ''}{b.note ? ` · ${b.note}` : ''}</small>
                      </div>
                      <ErpState value={b.status} />
                      {b.status === 'pending' && verify && (
                        <span className="vdv-bank-act">
                          <button className="btn btn-sm" onClick={() => setPrompt({ title: 'Reject bank account', act: (r) => erp.verifyBank(v.id, b.id, false, r) })}>Reject</button>
                          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(() => erp.verifyBank(v.id, b.id, true))}>Verify</button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {manage && adding && (
                <div className="vdv-addbank">
                  <label><span>Account name</span><input value={bank.account_name} autoFocus onChange={(e) => setBank({ ...bank, account_name: e.target.value })} /></label>
                  <label><span>Account number</span><input inputMode="numeric" value={bank.account_number} onChange={(e) => setBank({ ...bank, account_number: e.target.value.replace(/\s/g, '') })} /></label>
                  <label><span>IFSC</span><input value={bank.ifsc} className={bank.ifsc && !ifscOk ? 'is-bad' : ''} placeholder="HDFC0001234"
                    onChange={(e) => setBank({ ...bank, ifsc: e.target.value.toUpperCase() })} /></label>
                  <label><span>Bank</span><input value={bank.bank_name} onChange={(e) => setBank({ ...bank, bank_name: e.target.value })} /></label>
                  <div className="vdv-addbank-act">
                    <button className="btn btn-sm" onClick={() => { setAdding(false); setBank({ account_name: '', account_number: '', ifsc: '', bank_name: '' }) }}>Cancel</button>
                    <button className="btn btn-sm btn-primary" disabled={busy || !bank.account_number || !ifscOk || !bank.account_name}
                      onClick={() => act(async () => {
                        const out = await erp.addBank(v.id, bank)
                        setBank({ account_name: '', account_number: '', ifsc: '', bank_name: '' })
                        setAdding(false)
                        return out
                      })}>Save account</button>
                  </div>
                </div>
              )}
            </section>
          </main>

          <aside className="vdv-side">
            <section className="vdv-card">
              <h3>Commercial terms</h3>
              <dl className="vdv-kv">
                <dt>Payment terms</dt><dd>{v.payment_terms_days} days</dd>
                <dt>Advance</dt><dd>{v.advance_allowed ? 'Allowed' : 'Not allowed'}</dd>
                <dt>Agreement expiry</dt><dd className={v.agreement_expired ? 'is-bad' : ''}>{v.agreement_expiry ? <DateText iso={v.agreement_expiry} /> : '—'}</dd>
                {v.is_msme && <><dt>MSME rule</dt><dd>Pay within 45 days</dd></>}
              </dl>
            </section>
            <section className="vdv-card">
              <h3>Performance</h3>
              {score == null ? <p className="vdv-empty">No goods received yet — scored from GRNs.</p> : (
                <div className="vdv-score">
                  <b>{score.toFixed(1)}<small>/ 5</small></b>
                  <span className="vdv-bar"><i style={{ width: `${Math.max(0, Math.min(100, score * 20))}%` }} /></span>
                </div>
              )}
            </section>
            <section className="vdv-card">
              <h3>Approval</h3>
              <ul className="vdv-steps">
                {steps.map(([done, label, sub]) => (
                  <li key={label} className={done ? 'is-done' : ''}><i /><div><b>{label}</b>{sub && <small>{sub}</small>}</div></li>
                ))}
                {(v.status === 'suspended' || v.status === 'blacklisted') && (
                  <li className="is-bad"><i /><div><b>{titleCase(v.status)}</b>{v.status_reason && <small>{v.status_reason}</small>}</div></li>
                )}
              </ul>
              {v.status !== 'active' && <p className="vdv-hint">Only an active vendor can be put on a purchase order.</p>}
            </section>
          </aside>
        </div>
      </div>
      {editing && <VendorForm vendor={vendor} onClose={() => setEditing(false)} onSaved={(nv) => { setEditing(false); onChanged(nv) }} />}
      {prompt && <ReasonDialog title={prompt.title} onClose={() => setPrompt(null)} onSubmit={async (r) => onChanged(await prompt.act(r))} />}
    </div>
  )
}

/* -------------------------------------------------------------- customers --- */

function Customers() {
  const [q, setQ] = useState('')
  const list = useQuery(`erp-customers-${q}`, () => erp.customers(q.trim() || undefined))
  const [open, setOpen] = useState<CustomerAccount | null>(null)
  return (
    <>
      <Search value={q} onChange={setQ} placeholder="Search CRM customers" />
      {list.error && <ErrorNote>{erpError(list.cause, 'Could not load customers')}</ErrorNote>}
      <section className="card">
        {!list.data ? <Loading /> : list.data.length === 0 ? (
          <EmptyState icon={<IconBuilding size={22} />} title="No customers" body="Customers come from the CRM — convert a lead, or add one under CRM → My Customers." />
        ) : (
          <div className="table-wrap"><table>
            <thead><tr><th>Customer</th><th className="crm-num">Credit limit</th><th>Credit days</th><th className="crm-num">Outstanding</th><th className="crm-num">Overdue</th><th>Hold</th></tr></thead>
            <tbody>{list.data.map((c) => (
              <tr key={c.customer_id} onClick={() => setOpen(c)} style={{ cursor: 'pointer' }}>
                <td><span className="crm-code">{c.customer_code}</span> {c.customer_name}</td>
                <td className="crm-num">{c.account ? rupees(c.account.credit_limit) : '—'}</td>
                <td>{c.account ? `${c.account.credit_days} days` : '—'}</td>
                <td className="crm-num">{rupees(c.outstanding)}</td>
                <td className="crm-num" style={Number(c.overdue) > 0 ? { color: 'var(--status-critical)' } : undefined}>{rupees(c.overdue)}</td>
                <td>{c.account?.credit_hold ? <ErpState value="on_hold" /> : '—'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      {open && <CustomerDrawer customer={open} onClose={() => setOpen(null)} onChanged={(c) => { setOpen(c); list.reload() }} />}
    </>
  )
}

function CustomerDrawer({ customer, onClose, onChanged }: { customer: CustomerAccount; onClose: () => void; onChanged: (c: CustomerAccount) => void }) {
  const { can } = useAccess()
  const a = customer.account
  const [form, setForm] = useState({
    legal_name: a?.legal_name ?? customer.customer_name, gstin: a?.gstin ?? customer.crm_gstin ?? '', pan: a?.pan ?? '',
    billing_address: a?.billing_address ?? '', billing_state: a?.billing_state ?? '', shipping_address: a?.shipping_address ?? '',
    credit_limit: a?.credit_limit ?? '0', credit_days: a?.credit_days ?? 30,
  })
  const [site, setSite] = useState({ name: '', address: '', state: '', contact_name: '', contact_phone: '' })
  const [holding, setHolding] = useState(false)
  const { busy, error, run } = useRun()
  const editable = can('can_manage_billing')
  return (
    <Drawer title={customer.customer_name} meta={customer.customer_code} onClose={onClose} footer={
      <div className="crm-row-actions">
        {error && <span className="error">{error}</span>}
        {can('can_approve_billing') && (
          <button className="btn" onClick={() => setHolding(true)}>{a?.credit_hold ? 'Release hold' : 'Place on credit hold'}</button>
        )}
        {editable && <button className="btn btn-primary" disabled={busy}
          onClick={() => void run(async () => onChanged(await erp.saveCustomer(customer.customer_id, form)))}>Save terms</button>}
      </div>
    }>
      {a?.credit_hold && <Note>On credit hold: {a.hold_reason}</Note>}
      <Facts items={[
        ['Outstanding', rupees(customer.outstanding)], ['Overdue', rupees(customer.overdue)],
        ['Oldest overdue', customer.oldest_overdue_days ? `${customer.oldest_overdue_days} days` : '—'],
        ['Open orders (unbilled)', rupees(customer.open_order_value)],
      ]} />
      <div className="crm-form">
        <Field label="Legal name" wide><input disabled={!editable} value={form.legal_name} onChange={(e) => setForm({ ...form, legal_name: e.target.value })} /></Field>
        <Field label="GSTIN"><input disabled={!editable} value={form.gstin} onChange={(e) => setForm({ ...form, gstin: e.target.value })} /></Field>
        <Field label="PAN"><input disabled={!editable} value={form.pan} onChange={(e) => setForm({ ...form, pan: e.target.value })} /></Field>
        <Field label="Credit limit (₹, 0 = none)"><input disabled={!editable} inputMode="decimal" value={form.credit_limit} onChange={(e) => setForm({ ...form, credit_limit: e.target.value })} /></Field>
        <Field label="Credit days"><input disabled={!editable} inputMode="numeric" value={String(form.credit_days)} onChange={(e) => setForm({ ...form, credit_days: Number(e.target.value) || 0 })} /></Field>
        <Field label="Billing state (place of supply)"><input disabled={!editable} value={form.billing_state} onChange={(e) => setForm({ ...form, billing_state: e.target.value })} /></Field>
        <Field label="Billing address" wide><textarea disabled={!editable} rows={2} value={form.billing_address} onChange={(e) => setForm({ ...form, billing_address: e.target.value })} /></Field>
        <Field label="Shipping address" wide><textarea disabled={!editable} rows={2} value={form.shipping_address} onChange={(e) => setForm({ ...form, shipping_address: e.target.value })} /></Field>
      </div>

      <h4 className="crm-panel-title" style={{ marginTop: 16 }}>Sites</h4>
      {(a?.sites ?? []).map((s) => (
        <div key={s.id} className="crm-sub" style={{ padding: '4px 0' }}><span className="crm-strong">{s.name}</span> · {s.address ?? ''} {s.state ? `(${s.state})` : ''} {s.contact_name ? `· ${s.contact_name} ${s.contact_phone ?? ''}` : ''}</div>
      ))}
      {can('can_manage_sales_orders') && (
        <div className="crm-form" style={{ marginTop: 8 }}>
          <Field label="Site name"><input value={site.name} onChange={(e) => setSite({ ...site, name: e.target.value })} /></Field>
          <Field label="State"><input value={site.state} onChange={(e) => setSite({ ...site, state: e.target.value })} /></Field>
          <Field label="Contact"><input value={site.contact_name} onChange={(e) => setSite({ ...site, contact_name: e.target.value })} /></Field>
          <Field label="Phone"><input value={site.contact_phone} onChange={(e) => setSite({ ...site, contact_phone: e.target.value })} /></Field>
          <Field label="Address" wide><input value={site.address} onChange={(e) => setSite({ ...site, address: e.target.value })} /></Field>
          <div><button className="btn btn-sm" disabled={busy || !site.name}
            onClick={() => void run(async () => { onChanged(await erp.addSite(customer.customer_id, site)); setSite({ name: '', address: '', state: '', contact_name: '', contact_phone: '' }) })}>Add site</button></div>
        </div>
      )}
      {holding && (
        <ReasonDialog title={a?.credit_hold ? 'Release credit hold' : 'Place on credit hold'} onClose={() => setHolding(false)}
          onSubmit={async (r) => onChanged(await erp.customerHold(customer.customer_id, !a?.credit_hold, r))} />
      )}
    </Drawer>
  )
}
