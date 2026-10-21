/* Sales orders and dispatch — the customer's PO, booked, released, shipped.
 *
 * The usual way in is "From quotation": an accepted CRM quotation becomes a
 * draft order line for line. When the order's value differs from that
 * quotation (or from the customer's PO value) it is flagged as a deviation and
 * cannot be submitted without saying why. */

import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '../../lib/useQuery'
import { useAuth } from '../../lib/auth'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconPlus, IconSearch, IconSheet } from '../../components/Icons'
import { crm } from '../crm/api'
import { erp, erpError, qtyText, rupees, type SalesOrder } from './api'
import {
  blankLine, ChainView, DateText, DecideBar, Dialog, Drawer, ErpPage, ErpState, Facts, Field, LineEditor,
  LinesTable, linesPayload, Money, Note, ReasonDialog, Tabs, useAccess, useItems, useRun, type EditLine,
} from './parts'

const FILTERS = [
  { key: '', label: 'All' }, { key: 'draft', label: 'Draft' }, { key: 'submitted', label: 'Awaiting release' },
  { key: 'open', label: 'Open' }, { key: 'dispatched', label: 'Dispatched' }, { key: 'closed', label: 'Closed' },
  { key: 'cancelled', label: 'Cancelled' },
]

export default function ErpSalesOrders() {
  const { can } = useAccess()
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const list = useQuery(`erp-sos-${status}-${q}`, () => erp.salesOrders({ status: status || undefined, q: q.trim() || undefined }))
  const [params, setParams] = useSearchParams()
  const [openId, setOpenId] = useState<string | null>(params.get('open'))
  const [editing, setEditing] = useState<SalesOrder | 'new' | null>(null)
  const [converting, setConverting] = useState(false)
  useEffect(() => { if (params.get('open')) { setOpenId(params.get('open')); setParams({}, { replace: true }) } }, [params, setParams])

  return (
    <ErpPage title="Sales orders" subtitle="Booked from the customer's PO, released by somebody else, then reserved, dispatched and billed"
      actions={can('can_manage_sales_orders') && <>
        <button className="btn" onClick={() => setConverting(true)}>From quotation</button>
        <button className="btn btn-primary" onClick={() => setEditing('new')}><IconPlus size={15} /> New order</button>
      </>}>
      <div className="crm-bar">
        <div className="crm-search"><IconSearch size={15} /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search number, customer, PO" /></div>
      </div>
      <Tabs value={status} onChange={setStatus} items={FILTERS} />
      {list.error && <ErrorNote>{erpError(list.cause, 'Could not load sales orders')}</ErrorNote>}
      <section className="card">
        {!list.data ? <Loading /> : list.data.length === 0 ? (
          <EmptyState icon={<IconSheet size={22} />} title="No sales orders" body="Convert an accepted CRM quotation, or book one from the customer's PO." />
        ) : (
          <div className="table-wrap"><table>
            <thead><tr><th>Order</th><th>Customer</th><th>Customer PO</th><th>Date</th><th className="crm-num">Value</th><th className="crm-num">Invoiced</th><th>Status</th></tr></thead>
            <tbody>{list.data.map((so) => (
              <tr key={so.id} onClick={() => setOpenId(so.id)} style={{ cursor: 'pointer' }}>
                <td className="crm-strong">{so.number}{so.has_deviation && <span className="crm-sub" style={{ color: 'var(--status-warn)' }}> · deviation</span>}</td>
                <td>{so.customer_name}</td><td>{so.customer_po_number ?? '—'}</td><td><DateText iso={so.order_date} /></td>
                <td className="crm-num"><Money value={so.grand_total} /></td><td className="crm-num"><Money value={so.invoiced_total} /></td>
                <td><ErpState value={so.status} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      {converting && <FromQuotation onClose={() => setConverting(false)} onDone={(so) => { setConverting(false); list.reload(); setOpenId(so.id) }} />}
      {editing && <OrderForm so={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(so) => { setEditing(null); list.reload(); setOpenId(so.id) }} />}
      {openId && <OrderDrawer id={openId} onClose={() => setOpenId(null)} onEdit={(so) => { setOpenId(null); setEditing(so) }} onChanged={() => list.reload()} />}
    </ErpPage>
  )
}

function FromQuotation({ onClose, onDone }: { onClose: () => void; onDone: (so: SalesOrder) => void }) {
  const quotes = useQuery('crm-accepted-quotes', () => crm.quotations({}))
  const accepted = (quotes.data ?? []).filter((q) => q.status === 'accepted')
  const [picked, setPicked] = useState('')
  const { busy, error, run } = useRun()
  return (
    <Dialog title="Book an order from a quotation" subtitle="Accepted quotations only. Lines, rates and tax come across unchanged." onClose={onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !picked} onClick={() => void run(async () => onDone(await erp.salesOrderFromQuotation(picked)))}>Create draft order</button>
      </>
    }>
      <div style={{ padding: '0 20px 12px', display: 'grid', gap: 6 }}>
        {quotes.data && accepted.length === 0 && <p className="crm-muted">No accepted quotations. Mark one accepted in CRM → Quotations first.</p>}
        {accepted.map((q) => (
          <label key={q.id} className="crm-check">
            <input type="radio" checked={picked === q.id} onChange={() => setPicked(q.id)} />
            <span className="crm-strong">{q.number}</span> {q.customer_name ?? q.company ?? ''} · {rupees(q.grand_total)}
          </label>
        ))}
      </div>
    </Dialog>
  )
}

function OrderForm({ so, onClose, onSaved }: { so: SalesOrder | null; onClose: () => void; onSaved: (so: SalesOrder) => void }) {
  const items = useItems()
  const customers = useQuery('erp-customers-all', () => erp.customers())
  const [head, setHead] = useState({
    customer_id: so?.customer_id ?? '', customer_po_number: so?.customer_po_number ?? '', customer_po_date: so?.customer_po_date ?? '',
    customer_po_value: so?.customer_po_value ?? '', required_by: so?.required_by ?? '', place_of_supply: so?.place_of_supply ?? '',
    shipping_address: so?.shipping_address ?? '', deviation_note: so?.deviation_note ?? '', notes: so?.notes ?? '',
    site_id: so?.site_id ?? '',
  })
  const [lines, setLines] = useState<EditLine[]>(so ? so.lines.map((l) => ({
    key: l.id, item_id: l.item_id ?? '', description: l.description, quantity: l.quantity, rate: l.rate ?? '0', gst_percent: l.gst_percent ?? '18',
  })) : [blankLine()])
  const [milestones, setMilestones] = useState(so?.milestones.map((m) => ({ name: m.name, kind: m.kind, taxable_amount: m.taxable_amount, gst_percent: m.gst_percent, due_date: m.due_date ?? '' })) ?? [])
  const { busy, error, run } = useRun()
  const set = (k: keyof typeof head, v: string) => setHead({ ...head, [k]: v })
  const sites = (customers.data ?? []).find((c) => c.customer_id === head.customer_id)?.account?.sites ?? []
  return (
    <Dialog wide title={so ? `Edit ${so.number}` : 'New sales order'} onClose={onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !head.customer_id} onClick={() => void run(async () => onSaved(await erp.saveSalesOrder({
          ...head, quotation_id: so?.quotation_id ?? null,
          customer_po_date: head.customer_po_date || null, required_by: head.required_by || null,
          customer_po_value: head.customer_po_value || null, site_id: head.site_id || null,
          lines: linesPayload(lines),
          milestones: milestones.map((m) => ({ ...m, due_date: m.due_date || null })),
        }, so?.id)))}>Save draft</button>
      </>
    }>
      <div style={{ padding: '0 20px 12px' }}>
        <div className="crm-form" style={{ marginBottom: 12 }}>
          <Field label="Customer">
            <select value={head.customer_id} onChange={(e) => set('customer_id', e.target.value)} disabled={Boolean(so?.quotation_id)}>
              <option value="">Choose a CRM customer</option>
              {(customers.data ?? []).map((c) => <option key={c.customer_id} value={c.customer_id}>{c.customer_name}{c.account?.credit_hold ? ' (on hold)' : ''}</option>)}
            </select>
          </Field>
          {sites.length > 0 && <Field label="Site"><select value={head.site_id} onChange={(e) => set('site_id', e.target.value)}><option value="">—</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>}
          <Field label="Customer PO number"><input value={head.customer_po_number} onChange={(e) => set('customer_po_number', e.target.value)} /></Field>
          <Field label="PO date"><input type="date" value={head.customer_po_date} onChange={(e) => set('customer_po_date', e.target.value)} /></Field>
          <Field label="PO value (incl. tax)" hint="If it differs from the order, the order is flagged"><input inputMode="decimal" value={head.customer_po_value} onChange={(e) => set('customer_po_value', e.target.value)} /></Field>
          <Field label="Required by"><input type="date" value={head.required_by} onChange={(e) => set('required_by', e.target.value)} /></Field>
          <Field label="Place of supply (state)"><input value={head.place_of_supply} onChange={(e) => set('place_of_supply', e.target.value)} /></Field>
          <Field label="Ship to" wide><textarea rows={2} value={head.shipping_address} onChange={(e) => set('shipping_address', e.target.value)} /></Field>
          <Field label="Deviation note" wide hint="Required when the order differs from its quotation or PO value"><input value={head.deviation_note} onChange={(e) => set('deviation_note', e.target.value)} /></Field>
        </div>
        <LineEditor lines={lines} onChange={setLines} items={items.data ?? []} />
        <h4 className="crm-panel-title" style={{ marginTop: 14 }}>Billing milestones <span className="crm-sub">optional — advance, UAT, installation…</span></h4>
        {milestones.map((m, i) => (
          <div key={i} className="crm-form" style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr auto', alignItems: 'end', marginBottom: 6 }}>
            <Field label="Name"><input value={m.name} onChange={(e) => setMilestones(milestones.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} /></Field>
            <Field label="Kind"><select value={m.kind} onChange={(e) => setMilestones(milestones.map((x, j) => j === i ? { ...x, kind: e.target.value } : x))}>
              {['advance', 'dispatch', 'delivery', 'installation', 'uat', 'monthly', 'custom'].map((k) => <option key={k} value={k}>{k}</option>)}
            </select></Field>
            <Field label="Taxable ₹"><input inputMode="decimal" value={m.taxable_amount} onChange={(e) => setMilestones(milestones.map((x, j) => j === i ? { ...x, taxable_amount: e.target.value } : x))} /></Field>
            <Field label="GST %"><input inputMode="decimal" value={m.gst_percent} onChange={(e) => setMilestones(milestones.map((x, j) => j === i ? { ...x, gst_percent: e.target.value } : x))} /></Field>
            <Field label="Due"><input type="date" value={m.due_date} onChange={(e) => setMilestones(milestones.map((x, j) => j === i ? { ...x, due_date: e.target.value } : x))} /></Field>
            <button className="crm-icon-btn" onClick={() => setMilestones(milestones.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        <button className="btn btn-sm" onClick={() => setMilestones([...milestones, { name: '', kind: 'custom', taxable_amount: '0', gst_percent: '18', due_date: '' }])}><IconPlus size={14} /> Add milestone</button>
      </div>
    </Dialog>
  )
}

function OrderDrawer({ id, onClose, onEdit, onChanged }: { id: string; onClose: () => void; onEdit: (so: SalesOrder) => void; onChanged: () => void }) {
  const navigate = useNavigate()
  const { can } = useAccess()
  const { user } = useAuth()
  const q = useQuery(`erp-so-${id}`, () => erp.salesOrder(id))
  const warehouses = useQuery('erp-wh-active', () => erp.warehouses(true))
  const { busy, error, run } = useRun(() => { q.reload(); onChanged() })
  const [prompt, setPrompt] = useState<null | { title: string; act: (reason: string) => Promise<unknown>; danger?: boolean }>(null)
  const [reserveWh, setReserveWh] = useState('')
  const [dispatching, setDispatching] = useState(false)
  const so = q.data
  if (!so) return <Drawer title="Sales order" onClose={onClose}><Loading /></Drawer>
  const sales = can('can_manage_sales_orders')
  const open = ['approved', 'partially_dispatched'].includes(so.status)

  return (
    <Drawer title={so.number} meta={<>{so.customer_name} · <ErpState value={so.status} /></>} onClose={onClose} footer={
      <div className="crm-row-actions" style={{ flexWrap: 'wrap' }}>
        {error && <span className="error">{error}</span>}
        {so.status === 'draft' && sales && <>
          <button className="btn" onClick={() => onEdit(so)}>Edit</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void run(() => erp.salesOrderAction(so.id, 'submit'))}>Submit for release</button>
        </>}
        {so.status === 'rejected' && sales && <button className="btn" onClick={() => void run(() => erp.salesOrderAction(so.id, 'revise'))}>Revise</button>}
        {so.status === 'submitted' && so.created_by !== user?.id && <DecideBar onDecide={async (a, n) => { await erp.decideSalesOrder(so.id, a, n); q.reload(); onChanged() }} />}
        {open && sales && <button className="btn btn-primary" onClick={() => setDispatching(true)}>Dispatch</button>}
        {open && sales && <button className="btn" disabled={busy} onClick={() => void run(async () => {
          const req = await erp.shortageRequisition(so.id)
          navigate(`/erp/requisitions?open=${req.id}`)
        })}>Raise shortage requisition</button>}
        {(open || so.status === 'on_hold') && can('can_approve_sales_orders') && (
          <button className="btn" onClick={() => setPrompt({ title: so.status === 'on_hold' ? 'Release hold' : 'Put on hold', act: (r) => erp.holdSalesOrder(so.id, so.status !== 'on_hold', r) })}>
            {so.status === 'on_hold' ? 'Release hold' : 'Hold'}</button>
        )}
        {['approved', 'partially_dispatched', 'dispatched', 'on_hold'].includes(so.status) && can('can_approve_sales_orders') && (
          <button className="btn" onClick={() => setPrompt({ title: `Close ${so.number}`, act: (r) => erp.salesOrderReason(so.id, 'close', r) })}>Close</button>
        )}
        {!['cancelled', 'closed', 'dispatched', 'partially_dispatched'].includes(so.status) && sales && (
          <button className="btn btn-danger" onClick={() => setPrompt({ title: `Cancel ${so.number}`, danger: true, act: (r) => erp.salesOrderReason(so.id, 'cancel', r) })}>Cancel</button>
        )}
      </div>
    }>
      {so.has_deviation && <Note>Differs from {so.quotation_number ? `quotation ${so.quotation_number} (${rupees(so.quoted_total)})` : 'the customer PO value'}{so.deviation_note ? ` — ${so.deviation_note}` : ' — a deviation note is needed before submitting'}.</Note>}
      {so.hold_reason && <Note>On hold: {so.hold_reason}</Note>}
      {so.review_note && <Note>{so.review_note}</Note>}
      {so.closed_reason && <Note>{so.closed_reason}</Note>}
      <Facts items={[
        ['Customer PO', so.customer_po_number ? `${so.customer_po_number} · ${so.customer_po_date ?? ''}` : '—'],
        ['Order date', <DateText iso={so.order_date} />], ['Required by', <DateText iso={so.required_by} />],
        ['Place of supply', `${so.place_of_supply ?? '—'}${so.is_interstate ? ' (IGST)' : ''}`],
        ['Value', <Money value={so.grand_total} />], ['Invoiced', <Money value={so.invoiced_total} />],
        ['Booked by', so.created_by_name], ['Released by', so.reviewed_by_name],
      ]} />
      <ChainView steps={so.chain} />
      <LinesTable lines={so.lines} extra={[
        { head: 'Reserved', cell: (l: { reserved_qty: string }) => qtyText(l.reserved_qty) },
        { head: 'Dispatched', cell: (l: { dispatched_qty: string }) => qtyText(l.dispatched_qty) },
        { head: 'In stock', cell: (l: { available_qty: string | null }) => (l.available_qty === null ? '—' : qtyText(l.available_qty)) },
      ]} />
      {open && sales && (
        <div className="crm-bar" style={{ marginBottom: 14 }}>
          <select value={reserveWh} onChange={(e) => setReserveWh(e.target.value)}>
            <option value="">Reserve from…</option>{(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <button className="btn btn-sm" disabled={busy || !reserveWh} onClick={() => void run(() => erp.reserve(so.id, reserveWh))}>Reserve stock</button>
          <button className="btn btn-sm" disabled={busy} onClick={() => void run(() => erp.salesOrderAction(so.id, 'unreserve'))}>Release reservation</button>
        </div>
      )}
      {so.milestones.length > 0 && <>
        <h4 className="crm-panel-title">Billing milestones</h4>
        {so.milestones.map((m) => (
          <div key={m.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '4px 0' }}>
            <span style={{ flex: 1 }}>{m.name} <span className="crm-sub">{m.kind} · {rupees(m.taxable_amount)} + {Number(m.gst_percent)}%{m.evidence ? ` · ${m.evidence}` : ''}</span></span>
            <ErpState value={m.status} />
            {m.status === 'pending' && sales && <button className="btn btn-sm" onClick={() => setPrompt({ title: `Mark “${m.name}” ready`, act: (r) => erp.milestoneReady(m.id, r) })}>Mark ready</button>}
            {m.status === 'ready' && can('can_manage_billing') && <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void run(async () => {
              const inv = await erp.invoiceFromMilestone(m.id)
              navigate(`/erp/billing?open=${inv.id}`)
            })}>Invoice</button>}
          </div>
        ))}
      </>}
      {so.dispatches.length > 0 && <>
        <h4 className="crm-panel-title" style={{ marginTop: 12 }}>Dispatches</h4>
        {so.dispatches.map((d) => <div key={d.id} className="crm-sub" style={{ padding: '3px 0' }}><span className="crm-strong">{d.number}</span> · <DateText iso={d.dispatch_date} /> · {rupees(d.value)} · <ErpState value={d.status} /></div>)}
      </>}
      {so.invoices.length > 0 && <>
        <h4 className="crm-panel-title" style={{ marginTop: 12 }}>Invoices</h4>
        {so.invoices.map((i) => <div key={i.id} className="crm-sub" style={{ padding: '3px 0' }}><span className="crm-strong">{i.number ?? 'Draft'}</span> · {i.kind} · {rupees(i.grand_total)} · <ErpState value={i.status} /></div>)}
      </>}
      {dispatching && <DispatchForm so={so} onClose={() => setDispatching(false)} onDone={() => { setDispatching(false); q.reload(); onChanged() }} />}
      {prompt && <ReasonDialog title={prompt.title} danger={prompt.danger} onClose={() => setPrompt(null)}
        onSubmit={async (r) => { await prompt.act(r); q.reload(); onChanged() }} />}
    </Drawer>
  )
}

function DispatchForm({ so, onClose, onDone }: { so: SalesOrder; onClose: () => void; onDone: () => void }) {
  const warehouses = useQuery('erp-wh-active', () => erp.warehouses(true))
  const goods = so.lines.filter((l) => l.fulfilment !== 'service' && Number(l.pending_qty) > 0)
  const [warehouseId, setWarehouseId] = useState(goods.find((l) => l.reserved_warehouse_id)?.reserved_warehouse_id ?? '')
  const [head, setHead] = useState({ transporter: '', tracking_ref: '', vehicle_no: '', eway_bill_no: '' })
  const [rows, setRows] = useState(goods.map((l) => ({ id: l.id, quantity: l.pending_qty, serials: '' })))
  const { busy, error, run } = useRun()
  const set = (id: string, patch: Partial<(typeof rows)[number]>) => setRows(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  return (
    <Dialog wide title={`Dispatch against ${so.number}`} subtitle="Stock leaves the warehouse now. Serialised items need the exact serials picked." onClose={onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !warehouseId} onClick={() => void run(async () => {
          await erp.createDispatch({
            sales_order_id: so.id, warehouse_id: warehouseId, ...head,
            lines: rows.filter((r) => Number(r.quantity) > 0).map((r) => ({
              order_line_id: r.id, quantity: r.quantity, serials: r.serials.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
            })),
          })
          onDone()
        })}>Post dispatch</button>
      </>
    }>
      <div style={{ padding: '0 20px 12px' }}>
        <div className="crm-form" style={{ marginBottom: 12 }}>
          <Field label="From warehouse"><select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">Choose</option>{(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select></Field>
          <Field label="Transporter / courier"><input value={head.transporter} onChange={(e) => setHead({ ...head, transporter: e.target.value })} /></Field>
          <Field label="AWB / LR"><input value={head.tracking_ref} onChange={(e) => setHead({ ...head, tracking_ref: e.target.value })} /></Field>
          <Field label="Vehicle"><input value={head.vehicle_no} onChange={(e) => setHead({ ...head, vehicle_no: e.target.value })} /></Field>
          <Field label="E-way bill no."><input value={head.eway_bill_no} onChange={(e) => setHead({ ...head, eway_bill_no: e.target.value })} /></Field>
        </div>
        <div className="table-wrap"><table className="crm-lines">
          <thead><tr><th>Line</th><th className="crm-num">Pending</th><th className="crm-num">Ship now</th><th>Serials</th></tr></thead>
          <tbody>{goods.map((l) => {
            const r = rows.find((x) => x.id === l.id)!
            return (
              <tr key={l.id}>
                <td>{l.description}</td><td className="crm-num">{qtyText(l.pending_qty)}</td>
                <td className="crm-line-qty"><input inputMode="decimal" value={r.quantity} onChange={(e) => set(l.id, { quantity: e.target.value })} /></td>
                <td>{l.is_serialized ? <SerialPicker itemId={l.item_id!} warehouseId={warehouseId} value={r.serials} onChange={(v) => set(l.id, { serials: v })} /> : <span className="crm-muted">—</span>}</td>
              </tr>
            )
          })}</tbody>
        </table></div>
      </div>
    </Dialog>
  )
}

function SerialPicker({ itemId, warehouseId, value, onChange }: { itemId: string; warehouseId: string; value: string; onChange: (v: string) => void }) {
  const q = useQuery(`erp-serials-${itemId}-${warehouseId}`, () => erp.availableSerials(itemId, warehouseId), { enabled: Boolean(warehouseId) })
  const chosen = value.split(',').map((s) => s.trim()).filter(Boolean)
  const toggle = (s: string) => onChange((chosen.includes(s) ? chosen.filter((x) => x !== s) : [...chosen, s]).join(', '))
  if (!warehouseId) return <span className="crm-muted">Choose a warehouse</span>
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {(q.data ?? []).length === 0 && <span className="crm-muted">None in stock here</span>}
      {(q.data ?? []).map((s) => (
        <label key={s} className="crm-check" style={{ fontSize: 12 }}><input type="checkbox" checked={chosen.includes(s)} onChange={() => toggle(s)} />{s}</label>
      ))}
    </div>
  )
}
