/* Billing — invoices, credit notes, receipts and the receivables ageing.
 *
 * Product invoices are raised from a dispatch and milestone invoices from a
 * ready milestone (on the sales order); neither is typed. A draft carries no
 * number until it is posted. Credit notes are approved by somebody other than
 * whoever raised them, like any other money leaving the company. */

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '../../lib/useQuery'
import { canAdminister, useAuth } from '../../lib/auth'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconCard, IconCheck, IconClose, IconDownload, IconEdit, IconFolder, IconPlus, IconPrinter, IconSearch, IconSheet, IconSliders, IconTrash, IconUser } from '../../components/Icons'
import { erp, erpError, qtyText, rupees, type CustomerAccount, type Invoice, type InvoiceReceipt, type Item } from './api'
import { todayISO } from '../crm/api'
import { downloadCsv, downloadXlsx } from '../../lib/sheet'
import { CrmPage, OwnerSelect } from '../crm/parts'
import '../../styles/invoice.css'
import '../../styles/salebill.css'
import InvoicePrint, { downloadInvoicePdf } from './InvoicePrint'
import {
  ChainView, DateText, DecideBar, Dialog, ErpPage, ErpState,
  Money, Note, ReasonDialog, Tabs, useAccess, useItems, useRun,
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

/** Invoices on their own — the menu entry under Sales Orders. The same list
 *  and drawer as Billing's first tab, without the receivables around it. */
export function ErpInvoices() {
  const [params, setParams] = useSearchParams()
  const [openId, setOpenId] = useState<string | null>(params.get('open'))
  useEffect(() => { if (params.get('open')) { setOpenId(params.get('open')); setParams({}, { replace: true }) } }, [params, setParams])
  const [reload, setReload] = useState(0)
  const { can, loaded } = useAccess()
  const biller = can('can_manage_billing')
  // Opening Invoices starts a new invoice; the list is the second tab. Somebody
  // who cannot bill only ever sees the list.
  const [view, setView] = useState<'new' | 'list' | null>(null)
  const shown = view ?? (loaded && !biller ? 'list' : 'new')
  // No heading and no tabs: the top bar already says ERP › Invoices. The
  // form's action bar links to the list, and the list back to a new invoice.
  return (
    <CrmPage>
      {!loaded ? <Loading /> : shown === 'new' && biller ? (
        <ManualInvoice key={reload} inline onClose={() => setView('list')} onShowAll={() => setView('list')}
          onSaved={(inv) => { setReload((n) => n + 1); setView('list'); setOpenId(inv.id) }} />
      ) : (
        <InvoiceList key={reload} kind="invoice" onOpen={setOpenId} onNew={biller ? () => setView('new') : undefined} />
      )}
      {openId && <InvoiceDrawer id={openId} onOpen={setOpenId} onClose={() => setOpenId(null)} onChanged={() => setReload((n) => n + 1)} />}
    </CrmPage>
  )
}

type PayState = 'draft' | 'pending' | 'unpaid' | 'partial' | 'overdue' | 'paid' | 'issued' | 'cancelled' | 'rejected'

/** Where an invoice stands, in the words a biller uses. */
function payState(i: Invoice): PayState {
  if (i.status === 'draft') return 'draft'
  if (i.status === 'cancelled') return 'cancelled'
  if (i.status === 'rejected') return 'rejected'
  if (i.status === 'submitted') return 'pending'
  if (i.kind === 'proforma') return 'issued'
  if (i.kind === 'credit_note') return 'paid'
  if (Number(i.outstanding) <= 0) return 'paid'
  if (i.days_overdue > 0) return 'overdue'
  return Number(i.amount_received) + Number(i.amount_credited) > 0 ? 'partial' : 'unpaid'
}
const PAY_LABEL: Record<PayState, string> = {
  draft: 'Draft', pending: 'Awaiting approval', unpaid: 'Unpaid', partial: 'Partly paid',
  overdue: 'Overdue', paid: 'Paid', issued: 'Issued', cancelled: 'Cancelled', rejected: 'Rejected',
}
const editableKinds = ['service', 'proforma']

/** Why this invoice cannot be deleted right now — or null when it can. The
 *  same rules as the server's: a draft by anyone who bills; an issued one by
 *  an administrator, while no live payment or issued credit note is against
 *  it (a reversed payment does not count). */
function deleteBlock(i: Invoice, biller: boolean, admin: boolean): string | null {
  if (!biller) return 'You do not have billing permission'
  if (i.status === 'draft' || i.status === 'rejected') return null
  if (i.kind === 'credit_note') return 'A credit note is not deleted'
  if (!admin) return 'Only an administrator can delete an issued invoice — cancel it instead'
  if (i.receipts.some((r) => r.status === 'posted')) return 'A payment is recorded — reverse the payment first, then cancel the invoice'
  if (i.receipts.length) return 'Its payment history is kept for audit — cancel the invoice instead'
  if (i.credit_notes.some((c) => c.status !== 'draft' && c.status !== 'rejected')) return 'A credit note is issued against it — it cannot be deleted'
  return null
}

/** Is this the latest number issued in its series and year? Then deleting it
 *  hands the number back; otherwise the series keeps a gap. */
function isLatestNumber(inv: Invoice, all: Invoice[]): boolean {
  const key = (n: string) => n.replace(/\//g, '-').replace(/-\d+$/, '')
  const seq = (n: string) => Number(n.replace(/\//g, '-').split('-').pop())
  if (!inv.number) return false
  return !all.some((o) => o.id !== inv.id && o.number && key(o.number) === key(inv.number!) && seq(o.number) > seq(inv.number!))
}

function confirmDeleteIssued(inv: Invoice, latest: boolean): boolean {
  return window.confirm(
    `Delete ${inv.number} permanently?\n\n`
    + (latest
      ? 'It is the latest number in its series, so the next invoice will reuse it — no gap.'
      : 'It is not the latest number, so the series will have a gap where it was. GST returns list such gaps as cancelled/deleted documents.')
    + '\n\nThis cannot be undone. It is recorded in the audit log.',
  )
}

const DOC_STATUSES: [Invoice['status'], string][] = [
  ['draft', 'Draft'], ['submitted', 'Awaiting approval'], ['posted', 'Posted'], ['rejected', 'Rejected'], ['cancelled', 'Cancelled'],
]

type DateRange = '' | 'today' | 'this_month' | 'last_month' | 'this_quarter' | 'this_fy' | 'last_fy' | 'custom'
const DATE_RANGES: [Exclude<DateRange, ''>, string][] = [
  ['today', 'Today'], ['this_month', 'This month'], ['last_month', 'Last month'], ['this_quarter', 'This quarter'],
  ['this_fy', 'This financial year'], ['last_fy', 'Last financial year'], ['custom', 'Custom range'],
]

/** From and to dates (inclusive, yyyy-mm-dd) for a named range. Financial
 *  years and quarters run from April. */
function rangeDates(r: DateRange): [string, string] {
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const fy = m >= 3 ? y : y - 1
  switch (r) {
    case 'today': return [iso(now), iso(now)]
    case 'this_month': return [iso(new Date(y, m, 1)), iso(new Date(y, m + 1, 0))]
    case 'last_month': return [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))]
    case 'this_quarter': {
      const q0 = m - (((m - 3) % 3) + 3) % 3
      return [iso(new Date(y, q0, 1)), iso(new Date(y, q0 + 3, 0))]
    }
    case 'this_fy': return [`${fy}-04-01`, `${fy + 1}-03-31`]
    case 'last_fy': return [`${fy - 1}-04-01`, `${fy}-03-31`]
    default: return ['', '']
  }
}

/** The rows on screen, as a spreadsheet: every figure a biller or an
 *  accountant asks for, amounts as numbers. */
function invoiceSheet(rows: Invoice[]) {
  const n = (v: string | null | undefined) => Number(v ?? 0)
  const header = ['Number', 'Type', 'Status', 'Payment status', 'Invoice date', 'Due date', 'Days overdue', 'Customer', 'GSTIN',
    'Place of supply', 'Customer PO', 'Sales order', 'Salesperson', 'Taxable value', 'CGST', 'SGST', 'IGST', 'Cess', 'Round off',
    'Grand total', 'Received', 'Credited', 'Balance due', 'Payment reference', 'E-way bill', 'Vehicle', 'Credit against', 'Reason']
  const tax = (i: Invoice) => i.status === 'posted' && i.kind !== 'proforma' && i.kind !== 'credit_note'
  const data = rows.map((i) => [
    i.number ?? 'Draft', INV_TITLE[i.kind] ?? i.kind, DOC_STATUSES.find(([k]) => k === i.status)?.[1] ?? i.status,
    tax(i) ? PAY_LABEL[payState(i)] : '', i.invoice_date, i.due_date ?? '', tax(i) && i.days_overdue > 0 ? i.days_overdue : '',
    i.customer_name, i.gstin ?? '', i.place_of_supply ?? '', i.customer_po_number ?? '', i.order_number ?? '', i.salesperson_name ?? '',
    n(i.sub_total), n(i.cgst), n(i.sgst), n(i.igst), n(i.cess_total), n(i.round_off), n(i.grand_total),
    tax(i) ? n(i.amount_received) : '', tax(i) ? n(i.amount_credited) : '', tax(i) ? n(i.outstanding) : '',
    i.payment_reference ?? '', i.eway_bill_number ?? '', i.vehicle_number ?? '', i.original_number ?? '', i.reason ?? '',
  ])
  return { header, data, money: [13, 14, 15, 16, 17, 18, 19, 20, 21, 22] }
}

function InvoiceList({ kind, onOpen, onNew }: {
  kind: 'invoice' | 'credit_note'
  onOpen: (id: string) => void
  /** On the Invoices page: New invoice goes back to the full-page form
   *  instead of opening the dialog. */
  onNew?: () => void
}) {
  const { can } = useAccess()
  const biller = can('can_manage_billing')
  const [q, setQ] = useState('')
  const [docStatus, setDocStatus] = useState<'' | Invoice['status']>('')
  const [state, setState] = useState<'' | PayState>('')
  const [customer, setCustomer] = useState('')
  const [type, setType] = useState('')
  const [range, setRange] = useState<DateRange>('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  // All sales documents at once — tax invoices and proformas — and every
  // filter, the search included, works on what is loaded.
  const list = useQuery(`erp-inv-${kind}`, () => kind === 'invoice'
    ? erp.invoices({}).then((xs) => xs.filter((i) => i.kind !== 'credit_note'))
    : erp.invoices({ kind }))
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<{ inv: Invoice; copy: boolean } | null>(null)
  const [printId, setPrintId] = useState<string | null>(null)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const removing = useRun(() => list.reload())

  /** Straight to a PDF file, without opening the print view. */
  async function download(i: Invoice) {
    setDownloading(i.id)
    setDownloadError(null)
    try {
      await downloadInvoicePdf(i)
    } catch {
      setDownloadError(`${i.number ?? 'The draft'} could not be downloaded. Open Print and use Save as PDF instead.`)
    } finally {
      setDownloading(null)
    }
  }
  const approver = can('can_approve_billing')
  const admin = canAdminister(useAuth().user)
  const [cancelling, setCancelling] = useState<Invoice | null>(null)
  const all = list.data ?? []
  const needle = q.trim().toLowerCase()
  const rows = all.filter((i) => (!state || payState(i) === state)
    && (!docStatus || i.status === docStatus)
    && (!customer || i.customer_id === customer)
    && (!type || i.kind === type)
    && (!from || i.invoice_date >= from) && (!to || i.invoice_date <= to)
    && (!needle || [i.number, i.customer_name, i.gstin, i.customer_po_number, i.order_number, i.salesperson_name,
      i.eway_bill_number, i.vehicle_number, i.payment_reference, i.grand_total]
      .some((v) => v && String(v).toLowerCase().includes(needle))))
  const customers = [...new Map(all.map((i) => [i.customer_id, i.customer_name])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
  const kinds = [...new Set(all.map((i) => i.kind))]
  const pickRange = (r: DateRange) => {
    setRange(r)
    if (r && r !== 'custom') {
      const [f, t] = rangeDates(r)
      setFrom(f)
      setTo(t)
    } else if (!r) {
      setFrom('')
      setTo('')
    }
  }
  const [exporting, setExporting] = useState(false)
  function exportRows(as: 'csv' | 'xlsx') {
    const name = `${kind === 'invoice' ? 'invoices' : 'credit-notes'}-${todayISO()}`
    const { header, data, money } = invoiceSheet(rows)
    if (as === 'csv') downloadCsv(`${name}.csv`, header, data)
    else downloadXlsx(`${name}.xlsx`, kind === 'invoice' ? 'Invoices' : 'Credit notes', header, data, money)
    setExporting(false)
  }
  const live = all.filter((i) => i.status === 'posted' && i.kind !== 'proforma')
  const sum = (xs: Invoice[], f: (i: Invoice) => string | number) => xs.reduce((n, i) => n + Number(f(i) || 0), 0)
  const overdue = live.filter((i) => payState(i) === 'overdue')
  const drafts = all.filter((i) => i.status === 'draft')
  const filtered = Boolean(q || state || docStatus || customer || type || from || to)
  const activeFilters = [docStatus, state, customer, type, from || to].filter(Boolean).length
  const [filtering, setFiltering] = useState(false)
  const clearAll = () => { setQ(''); setState(''); setDocStatus(''); setCustomer(''); setType(''); setRange(''); setFrom(''); setTo('') }

  function remove(i: Invoice) {
    if (i.status === 'draft') {
      if (!window.confirm(`Delete this draft${i.customer_name ? ` for ${i.customer_name}` : ''}? It has no number yet and cannot be recovered.`)) return
    } else if (!confirmDeleteIssued(i, isLatestNumber(i, all))) return
    void removing.run(() => erp.deleteInvoice(i.id), 'That invoice could not be deleted')
  }

  return (
    <>
      {kind === 'invoice' && (
        <div className="ivl-kpis">
          <button type="button" className="ivl-kpi" onClick={() => { setState(''); setDocStatus('posted') }}>
            <span>Invoiced</span><b>{rupees(sum(live, (i) => i.grand_total))}</b><small>{live.length} posted invoices</small>
          </button>
          <button type="button" className="ivl-kpi is-good" onClick={() => { setDocStatus(''); setState('paid') }}>
            <span>Received</span><b>{rupees(sum(live, (i) => i.amount_received))}</b><small>{live.filter((i) => payState(i) === 'paid').length} paid in full</small>
          </button>
          <button type="button" className="ivl-kpi is-warn" onClick={() => { setDocStatus(''); setState('unpaid') }}>
            <span>Outstanding</span><b>{rupees(sum(live, (i) => i.outstanding))}</b><small>{live.filter((i) => Number(i.outstanding) > 0).length} awaiting payment</small>
          </button>
          <button type="button" className="ivl-kpi is-bad" onClick={() => { setDocStatus(''); setState('overdue') }}>
            <span>Overdue</span><b>{rupees(sum(overdue, (i) => i.outstanding))}</b><small>{overdue.length} past due date</small>
          </button>
          <button type="button" className="ivl-kpi is-idle" onClick={() => { setState(''); setDocStatus('draft') }}>
            <span>Drafts</span><b>{drafts.length}</b><small>{rupees(sum(drafts, (i) => i.grand_total))} not yet posted</small>
          </button>
        </div>
      )}

      <div className="crm-bar ivl-bar">
        <div className="crm-search"><IconSearch size={15} />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={kind === 'invoice' ? 'Search number, customer, GSTIN, PO, e-way bill…' : 'Search number, customer'} /></div>
        <div className="ivl-filter">
          <button type="button" className={`btn ivl-filter-btn${activeFilters ? ' is-on' : ''}`} aria-haspopup="dialog" aria-expanded={filtering}
            onClick={() => setFiltering((v) => !v)}>
            <IconSliders size={15} /> Filters{activeFilters > 0 && <span className="ivl-filter-n">{activeFilters}</span>}
          </button>
          {filtering && (
            <>
              <div className="ivl-filter-scrim" onClick={() => setFiltering(false)} />
              <div className="ivl-filter-pop" role="dialog" aria-label="Filters">
                <div className="ivl-filter-grid">
                  <label><span>Status</span>
                    <select value={docStatus} onChange={(e) => setDocStatus(e.target.value as typeof docStatus)} aria-label="Status">
                      <option value="">All statuses</option>
                      {(kind === 'invoice' ? DOC_STATUSES.filter(([k]) => k !== 'submitted' && k !== 'rejected') : DOC_STATUSES)
                        .map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                    </select></label>
                  {kind === 'invoice' && (
                    <label><span>Payment status</span>
                      <select value={state} onChange={(e) => setState(e.target.value as typeof state)} aria-label="Payment status">
                        <option value="">Any payment</option>
                        {(['unpaid', 'partial', 'overdue', 'paid'] as PayState[]).map((st) => <option key={st} value={st}>{PAY_LABEL[st]}</option>)}
                      </select></label>
                  )}
                  <label><span>Customer</span>
                    <select value={customer} onChange={(e) => setCustomer(e.target.value)} aria-label="Customer">
                      <option value="">All customers</option>
                      {customers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                    </select></label>
                  {kind === 'invoice' && (
                    <label><span>Invoice type</span>
                      <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Invoice type">
                        <option value="">All types</option>
                        {(['service', 'product', 'milestone', 'proforma'] as const).filter((k) => kinds.includes(k) || type === k)
                          .map((k) => <option key={k} value={k}>{INV_TITLE[k]}</option>)}
                      </select></label>
                  )}
                  <label className="is-wide"><span>Invoice date</span>
                    <select value={range} onChange={(e) => pickRange(e.target.value as DateRange)} aria-label="Date range">
                      <option value="">Any date</option>
                      {DATE_RANGES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                    </select></label>
                  <label><span>From</span><input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setRange('custom') }} /></label>
                  <label><span>To</span><input type="date" value={to} min={from || undefined} onChange={(e) => { setTo(e.target.value); setRange('custom') }} /></label>
                </div>
                <div className="ivl-filter-foot">
                  <span>{rows.length} of {all.length} match</span>
                  <button type="button" className="btn btn-sm" disabled={!activeFilters} onClick={clearAll}>Clear all</button>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => setFiltering(false)}>Done</button>
                </div>
              </div>
            </>
          )}
        </div>
        {filtered && <button type="button" className="btn btn-sm ivl-clear" onClick={clearAll}>Clear</button>}
        {list.data && <span className="ivl-count">{rows.length} of {all.length}</span>}
        <div className="ivl-export crm-push">
          <button type="button" className="btn" disabled={!rows.length} aria-haspopup="menu" aria-expanded={exporting}
            title={rows.length ? `Export the ${rows.length} shown` : 'Nothing to export'} onClick={() => setExporting((v) => !v)}>
            <IconDownload size={15} /> Export
          </button>
          {exporting && (
            <div className="ivl-export-menu" role="menu" onMouseLeave={() => setExporting(false)}>
              <button type="button" role="menuitem" onClick={() => exportRows('xlsx')}><b>Excel</b><small>.xlsx · {rows.length} rows</small></button>
              <button type="button" role="menuitem" onClick={() => exportRows('csv')}><b>CSV</b><small>.csv · {rows.length} rows</small></button>
            </div>
          )}
        </div>
        {kind === 'invoice' && biller && <button className="btn btn-primary" onClick={() => (onNew ? onNew() : setCreating(true))}><IconPlus size={15} /> {onNew ? 'New invoice' : 'Service / proforma invoice'}</button>}
      </div>
      {list.error && <ErrorNote>{erpError(list.cause, 'Could not load invoices')}</ErrorNote>}
      {removing.error && <div style={{ marginBottom: 10 }}><ErrorNote>{removing.error}</ErrorNote></div>}
      {downloadError && <div style={{ marginBottom: 10 }}><ErrorNote>{downloadError}</ErrorNote></div>}
      <section className="card ivl-card">
        {!list.data ? <Loading /> : all.length === 0 ? (
          <EmptyState icon={<IconCard size={22} />} title={kind === 'invoice' ? 'No invoices yet' : 'No credit notes'}
            body={kind === 'invoice' ? 'Create a sale bill, or raise a product invoice from a dispatch.' : 'Raise one from a posted invoice.'} />
        ) : rows.length === 0 ? (
          <EmptyState icon={<IconSearch size={22} />} title="Nothing matches" body="Change the search or the filters." />
        ) : (
          <div className="table-wrap"><table className="ivl">
            <thead><tr>
              <th>{kind === 'invoice' ? 'Invoice' : 'Credit note'}</th><th>Customer</th><th>Date</th><th>Due</th>
              <th className="crm-num">Grand total</th><th className="crm-num">Paid</th><th className="crm-num">Balance due</th><th>Status</th><th className="ivl-c-act">Actions</th>
            </tr></thead>
            <tbody>{rows.map((i) => {
              const st = payState(i)
              const canEdit = biller && i.status === 'draft' && editableKinds.includes(i.kind)
              return (
                <tr key={i.id} onClick={() => onOpen(i.id)} className={`is-${st}`}>
                  <td>
                    <span className="ivl-no">{i.number ?? <em>Draft</em>}</span>
                    <small className="ivl-kind">{INV_TITLE[i.kind] ?? i.kind}{i.order_number ? ` · ${i.order_number}` : ''}</small>
                  </td>
                  <td>
                    <span className="ivl-cust" title={i.customer_name}>{i.customer_name}</span>
                    {i.gstin && <small className="ivl-gst">{i.gstin}</small>}
                  </td>
                  <td className="ivl-date-cell"><DateText iso={i.invoice_date} /></td>
                  <td className="ivl-date-cell">
                    <DateText iso={i.due_date} />
                    {st === 'overdue' && <small className="ivl-late">{i.days_overdue}d overdue</small>}
                  </td>
                  <td className="crm-num ivl-amt">{rupees(i.grand_total)}</td>
                  <td className={`crm-num${Number(i.amount_received) > 0 ? ' ivl-paid' : ' ivl-zero'}`}>
                    {i.status === 'posted' && i.kind !== 'proforma' ? rupees(i.amount_received) : '—'}
                    {Number(i.amount_credited) > 0 && <small className="ivl-kind">+ {rupees(i.amount_credited)} credited</small>}
                  </td>
                  <td className={`crm-num${Number(i.outstanding) > 0 && i.status === 'posted' && i.kind !== 'proforma' ? ' ivl-due' : ' ivl-zero'}`}>
                    {i.status === 'posted' && i.kind !== 'proforma' ? rupees(i.outstanding) : '—'}
                  </td>
                  <td><span className={`ivl-state is-${st}`}><i aria-hidden />{PAY_LABEL[st]}</span></td>
                  <td className="ivl-c-act" onClick={(e) => e.stopPropagation()}>
                    <div className="ivl-actions">
                      <button className="crm-icon-btn" title="Open" aria-label={`Open ${i.number ?? 'draft'}`} onClick={() => onOpen(i.id)}><IconSheet size={14} /></button>
                      {canEdit && <button className="crm-icon-btn" title="Edit draft" aria-label="Edit draft" onClick={() => setEditing({ inv: i, copy: false })}><IconEdit size={14} /></button>}
                      <button className="crm-icon-btn" title="Print" aria-label={`Print ${i.number ?? 'draft'}`} onClick={() => setPrintId(i.id)}><IconPrinter size={14} /></button>
                      <button className="crm-icon-btn" title="Download PDF" aria-label={`Download ${i.number ?? 'draft'} as PDF`}
                        disabled={downloading === i.id} onClick={() => void download(i)}>
                        {downloading === i.id ? <span className="ivl-spin" aria-hidden /> : <IconDownload size={14} />}
                      </button>

                      {approver && i.status === 'posted' && i.kind !== 'credit_note' && i.kind !== 'proforma' && (() => {
                        const paid = Number(i.amount_received) + Number(i.amount_credited) > 0
                        return (
                          <button className="crm-icon-btn crm-icon-danger" disabled={paid}
                            title={paid ? 'Money is received against it — raise a credit note instead' : 'Cancel invoice'}
                            aria-label={`Cancel ${i.number}`} onClick={() => setCancelling(i)}>
                            <IconClose size={14} />
                          </button>
                        )
                      })()}
                      {(() => {
                        const block = deleteBlock(i, biller, admin)
                        return (
                          <button className="crm-icon-btn crm-icon-danger" disabled={Boolean(block) || removing.busy}
                            title={block ?? (i.status === 'draft' ? 'Delete draft' : 'Delete invoice')}
                            aria-label={`Delete ${i.number ?? 'draft'}`} onClick={() => remove(i)}>
                            <IconTrash size={14} />
                          </button>
                        )
                      })()}
                    </div>
                  </td>
                </tr>
              )
            })}</tbody>
          </table></div>
        )}
      </section>
      {printId && <PrintById id={printId} onClose={() => setPrintId(null)} />}
      {cancelling && (
        <ReasonDialog title={`Cancel ${cancelling.number}`} danger confirm="Cancel invoice"
          hint="A posted invoice is never deleted — GST needs its number kept. It stays on record marked Cancelled and stops counting as owed."
          onClose={() => setCancelling(null)}
          onSubmit={async (r) => { await erp.cancelInvoice(cancelling.id, r); setCancelling(null); list.reload() }} />
      )}
      {creating && <ManualInvoice onClose={() => setCreating(false)} onSaved={(inv) => { setCreating(false); list.reload(); onOpen(inv.id) }} />}
      {editing && (
        <ManualInvoice invoice={editing.inv} copy={editing.copy} onClose={() => setEditing(null)}
          onSaved={(inv) => { setEditing(null); list.reload(); onOpen(inv.id) }} />
      )}
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

/* ---------------------------------------------------------- invoice editor --- */

const INV_TITLE: Record<string, string> = {
  product: 'Tax invoice', service: 'Tax invoice', milestone: 'Tax invoice',
  proforma: 'Proforma invoice', credit_note: 'Credit note',
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** A service or proforma invoice, laid out as the invoice it becomes: title and
 *  number on top, who it is billed to beside its dates, the lines, then notes
 *  and terms beside the totals. The number is issued on posting, so a draft
 *  shows where it will go rather than a number it may not get. */
/** A party as My Customers lists it: the customer's own name, their code,
 *  and the company when there is one — two customers of one company stay
 *  two names, not the same company twice. */
const partyLabel = (c: CustomerAccount) =>
  [c.contact_name || c.customer_name, c.customer_code, c.customer_name !== c.contact_name ? c.customer_name : null]
    .filter(Boolean).join(' · ')

const GST_RATES = ['0', '5', '12', '18', '28']
const MIN_ROWS = 5

/** The server's checks, so a wrong value is caught as it is typed. */
const plate = (v: string) => v.replace(/[\s-]/g, '').toUpperCase()
const vehicleOk = (v: string) => !v.trim() || /^([A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}|\d{2}BH\d{4}[A-Z]{1,2})$/.test(plate(v))
const ewayOk = (v: string) => !v.trim() || /^\d{12}$/.test(v.replace(/\s/g, ''))

interface Transport {
  customer_po_number: string
  reverse_charge: boolean
  dispatch_doc_number: string
  transporter_name: string
  vehicle_number: string
  eway_bill_number: string
  lr_number: string
}
const NO_TRANSPORT: Transport = {
  customer_po_number: '', reverse_charge: false, dispatch_doc_number: '', transporter_name: '',
  vehicle_number: '', eway_bill_number: '', lr_number: '',
}

interface BillLine {
  key: string
  item_id: string
  name: string
  hsn_sac: string
  uom: string
  quantity: string
  free: string
  rate: string
  discount: string
  discount2: string
  gst_percent: string
  /** GST compensation cess %, where the line attracts it. */
  cess: string
}

const blankBillLine = (): BillLine => ({
  key: Math.random().toString(36).slice(2), item_id: '', name: '', hsn_sac: '', uom: 'Nos',
  quantity: '1', free: '', rate: '', discount: '', discount2: '', gst_percent: '18', cess: '',
})

/** Round off as it reads on a bill: +0.20 or −0.30. */
const signed = (n: number) => (n > 0 ? '+ ' : n < 0 ? '− ' : '') + Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const isFilled = (l: BillLine) => Boolean(l.item_id || l.name.trim())
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const fmt = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

type DiscMode = 'pct' | 'amt'

/** The rate the server is sent: with "rates include GST" on, the typed rate
 *  is GST-inclusive and the taxable rate is backed out of it. */
const exclusiveRate = (l: BillLine, incl: boolean) =>
  incl ? r2(Number(l.rate || 0) / (1 + Number(l.gst_percent || 0) / 100)) : Number(l.rate || 0)

/** One line's arithmetic, the same as the server's price_line: the first
 *  discount (% or ₹), the second off what that left, then the bill discount,
 *  then GST on what is left. Free units are not charged. */
function billMath(l: BillLine, mode: DiscMode, billPct: number, charge = false, mode2: DiscMode = 'pct', incl = false) {
  const gross = Number(l.quantity || 0) * exclusiveRate(l, incl)
  const d = Number(l.discount || 0)
  const d2 = Number(l.discount2 || 0)
  const afterFirst = Math.max(0, gross - (mode === 'pct' ? gross * d / 100 : d))
  const afterLine = Math.max(0, afterFirst - (mode2 === 'pct' ? afterFirst * d2 / 100 : d2))
  const after = charge ? afterLine : afterLine - afterLine * billPct / 100
  const taxable = r2(after)
  const tax = r2(taxable * Number(l.gst_percent || 0) / 100)
  return { gross, after, lineDisc: gross - afterLine, billDisc: afterLine - after, taxable, tax, amount: r2(taxable + tax) }
}

/** The bill's rupee discounts shared over the item lines by value — the
 *  server's _bill_shares: rounded to the paisa, the last line taking what
 *  rounding left so the shares add up exactly. */
function shareOut(total: number, values: number[]): number[] {
  const worth = values.reduce((n, v) => n + v, 0)
  if (total <= 0 || worth <= 0) return values.map(() => 0)
  const live = values.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0)
  const out = values.map(() => 0)
  let given = 0
  live.forEach((i, n) => {
    const share = n === live.length - 1 ? r2(total - given) : r2(total * values[i] / worth)
    out[i] = share
    given = r2(given + share)
  })
  return out
}

/** Keep a typed amount to a number with at most two decimals (and under a
 *  ceiling, for percentages). Anything else typed is dropped. */
function money2(raw: string, max?: number): string {
  let v = raw.replace(/[^\d.]/g, '')
  const dot = v.indexOf('.')
  if (dot >= 0) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '').slice(0, 2)
  if (max !== undefined && Number(v) > max) v = String(max)
  return v
}

/** Charges a bill can carry. Each is optional and taxed on its own. */
const CHARGE_KINDS = ['Freight charges', 'Packing charges', 'Loading & unloading', 'Insurance', 'Handling charges', 'Other charges'] as const
interface Charge { key: string; name: string; amount: string; gst: string }
const CHARGE_GST = ['none', '5', '12', '18', '28']

/** The sale bill — a dense, keyboard-first invoice screen. A header strip
 *  (party, date, bill no., type, salesman, place of supply), the items grid,
 *  and four panels under it: the row's item, discount and charges, the party,
 *  and the totals with Save. Everything else an invoice carries — addresses,
 *  bank, payment reference, delivery date, notes, terms — is one click away
 *  in More details. F3 = party, F2 = item, Ctrl+S = save bill. */
/** A saved invoice back into the bill's fields — for editing a draft, or for
 *  starting a new bill as a copy of any invoice. */
function seedFrom(inv: Invoice, copy: boolean) {
  const n = (v: string | null | undefined) => Number(v ?? 0)
  const items = inv.lines.filter((l) => !l.is_charge)
  const charges: Charge[] = inv.lines.filter((l) => l.is_charge).map((c) => ({
    key: Math.random().toString(36).slice(2), name: c.description,
    amount: String(r2(n(c.rate) * n(c.quantity))), gst: n(c.gst_percent) > 0 ? String(n(c.gst_percent)) : 'none',
  }))
  const discMode: DiscMode = items.some((l) => n(l.discount_amount) > 0) ? 'amt'
    : items.some((l) => n(l.discount_percent) > 0) ? 'pct' : 'amt'
  const discMode2: DiscMode = items.some((l) => n(l.discount2_amount) > 0) ? 'amt' : 'pct'
  const show = (v: number) => (v ? String(v) : '')
  return {
    kind: (inv.kind === 'proforma' ? 'proforma' : 'service') as 'service' | 'proforma',
    customerId: inv.customer_id,
    invoiceDate: copy ? todayISO() : inv.invoice_date,
    billType: (inv.due_date && inv.due_date === inv.invoice_date ? 'cash' : 'credit') as 'credit' | 'cash',
    salespersonId: inv.salesperson_id ?? '',
    place: inv.place_of_supply ?? '',
    dueOverride: copy ? '' : inv.due_date ?? '',
    billing: inv.billing_address ?? '',
    shipTo: inv.shipping_address ? 'other' : 'same',
    shipOther: inv.shipping_address ?? '',
    deliveryDate: copy ? '' : inv.delivery_date ?? '',
    bankId: inv.recipient_bank?.id ?? '',
    payRef: inv.payment_ref_standard ? '' : inv.payment_reference ?? '',
    payRefStandard: inv.payment_ref_standard,
    notes: inv.notes ?? '',
    terms: inv.terms ?? '',
    discMode, discMode2,
    billDisc: show(n(inv.bill_discount_percent)),
    billDiscAmt: show(n(inv.bill_discount_amount)),
    addlDisc: show(n(inv.additional_discount)),
    discReason: inv.discount_reason ?? '',
    charges,
    roundOff: n(inv.round_off) !== 0,
    transport: {
      customer_po_number: inv.customer_po_number ?? '', reverse_charge: Boolean(inv.reverse_charge),
      dispatch_doc_number: copy ? '' : inv.dispatch_doc_number ?? '', transporter_name: inv.transporter_name ?? '',
      vehicle_number: copy ? '' : inv.vehicle_number ?? '', eway_bill_number: copy ? '' : inv.eway_bill_number ?? '',
      lr_number: copy ? '' : inv.lr_number ?? '',
    } as Transport,
    lines: [...items.map((l): BillLine => ({
      key: Math.random().toString(36).slice(2), item_id: l.item_id ?? '', name: l.description,
      hsn_sac: l.hsn_sac ?? '', uom: l.uom ?? 'Nos', quantity: String(n(l.quantity)), free: show(n(l.free_qty)),
      rate: String(n(l.rate)),
      discount: show(discMode === 'amt' ? n(l.discount_amount) : n(l.discount_percent)),
      discount2: show(discMode2 === 'amt' ? n(l.discount2_amount) : n(l.discount2_percent)),
      gst_percent: String(n(l.gst_percent)), cess: show(n(l.cess_percent)),
    })), blankBillLine()],
    cessOn: items.some((l) => n(l.cess_percent) > 0),
  }
}

function ManualInvoice({ onClose, onSaved, inline, onShowAll, invoice, copy }: {
  onClose: () => void
  onSaved: (inv: Invoice) => void
  /** On the Invoices page itself rather than in a dialog. */
  inline?: boolean
  /** The way to the invoice list, in the bill's top bar. */
  onShowAll?: () => void
  /** A draft to edit — or, with ``copy``, any invoice to start a new bill from. */
  invoice?: Invoice | null
  copy?: boolean
}) {
  const items = useItems()
  const customers = useQuery('erp-customers-all', () => erp.customers())
  const settings = useQuery('erp-settings', () => erp.settings())
  const { user } = useAuth()
  const [seed] = useState(() => (invoice ? seedFrom(invoice, Boolean(copy)) : null))
  const editing = Boolean(invoice && !copy)
  const [kind, setKind] = useState<'service' | 'proforma'>(seed?.kind ?? 'service')
  const [customerId, setCustomerId] = useState(seed?.customerId ?? '')
  const [invoiceDate, setInvoiceDate] = useState(seed?.invoiceDate ?? todayISO())
  const [billType, setBillType] = useState<'credit' | 'cash'>(seed?.billType ?? 'credit')
  const [salespersonId, setSalespersonId] = useState(seed ? seed.salespersonId : user?.id ?? '')
  const [place, setPlace] = useState<string | null>(seed ? seed.place : null)
  const [dueOverride, setDueOverride] = useState(seed?.dueOverride ?? '')
  const [more, setMore] = useState(false)
  const [billing, setBilling] = useState<string | null>(seed ? seed.billing : null)
  const [shipTo, setShipTo] = useState(seed?.shipTo ?? 'same')
  const [shipOther, setShipOther] = useState(seed?.shipOther ?? '')
  const [deliveryDate, setDeliveryDate] = useState(seed?.deliveryDate ?? '')
  const [bankId, setBankId] = useState<string | null>(seed ? seed.bankId : null)
  const [payRef, setPayRef] = useState(seed?.payRef ?? '')
  const [payRefStandard, setPayRefStandard] = useState(seed?.payRefStandard ?? true)
  const [notes, setNotes] = useState(seed?.notes ?? '')
  const [terms, setTerms] = useState<string | null>(seed ? seed.terms : null)
  const [lines, setLines] = useState<BillLine[]>(seed?.lines ?? [blankBillLine()])
  const [discMode, setDiscMode] = useState<DiscMode>(seed?.discMode ?? 'amt')
  const [discMode2, setDiscMode2] = useState<DiscMode>(seed?.discMode2 ?? 'pct')
  const [ratesIncl, setRatesIncl] = useState(false)
  const [cessOn, setCessOn] = useState(seed?.cessOn ?? false)
  // Item list: the name searches the item master and a pick fills HSN, unit,
  // rate and GST. Manual: whatever is typed is the line, filled by hand.
  const [itemMode, setItemMode] = useState<'list' | 'manual'>('list')
  const [billDisc, setBillDisc] = useState(seed?.billDisc ?? '')
  const [billDiscAmt, setBillDiscAmt] = useState(seed?.billDiscAmt ?? '')
  const [addlDisc, setAddlDisc] = useState(seed?.addlDisc ?? '')
  const [discReason, setDiscReason] = useState(seed?.discReason ?? '')
  const [chargeList, setChargeList] = useState<Charge[]>(seed?.charges ?? [])
  const [addingCharge, setAddingCharge] = useState(false)
  const [roundOff, setRoundOff] = useState(seed?.roundOff ?? true)
  const [transport, setTransport] = useState<Transport>(seed?.transport ?? NO_TRANSPORT)
  const setT = <K extends keyof Transport>(k: K, v: Transport[K]) => setTransport((t) => ({ ...t, [k]: v }))
  const transportOk = vehicleOk(transport.vehicle_number) && ewayOk(transport.eway_bill_number)
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const customerRef = useRef<HTMLSelectElement>(null)
  const itemRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const { busy, error, run } = useRun()
  const nextNo = useQuery(`erp-inv-next-${kind}-${invoiceDate}`, () => erp.nextInvoiceNumber(kind, invoiceDate))

  const customer = (customers.data ?? []).find((c) => c.customer_id === customerId) ?? null
  const account = customer?.account ?? null
  const sites = (account?.sites ?? []).filter((s) => s.is_active)
  const creditDays = account?.credit_days ?? settings.data?.default_credit_days ?? 30
  const due = dueOverride || (billType === 'cash' ? invoiceDate : addDays(invoiceDate, creditDays))
  const placeOfSupply = place ?? account?.billing_state ?? ''
  const companyState = nextNo.data?.company_state ?? null
  const interstate = Boolean(companyState && placeOfSupply.trim() && placeOfSupply.trim().toLowerCase() !== companyState)
  const billingAddress = billing ?? account?.billing_address ?? ''
  const shippingAddress = shipTo === 'same' ? null
    : shipTo === 'other' ? shipOther || null
      : sites.find((s) => s.id === shipTo)?.address ?? null
  const termsText = terms ?? settings.data?.invoice_terms ?? ''
  const banks = settings.data?.bank_accounts ?? []
  const chosenBankId = bankId ?? banks.find((b) => b.is_default)?.id ?? ''
  const bank = banks.find((b) => b.id === chosenBankId) ?? null
  const sellable = (items.data ?? []).filter((i) => i.can_be_sold !== false)
  const codeOf = new Map((items.data ?? []).map((i) => [i.id, i.code]))

  // The grid always ends in one empty row to type into. It lives in state
  // (see withBlank) so its key — and the input in it — survive each keystroke.
  const rows = lines
  const filled = lines.filter(isFilled)
  const billPct = Number(billDisc || 0)
  const preShare = filled.map((l) => billMath(l, discMode, billPct, false, discMode2, ratesIncl))
  // Rupee discounts on the whole bill, shared over the item lines before GST.
  const billAmt = r2(Number(billDiscAmt || 0))
  const addlAmt = r2(Number(addlDisc || 0))
  const itemWorth = r2(preShare.reduce((n, m) => n + m.after, 0))
  const discTooBig = billAmt + addlAmt > itemWorth + 0.001
  const shares = discTooBig ? preShare.map(() => 0) : shareOut(r2(billAmt + addlAmt), preShare.map((m) => m.after))
  const itemMath = preShare.map((m, i) => {
    const taxableLine = r2(Math.max(0, m.after - shares[i]))
    const taxLine = r2(taxableLine * Number(filled[i].gst_percent || 0) / 100)
    const cessLine = cessOn ? r2(taxableLine * Number(filled[i].cess || 0) / 100) : 0
    return { ...m, billDisc: m.billDisc + shares[i], taxable: taxableLine, tax: taxLine, cess: cessLine, amount: r2(taxableLine + taxLine + cessLine) }
  })
  const mathByKey = new Map(filled.map((l, i) => [l.key, itemMath[i]]))
  // A new charge is taxed at the bill's highest item rate, as the principal supply.
  const chargeGst = String(Math.max(18 * Number(filled.length === 0), ...filled.map((l) => Number(l.gst_percent || 0))))
  const charges = chargeList.filter((c) => Number(c.amount || 0) > 0).map((c) => ({
    ...blankBillLine(), key: c.key, name: c.name, rate: String(r2(Number(c.amount))),
    gst_percent: c.gst === 'none' ? '0' : c.gst,
  }))
  const chargeMath = charges.map((c) => billMath(c, 'pct', 0, true))
  const all = [...itemMath, ...chargeMath]
  const gross = itemMath.reduce((n, m) => n + m.gross, 0)
  const discount = itemMath.reduce((n, m) => n + m.lineDisc + m.billDisc, 0)
  const chargesTotal = chargeMath.reduce((n, m) => n + m.taxable, 0)
  const reasonMissing = addlAmt > 0 && !discReason.trim()
  const discOk = !discTooBig && !reasonMissing && billPct <= 100
  const posMissing = kind === 'service' && !placeOfSupply.trim()
  const cessBad = cessOn && filled.some((l) => Number(l.cess || 0) > 300)
  const taxable = all.reduce((n, m) => n + m.taxable, 0)
  const tax = all.reduce((n, m) => n + m.tax, 0)
  // Cess is charged on item lines only, on the same taxable value as GST.
  const cessTotal = r2(itemMath.reduce((n, m) => n + m.cess, 0))
  const exact = r2(taxable + tax + cessTotal)
  const net = roundOff ? Math.round(exact) : exact
  const rounding = r2(net - exact)
  const qtyTotal = filled.reduce((n, l) => n + Number(l.quantity || 0) + Number(l.free || 0), 0)
  const ready = Boolean(customerId) && filled.length > 0 && due >= invoiceDate && transportOk && discOk && !posMissing && !cessBad

  const active = rows.find((l) => l.key === activeKey) ?? null
  const activeItem = active?.item_id ? (items.data ?? []).find((i) => i.id === active.item_id) ?? null : null

  const withBlank = (ls: BillLine[]) => (ls.length && !isFilled(ls[ls.length - 1]) ? ls : [...ls, blankBillLine()])
  function setLine(key: string, patch: Partial<BillLine>) {
    setLines((ls) => withBlank(ls.map((l) => (l.key === key ? { ...l, ...patch } : l))))
  }
  const removeLine = (key: string) => setLines((ls) => withBlank(ls.filter((l) => l.key !== key)))

  function payload() {
    const toLine = (l: BillLine, charge = false) => ({
      item_id: l.item_id || null, description: l.name.trim() || '—', hsn_sac: l.hsn_sac || null,
      uom: l.uom || null, quantity: l.quantity || '1', free_qty: charge ? '0' : l.free || '0',
      rate: charge ? l.rate || '0' : String(exclusiveRate(l, ratesIncl)),
      discount_percent: !charge && discMode === 'pct' ? l.discount || '0' : '0',
      discount_amount: !charge && discMode === 'amt' ? l.discount || '0' : '0',
      discount2_percent: !charge && discMode2 === 'pct' ? l.discount2 || '0' : '0',
      discount2_amount: !charge && discMode2 === 'amt' ? l.discount2 || '0' : '0',
      gst_percent: l.gst_percent || '0', is_charge: charge,
      cess_percent: !charge && cessOn ? l.cess || '0' : '0',
    })
    return {
      kind, customer_id: customerId, invoice_date: invoiceDate, due_date: due,
      place_of_supply: placeOfSupply || null, billing_address: billingAddress || null,
      shipping_address: shippingAddress, notes: notes || null, terms: termsText || null,
      salesperson_id: salespersonId || null, delivery_date: deliveryDate || null,
      recipient_bank_id: chosenBankId || null, payment_ref_standard: payRefStandard,
      payment_reference: payRefStandard ? null : payRef || null,
      bill_discount_percent: billDisc || '0', round_off: roundOff,
      bill_discount_amount: billAmt ? String(billAmt) : '0', additional_discount: addlAmt ? String(addlAmt) : '0',
      discount_reason: addlAmt > 0 ? discReason.trim() : null,
      customer_po_number: transport.customer_po_number.trim() || null, reverse_charge: transport.reverse_charge,
      dispatch_doc_number: transport.dispatch_doc_number.trim() || null,
      transporter_name: transport.transporter_name.trim() || null,
      vehicle_number: transport.vehicle_number.trim() ? plate(transport.vehicle_number) : null,
      eway_bill_number: transport.eway_bill_number.trim() ? transport.eway_bill_number.replace(/\s/g, '') : null,
      lr_number: transport.lr_number.trim() || null,
      lines: [...filled.map((l) => toLine(l)), ...charges.map((c) => toLine(c, true))],
    }
  }
  // Editing a draft saves over it; anything else is a new bill.
  const target = editing ? invoice!.id : undefined
  const saveDraft = () => void run(async () => onSaved(await erp.saveInvoice(payload(), target)))
  const saveBill = () => void run(async () => {
    const saved = await erp.saveInvoice(payload(), target)
    onSaved(await erp.postInvoice(saved.id))
  })

  // F3 → party, F2 → item of the current row, Ctrl+S / F10 → save bill,
  // Alt+D → delete the current row.
  const keys = useRef({ ready, busy, saveBill, activeKey, rows, removeLine })
  keys.current = { ready, busy, saveBill, activeKey, rows, removeLine }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keys.current
      if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') || e.key === 'F10') {
        e.preventDefault()
        if (k.ready && !k.busy) k.saveBill()
      } else if (e.altKey && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        const row = k.rows.find((r) => r.key === k.activeKey)
        if (row && isFilled(row)) k.removeLine(row.key)
      } else if (e.key === 'F3') {
        e.preventDefault(); customerRef.current?.focus()
      } else if (e.key === 'F2') {
        e.preventDefault()
        const key = k.activeKey ?? k.rows[k.rows.length - 1].key
        itemRefs.current[key]?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const draft: Invoice = {
    id: 'preview', number: nextNo.data?.number ?? null, kind, customer_id: customerId,
    customer_name: account?.legal_name || customer?.customer_name || 'Select a party',
    gstin: account?.gstin || customer?.crm_gstin || null, billing_address: billingAddress || null,
    shipping_address: shippingAddress, place_of_supply: placeOfSupply || null, sales_order_id: null,
    salesperson_id: salespersonId || null, salesperson_name: null, recipient_bank: bank,
    payment_reference: payRefStandard ? nextNo.data?.number ?? null : payRef || null,
    payment_ref_standard: payRefStandard, delivery_date: deliveryDate || null,
    bill_discount_percent: String(billPct), round_off: String(rounding),
    bill_discount_amount: String(billAmt), additional_discount: String(addlAmt), discount_reason: discReason || null,
    customer_po_number: transport.customer_po_number || null, reverse_charge: transport.reverse_charge,
    dispatch_doc_number: transport.dispatch_doc_number || null, transporter_name: transport.transporter_name || null,
    vehicle_number: transport.vehicle_number ? plate(transport.vehicle_number) : null,
    eway_bill_number: transport.eway_bill_number || null, lr_number: transport.lr_number || null,
    order_number: null, original_invoice_id: null, original_number: null, invoice_date: invoiceDate,
    due_date: due, is_interstate: interstate, sub_total: String(taxable),
    cgst: String(interstate ? 0 : tax / 2), sgst: String(interstate ? 0 : tax / 2), igst: String(interstate ? tax : 0),
    tax_total: String(tax), cess_total: String(cessTotal), grand_total: String(net), amount_received: '0', amount_credited: '0',
    outstanding: String(net), days_overdue: 0, reason: null, notes: notes || null, terms: termsText || null,
    status: 'draft', created_by: '', created_by_name: null, posted_by_name: null, reviewed_by_name: null,
    review_note: null, cancel_reason: null, chain: [], receipts: [], credit_notes: [],
    lines: [...filled, ...charges].map((l, i) => {
      const m = all[i]
      const isCharge = i >= filled.length
      return {
        id: String(i), item_id: l.item_id || null, description: l.name, hsn_sac: l.hsn_sac, uom: l.uom,
        quantity: l.quantity, rate: isCharge ? l.rate : String(exclusiveRate(l, ratesIncl)), gst_percent: l.gst_percent,
        free_qty: isCharge ? '0' : l.free || '0', is_charge: isCharge,
        discount_percent: !isCharge && discMode === 'pct' ? l.discount || '0' : '0',
        discount_amount: !isCharge && discMode === 'amt' ? l.discount || '0' : '0',
        taxable_value: String(m.taxable), tax_amount: String(m.tax), amount: String(m.amount),
        cess_percent: !isCharge && cessOn ? l.cess || '0' : '0', cess_amount: String((m as { cess?: number }).cess ?? 0),
      }
    }),
  }

  /** Enter → next field, Esc → back, through the header and the grid in
   *  reading order (Tab and Shift+Tab do the same natively). A key a field
   *  already used — the item search picking with Enter — is left alone. */
  function onNavKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented || (e.key !== 'Enter' && e.key !== 'Escape')) return
    const target = e.target as HTMLElement
    if (target.tagName === 'TEXTAREA' || target.tagName === 'BUTTON') return
    const fields = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(
      '.sb-head input, .sb-head select, .sb-grid td input, .sb-grid td select',
    )).filter((el) => !(el as HTMLInputElement).disabled)
    const at = fields.indexOf(target)
    if (at < 0) return
    e.preventDefault()
    fields[e.key === 'Enter' ? Math.min(at + 1, fields.length - 1) : Math.max(at - 1, 0)]?.focus()
  }

  const bill = (
    <div className={`sb${inline ? ' sb-page' : ''}`} onKeyDown={onNavKey}>
      <div className="sb-bar">
        <span className="sb-bar-icon" aria-hidden><IconSheet size={17} /></span>
        <div className="sb-bar-text">
          <h2 className="sb-title">
            {editing ? 'Edit draft bill' : copy ? 'New bill (copy)' : kind === 'proforma' ? 'Proforma bill' : 'Sale bill'}
          </h2>
          <span className="sb-bar-status">
            <i className={editing ? 'is-draft' : 'is-new'} />
            {editing ? 'Draft · not posted' : copy && invoice?.number ? `Copy of ${invoice.number}` : 'New · not saved yet'}
            {filled.length > 0 && <> · {filled.length} line{filled.length === 1 ? '' : 's'}</>}
          </span>
        </div>
        <div className="sb-seg" role="radiogroup" aria-label="Bill type">
          {([['service', 'Tax invoice'], ['proforma', 'Proforma']] as const).map(([key, label]) => (
            <button key={key} type="button" role="radio" aria-checked={kind === key}
              className={kind === key ? 'is-on' : ''} onClick={() => setKind(key)}>{label}</button>
          ))}
        </div>
        <span className="sb-bar-gap" />
        <label className={`sb-incl${cessOn ? ' is-on' : ''}`} title="Show a Cess % column — for goods that attract GST compensation cess">
          <input type="checkbox" checked={cessOn} onChange={(e) => setCessOn(e.target.checked)} /> Cess
        </label>
        <label className={`sb-incl${ratesIncl ? ' is-on' : ''}`} title="The rate typed in the grid already includes GST">
          <input type="checkbox" checked={ratesIncl} onChange={(e) => setRatesIncl(e.target.checked)} /> Rates include GST
        </label>
        <button type="button" className={`btn btn-sm${more ? ' is-on' : ''}`} onClick={() => setMore((m) => !m)}>
          <IconSliders size={14} /> More details
        </button>
        <button type="button" className="btn btn-sm" disabled={!filled.length} onClick={() => setPreviewing(true)}>
          <IconSheet size={14} /> Preview
        </button>
        {onShowAll && <button type="button" className="btn btn-sm" onClick={onShowAll}><IconFolder size={14} /> All invoices</button>}
      </div>

      <div className="sb-head">
        <label className="sb-f sb-f-name">
          <span>Name <kbd>F3</kbd></span>
          <select ref={customerRef} value={customerId} aria-label="Party"
            onChange={(e) => { setCustomerId(e.target.value); setPlace(null); setBilling(null); setShipTo('same') }}>
            <option value="">Select party…</option>
            {(customers.data ?? []).map((c) => <option key={c.customer_id} value={c.customer_id}>{partyLabel(c)}</option>)}
          </select>
        </label>
        <label className="sb-f sb-f-date">
          <span>Date</span>
          <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value || todayISO())} />
        </label>
        <div className="sb-f sb-f-billno">
          <span>Bill no.</span>
          <em title="The next number in the series — issued when the bill is saved">{nextNo.data?.number ?? '—'}</em>
          <small className="sb-next">next</small>
        </div>
        <label className="sb-f">
          <span>Type</span>
          <select value={billType} onChange={(e) => { setBillType(e.target.value as 'credit' | 'cash'); setDueOverride('') }}>
            <option value="credit">Credit</option>
            <option value="cash">Cash</option>
          </select>
        </label>
        <label className="sb-f">
          <span>Salesman</span>
          <OwnerSelect value={salespersonId} onChange={setSalespersonId} placeholder="— None —" />
        </label>
        <label className="sb-f">
          <span>Supply</span>
          <input value={placeOfSupply} onChange={(e) => setPlace(e.target.value)} placeholder="Place of supply (state)" />
        </label>
        <label className="sb-f">
          <span>Due</span>
          <input type="date" value={due} min={invoiceDate} onChange={(e) => setDueOverride(e.target.value)} />
        </label>
      </div>

      {more && (
        <div className="sb-more">
          <label><span>Billing address</span>
            <textarea rows={2} value={billingAddress} onChange={(e) => setBilling(e.target.value)} placeholder={customer ? 'Billing address' : 'Select a party'} /></label>
          <label><span>Shipping address</span>
            <select value={shipTo} onChange={(e) => setShipTo(e.target.value)}>
              <option value="same">Same as billing address</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              <option value="other">Other address…</option>
            </select>
            {shipTo === 'other' && <textarea rows={1} value={shipOther} onChange={(e) => setShipOther(e.target.value)} placeholder="Delivery address" />}
          </label>
          <label><span>Delivery date</span>
            <input type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} /></label>
          <label><span>Recipient bank</span>
            <select value={chosenBankId} onChange={(e) => setBankId(e.target.value)}>
              <option value="">{banks.length ? 'None' : 'None — add in ERP settings'}</option>
              {banks.map((b) => <option key={b.id} value={b.id}>{b.label || b.bank_name} · ••{b.account_number.slice(-4)}</option>)}
            </select></label>
          <label><span>Payment reference</span>
            <input value={payRefStandard ? (nextNo.data?.number ?? '') : payRef} disabled={payRefStandard}
              onChange={(e) => setPayRef(e.target.value)} placeholder="e.g. customer PO number" maxLength={60} />
            <span className="sb-check"><input type="checkbox" checked={payRefStandard} onChange={(e) => setPayRefStandard(e.target.checked)} /> Standard communication</span>
          </label>
          <div className="sb-more-row">
            <fieldset className="sb-more-set sb-more-order">
              <legend>Order &amp; tax</legend>
              <label><span>Customer PO number</span>
                <input value={transport.customer_po_number} maxLength={60} placeholder="e.g. PO-4501-778"
                  onChange={(e) => setT('customer_po_number', e.target.value)} /></label>
              <div className="sb-more-field">
                <span>Reverse charge</span>
                <div className="sb-yn" role="radiogroup" aria-label="Reverse charge">
                  {([[false, 'No'], [true, 'Yes']] as const).map(([v, label]) => (
                    <button key={label} type="button" role="radio" aria-checked={transport.reverse_charge === v}
                      className={transport.reverse_charge === v ? 'is-on' : ''} onClick={() => setT('reverse_charge', v)}>{label}</button>
                  ))}
                </div>
              </div>
            </fieldset>
            <fieldset className="sb-more-set sb-more-transport">
              <legend>Transport <small>optional</small></legend>
              <label><span>Dispatch doc. no.</span>
                <input value={transport.dispatch_doc_number} maxLength={40} placeholder="Delivery challan no."
                  onChange={(e) => setT('dispatch_doc_number', e.target.value)} /></label>
              <label><span>Transporter name</span>
                <input value={transport.transporter_name} maxLength={120} placeholder="e.g. VRL Logistics"
                  onChange={(e) => setT('transporter_name', e.target.value)} /></label>
              <label className={vehicleOk(transport.vehicle_number) ? '' : 'is-bad'}><span>Vehicle no.</span>
                <input value={transport.vehicle_number} maxLength={20} placeholder="MH12AB1234" className="sb-mono-in"
                  onChange={(e) => setT('vehicle_number', e.target.value.toUpperCase())} />
                {!vehicleOk(transport.vehicle_number) && <small>Like MH12AB1234</small>}</label>
              <label className={ewayOk(transport.eway_bill_number) ? '' : 'is-bad'}><span>E-way bill no.</span>
                <input value={transport.eway_bill_number} maxLength={14} placeholder="12 digits" inputMode="numeric" className="sb-mono-in"
                  onChange={(e) => setT('eway_bill_number', e.target.value.replace(/[^\d\s]/g, ''))} />
                {!ewayOk(transport.eway_bill_number) && <small>Must be 12 digits</small>}</label>
              <label title="LR / transport receipt number"><span>LR / receipt no.</span>
                <input value={transport.lr_number} maxLength={40} placeholder="LR / docket no."
                  onChange={(e) => setT('lr_number', e.target.value)} /></label>
            </fieldset>
          </div>
          <label className="sb-more-wide"><span>Notes</span>
            <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Shown on the invoice — PO reference, delivery note…" /></label>
          <label className="sb-more-wide"><span>Terms &amp; conditions</span>
            <textarea rows={2} value={termsText} onChange={(e) => setTerms(e.target.value)} placeholder="Payment terms, jurisdiction…" /></label>
        </div>
      )}

      <div className="sb-grid">
        <table>
          <thead>
            <tr>
              <th className="sb-c-sr">Sr</th>
              <th className="sb-c-item">
                Item name
                <span className="sb-mini-seg" role="radiogroup" aria-label="Item entry">
                  {([['list', 'Item list'], ['manual', 'Manual']] as const).map(([m, label]) => (
                    <button key={m} type="button" role="radio" aria-checked={itemMode === m}
                      className={itemMode === m ? 'is-on' : ''} onClick={() => setItemMode(m)}
                      title={m === 'list' ? 'Pick from the item master — HSN, unit, rate and GST come from the item' : 'Type the line yourself — no item lookup'}>
                      {label}
                    </button>
                  ))}
                </span>
              </th>
              <th className="sb-c-hsn">HSN/SAC</th>
              <th className="sb-c-qty">Qty</th>
              <th className="sb-c-free">Free</th>
              <th className="sb-c-unit">Unit</th>
              <th className="sb-c-rate">Rate</th>
              <th className="sb-c-dis">
                Dis
                <span className="sb-mini-seg">
                  {(['pct', 'amt'] as const).map((m) => (
                    <button key={m} type="button" className={discMode === m ? 'is-on' : ''} onClick={() => setDiscMode(m)}>{m === 'pct' ? '%' : '₹'}</button>
                  ))}
                </span>
              </th>
              <th className="sb-c-dis">
                Dis 2
                <span className="sb-mini-seg">
                  {(['pct', 'amt'] as const).map((m) => (
                    <button key={m} type="button" className={discMode2 === m ? 'is-on' : ''} onClick={() => setDiscMode2(m)}>{m === 'pct' ? '%' : '₹'}</button>
                  ))}
                </span>
              </th>
              <th className="sb-c-gst">GST %</th>
              {cessOn && <th className="sb-c-cess">Cess %</th>}
              <th className="sb-c-amt">Amount</th>
              <th className="sb-c-x" aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {rows.map((l, i) => {
              const m = isFilled(l) ? mathByKey.get(l.key) ?? billMath(l, discMode, billPct, false, discMode2, ratesIncl) : null
              return (
                <tr key={l.key} className={l.key === activeKey ? 'is-active' : ''} onFocusCapture={() => setActiveKey(l.key)}>
                  <td className="sb-c-sr">{i + 1}</td>
                  <td className="sb-c-item">
                    <ItemPicker value={l.name} items={sellable} manual={itemMode === 'manual'}
                      inputRef={(el) => { itemRefs.current[l.key] = el }}
                      onText={(name) => setLine(l.key, { name, item_id: '' })}
                      onPick={(it) => setLine(l.key, {
                        item_id: it.id, name: it.name, hsn_sac: it.hsn_sac ?? '', uom: it.uom,
                        rate: String(Number(it.sale_price)), gst_percent: String(Number(it.gst_percent)),
                      })} />
                    {l.item_id && codeOf.get(l.item_id) && <span className="sb-code">{codeOf.get(l.item_id)}</span>}
                  </td>
                  <td className="sb-c-hsn"><input value={l.hsn_sac} onChange={(e) => setLine(l.key, { hsn_sac: e.target.value })} /></td>
                  <td className="sb-c-qty"><input inputMode="decimal" value={isFilled(l) ? l.quantity : ''} onChange={(e) => setLine(l.key, { quantity: e.target.value })} /></td>
                  <td className="sb-c-free"><input inputMode="decimal" value={l.free} onChange={(e) => setLine(l.key, { free: e.target.value })} /></td>
                  <td className="sb-c-unit"><input value={isFilled(l) ? l.uom : ''} onChange={(e) => setLine(l.key, { uom: e.target.value })} /></td>
                  <td className="sb-c-rate"><input inputMode="decimal" value={l.rate} placeholder={isFilled(l) ? '0' : ''} onChange={(e) => setLine(l.key, { rate: e.target.value })} /></td>
                  <td className="sb-c-dis"><input inputMode="decimal" value={l.discount} placeholder={isFilled(l) ? '0' : ''} onChange={(e) => setLine(l.key, { discount: e.target.value })} /></td>
                  <td className="sb-c-dis"><input inputMode="decimal" value={l.discount2} placeholder={isFilled(l) ? '0' : ''} onChange={(e) => setLine(l.key, { discount2: e.target.value })} /></td>
                  <td className="sb-c-gst">
                    {isFilled(l) ? (
                      <select value={l.gst_percent} onChange={(e) => setLine(l.key, { gst_percent: e.target.value })}>
                        {!GST_RATES.includes(l.gst_percent) && <option value={l.gst_percent}>{l.gst_percent}%</option>}
                        {GST_RATES.map((r) => <option key={r} value={r}>{r}%</option>)}
                      </select>
                    ) : null}
                  </td>
                  {cessOn && (
                    <td className="sb-c-cess">
                      <input inputMode="decimal" value={l.cess} placeholder={isFilled(l) ? '0' : ''} aria-label="Cess %"
                        onChange={(e) => setLine(l.key, { cess: money2(e.target.value, 300) })} />
                    </td>
                  )}
                  <td className="sb-c-amt">{m ? fmt(m.amount) : ''}</td>
                  <td className="sb-c-x">
                    {isFilled(l) && <button type="button" className="sb-del" title="Remove line" aria-label="Remove line" onClick={() => removeLine(l.key)}><IconTrash size={13} /></button>}
                  </td>
                </tr>
              )
            })}
            {filled.length === 0 && (
              <tr className="sb-hint"><td className="sb-c-sr" /><td colSpan={cessOn ? 12 : 11}>
                <b>Start the bill:</b> type an item name or code in row 1 and pick it — HSN, unit, rate and GST fill in.
                Switch to <b>Manual</b> for a line that is not in the item list.
              </td></tr>
            )}
            {Array.from({ length: Math.max(0, MIN_ROWS - rows.length - (filled.length === 0 ? 1 : 0)) }, (_, i) => (
              <tr key={`pad-${i}`} className="sb-pad"><td className="sb-c-sr" /><td colSpan={cessOn ? 12 : 11} /></tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="sb-foot">
        <section className="sb-panel sb-panel-split">
          <div>
            <h4><IconFolder size={12} /> Item details</h4>
            <dl>
              <dt>Item</dt><dd title={active?.name}>{active && isFilled(active) ? <>{active.name}{activeItem && <small> ({activeItem.code})</small>}</> : '—'}</dd>
              <dt>HSN / GST</dt><dd>{active && isFilled(active) ? `${active.hsn_sac || '—'} · ${Number(active.gst_percent || 0)}%` : '—'}</dd>
              <dt>Stock</dt><dd>{activeItem ? (activeItem.is_stocked ? `${qtyText(activeItem.available_qty)} ${activeItem.uom}` : 'Not stocked') : '—'}</dd>
              <dt>Rate from</dt><dd>{activeItem ? 'Sale rate' : active && isFilled(active) ? 'Manual' : '—'}</dd>
            </dl>
          </div>
          <div>
            <h4><IconCard size={12} /> Discount &amp; charges</h4>
            <div className="sb-dc">
              <div className="sb-dc-row">
                <span className="sb-dc-label">Bill discount<small>Before GST</small></span>
                <span className="sb-affix sb-affix-sm"><input inputMode="decimal" value={billDisc} placeholder="0" aria-label="Bill discount %"
                  onChange={(e) => setBillDisc(money2(e.target.value, 100))} /><i>%</i></span>
                <span className="sb-affix sb-affix-sm"><input inputMode="decimal" value={billDiscAmt} placeholder="0" aria-label="Bill discount ₹"
                  onChange={(e) => setBillDiscAmt(money2(e.target.value))} /><i>₹</i></span>
              </div>
              <div className="sb-dc-row">
                <span className="sb-dc-label">Additional<small>Before GST</small></span>
                <span className="sb-affix sb-affix-sm"><input inputMode="decimal" value={addlDisc} placeholder="0" aria-label="Additional discount ₹"
                  onChange={(e) => setAddlDisc(money2(e.target.value))} /><i>₹</i></span>
                <input className={`sb-dc-reason${reasonMissing ? ' is-bad' : ''}`} value={discReason} maxLength={200}
                  placeholder={addlAmt > 0 ? 'Reason (required)' : 'Reason'} aria-label="Discount reason"
                  onChange={(e) => setDiscReason(e.target.value)} />
              </div>
              {discTooBig && <p className="sb-dc-err">Discounts ({rupees(billAmt + addlAmt)}) exceed the items' value ({rupees(itemWorth)}).</p>}
              {reasonMissing && <p className="sb-dc-err">Give a reason for the additional discount.</p>}

              <div className="sb-dc-head">
                <span>Charges</span>
                <div className="sb-dc-add">
                  <button type="button" className="sb-dc-addbtn" onClick={() => setAddingCharge((o) => !o)}
                    disabled={chargeList.length >= CHARGE_KINDS.length + 4}><IconPlus size={12} /> Add charge</button>
                  {addingCharge && (
                    <ul className="sb-dc-menu" onMouseLeave={() => setAddingCharge(false)}>
                      {CHARGE_KINDS.filter((k) => k === 'Other charges' || !chargeList.some((c) => c.name === k)).map((k) => (
                        <li key={k}><button type="button" onClick={() => {
                          setChargeList((cs) => [...cs, { key: Math.random().toString(36).slice(2), name: k, amount: '', gst: chargeGst }])
                          setAddingCharge(false)
                        }}>{k}</button></li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
              {chargeList.length === 0 ? <p className="sb-dc-none">No charges — add freight, packing, insurance…</p> : (
                <ul className="sb-dc-list">
                  {chargeList.map((c) => {
                    const amt = Number(c.amount || 0)
                    const g = c.gst === 'none' ? 0 : Number(c.gst)
                    return (
                      <li key={c.key}>
                        <span className="sb-dc-name" title={c.name}>{c.name}
                          <small>{amt > 0 ? (g ? `+ GST ${rupees(r2(amt * g / 100))}` : 'No GST') : '—'}</small></span>
                        <span className="sb-affix sb-affix-sm"><input inputMode="decimal" value={c.amount} placeholder="0" aria-label={`${c.name} amount`}
                          onChange={(e) => setChargeList((cs) => cs.map((x) => (x.key === c.key ? { ...x, amount: money2(e.target.value) } : x)))} /><i>₹</i></span>
                        <select className="sb-dc-gst" value={c.gst} aria-label={`${c.name} GST`}
                          onChange={(e) => setChargeList((cs) => cs.map((x) => (x.key === c.key ? { ...x, gst: e.target.value } : x)))}>
                          {CHARGE_GST.map((r) => <option key={r} value={r}>{r === 'none' ? 'No GST' : `${r}%`}</option>)}
                        </select>
                        <button type="button" className="sb-del" title="Remove charge" aria-label={`Remove ${c.name}`}
                          onClick={() => setChargeList((cs) => cs.filter((x) => x.key !== c.key))}><IconTrash size={12} /></button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </div>
        </section>

        <section className="sb-panel">
          <h4><IconUser size={12} /> Party</h4>
          <dl>
            <dt>Name</dt><dd>{customer ? <>{customer.contact_name || customer.customer_name}{customer.customer_name !== customer.contact_name && <small> · {account?.legal_name || customer.customer_name}</small>}</> : '—'}</dd>
            <dt>GSTIN</dt><dd className="sb-mono">{customer ? account?.gstin || customer.crm_gstin || 'Unregistered' : '—'}</dd>
            <dt>Outstanding</dt>
            <dd className={customer && Number(customer.overdue) > 0 ? 'is-bad' : ''}>
              {customer ? <>{rupees(customer.outstanding)}{Number(customer.overdue) > 0 && <small> · {rupees(customer.overdue)} overdue</small>}</> : '—'}
            </dd>
            <dt>Credit</dt><dd>{customer ? `${Number(account?.credit_limit ?? 0) > 0 ? rupees(account!.credit_limit) : 'No limit'} · ${creditDays} days` : '—'}</dd>
            <dt>Supply</dt><dd>{placeOfSupply ? (interstate ? 'Inter-state (IGST)' : 'Intra-state (CGST + SGST)') : '—'}</dd>
          </dl>
          {account?.credit_hold && <p className="sb-warn">On credit hold{account.hold_reason ? ` — ${account.hold_reason}` : ''}</p>}
        </section>

        <section className="sb-panel sb-totals">
          <div className="sb-tot">
            <dl>
              <dt>Items / Qty</dt><dd>{filled.length} / {qtyText(String(qtyTotal))}</dd>
              <dt>Gross</dt><dd>{fmt(gross)}</dd>
              <dt>Discount</dt><dd className={discount > 0 ? 'is-minus' : ''}>{discount > 0 ? `− ${fmt(discount)}` : fmt(0)}</dd>
              <dt>Charges</dt><dd>{fmt(chargesTotal)}</dd>
            </dl>
            <dl>
              <dt>Taxable</dt><dd>{fmt(taxable)}</dd>
              {interstate
                ? <><dt>IGST</dt><dd>{fmt(tax)}</dd></>
                : <><dt>CGST</dt><dd>{fmt(r2(tax / 2))}</dd><dt>SGST</dt><dd>{fmt(r2(tax - r2(tax / 2)))}</dd></>}
              {(cessOn || cessTotal > 0) && <><dt>Cess</dt><dd>{fmt(cessTotal)}</dd></>}
              <dt className="sb-tot-strong">Total GST</dt><dd className="sb-tot-strong">{fmt(r2(tax + cessTotal))}</dd>
              <dt><label className="sb-check"><input type="checkbox" checked={roundOff} onChange={(e) => setRoundOff(e.target.checked)} /> Round off</label></dt>
              <dd className={rounding ? 'sb-tot-round' : ''}>{signed(rounding)}</dd>
            </dl>
          </div>
          <div className="sb-net"><span>Net amount</span><b>{rupees(net)}</b></div>
          <p className="sb-words" title={amountInWords(net)}>{amountInWords(net)}</p>
          <p className="sb-taxnote">
            {interstate ? 'Inter-state supply — IGST' : 'Intra-state supply — CGST + SGST'}
            {companyState && placeOfSupply ? ` (${placeOfSupply} ${interstate ? '≠' : '='} company state)` : ''}
          </p>
          {!companyState && <p className="sb-warn">Company state is not set — GST is treated as intra-state. Set it in Settings → Company.</p>}
          {posMissing && <p className="error sb-error">Enter the place of supply — GST depends on it.</p>}
          {cessBad && <p className="error sb-error">A cess rate cannot be above 300%.</p>}
          {error && <p className="error sb-error">{error}</p>}
          {!transportOk && <p className="error sb-error">Check the vehicle / e-way bill number in More details.</p>}
          <div className="sb-save">
            <button type="button" className="btn" disabled={busy || !ready} onClick={saveDraft}>Save draft</button>
            {!inline && <button type="button" className="btn" onClick={onClose}>Cancel</button>}
            <button type="button" className="btn sb-save-btn" disabled={busy || !ready} onClick={saveBill}
              title="Save and post — the bill gets its number now">
              {busy ? 'Saving…' : 'Save bill'} <kbd>Ctrl+S</kbd>
            </button>
          </div>
        </section>
      </div>

      {/* Preview is the print layout itself — what the customer will get —
          marked DRAFT until the bill is saved. */}
      {previewing && <InvoicePrint inv={draft} onClose={() => setPreviewing(false)} />}
    </div>
  )

  if (inline) return bill
  return (
    <Dialog wide title={editing ? 'Edit draft bill' : copy ? 'New bill (copy)' : kind === 'proforma' ? 'New proforma bill' : 'New sale bill'} onClose={onClose}>
      {bill}
    </Dialog>
  )
}

/** Item name cell: type to search items by code or name, arrows and Enter to
 *  pick; anything typed that is not an item stays as free text. */
function ItemPicker({ value, items, onText, onPick, inputRef, manual }: {
  value: string
  items: Item[]
  onText: (text: string) => void
  onPick: (item: Item) => void
  inputRef: (el: HTMLInputElement | null) => void
  /** Manual entry: plain text, no lookup. */
  manual?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const q = value.trim().toLowerCase()
  const matches = manual ? [] : (q ? items.filter((i) => i.name.toLowerCase().includes(q) || i.code.toLowerCase().includes(q)) : items).slice(0, 8)
  function pick(item: Item) { onPick(item); setOpen(false) }
  return (
    <div className="sb-pick">
      <input ref={inputRef} value={value} placeholder={manual ? 'Type item / service description…' : 'Type item name or code…'}
        onChange={(e) => { onText(e.target.value); setOpen(true); setHi(0) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (!open || matches.length === 0) return
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, matches.length - 1)) }
          if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)) }
          if (e.key === 'Enter') { e.preventDefault(); pick(matches[hi]) }
          if (e.key === 'Escape') setOpen(false)
        }} />
      {open && matches.length > 0 && (
        <ul className="sb-pick-list" role="listbox">
          {matches.map((it, i) => (
            <li key={it.id} role="option" aria-selected={i === hi} className={i === hi ? 'is-hi' : ''}
              onMouseDown={(e) => { e.preventDefault(); pick(it) }} onMouseEnter={() => setHi(i)}>
              <span><b>{it.name}</b><small>{it.code}{it.hsn_sac ? ` · HSN ${it.hsn_sac}` : ''}</small></span>
              <span className="sb-pick-meta">
                {rupees(it.sale_price)}
                <small>{it.is_stocked ? `${qtyText(it.available_qty)} ${it.uom}` : it.item_type}</small>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Print straight from the list: load the full invoice, then the sheet. */
function PrintById({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery(`erp-invoice-${id}`, () => erp.invoice(id))
  if (q.error) return <Dialog title="Print" onClose={onClose}><div style={{ padding: 20 }}><ErrorNote>{erpError(q.cause, 'Could not load the invoice')}</ErrorNote></div></Dialog>
  if (!q.data) return null
  return <InvoicePrint inv={q.data} onClose={onClose} />
}

/** "10% + ₹100.00" — the bill discount as it was given, or null. */
function billDiscText(inv: Invoice): string | null {
  const pct = Number(inv.bill_discount_percent ?? 0)
  const amt = Number(inv.bill_discount_amount ?? 0)
  if (!pct && !amt) return null
  return [pct ? `${pct}%` : '', amt ? `− ${rupees(amt)}` : ''].filter(Boolean).join(' · ')
}

/** The invoice as a document — what the customer receives. */
function InvoiceDocument({ inv }: { inv: Invoice }) {
  const isTax = ['product', 'service', 'milestone'].includes(inv.kind)
  const discounted = inv.lines.some((l) => Number(l.discount_percent ?? 0) > 0 || Number(l.discount_amount ?? 0) > 0)
  return (
    <article className="inv-sheet inv-doc">
      <header className="inv-top">
        <div>
          <h2 className="inv-title">{INV_TITLE[inv.kind] ?? 'Invoice'}</h2>
          <ErpState value={inv.status} />
        </div>
        <dl className="inv-number">
          <dt>{inv.kind === 'credit_note' ? 'Credit note no.' : 'Invoice no.'}</dt>
          <dd>{inv.number ? <span className="inv-no">{inv.number}</span> : <span className="inv-pending">Assigned on posting</span>}</dd>
        </dl>
      </header>

      <div className="inv-parties">
        <div className="inv-billto">
          <span className="inv-cap">Bill to</span>
          <div className="inv-party">
            <b>{inv.customer_name}</b>
            {inv.billing_address && <span>{inv.billing_address}</span>}
            <span>GSTIN <span className="inv-mono">{inv.gstin || 'Unregistered'}</span></span>
          </div>
          {inv.shipping_address && (
            <div className="inv-party inv-shipto">
              <span className="inv-cap">Ship to</span>
              <span>{inv.shipping_address}</span>
            </div>
          )}
        </div>
        <dl className="inv-facts">
          <div><dt>Invoice date</dt><dd><DateText iso={inv.invoice_date} /></dd></div>
          <div><dt>Due date</dt><dd className={inv.days_overdue > 0 ? 'is-late' : ''}><DateText iso={inv.due_date} />{inv.days_overdue > 0 ? ` · ${inv.days_overdue}d overdue` : ''}</dd></div>
          <div><dt>Place of supply</dt><dd>{inv.place_of_supply || '—'}</dd></div>
          {inv.order_number && <div><dt>Sales order</dt><dd>{inv.order_number}</dd></div>}
          {inv.delivery_date && <div><dt>Delivery date</dt><dd><DateText iso={inv.delivery_date} /></dd></div>}
          {inv.customer_po_number && <div><dt>Customer PO</dt><dd>{inv.customer_po_number}</dd></div>}
          {inv.reverse_charge && <div><dt>Reverse charge</dt><dd>Yes</dd></div>}
          {inv.salesperson_name && <div><dt>Salesperson</dt><dd>{inv.salesperson_name}</dd></div>}
        </dl>
      </div>

      {(inv.dispatch_doc_number || inv.transporter_name || inv.vehicle_number || inv.eway_bill_number || inv.lr_number) && (
        <dl className="inv-transport">
          {inv.dispatch_doc_number && <div><dt>Dispatch doc.</dt><dd>{inv.dispatch_doc_number}</dd></div>}
          {inv.transporter_name && <div><dt>Transporter</dt><dd>{inv.transporter_name}</dd></div>}
          {inv.vehicle_number && <div><dt>Vehicle</dt><dd className="inv-mono">{inv.vehicle_number}</dd></div>}
          {inv.eway_bill_number && <div><dt>E-way bill</dt><dd className="inv-mono">{inv.eway_bill_number}</dd></div>}
          {inv.lr_number && <div><dt>LR no.</dt><dd>{inv.lr_number}</dd></div>}
        </dl>
      )}
      <div className="table-wrap inv-table">
        <table>
          <thead>
            <tr><th>#</th><th>Item &amp; description</th><th>HSN/SAC</th><th className="crm-num">Qty</th><th className="crm-num">Rate</th>
              {discounted && <th className="crm-num">Disc.</th>}
              <th className="crm-num">Taxable</th><th className="crm-num">GST</th><th className="crm-num">Amount</th></tr>
          </thead>
          <tbody>
            {inv.lines.map((l, i) => (
              <tr key={l.id}>
                <td className="inv-idx">{i + 1}</td>
                <td>{l.item_code && <span className="crm-code">{l.item_code}</span>} {l.description}</td>
                <td className="inv-mono">{l.hsn_sac || '—'}</td>
                <td className="crm-num">{qtyText(l.quantity)} {l.uom}{Number(l.free_qty ?? 0) > 0 && <small className="inv-free"> + {qtyText(l.free_qty!)} free</small>}</td>
                <td className="crm-num">{rupees(l.rate)}</td>
                {discounted && <td className="crm-num">{Number(l.discount_percent ?? 0) ? `${Number(l.discount_percent)}%` : Number(l.discount_amount ?? 0) ? rupees(l.discount_amount) : '—'}</td>}
                <td className="crm-num">{rupees(l.taxable_value)}</td>
                <td className="crm-num">{Number(l.gst_percent ?? 0)}%</td>
                <td className="crm-num">{rupees(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="inv-bottom">
        <div className="inv-notes">
          {(inv.recipient_bank || inv.payment_reference) && (
            <div className="inv-pay">
              <span className="inv-cap">Payment details</span>
              {inv.recipient_bank && (
                <dl>
                  <dt>Bank</dt><dd>{inv.recipient_bank.bank_name}{inv.recipient_bank.branch ? `, ${inv.recipient_bank.branch}` : ''}</dd>
                  {inv.recipient_bank.account_name && <><dt>A/c name</dt><dd>{inv.recipient_bank.account_name}</dd></>}
                  <dt>A/c no.</dt><dd className="inv-mono">{inv.recipient_bank.account_number}</dd>
                  {inv.recipient_bank.ifsc && <><dt>IFSC</dt><dd className="inv-mono">{inv.recipient_bank.ifsc}</dd></>}
                  {inv.recipient_bank.upi_id && <><dt>UPI</dt><dd>{inv.recipient_bank.upi_id}</dd></>}
                </dl>
              )}
              {inv.payment_reference && <p>Please quote <b className="inv-mono">{inv.payment_reference}</b> as the payment reference.</p>}
            </div>
          )}
          {inv.notes && <div><span className="inv-cap">Notes</span><p>{inv.notes}</p></div>}
          {inv.terms && <div><span className="inv-cap">Terms &amp; conditions</span><p>{inv.terms}</p></div>}
          <p className="inv-words"><span className="inv-cap">Amount in words</span>{amountInWords(Number(inv.grand_total))}</p>
        </div>
        <div className="inv-totals">
          {billDiscText(inv) && <div className="inv-disc"><span>Bill discount</span><span>{billDiscText(inv)}</span></div>}
          {Number(inv.additional_discount ?? 0) > 0 && (
            <div className="inv-disc"><span>Additional discount{inv.discount_reason ? ` (${inv.discount_reason})` : ''}</span><span>− {rupees(inv.additional_discount)}</span></div>
          )}
          <div><span>Taxable amount</span><span>{rupees(inv.sub_total)}</span></div>
          {inv.is_interstate
            ? <div><span>IGST</span><span>{rupees(inv.igst)}</span></div>
            : <><div><span>CGST</span><span>{rupees(inv.cgst)}</span></div><div><span>SGST</span><span>{rupees(inv.sgst)}</span></div></>}
          {Number(inv.round_off ?? 0) !== 0 && <div><span>Round off</span><span>{rupees(inv.round_off)}</span></div>}
          {Number(inv.cess_total ?? 0) > 0 && <div><span>Cess</span><span>{rupees(inv.cess_total)}</span></div>}
          <div><span>Total GST</span><span>{rupees(Number(inv.tax_total) + Number(inv.cess_total ?? 0))}</span></div>
          <div className="inv-grand"><span>Total</span><span>{rupees(inv.grand_total)}</span></div>
          {isTax && inv.status === 'posted' && <>
            {Number(inv.amount_received) > 0 && <div><span>Received</span><span>− {rupees(inv.amount_received)}</span></div>}
            {Number(inv.amount_credited) > 0 && <div><span>Credited</span><span>− {rupees(inv.amount_credited)}</span></div>}
            <div className={`inv-due${Number(inv.outstanding) > 0 ? '' : ' is-paid'}`}>
              <span>{Number(inv.outstanding) > 0 ? 'Balance due' : 'Paid in full'}</span><span>{rupees(inv.outstanding)}</span>
            </div>
          </>}
        </div>
      </div>
      {inv.created_by_name && (
        <footer className="inv-sign">
          Drafted by {inv.created_by_name}{(inv.posted_by_name ?? inv.reviewed_by_name) ? ` · Posted by ${inv.posted_by_name ?? inv.reviewed_by_name}` : ''}
        </footer>
      )}
    </article>
  )
}

/** "Rupees Twelve Thousand Three Hundred Only" — the Indian system, lakh and crore. */
function amountInWords(amount: number): string {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
    'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
  const two = (n: number) => (n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? ` ${ones[n % 10]}` : ''}`)
  const three = (n: number) => [n >= 100 ? `${ones[Math.floor(n / 100)]} Hundred` : '', n % 100 ? two(n % 100) : ''].filter(Boolean).join(' ')
  const words = (n: number): string => {
    if (n === 0) return 'Zero'
    const parts: string[] = []
    const crore = Math.floor(n / 1e7)
    if (crore) parts.push(`${words(crore)} Crore`)
    const lakh = Math.floor((n % 1e7) / 1e5)
    if (lakh) parts.push(`${two(lakh)} Lakh`)
    const thousand = Math.floor((n % 1e5) / 1e3)
    if (thousand) parts.push(`${two(thousand)} Thousand`)
    if (n % 1e3) parts.push(three(n % 1e3))
    return parts.join(' ')
  }
  const safe = Math.max(0, Math.round((Number.isFinite(amount) ? amount : 0) * 100))
  const rupeesPart = Math.floor(safe / 100)
  const paise = safe % 100
  return `Rupees ${words(rupeesPart)}${paise ? ` and ${two(paise)} Paise` : ''} Only`
}

/** One invoice, opened over the page in the centre: a toolbar with every
 *  action across the top, the invoice itself on the left, and its money —
 *  balance, payments, credit notes, who did what — down the right. */
function InvoiceDrawer({ id, onOpen, onClose, onChanged }: { id: string; onOpen: (id: string) => void; onClose: () => void; onChanged: () => void }) {
  const { can } = useAccess()
  const { user } = useAuth()
  const q = useQuery(`erp-invoice-${id}`, () => erp.invoice(id))
  const { busy, error, run } = useRun(() => { q.reload(); onChanged() })
  const [prompt, setPrompt] = useState<null | { title: string; hint?: string; act: (r: string) => Promise<unknown> }>(null)
  const [reversing, setReversing] = useState<InvoiceReceipt | null>(null)
  const [correcting, setCorrecting] = useState<InvoiceReceipt | null>(null)
  const [trail, setTrail] = useState<string | null>(null)
  const [paying, setPaying] = useState(false)
  const [crediting, setCrediting] = useState(false)
  const [printing, setPrinting] = useState(false)
  const [editing, setEditing] = useState<'edit' | 'copy' | null>(null)
  const nested = Boolean(prompt || paying || crediting || printing || editing)

  // Esc closes the view — unless a dialog opened from it is on top.
  const nestedRef = useRef(nested)
  nestedRef.current = nested
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !nestedRef.current) onClose() }
    window.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = previous }
  }, [onClose])

  const inv = q.data
  const biller = can('can_manage_billing')
  const approver = can('can_approve_billing')
  const admin = canAdminister(user)
  const siblings = useQuery('erp-inv-invoice-', () => erp.invoices({ kind: 'invoice' }))

  let body: ReactNode = <Loading />
  let tools: ReactNode = null
  let ident: ReactNode = <h2 className="ivv-no">Invoice</h2>
  if (inv) {
    const isTax = ['product', 'service', 'milestone'].includes(inv.kind)
    const draft = inv.status === 'draft'
    const st = payState(inv)
    const paidIn = Number(inv.amount_received) + Number(inv.amount_credited)
    const cancellable = inv.status === 'posted' && isTax && approver
    ident = (
      <>
        <span className="ivv-kind">{INV_TITLE[inv.kind] ?? 'Invoice'}</span>
        <h2 className="ivv-no">
          {inv.number ?? 'Draft'}
          <span className={`ivl-state is-${st}`}><i aria-hidden />{PAY_LABEL[st]}</span>
        </h2>
        <span className="ivv-sub">{inv.customer_name} · <DateText iso={inv.invoice_date} /> · {rupees(inv.grand_total)}</span>
      </>
    )
    tools = (
      <>
        <button className="btn btn-sm" onClick={() => setPrinting(true)}><IconPrinter size={14} /> Print</button>
        <button className="btn btn-sm" disabled={busy} onClick={() => void run(() => downloadInvoicePdf(inv), 'The PDF could not be made')}>
          <IconDownload size={14} /> PDF
        </button>
        {biller && inv.kind !== 'credit_note' && <button className="btn btn-sm" onClick={() => setEditing('copy')}><IconPlus size={14} /> Duplicate</button>}
        {biller && draft && editableKinds.includes(inv.kind) && <button className="btn btn-sm" onClick={() => setEditing('edit')}><IconEdit size={14} /> Edit</button>}

        {cancellable && (
          <button className="btn btn-sm ivv-danger" disabled={paidIn > 0}
            title={paidIn > 0 ? 'Money is received against it — raise a credit note instead' : 'A posted invoice is cancelled, not deleted — its number stays in the series'}
            onClick={() => setPrompt({ title: `Cancel ${inv.number}`, hint: 'The invoice stays on record marked Cancelled, and stops counting as owed.', act: (r) => erp.cancelInvoice(inv.id, r) })}>
            <IconClose size={14} /> Cancel invoice
          </button>
        )}
        {inv.kind !== 'credit_note' && (() => {
          const block = deleteBlock(inv, biller, admin)
          return (
            <button className="btn btn-sm ivv-danger" disabled={Boolean(block) || busy} title={block ?? 'Delete'}
              onClick={() => {
                const sure = draft
                  ? window.confirm('Delete this draft? It has no number yet and cannot be recovered.')
                  : confirmDeleteIssued(inv, isLatestNumber(inv, siblings.data ?? []))
                if (sure) void run(async () => { await erp.deleteInvoice(inv.id); onClose() })
              }}>
              <IconTrash size={14} /> Delete
            </button>
          )
        })()}
        <span className="ivv-sep" />
        {inv.status === 'submitted' && inv.kind === 'credit_note' && inv.created_by !== user?.id && (
          <DecideBar onDecide={async (a, n) => { await erp.decideCreditNote(inv.id, a, n); q.reload(); onChanged() }} />
        )}
        {inv.status === 'posted' && isTax && Number(inv.outstanding) > 0 && biller && <>
          <button className="btn btn-sm" onClick={() => setCrediting(true)}>Credit note</button>
          <button className="btn btn-sm btn-primary" onClick={() => setPaying(true)}><IconCard size={14} /> Record payment</button>
        </>}
        {draft && biller && (
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void run(() => erp.postInvoice(inv.id))}><IconCheck size={14} /> Post &amp; number</button>
        )}
      </>
    )
    body = (
      <>
        {error && <div className="ivv-note"><ErrorNote>{error}</ErrorNote></div>}
        {inv.cancel_reason && <div className="ivv-note"><Note>Cancelled: {inv.cancel_reason}</Note></div>}
        {inv.review_note && <div className="ivv-note"><Note>{inv.review_note}</Note></div>}
        {inv.original_invoice_id && <div className="ivv-note"><Note tone="ok">Credit against <a href="#" onClick={(e) => { e.preventDefault(); onOpen(inv.original_invoice_id!) }}>{inv.original_number}</a>{inv.reason ? ` — ${inv.reason}` : ''}</Note></div>}
        {draft && <div className="ivv-note"><Note>This is a draft — it has no number and is not owed yet. Post it to issue the invoice.</Note></div>}
        <div className="ivv-grid">
          <div className="ivv-doc">
            <ChainView steps={inv.chain} />
            <InvoiceDocument inv={inv} />
          </div>
          <aside className="ivv-side">
            {isTax && inv.status === 'posted' && (
              <section className="ivv-card">
                <h4>Payment</h4>
                <div className="ivv-due">
                  <span>Balance due</span>
                  <b className={Number(inv.outstanding) > 0 ? (inv.days_overdue > 0 ? 'is-bad' : 'is-warn') : 'is-good'}>{rupees(inv.outstanding)}</b>
                  {inv.days_overdue > 0 && <small className="is-bad">{inv.days_overdue} days overdue</small>}
                  {Number(inv.outstanding) <= 0 && <small className="is-good">Paid in full</small>}
                </div>
                <div className="ivd-meter" aria-hidden>
                  <span style={{ width: `${Math.min(100, paidIn / Math.max(1, Number(inv.grand_total)) * 100)}%` }} />
                </div>
                <dl className="ivv-dl">
                  <dt>Invoice total</dt><dd>{rupees(inv.grand_total)}</dd>
                  <dt>Received</dt><dd className="is-good">{rupees(inv.amount_received)}</dd>
                  {Number(inv.amount_credited) > 0 && <><dt>Credited</dt><dd>{rupees(inv.amount_credited)}</dd></>}
                  <dt>Due date</dt><dd><DateText iso={inv.due_date} /></dd>
                </dl>
                {Number(inv.outstanding) > 0 && biller && (
                  <button className="btn btn-primary ivv-wide" onClick={() => setPaying(true)}><IconCard size={14} /> Record payment</button>
                )}
              </section>
            )}
            <section className="ivv-card">
              <h4>Payments received</h4>
              {inv.receipts.length === 0 ? <p className="ivv-empty">No payments yet.</p> : (
                <ul className="ivv-list">
                  {inv.receipts.map((r) => (
                    <li key={r.id} className={r.status !== 'posted' ? 'is-rev' : ''}>
                      <div>
                        <b>{rupees(r.amount)}</b>
                        <small>{r.mode.toUpperCase()} · <DateText iso={r.received_on} />{Number(r.tds_amount) > 0 ? ` · TDS ${rupees(r.tds_amount)}` : ''}</small>
                        <small className="ivv-mono">{r.number}{r.reference ? ` · ${r.reference}` : ''}</small>
                        {r.deposit_account && <small>Into {r.deposit_account}</small>}
                        {r.notes && <small className="ivv-note">{r.notes}</small>}
                        <small className="ivv-by">Received by {r.created_by_name ?? '—'}{r.created_at ? ` · ${new Date(r.created_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}</small>
                        {(r.has_proof || (r.corrections?.length ?? 0) > 0 || (r.status === 'posted' && biller)) && (
                          <span className="ivv-rc-links">
                            {r.has_proof && <button type="button" onClick={() => void openProof(r.id)}>View proof</button>}
                            {r.status === 'posted' && biller && <button type="button" onClick={() => setCorrecting(r)}>Correct</button>}
                            {(r.corrections?.length ?? 0) > 0 && (
                              <button type="button" onClick={() => setTrail((t) => (t === r.id ? null : r.id))}>
                                {trail === r.id ? 'Hide' : 'Corrected'} ×{r.corrections!.length}
                              </button>
                            )}
                          </span>
                        )}
                        {trail === r.id && (
                          <ol className="ivv-trail">
                            {r.corrections!.map((c, k) => (
                              <li key={k}>
                                <b>{c.by_name}</b> · {new Date(c.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                                <em>“{c.reason}”</em>
                                {Object.entries(c.changes).map(([f, [o, n]]) => (
                                  <span key={f}>{FIELD_LABEL[f] ?? f}: <s>{showVal(o)}</s> → {showVal(n)}</span>
                                ))}
                              </li>
                            ))}
                          </ol>
                        )}
                        {r.status === 'reversed' && (
                          <small className="ivv-rev">
                            <span>Reversed{r.reversed_by_name ? ` by ${r.reversed_by_name}` : ''}{r.reversed_at ? <> on <DateText iso={r.reversed_at} /></> : ''}</span>
                            {r.reverse_reason ? <em>“{r.reverse_reason}”</em> : null}
                          </small>
                        )}
                      </div>
                      {r.status === 'posted' && approver
                        ? <button className="btn btn-sm" title="Reverse a payment recorded by mistake" onClick={() => setReversing(r)}>Reverse</button>
                        : <ErpState value={r.status} />}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {inv.credit_notes.length > 0 && (
              <section className="ivv-card">
                <h4>Credit notes</h4>
                <ul className="ivv-list">
                  {inv.credit_notes.map((c) => (
                    <li key={c.id} className={c.status === 'rejected' ? 'is-off' : ''}>
                      <div>
                        <a href="#" onClick={(e) => { e.preventDefault(); onOpen(c.id) }}>{c.number ?? 'Awaiting approval'}</a>
                        <small>{rupees(c.grand_total)}{c.invoice_date ? <> · <DateText iso={c.invoice_date} /></> : null}</small>
                        {c.reason && <small className="ivv-cn-why">{c.reason}{c.created_by_name ? ` · ${c.created_by_name}` : ''}</small>}
                      </div>
                      <ErpState value={c.status} />
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section className="ivv-card">
              <h4>Activity</h4>
              <ul className="ivv-steps">
                <li><i className="is-done" />Drafted{inv.created_by_name ? ` by ${inv.created_by_name}` : ''}</li>
                <li><i className={inv.status === 'draft' ? '' : 'is-done'} />{inv.status === 'draft' ? 'Not posted yet' : `Posted${(inv.posted_by_name ?? inv.reviewed_by_name) ? ` by ${inv.posted_by_name ?? inv.reviewed_by_name}` : ''}`}</li>
                {inv.receipts.map((r) => (
                  <Fragment key={r.id}>
                    <li><i className="is-done" /><span>{r.number}: received {rupees(r.amount)} on <DateText iso={r.received_on} />{r.created_by_name ? ` · ${r.created_by_name}` : ''}</span></li>
                    {r.status === 'reversed' && (
                      <li><i className="is-bad" /><span>{r.number} reversed{r.reversed_at ? <> on <DateText iso={r.reversed_at} /></> : ''}{r.reversed_by_name ? ` by ${r.reversed_by_name}` : ''}</span></li>
                    )}
                  </Fragment>
                ))}
                {inv.status === 'cancelled' && <li><i className="is-bad" />Cancelled</li>}
              </ul>
            </section>
          </aside>
        </div>
      </>
    )
  }

  return (
    <div className="ivv-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !nested && onClose()}>
      <div className="ivv" role="dialog" aria-modal="true" aria-label="Invoice">
        <header className="ivv-head">
          <div className="ivv-ident">{ident}</div>
          <div className="ivv-tools">{tools}</div>
          <button className="crm-icon-btn ivv-close" onClick={onClose} aria-label="Close"><IconClose size={16} /></button>
        </header>
        <div className="ivv-body">{body}</div>
      </div>
      {inv && correcting && <ReceiptCorrectForm receipt={correcting} onClose={() => setCorrecting(null)}
        onDone={() => { setCorrecting(null); q.reload(); onChanged() }} />}
      {inv && reversing && <ReversePaymentForm inv={inv} receipt={reversing} onClose={() => setReversing(null)}
        onDone={() => { setReversing(null); q.reload(); onChanged() }} />}
      {inv && paying && <ReceiptForm inv={inv} onClose={() => setPaying(false)} onDone={() => { setPaying(false); q.reload(); onChanged() }} />}
      {inv && printing && <InvoicePrint inv={inv} onClose={() => setPrinting(false)} />}
      {inv && crediting && <CreditNoteForm inv={inv} onClose={() => setCrediting(false)} onDone={(cn) => { setCrediting(false); onChanged(); onOpen(cn.id) }} />}
      {inv && editing && (
        <ManualInvoice invoice={inv} copy={editing === 'copy'} onClose={() => setEditing(null)}
          onSaved={(next) => { setEditing(null); onChanged(); onOpen(next.id) }} />
      )}
      {prompt && <ReasonDialog title={prompt.title} hint={prompt.hint} danger onClose={() => setPrompt(null)} onSubmit={async (r) => { await prompt.act(r); q.reload(); onChanged() }} />}
    </div>
  )
}

const PAY_MODES: Array<[string, string]> = [['neft', 'NEFT'], ['rtgs', 'RTGS'], ['upi', 'UPI'], ['cheque', 'Cheque'], ['cash', 'Cash'], ['other', 'Other']]

function ReceiptForm({ inv, onClose, onDone }: { inv: Invoice; onClose: () => void; onDone: () => void }) {
  const { user } = useAuth()
  const settings = useQuery('erp-settings', () => erp.settings())
  const banks = settings.data?.bank_accounts ?? []
  const [form, setForm] = useState({ amount: String(Number(inv.outstanding)), tds_amount: '', mode: 'neft', reference: '', received_on: todayISO(), notes: '', account: '' })
  const [proof, setProof] = useState<{ name: string; data: string } | null>(null)
  const [proofError, setProofError] = useState<string | null>(null)
  const { busy, error, run } = useRun()
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }))
  // The default bank account, or cash in hand for a cash receipt — until the user picks one.
  const [touchedAccount, setTouchedAccount] = useState(false)
  const defaultBank = banks.find((a) => a.is_default) ?? banks[0]
  const account = touchedAccount ? form.account : form.mode === 'cash' ? 'cash' : (defaultBank?.id ?? '')
  const settled = Number(form.amount || 0) + Number(form.tds_amount || 0)
  const after = Number(inv.outstanding) - settled
  const ready = settled > 0 && after >= -0.005 && !proofError
  const now = new Date().toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })
  return (
    <Dialog title="Record payment" subtitle={<>{inv.number} · {inv.customer_name}</>} onClose={onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        <span className="crm-push" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !ready} onClick={() => void run(async () => {
          await erp.recordReceipt({
            invoice_id: inv.id, amount: form.amount, tds_amount: form.tds_amount || '0', mode: form.mode, reference: form.reference || null,
            received_on: form.received_on || null, notes: form.notes || null, deposit_account_id: account || null,
            proof: proof?.data ?? null, proof_name: proof?.name ?? null,
          }); onDone()
        })}><IconCheck size={14} /> {busy ? 'Saving…' : 'Record payment'}</button>
      </>
    }>
      <div className="rcp">
        <div className="rcp-sum">
          <div><span>Invoice total</span><b>{rupees(inv.grand_total)}</b></div>
          <div><span>Already received</span><b>{rupees(Number(inv.amount_received) + Number(inv.amount_credited))}</b></div>
          <div><span>Balance due</span><b className="is-warn">{rupees(inv.outstanding)}</b></div>
        </div>
        <div className="rcp-grid">
          <label><span>Amount received <b className="rcp-req">*</b></span>
            <span className="itf-affix"><i>₹</i><input inputMode="decimal" value={form.amount} onChange={(e) => set('amount', e.target.value)} autoFocus /></span></label>
          <label><span>TDS deducted</span>
            <span className="itf-affix"><i>₹</i><input inputMode="decimal" value={form.tds_amount} placeholder="0" onChange={(e) => set('tds_amount', e.target.value)} /></span></label>
          <label><span>Received on</span>
            <input type="date" value={form.received_on} max={todayISO()} onChange={(e) => set('received_on', e.target.value)} /></label>
          <label><span>Reference / UTR / cheque no.</span>
            <input value={form.reference} onChange={(e) => set('reference', e.target.value)} placeholder="e.g. UTR 4126 8813 2201" /></label>
          <div className="rcp-modes">
            <span>Mode</span>
            <div>
              {PAY_MODES.map(([key, label]) => (
                <button key={key} type="button" className={form.mode === key ? 'is-on' : ''} onClick={() => set('mode', key)}>{label}</button>
              ))}
            </div>
          </div>
          <label><span>Deposited to (payment account)</span>
            <select value={account} onChange={(e) => { setTouchedAccount(true); set('account', e.target.value) }}>
              <option value="">— Not specified —</option>
              {banks.map((a) => <option key={a.id} value={a.id}>{a.label || a.bank_name} · {a.bank_name} ••{a.account_number.slice(-4)}</option>)}
              <option value="cash">Cash in hand</option>
            </select>
            {settings.data && banks.length === 0 && <small className="rcp-hint">Add bank accounts in ERP Settings to pick them here.</small>}
          </label>
          <ProofPicker value={proof} error={proofError} onChange={(p, err) => { setProof(p); setProofError(err) }} />
          <label className="rcp-wide"><span>Notes</span>
            <textarea rows={2} value={form.notes} maxLength={1000} onChange={(e) => set('notes', e.target.value)}
              placeholder="e.g. Part payment against first milestone; balance promised by 15th" /></label>
        </div>
        <div className={`rcp-after${after < -0.005 ? ' is-bad' : after <= 0.005 ? ' is-good' : ''}`}>
          {after < -0.005 ? `That is ${rupees(-after)} more than is due.`
            : after <= 0.005 ? 'This settles the invoice in full — it will be marked Paid.'
              : `Invoice will be marked Partly paid · balance after this payment ${rupees(after)}`}
        </div>
        <div className="rcp-meta">Received by <b>{user?.full_name ?? 'you'}</b> · recorded {now} — captured automatically</div>
      </div>
    </Dialog>
  )
}

const REVERSE_REASONS = ['Recorded by mistake', 'Recorded against the wrong invoice', 'Wrong amount entered', 'Duplicate entry', 'Cheque bounced']

/** Take back a payment recorded by mistake. The receipt is not deleted: it is
 *  marked reversed with the reason, and the invoice owes that money again. */
function ReversePaymentForm({ inv, receipt: r, onClose, onDone }: {
  inv: Invoice; receipt: InvoiceReceipt; onClose: () => void; onDone: () => void
}) {
  const [reason, setReason] = useState('')
  const { busy, error, run } = useRun()
  const settled = Number(r.amount) + Number(r.tds_amount)
  const after = Number(inv.outstanding) + settled
  const received = Number(inv.amount_received) + Number(inv.amount_credited) - settled
  const status = after <= 0.005 ? 'Paid' : received > 0.005 ? 'Partly paid' : inv.days_overdue > 0 ? 'Overdue' : 'Unpaid'
  return (
    <Dialog title={`Reverse payment ${r.number}`} subtitle={<>{inv.number} · {inv.customer_name}</>} onClose={onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        <span className="crm-push" />
        <button className="btn" onClick={onClose}>Back</button>
        <button className="btn btn-danger rcp-danger" disabled={busy || !reason.trim()} onClick={() => void run(async () => {
          await erp.reverseReceipt(r.id, reason.trim()); onDone()
        }, 'The payment could not be reversed')}>{busy ? 'Reversing…' : 'Reverse payment'}</button>
      </>
    }>
      <div className="rcp">
        <div className="rcp-rev">
          <div><span>Receipt</span><b className="ivv-mono">{r.number}</b></div>
          <div><span>Received on</span><b><DateText iso={r.received_on} /></b></div>
          <div><span>Mode</span><b>{r.mode.toUpperCase()}</b></div>
          <div><span>Amount</span><b>{rupees(r.amount)}</b></div>
          {Number(r.tds_amount) > 0 && <div><span>TDS</span><b>{rupees(r.tds_amount)}</b></div>}
          {r.reference && <div className="is-wide"><span>Reference</span><b>{r.reference}</b></div>}
        </div>
        <div className="rcp-sum">
          <div><span>Balance due now</span><b>{rupees(inv.outstanding)}</b></div>
          <div><span>Restored</span><b className="is-warn">+ {rupees(settled)}</b></div>
          <div><span>Balance after</span><b className="is-warn">{rupees(after)}</b></div>
        </div>
        <div className="rcp-grid">
          <label style={{ gridColumn: '1 / -1' }}><span>Reason for reversal <b className="rcp-req">*</b></span>
            <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus
              placeholder="Why is this payment being taken back?" /></label>
          <div className="rcp-modes">
            <div>
              {REVERSE_REASONS.map((x) => (
                <button key={x} type="button" className={reason === x ? 'is-on' : ''} onClick={() => setReason(x)}>{x}</button>
              ))}
            </div>
          </div>
        </div>
        <div className="rcp-after is-bad">
          The invoice will show {status} again. {r.number} stays in the payment history marked Reversed, with your name, the date and this reason — it is not deleted.
        </div>
      </div>
    </Dialog>
  )
}

interface AdjLine { key: string; item_id: string; description: string; hsn_sac: string; uom: string; quantity: string; rate: string; gst_percent: string }
const blankAdj = (): AdjLine => ({ key: Math.random().toString(36).slice(2), item_id: '', description: '', hsn_sac: '', uom: 'Nos', quantity: '1', rate: '', gst_percent: '18' })

const RETURN_REASONS = ['Damaged goods', 'Wrong item supplied', 'Quality issue', 'Short supply', 'Customer returned', 'Order cancelled']

/** A credit note against a posted invoice. Usually goods come back: pick the
 *  lines, say how many, and the credit is priced from the invoice itself —
 *  same rate, discounts and GST. Anything else (a rate difference, an
 *  allowance) goes in as an adjustment line. An approver posts it, and only
 *  then does it get its CN number. */
const PROOF_MAX = 2 * 1024 * 1024

/** Payment proof: a screenshot, a photo of the cheque, a bank advice PDF. */
function ProofPicker({ value, error, onChange, label = 'Payment proof' }: {
  value: { name: string; data: string } | null; error: string | null
  onChange: (v: { name: string; data: string } | null, error: string | null) => void; label?: string
}) {
  const input = useRef<HTMLInputElement>(null)
  function pick(file?: File) {
    if (!file) return
    if (!/^image\/|^application\/pdf$/.test(file.type)) { onChange(null, 'Choose a picture or a PDF.'); return }
    if (file.size > PROOF_MAX) { onChange(null, 'The file is larger than 2 MB.'); return }
    const reader = new FileReader()
    reader.onload = () => onChange({ name: file.name, data: String(reader.result) }, null)
    reader.readAsDataURL(file)
  }
  return (
    <div className="rcp-proof">
      <span>{label}</span>
      {value ? (
        <div className="rcp-file">
          <span className="rcp-file-ic" aria-hidden><IconSheet size={14} /></span>
          <b title={value.name}>{value.name}</b>
          <button type="button" className="crm-icon-btn" aria-label="Remove proof" onClick={() => onChange(null, null)}><IconClose size={12} /></button>
        </div>
      ) : (
        <button type="button" className={`rcp-drop${error ? ' is-bad' : ''}`} onClick={() => input.current?.click()}
          onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer.files[0]) }}>
          <IconPlus size={13} /> Upload screenshot / PDF <small>max 2 MB</small>
        </button>
      )}
      {error && <small className="rcp-err">{error}</small>}
      <input ref={input} type="file" accept="image/*,application/pdf" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = '' }} />
    </div>
  )
}

/** Open a receipt's proof in a new tab (a blob URL — browsers refuse data: URLs there). */
async function openProof(id: string) {
  const { data } = await erp.receiptProof(id)
  const blob = await (await fetch(data)).blob()
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank', 'noopener')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

const FIELD_LABEL: Record<string, string> = {
  mode: 'Mode', reference: 'Reference', notes: 'Notes', deposit_account: 'Account', proof: 'Proof',
}
const showVal = (v: unknown) => (v == null || v === '' ? '—' : String(v))

/** Correct a receipt's details. The money is not editable here — a wrong
 *  amount is reversed and recorded again. A reason is required and kept. */
function ReceiptCorrectForm({ receipt: r, onClose, onDone }: { receipt: InvoiceReceipt; onClose: () => void; onDone: () => void }) {
  const settings = useQuery('erp-settings', () => erp.settings())
  const banks = settings.data?.bank_accounts ?? []
  const [form, setForm] = useState({ mode: r.mode, reference: r.reference ?? '', notes: r.notes ?? '', account: r.deposit_account_id ?? '', reason: '' })
  const [proof, setProof] = useState<{ name: string; data: string } | null>(null)
  const [proofError, setProofError] = useState<string | null>(null)
  const [removeProof, setRemoveProof] = useState(false)
  const { busy, error, run } = useRun()
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }))
  return (
    <Dialog title={`Correct ${r.number}`} subtitle={<>{rupees(r.amount)} · {r.mode.toUpperCase()} · <DateText iso={r.received_on} /></>} onClose={onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        <span className="crm-push" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || form.reason.trim().length < 3 || Boolean(proofError)} onClick={() => void run(async () => {
          await erp.correctReceipt(r.id, {
            reason: form.reason.trim(), mode: form.mode, reference: form.reference, notes: form.notes,
            deposit_account_id: form.account || null, ...(proof ? { proof: proof.data, proof_name: proof.name } : {}),
            remove_proof: removeProof && !proof,
          }); onDone()
        }, 'The correction could not be saved')}><IconCheck size={14} /> {busy ? 'Saving…' : 'Save correction'}</button>
      </>
    }>
      <div className="rcp">
        <div className="rcp-after">The amount, TDS and date are not changed here. If the amount is wrong, reverse this payment and record it again.</div>
        <div className="rcp-grid">
          <div className="rcp-modes">
            <span>Mode</span>
            <div>{PAY_MODES.map(([key, label]) => (
              <button key={key} type="button" className={form.mode === key ? 'is-on' : ''} onClick={() => set('mode', key)}>{label}</button>
            ))}</div>
          </div>
          <label><span>Reference / UTR / cheque no.</span><input value={form.reference} onChange={(e) => set('reference', e.target.value)} /></label>
          <label><span>Deposited to</span>
            <select value={form.account} onChange={(e) => set('account', e.target.value)}>
              <option value="">— Not specified —</option>
              {banks.map((a) => <option key={a.id} value={a.id}>{a.label || a.bank_name} · {a.bank_name} ••{a.account_number.slice(-4)}</option>)}
              <option value="cash">Cash in hand</option>
            </select></label>
          {r.has_proof && !proof ? (
            <div className="rcp-proof">
              <span>Payment proof</span>
              <div className="rcp-file">
                <span className="rcp-file-ic" aria-hidden><IconSheet size={14} /></span>
                <b className={removeProof ? 'is-gone' : ''}>{r.proof_name ?? 'Attached'}</b>
                <button type="button" className="btn btn-sm" onClick={() => setRemoveProof((x) => !x)}>{removeProof ? 'Keep' : 'Remove'}</button>
              </div>
              {!removeProof && <button type="button" className="rcp-link" onClick={() => setProof({ name: '', data: '' })}>Replace with another file</button>}
            </div>
          ) : (
            <ProofPicker label={r.has_proof ? 'Replace proof' : 'Payment proof'} value={proof?.data ? proof : null} error={proofError}
              onChange={(p, err) => { setProof(p); setProofError(err) }} />
          )}
          <label className="rcp-wide"><span>Notes</span><textarea rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} /></label>
          <label className="rcp-wide"><span>Reason for correction <b className="rcp-req">*</b></span>
            <input value={form.reason} maxLength={300} onChange={(e) => set('reason', e.target.value)} placeholder="e.g. Wrong UTR typed" autoFocus /></label>
        </div>
      </div>
    </Dialog>
  )
}

function CreditNoteForm({ inv, onClose, onDone }: { inv: Invoice; onClose: () => void; onDone: (cn: Invoice) => void }) {
  const items = useItems()
  const [mode, setMode] = useState<'return' | 'adjust'>('return')
  const [reason, setReason] = useState('')
  const [date, setDate] = useState(todayISO())
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [adj, setAdj] = useState<AdjLine[]>([blankAdj()])
  const adjEnd = useRef<HTMLDivElement>(null)
  const next = useQuery(`cn-next-${date}`, () => erp.nextInvoiceNumber('credit_note', date))
  const { busy, error, run } = useRun()
  const pending = inv.credit_notes.filter((c) => c.status === 'submitted').reduce((t, c) => t + Number(c.grand_total), 0)
  const room = r2(Number(inv.outstanding) - pending)

  // Each invoice line: sold, already returned, still returnable, and what this return credits.
  const rows = inv.lines.map((l) => {
    const sold = Number(l.quantity)
    const back = inv.returned?.[l.id]
    const backQty = Number(back?.quantity ?? 0)
    const left = Math.max(0, Math.round((sold - backQty) * 1000) / 1000)
    const raw = picked[l.id]
    const on = raw !== undefined
    const q = on ? Number(raw || 0) : 0
    const bad = on && (!(q > 0) || q > left + 1e-9)
    const taxable = !on || bad || sold <= 0 ? 0
      : Math.abs(q - left) < 1e-9 ? r2(Number(l.taxable_value ?? 0) - Number(back?.taxable_value ?? 0))
        : r2(Number(l.taxable_value ?? 0) * q / sold)
    const gst = r2(taxable * Number(l.gst_percent ?? 0) / 100)
    const cess = r2(taxable * Number(l.cess_percent ?? 0) / 100)
    return { l, sold, backQty, left, on, q, bad, taxable, gst, cess, total: r2(taxable + gst + cess) }
  })
  const chosen = rows.filter((r) => r.on)
  // Adjustment lines: quantity × rate, GST on top — the same per-line rounding as the server.
  const adjRows = adj.map((a) => {
    const taxable = r2(Number(a.quantity || 0) * Number(a.rate || 0))
    const gst = r2(taxable * Number(a.gst_percent || 0) / 100)
    return { a, taxable, gst, total: r2(taxable + gst), filled: Boolean(a.description.trim()) && taxable > 0 }
  })
  const adjFilled = adjRows.filter((r) => r.filled)
  const live = mode === 'return' ? chosen : adjFilled
  const taxable = r2(live.reduce((t, r) => t + r.taxable, 0))
  const gst = r2(live.reduce((t, r) => t + r.gst, 0))
  const cess = mode === 'return' ? r2(chosen.reduce((t, r) => t + r.cess, 0)) : 0
  const total = r2(taxable + gst + cess)
  const half = r2(gst / 2)
  const anyBad = mode === 'return' && chosen.some((r) => r.bad)
  const setA = (key: string, patch: Partial<AdjLine>) => setAdj((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x)))
  const addA = () => {
    setAdj((xs) => [...xs, blankAdj()])
    setTimeout(() => adjEnd.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 30)
  }
  const pickItem = (key: string, id: string) => {
    const it = (items.data ?? []).find((x) => x.id === id)
    setA(key, it ? { item_id: id, description: it.name, hsn_sac: it.hsn_sac ?? '', uom: it.uom, rate: String(Number(it.sale_price)), gst_percent: String(Number(it.gst_percent)) }
      : { item_id: '' })
  }
  const over = total > room + 0.005
  const toggle = (id: string, left: number) => setPicked((p) => {
    const n = { ...p }
    if (id in n) delete n[id]
    else n[id] = String(left)
    return n
  })
  const ready = Boolean(reason.trim()) && !busy && !anyBad && !over && total > 0
    && (mode === 'adjust' ? adjFilled.length > 0 : chosen.length > 0)

  function submit() {
    void run(async () => onDone(await erp.createCreditNote({
      original_invoice_id: inv.id, reason: reason.trim(), invoice_date: date || null,
      ...(mode === 'return'
        ? { returns: chosen.map((r) => ({ source_line_id: r.l.id, quantity: String(r.q) })) }
        : { lines: adjFilled.map(({ a }) => ({
          item_id: a.item_id || null, description: a.description.trim(), hsn_sac: a.hsn_sac.trim() || null, uom: a.uom || 'Nos',
          quantity: a.quantity, rate: a.rate, gst_percent: a.gst_percent,
        })) }),
    })), 'The credit note could not be raised')
  }

  return (
    <Dialog wide title={`Credit note against ${inv.number}`}
      subtitle={<>{inv.customer_name} · invoice total {rupees(inv.grand_total)} · open {rupees(inv.outstanding)}</>} onClose={onClose} footer={
        <>
          {error && <span className="error">{error}</span>}
          <span className="crm-push" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!ready} onClick={submit}>
            <IconCheck size={14} /> {busy ? 'Submitting…' : 'Submit for approval'}
          </button>
        </>
      }>
      <div className="cnf">
        <div className="cnf-head">
          <div className="cnf-modes" role="tablist">
            <button type="button" role="tab" aria-selected={mode === 'return'} className={mode === 'return' ? 'is-on' : ''} onClick={() => setMode('return')}>Returned items</button>
            <button type="button" role="tab" aria-selected={mode === 'adjust'} className={mode === 'adjust' ? 'is-on' : ''} onClick={() => setMode('adjust')}>Other adjustment</button>
          </div>
          <label className="cnf-date"><span>Credit note date</span>
            <input type="date" value={date} min={inv.invoice_date} max={todayISO()} onChange={(e) => setDate(e.target.value)} /></label>
          <div className="cnf-no">
            <span>Credit note no.</span>
            <b>{next.data?.number ?? '…'}</b>
            <small>given on approval</small>
          </div>
        </div>

        {mode === 'return' ? (
          <div className="cnf-table">
            <table>
              <thead>
                <tr>
                  <th className="cnf-c-pick" /><th>Item</th><th className="crm-num">Sold</th><th className="crm-num">Returned</th>
                  <th className="cnf-c-qty">Return qty</th><th className="crm-num">Rate</th><th className="crm-num">GST</th>
                  <th className="crm-num">Taxable</th><th className="crm-num">GST amt</th><th className="crm-num">Credit</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.l.id} className={`${r.on ? 'is-on' : ''}${r.left <= 0 ? ' is-done' : ''}`}>
                    <td className="cnf-c-pick">
                      <input type="checkbox" checked={r.on} disabled={r.left <= 0} aria-label={`Return ${r.l.description}`}
                        onChange={() => toggle(r.l.id, r.left)} />
                    </td>
                    <td>
                      <div className="cnf-item">{r.l.description}</div>
                      <small className="crm-sub">{r.l.hsn_sac ? `HSN ${r.l.hsn_sac}` : ''}{r.left <= 0 ? (r.l.hsn_sac ? ' · ' : '') + 'Fully returned' : ''}</small>
                    </td>
                    <td className="crm-num">{qtyText(r.l.quantity)} <small className="crm-sub">{r.l.uom}</small></td>
                    <td className="crm-num">{r.backQty > 0 ? qtyText(String(r.backQty)) : '—'}</td>
                    <td className="cnf-c-qty">
                      {r.on ? (
                        <span className={`cnf-qty${r.bad ? ' is-bad' : ''}`}>
                          <input inputMode="decimal" value={picked[r.l.id]} aria-label={`Return quantity for ${r.l.description}`}
                            onChange={(e) => setPicked((p) => ({ ...p, [r.l.id]: e.target.value }))} />
                          <small>of {qtyText(String(r.left))}</small>
                        </span>
                      ) : <small className="crm-sub">{r.left > 0 ? `up to ${qtyText(String(r.left))}` : '—'}</small>}
                    </td>
                    <td className="crm-num">{rupees(r.l.rate ?? '0')}</td>
                    <td className="crm-num">{Number(r.l.gst_percent ?? 0)}%</td>
                    <td className="crm-num">{r.on ? rupees(r.taxable) : '—'}</td>
                    <td className="crm-num">{r.on ? rupees(r2(r.gst + r.cess)) : '—'}</td>
                    <td className="crm-num crm-strong">{r.on ? rupees(r.total) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="cnf-adjust">
            <div className="cnf-table cnf-adj">
              <table>
                <thead>
                  <tr>
                    <th className="cnf-c-no">#</th><th className="cnf-c-item">Item (optional)</th><th>Description</th><th className="cnf-c-hsn">HSN/SAC</th>
                    <th className="cnf-c-n">Qty</th><th className="cnf-c-r">Rate</th><th className="cnf-c-g">GST</th>
                    <th className="crm-num">Taxable</th><th className="crm-num">Amount</th><th className="cnf-c-x" />
                  </tr>
                </thead>
                <tbody>
                  {adjRows.map(({ a, taxable: tv, total: tt }, n) => (
                    <tr key={a.key}>
                      <td className="cnf-c-no">{n + 1}</td>
                      <td className="cnf-c-item">
                        <select value={a.item_id} onChange={(e) => pickItem(a.key, e.target.value)} aria-label={`Item, line ${n + 1}`}>
                          <option value="">— None —</option>
                          {(items.data ?? []).filter((it) => it.can_be_sold !== false).map((it) => <option key={it.id} value={it.id}>{it.code} · {it.name}</option>)}
                        </select>
                      </td>
                      <td><input value={a.description} onChange={(e) => setA(a.key, { description: e.target.value })}
                        placeholder="e.g. Rate difference on CAM-2MP-BL" aria-label={`Description, line ${n + 1}`} /></td>
                      <td className="cnf-c-hsn"><input value={a.hsn_sac} onChange={(e) => setA(a.key, { hsn_sac: e.target.value })} aria-label={`HSN, line ${n + 1}`} /></td>
                      <td className="cnf-c-n"><input inputMode="decimal" value={a.quantity} onChange={(e) => setA(a.key, { quantity: e.target.value })} aria-label={`Quantity, line ${n + 1}`} /></td>
                      <td className="cnf-c-r"><input inputMode="decimal" value={a.rate} onChange={(e) => setA(a.key, { rate: e.target.value })} aria-label={`Rate, line ${n + 1}`} /></td>
                      <td className="cnf-c-g">
                        <select value={String(Number(a.gst_percent))} onChange={(e) => setA(a.key, { gst_percent: e.target.value })} aria-label={`GST, line ${n + 1}`}>
                          {['0', '5', '12', '18', '28'].map((g) => <option key={g} value={g}>{g}%</option>)}
                        </select>
                      </td>
                      <td className="crm-num">{tv > 0 ? rupees(tv) : '—'}</td>
                      <td className="crm-num crm-strong">{tt > 0 ? rupees(tt) : '—'}</td>
                      <td className="cnf-c-x">
                        <button type="button" className="crm-icon-btn crm-icon-danger" disabled={adj.length === 1} title="Remove line"
                          aria-label={`Remove line ${n + 1}`} onClick={() => setAdj((xs) => xs.filter((x) => x.key !== a.key))}><IconTrash size={13} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div ref={adjEnd} />
            </div>
            <div className="cnf-adj-bar">
              <button type="button" className="btn btn-sm" onClick={addA}><IconPlus size={13} /> Add line</button>
              <span className="cnf-hint">For a rate difference or an allowance — not goods coming back. Use Returned items for those.</span>
            </div>
          </div>
        )}

        <div className="cnf-foot">
          <div className="cnf-reason">
            <label><span>Reason for credit note <b className="rcp-req">*</b></span>
              <input value={reason} maxLength={120} onChange={(e) => setReason(e.target.value)} placeholder="Why is the customer being credited?" /></label>
            <div className="rcp-modes"><div>
              {RETURN_REASONS.map((x) => (
                <button key={x} type="button" className={reason === x ? 'is-on' : ''} onClick={() => setReason(x)}>{x}</button>
              ))}
            </div></div>
          </div>
          {(
            <dl className="cnf-sum">
              <dt>Taxable value</dt><dd>{rupees(taxable)}</dd>
              {inv.is_interstate
                ? <><dt>IGST</dt><dd>{rupees(gst)}</dd></>
                : <><dt>CGST</dt><dd>{rupees(half)}</dd><dt>SGST</dt><dd>{rupees(r2(gst - half))}</dd></>}
              {cess > 0 && <><dt>Cess</dt><dd>{rupees(cess)}</dd></>}
              <dt className="cnf-total">Credit note total</dt><dd className="cnf-total">{rupees(total)}</dd>
              <dt>Invoice balance after</dt><dd className={over ? 'is-bad' : ''}>{rupees(r2(Number(inv.outstanding) - total))}</dd>
            </dl>
          )}
        </div>
        {mode === 'return' && anyBad && <p className="cnf-warn">A return quantity must be more than 0 and no more than what is left to return.</p>}
        {over && (
          <p className="cnf-warn">
            The credit is more than the {rupees(room)} still open on {inv.number}
            {pending > 0 ? ` (${rupees(pending)} is on credit notes awaiting approval)` : ''}.
          </p>
        )}
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
          <thead><tr><th>Receipt</th><th>Invoice</th><th>Customer</th><th>Date</th><th>Mode</th><th className="crm-num">Amount</th><th className="crm-num">TDS</th><th>Status</th><th>Reversal</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id} className={r.status === 'reversed' ? 'rcl-rev' : undefined}>
              <td className="crm-strong">{r.number}{r.created_by_name ? <div className="crm-sub">by {r.created_by_name}</div> : null}</td>
              <td>{r.invoice}</td><td>{r.customer}</td><td><DateText iso={r.received_on} /></td>
              <td>{r.mode.toUpperCase()}{r.reference ? <div className="crm-sub">{r.reference}</div> : null}</td>
              <td className="crm-num rcl-amt">{rupees(r.amount)}</td><td className="crm-num rcl-amt">{rupees(r.tds_amount)}</td><td><ErpState value={r.status} /></td>
              <td className="rcl-why">{r.status === 'reversed' ? (
                <>{r.reverse_reason ?? '—'}<div className="crm-sub">{r.reversed_at ? <DateText iso={r.reversed_at} /> : null}{r.reversed_by_name ? ` · ${r.reversed_by_name}` : ''}</div></>
              ) : '—'}</td>
            </tr>
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
