/* Purchase requisitions — anybody asks, somebody else approves, procurement orders.
 *
 * An employee sees their own; procurement and approvers see everybody's. An
 * approved requisition turns into an RFQ (several vendors) or straight into a
 * purchase order (one vendor) without retyping a line. */

import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '../../lib/useQuery'
import { useAuth } from '../../lib/auth'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconPlus, IconSheet } from '../../components/Icons'
import { erp, erpError, qtyText, type Requisition } from './api'
import {
  blankLine, ChainView, DateText, DecideBar, Dialog, Drawer, ErpPage, ErpState, Facts, Field, LineEditor,
  LinesTable, linesPayload, Money, Note, ReasonDialog, Tabs, useAccess, useItems, useRun, type EditLine,
} from './parts'

const FILTERS = ['', 'draft', 'submitted', 'approved', 'rejected', 'closed', 'cancelled']

export default function ErpRequisitions() {
  const [status, setStatus] = useState('')
  const list = useQuery(`erp-reqs-${status}`, () => erp.requisitions({ status: status || undefined }))
  const [open, setOpen] = useState<Requisition | null>(null)
  const [editing, setEditing] = useState<Requisition | 'new' | null>(null)
  const [params, setParams] = useSearchParams()
  useEffect(() => {
    const id = params.get('open')
    if (!id) return
    setParams({}, { replace: true })
    void erp.requisition(id).then(setOpen).catch(() => undefined)
  }, [params, setParams])

  return (
    <ErpPage title="Purchase requisitions" subtitle="Ask for what you need — it is approved by somebody else, then ordered"
      actions={<button className="btn btn-primary" onClick={() => setEditing('new')}><IconPlus size={15} /> New requisition</button>}>
      <Tabs value={status} onChange={setStatus} items={FILTERS.map((f) => ({ key: f, label: f ? f[0].toUpperCase() + f.slice(1) : 'All' }))} />
      {list.error && <ErrorNote>{erpError(list.cause, 'Could not load requisitions')}</ErrorNote>}
      <section className="card">
        {!list.data ? <Loading /> : list.data.length === 0 ? (
          <EmptyState icon={<IconSheet size={22} />} title="No requisitions" body="Raise one for anything the company should buy — it routes to an approver automatically." />
        ) : (
          <div className="table-wrap"><table>
            <thead><tr><th>Number</th><th>Title</th><th>Requested by</th><th>Needed by</th><th className="crm-num">Estimate</th><th>Status</th></tr></thead>
            <tbody>{list.data.map((r) => (
              <tr key={r.id} onClick={() => setOpen(r)} style={{ cursor: 'pointer' }}>
                <td className="crm-strong">{r.number}</td><td>{r.title}</td><td>{r.requested_by_name}</td>
                <td><DateText iso={r.required_by} /></td><td className="crm-num"><Money value={r.estimated_total} /></td>
                <td><ErpState value={r.status} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      {editing && <RequisitionForm req={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
        onSaved={(r) => { setEditing(null); list.reload(); setOpen(r) }} />}
      {open && <RequisitionDrawer req={open} onClose={() => setOpen(null)} onEdit={() => { setEditing(open); setOpen(null) }}
        onChanged={(r) => { setOpen(r); list.reload() }} />}
    </ErpPage>
  )
}

function RequisitionForm({ req, onClose, onSaved }: { req: Requisition | null; onClose: () => void; onSaved: (r: Requisition) => void }) {
  const items = useItems()
  const warehouses = useQuery('erp-wh-active', () => erp.warehouses(true))
  const [title, setTitle] = useState(req?.title ?? '')
  const [purpose, setPurpose] = useState(req?.purpose ?? '')
  const [requiredBy, setRequiredBy] = useState(req?.required_by ?? '')
  const [warehouseId, setWarehouseId] = useState(req?.warehouse_id ?? '')
  const [lines, setLines] = useState<EditLine[]>(req ? req.lines.map((l) => ({
    key: l.id, item_id: l.item_id ?? '', description: l.description, quantity: l.quantity, rate: l.estimated_rate, gst_percent: '0',
  })) : [blankLine()])
  const { busy, error, run } = useRun()
  return (
    <Dialog wide title={req ? `Edit ${req.number}` : 'New requisition'} onClose={onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !title.trim()} onClick={() => void run(async () => onSaved(await erp.saveRequisition({
          title, purpose, required_by: requiredBy || null, warehouse_id: warehouseId || null,
          lines: linesPayload(lines, 'estimated_rate'),
        }, req?.id)))}>Save draft</button>
      </>
    }>
      <div style={{ padding: '0 20px 12px' }}>
        <div className="crm-form" style={{ marginBottom: 12 }}>
          <Field label="What is it for" wide><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Switches for the Pune rollout" /></Field>
          <Field label="Needed by"><input type="date" value={requiredBy} onChange={(e) => setRequiredBy(e.target.value)} /></Field>
          <Field label="Deliver to">
            <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <option value="">—</option>
              {(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </Field>
          <Field label="Justification" wide><textarea rows={2} value={purpose} onChange={(e) => setPurpose(e.target.value)} /></Field>
        </div>
        <LineEditor lines={lines} onChange={setLines} items={items.data ?? []} rateFrom="standard_cost" />
        <p className="crm-sub">Rates are estimates — the purchase order carries the vendor's price.</p>
      </div>
    </Dialog>
  )
}

function RequisitionDrawer({ req, onClose, onEdit, onChanged }: {
  req: Requisition; onClose: () => void; onEdit: () => void; onChanged: (r: Requisition) => void
}) {
  const navigate = useNavigate()
  const { can } = useAccess()
  const { busy, error, run } = useRun()
  const [cancelling, setCancelling] = useState(false)
  const [ordering, setOrdering] = useState<null | 'po' | 'rfq'>(null)
  const { user } = useAuth()
  // Shown to anybody but the requester; the server decides whether they are the
  // approver this one is waiting on, and says so if not.
  const mayDecide = req.status === 'submitted' && req.requested_by !== user?.id
  const act = (fn: () => Promise<Requisition>) => void run(async () => onChanged(await fn()))

  return (
    <Drawer title={`${req.number} · ${req.title}`} meta={<ErpState value={req.status} />} onClose={onClose} footer={
      <div className="crm-row-actions">
        {error && <span className="error">{error}</span>}
        {req.status === 'draft' && <>
          <button className="btn" onClick={onEdit}>Edit</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => act(() => erp.requisitionAction(req.id, 'submit'))}>Submit</button>
        </>}
        {req.status === 'rejected' && <button className="btn" onClick={() => act(() => erp.requisitionAction(req.id, 'revise'))}>Revise</button>}
        {mayDecide && <DecideBar onDecide={async (a, n) => onChanged(await erp.decideRequisition(req.id, a, n))} />}
        {req.status === 'approved' && can('can_manage_procurement') && <>
          <button className="btn" onClick={() => setOrdering('rfq')}>Request quotes</button>
          <button className="btn btn-primary" onClick={() => setOrdering('po')}>Raise purchase order</button>
        </>}
        {!['cancelled', 'closed'].includes(req.status) && <button className="btn" onClick={() => setCancelling(true)}>Cancel</button>}
      </div>
    }>
      {req.review_note && <Note>{req.status === 'rejected' ? 'Rejected: ' : 'Note: '}{req.review_note}</Note>}
      <Facts items={[
        ['Requested by', req.requested_by_name], ['Needed by', <DateText iso={req.required_by} />],
        ['Estimate', <Money value={req.estimated_total} />], ['Decided by', req.reviewed_by_name],
      ]} />
      {req.purpose && <p>{req.purpose}</p>}
      <ChainView steps={req.chain} />
      <LinesTable lines={req.lines.map((l) => ({ ...l, rate: l.estimated_rate }))}
        extra={[{ head: 'Ordered', cell: (l: { ordered_qty: string }) => qtyText(l.ordered_qty) }]} />
      {cancelling && <ReasonDialog title={`Cancel ${req.number}`} danger confirm="Cancel requisition" onClose={() => setCancelling(false)}
        onSubmit={async (r) => onChanged(await erp.cancelRequisition(req.id, r))} />}
      {ordering && <OrderFrom req={req} mode={ordering} onClose={() => setOrdering(null)}
        onDone={(path) => navigate(path)} />}
    </Drawer>
  )
}

/** Pick the vendor(s) and turn an approved requisition into an RFQ or a PO. */
function OrderFrom({ req, mode, onClose, onDone }: { req: Requisition; mode: 'po' | 'rfq'; onClose: () => void; onDone: (path: string) => void }) {
  const vendors = useQuery('erp-vendors-active', () => erp.vendors({ status: 'active' }))
  const [picked, setPicked] = useState<string[]>([])
  const [due, setDue] = useState('')
  const { busy, error, run } = useRun()
  const toggle = (id: string) => setPicked(mode === 'po' ? [id] : picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id])
  return (
    <Dialog title={mode === 'po' ? 'Raise a purchase order' : 'Request quotations'}
      subtitle={mode === 'po' ? 'One vendor; the requisition’s estimates become the draft rates.' : 'Pick every vendor who should quote.'}
      onClose={onClose} footer={
        <>
          {error && <span className="error">{error}</span>}
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !picked.length} onClick={() => void run(async () => {
            if (mode === 'po') {
              const po = await erp.requisitionToPo(req.id, picked[0])
              onDone(`/erp/purchase-orders?open=${po.id}`)
            } else {
              const rfq = await erp.createRfq({ title: req.title, requisition_id: req.id, vendor_ids: picked, due_date: due || null })
              onDone(`/erp/rfqs?open=${rfq.id}`)
            }
          })}>{mode === 'po' ? 'Create draft PO' : 'Create RFQ'}</button>
        </>
      }>
      <div style={{ padding: '0 20px 12px', display: 'grid', gap: 6 }}>
        {mode === 'rfq' && <Field label="Quotes due by"><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>}
        {(vendors.data ?? []).length === 0 && <p className="crm-muted">No active vendors — approve one under Masters first.</p>}
        {(vendors.data ?? []).map((v) => (
          <label key={v.id} className="crm-check">
            <input type={mode === 'po' ? 'radio' : 'checkbox'} checked={picked.includes(v.id)} onChange={() => toggle(v.id)} />
            {v.legal_name} <span className="crm-sub">{v.code}{v.performance_score ? ` · score ${v.performance_score}` : ''}</span>
          </label>
        ))}
      </div>
    </Dialog>
  )
}
