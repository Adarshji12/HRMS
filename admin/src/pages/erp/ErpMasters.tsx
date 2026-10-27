/* Masters — items, warehouses, vendors and the customer's financial account.
 *
 * Customers are not created here. They are the CRM's, and this screen only adds
 * what billing needs beside them: credit terms, the hold, delivery sites. */

import { useState } from 'react'
import { Navigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '../../lib/useQuery'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconBuilding, IconPlus, IconSearch } from '../../components/Icons'
import {
  erp, erpError, qtyText, rupees,
  type CustomerAccount, type Item, type Vendor, type Warehouse,
} from './api'
import { DateText, Dialog, Drawer, ErpPage, ErpState, Facts, Field, Note, ReasonDialog, Tabs, useAccess, useRun } from './parts'
import { MasterTrail } from '../masters/MasterBack'

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
  gst_percent: '18', make: '', model: '', part_number: '', is_serialized: false, warranty_months: 0,
  standard_cost: '0', sale_price: '0', reorder_level: '0', min_level: '0', max_level: '0', is_active: true,
}

function Items() {
  const { can } = useAccess()
  const [q, setQ] = useState('')
  const list = useQuery(`erp-items-list-${q}`, () => erp.items({ q: q.trim() || undefined }))
  const [editing, setEditing] = useState<Item | 'new' | null>(null)
  return (
    <>
      <div className="crm-bar">
        <Search value={q} onChange={setQ} placeholder="Search code, name, make, part number" />
        {can('can_manage_erp_masters') && (
          <button className="btn btn-primary crm-push" onClick={() => setEditing('new')}><IconPlus size={15} /> New item</button>
        )}
      </div>
      {list.error && <ErrorNote>{list.error}</ErrorNote>}
      <section className="card">
        {!list.data ? <Loading /> : list.data.length === 0 ? (
          <EmptyState icon={<IconBuilding size={22} />} title="No items yet" body="Add what you buy, stock and sell. Services are items too — they are simply never stocked." />
        ) : (
          <div className="table-wrap"><table>
            <thead><tr><th>Item</th><th>Type</th><th>Make / model</th><th>UOM</th><th className="crm-num">GST</th><th className="crm-num">Cost</th><th className="crm-num">Price</th><th className="crm-num">Available</th><th>Status</th></tr></thead>
            <tbody>
              {list.data.map((i) => (
                <tr key={i.id} onClick={() => can('can_manage_erp_masters') && setEditing(i)} style={{ cursor: 'pointer' }}>
                  <td><span className="crm-code">{i.code}</span> {i.name}{i.is_serialized && <span className="crm-sub"> · serialised</span>}</td>
                  <td>{i.item_type}</td>
                  <td>{[i.make, i.model].filter(Boolean).join(' ') || '—'}</td>
                  <td>{i.uom}</td>
                  <td className="crm-num">{Number(i.gst_percent)}%</td>
                  <td className="crm-num">{rupees(i.standard_cost)}</td>
                  <td className="crm-num">{rupees(i.sale_price)}</td>
                  <td className="crm-num" style={i.below_reorder ? { color: 'var(--status-warn)' } : undefined}>
                    {i.item_type === 'goods' ? qtyText(i.available_qty) : '—'}
                  </td>
                  <td><ErpState value={i.is_active ? 'active' : 'inactive'} /></td>
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

function ItemForm({ item, onClose, onSaved }: { item: Item | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<Record<string, string | number | boolean>>(item ? { ...ITEM_BLANK, ...item } as never : ITEM_BLANK)
  const { busy, error, run } = useRun()
  const set = (k: string, v: string | number | boolean) => setForm({ ...form, [k]: v })
  const text = (k: string, labelText: string, wide = false) => (
    <Field label={labelText} wide={wide}><input value={String(form[k] ?? '')} onChange={(e) => set(k, e.target.value)} /></Field>
  )
  return (
    <Dialog wide title={item ? `Edit ${item.code}` : 'New item'} onClose={onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !form.code || !form.name}
          onClick={() => void run(async () => { await erp.saveItem(form, item?.id); onSaved() })}>Save</button>
      </>
    }>
      <div className="crm-form" style={{ padding: '0 20px 12px' }}>
        {text('code', 'Code / SKU')}
        {text('name', 'Name')}
        <Field label="Type">
          <select value={String(form.item_type)} onChange={(e) => set('item_type', e.target.value)}>
            <option value="goods">Goods (stocked)</option><option value="service">Service</option>
          </select>
        </Field>
        {text('category', 'Category')}
        {text('uom', 'Unit')}
        {text('hsn_sac', 'HSN / SAC')}
        {text('gst_percent', 'GST %')}
        {text('make', 'Make / OEM')}
        {text('model', 'Model')}
        {text('part_number', 'Part number')}
        {text('standard_cost', 'Standard cost')}
        {text('sale_price', 'Sale price')}
        {form.item_type === 'goods' && text('reorder_level', 'Reorder level')}
        {form.item_type === 'goods' && text('max_level', 'Maximum level')}
        {form.item_type === 'goods' && (
          <Field label="Warranty (months)"><input inputMode="numeric" value={String(form.warranty_months)} onChange={(e) => set('warranty_months', Number(e.target.value) || 0)} /></Field>
        )}
        {form.item_type === 'goods' && (
          <label className="crm-check"><input type="checkbox" checked={Boolean(form.is_serialized)} onChange={(e) => set('is_serialized', e.target.checked)} /> Track serial numbers</label>
        )}
        <label className="crm-check"><input type="checkbox" checked={Boolean(form.is_active)} onChange={(e) => set('is_active', e.target.checked)} /> Active</label>
        {text('description', 'Description', true)}
      </div>
    </Dialog>
  )
}

/* ------------------------------------------------------------- warehouses --- */

function Warehouses() {
  const { can } = useAccess()
  const list = useQuery('erp-warehouses', () => erp.warehouses())
  const [editing, setEditing] = useState<Warehouse | 'new' | null>(null)
  return (
    <>
      <div className="crm-bar">
        {can('can_manage_erp_masters') && <button className="btn btn-primary crm-push" onClick={() => setEditing('new')}><IconPlus size={15} /> New warehouse</button>}
      </div>
      <section className="card">
        {!list.data ? <Loading /> : list.data.length === 0 ? (
          <EmptyState icon={<IconBuilding size={22} />} title="No warehouses yet" body="Warehouses, hubs, branches, project sites and engineer kits all hold stock." />
        ) : (
          <div className="table-wrap"><table>
            <thead><tr><th>Code</th><th>Name</th><th>Kind</th><th>State</th><th>Custodian</th><th>Status</th></tr></thead>
            <tbody>{list.data.map((w) => (
              <tr key={w.id} onClick={() => can('can_manage_erp_masters') && setEditing(w)} style={{ cursor: 'pointer' }}>
                <td><span className="crm-code">{w.code}</span></td><td>{w.name}</td><td>{w.kind}</td>
                <td>{w.state ?? '—'}</td><td>{w.custodian_name ?? '—'}</td><td><ErpState value={w.is_active ? 'active' : 'inactive'} /></td>
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
  const [form, setForm] = useState({ code: wh?.code ?? '', name: wh?.name ?? '', kind: wh?.kind ?? 'warehouse', address: wh?.address ?? '', state: wh?.state ?? '', is_active: wh?.is_active ?? true })
  const { busy, error, run } = useRun()
  return (
    <Dialog title={wh ? `Edit ${wh.code}` : 'New warehouse'} onClose={onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !form.code || !form.name}
          onClick={() => void run(async () => { await erp.saveWarehouse(form, wh?.id); onSaved() })}>Save</button>
      </>
    }>
      <div className="crm-form" style={{ padding: '0 20px 12px' }}>
        <Field label="Code"><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></Field>
        <Field label="Name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Kind">
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Warehouse['kind'] })}>
            {['warehouse', 'hub', 'branch', 'site', 'engineer'].map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </Field>
        <Field label="State"><input value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} /></Field>
        <Field label="Address" wide><textarea rows={2} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></Field>
        <label className="crm-check"><input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} /> Active</label>
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

function Vendors() {
  const { can } = useAccess()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const list = useQuery(`erp-vendors-${q}-${status}`, () => erp.vendors({ q: q.trim() || undefined, status: status || undefined }))
  const [open, setOpen] = useState<Vendor | null>(null)
  const [creating, setCreating] = useState(false)
  return (
    <>
      <div className="crm-bar">
        <Search value={q} onChange={setQ} placeholder="Search name, code, GSTIN, PAN" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ marginBottom: 12 }}>
          <option value="">All statuses</option>
          {['draft', 'pending', 'active', 'suspended', 'blacklisted'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        {can('can_manage_erp_masters') && <button className="btn btn-primary crm-push" onClick={() => setCreating(true)}><IconPlus size={15} /> New vendor</button>}
      </div>
      <section className="card">
        {!list.data ? <Loading /> : list.data.length === 0 ? (
          <EmptyState icon={<IconBuilding size={22} />} title="No vendors" body="A vendor is purchasable once somebody other than its creator approves it." />
        ) : (
          <div className="table-wrap"><table>
            <thead><tr><th>Vendor</th><th>Type</th><th>GSTIN / PAN</th><th>Terms</th><th className="crm-num">Score</th><th>Status</th></tr></thead>
            <tbody>{list.data.map((v) => (
              <tr key={v.id} onClick={() => setOpen(v)} style={{ cursor: 'pointer' }}>
                <td><span className="crm-code">{v.code}</span> {v.legal_name}{v.is_msme && <span className="crm-sub"> · MSME</span>}</td>
                <td>{v.vendor_type.replace('_', ' ')}</td>
                <td>{v.gstin ?? v.pan ?? '—'}</td>
                <td>{v.payment_terms_days} days</td>
                <td className="crm-num">{v.performance_score ?? '—'}</td>
                <td><ErpState value={v.status} /></td>
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

function VendorForm({ vendor, onClose, onSaved }: { vendor: Vendor | null; onClose: () => void; onSaved: (v: Vendor) => void }) {
  const [form, setForm] = useState<Record<string, string | number | boolean | null>>(
    vendor ? { ...VENDOR_BLANK, ...vendor } as never : VENDOR_BLANK)
  const { busy, error, run } = useRun()
  const set = (k: string, v: string | number | boolean) => setForm({ ...form, [k]: v })
  const text = (k: string, l: string, wide = false) => (
    <Field label={l} wide={wide}><input value={String(form[k] ?? '')} onChange={(e) => set(k, e.target.value)} /></Field>
  )
  const body = { ...form }
  delete body.banks
  return (
    <Dialog wide title={vendor ? `Edit ${vendor.code}` : 'New vendor'} onClose={onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !form.legal_name}
          onClick={() => void run(async () => onSaved(await erp.saveVendor(body, vendor?.id)))}>Save</button>
      </>
    }>
      <div className="crm-form" style={{ padding: '0 20px 12px' }}>
        {text('legal_name', 'Legal name', true)}
        <Field label="Type">
          <select value={String(form.vendor_type)} onChange={(e) => set('vendor_type', e.target.value)}>
            {['oem', 'distributor', 'service_partner', 'transporter', 'other'].map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
          </select>
        </Field>
        {text('category', 'Category')}
        {text('gstin', 'GSTIN')}
        {text('pan', 'PAN')}
        {text('contact_name', 'Contact')}
        {text('phone', 'Phone')}
        {text('email', 'Email')}
        {text('state', 'State')}
        <Field label="Payment terms (days)"><input inputMode="numeric" value={String(form.payment_terms_days)} onChange={(e) => set('payment_terms_days', Number(e.target.value) || 0)} /></Field>
        <Field label="Agreement / authorisation expiry"><input type="date" value={String(form.agreement_expiry ?? '')} onChange={(e) => set('agreement_expiry', e.target.value)} /></Field>
        <label className="crm-check"><input type="checkbox" checked={Boolean(form.is_msme)} onChange={(e) => set('is_msme', e.target.checked)} /> MSME</label>
        {form.is_msme && text('msme_number', 'Udyam number')}
        <label className="crm-check"><input type="checkbox" checked={Boolean(form.advance_allowed)} onChange={(e) => set('advance_allowed', e.target.checked)} /> Advances allowed</label>
        <Field label="Address" wide><textarea rows={2} value={String(form.address ?? '')} onChange={(e) => set('address', e.target.value)} /></Field>
      </div>
    </Dialog>
  )
}

function VendorDrawer({ vendor, onClose, onChanged }: { vendor: Vendor; onClose: () => void; onChanged: (v: Vendor) => void }) {
  const { can } = useAccess()
  const { busy, error, run } = useRun()
  const [editing, setEditing] = useState(false)
  const [prompt, setPrompt] = useState<null | { title: string; act: (reason: string) => Promise<Vendor> }>(null)
  const [bank, setBank] = useState({ account_name: '', account_number: '', ifsc: '', bank_name: '' })
  const act = (fn: () => Promise<Vendor>) => void run(async () => onChanged(await fn()))

  return (
    <Drawer title={vendor.legal_name} meta={<>{vendor.code} · <ErpState value={vendor.status} /></>} onClose={onClose} footer={
      <div className="crm-row-actions">
        {error && <span className="error">{error}</span>}
        {can('can_manage_erp_masters') && <button className="btn" onClick={() => setEditing(true)}>Edit</button>}
        {vendor.status === 'draft' && can('can_manage_erp_masters') && (
          <button className="btn btn-primary" disabled={busy} onClick={() => act(() => erp.submitVendor(vendor.id))}>Submit for approval</button>
        )}
        {vendor.status === 'pending' && can('can_verify_vendors') && (
          <>
            <button className="btn btn-primary" disabled={busy} onClick={() => act(() => erp.decideVendor(vendor.id, true))}>Approve</button>
            <button className="btn" onClick={() => setPrompt({ title: 'Send back to draft', act: (r) => erp.decideVendor(vendor.id, false, r) })}>Send back</button>
          </>
        )}
        {vendor.status === 'active' && can('can_verify_vendors') && (
          <>
            <button className="btn" onClick={() => setPrompt({ title: 'Suspend vendor', act: (r) => erp.vendorStatus(vendor.id, 'suspended', r) })}>Suspend</button>
            <button className="btn btn-danger" onClick={() => setPrompt({ title: 'Blacklist vendor', act: (r) => erp.vendorStatus(vendor.id, 'blacklisted', r) })}>Blacklist</button>
          </>
        )}
        {(vendor.status === 'suspended' || vendor.status === 'blacklisted') && can('can_verify_vendors') && (
          <button className="btn" onClick={() => setPrompt({ title: 'Reactivate vendor', act: (r) => erp.vendorStatus(vendor.id, 'active', r) })}>Reactivate</button>
        )}
      </div>
    }>
      {vendor.status_reason && <Note>{vendor.status_reason}</Note>}
      {vendor.agreement_expired && <Note>The vendor agreement / OEM authorisation has expired.</Note>}
      <Facts items={[
        ['GSTIN', vendor.gstin], ['PAN', vendor.pan], ['Type', vendor.vendor_type.replace('_', ' ')],
        ['Payment terms', `${vendor.payment_terms_days} days`], ['Contact', vendor.contact_name],
        ['Phone', vendor.phone], ['Email', vendor.email], ['Agreement expiry', <DateText iso={vendor.agreement_expiry} />],
        ['Created by', vendor.created_by_name], ['Approved by', vendor.approved_by_name],
        ['Performance', vendor.performance_score ? `${vendor.performance_score} / 5` : 'No receipts yet'],
      ]} />

      <h4 className="crm-panel-title">Bank accounts</h4>
      <p className="crm-sub">Every change is a new account, verified by somebody other than whoever entered it.</p>
      {vendor.banks.map((b) => (
        <div key={b.id} className="crm-log-row" style={{ padding: '8px 0', display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{ flex: 1 }}>
            <div className="crm-strong">{b.account_name} · {b.account_number}</div>
            <div className="crm-sub">{b.ifsc} {b.bank_name ? `· ${b.bank_name}` : ''} · by {b.created_by_name ?? '—'}{b.verified_by_name ? `, checked by ${b.verified_by_name}` : ''}</div>
          </div>
          <ErpState value={b.status} />
          {b.status === 'pending' && can('can_verify_vendors') && (
            <>
              <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(() => erp.verifyBank(vendor.id, b.id, true))}>Verify</button>
              <button className="btn btn-sm" onClick={() => setPrompt({ title: 'Reject bank account', act: (r) => erp.verifyBank(vendor.id, b.id, false, r) })}>Reject</button>
            </>
          )}
        </div>
      ))}
      {can('can_manage_erp_masters') && (
        <div className="crm-form" style={{ marginTop: 10 }}>
          <Field label="Account name"><input value={bank.account_name} onChange={(e) => setBank({ ...bank, account_name: e.target.value })} /></Field>
          <Field label="Account number"><input value={bank.account_number} onChange={(e) => setBank({ ...bank, account_number: e.target.value })} /></Field>
          <Field label="IFSC"><input value={bank.ifsc} onChange={(e) => setBank({ ...bank, ifsc: e.target.value })} /></Field>
          <Field label="Bank"><input value={bank.bank_name} onChange={(e) => setBank({ ...bank, bank_name: e.target.value })} /></Field>
          <div><button className="btn btn-sm" disabled={busy || !bank.account_number || !bank.ifsc || !bank.account_name}
            onClick={() => act(async () => { const v = await erp.addBank(vendor.id, bank); setBank({ account_name: '', account_number: '', ifsc: '', bank_name: '' }); return v })}>
            Add account</button></div>
        </div>
      )}
      {editing && <VendorForm vendor={vendor} onClose={() => setEditing(false)} onSaved={(v) => { setEditing(false); onChanged(v) }} />}
      {prompt && <ReasonDialog title={prompt.title} onClose={() => setPrompt(null)} onSubmit={async (r) => onChanged(await prompt.act(r))} />}
    </Drawer>
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
