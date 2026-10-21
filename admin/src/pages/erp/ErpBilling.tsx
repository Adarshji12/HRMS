/* Billing — invoices, credit notes, receipts and the receivables ageing.
 *
 * Product invoices are raised from a dispatch and milestone invoices from a
 * ready milestone (on the sales order); neither is typed. A draft carries no
 * number until it is posted. Credit notes are approved by somebody other than
 * whoever raised them, like any other money leaving the company. */

import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '../../lib/useQuery'
import { useAuth } from '../../lib/auth'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconCard, IconPlus, IconSearch } from '../../components/Icons'
import { erp, erpError, qtyText, rupees, type Invoice } from './api'
import {
  blankLine, ChainView, DateText, DecideBar, Dialog, Drawer, ErpPage, ErpState, Facts, Field, LineEditor,
  LinesTable, linesPayload, Money, Note, ReasonDialog, Tabs, useAccess, useItems, useRun, type EditLine,
} from './parts'

type Tab = 'invoices' | 'to_bill' | 'credit_notes' | 'receipts' | 'ageing'

export default function ErpBilling() {
  const [tab, setTab] = useState<Tab>('invoices')
  const [params, setParams] = useSearchParams()
  const [openId, setOpenId] = useState<string | null>(params.get('open'))
  useEffect(() => { if (params.get('open')) { setOpenId(params.get('open')); setParams({}, { replace: true }) } }, [params, setParams])
  const [reload, setReload] = useState(0)
  return (
    <ErpPage title="Billing & receivables" subtitle="What has been billed, what is still to bill, and what is owed">
      <Tabs value={tab} onChange={setTab} items={[
        { key: 'invoices', label: 'Invoices' }, { key: 'to_bill', label: 'Dispatched, not billed' },
        { key: 'credit_notes', label: 'Credit notes' }, { key: 'receipts', label: 'Receipts' }, { key: 'ageing', label: 'Ageing' },
      ]} />
      {tab === 'invoices' && <InvoiceList key={reload} kind="invoice" onOpen={setOpenId} />}
      {tab === 'credit_notes' && <InvoiceList key={reload} kind="credit_note" onOpen={setOpenId} />}
      {tab === 'to_bill' && <ToBill onOpen={setOpenId} />}
      {tab === 'receipts' && <Receipts />}
      {tab === 'ageing' && <AgeingTab />}
      {openId && <InvoiceDrawer id={openId} onOpen={setOpenId} onClose={() => setOpenId(null)} onChanged={() => setReload((n) => n + 1)} />}
    </ErpPage>
  )
}

function InvoiceList({ kind, onOpen }: { kind: 'invoice' | 'credit_note'; onOpen: (id: string) => void }) {
  const { can } = useAccess()
  const [q, setQ] = useState('')
  const [outstanding, setOutstanding] = useState(false)
  const list = useQuery(`erp-inv-${kind}-${q}-${outstanding}`, () => erp.invoices({ kind, q: q.trim() || undefined, outstanding_only: outstanding || undefined }))
  const [creating, setCreating] = useState(false)
  return (
    <>
      <div className="crm-bar">
        <div className="crm-search"><IconSearch size={15} /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search number, customer" /></div>
        {kind === 'invoice' && <label className="crm-check"><input type="checkbox" checked={outstanding} onChange={(e) => setOutstanding(e.target.checked)} /> Outstanding only</label>}
        {kind === 'invoice' && can('can_manage_billing') && <button className="btn btn-primary crm-push" onClick={() => setCreating(true)}><IconPlus size={15} /> Service / proforma invoice</button>}
      </div>
      {list.error && <ErrorNote>{erpError(list.cause, 'Could not load invoices')}</ErrorNote>}
      <section className="card">
        {!list.data ? <Loading /> : list.data.length === 0 ? (
          <EmptyState icon={<IconCard size={22} />} title={kind === 'invoice' ? 'No invoices' : 'No credit notes'}
            body={kind === 'invoice' ? 'Raise a product invoice from a dispatch, or a milestone invoice from its sales order.' : 'Raise one from a posted invoice.'} />
        ) : (
          <div className="table-wrap"><table>
            <thead><tr><th>Number</th><th>Kind</th><th>Customer</th><th>Date</th><th>Due</th><th className="crm-num">Total</th><th className="crm-num">Outstanding</th><th>Status</th></tr></thead>
            <tbody>{list.data.map((i) => (
              <tr key={i.id} onClick={() => onOpen(i.id)} style={{ cursor: 'pointer' }}>
                <td className="crm-strong">{i.number ?? 'Draft'}</td><td>{i.kind.replace('_', ' ')}</td><td>{i.customer_name}</td>
                <td><DateText iso={i.invoice_date} /></td>
                <td style={i.days_overdue > 0 ? { color: 'var(--status-critical)' } : undefined}><DateText iso={i.due_date} />{i.days_overdue > 0 ? ` (${i.days_overdue}d)` : ''}</td>
                <td className="crm-num"><Money value={i.grand_total} /></td><td className="crm-num"><Money value={i.outstanding} /></td>
                <td><ErpState value={i.status} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      {creating && <ManualInvoice onClose={() => setCreating(false)} onSaved={(inv) => { setCreating(false); list.reload(); onOpen(inv.id) }} />}
    </>
  )
}

function ToBill({ onOpen }: { onOpen: (id: string) => void }) {
  const { can } = useAccess()
  const list = useQuery('erp-uninvoiced', () => erp.dispatches({ uninvoiced: true }))
  const { busy, error, run } = useRun()
  return (
    <section className="card">
      {error && <ErrorNote>{error}</ErrorNote>}
      {!list.data ? <Loading /> : list.data.length === 0 ? (
        <EmptyState icon={<IconCard size={22} />} title="Nothing left to bill" body="Every dispatch is invoiced." />
      ) : (
        <div className="table-wrap"><table>
          <thead><tr><th>Dispatch</th><th>Order</th><th>Customer</th><th>Date</th><th>Status</th><th className="crm-num">Value</th><th /></tr></thead>
          <tbody>{list.data.map((d) => (
            <tr key={d.id}>
              <td className="crm-strong">{d.number}</td><td>{d.order_number}</td><td>{d.customer_name}</td>
              <td><DateText iso={d.dispatch_date} /></td><td><ErpState value={d.status} /></td><td className="crm-num"><Money value={d.value} /></td>
              <td>{can('can_manage_billing') && <button className="btn btn-sm btn-primary" disabled={busy}
                onClick={() => void run(async () => { const inv = await erp.invoiceFromDispatch(d.id); list.reload(); onOpen(inv.id) })}>Invoice</button>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </section>
  )
}

function ManualInvoice({ onClose, onSaved }: { onClose: () => void; onSaved: (inv: Invoice) => void }) {
  const items = useItems()
  const customers = useQuery('erp-customers-all', () => erp.customers())
  const [kind, setKind] = useState<'service' | 'proforma'>('service')
  const [customerId, setCustomerId] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<EditLine[]>([blankLine()])
  const { busy, error, run } = useRun()
  return (
    <Dialog wide title="New invoice" subtitle="For services and proformas. Goods are invoiced from their dispatch." onClose={onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !customerId} onClick={() => void run(async () => onSaved(await erp.saveInvoice({
          kind, customer_id: customerId, notes, lines: linesPayload(lines).map((l) => ({ ...l, description: l.description ?? '' })),
        })))}>Save draft</button>
      </>
    }>
      <div style={{ padding: '0 20px 12px' }}>
        <div className="crm-form" style={{ marginBottom: 12 }}>
          <Field label="Kind"><select value={kind} onChange={(e) => setKind(e.target.value as 'service' | 'proforma')}><option value="service">Service invoice</option><option value="proforma">Proforma</option></select></Field>
          <Field label="Customer"><select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">Choose</option>{(customers.data ?? []).map((c) => <option key={c.customer_id} value={c.customer_id}>{c.customer_name}</option>)}
          </select></Field>
          <Field label="Notes" wide><input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>
        <LineEditor lines={lines} onChange={setLines} items={items.data ?? []} />
      </div>
    </Dialog>
  )
}

function InvoiceDrawer({ id, onOpen, onClose, onChanged }: { id: string; onOpen: (id: string) => void; onClose: () => void; onChanged: () => void }) {
  const { can } = useAccess()
  const { user } = useAuth()
  const q = useQuery(`erp-invoice-${id}`, () => erp.invoice(id))
  const { busy, error, run } = useRun(() => { q.reload(); onChanged() })
  const [prompt, setPrompt] = useState<null | { title: string; act: (r: string) => Promise<unknown> }>(null)
  const [paying, setPaying] = useState(false)
  const [crediting, setCrediting] = useState(false)
  const inv = q.data
  if (!inv) return <Drawer title="Invoice" onClose={onClose}><Loading /></Drawer>
  const biller = can('can_manage_billing')
  const isTax = ['product', 'service', 'milestone'].includes(inv.kind)

  return (
    <Drawer title={`${inv.number ?? 'Draft'} · ${inv.kind.replace('_', ' ')}`} meta={<>{inv.customer_name} · <ErpState value={inv.status} /></>} onClose={onClose} footer={
      <div className="crm-row-actions" style={{ flexWrap: 'wrap' }}>
        {error && <span className="error">{error}</span>}
        {inv.status === 'draft' && biller && <>
          <button className="btn btn-primary" disabled={busy} onClick={() => void run(() => erp.postInvoice(inv.id))}>Post & number</button>
          <button className="btn btn-danger" disabled={busy} onClick={() => void run(async () => { await erp.deleteInvoice(inv.id); onClose() })}>Delete draft</button>
        </>}
        {inv.status === 'submitted' && inv.kind === 'credit_note' && inv.created_by !== user?.id && (
          <DecideBar onDecide={async (a, n) => { await erp.decideCreditNote(inv.id, a, n); q.reload(); onChanged() }} />
        )}
        {inv.status === 'posted' && isTax && Number(inv.outstanding) > 0 && biller && <>
          <button className="btn btn-primary" onClick={() => setPaying(true)}>Record receipt</button>
          <button className="btn" onClick={() => setCrediting(true)}>Credit note</button>
        </>}
        {inv.status === 'posted' && isTax && can('can_approve_billing') && Number(inv.amount_received) === 0 && Number(inv.amount_credited) === 0 && (
          <button className="btn btn-danger" onClick={() => setPrompt({ title: `Cancel ${inv.number}`, act: (r) => erp.cancelInvoice(inv.id, r) })}>Cancel invoice</button>
        )}
      </div>
    }>
      {inv.cancel_reason && <Note>Cancelled: {inv.cancel_reason}</Note>}
      {inv.review_note && <Note>{inv.review_note}</Note>}
      {inv.original_invoice_id && <Note tone="ok">Credit against <a href="#" onClick={(e) => { e.preventDefault(); onOpen(inv.original_invoice_id!) }}>{inv.original_number}</a>{inv.reason ? ` — ${inv.reason}` : ''}</Note>}
      <Facts items={[
        ['Date', <DateText iso={inv.invoice_date} />], ['Due', <DateText iso={inv.due_date} />], ['GSTIN', inv.gstin],
        ['Place of supply', inv.place_of_supply], ['Order', inv.order_number], ['Drafted by', inv.created_by_name],
        ['Posted by', inv.posted_by_name ?? inv.reviewed_by_name],
        ...(isTax ? [['Received', rupees(inv.amount_received)], ['Credited', rupees(inv.amount_credited)], ['Outstanding', rupees(inv.outstanding)]] as Array<[string, string]> : []),
      ]} />
      <ChainView steps={inv.chain} />
      <LinesTable lines={inv.lines} />
      <div className="crm-totals" style={{ marginBottom: 16 }}>
        <div className="crm-total-row"><span>Taxable</span><span>{rupees(inv.sub_total)}</span></div>
        {inv.is_interstate
          ? <div className="crm-total-row"><span>IGST</span><span>{rupees(inv.igst)}</span></div>
          : <><div className="crm-total-row"><span>CGST</span><span>{rupees(inv.cgst)}</span></div><div className="crm-total-row"><span>SGST</span><span>{rupees(inv.sgst)}</span></div></>}
        <div className="crm-total-row crm-total-grand"><span>Total</span><span>{rupees(inv.grand_total)}</span></div>
      </div>
      {inv.receipts.length > 0 && <>
        <h4 className="crm-panel-title">Receipts</h4>
        {inv.receipts.map((r) => (
          <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '3px 0' }}>
            <span className="crm-strong">{r.number}</span><DateText iso={r.received_on} />
            <span>{rupees(r.amount)}{Number(r.tds_amount) > 0 ? ` + TDS ${rupees(r.tds_amount)}` : ''}</span>
            <span className="crm-sub">{r.mode}{r.reference ? ` · ${r.reference}` : ''}</span>
            <span className="crm-push"><ErpState value={r.status} /></span>
            {r.status === 'posted' && can('can_approve_billing') && <button className="btn btn-sm" onClick={() => setPrompt({ title: `Reverse ${r.number}`, act: (reason) => erp.reverseReceipt(r.id, reason) })}>Reverse</button>}
          </div>
        ))}
      </>}
      {inv.credit_notes.length > 0 && <>
        <h4 className="crm-panel-title" style={{ marginTop: 10 }}>Credit notes</h4>
        {inv.credit_notes.map((c) => <div key={c.id} style={{ padding: '3px 0' }}><a href="#" onClick={(e) => { e.preventDefault(); onOpen(c.id) }}>{c.number ?? 'Awaiting approval'}</a> · {rupees(c.grand_total)} · <ErpState value={c.status} /></div>)}
      </>}
      {paying && <ReceiptForm inv={inv} onClose={() => setPaying(false)} onDone={() => { setPaying(false); q.reload(); onChanged() }} />}
      {crediting && <CreditNoteForm inv={inv} onClose={() => setCrediting(false)} onDone={(cn) => { setCrediting(false); onChanged(); onOpen(cn.id) }} />}
      {prompt && <ReasonDialog title={prompt.title} danger onClose={() => setPrompt(null)} onSubmit={async (r) => { await prompt.act(r); q.reload(); onChanged() }} />}
    </Drawer>
  )
}

function ReceiptForm({ inv, onClose, onDone }: { inv: Invoice; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ amount: inv.outstanding, tds_amount: '0', mode: 'neft', reference: '', received_on: '' })
  const { busy, error, run } = useRun()
  return (
    <Dialog title={`Receipt against ${inv.number}`} subtitle={`Outstanding ${rupees(inv.outstanding)}`} onClose={onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => void run(async () => {
          await erp.recordReceipt({ invoice_id: inv.id, ...form, received_on: form.received_on || null }); onDone()
        })}>Record</button>
      </>
    }>
      <div className="crm-form" style={{ padding: '0 20px 12px' }}>
        <Field label="Amount received"><input inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
        <Field label="TDS deducted"><input inputMode="decimal" value={form.tds_amount} onChange={(e) => setForm({ ...form, tds_amount: e.target.value })} /></Field>
        <Field label="Mode"><select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>{['neft', 'rtgs', 'cheque', 'upi', 'cash', 'other'].map((m) => <option key={m} value={m}>{m.toUpperCase()}</option>)}</select></Field>
        <Field label="Reference / UTR"><input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></Field>
        <Field label="Received on"><input type="date" value={form.received_on} onChange={(e) => setForm({ ...form, received_on: e.target.value })} /></Field>
      </div>
    </Dialog>
  )
}

function CreditNoteForm({ inv, onClose, onDone }: { inv: Invoice; onClose: () => void; onDone: (cn: Invoice) => void }) {
  const items = useItems()
  const [reason, setReason] = useState('')
  const [lines, setLines] = useState<EditLine[]>([{ ...blankLine(), description: 'Credit against ' + (inv.number ?? ''), rate: '0' }])
  const { busy, error, run } = useRun()
  return (
    <Dialog wide title={`Credit note against ${inv.number}`} subtitle={`Up to ${rupees(inv.outstanding)} can be credited. It goes to an approver before it posts.`} onClose={onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !reason.trim()} onClick={() => void run(async () => onDone(await erp.createCreditNote({
          original_invoice_id: inv.id, reason, lines: linesPayload(lines).map((l) => ({ ...l, description: l.description ?? 'Credit' })),
        })))}>Submit for approval</button>
      </>
    }>
      <div style={{ padding: '0 20px 12px' }}>
        <Field label="Reason code"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Rate dispute, short supply, damaged goods…" /></Field>
        <div style={{ marginTop: 12 }}><LineEditor lines={lines} onChange={setLines} items={items.data ?? []} /></div>
      </div>
    </Dialog>
  )
}

function Receipts() {
  const list = useQuery('erp-receipts', () => erp.invoices({ kind: 'invoice' }))
  const rows = (list.data ?? []).flatMap((i) => i.receipts.map((r) => ({ ...r, invoice: i.number, customer: i.customer_name })))
  return (
    <section className="card">
      {!list.data ? <Loading /> : rows.length === 0 ? <EmptyState icon={<IconCard size={22} />} title="No receipts yet" body="Record money received from an invoice." /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Receipt</th><th>Invoice</th><th>Customer</th><th>Date</th><th>Mode</th><th className="crm-num">Amount</th><th className="crm-num">TDS</th><th>Status</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}><td className="crm-strong">{r.number}</td><td>{r.invoice}</td><td>{r.customer}</td><td><DateText iso={r.received_on} /></td>
              <td>{r.mode.toUpperCase()}{r.reference ? <div className="crm-sub">{r.reference}</div> : null}</td>
              <td className="crm-num">{rupees(r.amount)}</td><td className="crm-num">{rupees(r.tds_amount)}</td><td><ErpState value={r.status} /></td></tr>
          ))}</tbody>
        </table></div>
      )}
    </section>
  )
}

function AgeingTab() {
  const q = useQuery('erp-ageing', () => erp.ageing())
  if (!q.data) return <Loading />
  const a = q.data
  return (
    <section className="card">
      {a.rows.length === 0 ? <EmptyState icon={<IconCard size={22} />} title="Nothing outstanding" body="Every posted invoice is settled." /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Customer</th><th className="crm-num">Invoices</th>{a.buckets.map((b) => <th key={b} className="crm-num">{b === 'current' ? 'Not due' : `${b} days`}</th>)}<th className="crm-num">Total</th></tr></thead>
          <tbody>
            {a.rows.map((r) => (
              <tr key={r.customer_id}><td>{r.customer_name}</td><td className="crm-num">{qtyText(r.invoices)}</td>
                {a.buckets.map((b) => <td key={b} className="crm-num" style={b !== 'current' && Number(r[b]) > 0 ? { color: 'var(--status-critical)' } : undefined}>{rupees(r[b] as string)}</td>)}
                <td className="crm-num crm-strong">{rupees(r.total)}</td></tr>
            ))}
            <tr><td className="crm-strong">Total</td><td />{a.buckets.map((b) => <td key={b} className="crm-num crm-strong">{rupees(a.totals[b])}</td>)}<td className="crm-num crm-strong">{rupees(a.total)}</td></tr>
          </tbody>
        </table></div>
      )}
    </section>
  )
}
