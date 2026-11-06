/* Sales orders and dispatch — the customer's PO, booked, released, shipped.
 *
 * The usual way in is "From quotation": an accepted CRM quotation becomes a
 * draft order line for line. When the order's value differs from that
 * quotation (or from the customer's PO value) it is flagged as a deviation and
 * cannot be submitted without saying why. */

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '../../lib/useQuery'
import { useAuth } from '../../lib/auth'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { downloadCsv, downloadXlsx } from '../../lib/sheet'
import {
  IconCard, IconCheck, IconChevronDown, IconClose, IconDownload, IconEdit, IconMail, IconMore, IconPlus, IconPrinter, IconSearch, IconSheet, IconSliders, IconTrash,
} from '../../components/Icons'
import { crm, todayISO } from '../crm/api'
import { CrmPage, OwnerSelect } from '../crm/parts'
import { DATE_RANGES, rangeDates, type DateRange } from './ErpBilling'
import { blankPoLine, PO_UNITS, PoSummary, priceLine, type PoLine } from './ErpPurchaseOrders'
import DispatchChallan from './DispatchChallan'
import SalesOrderPrint, { DELIVERY_MODES, downloadSalesOrderPdf, FREIGHT_TERMS, salesOrderPdfBase64 } from './SalesOrderPrint'
import { erp, erpError, qtyText, rupees, type Item, type SalesOrder, type SalesOrderDetail, type SalesOrderQuery } from './api'
import { asUTC, dateTime } from '../../lib/format'
import '../../styles/so-view.css'
import '../../styles/so-form.css'
import {
  DateText, DecideBar, Dialog, ErpState, Field, label,
  LinesTable, Money, Note, ReasonDialog, SearchSelect, useAccess, useItems, useRun, type PickOption,
} from './parts'

const FILTERS = [
  { key: '', label: 'All' }, { key: 'draft', label: 'Draft' }, { key: 'submitted', label: 'Awaiting release' },
  { key: 'open', label: 'Open' }, { key: 'dispatched', label: 'Dispatched' }, { key: 'closed', label: 'Closed' },
  { key: 'rejected', label: 'Rejected' }, { key: 'cancelled', label: 'Cancelled' },
]
const APPROVAL: Record<SalesOrder['approval_status'], [string, string]> = {
  not_submitted: ['Not submitted', 'idle'], pending: ['Pending', 'warn'], approved: ['Approved', 'good'],
  rejected: ['Rejected', 'bad'], cancelled: ['Cancelled', 'idle'],
}
const DELIVERY: Record<SalesOrder['delivery_status'], [string, string]> = {
  not_applicable: ['N/A', 'idle'], pending: ['Pending', 'idle'], partial: ['Partial', 'warn'],
  in_transit: ['In transit', 'warn'], delivered: ['Delivered', 'good'],
}
const PAGE_SIZES = [10, 25, 50, 100]
/** Text reads best A to Z first; dates and money, newest and largest first. */
const ASC_FIRST = ['number', 'customer', 'approval', 'delivery']

function SortTh({ col, sort, dir, onSort, num, className, children }: {
  col: string; sort: string; dir: 'asc' | 'desc'; onSort: (col: string) => void; num?: boolean; className?: string; children: ReactNode
}) {
  const on = sort === col
  return (
    <th className={`${num ? 'crm-num ' : ''}${className ?? ''}`} aria-sort={on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className={`sol-sort${on ? ' is-on' : ''}`} onClick={() => onSort(col)}>
        {children}<i aria-hidden>{on ? (dir === 'asc' ? '▲' : '▼') : '↕'}</i>
      </button>
    </th>
  )
}

/** Page numbers around the current one, with the ends always reachable. */
function pageWindow(page: number, pages: number): number[] {
  const near = new Set([1, pages, page - 1, page, page + 1])
  return [...near].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b)
}
const approvalText = (so: SalesOrder) =>
  `${APPROVAL[so.approval_status][0]}${so.approval_level ? ` · L${so.approval_level}` : ''}`

/** Every column, the amounts as numbers, for whoever takes the list to Excel. */
function orderSheet(rows: SalesOrder[]) {
  const n = (v: string | null | undefined) => Number(v ?? 0)
  const header = ['Sales order no.', 'Order date', 'Delivery date', 'Customer', 'GSTIN', 'Customer PO', 'Quotation', 'Order type', 'Priority',
    'Salesperson', 'Order value', 'Invoiced amount', 'Pending amount', 'Approval status', 'Delivery status', 'Status']
  const data = rows.map((o) => [
    o.number, o.order_date, o.required_by ?? '', o.customer_name, o.customer_gstin ?? '', o.customer_po_number ?? '', o.quotation_number ?? '',
    ORDER_TYPES.find(([k]) => k === o.order_type)?.[1] ?? '', titleCase(o.priority ?? ''), o.salesperson_name ?? '',
    n(o.grand_total), n(o.invoiced_total), n(o.pending_amount),
    approvalText(o), DELIVERY[o.delivery_status][0], label(o.status),
  ])
  return { header, data, money: [10, 11, 12] }
}

export default function ErpSalesOrders() {
  const { can, loaded } = useAccess()
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [range, setRange] = useState<DateRange>('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [approval, setApproval] = useState('')
  const [delivery, setDelivery] = useState('')
  const [filtering, setFiltering] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [sort, setSort] = useState('created')
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const query: SalesOrderQuery = {
    status: status || undefined, approval: approval || undefined, delivery: delivery || undefined, q: q.trim() || undefined,
    date_from: from || undefined, date_to: to || undefined, sort, direction: dir,
  }
  // Polled, because what it shows moves with invoices and dispatches other people raise.
  const list = useQuery(`erp-sos-${JSON.stringify(query)}-${page}-${pageSize}`,
    () => erp.salesOrdersPage({ ...query, page, page_size: pageSize }), { pollMs: 60_000 })
  // A new filter starts from the top; the server says if the page has gone.
  useEffect(() => { setPage(1) }, [status, approval, delivery, q, from, to, sort, dir, pageSize])
  useEffect(() => { if (list.data && list.data.page !== page) setPage(list.data.page) }, [list.data]) // eslint-disable-line react-hooks/exhaustive-deps
  const [params, setParams] = useSearchParams()
  const [openId, setOpenId] = useState<string | null>(params.get('open'))
  const [converting, setConverting] = useState(false)
  useEffect(() => { if (params.get('open')) { setOpenId(params.get('open')); setParams({}, { replace: true }) } }, [params, setParams])
  // Opening Sales orders starts a new order, as Invoices and POs do; somebody
  // who cannot book one, or who came to open a given order, sees the list.
  const seller = can('can_manage_sales_orders')
  const [view, setView] = useState<'new' | 'list' | null>(params.get('open') ? 'list' : null)
  const [editing, setEditing] = useState<SalesOrder | null>(null)
  const [fresh, setFresh] = useState(0)
  const [saved, setSaved] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ so: SalesOrder; top: number; left: number } | null>(null)
  const [printing, setPrinting] = useState<SalesOrder | null>(null)
  const [sending, setSending] = useState<SalesOrder | null>(null)
  const [invoicing, setInvoicing] = useState<SalesOrder | null>(null)
  const [cancelling, setCancelling] = useState<SalesOrder | null>(null)
  const [exportBusy, setExportBusy] = useState(false)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    // Late, because clicking a half-hidden button scrolls it into view: that
    // scroll belongs to the click that opened the menu, and must not close it.
    const arm = setTimeout(() => window.addEventListener('scroll', close, true), 200)
    window.addEventListener('keydown', onKey)
    return () => { clearTimeout(arm); window.removeEventListener('scroll', close, true); window.removeEventListener('keydown', onKey) }
  }, [menu])
  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(null), 6000)
    return () => clearTimeout(t)
  }, [saved])
  const shown = editing ? 'edit' : view ?? (loaded && seller ? 'new' : 'list')

  if (!loaded) return <CrmPage><Loading /></CrmPage>
  if ((shown === 'new' || shown === 'edit') && seller) {
    return (
      <CrmPage>
        <SalesOrderPage key={editing?.id ?? `new-${fresh}`} so={editing}
          onClose={() => { if (editing) { setEditing(null); setView('list') } else setFresh((n) => n + 1) }}
          onShowAll={() => { setEditing(null); setView('list') }}
          onSaved={(order, submitted) => {
            setEditing(null); setView('list'); list.reload(); setOpenId(order.id)
            setSaved(submitted ? `${order.number} was submitted for approval.` : `${order.number} was saved as a draft. Open it any time from the Draft tab to edit or submit it.`)
          }} />
      </CrmPage>
    )
  }

  const book = list.data?.summary ?? {}
  const count = (...names: string[]) => names.reduce((t, n) => t + (book[n]?.count ?? 0), 0)
  const value = (...names: string[]) => names.reduce((t, n) => t + Number(book[n]?.value ?? 0), 0)
  const OPEN = ['approved', 'partially_dispatched', 'on_hold']
  const everyStatus = Object.keys(book)
  const booked = everyStatus.filter((n) => !['draft', 'submitted', 'rejected', 'cancelled'].includes(n))
  const cards: [string, string, string, string, string][] = [
    ['', 'Booked value', rupees(value(...booked)), `${count(...booked)} approved`, 'all'],
    ['submitted', 'Awaiting release', String(count('submitted')), rupees(value('submitted')), 'wait'],
    ['open', 'Open to dispatch', String(count(...OPEN)), rupees(value(...OPEN)), 'open'],
    ['dispatched', 'Dispatched', String(count('dispatched')), rupees(value('dispatched')), 'done'],
    ['draft', 'Drafts', String(count('draft')), 'Not yet submitted', 'draft'],
  ]
  const rows = list.data?.rows ?? []
  const total = list.data?.total ?? 0
  const shownPage = list.data?.page ?? page
  const pages = list.data?.pages ?? 1
  const onSort = (col: string) => {
    if (sort === col) setDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSort(col); setDir(ASC_FIRST.includes(col) ? 'asc' : 'desc') }
  }
  const biller = can('can_manage_billing')
  const deleter = can('can_delete_sales_orders')
  const activeFilters = [status, approval, delivery, from || to].filter(Boolean).length
  const filtered = Boolean(q || activeFilters)
  const clearFilters = () => { setStatus(''); setApproval(''); setDelivery(''); setRange(''); setFrom(''); setTo('') }
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
  /** Everything the filters match, not only the page on screen. */
  async function exportRows(as: 'csv' | 'xlsx') {
    setExporting(false)
    setExportBusy(true)
    setDownloadError(null)
    try {
      const everything: SalesOrder[] = []
      for (let at = 1, last = 1; at <= last; at += 1) {
        const part = await erp.salesOrdersPage({ ...query, page: at, page_size: 200 })
        everything.push(...part.rows)
        last = part.pages
      }
      const name = `sales-orders-${todayISO()}`
      const { header, data, money } = orderSheet(everything)
      if (as === 'csv') downloadCsv(`${name}.csv`, header, data)
      else downloadXlsx(`${name}.xlsx`, 'Sales orders', header, data, money)
    } catch (err) {
      setDownloadError(erpError(err, 'The export could not be prepared'))
    } finally {
      setExportBusy(false)
    }
  }
  async function duplicate(so: SalesOrder) {
    setDownloadError(null)
    try {
      const copy = await erp.duplicateSalesOrder(so.id)
      list.reload()
      setEditing(copy)
    } catch (err) {
      setDownloadError(erpError(err, `${so.number} could not be copied`))
    }
  }

  async function download(so: SalesOrder) {
    setDownloading(so.id)
    setDownloadError(null)
    try {
      await downloadSalesOrderPdf(so)
    } catch {
      setDownloadError(`${so.number} could not be downloaded. Open Print and use Save as PDF instead.`)
    } finally {
      setDownloading(null)
    }
  }
  async function remove(so: SalesOrder) {
    setMenu(null)
    if (!window.confirm(`Delete draft ${so.number} for ${so.customer_name} (${rupees(so.grand_total)})?\n\nThis cannot be undone, and the number will not be used again.`)) return
    setDownloadError(null)
    try {
      await erp.deleteSalesOrder(so.id)
      setSaved(`${so.number} was deleted.`)
      list.reload()
    } catch (err) {
      setDownloadError(erpError(err, `${so.number} could not be deleted`))
    }
  }
  function openMenu(so: SalesOrder, button: HTMLElement) {
    const box = button.getBoundingClientRect()
    const tall = 226
    setMenu({ so, left: Math.max(8, box.right - 200), top: box.bottom + tall + 8 > window.innerHeight ? box.top - tall - 4 : box.bottom + 4 })
  }

  return (
    <CrmPage>
      <div className="vdl-kpis sol-kpis">
        {cards.map(([key, label, big, sub, tone]) => (
          <button key={label} type="button" className={`vdl-kpi sol-kpi is-${tone}${status === key ? ' is-on' : ''}`} onClick={() => setStatus(key)}>
            <span>{label}</span><b>{list.data ? big : '—'}</b><small>{sub}</small>
          </button>
        ))}
      </div>


      <div className="crm-bar sol-bar">
        <div className="crm-search"><IconSearch size={15} />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search order no., customer or customer PO" /></div>
        <div className="sol-tools">
        {filtered && <button type="button" className="btn btn-sm ivl-clear" onClick={() => { setQ(''); clearFilters() }}>Clear</button>}
        {list.data && <span className="sol-count">{total} {total === 1 ? 'order' : 'orders'}</span>}
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
                  <label className="is-wide"><span>Status</span>
                    <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
                      {FILTERS.map((f) => <option key={f.key} value={f.key}>{f.key ? f.label : 'All statuses'}</option>)}
                    </select></label>
                  <label><span>Approval status</span>
                    <select value={approval} onChange={(e) => setApproval(e.target.value)} aria-label="Approval status">
                      <option value="">Any approval</option>
                      {Object.entries(APPROVAL).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
                    </select></label>
                  <label><span>Delivery status</span>
                    <select value={delivery} onChange={(e) => setDelivery(e.target.value)} aria-label="Delivery status">
                      <option value="">Any delivery</option>
                      {Object.entries(DELIVERY).map(([k, [l]]) => <option key={k} value={k}>{k === 'not_applicable' ? 'Nothing to deliver' : l}</option>)}
                    </select></label>
                  <label className="is-wide"><span>Order date</span>
                    <select value={range} onChange={(e) => pickRange(e.target.value as DateRange)} aria-label="Date range">
                      <option value="">Any date</option>
                      {DATE_RANGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select></label>
                  <label><span>From</span><input type="date" value={from} max={to || undefined} onChange={(e) => { setFrom(e.target.value); setRange('custom') }} /></label>
                  <label><span>To</span><input type="date" value={to} min={from || undefined} onChange={(e) => { setTo(e.target.value); setRange('custom') }} /></label>
                </div>
                <div className="ivl-filter-foot">
                  <span>{total} of {count(...everyStatus)} match</span>
                  <button type="button" className="btn btn-sm" disabled={!activeFilters} onClick={clearFilters}>Clear all</button>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => setFiltering(false)}>Done</button>
                </div>
              </div>
            </>
          )}
        </div>
        <div className="ivl-export">
          <button type="button" className="btn" disabled={!total || exportBusy} aria-haspopup="menu" aria-expanded={exporting}
            title={total ? `Export all ${total} matching` : 'Nothing to export'} onClick={() => setExporting((v) => !v)}>
            <IconDownload size={15} /> {exportBusy ? 'Exporting…' : 'Export'}
          </button>
          {exporting && (
            <div className="ivl-export-menu" role="menu" onMouseLeave={() => setExporting(false)}>
              <button type="button" role="menuitem" onClick={() => void exportRows('xlsx')}><b>Excel</b><small>.xlsx · {total} rows</small></button>
              <button type="button" role="menuitem" onClick={() => void exportRows('csv')}><b>CSV</b><small>.csv · {total} rows</small></button>
            </div>
          )}
        </div>
        {seller && (
          <div className="sol-actions">
            <button className="btn" onClick={() => setConverting(true)} title="Book an order from an accepted CRM quotation">
              <IconSheet size={15} /> From quotation
            </button>
            <button className="btn btn-primary" onClick={() => { setFresh((n) => n + 1); setView('new') }}><IconPlus size={15} /> New order</button>
          </div>
        )}
        </div>
      </div>
      {saved && <div className="notice notice-ok" role="status" style={{ marginBottom: 12 }}>{saved}</div>}
      {list.error && <ErrorNote>{erpError(list.cause, 'Could not load sales orders')}</ErrorNote>}
      {downloadError && <div style={{ marginBottom: 10 }}><ErrorNote>{downloadError}</ErrorNote></div>}

      <section className="card itl-card">
        {!list.data ? <Loading /> : rows.length === 0 ? (
          <EmptyState icon={<IconSheet size={22} />} title={filtered ? 'Nothing matches' : 'No sales orders yet'}
            body={filtered ? 'Change the search or the filters.' : 'Convert an accepted CRM quotation, or book one from the customer\u2019s PO.'} />
        ) : (
          <div className="table-wrap"><table className="itl sol">
            <thead><tr>
              <SortTh col="number" sort={sort} dir={dir} onSort={onSort}>Sales order no.</SortTh>
              <SortTh col="order_date" sort={sort} dir={dir} onSort={onSort}>Order date</SortTh>
              <SortTh col="customer" sort={sort} dir={dir} onSort={onSort} className="sol-c-cust">Customer</SortTh>
              <SortTh col="required_by" sort={sort} dir={dir} onSort={onSort}>Delivery date</SortTh>
              <SortTh col="grand_total" sort={sort} dir={dir} onSort={onSort} num>Order value</SortTh>
              <SortTh col="invoiced" sort={sort} dir={dir} onSort={onSort} num>Invoiced</SortTh>
              <SortTh col="pending" sort={sort} dir={dir} onSort={onSort} num>Pending</SortTh>
              <SortTh col="approval" sort={sort} dir={dir} onSort={onSort}>Approval</SortTh>
              <SortTh col="delivery" sort={sort} dir={dir} onSort={onSort}>Delivery status</SortTh>
              <th className="itl-c-act">Actions</th>
            </tr></thead>
            <tbody>{rows.map((so) => {
              const billed = Number(so.grand_total) > 0 ? Math.min(100, Math.round((Number(so.invoiced_total || 0) / Number(so.grand_total)) * 100)) : 0
              return (
                <tr key={so.id} onClick={() => setOpenId(so.id)} className={`sol-row${so.status === 'cancelled' ? ' is-off' : ''}`}>
                  <td>
                    <span className="pol-no">{so.number}</span>
                    {/* Only what needs noticing from the list. The rest is in View. */}
                    {(so.status === 'on_hold' || so.status === 'closed' || so.has_deviation || (so.priority && so.priority !== 'normal')) && (
                      <span className="sol-tags">
                        {so.status === 'on_hold' && <em className="is-high">On hold</em>}
                        {so.status === 'closed' && <em>Closed</em>}
                        {so.priority && so.priority !== 'normal' && <em className={`is-${so.priority}`}>{titleCase(so.priority)}</em>}
                        {so.has_deviation && <em className="is-dev">Deviation</em>}
                      </span>
                    )}
                  </td>
                  <td><DateText iso={so.order_date} /></td>
                  <td className="sol-c-cust"><b title={so.customer_name}>{so.customer_name}</b></td>
                  <td>{so.required_by ? <DateText iso={so.required_by} /> : <span className="itl-muted">—</span>}</td>
                  <td className="crm-num"><b className="pol-amt">{rupees(so.grand_total)}</b></td>
                  <td className="crm-num" title={`${billed}% invoiced`}>{rupees(so.invoiced_total)}</td>
                  <td className={`crm-num${Number(so.pending_amount) > 0 ? ' sol-pending' : ' itl-muted'}`}>{Number(so.pending_amount) > 0 ? rupees(so.pending_amount) : '—'}</td>
                  <td><span className={`crm-state crm-state-${APPROVAL[so.approval_status][1]}`}>{approvalText(so)}</span></td>
                  <td><span className={`crm-state crm-state-${DELIVERY[so.delivery_status][1]}`}>{DELIVERY[so.delivery_status][0]}</span></td>
                  <td className="itl-c-act" onClick={(e) => e.stopPropagation()}>
                    <div className="crm-row-actions itl-actions">
                      <button className="crm-icon-btn" title="View" aria-label={`View ${so.number}`} onClick={() => setOpenId(so.id)}><IconSheet size={14} /></button>
                      <button className="crm-icon-btn" disabled={so.status !== 'draft' || !seller} aria-label={`Edit ${so.number}`}
                        title={editBlock(so, seller) ?? 'Edit draft'} onClick={() => setEditing(so)}><IconEdit size={14} /></button>
                      <button className="crm-icon-btn" title="More actions" aria-label={`More actions for ${so.number}`} aria-haspopup="menu"
                        onClick={(e) => openMenu(so, e.currentTarget)}>
                        {downloading === so.id ? <span className="ivl-spin" aria-hidden /> : <IconMore size={14} />}
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}</tbody>
          </table></div>
        )}
        {rows.length > 0 && (
          <div className="crm-foot sol-foot">
            <span>{(shownPage - 1) * (list.data?.page_size ?? pageSize) + 1}–{Math.min(shownPage * (list.data?.page_size ?? pageSize), total)} of {total} order{total === 1 ? '' : 's'}</span>
            <label className="crm-sub" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              Rows
              <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} aria-label="Rows per page">
                {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <div className="crm-pager">
              <button disabled={shownPage <= 1} onClick={() => setPage(shownPage - 1)} aria-label="Previous page">‹</button>
              {pageWindow(shownPage, pages).map((n, i, all) => (
                <Fragment key={n}>
                  {i > 0 && n - all[i - 1] > 1 && <span className="sol-gap" aria-hidden>…</span>}
                  <button className={n === shownPage ? 'crm-page-on' : ''} aria-current={n === shownPage ? 'page' : undefined} onClick={() => setPage(n)}>{n}</button>
                </Fragment>
              ))}
              <button disabled={shownPage >= pages} onClick={() => setPage(shownPage + 1)} aria-label="Next page">›</button>
            </div>
          </div>
        )}
      </section>
      {menu && (
        <>
          <div className="ivl-filter-scrim" onClick={() => setMenu(null)} />
          <div className="ivl-export-menu sol-menu" role="menu" style={{ top: menu.top, left: menu.left }}>
            <button type="button" role="menuitem" onClick={() => { setPrinting(menu.so); setMenu(null) }}><IconPrinter size={14} /> Print</button>
            <button type="button" role="menuitem" onClick={() => { void download(menu.so); setMenu(null) }}><IconDownload size={14} /> Download PDF</button>
            {(() => {
              const block = !seller ? 'You cannot send orders' : menu.so.approval_status !== 'approved' ? 'Only an approved order is sent to the customer' : null
              return <button type="button" role="menuitem" disabled={Boolean(block)} title={block ?? undefined} onClick={() => { setSending(menu.so); setMenu(null) }}><IconMail size={14} /> Send to customer</button>
            })()}
            {(() => {
              const block = !biller ? 'You cannot raise invoices' : menu.so.approval_status !== 'approved' ? 'Only an approved order is invoiced' : null
              return <button type="button" role="menuitem" disabled={Boolean(block)} title={block ?? undefined} onClick={() => { setInvoicing(menu.so); setMenu(null) }}><IconCard size={14} /> Create invoice</button>
            })()}
            <button type="button" role="menuitem" disabled={!seller} title={seller ? undefined : 'You cannot create orders'} onClick={() => { void duplicate(menu.so); setMenu(null) }}><IconSheet size={14} /> Duplicate order</button>
            {(() => {
              const block = cancelBlock(menu.so, seller)
              return <button type="button" role="menuitem" className="is-danger" disabled={Boolean(block)} title={block ?? undefined} onClick={() => { setCancelling(menu.so); setMenu(null) }}><IconClose size={14} /> Cancel order</button>
            })()}
            {(() => {
              const block = deleteBlock(menu.so, deleter)
              return <button type="button" role="menuitem" className="is-danger" disabled={Boolean(block)} title={block ?? undefined} onClick={() => void remove(menu.so)}><IconTrash size={14} /> Delete</button>
            })()}
          </div>
        </>
      )}
      {printing && <SalesOrderPrint so={printing} onClose={() => setPrinting(null)} />}
      {sending && <SendOrder so={sending} onClose={() => setSending(null)} onSent={(to) => { setSaved(`${sending.number} was sent to ${to}.`); setSending(null) }} />}
      {invoicing && <CreateInvoice so={invoicing} onClose={() => setInvoicing(null)} />}
      {cancelling && (
        <ReasonDialog title={`Cancel ${cancelling.number}`} danger confirm="Cancel order"
          hint="The order stays on record marked Cancelled, and any stock reserved for it is released."
          onClose={() => setCancelling(null)}
          onSubmit={async (reason) => {
            await erp.salesOrderReason(cancelling.id, 'cancel', reason)
            setSaved(`${cancelling.number} was cancelled.`)
            list.reload()
          }} />
      )}
      {converting && <FromQuotation onClose={() => setConverting(false)} onDone={(so) => { setConverting(false); list.reload(); setOpenId(so.id) }} />}
      {openId && <OrderDrawer id={openId} flash={saved} onClose={() => { setOpenId(null) }} onEdit={(so) => { setOpenId(null); setEditing(so) }} onChanged={() => list.reload()} />}
    </CrmPage>
  )
}

const ORDER_TYPES: [string, string][] = [
  ['standard', 'Standard order'], ['project', 'Project'], ['service', 'Service'], ['amc', 'AMC / contract'], ['sample', 'Sample / demo'], ['export', 'Export'],
]
const PRIORITIES: [string, string][] = [['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent']]
const OTHER = '__other__'
const NET_DAYS = { net7: 7, net15: 15, net30: 30, net45: 45, net60: 60, net90: 90 } as const
const PAY_KINDS: [string, string][] = [
  ['advance', '100% advance'], ['receipt', 'Due on receipt'],
  ['net7', 'Credit — 7 days'], ['net15', 'Credit — 15 days'], ['net30', 'Credit — 30 days'], ['net45', 'Credit — 45 days'],
  ['net60', 'Credit — 60 days'], ['net90', 'Credit — 90 days'], ['partial', 'Part advance + credit'], ['custom', 'Custom…'],
]
type Pay = { kind: string; advance: string; days: string; custom: string }

/** Payment terms are stored as words on the order; read them back into the picker. */
function parsePay(text: string): Pay {
  const t = text.trim()
  const base: Pay = { kind: 'net30', advance: '50', days: '30', custom: '' }
  if (!t) return base
  if (/^100% advance$/i.test(t) || /^advance$/i.test(t)) return { ...base, kind: 'advance' }
  if (/^due on receipt$/i.test(t)) return { ...base, kind: 'receipt' }
  const net = t.match(/^(?:net\s*)?(\d+)\s*days$/i)
  if (net && `net${net[1]}` in NET_DAYS) return { ...base, kind: `net${net[1]}` }
  const part = t.match(/^(\d{1,2})% advance, balance in (\d+) days$/i)
  if (part) return { ...base, kind: 'partial', advance: part[1], days: part[2] }
  return { ...base, kind: 'custom', custom: t }
}

function payText(p: Pay, creditDays?: number): string {
  if (p.kind === 'advance') return '100% advance'
  if (p.kind === 'receipt') return 'Due on receipt'
  if (p.kind in NET_DAYS) return `Net ${NET_DAYS[p.kind as keyof typeof NET_DAYS]} days`
  if (p.kind === 'partial') return `${p.advance || 0}% advance, balance in ${p.days || creditDays || 0} days`
  return p.custom.trim()
}
const DELIVERY_TERMS = ['Door delivery', 'FOR destination', 'Ex-works', 'Freight extra', 'Delivery & installation']
const MILESTONE_KINDS = ['advance', 'dispatch', 'delivery', 'installation', 'uat', 'monthly', 'custom']
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase())

/** Why this order cannot be deleted, if it cannot. The server asks the same
 *  questions, and also refuses one that requisitions or POs point at. */
function deleteBlock(so: SalesOrder, may: boolean): string | null {
  if (!may) return 'You do not have permission to delete orders'
  if (so.status !== 'draft') return 'Only a draft that was never submitted can be deleted'
  if (so.submitted_at) return 'It has been through approval — cancel it instead'
  if (so.invoices.length || so.dispatches.length) return 'It has documents against it — cancel it instead'
  return null
}

/** Why this order cannot be cancelled, if it cannot. The server asks the same. */
function cancelBlock(so: SalesOrder, seller: boolean): string | null {
  if (!seller) return 'You cannot cancel orders'
  if (so.status === 'cancelled' || so.status === 'closed') return `This order is already ${so.status}`
  if (so.lines.some((l) => Number(l.dispatched_qty) > 0)) return 'Goods have left against it — close it from View instead'
  if (so.invoices.some((i) => !['cancelled', 'rejected'].includes(i.status) && !['proforma', 'credit_note'].includes(i.kind))) {
    return 'An invoice is raised against it — delete or cancel that first'
  }
  return null
}

/** Why this order cannot go back to draft, if it cannot. The server asks the same. */
function amendBlock(so: SalesOrder): string | null {
  if (so.dispatches.length) return 'It has a dispatch against it. Close it and raise another'
  if (so.invoices.some((i) => !['cancelled', 'rejected'].includes(i.status) && !['proforma', 'credit_note'].includes(i.kind))) {
    return 'An invoice is raised against it. Delete or cancel that first'
  }
  return null
}

/** Why this order cannot be edited from the list, if it cannot. */
function editBlock(so: SalesOrder, seller: boolean): string | null {
  if (!seller) return 'You cannot edit orders'
  if (so.status === 'draft') return null
  if (so.status === 'rejected') return 'View it and choose Revise to edit it again'
  return 'Only a draft order can be edited'
}

/** Open an attachment in a new tab — a blob URL; browsers refuse data: there. */
async function openData(data: string) {
  const blob = await (await fetch(data)).blob()
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank', 'noopener')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

const SO_MIN_ROWS = 4
const SO_GST = ['0', '5', '12', '18', '28']

/** The order's items as a sheet, in the family of the sale bill: one row a line,
 *  and a fresh row appears once the last one is used. Pick from the Item Master
 *  and the description, HSN/SAC, unit, rate and GST fill in; anything can be typed
 *  over, or a line written by hand under Description. */
function SoItems({ lines, onChange, items }: {
  lines: PoLine[]
  onChange: (lines: PoLine[]) => void
  items: Item[]
}) {
  const used = (l: PoLine) => Boolean(l.item_id || l.description.trim())
  const tail = useRef(blankPoLine())
  // Once the spare row is typed in it is a line of the order; the next spare is new.
  if (lines.some((l) => l.key === tail.current.key)) tail.current = blankPoLine()
  const rows = lines.length > 0 && !used(lines[lines.length - 1]) ? lines : [...lines, tail.current]
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const set = (key: string, patch: Partial<PoLine>) => onChange((key === tail.current.key ? rows : lines).map((l) => (l.key === key ? { ...l, ...patch } : l)))
  const remove = (key: string) => {
    const left = lines.filter((l) => l.key !== key)
    onChange(left.length > 0 ? left : [blankPoLine()])
  }
  const pick = (key: string, id: string) => {
    const it = items.find((i) => i.id === id)
    if (!it) { set(key, { item_id: '' }); return }
    set(key, {
      item_id: it.id, description: it.name, hsn_sac: it.hsn_sac ?? '', uom: it.uom || 'Nos',
      rate: String(Number(it.sale_price || 0)), gst_percent: String(Number(it.gst_percent ?? 18)),
    })
  }
  const options: PickOption[] = items.filter((i) => i.can_be_sold !== false).map((i) => ({
    value: i.id, label: `${i.code} · ${i.name}`,
    hint: [[i.make, i.model].filter(Boolean).join(' '), i.hsn_sac && `HSN ${i.hsn_sac}`,
      `₹${Number(i.sale_price || 0).toLocaleString('en-IN')} / ${i.uom}`,
      i.is_stocked && `${qtyText(i.available_qty)} in stock`].filter(Boolean).join(' · '),
    tag: i.item_type === 'service' ? 'Service' : undefined,
  }))
  const count = lines.filter(used).length
  /** Enter moves along the row, as on the sale bill. */
  function nextCell(e: React.KeyboardEvent<HTMLTableElement>) {
    const target = e.target as HTMLElement
    if (e.defaultPrevented || e.key !== 'Enter' || !target.matches('td > input, td > select')) return
    e.preventDefault()
    const cells = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('td > input, td > select, td .ss-btn'))
    cells[cells.indexOf(target) + 1]?.focus()
  }

  return (
    <section className="pof-sec sof-items">
      <header className="pof-sec-head">
        <h3>Item details</h3>
        <span>{count} {count === 1 ? 'line' : 'lines'}</span>
      </header>
      <div className="sb-grid">
        <table onKeyDown={nextCell}>
          <thead>
            <tr>
              <th className="sb-c-sr">Sr</th><th className="sb-c-item">Item name</th><th className="sof-c-desc">Description</th>
              <th className="sb-c-hsn">HSN/SAC</th><th className="sb-c-qty">Qty</th><th className="sb-c-unit">Unit</th>
              <th className="sb-c-rate">Rate (₹)</th><th className="sof-c-disc">Disc %</th><th className="sb-c-gst">GST %</th>
              <th className="sb-c-amt">Amount (₹)</th><th className="sb-c-x" aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {rows.map((l, n) => {
              const on = used(l)
              const p = priceLine(l)
              const qtyBad = on && !(Number(l.quantity) > 0)
              const discBad = Number(l.discount_percent || 0) > 100
              const gst = String(Number(l.gst_percent))
              return (
                <tr key={l.key} className={l.key === activeKey ? 'is-active' : undefined} onFocusCapture={() => setActiveKey(l.key)}>
                  <td className="sb-c-sr">{n + 1}</td>
                  <td className="sb-c-item">
                    <SearchSelect label={`Item, line ${n + 1}`} value={l.item_id} onChange={(v) => pick(l.key, v)} options={options} clearable
                      placeholder="Search item name or code…" empty="No item matches" />
                  </td>
                  <td className="sof-c-desc"><input value={l.description} onChange={(e) => set(l.key, { description: e.target.value })}
                    placeholder={l.item_id ? 'Description' : 'Or type a line by hand'} aria-label={`Description, line ${n + 1}`} /></td>
                  <td className="sb-c-hsn"><input value={l.hsn_sac} placeholder="8471" onChange={(e) => set(l.key, { hsn_sac: e.target.value })} aria-label={`HSN/SAC, line ${n + 1}`} /></td>
                  <td className="sb-c-qty"><input placeholder="1" inputMode="decimal" className={qtyBad ? 'is-bad' : undefined} value={on || l.quantity !== '1' ? l.quantity : ''}
                    onChange={(e) => set(l.key, { quantity: e.target.value })} aria-label={`Quantity, line ${n + 1}`} /></td>
                  <td className="sb-c-unit"><input placeholder="Nos" list="sof-units" value={on || l.uom !== 'Nos' ? l.uom : ''}
                    onChange={(e) => set(l.key, { uom: e.target.value })} aria-label={`Unit, line ${n + 1}`} /></td>
                  <td className="sb-c-rate"><input inputMode="decimal" value={l.rate} placeholder={on ? '0.00' : ''}
                    onChange={(e) => set(l.key, { rate: e.target.value })} aria-label={`Rate, line ${n + 1}`} /></td>
                  <td className="sof-c-disc"><input inputMode="decimal" className={discBad ? 'is-bad' : undefined} value={l.discount_percent} placeholder={on ? '0' : ''}
                    onChange={(e) => set(l.key, { discount_percent: e.target.value })} aria-label={`Discount percent, line ${n + 1}`} /></td>
                  <td className="sb-c-gst">
                    {on && (
                      <select value={gst} onChange={(e) => set(l.key, { gst_percent: e.target.value })} aria-label={`GST, line ${n + 1}`}>
                        {!SO_GST.includes(gst) && <option value={gst}>{gst}%</option>}
                        {SO_GST.map((g) => <option key={g} value={g}>{g}%</option>)}
                      </select>
                    )}
                  </td>
                  <td className="sb-c-amt" title={p.amount > 0 ? `Taxable ${rupees(p.taxable)}${p.disc > 0 ? ` after ${rupees(p.disc)} discount` : ''} + GST ${rupees(p.gst)}` : undefined}>
                    {p.amount > 0 ? rupees(p.amount) : ''}
                  </td>
                  <td className="sb-c-x">
                    {on && <button type="button" className="sb-del" title="Remove line" aria-label={`Remove line ${n + 1}`} onClick={() => remove(l.key)}><IconTrash size={13} /></button>}
                  </td>
                </tr>
              )
            })}
            {count === 0 && (
              <tr className="sb-hint"><td className="sb-c-sr" /><td colSpan={10}>
                <b>Start the order:</b> search an item in row 1 and pick it — description, HSN, unit, rate and GST fill in.
                For a line that is not in the item list, type it under <b>Description</b>.
              </td></tr>
            )}
            {Array.from({ length: Math.max(0, SO_MIN_ROWS - rows.length - (count === 0 ? 1 : 0)) }, (_, i) => (
              <tr key={`pad-${i}`} className="sb-pad"><td className="sb-c-sr" /><td colSpan={10} /></tr>
            ))}
          </tbody>
        </table>
        <datalist id="sof-units">{PO_UNITS.map((u) => <option key={u} value={u} />)}</datalist>
      </div>
    </section>
  )
}

/** The sales order, as a full page: order details, items, the tax summary,
 *  delivery & terms, milestones, notes and attachments — then Save draft or
 *  Submit for approval. Editing a draft opens the same page. */
function SalesOrderPage({ so, onClose, onSaved, onShowAll }: {
  so: SalesOrder | null; onClose: () => void; onSaved: (so: SalesOrder, submitted: boolean) => void; onShowAll: () => void
}) {
  const { user } = useAuth()
  const items = useItems()
  const customers = useQuery('erp-customers-all', () => erp.customers())
  const [head, setHead] = useState({
    customer_id: so?.customer_id ?? '', site_id: so?.site_id ?? '', order_date: so?.order_date ?? todayISO(),
    order_type: so?.order_type ?? 'standard', priority: so?.priority ?? 'normal', reference: so?.reference ?? '',
    salesperson_id: so?.salesperson_id ?? user?.id ?? '',
    customer_po_number: so?.customer_po_number ?? '', customer_po_date: so?.customer_po_date ?? '', customer_po_value: so?.customer_po_value ?? '',
    required_by: so?.required_by ?? '', place_of_supply: so?.place_of_supply ?? '', payment_terms: so?.payment_terms ?? '',
    delivery_terms: so?.delivery_terms ?? '', delivery_mode: so?.delivery_mode ?? '', freight_terms: so?.freight_terms ?? '',
    transporter_name: so?.transporter_name ?? '', billing_address: so?.billing_address ?? '', shipping_address: so?.shipping_address ?? '',
    delivery_instructions: so?.delivery_instructions ?? '', freight: so?.freight && Number(so.freight) ? String(Number(so.freight)) : '',
    other_charges: so?.other_charges && Number(so.other_charges) ? String(Number(so.other_charges)) : '',
    notes: so?.notes ?? '', terms: so?.terms ?? '', internal_notes: so?.internal_notes ?? '', deviation_note: so?.deviation_note ?? '',
  })
  const [lines, setLines] = useState<PoLine[]>(so ? so.lines.map((l) => ({
    key: l.id, item_id: l.item_id ?? '', description: l.description, hsn_sac: l.hsn_sac ?? '', uom: l.uom ?? 'Nos',
    quantity: String(Number(l.quantity)), rate: String(Number(l.rate ?? 0)), discount_percent: String(Number(l.discount_percent ?? 0)),
    gst_percent: String(Number(l.gst_percent ?? 18)), requisition_line_id: null,
  })) : [blankPoLine()])
  const [milestones, setMilestones] = useState(so?.milestones.map((m) => ({ name: m.name, kind: m.kind, taxable_amount: String(Number(m.taxable_amount)), gst_percent: String(Number(m.gst_percent)), due_date: m.due_date ?? '' })) ?? [])
  const [pending, setPending] = useState<{ name: string; data: string }[]>([])
  const [kept, setKept] = useState(so?.attachments ?? [])
  const [fileError, setFileError] = useState<string | null>(null)
  /* Set once the server has the order. A later step failing (an attachment, the
     submit) must not make the next click create a second order. */
  const [stored, setStored] = useState<SalesOrder | null>(null)
  const next = useQuery(`erp-so-next-${head.order_date}`, () => erp.nextSoNumber(head.order_date || todayISO()))
  const { busy, error, run } = useRun()
  const set = (k: keyof typeof head, v: string) => setHead((h) => ({ ...h, [k]: v }))
  const fileInput = useRef<HTMLInputElement>(null)

  const all = customers.data ?? []
  const customer = all.find((c) => c.customer_id === head.customer_id) ?? null
  const account = customer?.account ?? null
  const sites = account?.sites ?? []
  const pickCustomer = (id: string) => {
    const c = all.find((x) => x.customer_id === id)
    const acc = c?.account
    setHead((h) => ({
      ...h, customer_id: id, site_id: '',
      place_of_supply: acc?.billing_state ? titleCase(acc.billing_state) : h.place_of_supply,
      billing_address: acc?.billing_address ?? '',
      // A separate shipping address on the customer means "different"; else same as billing.
      shipping_address: acc?.shipping_address && acc.shipping_address !== acc.billing_address ? acc.shipping_address : '',
    }))
    setShipMode(acc?.shipping_address && acc.shipping_address !== acc.billing_address ? 'other' : 'same')
    setShipSite('')
    if (!so) setPay(acc && acc.credit_days > 0 ? { ...parsePay(''), kind: `net${acc.credit_days}` in NET_DAYS ? `net${acc.credit_days}` : 'custom', custom: `Net ${acc.credit_days} days` } : parsePay(''))
  }
  const customerOptions: PickOption[] = all.map((c) => ({
    value: c.customer_id, label: c.customer_name,
    hint: [c.customer_code, c.contact_name, c.mobile, c.account?.gstin ?? c.crm_gstin, c.account?.billing_state && titleCase(c.account.billing_state)]
      .filter(Boolean).join(' · '),
    tag: c.account?.credit_hold ? 'Credit hold' : undefined,
  }))
  const filled = lines.filter((l) => l.item_id || l.description.trim())
  const linesBad = filled.some((l) => !(Number(l.quantity) > 0) || Number(l.rate) < 0 || !(Number(l.discount_percent || 0) <= 100))
  const datesBad = Boolean(head.required_by && head.order_date && head.required_by < head.order_date)
  // ── Delivery & terms ──
  const states = useQuery<Array<{ id: string; name: string; gst_code?: string | null; is_active: boolean }>>('crm-master-states', () => crm.masters('states'))
  const stateList = (states.data ?? []).filter((x) => x.is_active || x.name === head.place_of_supply).sort((x, y) => x.name.localeCompare(y.name))
  const vendors = useQuery('erp-vendors-all', () => erp.vendors({}))
  const transporters = (vendors.data ?? []).filter((v) => v.vendor_type === 'transporter' && v.status === 'active').map((v) => v.legal_name)
  const [transporterPick, setTransporterPick] = useState(() => (head.transporter_name ? (head.transporter_name) : ''))
  useEffect(() => {
    // An old free-text transporter that is not in the vendor master stays as "Other".
    if (vendors.data && head.transporter_name && !transporters.includes(head.transporter_name)) setTransporterPick(OTHER)
  }, [vendors.data]) // eslint-disable-line react-hooks/exhaustive-deps
  const noTransport = head.delivery_mode === 'hand' || head.delivery_mode === 'pickup'
  const [pay, setPay] = useState(() => parsePay(so?.payment_terms ?? ''))
  const paymentTerms = payText(pay, account?.credit_days)
  const [chargesRate, setChargesRate] = useState(so?.charges_gst_percent != null ? String(Number(so.charges_gst_percent)) : '')
  const autoRate = Math.max(18 * Number(!filled.length), ...filled.map((l) => Number(l.gst_percent || 0)), 0)
  const effRate = chargesRate === '' ? autoRate : Number(chargesRate)
  const charges = Number(head.freight || 0) + Number(head.other_charges || 0)
  const shipSites = sites.filter((x) => x.is_active && x.address)
  const siteAddress = (id: string) => shipSites.find((x) => x.id === id)?.address ?? ''
  const [shipMode, setShipMode] = useState<'same' | 'site' | 'other'>(() =>
    !so || !so.shipping_address || so.shipping_address === so.billing_address ? 'same' : 'other')
  const [shipSite, setShipSite] = useState('')
  const pickShip = (k: 'same' | 'site' | 'other') => {
    setShipMode(k)
    if (k === 'same') set('shipping_address', '')
    if (k === 'site') { setShipSite(''); set('shipping_address', '') }
    if (k === 'other' && head.shipping_address === head.billing_address) set('shipping_address', '')
  }
  const GST_CODES = new Map((states.data ?? []).filter((x) => x.gst_code).map((x) => [String(x.gst_code).padStart(2, '0'), x.name]))
  const gstin = account?.gstin || customer?.crm_gstin || ''
  const gstinState = /^\d{2}/.test(gstin) ? GST_CODES.get(gstin.slice(0, 2)) ?? null : null
  const moneyOk = (v: string) => v === '' || /^\d{1,10}(\.\d{1,2})?$/.test(v.trim())
  const freightBad = !moneyOk(head.freight)
  const otherBad = !moneyOk(head.other_charges)
  const posBad = Boolean(head.customer_id) && (!head.place_of_supply
    || (stateList.length > 0 && !stateList.some((x) => x.name.toLowerCase() === head.place_of_supply.toLowerCase())))
  const advBad = pay.kind === 'partial' && !(Number(pay.advance) >= 1 && Number(pay.advance) <= 99)
  const customPayBad = pay.kind === 'custom' && !pay.custom.trim()
  const shipBad = shipMode !== 'same' && head.shipping_address.trim().length < 5
  const total = lines.reduce((t, l) => t + priceLine(l).amount, 0) + charges + Math.round(charges * effRate) / 100
  const deviation = Boolean(so?.quotation_id) || Boolean(head.customer_po_value)
  const msUsed = milestones.filter((m) => m.name.trim() || Number(m.taxable_amount) > 0 || m.due_date)
  const msBad = (m: typeof milestones[number]) => (m.name.trim() || Number(m.taxable_amount) > 0 || m.due_date) && (
    !m.name.trim() || !moneyOk(m.taxable_amount) || !(Number(m.taxable_amount) > 0)
    || !(Number(m.gst_percent) >= 0 && Number(m.gst_percent) <= 28) || m.gst_percent.trim() === '')
  const milestonesBad = msUsed.some(msBad)
  const msTotal = msUsed.reduce((t, m) => t + Number(m.taxable_amount || 0), 0)
  const msSub = lines.reduce((t, l) => t + priceLine(l).taxable, 0) + charges
  const msOver = msUsed.length > 0 && msSub > 0 && msTotal > msSub + 0.005
  const poValueBad = !moneyOk(head.customer_po_value)
  const problem = !head.customer_id ? 'Choose a customer to begin'
    : !filled.length ? 'Add at least one item'
      : linesBad ? 'Each item needs a quantity above 0, a rate and a discount of 100 % or less'
        : datesBad ? 'The delivery date cannot be before the order date'
          : posBad ? 'Choose the place of supply'
            : advBad || customPayBad ? 'Complete the payment terms'
              : freightBad || otherBad ? 'Check the freight and other charges'
                : shipBad ? 'Enter the delivery address'
                  : poValueBad ? 'Enter the customer PO value as an amount'
                    : milestonesBad ? 'Each billing milestone needs a name, an amount above 0 and GST of 0–28 %'
                      : msOver ? 'Billing milestones add up to more than the order value'
                        : null
  const ready = !problem && !busy
  const overdue = customer && Number(customer.overdue) > 0
  const creditLimit = Number(account?.credit_limit ?? 0)
  const overLimit = creditLimit > 0 && Number(customer?.outstanding ?? 0) + total > creditLimit

  function addFiles(files: FileList | null) {
    setFileError(null)
    for (const f of Array.from(files ?? [])) {
      if (!/^image\/|^application\/pdf$/.test(f.type)) { setFileError('Attach pictures or PDFs only.'); continue }
      if (f.size > 5 * 1024 * 1024) { setFileError(`${f.name} is larger than 5 MB.`); continue }
      const reader = new FileReader()
      reader.onload = () => setPending((p) => [...p, { name: f.name, data: String(reader.result) }])
      reader.readAsDataURL(f)
    }
  }

  function save(submit = false) {
    void run(async () => {
      let saved = await erp.saveSalesOrder({
        customer_id: head.customer_id, quotation_id: so?.quotation_id ?? null, site_id: head.site_id || null,
        order_date: head.order_date || null, order_type: head.order_type, priority: head.priority, reference: head.reference || null,
        salesperson_id: head.salesperson_id || null,
        customer_po_number: head.customer_po_number || null, customer_po_date: head.customer_po_date || null,
        customer_po_value: head.customer_po_value || null, required_by: head.required_by || null,
        place_of_supply: head.place_of_supply || null, payment_terms: paymentTerms || null,
        delivery_terms: head.delivery_terms || null, delivery_mode: head.delivery_mode || null, freight_terms: head.freight_terms || null,
        transporter_name: noTransport ? null : head.transporter_name.trim() || null, billing_address: head.billing_address.trim() || null,
        shipping_address: shipMode === 'same' ? head.billing_address.trim() || null : head.shipping_address.trim() || null,
        delivery_instructions: head.delivery_instructions.trim() || null,
        freight: head.freight.trim() || '0', other_charges: head.other_charges.trim() || '0',
        charges_gst_percent: chargesRate === '' ? null : chargesRate,
        notes: head.notes || null, terms: head.terms || null, internal_notes: head.internal_notes || null,
        deviation_note: head.deviation_note || null,
        lines: filled.map((l) => ({
          item_id: l.item_id || null, description: l.description.trim() || null, hsn_sac: l.hsn_sac.trim() || null,
          uom: l.uom.trim() || null, quantity: l.quantity, rate: l.rate || '0', discount_percent: l.discount_percent || '0',
          gst_percent: l.gst_percent,
        })),
        milestones: msUsed.map((m) => ({ ...m, name: m.name.trim(), due_date: m.due_date || null })),
      }, so?.id ?? stored?.id)
      setStored(saved)
      // One at a time, so a file that fails leaves the ones before it uploaded.
      for (const f of pending) {
        saved = await erp.addSoAttachment(saved.id, f)
        setStored(saved)
        setKept(saved.attachments ?? [])
        setPending((p) => p.filter((x) => x !== f))
      }
      if (submit) {
        const draft = saved
        try {
          saved = await erp.salesOrderAction(draft.id, 'submit')
        } catch (err) {
          // The order is safe as a draft; say so, and why it did not go further.
          throw new Error(`${draft.number} is saved as a draft but was not submitted: ${erpError(err, 'the submit failed')}`)
        }
      }
      onSaved(saved, submit)
    }, submit ? 'The order could not be submitted' : 'The order could not be saved')
  }

  return (
    <div className="sb sb-page sof">
      <div className="sb-bar">
        <span className="sb-bar-icon" aria-hidden><IconSheet size={17} /></span>
        <div className="sb-bar-text">
          <h2 className="sb-title">{so ? `Edit ${so.number}` : stored ? `Edit ${stored.number}` : 'New sales order'}</h2>
          <span className="sb-bar-status">
            <i className={so || stored ? 'is-draft' : 'is-new'} />
            {so || stored ? 'Draft' : 'New · not saved yet'}
            {so?.quotation_number && <> · From quotation {so.quotation_number}</>}
            {filled.length > 0 && <> · {filled.length} line{filled.length === 1 ? '' : 's'}</>}
          </span>
        </div>
        <div className="sb-seg sof-prio" role="radiogroup" aria-label="Priority">
          {PRIORITIES.map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={head.priority === k}
              className={`${head.priority === k ? 'is-on' : ''} is-${k}`} onClick={() => set('priority', k)}>{l}</button>
          ))}
        </div>
        <span className="sb-bar-gap" />
        <small className="sof-req-note">Fields marked <b className="pof-req">*</b> are required</small>
        <button type="button" className="btn btn-sm" onClick={onShowAll}><IconSheet size={14} /> All sales orders</button>
      </div>

      <div className="sb-head sof-head">
        <div className={`sb-f ${sites.length > 0 ? 'c4' : 'c6'} sof-cust`}>
          <span>Customer <b className="pof-req">*</b></span>
          <SearchSelect label="Customer" value={head.customer_id} onChange={pickCustomer} options={customerOptions}
            placeholder="Search customer by name, code or GSTIN" empty="No customer matches — add one in CRM › My customers" />
        </div>
        {sites.length > 0 && (
          <label className="sb-f c2">
            <span>Site</span>
            <select value={head.site_id} aria-label="Customer site" onChange={(e) => set('site_id', e.target.value)}>
              <option value="">— Main address —</option>
              {sites.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
        )}
        <div className="sb-f sb-f-billno c2">
          <span>SO no.</span>
          <em title={so || stored ? 'Assigned' : 'Auto-generated'}>{so?.number ?? stored?.number ?? next.data?.number ?? '…'}</em>
        </div>
        <label className="sb-f c2">
          <span>Date <b className="pof-req">*</b></span>
          <input type="date" value={head.order_date} max={todayISO()} aria-label="Order date" onChange={(e) => set('order_date', e.target.value)} />
        </label>
        <label className="sb-f c2">
          <span>Type</span>
          <select value={head.order_type} aria-label="Order type" onChange={(e) => set('order_type', e.target.value)}>
            {ORDER_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>

        <label className="sb-f c3">
          <span>Salesperson</span>
          <OwnerSelect value={head.salesperson_id} onChange={(v) => set('salesperson_id', v)} placeholder="— None —" />
        </label>
        <label className={`sb-f c3${posBad ? ' is-bad' : ''}`} title={posBad ? (head.place_of_supply ? 'Not in the States master' : 'Required — GST depends on it') : 'From the customer; change it for a different delivery state'}>
          <span>Supply <b className="pof-req">*</b></span>
          <select value={head.place_of_supply} aria-label="Place of supply" onChange={(e) => set('place_of_supply', e.target.value)}>
            <option value="">— Select state —</option>
            {stateList.map((st) => <option key={st.id} value={st.name}>{st.name}{st.gst_code ? ` (${st.gst_code})` : ''}</option>)}
          </select>
        </label>
        <label className="sb-f c3">
          <span>Payment <b className="pof-req">*</b></span>
          <select value={pay.kind} aria-label="Payment terms" onChange={(e) => setPay((p) => ({ ...p, kind: e.target.value }))}>
            {PAY_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label className={`sb-f c3${datesBad ? ' is-bad' : ''}`} title={datesBad ? 'Cannot be before the order date' : undefined}>
          <span>Delivery</span>
          <input type="date" value={head.required_by} min={head.order_date || undefined} aria-label="Delivery date"
            onChange={(e) => set('required_by', e.target.value)} />
        </label>

        <label className="sb-f c3">
          <span>Customer PO</span>
          <input value={head.customer_po_number} maxLength={60} aria-label="Customer PO no." onChange={(e) => set('customer_po_number', e.target.value)} placeholder="e.g. PO-4501-778" />
        </label>
        <label className="sb-f c2">
          <span>PO date</span>
          <input type="date" value={head.customer_po_date} max={todayISO()} aria-label="PO date" onChange={(e) => set('customer_po_date', e.target.value)} />
        </label>
        <label className={`sb-f c3${poValueBad ? ' is-bad' : ''}`} title={poValueBad ? 'Enter an amount like 1250 or 1250.50' : 'Including tax'}>
          <span>PO value ₹</span>
          <input inputMode="decimal" value={head.customer_po_value} aria-label="PO value (incl. tax)" onChange={(e) => set('customer_po_value', e.target.value)} placeholder="Flags a mismatch" />
        </label>
        <label className="sb-f c2">
          <span>Ref.</span>
          <input value={head.reference} maxLength={80} aria-label="Reference" onChange={(e) => set('reference', e.target.value)} placeholder="Tender / enquiry no." />
        </label>
        <div className="sb-f c2">
          <span>Status</span>
          <ErpState value={stored?.status ?? so?.status ?? 'draft'} />
        </div>

        {pay.kind === 'partial' && (
          <div className={`sb-f c6${advBad ? ' is-bad' : ''}`} title={advBad ? 'Advance must be between 1 and 99 %' : undefined}>
            <span>Part advance</span>
            <input className="sof-tiny" placeholder="50" inputMode="numeric" value={pay.advance} aria-label="Advance percent"
              onChange={(e) => setPay((p) => ({ ...p, advance: e.target.value.replace(/\D/g, '').slice(0, 2) }))} />
            <small>% advance, balance in</small>
            <input className="sof-tiny" placeholder="30" inputMode="numeric" value={pay.days} aria-label="Balance days"
              onChange={(e) => setPay((p) => ({ ...p, days: e.target.value.replace(/\D/g, '').slice(0, 3) }))} />
            <small>days</small>
          </div>
        )}
        {pay.kind === 'custom' && (
          <label className={`sb-f c6${customPayBad ? ' is-bad' : ''}`} title={customPayBad ? 'Describe the payment terms' : undefined}>
            <span>Custom terms</span>
            <input value={pay.custom} maxLength={160} aria-label="Custom payment terms"
              onChange={(e) => setPay((p) => ({ ...p, custom: e.target.value }))} placeholder="e.g. 30% advance, 60% on delivery, 10% after installation" />
          </label>
        )}
      </div>

    {customer && (
      <div className="pof-vendor">
        <span><em>GSTIN</em>{account?.gstin || customer.crm_gstin || 'Unregistered'}</span>
        <span><em>State</em>{account?.billing_state ? titleCase(account.billing_state) : '—'}</span>
        <span><em>Contact</em>{customer.contact_name}{customer.mobile ? ` · ${customer.mobile}` : ''}</span>
        <span><em>Credit</em>{creditLimit > 0 ? rupees(creditLimit) : 'No limit'} · {account?.credit_days ?? 0} days</span>
        <span className={overdue ? 'sof-bad' : ''}><em>Outstanding</em>{rupees(customer.outstanding)}{overdue ? ` · ${rupees(customer.overdue)} overdue` : ''}</span>
        {account?.credit_hold && <span className="sof-bad">On credit hold{account.hold_reason ? ` — ${account.hold_reason}` : ''}</span>}
        {overLimit && <span className="sof-bad">This order takes the customer over the credit limit</span>}
        {gstinState && head.place_of_supply && gstinState.toLowerCase() !== head.place_of_supply.toLowerCase() && <span className="sof-bad">Customer GSTIN is registered in {gstinState}</span>}
      </div>
    )}

      <SoItems lines={lines} onChange={setLines} items={items.data ?? []} />

      <div className="sof-panels">
        <section className="pof-sec sdt sof-p-a">
          <header className="pof-sec-head"><h3>Dispatch &amp; charges</h3></header>
          <div className="sof-fields">
            <label className="pof-f"><span className="pof-l">Delivery mode</span>
              <select value={head.delivery_mode} onChange={(e) => set('delivery_mode', e.target.value)}>
                <option value="">— Select —</option>{DELIVERY_MODES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select></label>
            <label className="pof-f"><span className="pof-l">Transporter</span>
              <select value={transporterPick} disabled={noTransport} onChange={(e) => {
                const v = e.target.value
                setTransporterPick(v)
                set('transporter_name', v === OTHER ? '' : v)
              }}>
                <option value="">{noTransport ? '— Not needed —' : '— Select —'}</option>
                {transporters.map((t) => <option key={t} value={t}>{t}</option>)}
                <option value={OTHER}>Other (type name)…</option>
              </select>
              {transporterPick === OTHER && !noTransport && (
                <input className="sdt-under" value={head.transporter_name} maxLength={120} autoFocus
                  onChange={(e) => set('transporter_name', e.target.value)} placeholder="Transporter name" />
              )}
              {!noTransport && transporters.length === 0 && <small className="sdt-note">Add transporters in Vendor master (type: Transporter)</small>}
            </label>
            <label className="pof-f"><span className="pof-l">Delivery terms</span>
              <select value={head.delivery_terms} onChange={(e) => set('delivery_terms', e.target.value)}>
                <option value="">— Select —</option>
                {[...DELIVERY_TERMS, ...(head.delivery_terms && !DELIVERY_TERMS.includes(head.delivery_terms) ? [head.delivery_terms] : [])]
                  .map((t) => <option key={t} value={t}>{t}</option>)}
              </select></label>
            <label className="pof-f"><span className="pof-l">Freight terms</span>
              <select value={head.freight_terms} onChange={(e) => set('freight_terms', e.target.value)}>
                <option value="">— Select —</option>{FREIGHT_TERMS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select></label>
            <label className="pof-f"><span className="pof-l">Freight charges</span>
              <span className={`pof-affix${freightBad ? ' is-bad' : ''}`}><i>₹</i><input inputMode="decimal" value={head.freight} placeholder="0.00"
                onChange={(e) => set('freight', e.target.value)} /></span>
              {freightBad && <small className="pof-err">Enter an amount like 1250 or 1250.50</small>}</label>
            <label className="pof-f"><span className="pof-l">Other charges</span>
              <span className={`pof-affix${otherBad ? ' is-bad' : ''}`}><i>₹</i><input inputMode="decimal" value={head.other_charges} placeholder="Packing, loading…"
                onChange={(e) => set('other_charges', e.target.value)} /></span>
              {otherBad && <small className="pof-err">Enter an amount like 1250 or 1250.50</small>}</label>
            <label className="pof-f"><span className="pof-l">GST on charges</span>
              <select value={chargesRate} onChange={(e) => setChargesRate(e.target.value)}>
                <option value="">Auto — highest item rate ({autoRate}%)</option>
                {['0', '5', '12', '18', '28'].map((g) => <option key={g} value={g}>{g}%</option>)}
              </select>
              <small className="sdt-note">{charges > 0 ? `${rupees(charges)} + GST ${rupees(Math.round(charges * effRate) / 100)}` : 'Applied when charges are entered'}</small></label>
          </div>
        </section>

        <section className="pof-sec sdt sof-p-b">
          <header className="pof-sec-head"><h3>Addresses</h3></header>
          <div className="sof-stack">
            <label className="pof-f"><span className="pof-l">Billing address</span>
              <textarea rows={3} value={head.billing_address} onChange={(e) => set('billing_address', e.target.value)}
                placeholder={customer ? 'No billing address on the customer — type it here' : 'Choose a customer first'} />
              <small className="sdt-note">{customer ? 'From the customer master — edit for this order only' : ''}</small></label>
            <div className="pof-f"><span className="pof-l">Ship to</span>
              <div className="sof-seg sdt-ship" role="radiogroup" aria-label="Ship to">
                {([['same', 'Same as billing'], ['site', 'Customer site'], ['other', 'Different']] as const)
                  .filter(([k]) => k !== 'site' || shipSites.length > 0)
                  .map(([k, l]) => (
                    <button key={k} type="button" role="radio" aria-checked={shipMode === k} className={shipMode === k ? 'is-on' : ''}
                      onClick={() => pickShip(k)}>{l}</button>
                  ))}
              </div>
              {shipMode === 'site' && (
                <select className="sdt-under" value={shipSite} onChange={(e) => { setShipSite(e.target.value); set('shipping_address', siteAddress(e.target.value)) }}>
                  <option value="">— Choose site —</option>
                  {shipSites.map((x) => <option key={x.id} value={x.id}>{x.name}{x.state ? ` · ${x.state}` : ''}</option>)}
                </select>
              )}
              {shipMode === 'same'
                ? <div className="sdt-addr">{head.billing_address || <span>Same as the billing address</span>}</div>
                : <textarea className={`sdt-under${shipBad ? ' is-bad' : ''}`} rows={shipMode === 'site' ? 2 : 3} value={head.shipping_address}
                  onChange={(e) => set('shipping_address', e.target.value)} placeholder="Full delivery address with PIN code" />}
              {shipBad && <small className="pof-err">Enter the delivery address</small>}
            </div>
            <label className="pof-f"><span className="pof-l">Delivery instructions</span>
              <textarea rows={3} value={head.delivery_instructions} maxLength={2000} onChange={(e) => set('delivery_instructions', e.target.value)}
                placeholder="Optional — e.g. unload at gate 2; call the site engineer before arrival" /></label>
          </div>
        </section>

        <div className="sof-p-sum">
        <PoSummary lines={lines} freight={Number(head.freight || 0)} other={Number(head.other_charges || 0)}
          companyState={next.data?.company_state ?? null} vendorState={head.place_of_supply || null} vendorChosen={Boolean(head.place_of_supply)} party="place of supply"
          chargesGst={effRate} />
        </div>

        <div className="sof-p-ms">
        <section className="pof-sec">
          <header className="pof-sec-head">
            <h3>Billing milestones</h3>
            <span>optional — advance, delivery, installation, UAT…</span>
          </header>
          {milestones.length > 0 && (
            <div className="sof-ms">
              <div className="sof-ms-head"><span>Milestone</span><span>Kind</span><span>Taxable ₹</span><span>GST %</span><span>Due</span><span /></div>
              {milestones.map((m, i) => {
                const upd = (patch: Partial<typeof m>) => setMilestones(milestones.map((x, j) => (j === i ? { ...x, ...patch } : x)))
                return (
                  <div key={i} className="sof-ms-row">
                    <input value={m.name} placeholder="e.g. 30% advance" maxLength={160} className={msBad(m) && !m.name.trim() ? 'is-bad' : ''}
                      onChange={(e) => upd({ name: e.target.value })} />
                    <select value={m.kind} onChange={(e) => upd({ kind: e.target.value })}>{MILESTONE_KINDS.map((k) => <option key={k} value={k}>{titleCase(k)}</option>)}</select>
                    <input placeholder="0" inputMode="decimal" value={m.taxable_amount} className={msBad(m) && !(Number(m.taxable_amount) > 0 && moneyOk(m.taxable_amount)) ? 'is-bad' : ''}
                      onChange={(e) => upd({ taxable_amount: e.target.value })} />
                    <input placeholder="18" inputMode="decimal" value={m.gst_percent} className={msBad(m) && !(Number(m.gst_percent) >= 0 && Number(m.gst_percent) <= 28 && m.gst_percent.trim() !== '') ? 'is-bad' : ''}
                      onChange={(e) => upd({ gst_percent: e.target.value })} />
                    <input type="date" value={m.due_date} onChange={(e) => upd({ due_date: e.target.value })} />
                    <button type="button" className="crm-icon-btn crm-icon-danger" aria-label="Remove milestone" onClick={() => setMilestones(milestones.filter((_, j) => j !== i))}><IconTrash size={13} /></button>
                  </div>
                )
              })}
            </div>
          )}
          {milestonesBad && <small className="pof-err">Each milestone needs a name, an amount above 0 and GST of 0–28 %.</small>}
          {!milestonesBad && msOver && <small className="pof-err">Milestones add up to {rupees(msTotal)}, more than the order's taxable value of {rupees(msSub)}.</small>}
          <button type="button" className="btn btn-sm sof-add" onClick={() => setMilestones([...milestones, { name: '', kind: 'custom', taxable_amount: '', gst_percent: '18', due_date: '' }])}>
            <IconPlus size={13} /> Add milestone
          </button>
        </section>
        </div>

        <div className="sof-p-notes">
          <section className="pof-sec">
            <header className="pof-sec-head"><h3>Notes &amp; terms</h3></header>
            <div className="sof-notes">
              <label className="pof-f"><span className="pof-l">Notes to customer</span>
                <textarea rows={2} value={head.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Printed on the order" /></label>
              <label className="pof-f"><span className="pof-l">Terms &amp; conditions</span>
                <textarea rows={2} value={head.terms} onChange={(e) => set('terms', e.target.value)} placeholder="Warranty, jurisdiction, validity…" /></label>
              <label className="pof-f"><span className="pof-l">Internal notes <small className="sof-private">not printed</small></span>
                <textarea rows={2} value={head.internal_notes} onChange={(e) => set('internal_notes', e.target.value)} placeholder="For the team only" /></label>
              {deviation && (
                <label className="pof-f"><span className="pof-l">Deviation note</span>
                  <input value={head.deviation_note} onChange={(e) => set('deviation_note', e.target.value)} placeholder="Why the order differs from the quotation / PO value" /></label>
              )}
            </div>
          </section>
        </div>

        <div className="sof-p-files">
          <section className="pof-sec">
            <header className="pof-sec-head"><h3>Attachments</h3><span>{kept.length + pending.length} / 10</span></header>
            <button type="button" className="sof-drop" onClick={() => fileInput.current?.click()}
              onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files) }}>
              <IconPlus size={16} />
              <b>Drag &amp; drop files here, or click to upload</b>
              <small>Customer PO copy, drawings, BOQ — PDF, JPG, PNG · max 5 MB each</small>
            </button>
            <input ref={fileInput} type="file" multiple accept="image/*,application/pdf" hidden onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />
            {fileError && <small className="pof-err">{fileError}</small>}
            {(kept.length > 0 || pending.length > 0) && (
              <ul className="sof-files">
                {kept.map((f) => (
                  <li key={f.id}>
                    <span className="sof-file-ic"><IconSheet size={13} /></span>
                    <button type="button" className="sof-file-name" onClick={() => so && void erp.soAttachment(so.id, f.id).then((x) => openData(x.data))}>{f.name}</button>
                    <small>{f.by_name}</small>
                    <button type="button" className="crm-icon-btn crm-icon-danger" aria-label={`Remove ${f.name}`}
                      onClick={() => so && void run(async () => { const out = await erp.removeSoAttachment(so.id, f.id); setKept(out.attachments ?? []) })}><IconTrash size={12} /></button>
                  </li>
                ))}
                {pending.map((f, i) => (
                  <li key={`p${i}`} className="is-new">
                    <span className="sof-file-ic"><IconSheet size={13} /></span>
                    <button type="button" className="sof-file-name" onClick={() => void openData(f.data)}>{f.name}</button>
                    <small>Uploads on save</small>
                    <button type="button" className="crm-icon-btn crm-icon-danger" aria-label={`Remove ${f.name}`}
                      onClick={() => setPending((p) => p.filter((_, j) => j !== i))}><IconTrash size={12} /></button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      <footer className="pof-page-foot">
        <span className="pof-page-total">Order total <b>{rupees(Math.round(total * 100) / 100)}</b></span>
        {error && <span className="error">{error}</span>}
        {problem ? <span className="sof-hint">{problem}</span> : <span className="sof-ok">Ready to save</span>}
        <span className="crm-push" />
        <button className="btn" disabled={busy} onClick={onClose}>{so ? 'Cancel' : 'Clear'}</button>
        <button className="btn" disabled={!ready} onClick={() => save()}>{busy ? 'Saving…' : 'Save as draft'}</button>
        <button className="btn btn-primary" disabled={!ready} onClick={() => save(true)}><IconCheck size={14} /> Submit for approval</button>
      </footer>
    </div>
  )
}

/** Mail the order's PDF to the customer. The address starts as the one on the
 *  customer master, and can be changed for this mail. */
function SendOrder({ so, onClose, onSent }: { so: SalesOrder; onClose: () => void; onSent: (to: string) => void }) {
  const { user } = useAuth()
  const [to, setTo] = useState(so.customer_email ?? '')
  const [subject, setSubject] = useState(`Sales order ${so.number}`)
  const [message, setMessage] = useState([
    `Dear ${so.customer_name},`, '',
    `Please find attached our sales order ${so.number}${so.customer_po_number ? ` against your PO ${so.customer_po_number}` : ''}, for ${rupees(so.grand_total)}.`,
    '', 'Regards,', user?.full_name ?? '',
  ].join('\n'))
  const { busy, error, run } = useRun()
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim()) && subject.trim() && message.trim()
  return (
    <Dialog title={`Send ${so.number} to the customer`} subtitle="The order goes as a PDF attachment. Internal notes are never included." onClose={onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !ok} onClick={() => void run(async () => {
          const pdf = await salesOrderPdfBase64(so)
          await erp.sendSalesOrder(so.id, { to: to.trim(), subject: subject.trim(), message, pdf })
          onSent(to.trim())
        }, 'The order could not be sent')}><IconMail size={14} /> {busy ? 'Sending…' : 'Send'}</button>
      </>
    }>
      <div className="crm-form" style={{ padding: '0 20px 12px', gridTemplateColumns: '1fr' }}>
        <Field label="To"><input type="email" value={to} autoFocus placeholder="customer@company.com" onChange={(e) => setTo(e.target.value)} /></Field>
        {!so.customer_email && <small className="crm-muted">No email on this customer. Type one here, or add it in CRM › My customers.</small>}
        <Field label="Subject"><input value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} /></Field>
        <Field label="Message"><textarea rows={7} value={message} maxLength={4000} onChange={(e) => setMessage(e.target.value)} /></Field>
      </div>
    </Dialog>
  )
}

/** What this order can be billed for now: dispatches not yet invoiced, milestones
 *  that are ready, and its service lines and charges. Each makes a draft invoice
 *  and opens it. Nothing is posted from here. */
function CreateInvoice({ so, onClose }: { so: SalesOrder; onClose: () => void }) {
  const navigate = useNavigate()
  const { busy, error, run } = useRun()
  const open = (id: string) => navigate(`/erp/billing?open=${id}`)
  const dispatches = so.dispatches.filter((d) => d.uninvoiced)
  const byMilestones = so.milestones.some((m) => m.kind === 'dispatch' || m.kind === 'delivery')
  const ready = so.milestones.filter((m) => m.status === 'ready')
  const waiting = so.milestones.filter((m) => m.status === 'pending')
  const services = so.lines.filter((l) => l.fulfilment === 'service')
  const freight = Number(so.freight ?? 0)
  const other = Number(so.other_charges ?? 0)
  const chargeRate = Number(so.charges_gst_percent ?? 18)
  const live = so.invoices.filter((i) => !['cancelled', 'rejected'].includes(i.status) && ['product', 'service', 'milestone'].includes(i.kind))
  const hasManual = live.some((i) => i.kind === 'service')
  const manualValue = services.reduce((t, l) => t + Number(l.amount ?? 0), 0) + (freight + other) * (1 + chargeRate / 100)
  const showManual = !hasManual && (services.length > 0 || freight + other > 0)
  const manualLabel = services.length && freight + other ? 'Service lines and charges' : services.length ? 'Service lines' : 'Freight and other charges'
  const billed = live.reduce((t, i) => t + Number(i.grand_total), 0)
  const over = (amount: number) => billed + amount > Number(so.grand_total) + 0.5

  function raiseManual() {
    const charge = (description: string, rate: number) => ({ description, quantity: '1', rate: String(rate), gst_percent: String(chargeRate), is_charge: true })
    return erp.saveInvoice({
      kind: 'service', customer_id: so.customer_id, sales_order_id: so.id, place_of_supply: so.place_of_supply,
      billing_address: so.billing_address, shipping_address: so.shipping_address, salesperson_id: so.salesperson_id ?? null,
      customer_po_number: so.customer_po_number, notes: so.notes, terms: so.terms ?? null,
      lines: [
        ...services.map((l) => ({
          item_id: l.item_id ?? null, description: l.description, hsn_sac: l.hsn_sac ?? null, uom: l.uom ?? null, quantity: l.quantity,
          rate: l.rate, discount_percent: l.discount_percent ?? '0', gst_percent: l.gst_percent ?? '18',
        })),
        ...(freight > 0 ? [charge('Freight charges', freight)] : []),
        ...(other > 0 ? [charge('Other charges', other)] : []),
      ],
    })
  }
  const row = (key: string, title: ReactNode, sub: ReactNode, amount: number, make: () => Promise<{ id: string }>) => (
    <li key={key}>
      <span className="sov-row-main">{title}<small>{sub}</small>
        {over(amount) && <small className="sol-over">This takes billing past the order value of {rupees(so.grand_total)}.</small>}
      </span>
      <b className="pol-amt">{rupees(Math.round(amount * 100) / 100)}</b>
      <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void run(async () => open((await make()).id), 'The invoice could not be created')}>Create draft</button>
    </li>
  )
  const nothing = !dispatches.length && !ready.length && !showManual
  return (
    <Dialog title={`Create invoice for ${so.number}`} subtitle={`${so.customer_name} · ${rupees(so.pending_amount)} still to invoice`} onClose={onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        <button className="btn" onClick={onClose}>Close</button>
      </>
    }>
      <div style={{ padding: '0 20px 12px' }}>
        {byMilestones && (
          <p className="crm-muted" style={{ margin: '0 0 10px' }}>
            The goods on this order are billed by its dispatch or delivery milestone. A dispatch only makes that milestone ready, so they are not invoiced twice.
          </p>
        )}
        {nothing ? (
          <p className="crm-muted">
            {waiting.length ? 'Nothing is ready to invoice. Mark a billing milestone ready from View, or dispatch the goods.'
              : so.delivery_status === 'pending' || so.delivery_status === 'partial' ? 'Nothing is ready to invoice. Dispatch the goods from View first.'
                : 'Everything on this order has been invoiced.'}
          </p>
        ) : (
          <ul className="sov-rows sol-bill">
            {dispatches.map((d) => row(d.id, `Dispatch ${d.number}`, <>Goods shipped on <DateText iso={d.dispatch_date} /></>, Number(d.unbilled_value), () => erp.invoiceFromDispatch(d.id)))}
            {ready.map((m) => row(m.id, m.name, `${titleCase(m.kind)} milestone`, Number(m.taxable_amount) * (1 + Number(m.gst_percent) / 100), () => erp.invoiceFromMilestone(m.id)))}
            {showManual && row('manual', manualLabel, 'A draft you can still edit', manualValue, raiseManual)}
          </ul>
        )}
      </div>
    </Dialog>
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

/** The order opened from the list or just after saving: centred, sized to the
 *  screen, with the body scrolling between a fixed header and action bar. */
function OrderModal({ title, meta, onClose, children, footer, actions, covered }: {
  title: ReactNode
  meta?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  actions?: ReactNode
  /** Something is open on top: Escape belongs to that, not to this window. */
  covered?: boolean
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !covered) onClose() }
    window.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = previous }
  }, [onClose, covered])
  return (
    <div className="crm-backdrop sov-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sov" role="dialog" aria-modal="true">
        <header className="sov-head">
          <span className="sov-icon" aria-hidden><IconSheet size={18} /></span>
          <div className="sov-id">
            <h2>{title}</h2>
            {meta && <p>{meta}</p>}
          </div>
          {actions && <div className="sov-head-actions">{actions}</div>}
          <button className="crm-icon-btn" onClick={onClose} aria-label="Close"><IconClose size={16} /></button>
        </header>
        <div className="sov-body">{children}</div>
        {footer && <footer className="sov-foot">{footer}</footer>}
      </div>
    </div>
  )
}

/** A date with its year: an order is read long after the year it was booked in. */
function fullDate(iso: string): string {
  const day = iso.length > 10 ? new Date(asUTC(iso)) : new Date(`${iso}T00:00:00`)
  return day.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}
function FullDate({ iso }: { iso: string | null | undefined }) {
  return iso ? <span className="crm-nowrap">{fullDate(iso)}</span> : <span className="crm-muted">—</span>
}

type StepState = 'done' | 'part' | 'now' | 'todo' | 'bad'
interface OrderStep { label: string; note: string; state: StepState }

/** Where the order has got to, read from its linked dispatches, invoices and
 *  receipts. A service-only order has nothing to dispatch, so no such step. */
function orderSteps(so: SalesOrderDetail): OrderStep[] {
  const pay = so.payment_summary
  const steps: OrderStep[] = [{ label: 'Booked', note: fullDate(so.order_date), state: 'done' }]

  if (so.status === 'rejected') steps.push({ label: 'Rejected', note: so.reviewed_at ? fullDate(so.reviewed_at) : 'Needs revising', state: 'bad' })
  else if (so.approval_status === 'approved') steps.push({ label: 'Approved', note: so.reviewed_at ? fullDate(so.reviewed_at) : (so.reviewed_by_name ?? ''), state: 'done' })
  else if (so.status === 'submitted') steps.push({ label: 'Approval', note: 'Waiting for approval', state: 'now' })
  else steps.push({ label: 'Approval', note: 'Not submitted', state: so.status === 'draft' ? 'now' : 'todo' })

  const goods = so.lines.filter((l) => l.fulfilment !== 'service')
  if (goods.length > 0) {
    const sent = goods.some((l) => Number(l.dispatched_qty) > 0)
    const all = sent && goods.every((l) => Number(l.pending_qty) <= 0)
    const live = so.dispatch_details.filter((d) => d.status !== 'cancelled')
    const last = live.map((d) => d.dispatch_date).filter(Boolean).sort().pop()
    const reached = live.length > 0 && live.every((d) => d.status === 'delivered')
    steps.push({
      label: reached && all ? 'Delivered' : 'Dispatched',
      note: all ? (reached ? 'All delivered' : last ? fullDate(last) : 'Fully dispatched') : sent ? 'Part dispatched' : 'Nothing sent yet',
      state: all ? 'done' : sent ? 'part' : 'todo',
    })
  }

  const invoiced = Number(pay.invoiced)
  const toBill = Number(pay.to_bill)
  steps.push({
    label: 'Invoiced',
    note: invoiced > 0 ? (toBill > 0 ? `${rupees(toBill)} still to bill` : rupees(invoiced)) : toBill > 0 ? 'No invoice yet' : 'Nothing to bill',
    state: invoiced > 0 ? (toBill > 0 ? 'part' : 'done') : 'todo',
  })

  const received = Number(pay.received)
  const owed = Number(pay.outstanding)
  const paid = received > 0 && owed <= 0 && toBill <= 0
  steps.push({
    label: 'Paid',
    note: received > 0 ? (paid ? rupees(received) : `${rupees(received)} received`) : 'Nothing received',
    state: paid ? 'done' : received > 0 ? 'part' : 'todo',
  })

  // The first step still to be done is the one the order is on.
  if (!['cancelled', 'closed'].includes(so.status) && so.approval_status === 'approved') {
    const next = steps.find((step) => step.state === 'todo')
    if (next && !steps.some((step) => step.state === 'part')) next.state = 'now'
  }
  return steps
}

function OrderProgress({ so }: { so: SalesOrderDetail }) {
  return (
    <ol className={`sov-steps${['cancelled', 'closed'].includes(so.status) ? ' is-ended' : ''}`} aria-label="Order progress">
      {orderSteps(so).map((step) => (
        <li key={step.label} className={`sov-step is-${step.state}`}>
          <span className="sov-step-dot" aria-hidden>
            {step.state === 'done' ? <IconCheck size={12} /> : step.state === 'bad' ? <IconClose size={12} /> : null}
          </span>
          <b>{step.label}</b>
          <small>{step.note}</small>
        </li>
      ))}
    </ol>
  )
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="sov-detail">
      <dt>{label}</dt>
      <dd>{children || <span className="crm-muted">—</span>}</dd>
    </div>
  )
}

type SoTab = 'overview' | 'items' | 'dispatch' | 'billing' | 'approvals' | 'activity'
const SO_TABS: [SoTab, string][] = [
  ['overview', 'Overview'], ['items', 'Items'], ['dispatch', 'Dispatch & delivery'],
  ['billing', 'Invoices & payments'], ['approvals', 'Approvals'], ['activity', 'Activity'],
]

type Activity = SalesOrderDetail['activity'][number]
const ACTIVITY_LABELS: Record<string, string> = {
  'sales_order.saved': 'Order saved', 'sales_order.submitted': 'Submitted for approval', 'sales_order.revised': 'Sent back to draft',
  'sales_order.approved': 'Approved', 'sales_order.rejected': 'Rejected', 'sales_order.reserved': 'Stock reserved',
  'sales_order.unreserved': 'Reservation released', 'sales_order.milestone_ready': 'Milestone marked ready',
  'sales_order.cancelled': 'Order cancelled', 'sales_order.closed': 'Order closed', 'sales_order.sent': 'Order sent to customer',
  'sales_order.amended': 'Sent back to draft to amend', 'sales_order.duplicated': 'Copied from another order',
  'dispatch.returned': 'Goods returned', 'sales_order.attachment_added': 'Attachment added', 'sales_order.attachment_removed': 'Attachment removed',
  'dispatch.transport_changed': 'Transport details changed', 'dispatch.created': 'Goods dispatched', 'dispatch.delivered': 'Delivery confirmed', 'dispatch.cancelled': 'Dispatch cancelled',
  'invoice.saved': 'Invoice drafted', 'invoice.posted': 'Invoice posted', 'invoice.cancelled': 'Invoice cancelled',
  'receipt.recorded': 'Payment received', 'receipt.reversed': 'Payment reversed',
}
function activityLabel(a: Activity): string {
  if (a.action === 'sales_order.hold') return a.detail.hold ? 'Put on hold' : 'Hold released'
  if (a.action === 'sales_order.decided') return a.detail.decision === 'rejected' ? 'Rejected' : 'Approved'
  return ACTIVITY_LABELS[a.action] ?? titleCase(a.action.replace(/[._]/g, ' '))
}
function activityTone(action: string): string {
  if (action === 'sales_order.decided') return 'approved'
  if (/cancel|reject|revers|removed/.test(action)) return 'rejected'
  if (/approved|delivered|posted|receipt/.test(action)) return 'approved'
  return 'done'
}
function activityDetail(a: Activity): string {
  const d = a.detail
  if (a.action === 'dispatch.transport_changed' && d.changes && typeof d.changes === 'object') {
    const list = Object.entries(d.changes as Record<string, { from: string | null; to: string | null }>)
      .map(([k, v]) => `${TRANSPORT_LABEL[k] ?? k}: ${v.from ?? '—'} → ${v.to ?? '—'}`)
    return [typeof d.number === 'string' ? d.number : null, ...list].filter(Boolean).join(' · ')
  }
  const bits = [
    typeof d.number === 'string' && !a.action.startsWith('sales_order.') ? d.number : null,
    typeof d.from === 'string' ? `from ${d.from}` : null,
    typeof d.reason === 'string' ? d.reason : null,
    typeof d.warehouse === 'string' ? `from ${d.warehouse}` : null,
    typeof d.received_by === 'string' ? `received by ${d.received_by}` : null,
    typeof d.to === 'string' ? `to ${d.to}` : null,
    typeof d.name === 'string' ? d.name : null,
    typeof d.grand_total === 'string' ? rupees(d.grand_total) : typeof d.value === 'string' ? rupees(d.value) : null,
  ].filter(Boolean)
  return bits.join(' · ')
}

function OrderDrawer({ id, flash, onClose, onEdit, onChanged }: { id: string; flash?: string | null; onClose: () => void; onEdit: (so: SalesOrder) => void; onChanged: () => void }) {
  const navigate = useNavigate()
  const { can } = useAccess()
  const { user } = useAuth()
  const q = useQuery(`erp-so-${id}`, () => erp.salesOrder(id))
  const warehouses = useQuery('erp-wh-active', () => erp.warehouses(true))
  const { busy, error, run } = useRun(() => { q.reload(); onChanged() })
  const [prompt, setPrompt] = useState<null | { title: string; hint?: string; act: (reason: string) => Promise<unknown>; danger?: boolean }>(null)
  const [challan, setChallan] = useState<string | null>(null)
  const [delivering, setDelivering] = useState<string | null>(null)
  const [transporting, setTransporting] = useState<string | null>(null)
  const [returning, setReturning] = useState<string | null>(null)
  const [reserveWh, setReserveWh] = useState('')
  const [dispatching, setDispatching] = useState(false)
  const [tab, setTab] = useState<SoTab>('overview')
  const [more, setMore] = useState(false)
  const [printing, setPrinting] = useState(false)
  const [sending, setSending] = useState(false)
  const [invoicing, setInvoicing] = useState(false)
  const [pdfBusy, setPdfBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [pdfError, setPdfError] = useState<string | null>(null)
  const so = q.data
  if (!so) return <OrderModal title="Sales order" onClose={onClose}><Loading /></OrderModal>
  const pay = so.payment_summary
  const sales = can('can_manage_sales_orders')
  const open = ['approved', 'partially_dispatched'].includes(so.status)
  const grand = Number(so.grand_total)
  const billedPct = grand > 0 ? Math.min((Number(pay.invoiced) / grand) * 100, 100) : 0
  const typeLabel = ORDER_TYPES.find(([k]) => k === so.order_type)?.[1]
  const priority = so.priority && so.priority !== 'normal' ? titleCase(so.priority) : null

  const approved = so.approval_status === 'approved' && so.status !== 'cancelled'
  const toShip = open && sales && so.lines.some((l) => l.fulfilment !== 'service' && Number(l.pending_qty) > 0)
  const canSend = approved && sales
  const canInvoice = approved && can('can_manage_billing') && Number(pay.to_bill) > 0
  const canHold = (open || so.status === 'on_hold') && can('can_approve_sales_orders')
  const canClose = ['approved', 'partially_dispatched', 'dispatched', 'on_hold'].includes(so.status) && can('can_approve_sales_orders')
  const canCancelShown = sales && !['cancelled', 'closed'].includes(so.status)
  const cancelWhy = cancelBlock(so, sales)
  const canAmend = so.status === 'approved' && sales
  const amendWhy = amendBlock(so)
  const hasMore = canHold || canClose || toShip || canCancelShown || canAmend || sales
  const pick = (act: () => void) => () => { setMore(false); act() }

  async function downloadPdf() {
    if (!so) return
    setPdfBusy(true)
    setPdfError(null)
    try {
      await downloadSalesOrderPdf(so)
    } catch {
      setPdfError(`${so.number} could not be downloaded. Open Print and use Save as PDF instead.`)
    } finally {
      setPdfBusy(false)
    }
  }

  return (
    <>
    <OrderModal
      title={<>{so.number} <ErpState value={so.status} /></>}
      meta={<>
        {so.customer_name}{typeLabel && <> · {typeLabel}</>}
        {priority && <> · <b className={`sov-prio is-${so.priority}`}>{priority} priority</b></>}
        {so.reviewed_by_name && ['approved', 'rejected'].includes(so.status) && (
          <span className="sov-decided"> · {so.status === 'rejected' ? 'Rejected' : 'Approved'} by {so.reviewed_by_name}{so.reviewed_at ? ` on ${fullDate(so.reviewed_at)}` : ''}</span>
        )}
      </>}
      onClose={onClose}
      covered={Boolean(printing || sending || invoicing || dispatching || prompt || challan || delivering || returning || transporting)}
      actions={<>
        <button type="button" className="btn btn-sm" onClick={() => setPrinting(true)}><IconPrinter size={14} /> Print</button>
        <button type="button" className="btn btn-sm" disabled={pdfBusy} onClick={() => void downloadPdf()}>
          {pdfBusy ? <span className="ivl-spin" aria-hidden /> : <IconDownload size={14} />} Download PDF
        </button>
      </>}
      footer={<>
        {error && <span className="error">{error}</span>}
        {hasMore && (
          <div className="sov-more">
            <button type="button" className="btn" aria-haspopup="menu" aria-expanded={more} onClick={() => setMore((v) => !v)}>
              More actions <IconChevronDown size={14} />
            </button>
            {more && <>
              <div className="sov-more-scrim" onClick={() => setMore(false)} />
              <div className="sov-more-menu" role="menu">
                {toShip && <button type="button" role="menuitem" disabled={busy} onClick={pick(() => void run(async () => {
                  const req = await erp.shortageRequisition(so.id)
                  navigate(`/erp/requisitions?open=${req.id}`)
                }))}>Raise shortage requisition</button>}
                {canAmend && <button type="button" role="menuitem" disabled={Boolean(amendWhy)} title={amendWhy ?? undefined}
                  onClick={pick(() => setPrompt({ title: `Amend ${so.number}`, hint: 'It goes back to draft and has to be approved again. Any reservation is released.', act: (r) => erp.amendSalesOrder(so.id, r) }))}>Amend order</button>}
                {sales && <button type="button" role="menuitem" disabled={busy} onClick={pick(() => void run(async () => {
                  onEdit(await erp.duplicateSalesOrder(so.id))
                }))}>Duplicate order</button>}
                {canHold && <button type="button" role="menuitem" onClick={pick(() => setPrompt({ title: so.status === 'on_hold' ? 'Release hold' : 'Put on hold', act: (r) => erp.holdSalesOrder(so.id, so.status !== 'on_hold', r) }))}>
                  {so.status === 'on_hold' ? 'Release hold' : 'Put on hold'}</button>}
                {canClose && <button type="button" role="menuitem" onClick={pick(() => setPrompt({ title: `Close ${so.number}`, act: (r) => erp.salesOrderReason(so.id, 'close', r) }))}>Close order</button>}
                {canCancelShown && <button type="button" role="menuitem" className="is-danger" disabled={Boolean(cancelWhy)} title={cancelWhy ?? undefined}
                  onClick={pick(() => setPrompt({ title: `Cancel ${so.number}`, danger: true, act: (r) => erp.salesOrderReason(so.id, 'cancel', r) }))}>Cancel order</button>}
              </div>
            </>}
          </div>
        )}
        <div className="sov-actions sov-actions-main">
          {so.status === 'draft' && sales && <>
            <button className="btn" onClick={() => onEdit(so)}>Edit</button>
            <button className="btn btn-primary" disabled={busy} onClick={() => void run(() => erp.salesOrderAction(so.id, 'submit'))}><IconCheck size={14} /> Submit for approval</button>
          </>}
          {so.status === 'rejected' && sales && <button className="btn btn-primary" onClick={() => void run(() => erp.salesOrderAction(so.id, 'revise'))}>Revise</button>}
          {so.status === 'submitted' && (so.created_by !== user?.id || user?.role === 'owner') && <DecideBar onDecide={async (a, n) => { await erp.decideSalesOrder(so.id, a, n); q.reload(); onChanged() }} />}
          {canSend && <button className="btn" onClick={() => setSending(true)}><IconMail size={14} /> Send to customer</button>}
          {canInvoice && <button className={`btn${toShip ? '' : ' btn-primary'}`} onClick={() => setInvoicing(true)}><IconCard size={14} /> Create invoice</button>}
          {toShip && <button className="btn btn-primary" onClick={() => setDispatching(true)}>Dispatch</button>}
        </div>
      </>}
    >
      {flash && flash.startsWith(so.number) && <div className="notice notice-ok" role="status" style={{ margin: 0 }}>{flash}</div>}
      {so.has_deviation && <Note>Differs from {so.quotation_number ? `quotation ${so.quotation_number} (${rupees(so.quoted_total)})` : 'the customer PO value'}{so.deviation_note ? ` — ${so.deviation_note}` : ' — a deviation note is needed before submitting'}.</Note>}
      {so.hold_reason && <Note>On hold: {so.hold_reason}</Note>}
      {so.review_note && <Note>{so.status === 'rejected' ? 'Rejected' : 'Approval note'}: {so.review_note}</Note>}
      {so.closed_reason && <Note>{so.closed_reason}</Note>}
      {note && <div className="notice notice-ok" role="status" style={{ margin: 0 }}>{note}</div>}
      {pdfError && <ErrorNote>{pdfError}</ErrorNote>}

      <OrderProgress so={so} />

      <div className="sov-layout">
      <div className="sov-main">
      <div className="sov-tabs" role="tablist">
        {SO_TABS.map(([key, text]) => {
          const count = key === 'dispatch' ? so.dispatch_details.length : key === 'billing' ? so.invoice_details.length
            : key === 'activity' ? so.activity.length : key === 'items' ? so.lines.length : 0
          return (
            <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'is-on' : ''} onClick={() => setTab(key)}>
              {text}{count > 0 && <span className="sov-count">{count}</span>}
            </button>
          )
        })}
      </div>

      {tab === 'overview' && <>
        <div className="sov-cols">
          <section className="sov-card">
            <h3>Order details</h3>
            <dl className="sov-details sov-details-4">
              <Detail label="Order date"><FullDate iso={so.order_date} /></Detail>
              <Detail label="Required by"><FullDate iso={so.required_by} /></Detail>
              <Detail label="Order type">{typeLabel}</Detail>
              <Detail label="Customer PO">{so.customer_po_number ? `${so.customer_po_number}${so.customer_po_date ? ` · ${fullDate(so.customer_po_date)}` : ''}` : null}</Detail>
              <Detail label="PO value">{so.customer_po_value ? rupees(so.customer_po_value) : null}</Detail>
              <Detail label="Reference">{so.reference}</Detail>
              <Detail label="Place of supply">{so.place_of_supply ? `${so.place_of_supply}${so.is_interstate ? ' (IGST)' : ''}` : null}</Detail>
              <Detail label="Payment terms">{so.payment_terms}</Detail>
              <Detail label="Delivery terms">{so.delivery_terms}</Detail>
              <Detail label="Salesperson">{so.salesperson_name}</Detail>
              <Detail label="Booked by">{so.created_by_name}</Detail>
              <Detail label={so.status === 'rejected' ? 'Rejected by' : 'Approved by'}>{so.reviewed_by_name}</Detail>
            </dl>
          </section>
        </div>
        <div className="sov-cols">
          {so.quotation && <section className="sov-card">
            <div className="sov-card-head">
              <h3>Linked quotation</h3>
              <button type="button" className="btn btn-sm" onClick={() => navigate(`/crm/quotations/${so.quotation!.id}`)}>Open quotation</button>
            </div>
            {(
              <dl className="sov-details">
                <Detail label="Quotation no.">{so.quotation.number}</Detail>
                <Detail label="Status"><ErpState value={so.quotation.status} /></Detail>
                <Detail label="Date"><FullDate iso={so.quotation.quote_date} /></Detail>
                <Detail label="Quoted value">{rupees(so.quotation.grand_total)}</Detail>
                <Detail label="Order vs quote">
                  {Number(so.quotation.grand_total) === Number(so.grand_total)
                    ? 'Matches the quotation'
                    : <span className="sov-bad">{rupees(Number(so.grand_total) - Number(so.quotation.grand_total))} difference</span>}
                </Detail>
              </dl>
            )}
          </section>}
          <section className="sov-card">
            <h3>Addresses</h3>
            <dl className="sov-details">
              <Detail label="Bill to">{so.billing_address}</Detail>
              <Detail label="Ship to">{[so.site_name, so.shipping_address].filter(Boolean).join(' — ')}</Detail>
              {so.delivery_instructions && <Detail label="Delivery instructions">{so.delivery_instructions}</Detail>}
            </dl>
          </section>
        </div>
        {(so.notes || so.terms || so.internal_notes || so.attachments?.length) ? (
          <div className="sov-cols">
            {(so.notes || so.terms || so.internal_notes) && (
              <section className="sov-card">
                <h3>Notes &amp; terms</h3>
                <dl className="sov-details sov-details-1">
                  {so.notes && <Detail label="Notes to customer">{so.notes}</Detail>}
                  {so.terms && <Detail label="Terms & conditions">{so.terms}</Detail>}
                  {so.internal_notes && <Detail label="Internal notes">{so.internal_notes}</Detail>}
                </dl>
              </section>
            )}
            {so.attachments && so.attachments.length > 0 && (
              <section className="sov-card">
                <h3>Attachments <span className="sov-count">{so.attachments.length}</span></h3>
                <ul className="sov-rows">
                  {so.attachments.map((f) => (
                    <li key={f.id}>
                      <button type="button" className="link-btn sov-row-main" onClick={() => void erp.soAttachment(so.id, f.id).then((x) => openData(x.data))}>
                        {f.name}<small>{f.by_name}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        ) : null}
      </>}

      {tab === 'items' && <>
        <section className="sov-card">
          <div className="sov-card-head">
            <h3>Items <span className="sov-count">{so.lines.length}</span></h3>
            {open && sales && (
              <div className="sov-reserve">
                <select value={reserveWh} onChange={(e) => setReserveWh(e.target.value)} aria-label="Reserve from warehouse">
                  <option value="">Reserve from…</option>{(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
                <button className="btn btn-sm" disabled={busy || !reserveWh} onClick={() => void run(() => erp.reserve(so.id, reserveWh))}>Reserve</button>
                <button className="btn btn-sm" disabled={busy} onClick={() => void run(() => erp.salesOrderAction(so.id, 'unreserve'))}>Release</button>
              </div>
            )}
          </div>
          <LinesTable lines={so.lines} extra={[
            { head: 'Reserved', cell: (l: { reserved_qty: string }) => qtyText(l.reserved_qty) },
            { head: 'Dispatched', cell: (l: { dispatched_qty: string }) => qtyText(l.dispatched_qty) },
            { head: 'Pending', cell: (l: { pending_qty?: string }) => qtyText(l.pending_qty ?? '0') },
            { head: 'In stock', cell: (l: { available_qty: string | null }) => (l.available_qty === null ? '—' : qtyText(l.available_qty)) },
          ]} />
          <dl className="sov-totals">
            <div><dt>Sub total</dt><dd><Money value={so.sub_total} /></dd></div>
            <div><dt>{so.is_interstate ? 'IGST' : 'CGST + SGST'}</dt><dd><Money value={so.tax_total} /></dd></div>
            <div className="is-grand"><dt>Grand total</dt><dd><Money value={so.grand_total} /></dd></div>
          </dl>
        </section>
        {so.milestones.length > 0 && (
          <section className="sov-card">
            <h3>Billing milestones</h3>
            <ul className="sov-rows">
              {so.milestones.map((m) => (
                <li key={m.id}>
                  <span className="sov-row-main">{m.name}<small>{titleCase(m.kind)} · {rupees(m.taxable_amount)} + {Number(m.gst_percent)}%{m.evidence ? ` · ${m.evidence}` : ''}</small></span>
                  <ErpState value={m.status} />
                  {m.status === 'pending' && sales && <button className="btn btn-sm" onClick={() => setPrompt({ title: `Mark “${m.name}” ready`, act: (r) => erp.milestoneReady(m.id, r) })}>Mark ready</button>}
                  {m.status === 'ready' && can('can_manage_billing') && <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void run(async () => {
                    const inv = await erp.invoiceFromMilestone(m.id)
                    navigate(`/erp/billing?open=${inv.id}`)
                  })}>Invoice</button>}
                </li>
              ))}
            </ul>
          </section>
        )}
      </>}

      {tab === 'dispatch' && (so.dispatch_details.length === 0 ? (
        <section className="sov-card"><p className="sov-empty">Nothing dispatched yet.{open && sales ? ' Use Dispatch below to send goods against this order.' : ''}</p></section>
      ) : so.dispatch_details.map((d) => (
        <section key={d.id} className="sov-card">
          <div className="sov-card-head">
            <h3>{d.number} <ErpState value={d.status} /></h3>
            <span className="sov-sub sov-disp-when">Dispatched <FullDate iso={d.dispatch_date} />{d.created_by_name ? ` by ${d.created_by_name}` : ''}</span>
            <div className="sov-disp-actions">
              {d.status !== 'cancelled' && <button type="button" className="btn btn-sm" onClick={() => setChallan(d.id)}><IconPrinter size={13} /> Challan</button>}
              {d.status === 'dispatched' && sales && <button type="button" className="btn btn-sm" onClick={() => setTransporting(d.id)}><IconEdit size={13} /> Edit transport</button>}
              {d.status === 'dispatched' && sales && <button type="button" className="btn btn-sm btn-primary" onClick={() => setDelivering(d.id)}><IconCheck size={13} /> Mark delivered</button>}
              {d.status !== 'cancelled' && sales && d.lines.some((l) => Number(l.returned_qty) < Number(l.quantity)) && (
                <button type="button" className="btn btn-sm" onClick={() => setReturning(d.id)}>Return goods</button>
              )}
              {d.status === 'dispatched' && sales && (() => {
                const why = d.lines.some((l) => Number(l.invoiced_qty) > 0) ? 'It is invoiced. Credit the invoice first'
                  : d.lines.some((l) => Number(l.returned_qty) > 0) ? 'Goods have already come back against it' : null
                return <button type="button" className="btn btn-sm" disabled={Boolean(why)} title={why ?? undefined}
                  onClick={() => setPrompt({ title: `Cancel dispatch ${d.number}`, danger: true, hint: 'The goods go back into the warehouse they left.', act: (r) => erp.cancelDispatch(d.id, r) })}>Cancel dispatch</button>
              })()}
            </div>
          </div>
          <dl className="sov-details sov-details-4">
            <Detail label="From warehouse">{d.warehouse}</Detail>
            <Detail label="Transporter">{d.transporter}</Detail>
            <Detail label="Vehicle no.">{d.vehicle_no}</Detail>
            <Detail label="LR / tracking">{d.tracking_ref}</Detail>
            <Detail label="E-way bill">{d.eway_bill_no}</Detail>
            <Detail label="Value">{rupees(d.value)}</Detail>
            <Detail label="Delivered on"><FullDate iso={d.delivered_on} /></Detail>
            <Detail label="Received by">{d.pod_received_by}</Detail>
          </dl>
          {d.pod_note && <p className="sov-note">Delivery note: {d.pod_note}</p>}
          {d.cancel_reason && <p className="sov-note sov-bad">Cancelled: {d.cancel_reason}</p>}
          {d.lines.length > 0 && (
            <ul className="sov-chips">{d.lines.map((l) => (
              <li key={l.id}>
                {l.description} <b>× {qtyText(l.quantity)}</b>
                {Number(l.returned_qty) > 0 && <span className="sov-bad"> · {qtyText(l.returned_qty)} returned</span>}
                {Number(l.free_qty) > 0 && <span className="sov-good"> · {qtyText(l.free_qty)} free replacement</span>}
                {l.serials.length > 0 && <small className="sov-sub"> · {l.serials.join(', ')}</small>}
              </li>
            ))}</ul>
          )}
        </section>
      )))}

      {tab === 'dispatch' && so.returns.length > 0 && (
        <section className="sov-card">
          <h3>Returned goods <span className="sov-count">{so.returns.length}</span></h3>
          <div className="table-wrap"><table>
            <thead><tr><th>Return</th><th>Date</th><th>Dispatch</th><th>Items</th><th>Into</th><th>Condition</th><th>Next</th><th className="crm-num">Value</th><th>Reason</th></tr></thead>
            <tbody>{so.returns.map((r) => (
              <tr key={r.id}>
                <td><b>{r.number}</b></td><td><FullDate iso={r.return_date} /></td>
                <td>{so.dispatch_details.find((d) => d.id === r.dispatch_id)?.number ?? '—'}</td>
                <td>{r.lines.map((l) => `${l.description} × ${qtyText(l.quantity)}`).join(', ')}</td>
                <td>{r.warehouse}</td><td>{titleCase(r.condition)}</td><td>{r.replace ? 'Replacement' : 'No replacement'}</td>
                <td className="crm-num">{rupees(r.value)}</td><td>{r.reason}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </section>
      )}

      {tab === 'billing' && <>
        <section className="sov-card">
          <h3>Invoices <span className="sov-count">{so.invoice_details.length}</span></h3>
          {so.invoice_details.length === 0 ? <p className="sov-empty">No invoice raised against this order yet.</p> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Invoice</th><th>Date</th><th>Due</th><th className="crm-num">Total</th><th className="crm-num">Received</th><th className="crm-num">Balance</th><th>Status</th><th /></tr></thead>
              <tbody>{so.invoice_details.map((i) => (
                <tr key={i.id}>
                  <td><b>{i.number ?? 'Draft'}</b><small className="sov-sub"> · {titleCase(i.kind.replace(/_/g, ' '))}</small></td>
                  <td><FullDate iso={i.invoice_date} /></td><td><FullDate iso={i.due_date} /></td>
                  <td className="crm-num">{rupees(i.grand_total)}</td><td className="crm-num">{rupees(i.amount_received)}</td>
                  <td className="crm-num">{i.status === 'posted' && i.kind !== 'proforma' ? rupees(i.outstanding) : '—'}</td>
                  <td><ErpState value={i.status} /></td>
                  <td><button type="button" className="link-btn" onClick={() => navigate(`/erp/billing?open=${i.id}`)}>Open</button></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
        <section className="sov-card">
          <h3>Payments received <span className="sov-count">{so.receipts.length}</span></h3>
          {so.receipts.length === 0 ? <p className="sov-empty">No payment recorded yet.</p> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Receipt</th><th>Date</th><th>Invoice</th><th>Mode</th><th>Reference</th><th className="crm-num">Amount</th><th>Recorded by</th><th>Status</th></tr></thead>
              <tbody>{so.receipts.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.number}</b></td><td><FullDate iso={r.received_on} /></td>
                  <td>{so.invoice_details.find((i) => i.id === r.invoice_id)?.number ?? '—'}</td>
                  <td>{r.mode.toUpperCase()}</td><td>{r.reference ?? '—'}</td>
                  <td className="crm-num">{rupees(r.amount)}</td><td>{r.created_by_name ?? '—'}</td><td><ErpState value={r.status} /></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
      </>}

      {tab === 'approvals' && (
        <section className="sov-card">
          <h3>Approval history</h3>
          <ol className="sov-tl">
            <li className="is-done">
              <b>Order booked</b>
              <span>{so.created_by_name ?? '—'} · {dateTime(so.created_at)}</span>
            </li>
            {so.submitted_at && (
              <li className="is-done"><b>Submitted for approval</b><span>{so.created_by_name ?? '—'} · {dateTime(so.submitted_at)}</span></li>
            )}
            {so.chain.map((st) => (
              <li key={st.id} className={`is-${st.status}`}>
                <b>Level {st.level} · <ErpState value={st.status} /></b>
                <span>
                  {st.acted_by_name ?? st.reviewer_name ?? st.reviewer_rule.replace(/_/g, ' ')}
                  {st.acted_at ? ` · ${dateTime(st.acted_at)}` : ' · waiting'}
                </span>
                {st.note && <em>“{st.note}”</em>}
              </li>
            ))}
            {so.chain.length === 0 && so.reviewed_by_name && (
              <li className={so.status === 'rejected' ? 'is-rejected' : 'is-approved'}>
                <b>{so.status === 'rejected' ? 'Rejected' : 'Approved'}</b>
                <span>{so.reviewed_by_name}{so.reviewed_at ? ` · ${dateTime(so.reviewed_at)}` : ''}</span>
                {so.review_note && <em>“{so.review_note}”</em>}
              </li>
            )}
            {so.status === 'draft' && <li className="is-pending"><b>Not submitted yet</b><span>Still a draft</span></li>}
          </ol>
        </section>
      )}

      {tab === 'activity' && (
        <section className="sov-card">
          <h3>Activity</h3>
          {so.activity.length === 0 ? <p className="sov-empty">No activity recorded.</p> : (
            <ol className="sov-tl sov-tl-activity">
              {so.activity.map((a) => (
                <li key={a.id} className={`is-${activityTone(a.action)}`}>
                  <b>{activityLabel(a)}</b>
                  <span>{a.by ?? 'System'} · {dateTime(a.at)}</span>
                  {activityDetail(a) && <em>{activityDetail(a)}</em>}
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
      </div>
      <aside className="sov-rail">
        <section className="sov-card sov-sum">
          <span className="sov-sum-label">Order value</span>
          <b className="sov-sum-total"><Money value={so.grand_total} /></b>
          <dl className="sov-sum-rows">
            <div><dt>Taxable</dt><dd>{rupees(so.sub_total)}</dd></div>
            <div><dt>{so.is_interstate ? 'IGST' : 'GST'}</dt><dd>{rupees(so.tax_total)}</dd></div>
            <div className="is-rule"><dt>Invoiced <small>{billedPct.toFixed(0)}%</small></dt><dd>{rupees(pay.invoiced)}</dd></div>
            {Number(pay.credited) > 0 && <div><dt>Credit notes</dt><dd>{rupees(pay.credited)}</dd></div>}
            <div><dt>Received <small>{so.receipts.length} payment{so.receipts.length === 1 ? '' : 's'}</small></dt><dd>{rupees(pay.received)}</dd></div>
            <div className={Number(pay.outstanding) > 0 ? 'is-due' : ''}><dt>Balance due</dt><dd>{rupees(pay.outstanding)}</dd></div>
            <div><dt>Still to bill</dt><dd>{rupees(pay.to_bill)}</dd></div>
          </dl>
        </section>
          <section className="sov-card">
            <div className="sov-card-head">
              <h3>Customer</h3>
              <button type="button" className="link-btn" onClick={() => navigate(`/crm/customers?open=${so.customer.id}`)}>Open</button>
            </div>
            <dl className="sov-details">
              <Detail label="Name">{so.customer.name}{so.customer.code ? <small className="sov-sub"> · {so.customer.code}</small> : null}</Detail>
              <Detail label="Company">{so.customer.company}</Detail>
              <Detail label="Mobile">{so.customer.mobile}</Detail>
              <Detail label="Email">{so.customer.email}</Detail>
              <Detail label="GSTIN">{so.customer.gstin}</Detail>
              <Detail label="PAN">{so.customer.pan}</Detail>
              <Detail label="Credit terms">{so.customer.credit_days !== null ? `${so.customer.credit_days} days${Number(so.customer.credit_limit) > 0 ? ` · limit ${rupees(so.customer.credit_limit)}` : ''}` : null}</Detail>
              <Detail label="Account outstanding">
                <span className={Number(so.customer.overdue) > 0 ? 'sov-bad' : ''}>{rupees(so.customer.outstanding)}{Number(so.customer.overdue) > 0 ? ` · ${rupees(so.customer.overdue)} overdue` : ''}</span>
              </Detail>
            </dl>
            {so.customer.credit_hold && <p className="sov-bad sov-flag">Customer is on credit hold</p>}
          </section>
      </aside>
      </div>
    </OrderModal>
    {dispatching && <DispatchForm so={so} onClose={() => setDispatching(false)} onDone={() => { setDispatching(false); q.reload(); onChanged() }} />}
    {/* After the key press has finished: Escape here must not reach the window beneath. */}
    {printing && <SalesOrderPrint so={so} onClose={() => window.setTimeout(() => setPrinting(false))} />}
    {sending && <SendOrder so={so} onClose={() => setSending(false)} onSent={(to) => { setNote(`${so.number} was sent to ${to}.`); setSending(false); q.reload() }} />}
    {invoicing && <CreateInvoice so={so} onClose={() => setInvoicing(false)} />}
    {challan && so.dispatch_details.some((d) => d.id === challan) && (
      <DispatchChallan so={so} dispatch={so.dispatch_details.find((d) => d.id === challan)!} onClose={() => window.setTimeout(() => setChallan(null))} />
    )}
    {transporting && so.dispatch_details.some((d) => d.id === transporting) && (
      <TransportDialog dispatch={so.dispatch_details.find((d) => d.id === transporting)!}
        onClose={() => setTransporting(null)} onDone={() => { setTransporting(null); q.reload(); onChanged() }} />
    )}
    {delivering && <DeliverDialog number={so.dispatch_details.find((d) => d.id === delivering)?.number ?? ''} id={delivering}
      minDate={so.dispatch_details.find((d) => d.id === delivering)?.dispatch_date ?? ''}
      onClose={() => setDelivering(null)} onDone={() => { setDelivering(null); q.reload(); onChanged() }} />}
    {returning && so.dispatch_details.some((d) => d.id === returning) && (
      <ReturnDialog dispatch={so.dispatch_details.find((d) => d.id === returning)!}
        onClose={() => setReturning(null)} onDone={() => { setReturning(null); q.reload(); onChanged() }} />
    )}
    {prompt && <ReasonDialog title={prompt.title} hint={prompt.hint} danger={prompt.danger} onClose={() => setPrompt(null)}
      onSubmit={async (r) => { await prompt.act(r); q.reload(); onChanged() }} />}
    </>
  )
}

/** Proof of delivery: who took the goods, and when. */
const TRANSPORT_LABEL: Record<string, string> = {
  transporter: 'Transporter', tracking_ref: 'LR / tracking', vehicle_no: 'Vehicle', eway_bill_no: 'E-way bill',
}

/** Correct how a shipment travels. The goods and the stock are not touched. */
function TransportDialog({ dispatch, onClose, onDone }: { dispatch: SalesOrderDetail['dispatch_details'][number]; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({
    transporter: dispatch.transporter ?? '', tracking_ref: dispatch.tracking_ref ?? '',
    vehicle_no: dispatch.vehicle_no ?? '', eway_bill_no: dispatch.eway_bill_no ?? '',
  })
  const { busy, error, run } = useRun()
  const changed = (Object.keys(form) as (keyof typeof form)[]).some((k) => form[k].trim() !== ((dispatch[k] as string | null) ?? ''))
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value })
  return (
    <Dialog title={`Edit transport for ${dispatch.number}`} subtitle="Only how it travels changes. The goods, quantities and stock stay as they are." onClose={onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !changed} onClick={() => void run(async () => {
          await erp.dispatchTransport(dispatch.id, form)
          onDone()
        })}>Save changes</button>
      </>
    }>
      <div className="crm-form" style={{ padding: '0 20px 14px' }}>
        <Field label="Transporter / courier"><input placeholder="e.g. VRL Logistics" maxLength={120} value={form.transporter} onChange={set('transporter')} /></Field>
        <Field label="Vehicle no."><input placeholder="e.g. MH12AB1234" maxLength={24} value={form.vehicle_no} onChange={set('vehicle_no')} /></Field>
        <Field label="AWB / LR"><input placeholder="e.g. LR-883201" maxLength={80} value={form.tracking_ref} onChange={set('tracking_ref')} /></Field>
        <Field label="E-way bill no."><input placeholder="e.g. 331000123456" maxLength={24} value={form.eway_bill_no} onChange={set('eway_bill_no')} /></Field>
      </div>
    </Dialog>
  )
}

function DeliverDialog({ id, number, minDate, onClose, onDone }: { id: string; number: string; minDate: string; onClose: () => void; onDone: () => void }) {
  const [on, setOn] = useState(todayISO())
  const [by, setBy] = useState('')
  const [note, setNote] = useState('')
  const { busy, error, run } = useRun()
  return (
    <Dialog title={`Mark ${number} delivered`} subtitle="Any delivery milestone on the order becomes ready to invoice." onClose={onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !by.trim() || !on} onClick={() => void run(async () => {
          await erp.deliver(id, { delivered_on: on, received_by: by.trim(), note: note.trim() || null })
          onDone()
        })}>Save delivery</button>
      </>
    }>
      <div className="crm-form" style={{ padding: '0 20px 14px' }}>
        <Field label="Delivered on"><input type="date" value={on} min={minDate.slice(0, 10)} max={todayISO()} onChange={(e) => setOn(e.target.value)} /></Field>
        <Field label="Received by"><input placeholder="Name of the person who took it" value={by} maxLength={120} onChange={(e) => setBy(e.target.value)} /></Field>
        <Field label="Note" wide><textarea rows={2} placeholder="Shortage, damage, or anything said at delivery" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Dialog>
  )
}

/** Goods back from the customer, against one dispatch. */
function ReturnDialog({ dispatch, onClose, onDone }: { dispatch: SalesOrderDetail['dispatch_details'][number]; onClose: () => void; onDone: () => void }) {
  const warehouses = useQuery('erp-wh-active', () => erp.warehouses(true))
  const lines = dispatch.lines.filter((l) => Number(l.returned_qty) < Number(l.quantity))
  const [warehouseId, setWarehouseId] = useState('')
  const [on, setOn] = useState(todayISO())
  const [condition, setCondition] = useState('good')
  const [reason, setReason] = useState('')
  const [replace, setReplace] = useState(false)
  const [rows, setRows] = useState<Record<string, { quantity: string; serials: string[] }>>({})
  const { busy, error, run } = useRun()
  // The warehouse it left is the likely one it comes back to.
  const house = warehouseId || (warehouses.data ?? []).find((w) => w.name === dispatch.warehouse)?.id || ''
  const row = (id: string) => rows[id] ?? { quantity: '', serials: [] }
  const left = (l: (typeof lines)[number]) => Number(l.quantity) - Number(l.returned_qty)
  const picked = lines.filter((l) => Number(row(l.id).quantity) > 0)
  const over = lines.some((l) => Number(row(l.id).quantity) > left(l))
  const serialsOff = picked.some((l) => l.serials.length > 0 && row(l.id).serials.length !== Number(row(l.id).quantity))
  const billed = picked.some((l) => Number(l.invoiced_qty) > 0)
  const ready = Boolean(house && on && reason.trim() && picked.length > 0 && !over && !serialsOff)
  const set = (id: string, patch: Partial<{ quantity: string; serials: string[] }>) => setRows({ ...rows, [id]: { ...row(id), ...patch } })
  return (
    <Dialog wide title={`Return goods from ${dispatch.number}`} subtitle="Stock comes back into the warehouse in the condition it arrived." onClose={onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !ready} onClick={() => void run(async () => {
          await erp.salesReturn(dispatch.id, {
            warehouse_id: house, return_date: on, condition, reason: reason.trim(), replace,
            lines: picked.map((l) => ({ dispatch_line_id: l.id, quantity: row(l.id).quantity, serials: row(l.id).serials })),
          })
          onDone()
        })}>Record return</button>
      </>
    }>
      <div style={{ padding: '0 20px 12px' }}>
        <div className="crm-form" style={{ marginBottom: 12 }}>
          <Field label="Back into warehouse"><select value={house} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">Choose</option>{(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select></Field>
          <Field label="Return date"><input type="date" value={on} min={dispatch.dispatch_date.slice(0, 10)} max={todayISO()} onChange={(e) => setOn(e.target.value)} /></Field>
          <Field label="Condition" hint="Only good stock counts as available."><select value={condition} onChange={(e) => setCondition(e.target.value)}>
            <option value="good">Good</option><option value="quarantine">Quarantine (to be checked)</option><option value="defective">Defective</option>
          </select></Field>
          <Field label="Reason" wide><input placeholder="e.g. Wrong model sent" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <div className="crm-field" style={{ gridColumn: '1 / -1' }}>
            <label className="crm-check">
              <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
              Send a replacement from this order
            </label>
            <span className="crm-field-hint">The same quantity opens up to dispatch again. Units already billed go free; the rest are billed with the replacement.</span>
          </div>
        </div>
        <div className="table-wrap"><table className="crm-lines">
          <thead><tr><th>Line</th><th className="crm-num">Sent</th><th className="crm-num">Can return</th><th className="crm-num">Returning</th><th>Serials</th></tr></thead>
          <tbody>{lines.map((l) => (
            <tr key={l.id}>
              <td>{l.description}</td><td className="crm-num">{qtyText(l.quantity)}</td><td className="crm-num">{qtyText(String(left(l)))}</td>
              <td className="crm-line-qty"><input placeholder="0" inputMode="decimal" aria-label={`Returning ${l.description}`} value={row(l.id).quantity}
                onChange={(e) => set(l.id, { quantity: e.target.value.replace(/[^\d.]/g, '') })} /></td>
              <td>{l.serials.length === 0 ? <span className="crm-muted">—</span> : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {l.serials.map((serial) => {
                    const on = row(l.id).serials.includes(serial)
                    return <button key={serial} type="button" className={`btn btn-sm${on ? ' btn-primary' : ''}`}
                      onClick={() => set(l.id, { serials: on ? row(l.id).serials.filter((x) => x !== serial) : [...row(l.id).serials, serial] })}>{serial}</button>
                  })}
                </div>
              )}</td>
            </tr>
          ))}</tbody>
        </table></div>
        {over && <p className="sov-note sov-bad">That is more than can come back.</p>}
        {serialsOff && <p className="sov-note sov-bad">Pick one serial for each unit coming back.</p>}
        {billed && !replace && <p className="sov-note">Some of this has been invoiced. Raise a credit note against the invoice for the money, from Billing.</p>}
        {billed && replace && <p className="sov-note">Some of this has been invoiced, so its replacement will not be billed again. No credit note is needed.</p>}
      </div>
    </Dialog>
  )
}

function DispatchForm({ so, onClose, onDone }: { so: SalesOrder; onClose: () => void; onDone: () => void }) {
  const warehouses = useQuery('erp-wh-active', () => erp.warehouses(true))
  const goods = so.lines.filter((l) => l.fulfilment !== 'service' && Number(l.pending_qty) > 0)
  const [warehouseId, setWarehouseId] = useState(goods.find((l) => l.reserved_warehouse_id)?.reserved_warehouse_id ?? '')
  const [head, setHead] = useState({ transporter: so.transporter_name ?? '', tracking_ref: '', vehicle_no: '', eway_bill_no: '' })
  const [rows, setRows] = useState(goods.map((l) => ({ id: l.id, quantity: String(Number(l.pending_qty)), serials: '' })))
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
          <Field label="Transporter / courier"><input placeholder="e.g. VRL Logistics" value={head.transporter} onChange={(e) => setHead({ ...head, transporter: e.target.value })} /></Field>
          <Field label="AWB / LR"><input placeholder="e.g. LR-883201" value={head.tracking_ref} onChange={(e) => setHead({ ...head, tracking_ref: e.target.value })} /></Field>
          <Field label="Vehicle"><input placeholder="e.g. MH12AB1234" value={head.vehicle_no} onChange={(e) => setHead({ ...head, vehicle_no: e.target.value })} /></Field>
          <Field label="E-way bill no."><input placeholder="e.g. 331000123456" value={head.eway_bill_no} onChange={(e) => setHead({ ...head, eway_bill_no: e.target.value })} /></Field>
        </div>
        <div className="table-wrap"><table className="crm-lines">
          <thead><tr><th>Line</th><th className="crm-num">Pending</th><th className="crm-num">Ship now</th><th>Serials</th></tr></thead>
          <tbody>{goods.map((l) => {
            const r = rows.find((x) => x.id === l.id)!
            return (
              <tr key={l.id}>
                <td>{l.description}</td><td className="crm-num">{qtyText(l.pending_qty)}</td>
                <td className="crm-line-qty"><input placeholder="0" inputMode="decimal" value={r.quantity} onChange={(e) => set(l.id, { quantity: e.target.value })} /></td>
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
