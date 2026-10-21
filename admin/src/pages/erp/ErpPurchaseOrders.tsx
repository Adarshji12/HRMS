/* Purchase orders and goods receipts.
 *
 * A draft is edited freely; a submitted order waits on somebody other than its
 * buyer; an approved one is frozen — a change is an amendment, which bumps the
 * revision and goes back for approval. Goods are received from the order
 * itself, so a GRN can only ever be against what was ordered. */

import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '../../lib/useQuery'
import { useAuth } from '../../lib/auth'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconCard, IconPlus, IconSearch } from '../../components/Icons'
import { CONDITIONS, erp, erpError, qtyText, rupees, type PurchaseOrder } from './api'
import {
  blankLine, ChainView, DateText, DecideBar, Dialog, Drawer, ErpPage, ErpState, Facts, Field, LineEditor,
  LinesTable, linesPayload, Money, Note, ReasonDialog, Tabs, useAccess, useItems, useRun, type EditLine,
} from './parts'

const FILTERS = [
  { key: '', label: 'All' }, { key: 'draft', label: 'Draft' }, { key: 'submitted', label: 'Awaiting approval' },
  { key: 'open', label: 'Open' }, { key: 'received', label: 'Received' }, { key: 'closed', label: 'Closed' },
  { key: 'cancelled', label: 'Cancelled' },
]

export default function ErpPurchaseOrders() {
  const { can } = useAccess()
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const list = useQuery(`erp-pos-${status}-${q}`, () => erp.purchaseOrders({ status: status || undefined, q: q.trim() || undefined }))
  const [params, setParams] = useSearchParams()
  const [openId, setOpenId] = useState<string | null>(params.get('open'))
  const [editing, setEditing] = useState<PurchaseOrder | 'new' | null>(null)
  useEffect(() => { if (params.get('open')) { setOpenId(params.get('open')); setParams({}, { replace: true }) } }, [params, setParams])

  return (
    <ErpPage title="Purchase orders" subtitle="Raised by procurement, approved by somebody else, received into a warehouse"
      actions={can('can_manage_procurement') && <button className="btn btn-primary" onClick={() => setEditing('new')}><IconPlus size={15} /> New PO</button>}>
      <div className="crm-bar">
        <div className="crm-search"><IconSearch size={15} /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search number, vendor" /></div>
      </div>
      <Tabs value={status} onChange={setStatus} items={FILTERS} />
      {list.error && <ErrorNote>{erpError(list.cause, 'Could not load purchase orders')}</ErrorNote>}
      <section className="card">
        {!list.data ? <Loading /> : list.data.length === 0 ? (
          <EmptyState icon={<IconCard size={22} />} title="No purchase orders" body="Raise one from an approved requisition, an awarded RFQ, or from scratch." />
        ) : (
          <div className="table-wrap"><table>
            <thead><tr><th>PO</th><th>Vendor</th><th>Date</th><th>Expected</th><th className="crm-num">Value</th><th>Status</th></tr></thead>
            <tbody>{list.data.map((po) => (
              <tr key={po.id} onClick={() => setOpenId(po.id)} style={{ cursor: 'pointer' }}>
                <td className="crm-strong">{po.number}{po.revision > 0 && <span className="crm-sub"> rev {po.revision}</span>}</td>
                <td>{po.vendor_name}</td><td><DateText iso={po.order_date} /></td>
                <td style={po.is_overdue ? { color: 'var(--status-critical)' } : undefined}><DateText iso={po.committed_date ?? po.expected_date} /></td>
                <td className="crm-num"><Money value={po.grand_total} /></td><td><ErpState value={po.status} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      {editing && <PoForm po={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
        onSaved={(po) => { setEditing(null); list.reload(); setOpenId(po.id) }} />}
      {openId && <PoDrawer id={openId} onClose={() => setOpenId(null)} onEdit={(po) => { setOpenId(null); setEditing(po) }} onChanged={() => list.reload()} />}
    </ErpPage>
  )
}

function PoForm({ po, onClose, onSaved }: { po: PurchaseOrder | null; onClose: () => void; onSaved: (po: PurchaseOrder) => void }) {
  const items = useItems()
  const vendors = useQuery('erp-vendors-active', () => erp.vendors({ status: 'active' }))
  const warehouses = useQuery('erp-wh-active', () => erp.warehouses(true))
  const [head, setHead] = useState({
    vendor_id: po?.vendor_id ?? '', warehouse_id: po?.warehouse_id ?? '', expected_date: po?.expected_date ?? '',
    payment_terms: po?.payment_terms ?? '', delivery_terms: po?.delivery_terms ?? '', freight: po?.freight ?? '0',
    ld_percent_per_week: po?.ld_percent_per_week ?? '0', ld_cap_percent: po?.ld_cap_percent ?? '0', notes: po?.notes ?? '',
  })
  const [lines, setLines] = useState<EditLine[]>(po ? po.lines.map((l) => ({
    key: l.id, item_id: l.item_id ?? '', description: l.description, quantity: l.quantity, rate: l.rate ?? '0', gst_percent: l.gst_percent ?? '18',
  })) : [blankLine()])
  const { busy, error, run } = useRun()
  const set = (k: keyof typeof head, v: string) => setHead({ ...head, [k]: v })
  return (
    <Dialog wide title={po ? `Edit ${po.number}` : 'New purchase order'} onClose={onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !head.vendor_id} onClick={() => void run(async () => onSaved(await erp.savePurchaseOrder({
          ...head, warehouse_id: head.warehouse_id || null, expected_date: head.expected_date || null,
          requisition_id: po?.requisition_id ?? null, sales_order_id: po?.sales_order_id ?? null,
          lines: lines.map((l, i) => ({ ...linesPayload([l])[0], requisition_line_id: (po?.lines[i] as { requisition_line_id?: string } | undefined)?.requisition_line_id ?? null })),
        }, po?.id)))}>Save draft</button>
      </>
    }>
      <div style={{ padding: '0 20px 12px' }}>
        <div className="crm-form" style={{ marginBottom: 12 }}>
          <Field label="Vendor">
            <select value={head.vendor_id} onChange={(e) => set('vendor_id', e.target.value)}>
              <option value="">Choose an active vendor</option>
              {(vendors.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.legal_name}</option>)}
            </select>
          </Field>
          <Field label="Deliver to">
            <select value={head.warehouse_id} onChange={(e) => set('warehouse_id', e.target.value)}>
              <option value="">—</option>{(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </Field>
          <Field label="Expected delivery"><input type="date" value={head.expected_date} onChange={(e) => set('expected_date', e.target.value)} /></Field>
          <Field label="Payment terms"><input value={head.payment_terms} onChange={(e) => set('payment_terms', e.target.value)} placeholder="From the vendor master if blank" /></Field>
          <Field label="Delivery terms"><input value={head.delivery_terms} onChange={(e) => set('delivery_terms', e.target.value)} /></Field>
          <Field label="Freight"><input inputMode="decimal" value={head.freight} onChange={(e) => set('freight', e.target.value)} /></Field>
          <Field label="LD % per week late" hint="Liquidated damages, on the value received late"><input inputMode="decimal" value={head.ld_percent_per_week} onChange={(e) => set('ld_percent_per_week', e.target.value)} /></Field>
          <Field label="LD cap %"><input inputMode="decimal" value={head.ld_cap_percent} onChange={(e) => set('ld_cap_percent', e.target.value)} /></Field>
        </div>
        <LineEditor lines={lines} onChange={setLines} items={items.data ?? []} rateFrom="standard_cost" />
      </div>
    </Dialog>
  )
}

function PoDrawer({ id, onClose, onEdit, onChanged }: { id: string; onClose: () => void; onEdit: (po: PurchaseOrder) => void; onChanged: () => void }) {
  const { can } = useAccess()
  const { user } = useAuth()
  const q = useQuery(`erp-po-${id}`, () => erp.purchaseOrder(id))
  const { busy, error, run } = useRun(() => { q.reload(); onChanged() })
  const [prompt, setPrompt] = useState<null | { title: string; action: 'amend' | 'cancel' | 'short-close' | 'waive-ld' }>(null)
  const [receiving, setReceiving] = useState(false)
  const [committed, setCommitted] = useState('')
  const po = q.data
  if (!po) return <Drawer title="Purchase order" onClose={onClose}><Loading /></Drawer>
  const buyer = can('can_manage_procurement')
  const receivable = ['approved', 'acknowledged', 'partially_received'].includes(po.status)

  return (
    <Drawer title={`${po.number}${po.revision ? ` rev ${po.revision}` : ''}`} meta={<>{po.vendor_name} · <ErpState value={po.status} /></>} onClose={onClose} footer={
      <div className="crm-row-actions" style={{ flexWrap: 'wrap' }}>
        {error && <span className="error">{error}</span>}
        {po.status === 'draft' && buyer && <>
          <button className="btn" onClick={() => onEdit(po)}>Edit</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void run(() => erp.submitPurchaseOrder(po.id))}>Submit for approval</button>
        </>}
        {po.status === 'submitted' && po.created_by !== user?.id && (
          <DecideBar onDecide={async (a, n) => { await erp.decidePurchaseOrder(po.id, a, n); q.reload(); onChanged() }} />
        )}
        {po.status === 'approved' && buyer && <>
          <input type="date" value={committed} onChange={(e) => setCommitted(e.target.value)} title="Vendor's committed date" />
          <button className="btn" disabled={busy} onClick={() => void run(() => erp.acknowledgePurchaseOrder(po.id, committed || undefined))}>Vendor acknowledged</button>
        </>}
        {receivable && can('can_manage_inventory') && <button className="btn btn-primary" onClick={() => setReceiving(true)}>Receive goods</button>}
        {['approved', 'acknowledged', 'rejected'].includes(po.status) && buyer && <button className="btn" onClick={() => setPrompt({ title: 'Amend order', action: 'amend' })}>Amend</button>}
        {po.status === 'partially_received' && buyer && <button className="btn" onClick={() => setPrompt({ title: 'Short-close order', action: 'short-close' })}>Short-close</button>}
        {Number(po.ld_amount) > 0 && !po.ld_waived && can('can_approve_purchases') && po.created_by !== user?.id && (
          <button className="btn" onClick={() => setPrompt({ title: 'Waive liquidated damages', action: 'waive-ld' })}>Waive LD</button>
        )}
        {['draft', 'submitted', 'approved', 'acknowledged', 'rejected'].includes(po.status) && buyer && (
          <button className="btn btn-danger" onClick={() => setPrompt({ title: `Cancel ${po.number}`, action: 'cancel' })}>Cancel</button>
        )}
      </div>
    }>
      {po.review_note && <Note>{po.status === 'rejected' ? 'Rejected: ' : ''}{po.review_note}</Note>}
      {po.closed_reason && <Note>{po.closed_reason}</Note>}
      {po.is_overdue && <Note>Delivery is overdue.</Note>}
      <Facts items={[
        ['Order date', <DateText iso={po.order_date} />], ['Expected', <DateText iso={po.expected_date} />],
        ['Vendor committed', <DateText iso={po.committed_date} />], ['Deliver to', po.warehouse_name],
        ['Payment terms', po.payment_terms], ['Raised by', po.created_by_name], ['Approved by', po.reviewed_by_name],
        ['LD accrued', po.ld_waived ? `${rupees(po.ld_amount)} (waived)` : rupees(po.ld_amount)],
      ]} />
      <ChainView steps={po.chain} />
      <LinesTable lines={po.lines} extra={[{ head: 'Received', cell: (l: { received_qty: string }) => qtyText(l.received_qty) }]} />
      <div className="crm-totals" style={{ marginBottom: 16 }}>
        <div className="crm-total-row"><span>Taxable</span><span>{rupees(po.sub_total)}</span></div>
        <div className="crm-total-row"><span>GST</span><span>{rupees(po.tax_total)}</span></div>
        <div className="crm-total-row"><span>Freight</span><span>{rupees(po.freight)}</span></div>
        <div className="crm-total-row crm-total-grand"><span>Total</span><span>{rupees(po.grand_total)}</span></div>
      </div>
      {po.receipts.length > 0 && (
        <>
          <h4 className="crm-panel-title">Goods receipts</h4>
          {po.receipts.map((g) => (
            <GrnRow key={g.id} grn={g} canReverse={can('can_manage_inventory')} onReversed={() => { q.reload(); onChanged() }} />
          ))}
        </>
      )}
      {receiving && <ReceiveForm po={po} onClose={() => setReceiving(false)} onDone={() => { setReceiving(false); q.reload(); onChanged() }} />}
      {prompt && <ReasonDialog title={prompt.title} danger={prompt.action === 'cancel'} onClose={() => setPrompt(null)}
        onSubmit={async (reason) => { await erp.purchaseOrderReason(po.id, prompt.action, reason); q.reload(); onChanged() }} />}
    </Drawer>
  )
}

function GrnRow({ grn, canReverse, onReversed }: { grn: PurchaseOrder['receipts'][number]; canReverse: boolean; onReversed: () => void }) {
  const [reversing, setReversing] = useState(false)
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '4px 0' }}>
      <span className="crm-strong">{grn.number}</span>
      <DateText iso={grn.received_on} />
      {grn.days_late > 0 && <span className="crm-sub">{grn.days_late} days late · LD {rupees(grn.ld_amount)}</span>}
      <span className="crm-push"><ErpState value={grn.status} /></span>
      {canReverse && grn.status === 'posted' && <button className="btn btn-sm" onClick={() => setReversing(true)}>Reverse</button>}
      {reversing && <ReasonDialog title={`Reverse ${grn.number}`} danger hint="The stock leaves the warehouse again. Refused if it has already moved on."
        onClose={() => setReversing(false)} onSubmit={async (r) => { await erp.reverseGoodsReceipt(grn.id, r); onReversed() }} />}
    </div>
  )
}

function ReceiveForm({ po, onClose, onDone }: { po: PurchaseOrder; onClose: () => void; onDone: () => void }) {
  const warehouses = useQuery('erp-wh-active', () => erp.warehouses(true))
  const [warehouseId, setWarehouseId] = useState(po.warehouse_id ?? '')
  const [challan, setChallan] = useState('')
  const [invoiceRef, setInvoiceRef] = useState('')
  const pending = po.lines.filter((l) => Number(l.pending_qty) > 0)
  const [rows, setRows] = useState(pending.map((l) => ({ id: l.id, received: l.pending_qty, rejected: '0', condition: 'good', serials: '' })))
  const { busy, error, run } = useRun()
  const set = (id: string, patch: Partial<(typeof rows)[number]>) => setRows(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  return (
    <Dialog wide title={`Receive against ${po.number}`} subtitle="Rejected units are recorded, not stocked. Serialised items need one serial per accepted unit." onClose={onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !warehouseId} onClick={() => void run(async () => {
          await erp.postGoodsReceipt({
            purchase_order_id: po.id, warehouse_id: warehouseId, challan_ref: challan, invoice_ref: invoiceRef,
            lines: rows.filter((r) => Number(r.received) > 0).map((r) => ({
              po_line_id: r.id, received_qty: r.received, rejected_qty: r.rejected || '0', condition: r.condition,
              serials: r.serials.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
            })),
          })
          onDone()
        })}>Post GRN</button>
      </>
    }>
      <div style={{ padding: '0 20px 12px' }}>
        <div className="crm-form" style={{ marginBottom: 12 }}>
          <Field label="Into warehouse">
            <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <option value="">Choose</option>{(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </Field>
          <Field label="Delivery challan"><input value={challan} onChange={(e) => setChallan(e.target.value)} /></Field>
          <Field label="Vendor invoice"><input value={invoiceRef} onChange={(e) => setInvoiceRef(e.target.value)} /></Field>
        </div>
        <div className="table-wrap"><table className="crm-lines">
          <thead><tr><th>Line</th><th className="crm-num">Due</th><th className="crm-num">Received</th><th className="crm-num">Rejected</th><th>Condition</th><th>Serials</th></tr></thead>
          <tbody>{pending.map((l) => {
            const r = rows.find((x) => x.id === l.id)!
            return (
              <tr key={l.id}>
                <td>{l.description}</td><td className="crm-num">{qtyText(l.pending_qty)}</td>
                <td className="crm-line-qty"><input inputMode="decimal" value={r.received} onChange={(e) => set(l.id, { received: e.target.value })} /></td>
                <td className="crm-line-qty"><input inputMode="decimal" value={r.rejected} onChange={(e) => set(l.id, { rejected: e.target.value })} /></td>
                <td><select value={r.condition} onChange={(e) => set(l.id, { condition: e.target.value })}>{CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}</select></td>
                <td>{l.is_serialized ? <textarea rows={2} value={r.serials} placeholder="One per line or comma-separated" onChange={(e) => set(l.id, { serials: e.target.value })} /> : <span className="crm-muted">—</span>}</td>
              </tr>
            )
          })}</tbody>
        </table></div>
      </div>
    </Dialog>
  )
}
