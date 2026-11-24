/* Masters — items, warehouses, vendors and the customer's financial account.
 *
 * Customers are not created here. They are the CRM's, and this screen only adds
 * what billing needs beside them: credit terms, the hold, delivery sites. */

import { Fragment, useEffect, useState, type ReactNode } from 'react'
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
import {
  ColumnSettings, FieldSettings, useColumns, useFieldModes,
  type FieldDef, type FieldSection,
} from '../../components/ViewSettings'
import { cells, heads, type Col } from './listColumns'
import ImportExport, { type IoColumn } from '../../components/ImportExport'
import FilterPopup, { FilterField } from '../../components/FilterPopup'
import Ledgers from './ErpLedgers'
import Accounts from './ErpAccounts'
import Salesmen from './ErpSalesmen'
import Walkins from './ErpWalkins'
import Lookups from './ErpLookups'
import Companies from './ErpCompanies'
import BillSeriesPage from './ErpBillSeries'
import Stations from './ErpStations'
import { LedgerOpenings, PrintBarcode, RackUpdate, StockOpenings } from './ErpUpdateMaster'

/** A state picked from the State Master. Stored by name, as the vendor record keeps it;
 *  a name typed earlier that is not in the master stays selectable so nothing is lost. */
function StateSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const list = useQuery<Array<{ id: string; name: string; is_active?: boolean }>>(
    'crm-master-states-all', () => crm.masters('states'),
  )
  const names = (list.data ?? []).filter((r) => r.is_active !== false).map((r) => r.name)
  if (value && !names.includes(value)) names.push(value)
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off">
      <option value="">{list.loading ? 'Loading…' : 'Select state'}</option>
      {names.sort((x, y) => x.localeCompare(y)).map((n) => <option key={n} value={n}>{n}</option>)}
    </select>
  )
}

type Tab = 'items' | 'warehouses' | 'vendors' | 'customers' | 'ledgers' | 'accounts' | 'salesmen' | 'walkins' | 'subcategories' | 'units' | 'hsn' | 'racks' | 'billseries' | 'companies' | 'stations' | 'ledger-openings' | 'stock-openings' | 'rack-update' | 'print-barcode'

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'items', label: 'Items' }, { key: 'warehouses', label: 'Warehouses' },
  { key: 'vendors', label: 'Vendors' }, { key: 'customers', label: 'Customer accounts' },
  { key: 'ledgers', label: 'Ledger' }, { key: 'accounts', label: 'List of accounts' },
  { key: 'salesmen', label: 'Salesman' }, { key: 'walkins', label: 'Walk-in customers' },
  { key: 'subcategories', label: 'Sub categories' }, { key: 'units', label: 'Units' }, { key: 'hsn', label: 'HSN / SAC' },
  { key: 'racks', label: 'Racks' }, { key: 'billseries', label: 'Bill series' },
  { key: 'companies', label: 'Companies' }, { key: 'stations', label: 'Stations' },
  { key: 'ledger-openings', label: 'Ledger openings' }, { key: 'stock-openings', label: 'Stock openings' }, { key: 'rack-update', label: 'Rack update' }, { key: 'print-barcode', label: 'Print barcode' },
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
          { label: ['ledgers', 'accounts', 'salesmen', 'walkins'].includes(only.key) ? 'Ledger Master'
              : only.key === 'stations' ? 'Geography'
              : ['ledger-openings', 'stock-openings', 'rack-update', 'print-barcode'].includes(only.key) ? 'Update Master'
              : ['items', 'warehouses', 'subcategories', 'units', 'hsn', 'racks', 'billseries', 'companies'].includes(only.key) ? 'Inventory Masters' : 'ERP Master', to: '/masters' },
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
          {tab === 'ledgers' && <Ledgers />}
          {tab === 'accounts' && <Accounts />}
          {tab === 'salesmen' && <Salesmen />}
          {tab === 'walkins' && <Walkins />}
          {tab === 'subcategories' && <Lookups kind="subcategory" />}
          {tab === 'units' && <Lookups kind="unit" />}
          {tab === 'hsn' && <Lookups kind="hsn" />}
          {tab === 'racks' && <Lookups kind="rack" />}
          {tab === 'billseries' && <BillSeriesPage />}
          {tab === 'companies' && <Companies />}
          {tab === 'stations' && <Stations />}
          {tab === 'ledger-openings' && <LedgerOpenings />}
          {tab === 'rack-update' && <RackUpdate />}
          {tab === 'print-barcode' && <PrintBarcode />}
          {tab === 'stock-openings' && <StockOpenings />}
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
          {tab === 'ledgers' && <Ledgers />}
          {tab === 'accounts' && <Accounts />}
          {tab === 'salesmen' && <Salesmen />}
          {tab === 'walkins' && <Walkins />}
          {tab === 'subcategories' && <Lookups kind="subcategory" />}
          {tab === 'units' && <Lookups kind="unit" />}
          {tab === 'hsn' && <Lookups kind="hsn" />}
          {tab === 'racks' && <Lookups kind="rack" />}
          {tab === 'billseries' && <BillSeriesPage />}
          {tab === 'companies' && <Companies />}
          {tab === 'stations' && <Stations />}
          {tab === 'ledger-openings' && <LedgerOpenings />}
          {tab === 'rack-update' && <RackUpdate />}
          {tab === 'print-barcode' && <PrintBarcode />}
          {tab === 'stock-openings' && <StockOpenings />}
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

const cleanNum = (v: string, label: string, fallback = '0') => {
  const t = (v ?? '').replace(/[,₹\s]/g, '')
  if (!t) return fallback
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`${label} must be a number`)
  return t
}
const pick = (v: string, label: string, allowed: string[], fallback: string) => {
  const t = (v ?? '').trim().toLowerCase().replace(/[\s/-]+/g, '_')
  if (!t) return fallback
  if (!allowed.includes(t)) throw new Error(`${label} must be one of: ${allowed.join(', ')}`)
  return t
}
const ITEM_IO: IoColumn<Item>[] = [
  { key: 'code', label: 'Reference / SKU', required: true, sample: 'CAM-4MP-01', get: (i) => i.code },
  { key: 'name', label: 'Item name', required: true, sample: '4MP Dome Camera', get: (i) => i.name },
  { key: 'item_type', label: 'Type', sample: 'goods', get: (i) => i.item_type },
  { key: 'category', label: 'Category', sample: 'Cameras', get: (i) => i.category },
  { key: 'uom', label: 'Unit', sample: 'Nos', get: (i) => i.uom },
  { key: 'hsn_sac', label: 'HSN / SAC', sample: '8525', get: (i) => i.hsn_sac },
  { key: 'gst_percent', label: 'Sales GST %', sample: '18', get: (i) => i.gst_percent },
  { key: 'purchase_gst_percent', label: 'Purchase GST %', sample: '18', get: (i) => i.purchase_gst_percent },
  { key: 'sale_price', label: 'Sale price', sample: '4500', get: (i) => i.sale_price },
  { key: 'standard_cost', label: 'Cost', sample: '3200', get: (i) => i.standard_cost },
  { key: 'make', label: 'Make', sample: '', get: (i) => i.make },
  { key: 'model', label: 'Model', sample: '', get: (i) => i.model },
  { key: 'part_number', label: 'Part number', sample: '', get: (i) => i.part_number },
  { key: 'barcode', label: 'Barcode', sample: '', get: (i) => i.barcode },
  { key: 'description', label: 'Description', sample: '', get: (i) => i.description },
  { key: 'status', label: 'Status', sample: 'active', get: (i) => (i.is_active ? 'active' : 'inactive') },
]
const buildItem = (r: Record<string, string>) => ({
  ...ITEM_BLANK,
  code: r.code.toUpperCase(), name: r.name,
  item_type: pick(r.item_type, 'Type', ['goods', 'service'], 'goods'),
  category: r.category ?? '', uom: r.uom || 'Nos', hsn_sac: r.hsn_sac ?? '',
  gst_percent: cleanNum(r.gst_percent, 'Sales GST %', '18'),
  purchase_gst_percent: cleanNum(r.purchase_gst_percent, 'Purchase GST %', cleanNum(r.gst_percent, 'Sales GST %', '18')),
  sale_price: cleanNum(r.sale_price, 'Sale price'), standard_cost: cleanNum(r.standard_cost, 'Cost'),
  make: r.make ?? '', model: r.model ?? '', part_number: r.part_number ?? '', barcode: r.barcode ?? '',
  description: r.description ?? '',
  is_active: pick(r.status, 'Status', ['active', 'inactive'], 'active') === 'active',
})

type ItemColumn = Col<Item>
const ITEM_COLUMNS: ItemColumn[] = [
  { key: 'item', label: 'Item', locked: true, thClass: 'itl-c-item', className: 'itl-c-item', td: (i) => (
    <span className="itl-item">
      <span className="itl-thumb" aria-hidden>{i.image ? <img src={i.image} alt="" /> : <IconBuilding size={14} />}</span>
      <span className="itl-name">
        <b title={i.name}>{i.name}</b>
        <small><span className="crm-code">{i.code}</span>{i.category ? ` · ${i.category}` : ''}{i.is_serialized ? ' · serialised' : ''}</small>
      </span>
    </span>
  ) },
  { key: 'type', label: 'Type', td: (i) => <span className={`itl-type is-${i.item_type}`}>{i.item_type === 'goods' ? 'Goods' : 'Service'}</span> },
  { key: 'make', label: 'Make / model', className: 'itl-muted',
    title: (i) => [i.make, i.model].filter(Boolean).join(' ') || undefined,
    td: (i) => [i.make, i.model].filter(Boolean).join(' ') || '—' },
  { key: 'hsn', label: 'HSN / SAC', className: 'itl-mono', td: (i) => i.hsn_sac || '—' },
  { key: 'uom', label: 'UOM', td: (i) => i.uom },
  { key: 'gst', label: 'GST', thClass: 'crm-num', className: 'crm-num', td: (i) => `${Number(i.gst_percent)}%` },
  { key: 'cost', label: 'Cost', thClass: 'crm-num', className: 'crm-num', td: (i) => rupees(i.standard_cost) },
  { key: 'price', label: 'Price', thClass: 'crm-num', className: 'crm-num itl-price', td: (i) => rupees(i.sale_price) },
  { key: 'stock', label: 'Stock', thClass: 'crm-num',
    className: (i) => `crm-num${i.below_reorder ? ' itl-low' : ''}`,
    title: (i) => (i.below_reorder ? 'At or below the reorder level' : undefined),
    td: (i) => (i.item_type === 'goods' ? qtyText(i.available_qty) : '—') },
  { key: 'status', label: 'Status', td: (i) => <ErpState value={i.is_active ? 'active' : 'inactive'} /> },
  { key: 'category', label: 'Category', initial: false, td: (i) => i.category || '—' },
  { key: 'part_number', label: 'Part number', initial: false, className: 'itl-mono', td: (i) => i.part_number || '—' },
  { key: 'barcode', label: 'Barcode', initial: false, className: 'itl-mono', td: (i) => i.barcode || '—' },
  { key: 'purchase_gst', label: 'Purchase GST', initial: false, thClass: 'crm-num', className: 'crm-num', td: (i) => `${Number(i.purchase_gst_percent)}%` },
  { key: 'reorder', label: 'Reorder level', initial: false, thClass: 'crm-num', className: 'crm-num', td: (i) => qtyText(i.reorder_level) },
  { key: 'warranty', label: 'Warranty', initial: false, td: (i) => (i.warranty_months ? `${i.warranty_months} months` : '—') },
]

function Items() {
  const columns = useColumns('erp-items', ITEM_COLUMNS)
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
        <div className="crm-push" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <ImportExport name="items" columns={ITEM_IO} rows={rows} canImport={manage} build={buildItem}
            save={(b) => erp.saveItem(b)} onDone={() => list.reload()} />
          <ColumnSettings defs={ITEM_COLUMNS} order={columns.pref.order} hidden={columns.pref.hidden}
            onSave={columns.save} onReset={columns.reset} />
          {manage && (
            <button className="btn btn-primary" onClick={() => setEditing('new')}><IconPlus size={15} /> New item</button>
          )}
        </div>
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
              {heads<Item>(columns.visible)}
              {manage && <th className="itl-c-act">Actions</th>}
            </tr></thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id} className={i.is_active ? '' : 'is-off'}>
                  {cells<Item>(columns.visible, i)}
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

const ITEM_SECTIONS: FieldSection[] = [
  { id: 'basic', label: 'Basic details' },
  { id: 'pricing', label: 'Pricing & tax' },
  { id: 'logistics', label: 'Product & logistics' },
]
// Code and name are what the server requires of an item. The tax rates, unit and
// warranty always hold a value, so they can be moved or hidden but never "mandatory".
const ITEM_FIELDS: FieldDef[] = [
  { key: 'code', label: 'Reference / SKU', section: 'basic', fixed: true },
  { key: 'name', label: 'Item name', section: 'basic', fixed: true },
  { key: 'category', label: 'Category', section: 'basic' },
  { key: 'uom', label: 'Unit', section: 'basic', optionalOnly: true },
  { key: 'barcode', label: 'Barcode (goods)', section: 'basic' },
  { key: 'tags', label: 'Tags', section: 'basic' },
  { key: 'description', label: 'Description', section: 'basic' },
  { key: 'sale_price', label: 'Sale price', section: 'pricing' },
  { key: 'gst_percent', label: 'Sales tax', section: 'pricing', optionalOnly: true },
  { key: 'standard_cost', label: 'Cost', section: 'pricing' },
  { key: 'purchase_gst_percent', label: 'Purchase tax', section: 'pricing', optionalOnly: true },
  { key: 'hsn_sac', label: 'HSN / SAC code', section: 'pricing' },
  { key: 'make', label: 'Company (make / OEM)', section: 'logistics' },
  { key: 'model', label: 'Model', section: 'logistics' },
  { key: 'part_number', label: 'Part number', section: 'logistics' },
  { key: 'warranty_months', label: 'Warranty', section: 'logistics', optionalOnly: true },
  { key: 'weight_kg', label: 'Weight', section: 'logistics' },
  { key: 'volume_m3', label: 'Volume', section: 'logistics' },
]

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

  const fields = useFieldModes('erp-item-form', ITEM_FIELDS)
  const fm = fields.mode
  const rq = (key: string) => fm(key) === 'mandatory'
  const emptyField: Record<string, boolean> = {
    category: !category.trim(),
    barcode: goods && !value('barcode').trim(),
    tags: ((form.tags as string[]) ?? []).length === 0,
    description: !value('description').trim(),
    sale_price: !value('sale_price').trim(),
    standard_cost: !value('standard_cost').trim(),
    hsn_sac: !value('hsn_sac').trim(),
    make: goods && !make.trim(),
    model: goods && !value('model').trim(),
    part_number: goods && !value('part_number').trim(),
    weight_kg: goods && !value('weight_kg').trim(),
    volume_m3: goods && !value('volume_m3').trim(),
  }
  const missing = Object.keys(emptyField).some((k) => fm(k) === 'mandatory' && emptyField[k])
  const fieldNodes: Record<string, ReactNode> = {
    code: (
      <Field label="Reference / SKU *">
        <input value={value('code')} onChange={(e) => set('code', e.target.value.toUpperCase())}
          placeholder="e.g. CAM-4MP-01" maxLength={40} autoFocus={!item} className="itx-mono" />
      </Field>
    ),
    name: (
      <Field label="Item name *" wide>
        <input value={value('name')} onChange={(e) => set('name', e.target.value)}
          placeholder="As it should print on documents" maxLength={200} />
      </Field>
    ),
    category: fm('category') !== 'hide' && (
      <Field label="Category" required={rq('category')}>
        <select value={category} onChange={(e) => set('category', e.target.value)}>
          <option value="">{categoryNames.length ? 'Select category' : 'None yet — add in Master'}</option>
          {category && !categoryNames.includes(category) && <option value={category}>{category}</option>}
          {categoryNames.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </Field>
    ),
    uom: fm('uom') !== 'hide' && (
      <Field label="Unit">
        <select value={value('uom')} onChange={(e) => set('uom', e.target.value)}>
          {!UNITS.includes(value('uom')) && <option value={value('uom')}>{value('uom')}</option>}
          {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
      </Field>
    ),
    /* A service has nothing to scan. */
    barcode: goods && fm('barcode') !== 'hide' && (
      <Field label="Barcode" required={rq('barcode')}>
        <input value={value('barcode')} onChange={(e) => set('barcode', e.target.value)}
          placeholder="EAN / UPC — scan or type" maxLength={64} />
      </Field>
    ),
    tags: fm('tags') !== 'hide' && (
      <div className={`crm-field ${goods ? 'crm-form-wide' : 'itx-span-3'}`}>
        <span className="crm-field-label">Tags{rq('tags') && <span className="lf-req"> *</span>}</span>
        <TagInput tags={(form.tags as string[]) ?? []} onChange={(next) => set('tags', next)} />
      </div>
    ),
    description: fm('description') !== 'hide' && (
      <div className="crm-field itx-full">
        <span className="crm-field-label">Description{rq('description') && <span className="lf-req"> *</span>}</span>
        <input value={value('description')} onChange={(e) => set('description', e.target.value)}
          placeholder="Specification or notes (optional)" />
      </div>
    ),
    sale_price: fm('sale_price') !== 'hide' && (
      <Field label="Sale price" required={rq('sale_price')}>
        <span className="itf-affix"><i>₹</i>
          <input placeholder="e.g. 45000" type="number" data-spin min={0} step="any" value={value('sale_price')} onChange={(e) => set('sale_price', e.target.value)} />
        </span>
      </Field>
    ),
    gst_percent: fm('gst_percent') !== 'hide' && (
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
    ),
    standard_cost: fm('standard_cost') !== 'hide' && (
      <Field label="Cost" required={rq('standard_cost')}>
        <span className="itf-affix"><i>₹</i>
          <input placeholder="e.g. 32000" type="number" data-spin min={0} step="any" value={value('standard_cost')} onChange={(e) => set('standard_cost', e.target.value)} />
        </span>
      </Field>
    ),
    purchase_gst_percent: fm('purchase_gst_percent') !== 'hide' && (
      <Field label="Purchase tax">
        <select value={purchaseGst} onChange={(e) => set('purchase_gst_percent', e.target.value)}>
          {!GST_RATES.includes(purchaseGst) && <option value={purchaseGst}>GST {purchaseGst}%</option>}
          {GST_RATES.map((r) => <option key={r} value={r}>GST {r}%</option>)}
        </select>
      </Field>
    ),
    hsn_sac: fm('hsn_sac') !== 'hide' && (
      <Field label={goods ? 'HSN code' : 'SAC code'} required={rq('hsn_sac')}>
        <input value={value('hsn_sac')} onChange={(e) => set('hsn_sac', e.target.value)} className="itx-mono"
          placeholder={goods ? 'e.g. 8525' : 'e.g. 998313'} maxLength={16} inputMode="numeric" />
      </Field>
    ),
    make: fm('make') !== 'hide' && (
      <Field label="Company (make / OEM)" required={rq('make')}>
        <select value={make} onChange={(e) => set('make', e.target.value)}>
          <option value="">{companyNames.length ? 'Select company' : 'None yet — add in Master'}</option>
          {make && !companyNames.includes(make) && <option value={make}>{make}</option>}
          {companyNames.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </Field>
    ),
    model: fm('model') !== 'hide' && (
      <Field label="Model" required={rq('model')}>
        <input value={value('model')} onChange={(e) => set('model', e.target.value)} placeholder="Model" />
      </Field>
    ),
    part_number: fm('part_number') !== 'hide' && (
      <Field label="Part number" required={rq('part_number')}>
        <input value={value('part_number')} onChange={(e) => set('part_number', e.target.value)} placeholder="Part no." className="itx-mono" />
      </Field>
    ),
    warranty_months: fm('warranty_months') !== 'hide' && (
      <Field label="Warranty">
        <span className="itf-affix is-suffix">
          <input placeholder="12" type="number" data-spin min={0} step={1} value={String(form.warranty_months ?? 0)}
            onChange={(e) => set('warranty_months', Number(e.target.value.replace(/\D/g, '')) || 0)} />
          <i>months</i>
        </span>
      </Field>
    ),
    weight_kg: fm('weight_kg') !== 'hide' && (
      <Field label="Weight" required={rq('weight_kg')}>
        <span className="itf-affix is-suffix">
          <input type="number" data-spin min={0} step="any" value={value('weight_kg')} placeholder="0.00"
            onChange={(e) => set('weight_kg', e.target.value)} />
          <i>kg</i>
        </span>
      </Field>
    ),
    volume_m3: fm('volume_m3') !== 'hide' && (
      <Field label="Volume" required={rq('volume_m3')}>
        <span className="itf-affix is-suffix">
          <input type="number" data-spin min={0} step="any" value={value('volume_m3')} placeholder="0.00"
            onChange={(e) => set('volume_m3', e.target.value)} />
          <i>m³</i>
        </span>
      </Field>
    ),
  }
  const fieldsOf = (section: string) =>
    fields.orderOf(section).map((key) => <Fragment key={key}>{fieldNodes[key]}</Fragment>)


  return (
    <Dialog wide title={item ? `Edit item · ${item.code}` : 'New item'}
      onClose={onClose} footer={
      <>
        <span className="itx-req"><b>*</b> Required</span>
        {error && <span className="error">{error}</span>}
        {missing && <span className="error">Fill in the fields marked <b className="lf-req">*</b></span>}
        <span className="crm-push" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !ready || missing}
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
          <div className="lf-settings">
            <FieldSettings defs={ITEM_FIELDS} sections={ITEM_SECTIONS} modes={fields.modes} order={fields.order}
              onSave={fields.save} onReset={fields.reset} />
          </div>
          <section className="itx-section">
            <h3 className="itx-title"><IconSheet size={14} /> Basic details</h3>
            <div className="itx-grid">
              {fieldsOf('basic')}
            </div>
          </section>

          <section className="itx-section">
            <h3 className="itx-title"><IconCard size={14} /> Pricing &amp; tax</h3>
            <div className="itx-grid itx-grid-5">
              {fieldsOf('pricing')}
            </div>
          </section>

          {goods && (
            <section className="itx-section">
              <h3 className="itx-title"><IconBriefcase size={14} /> Product &amp; logistics</h3>
              <div className="itx-grid itx-grid-3">
                {fieldsOf('logistics')}
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

type WarehouseColumn = Col<Warehouse>
const KIND_LABEL: Record<string, string> = {
  warehouse: 'Warehouse', hub: 'Hub', branch: 'Branch', site: 'Project site', engineer: 'Engineer kit',
}
const WAREHOUSE_COLUMNS: WarehouseColumn[] = [
  { key: 'name', label: 'Store', locked: true, thStyle: { width: '28%' }, td: (w) => <b>{w.name}</b> },
  { key: 'code', label: 'Code', td: (w) => <span className="crm-code">{w.code}</span> },
  { key: 'address', label: 'Address', td: (w) => w.address || <span className="crm-muted">—</span> },
  { key: 'default', label: 'Default', td: (w) => (w.is_default ? <b>Default</b> : <span className="crm-muted">—</span>) },
  { key: 'racks', label: 'Racks', td: (w) => String(w.racks ?? 0) },
  { key: 'description', label: 'Description', initial: false, td: (w) => w.description || <span className="crm-muted">—</span> },
  { key: 'kind', label: 'Kind', initial: false, td: (w) => KIND_LABEL[w.kind] ?? w.kind },
  { key: 'state', label: 'State', initial: false, td: (w) => w.state || <span className="crm-muted">—</span> },
  { key: 'custodian', label: 'Custodian', initial: false, td: (w) => w.custodian_name || <span className="crm-muted">—</span> },
  { key: 'status', label: 'Status', initial: false, td: (w) => <ErpState value={w.is_active ? 'active' : 'inactive'} /> },
]

const WAREHOUSE_IO: IoColumn<Warehouse>[] = [
  { key: 'name', label: 'Store name', required: true, sample: 'Main Store', get: (w) => w.name },
  { key: 'code', label: 'Code', sample: 'WH-01', get: (w) => w.code },
  { key: 'address', label: 'Address', sample: '', get: (w) => w.address },
  { key: 'default', label: 'Default', sample: 'no', get: (w) => (w.is_default ? 'yes' : 'no') },
  { key: 'status', label: 'Status', sample: 'active', get: (w) => (w.is_active ? 'active' : 'inactive') },
]
const buildWarehouse = (r: Record<string, string>) => ({
  code: r.code ? r.code.toUpperCase() : null, name: r.name, address: r.address ?? '',
  is_default: pick(r.default, 'Default', ['yes', 'no'], 'no') === 'yes',
  is_active: pick(r.status, 'Status', ['active', 'inactive'], 'active') === 'active',
})

function Warehouses() {
  const columns = useColumns('erp-warehouses', WAREHOUSE_COLUMNS)
  const { can } = useAccess()
  const list = useQuery('erp-warehouses', () => erp.warehouses())
  const [editing, setEditing] = useState<Warehouse | 'new' | null>(null)
  const [q, setQ] = useState('')
  const [show, setShow] = useState<'active' | 'inactive' | 'all'>('active')
  const [defaultF, setDefaultF] = useState('')
  const manage = can('can_manage_erp_masters')
  const removing = useRun(() => list.reload())
  function remove(w: Warehouse) {
    if (!window.confirm(`Delete the store “${w.name}”? This cannot be undone.`)) return
    void removing.run(() => erp.deleteWarehouse(w.id), 'That store could not be deleted')
  }
  const needle = q.trim().toLowerCase()
  const rows = (list.data ?? []).filter((w) =>
    (show === 'all' || (show === 'active') === w.is_active) && (!defaultF || (defaultF === 'yes') === !!w.is_default)
    && (!needle || [w.name, w.code, w.address].some((x) => x && x.toLowerCase().includes(needle))))
  const extra = (show !== 'active' ? 1 : 0) + (defaultF ? 1 : 0)
  return (
    <>
      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '14px 18px', flexWrap: 'wrap' }}>
          <div>
            <h2 className="card-title" style={{ margin: 0 }}>Stores</h2>
            <p className="muted-sm" style={{ margin: '2px 0 0' }}>Shops, godowns and cold rooms where stock is kept. Racks are made inside a store.</p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <ImportExport name="stores" columns={WAREHOUSE_IO} rows={rows} canImport={manage} build={buildWarehouse}
              save={(b) => erp.saveWarehouse(b)} onDone={() => list.reload()} />
            <ColumnSettings defs={WAREHOUSE_COLUMNS} order={columns.pref.order} hidden={columns.pref.hidden}
              onSave={columns.save} onReset={columns.reset} />
            {manage && <button className="btn btn-primary" onClick={() => setEditing('new')}><IconPlus size={15} /> New store</button>}
          </div>
        </div>
        <div className="crm-bar itl-bar" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="crm-search">
            <IconSearch size={15} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search stores" aria-label="Search stores" />
          </div>
          <FilterPopup count={extra} onReset={() => { setShow('active'); setDefaultF('') }}>
            <FilterField label="Status">
              <select value={show} onChange={(e) => setShow(e.target.value as typeof show)}>
                <option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All</option>
              </select>
            </FilterField>
            <FilterField label="Default store">
              <select value={defaultF} onChange={(e) => setDefaultF(e.target.value)}>
                <option value="">Any</option><option value="yes">The default</option><option value="no">Not the default</option>
              </select>
            </FilterField>
          </FilterPopup>
        </div>
        {removing.error && <div style={{ margin: 10 }}><ErrorNote>{removing.error}</ErrorNote></div>}
        {!list.data ? <Loading /> : rows.length === 0 ? (
          <EmptyState icon={<IconBuilding size={22} />} title={needle || extra ? 'Nothing matches' : 'No stores yet'}
            body={needle || extra ? 'Change the search or the filters.' : 'Add the shops, godowns and cold rooms where stock is kept.'} />
        ) : (
          <div className="table-wrap"><table className="itl">
            <thead><tr>
              {heads<Warehouse>(columns.visible)}
              {manage && <th className="itl-c-act">Actions</th>}
            </tr></thead>
            <tbody>{rows.map((w) => (
              <tr key={w.id} className={w.is_active ? '' : 'is-off'}>
                {cells<Warehouse>(columns.visible, w)}
                {manage && (
                  <td className="itl-c-act">
                    <div className="crm-row-actions itl-actions">
                      <button className="crm-icon-btn" onClick={() => setEditing(w)} title="Edit" aria-label={`Edit ${w.name}`}><IconEdit size={15} /></button>
                      <button className="crm-icon-btn crm-icon-danger" onClick={() => remove(w)} disabled={removing.busy} title="Delete" aria-label={`Delete ${w.name}`}><IconTrash size={15} /></button>
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

const WAREHOUSE_SECTIONS: FieldSection[] = [{ id: 'main', label: 'Store' }]
const WAREHOUSE_FIELDS: FieldDef[] = [
  { key: 'name', label: 'Store name', section: 'main', fixed: true },
  { key: 'code', label: 'Code', section: 'main', optionalOnly: true },
  { key: 'address', label: 'Address', section: 'main' },
  { key: 'default', label: 'Default store', section: 'main', optionalOnly: true },
]

function WarehouseForm({ wh, onClose, onSaved }: { wh: Warehouse | null; onClose: () => void; onSaved: () => void }) {
  /* An edit sends only these, so the kind, state and description set elsewhere stay as they are. */
  const [form, setForm] = useState({
    name: wh?.name ?? '', code: wh?.code ?? '', address: wh?.address ?? '', is_default: Boolean(wh?.is_default), is_active: wh?.is_active ?? true,
  })
  const { busy, error, run } = useRun()
  const fields = useFieldModes('erp-warehouse-form', WAREHOUSE_FIELDS)
  const fm = fields.mode
  const rq = (key: string) => fm(key) === 'mandatory'
  const missing = rq('address') && !form.address.trim()
  const fieldNodes: Record<string, ReactNode> = {
    name: (
      <Field label="Store name" required>
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Main Store" maxLength={160} autoFocus />
      </Field>
    ),
    code: fm('code') !== 'hide' && (
      <Field label="Code">
        <input value={form.code} maxLength={24} placeholder="Made from the name if left blank"
          onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} />
      </Field>
    ),
    address: fm('address') !== 'hide' && (
      <Field label="Address" required={rq('address')}>
        <textarea rows={3} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
      </Field>
    ),
    default: fm('default') !== 'hide' && (
      <label className="crm-check">
        <input type="checkbox" checked={form.is_default} onChange={(e) => setForm({ ...form, is_default: e.target.checked })} />
        <span>Default store — stock lands here unless a bill says otherwise</span>
      </label>
    ),
  }
  return (
    <Dialog title={wh ? `Edit store · ${wh.code}` : 'New store'} subtitle={wh ? undefined : 'Add a store to the list'} onClose={onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        {!error && (missing || !form.name.trim()) && <span className="lf-foot-note lf-foot-link">Store name required</span>}
        <button className="btn crm-push" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !form.name.trim() || missing}
          onClick={() => void run(async () => {
            await erp.saveWarehouse({ name: form.name.trim(), code: form.code.trim() || null, address: form.address.trim() || null,
              is_default: form.is_default, is_active: form.is_active }, wh?.id)
            onSaved()
          })}>
          {busy ? 'Saving…' : wh ? 'Save changes' : 'Add store'}
        </button>
      </>
    }>
      <div className="itf">
        <div className="lf-settings">
          <FieldSettings defs={WAREHOUSE_FIELDS} sections={WAREHOUSE_SECTIONS} modes={fields.modes} order={fields.order}
            onSave={fields.save} onReset={fields.reset} />
        </div>
        <div className="itf-grid itf-grid-1">
          {fields.orderOf('main').map((key) => <Fragment key={key}>{fieldNodes[key]}</Fragment>)}
        </div>
        {wh && <label className="crm-check" style={{ marginTop: 10 }}><input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} /> <span>Active</span></label>}
      </div>
    </Dialog>
  )
}
/* ---------------------------------------------------------------- vendors --- */

const VENDOR_BLANK = {
  legal_name: '', vendor_type: 'distributor', category: '', gstin: '', pan: '', contact_name: '', email: '',
  phone: '', address: '', city: '', state: '', pincode: '', payment_terms_days: 30, advance_allowed: false, is_msme: false,
  msme_number: '', agreement_expiry: '',
}

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase())
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()
const VENDOR_TYPE_LABEL: Record<string, string> = {
  oem: 'OEM', distributor: 'Distributor', service_partner: 'Service partner', transporter: 'Transporter', other: 'Other',
}
type VendorView = '' | 'active' | 'awaiting' | 'msme' | 'blocked'

type VendorColumn = Col<Vendor>
const VENDOR_COLUMNS: VendorColumn[] = [
  { key: 'vendor', label: 'Vendor', locked: true, thClass: 'vdl-c-name', className: 'vdl-c-name', td: (v) => (
    <span className="itl-item">
      <span className={`vdl-avatar is-${v.vendor_type}`} aria-hidden>{initials(v.legal_name)}</span>
      <span className="itl-name">
        <b title={v.legal_name}>{v.legal_name}</b>
        <small><span className="crm-code">{v.code}</span>{v.category ? ` · ${v.category}` : ''}</small>
      </span>
    </span>
  ) },
  { key: 'type', label: 'Type', td: (v) => (
    <>
      <span className={`vdl-type is-${v.vendor_type}`}>{VENDOR_TYPE_LABEL[v.vendor_type] ?? v.vendor_type}</span>
      {v.is_msme && <span className="vdl-tag" title={v.msme_number ?? 'MSME'}>MSME</span>}
    </>
  ) },
  { key: 'contact', label: 'Contact', className: 'vdl-contact', td: (v) => (
    <>
      {v.contact_name ? <b>{v.contact_name}</b> : <span className="itl-muted">—</span>}
      {(v.phone || v.email) && <small title={v.email ?? undefined}>{v.phone ?? v.email}</small>}
    </>
  ) },
  { key: 'state', label: 'State', className: 'itl-muted', td: (v) => (v.state ? titleCase(v.state) : '—') },
  { key: 'tax', label: 'GSTIN / PAN', className: 'vdl-tax', td: (v) => (
    <>
      <span className="itl-mono">{v.gstin ?? '—'}</span>
      {v.pan && <small>PAN {v.pan}</small>}
    </>
  ) },
  { key: 'terms', label: 'Terms', thClass: 'crm-num', className: 'crm-num',
    td: (v) => <>{v.payment_terms_days} days{v.advance_allowed && <small className="vdl-sub">Advance OK</small>}</> },
  { key: 'score', label: 'Score', thClass: 'crm-num', className: 'crm-num',
    td: (v) => (v.performance_score != null
      ? <span className="vdl-score">{Number(v.performance_score).toFixed(1)}</span>
      : <span className="itl-muted">—</span>) },
  { key: 'status', label: 'Status', td: (v) => (
    <>
      <ErpState value={v.status} />
      {v.agreement_expired && <small className="vdl-warn">Agreement expired</small>}
    </>
  ) },
  { key: 'category', label: 'Category', initial: false, td: (v) => v.category || '—' },
  { key: 'email', label: 'Email', initial: false, td: (v) => v.email || '—' },
  { key: 'phone', label: 'Phone', initial: false, td: (v) => v.phone || '—' },
  { key: 'address', label: 'Address', initial: false, td: (v) => v.address || '—' },
  { key: 'msme', label: 'Udyam number', initial: false, className: 'itl-mono', td: (v) => (v.is_msme ? v.msme_number || 'MSME' : '—') },
  { key: 'agreement', label: 'Agreement expiry', initial: false, td: (v) => <DateText iso={v.agreement_expiry} /> },
  { key: 'created_by', label: 'Created by', initial: false, td: (v) => v.created_by_name || '—' },
  { key: 'approved_by', label: 'Approved by', initial: false, td: (v) => v.approved_by_name || '—' },
]

function Vendors() {
  const columns = useColumns('erp-vendors', VENDOR_COLUMNS)
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
  const removing = useRun(() => list.reload())
  function remove(v: Vendor) {
    if (!window.confirm(`Delete the vendor “${v.legal_name}”? This cannot be undone.`)) return
    void removing.run(() => erp.deleteVendor(v.id), 'That vendor could not be deleted')
  }
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
      {removing.error && <div style={{ marginBottom: 10 }}><ErrorNote>{removing.error}</ErrorNote></div>}
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
        <div className="crm-push" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <ImportExport name="vendors" columns={VENDOR_IO} rows={rows} canImport={manage} build={buildVendor}
            save={(b) => erp.saveVendor(b)} onDone={() => list.reload()} />
          <ColumnSettings defs={VENDOR_COLUMNS} order={columns.pref.order} hidden={columns.pref.hidden}
            onSave={columns.save} onReset={columns.reset} />
          {manage && <button className="btn btn-primary" onClick={() => setCreating(true)}><IconPlus size={15} /> New vendor</button>}
        </div>
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
              {heads<Vendor>(columns.visible)}
              <th className="itl-c-act">Actions</th>
            </tr></thead>
            <tbody>{rows.map((v) => (
              <tr key={v.id} onClick={() => setOpen(v)} className={`vdl-row${v.status === 'blacklisted' || v.status === 'suspended' ? ' is-off' : ''}`}>
                {cells<Vendor>(columns.visible, v)}
                <td className="itl-c-act" onClick={(e) => e.stopPropagation()}>
                  <div className="crm-row-actions itl-actions">
                    <button className="crm-icon-btn" onClick={() => setOpen(v)} title="Open" aria-label={`Open ${v.legal_name}`}><IconSheet size={14} /></button>
                    {manage && (
                      <button className="crm-icon-btn crm-icon-danger" onClick={() => remove(v)} disabled={removing.busy}
                        title="Delete" aria-label={`Delete ${v.legal_name}`}><IconTrash size={14} /></button>
                    )}
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

const VENDOR_SECTIONS: FieldSection[] = [
  { id: 'company', label: 'Company details' },
  { id: 'contact', label: 'Contact' },
  { id: 'terms', label: 'Terms & compliance' },
]
// The legal name is what the server requires of a vendor. The type and the
// payment terms always hold a value. The two tick boxes (MSME, advances) are
// not part of this list and stay where they are.
const VENDOR_FIELDS: FieldDef[] = [
  { key: 'legal_name', label: 'Legal name', section: 'company', fixed: true },
  { key: 'vendor_type', label: 'Vendor type', section: 'company', optionalOnly: true },
  { key: 'category', label: 'Category', section: 'company' },
  { key: 'gstin', label: 'GSTIN', section: 'company' },
  { key: 'pan', label: 'PAN', section: 'company' },
  { key: 'agreement_expiry', label: 'Agreement expiry', section: 'company' },
  { key: 'contact_name', label: 'Contact person', section: 'contact' },
  { key: 'phone', label: 'Phone', section: 'contact' },
  { key: 'email', label: 'Email', section: 'contact' },
  { key: 'address', label: 'Street address', section: 'contact' },
  { key: 'state', label: 'State', section: 'contact' },
  { key: 'city', label: 'City', section: 'contact' },
  { key: 'pincode', label: 'PIN code', section: 'contact' },
  { key: 'payment_terms_days', label: 'Payment terms', section: 'terms', optionalOnly: true },
  { key: 'msme_number', label: 'Udyam number (MSME vendors)', section: 'terms' },
]

const VENDOR_IO: IoColumn<Vendor>[] = [
  { key: 'legal_name', label: 'Legal name', required: true, sample: 'Acme Traders Pvt Ltd', get: (v) => v.legal_name },
  { key: 'vendor_type', label: 'Vendor type', sample: 'distributor', get: (v) => v.vendor_type },
  { key: 'category', label: 'Category', sample: '', get: (v) => v.category },
  { key: 'gstin', label: 'GSTIN', sample: '27AAAAA0000A1Z5', get: (v) => v.gstin },
  { key: 'pan', label: 'PAN', sample: 'AAAAA0000A', get: (v) => v.pan },
  { key: 'contact_name', label: 'Contact person', sample: 'Rohit Mehta', get: (v) => v.contact_name },
  { key: 'phone', label: 'Phone', sample: '9845012345', get: (v) => v.phone },
  { key: 'email', label: 'Email', sample: 'accounts@vendor.com', get: (v) => v.email },
  { key: 'address', label: 'Street address', sample: '', get: (v) => v.address },
  { key: 'city', label: 'City', sample: 'Pune', get: (v) => v.city },
  { key: 'state', label: 'State', sample: 'Maharashtra', get: (v) => v.state },
  { key: 'pincode', label: 'PIN code', sample: '411001', get: (v) => v.pincode },
  { key: 'payment_terms_days', label: 'Payment terms (days)', sample: '30', get: (v) => v.payment_terms_days },
  { key: 'status', label: 'Status', get: (v) => v.status },
]
const buildVendor = (r: Record<string, string>) => ({
  ...VENDOR_BLANK,
  legal_name: r.legal_name,
  vendor_type: pick(r.vendor_type, 'Vendor type', ['oem', 'distributor', 'service_partner', 'transporter', 'other'], 'distributor'),
  category: r.category ?? '', gstin: (r.gstin ?? '').toUpperCase(), pan: (r.pan ?? '').toUpperCase(),
  contact_name: r.contact_name ?? '', phone: r.phone ?? '', email: r.email ?? '',
  address: r.address ?? '', city: r.city ?? '', state: r.state ?? '', pincode: r.pincode ?? '',
  payment_terms_days: Number(cleanNum(r.payment_terms_days, 'Payment terms', '30').split('.')[0]),
  agreement_expiry: null,
})

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

  const fields = useFieldModes('erp-vendor-form', VENDOR_FIELDS)
  const fm = fields.mode
  const rq = (key: string) => fm(key) === 'mandatory'
  const emptyField: Record<string, boolean> = {
    category: !category.trim(),
    gstin: !value('gstin').trim(),
    pan: !value('pan').trim(),
    state: !value('state').trim(),
    agreement_expiry: !value('agreement_expiry').trim(),
    contact_name: !value('contact_name').trim(),
    phone: !value('phone').trim(),
    email: !value('email').trim(),
    address: !value('address').trim(),
    city: !value('city').trim(),
    pincode: !value('pincode').trim(),
    msme_number: Boolean(form.is_msme) && !value('msme_number').trim(),
  }
  const missing = Object.keys(emptyField).some((k) => fm(k) === 'mandatory' && emptyField[k])
  /* Shown under the field once it has something typed; an empty optional field is fine. */
  const phoneDigits = value('phone').replace(/[\s\-()]/g, '').replace(/^(\+91|0)/, '')
  const problems: Record<string, string> = {}
  if (value('phone').trim() && !/^[6-9]\d{9}$/.test(phoneDigits)) problems.phone = 'Enter a valid 10-digit mobile number.'
  if (value('email').trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(value('email').trim())) problems.email = 'Enter a valid email address, like name@company.com.'
  if (value('pincode').trim() && !/^\d{6}$/.test(value('pincode').trim())) problems.pincode = 'PIN code must be 6 digits.'
  const invalid = Object.keys(problems).length > 0
  const err = (k: string) => problems[k] ? <span style={{ color: '#dc2626' }}>{problems[k]}</span> : undefined
  const fieldNodes: Record<string, ReactNode> = {
    legal_name: (
      <Field label="Legal name *" wide>
        <input value={value('legal_name')} onChange={(e) => set('legal_name', e.target.value)}
          placeholder="As registered for GST" maxLength={200} autoFocus={!vendor} />
      </Field>
    ),
    vendor_type: fm('vendor_type') !== 'hide' && (
      <Field label="Vendor type">
        <select value={value('vendor_type')} onChange={(e) => set('vendor_type', e.target.value)}>
          {VENDOR_TYPES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      </Field>
    ),
    category: fm('category') !== 'hide' && (
      <Field label="Category" required={rq('category')}>
        <select value={category} onChange={(e) => set('category', e.target.value)}>
          <option value="">{categoryNames.length ? 'Select category' : 'None yet — add in Master'}</option>
          {category && !categoryNames.includes(category) && <option value={category}>{category}</option>}
          {categoryNames.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </Field>
    ),
    gstin: fm('gstin') !== 'hide' && (
      <Field label="GSTIN" required={rq('gstin')}>
        <input value={value('gstin')} onChange={(e) => set('gstin', e.target.value.toUpperCase())}
          placeholder="27AAAAA0000A1Z5" maxLength={15} />
      </Field>
    ),
    pan: fm('pan') !== 'hide' && (
      <Field label="PAN" required={rq('pan')}>
        <input value={value('pan')} onChange={(e) => set('pan', e.target.value.toUpperCase())}
          placeholder="AAAAA0000A" maxLength={10} />
      </Field>
    ),
    state: fm('state') !== 'hide' && (
      <Field label="State" required={rq('state')}>
        <StateSelect value={value('state')} onChange={(v) => set('state', v)} />
      </Field>
    ),
    city: fm('city') !== 'hide' && (
      <Field label="City" required={rq('city')}>
        <input value={value('city')} onChange={(e) => set('city', e.target.value)} placeholder="e.g. Pune" maxLength={120} />
      </Field>
    ),
    pincode: fm('pincode') !== 'hide' && (
      <Field label="PIN code" required={rq('pincode')} hint={err('pincode')}>
        <input value={value('pincode')} inputMode="numeric" maxLength={6} placeholder="6 digits"
          onChange={(e) => set('pincode', e.target.value.replace(/\D/g, ''))} />
      </Field>
    ),
    agreement_expiry: fm('agreement_expiry') !== 'hide' && (
      <Field label="Agreement expiry" required={rq('agreement_expiry')}>
        <input type="date" value={value('agreement_expiry')} onChange={(e) => set('agreement_expiry', e.target.value)} />
      </Field>
    ),
    contact_name: fm('contact_name') !== 'hide' && (
      <Field label="Contact person" required={rq('contact_name')}>
        <input value={value('contact_name')} onChange={(e) => set('contact_name', e.target.value)} placeholder="Full name" maxLength={60} />
      </Field>
    ),
    phone: fm('phone') !== 'hide' && (
      <Field label="Phone" required={rq('phone')} hint={err('phone')}>
        <input type="tel" inputMode="tel" value={value('phone')} maxLength={16}
          onChange={(e) => set('phone', e.target.value.replace(/[^\d+\s\-()]/g, ''))} placeholder="+91 98765 43210" />
      </Field>
    ),
    email: fm('email') !== 'hide' && (
      <Field label="Email" wide required={rq('email')} hint={err('email')}>
        <input type="text" inputMode="email" value={value('email')} onChange={(e) => set('email', e.target.value)} placeholder="accounts@vendor.com" />
      </Field>
    ),
    address: fm('address') !== 'hide' && (
      <div className="itf-full">
        <Field label="Street address" required={rq('address')}>
          <input value={value('address')} onChange={(e) => set('address', e.target.value)} placeholder="House / building, street, area" />
        </Field>
      </div>
    ),
    payment_terms_days: fm('payment_terms_days') !== 'hide' && (
      <Field label="Payment terms">
        <span className="itf-affix is-suffix">
          <input placeholder="30" type="number" data-spin min={0} step={1} value={String(form.payment_terms_days)}
            onChange={(e) => set('payment_terms_days', Number(e.target.value.replace(/\D/g, '')) || 0)} />
          <i>days</i>
        </span>
      </Field>
    ),
    msme_number: Boolean(form.is_msme) && fm('msme_number') !== 'hide' && (
      <Field label="Udyam number" required={rq('msme_number')}>
        <input value={value('msme_number')} onChange={(e) => set('msme_number', e.target.value.toUpperCase())}
          placeholder="UDYAM-MH-00-0000000" maxLength={19} />
      </Field>
    ),
  }
  const fieldsOf = (section: string) =>
    fields.orderOf(section).map((key) => <Fragment key={key}>{fieldNodes[key]}</Fragment>)

  return (
    <Dialog wide title={vendor ? `Edit vendor · ${vendor.code}` : 'New vendor'} onClose={onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        {missing && <span className="error">Fill in the fields marked <b className="lf-req">*</b></span>}
        <button className="btn crm-push" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !String(form.legal_name).trim() || missing || invalid}
          onClick={() => void run(async () => onSaved(await erp.saveVendor(body, vendor?.id)))}>
          {busy ? 'Saving…' : vendor ? 'Save changes' : 'Save vendor'}
        </button>
      </>
    }>
      <div className="itf">
        <div className="lf-settings">
          <FieldSettings defs={VENDOR_FIELDS} sections={VENDOR_SECTIONS} modes={fields.modes} order={fields.order}
            onSave={fields.save} onReset={fields.reset} />
        </div>
        <section className="itf-section">
          <header className="itf-head">
            <span className="itf-icon" aria-hidden><IconBuilding size={15} /></span>
            <h3 className="itf-title">Company details</h3>
          </header>
          <div className="itf-grid">
            {fieldsOf('company')}
          </div>
        </section>

        <section className="itf-section">
          <header className="itf-head">
            <span className="itf-icon" aria-hidden><IconUser size={15} /></span>
            <h3 className="itf-title">Contact</h3>
          </header>
          <div className="itf-grid">
            {fieldsOf('contact')}
          </div>
        </section>

        <section className="itf-section">
          <header className="itf-head">
            <span className="itf-icon" aria-hidden><IconCard size={15} /></span>
            <h3 className="itf-title">Terms &amp; compliance</h3>
          </header>
          <div className="itf-grid">
            {fieldsOf('terms')}
          </div>          <div className="itf-options">
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
                  <label><span>Account name</span><input placeholder="e.g. Sharma Traders" value={bank.account_name} autoFocus onChange={(e) => setBank({ ...bank, account_name: e.target.value })} /></label>
                  <label><span>Account number</span><input placeholder="e.g. 123456789012" inputMode="numeric" value={bank.account_number} onChange={(e) => setBank({ ...bank, account_number: e.target.value.replace(/\s/g, '') })} /></label>
                  <label><span>IFSC</span><input value={bank.ifsc} className={bank.ifsc && !ifscOk ? 'is-bad' : ''} placeholder="HDFC0001234"
                    onChange={(e) => setBank({ ...bank, ifsc: e.target.value.toUpperCase() })} /></label>
                  <label><span>Bank</span><input placeholder="e.g. HDFC Bank" value={bank.bank_name} onChange={(e) => setBank({ ...bank, bank_name: e.target.value })} /></label>
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

type CustomerColumn = Col<CustomerAccount>
const CUSTOMER_COLUMNS: CustomerColumn[] = [
  { key: 'customer', label: 'Customer', locked: true, td: (c) => <><span className="crm-code">{c.customer_code}</span> {c.customer_name}</> },
  { key: 'credit_limit', label: 'Credit limit', thClass: 'crm-num', className: 'crm-num', td: (c) => (c.account ? rupees(c.account.credit_limit) : '—') },
  { key: 'credit_days', label: 'Credit days', td: (c) => (c.account ? `${c.account.credit_days} days` : '—') },
  { key: 'outstanding', label: 'Outstanding', thClass: 'crm-num', className: 'crm-num', td: (c) => rupees(c.outstanding) },
  { key: 'overdue', label: 'Overdue', thClass: 'crm-num', className: 'crm-num',
    style: (c) => (Number(c.overdue) > 0 ? { color: 'var(--status-critical)' } : undefined), td: (c) => rupees(c.overdue) },
  { key: 'hold', label: 'Hold', td: (c) => (c.account?.credit_hold ? <ErpState value="on_hold" /> : '—') },
  { key: 'contact', label: 'Contact', initial: false, td: (c) => c.contact_name || '—' },
  { key: 'mobile', label: 'Mobile', initial: false, td: (c) => c.mobile || '—' },
  { key: 'email', label: 'Email', initial: false, td: (c) => c.email || '—' },
  { key: 'gstin', label: 'GSTIN', initial: false, className: 'itl-mono', td: (c) => c.account?.gstin ?? c.crm_gstin ?? '—' },
  { key: 'billing_state', label: 'Billing state', initial: false, td: (c) => c.account?.billing_state || '—' },
  { key: 'open_orders', label: 'Open orders', initial: false, thClass: 'crm-num', className: 'crm-num', td: (c) => rupees(c.open_order_value) },
  { key: 'oldest_overdue', label: 'Oldest overdue', initial: false, td: (c) => (c.oldest_overdue_days ? `${c.oldest_overdue_days} days` : '—') },
]

function Customers() {
  const columns = useColumns('erp-customers', CUSTOMER_COLUMNS)
  const [q, setQ] = useState('')
  const list = useQuery(`erp-customers-${q}`, () => erp.customers(q.trim() || undefined))
  const [open, setOpen] = useState<CustomerAccount | null>(null)
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <Search value={q} onChange={setQ} placeholder="Search CRM customers" />
        <ColumnSettings defs={CUSTOMER_COLUMNS} order={columns.pref.order} hidden={columns.pref.hidden}
          onSave={columns.save} onReset={columns.reset} />
      </div>
      {list.error && <ErrorNote>{erpError(list.cause, 'Could not load customers')}</ErrorNote>}
      <section className="card">
        {!list.data ? <Loading /> : list.data.length === 0 ? (
          <EmptyState icon={<IconBuilding size={22} />} title="No customers" body="Customers come from the CRM — convert a lead, or add one under CRM → My Customers." />
        ) : (
          <div className="table-wrap"><table>
            <thead><tr>{heads<CustomerAccount>(columns.visible)}</tr></thead>
            <tbody>{list.data.map((c) => (
              <tr key={c.customer_id} onClick={() => setOpen(c)} style={{ cursor: 'pointer' }}>
                {cells<CustomerAccount>(columns.visible, c)}
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      {open && <CustomerDrawer customer={open} onClose={() => setOpen(null)} onChanged={(c) => { setOpen(c); list.reload() }} />}
    </>
  )
}

const ACCOUNT_SECTIONS: FieldSection[] = [
  { id: 'account', label: 'Account' },
  { id: 'terms', label: 'Credit terms' },
  { id: 'billing', label: 'Billing & shipping' },
]
// Nothing is required by the server on a customer's billing account (the legal
// name starts filled from the CRM customer), so nothing is fixed here. Credit days
// always hold a value, so they cannot be made mandatory.
const ACCOUNT_FIELDS: FieldDef[] = [
  { key: 'legal_name', label: 'Legal name', section: 'account' },
  { key: 'gstin', label: 'GSTIN', section: 'account' },
  { key: 'pan', label: 'PAN', section: 'account' },
  { key: 'credit_limit', label: 'Credit limit', section: 'terms' },
  { key: 'credit_days', label: 'Credit days', section: 'terms', optionalOnly: true },
  { key: 'billing_state', label: 'Billing state (place of supply)', section: 'billing' },
  { key: 'billing_address', label: 'Billing address', section: 'billing' },
  { key: 'shipping_address', label: 'Shipping address', section: 'billing' },
]

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
  const fields = useFieldModes('erp-customer-account-form', ACCOUNT_FIELDS)
  const fm = fields.mode
  const rq = (key: string) => fm(key) === 'mandatory'
  const emptyField: Record<string, boolean> = {
    legal_name: !form.legal_name.trim(), gstin: !form.gstin.trim(), pan: !form.pan.trim(),
    credit_limit: !String(form.credit_limit).trim(), billing_state: !form.billing_state.trim(),
    billing_address: !form.billing_address.trim(), shipping_address: !form.shipping_address.trim(),
  }
  const missing = Object.keys(emptyField).some((k) => fm(k) === 'mandatory' && emptyField[k])
  const fieldNodes: Record<string, ReactNode> = {
    legal_name: fm('legal_name') !== 'hide' && <Field label="Legal name" wide required={rq('legal_name')}><input placeholder="e.g. Sharma Traders Pvt Ltd" disabled={!editable} value={form.legal_name} onChange={(e) => setForm({ ...form, legal_name: e.target.value })} /></Field>,
    gstin: fm('gstin') !== 'hide' && <Field label="GSTIN" required={rq('gstin')}><input placeholder="22AAAAA0000A1Z5" disabled={!editable} value={form.gstin} onChange={(e) => setForm({ ...form, gstin: e.target.value })} /></Field>,
    pan: fm('pan') !== 'hide' && <Field label="PAN" required={rq('pan')}><input placeholder="ABCDE1234F" disabled={!editable} value={form.pan} onChange={(e) => setForm({ ...form, pan: e.target.value })} /></Field>,
    credit_limit: fm('credit_limit') !== 'hide' && <Field label="Credit limit (₹, 0 = none)" required={rq('credit_limit')}><input placeholder="e.g. 500000" disabled={!editable} type="number" data-spin min={0} step="any" value={form.credit_limit} onChange={(e) => setForm({ ...form, credit_limit: e.target.value })} /></Field>,
    credit_days: fm('credit_days') !== 'hide' && <Field label="Credit days"><input placeholder="30" disabled={!editable} type="number" data-spin min={0} step={1} value={String(form.credit_days)} onChange={(e) => setForm({ ...form, credit_days: Number(e.target.value) || 0 })} /></Field>,
    billing_state: fm('billing_state') !== 'hide' && <Field label="Billing state (place of supply)" required={rq('billing_state')}><input placeholder="e.g. Maharashtra" disabled={!editable} value={form.billing_state} onChange={(e) => setForm({ ...form, billing_state: e.target.value })} /></Field>,
    billing_address: fm('billing_address') !== 'hide' && <Field label="Billing address" wide required={rq('billing_address')}><textarea placeholder="e.g. 12 MG Road, Pune, Maharashtra 411001" disabled={!editable} rows={2} value={form.billing_address} onChange={(e) => setForm({ ...form, billing_address: e.target.value })} /></Field>,
    shipping_address: fm('shipping_address') !== 'hide' && <Field label="Shipping address" wide required={rq('shipping_address')}><textarea placeholder="e.g. 12 MG Road, Pune, Maharashtra 411001" disabled={!editable} rows={2} value={form.shipping_address} onChange={(e) => setForm({ ...form, shipping_address: e.target.value })} /></Field>,
  }
  const fieldsOf = (section: string) =>
    fields.orderOf(section).map((key) => <Fragment key={key}>{fieldNodes[key]}</Fragment>)
  return (
    <Drawer title={customer.customer_name} meta={customer.customer_code} onClose={onClose} footer={
      <div className="crm-row-actions">
        {error && <span className="error">{error}</span>}
        {missing && <span className="error">Fill in the fields marked <b className="lf-req">*</b></span>}
        {can('can_approve_billing') && (
          <button className="btn" onClick={() => setHolding(true)}>{a?.credit_hold ? 'Release hold' : 'Place on credit hold'}</button>
        )}
        {editable && <button className="btn btn-primary" disabled={busy || missing}
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
        <div className="crm-form-wide lf-settings">
          <FieldSettings defs={ACCOUNT_FIELDS} sections={ACCOUNT_SECTIONS} modes={fields.modes} order={fields.order}
            onSave={fields.save} onReset={fields.reset} />
        </div>
        {fieldsOf('account')}
        {fieldsOf('terms')}
        {fieldsOf('billing')}
      </div>
      <h4 className="crm-panel-title" style={{ marginTop: 16 }}>Sites</h4>
      {(a?.sites ?? []).map((s) => (
        <div key={s.id} className="crm-sub" style={{ padding: '4px 0' }}><span className="crm-strong">{s.name}</span> · {s.address ?? ''} {s.state ? `(${s.state})` : ''} {s.contact_name ? `· ${s.contact_name} ${s.contact_phone ?? ''}` : ''}</div>
      ))}
      {can('can_manage_sales_orders') && (
        <div className="crm-form" style={{ marginTop: 8 }}>
          <Field label="Site name"><input placeholder="e.g. Pune warehouse" value={site.name} onChange={(e) => setSite({ ...site, name: e.target.value })} /></Field>
          <Field label="State"><input placeholder="e.g. Maharashtra" value={site.state} onChange={(e) => setSite({ ...site, state: e.target.value })} /></Field>
          <Field label="Contact"><input placeholder="e.g. Rahul Sharma" value={site.contact_name} onChange={(e) => setSite({ ...site, contact_name: e.target.value })} /></Field>
          <Field label="Phone"><input placeholder="9876543210" value={site.contact_phone} onChange={(e) => setSite({ ...site, contact_phone: e.target.value })} /></Field>
          <Field label="Address" wide><input placeholder="e.g. Plot 5, MIDC Bhosari, Pune 411026" value={site.address} onChange={(e) => setSite({ ...site, address: e.target.value })} /></Field>
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
