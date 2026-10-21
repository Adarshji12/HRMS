/* Inventory — what is where, how it got there, and the documents that move it.
 *
 * Stock arrives through GRNs (on the purchase order) and leaves through
 * dispatches (on the sales order). Everything else — an issue to a project, a
 * return, a transfer, a counted adjustment — is a stock document here. Only
 * the adjustment is approved: it changes what the company owns without
 * anything physically moving. */

import { useState } from 'react'
import { useQuery } from '../../lib/useQuery'
import { useAuth } from '../../lib/auth'
import { dateTime } from '../../lib/format'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconCard, IconPlus, IconSearch } from '../../components/Icons'
import { CONDITIONS, erp, erpError, qtyText, rupees, type StockDoc } from './api'
import {
  ChainView, DateText, DecideBar, Dialog, Drawer, ErpPage, ErpState, Facts, Field, Note, ReasonDialog, Tabs,
  useAccess, useItems, useRun,
} from './parts'

type Tab = 'stock' | 'movements' | 'serials' | 'docs'

export default function ErpInventory() {
  const [tab, setTab] = useState<Tab>('stock')
  return (
    <ErpPage title="Inventory" subtitle="Stock by warehouse and condition, at weighted average cost — every figure drills down to the movement behind it">
      <Tabs value={tab} onChange={setTab} items={[
        { key: 'stock', label: 'Stock on hand' }, { key: 'movements', label: 'Ledger' },
        { key: 'serials', label: 'Serial lookup' }, { key: 'docs', label: 'Issues, transfers & adjustments' },
      ]} />
      {tab === 'stock' && <StockTab />}
      {tab === 'movements' && <MovementsTab />}
      {tab === 'serials' && <SerialsTab />}
      {tab === 'docs' && <DocsTab />}
    </ErpPage>
  )
}

function useWarehouses() {
  return useQuery('erp-wh-all', () => erp.warehouses())
}

function StockTab() {
  const warehouses = useWarehouses()
  const [warehouseId, setWarehouseId] = useState('')
  const [condition, setCondition] = useState('')
  const q = useQuery(`erp-stock-${warehouseId}-${condition}`, () => erp.stock({ warehouse_id: warehouseId || undefined, condition: condition || undefined }))
  const total = (q.data ?? []).reduce((s, r) => s + Number(r.value), 0)
  return (
    <>
      <div className="crm-bar">
        <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
          <option value="">All warehouses</option>{(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <select value={condition} onChange={(e) => setCondition(e.target.value)}>
          <option value="">All conditions</option>{CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <span className="crm-push crm-strong">Value {rupees(total)}</span>
      </div>
      {q.error && <ErrorNote>{erpError(q.cause, 'Could not load stock')}</ErrorNote>}
      <section className="card">
        {!q.data ? <Loading /> : q.data.length === 0 ? (
          <EmptyState icon={<IconCard size={22} />} title="Nothing in stock" body="Stock arrives when goods are received against a purchase order." />
        ) : (
          <div className="table-wrap"><table>
            <thead><tr><th>Item</th><th>Warehouse</th><th>Condition</th><th className="crm-num">On hand</th><th className="crm-num">Reserved</th><th className="crm-num">Available</th><th className="crm-num">Avg cost</th><th className="crm-num">Value</th></tr></thead>
            <tbody>{q.data.map((r) => (
              <tr key={r.id}>
                <td><span className="crm-code">{r.item_code}</span> {r.item_name}</td>
                <td>{r.warehouse_name}</td><td><ErpState value={r.condition === 'good' ? 'active' : r.condition} /></td>
                <td className="crm-num">{qtyText(r.quantity)} {r.uom}</td>
                <td className="crm-num">{qtyText(r.reserved_qty)}</td>
                <td className="crm-num" style={Number(r.reorder_level) > 0 && Number(r.available_qty) <= Number(r.reorder_level) ? { color: 'var(--status-warn)' } : undefined}>{qtyText(r.available_qty)}</td>
                <td className="crm-num">{rupees(r.avg_cost)}</td><td className="crm-num">{rupees(r.value)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </>
  )
}

function MovementsTab() {
  const items = useItems('goods')
  const [itemId, setItemId] = useState('')
  const q = useQuery(`erp-moves-${itemId}`, () => erp.movements({ item_id: itemId || undefined }))
  return (
    <>
      <div className="crm-bar">
        <select value={itemId} onChange={(e) => setItemId(e.target.value)}>
          <option value="">All items</option>{(items.data ?? []).map((i) => <option key={i.id} value={i.id}>{i.code} · {i.name}</option>)}
        </select>
      </div>
      <section className="card">
        {!q.data ? <Loading /> : q.data.length === 0 ? <EmptyState icon={<IconCard size={22} />} title="No movements" body="Every receipt, issue, transfer and dispatch writes a line here." /> : (
          <div className="table-wrap"><table>
            <thead><tr><th>When</th><th>Item</th><th>Warehouse</th><th>Kind</th><th>Document</th><th className="crm-num">Qty</th><th className="crm-num">Balance</th><th className="crm-num">Value</th><th>By</th></tr></thead>
            <tbody>{q.data.map((m) => (
              <tr key={m.id}>
                <td className="crm-nowrap">{dateTime(m.created_at)}</td>
                <td><span className="crm-code">{m.item_code}</span></td><td>{m.warehouse_name}{m.condition !== 'good' ? ` (${m.condition})` : ''}</td>
                <td>{m.kind.replace('_', ' ')}</td><td>{m.ref_number}{m.reason ? <div className="crm-sub">{m.reason}</div> : null}</td>
                <td className="crm-num" style={{ color: Number(m.quantity) < 0 ? 'var(--status-critical)' : 'var(--status-good)' }}>{Number(m.quantity) > 0 ? '+' : ''}{qtyText(m.quantity)}</td>
                <td className="crm-num">{qtyText(m.balance_after)}</td><td className="crm-num">{rupees(m.value)}</td><td>{m.created_by_name}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </>
  )
}

function SerialsTab() {
  const [term, setTerm] = useState('')
  const [search, setSearch] = useState('')
  const q = useQuery(`erp-serial-${search}`, () => erp.serials(search), { enabled: search.length >= 2 })
  return (
    <>
      <form className="crm-bar" onSubmit={(e) => { e.preventDefault(); setSearch(term.trim()) }}>
        <div className="crm-search"><IconSearch size={15} /><input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Serial number, MAC or service tag" /></div>
        <button className="btn">Find</button>
      </form>
      {search.length >= 2 && (!q.data ? <Loading /> : q.data.length === 0 ? <p className="crm-muted">No unit with that serial.</p> : q.data.map((s) => (
        <section key={s.id} className="card" style={{ padding: 16, marginBottom: 12 }}>
          <div className="crm-strong">{s.serial_no} · <span className="crm-code">{s.item_code}</span> {s.item_name}</div>
          <Facts items={[['Status', <ErpState value={s.status} />], ['Condition', s.condition], ['Where', s.warehouse_name ?? (s.customer_id ? 'With the customer' : '—')], ['Warranty until', <DateText iso={s.warranty_until} />]]} />
          <ol style={{ margin: 0, paddingLeft: 18 }}>
            {s.history.map((h) => <li key={h.id}>{dateTime(h.created_at)} — {h.kind.replace('_', ' ')} on {h.ref_number}{h.warehouse_name ? ` at ${h.warehouse_name}` : ''}</li>)}
          </ol>
        </section>
      )))}
    </>
  )
}

function DocsTab() {
  const { can } = useAccess()
  const [kind, setKind] = useState('')
  const q = useQuery(`erp-docs-${kind}`, () => erp.stockDocs({ kind: kind || undefined }))
  const [open, setOpen] = useState<StockDoc | null>(null)
  const [creating, setCreating] = useState(false)
  return (
    <>
      <div className="crm-bar">
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All kinds</option>{['issue', 'return', 'transfer', 'adjustment'].map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        {can('can_manage_inventory') && <button className="btn btn-primary crm-push" onClick={() => setCreating(true)}><IconPlus size={15} /> New document</button>}
      </div>
      <section className="card">
        {!q.data ? <Loading /> : q.data.length === 0 ? <EmptyState icon={<IconCard size={22} />} title="No stock documents" body="Issue to a project, return, transfer between warehouses, or adjust after a count." /> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Number</th><th>Kind</th><th>From → to</th><th>Date</th><th>Reason</th><th className="crm-num">Value</th><th>Status</th></tr></thead>
            <tbody>{q.data.map((d) => (
              <tr key={d.id} onClick={() => setOpen(d)} style={{ cursor: 'pointer' }}>
                <td className="crm-strong">{d.number}</td><td>{d.kind}</td>
                <td>{d.from_warehouse_name ?? '—'} → {d.to_warehouse_name ?? '—'}</td><td><DateText iso={d.doc_date} /></td>
                <td>{d.reason ?? '—'}</td><td className="crm-num">{rupees(d.value)}</td><td><ErpState value={d.status} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      {creating && <DocForm onClose={() => setCreating(false)} onSaved={(d) => { setCreating(false); q.reload(); setOpen(d) }} />}
      {open && <DocDrawer doc={open} onClose={() => setOpen(null)} onChanged={(d) => { setOpen(d); q.reload() }} />}
    </>
  )
}

interface DocRow { key: string; item_id: string; quantity: string; condition: string; serials: string }

function DocForm({ onClose, onSaved }: { onClose: () => void; onSaved: (d: StockDoc) => void }) {
  const items = useItems('goods')
  const warehouses = useQuery('erp-wh-active', () => erp.warehouses(true))
  const [head, setHead] = useState({ kind: 'issue', from_warehouse_id: '', to_warehouse_id: '', reason: '', notes: '' })
  const [rows, setRows] = useState<DocRow[]>([{ key: 'a', item_id: '', quantity: '1', condition: 'good', serials: '' }])
  const { busy, error, run } = useRun()
  const needsFrom = head.kind !== 'return'
  const needsTo = head.kind === 'return' || head.kind === 'transfer'
  const set = (key: string, patch: Partial<DocRow>) => setRows(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const whSelect = (field: 'from_warehouse_id' | 'to_warehouse_id') => (
    <select value={head[field]} onChange={(e) => setHead({ ...head, [field]: e.target.value })}>
      <option value="">Choose</option>{(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
    </select>
  )
  return (
    <Dialog wide title="New stock document" onClose={onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => void run(async () => onSaved(await erp.saveStockDoc({
          ...head, from_warehouse_id: head.from_warehouse_id || null, to_warehouse_id: head.to_warehouse_id || null,
          lines: rows.map((r) => ({ item_id: r.item_id, quantity: r.quantity, condition: r.condition,
            serials: r.serials.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean) })),
        })))}>Save draft</button>
      </>
    }>
      <div style={{ padding: '0 20px 12px' }}>
        <div className="crm-form" style={{ marginBottom: 12 }}>
          <Field label="Kind">
            <select value={head.kind} onChange={(e) => setHead({ ...head, kind: e.target.value })}>
              <option value="issue">Issue (out to a project, engineer, department)</option>
              <option value="return">Return (back into a warehouse)</option>
              <option value="transfer">Transfer (between warehouses)</option>
              <option value="adjustment">Adjustment (after a count — needs approval)</option>
            </select>
          </Field>
          {needsFrom && <Field label={head.kind === 'adjustment' ? 'Warehouse' : 'From'}>{whSelect('from_warehouse_id')}</Field>}
          {needsTo && <Field label="To">{whSelect('to_warehouse_id')}</Field>}
          <Field label="Reason code" hint={head.kind === 'adjustment' ? 'Required — e.g. “Cycle count shortfall”' : undefined}>
            <input value={head.reason} onChange={(e) => setHead({ ...head, reason: e.target.value })} />
          </Field>
          <Field label="Notes" wide><input value={head.notes} onChange={(e) => setHead({ ...head, notes: e.target.value })} /></Field>
        </div>
        <div className="table-wrap"><table className="crm-lines">
          <thead><tr><th>Item</th><th className="crm-num">{head.kind === 'adjustment' ? 'Qty (+/−)' : 'Qty'}</th><th>Condition</th><th>Serials</th><th /></tr></thead>
          <tbody>{rows.map((r) => {
            const item = (items.data ?? []).find((i) => i.id === r.item_id)
            return (
              <tr key={r.key}>
                <td><select value={r.item_id} onChange={(e) => set(r.key, { item_id: e.target.value })}>
                  <option value="">Choose</option>{(items.data ?? []).map((i) => <option key={i.id} value={i.id}>{i.code} · {i.name}</option>)}
                </select></td>
                <td className="crm-line-qty"><input inputMode="decimal" value={r.quantity} onChange={(e) => set(r.key, { quantity: e.target.value })} /></td>
                <td><select value={r.condition} onChange={(e) => set(r.key, { condition: e.target.value })}>{CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}</select></td>
                <td>{item?.is_serialized ? <input value={r.serials} placeholder="Comma-separated" onChange={(e) => set(r.key, { serials: e.target.value })} /> : <span className="crm-muted">—</span>}</td>
                <td><button className="crm-icon-btn" disabled={rows.length === 1} onClick={() => setRows(rows.filter((x) => x.key !== r.key))}>×</button></td>
              </tr>
            )
          })}</tbody>
        </table></div>
        <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setRows([...rows, { key: Math.random().toString(36), item_id: '', quantity: '1', condition: 'good', serials: '' }])}><IconPlus size={14} /> Add line</button>
      </div>
    </Dialog>
  )
}

function DocDrawer({ doc, onClose, onChanged }: { doc: StockDoc; onClose: () => void; onChanged: (d: StockDoc) => void }) {
  const { can } = useAccess()
  const { user } = useAuth()
  const { busy, error, run } = useRun()
  const [cancelling, setCancelling] = useState(false)
  const act = (fn: () => Promise<StockDoc>) => void run(async () => onChanged(await fn()))
  const keeper = can('can_manage_inventory')
  return (
    <Drawer title={`${doc.number} · ${doc.kind}`} meta={<ErpState value={doc.status} />} onClose={onClose} footer={
      <div className="crm-row-actions">
        {error && <span className="error">{error}</span>}
        {doc.status === 'draft' && keeper && doc.kind !== 'adjustment' && (
          <button className="btn btn-primary" disabled={busy} onClick={() => act(() => erp.stockDocAction(doc.id, 'post'))}>{doc.kind === 'transfer' ? 'Dispatch transfer' : 'Post'}</button>
        )}
        {doc.status === 'draft' && keeper && doc.kind === 'adjustment' && (
          <button className="btn btn-primary" disabled={busy} onClick={() => act(() => erp.stockDocAction(doc.id, 'submit'))}>Submit for approval</button>
        )}
        {doc.status === 'in_transit' && keeper && <button className="btn btn-primary" disabled={busy} onClick={() => act(() => erp.stockDocAction(doc.id, 'receive'))}>Receive at {doc.to_warehouse_name}</button>}
        {doc.status === 'submitted' && doc.created_by !== user?.id && <DecideBar onDecide={async (a, n) => onChanged(await erp.decideStockDoc(doc.id, a, n))} />}
        {['draft', 'submitted'].includes(doc.status) && keeper && <button className="btn" onClick={() => setCancelling(true)}>Cancel</button>}
      </div>
    }>
      {doc.review_note && <Note>{doc.review_note}</Note>}
      <Facts items={[['From', doc.from_warehouse_name], ['To', doc.to_warehouse_name], ['Date', <DateText iso={doc.doc_date} />],
        ['Reason', doc.reason], ['Value', rupees(doc.value)], ['Raised by', doc.created_by_name], ['Approved by', doc.reviewed_by_name]]} />
      <ChainView steps={doc.chain} />
      <div className="table-wrap"><table>
        <thead><tr><th>Item</th><th className="crm-num">Qty</th><th>Condition</th><th className="crm-num">Unit cost</th><th>Serials</th></tr></thead>
        <tbody>{doc.lines.map((l) => (
          <tr key={l.id}><td><span className="crm-code">{l.item_code}</span> {l.item_name}</td><td className="crm-num">{qtyText(l.quantity)} {l.uom}</td>
            <td>{l.condition}</td><td className="crm-num">{rupees(l.unit_cost)}</td><td className="crm-sub">{l.serials?.join(', ') ?? '—'}</td></tr>
        ))}</tbody>
      </table></div>
      {cancelling && <ReasonDialog title={`Cancel ${doc.number}`} danger onClose={() => setCancelling(false)} onSubmit={async (r) => onChanged(await erp.cancelStockDoc(doc.id, r))} />}
    </Drawer>
  )
}
