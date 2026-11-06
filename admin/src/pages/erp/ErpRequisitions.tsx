/* Purchase requisitions — anybody asks, somebody else approves, procurement orders.
 *
 * An employee sees their own; procurement and approvers see everybody's. An
 * approved requisition turns into an RFQ (several vendors) or straight into a
 * purchase order (one vendor) without retyping a line. */

import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '../../lib/useQuery'
import { useAuth } from '../../lib/auth'
import { downloadCsv, downloadXlsx } from '../../lib/sheet'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconClose, IconDownload, IconEdit, IconMore, IconPlus, IconSearch, IconSheet, IconSliders } from '../../components/Icons'
import { CrmPage } from '../crm/parts'
import { todayISO } from '../crm/api'
import { erp, erpError, qtyText, rupees, type Requisition } from './api'
import '../../styles/invoice.css'
import '../../styles/so-view.css'
import '../../styles/erp-req.css'
import {
  blankLine, ChainView, DecideBar, Dialog, Facts, Field, LineEditor,
  LinesTable, linesPayload, Money, Note, ReasonDialog, useAccess, useItems, useRun, type EditLine,
} from './parts'

const STATUSES: [string, string][] = [
  ['draft', 'Draft'], ['submitted', 'Awaiting approval'], ['approved', 'Approved'], ['rejected', 'Rejected'],
  ['closed', 'Ordered'], ['cancelled', 'Cancelled'],
]
const STATUS_TEXT = Object.fromEntries(STATUSES) as Record<string, string>
const TONE: Record<string, string> = {
  draft: 'idle', submitted: 'warn', approved: 'good', rejected: 'bad', closed: 'good', cancelled: 'idle',
}
const PAGE_SIZES = [10, 25, 50, 100]
const ASC_FIRST = ['number', 'title', 'requested_by', 'status']
/** Still with somebody: not yet ordered, cancelled or turned down. */
const OPEN = ['draft', 'submitted', 'approved']

const ordered = (r: Requisition) => {
  const want = r.lines.reduce((t, l) => t + Number(l.quantity), 0)
  const got = r.lines.reduce((t, l) => t + Number(l.ordered_qty), 0)
  return want > 0 ? Math.min(100, Math.round((got / want) * 100)) : 0
}
const late = (r: Requisition, today: string) => Boolean(r.required_by && r.required_by < today && OPEN.includes(r.status))

function SortTh({ col, sort, dir, onSort, num, children }: {
  col: string; sort: string; dir: 'asc' | 'desc'; onSort: (col: string) => void; num?: boolean; children: ReactNode
}) {
  const on = sort === col
  return (
    <th className={num ? 'crm-num' : undefined} aria-sort={on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className={`sol-sort${on ? ' is-on' : ''}`} onClick={() => onSort(col)}>
        {children}<i aria-hidden>{on ? (dir === 'asc' ? '▲' : '▼') : '↕'}</i>
      </button>
    </th>
  )
}

function pageWindow(page: number, pages: number): number[] {
  const near = new Set([1, pages, page - 1, page, page + 1])
  return [...near].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b)
}

export default function ErpRequisitions() {
  const { user } = useAuth()
  const { can } = useAccess()
  const procurement = can('can_manage_procurement')
  // Polled: approvers decide and buyers order from other screens.
  const list = useQuery('erp-reqs-all', () => erp.requisitions(), { pollMs: 60_000 })
  const warehouses = useQuery('erp-wh-all', () => erp.warehouses())
  const house = useMemo(() => Object.fromEntries((warehouses.data ?? []).map((w) => [w.id, w.name])), [warehouses.data])
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [who, setWho] = useState<'' | 'mine'>('')
  const [warehouse, setWarehouse] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [lateOnly, setLateOnly] = useState(false)
  const [filtering, setFiltering] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [sort, setSort] = useState('created')
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [open, setOpen] = useState<Requisition | null>(null)
  const [editing, setEditing] = useState<Requisition | 'new' | null>(null)
  const [menu, setMenu] = useState<{ r: Requisition; top: number; left: number } | null>(null)
  const [cancelling, setCancelling] = useState<Requisition | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [params, setParams] = useSearchParams()
  useEffect(() => {
    const id = params.get('open')
    if (!id) return
    setParams({}, { replace: true })
    void erp.requisition(id).then(setOpen).catch(() => undefined)
  }, [params, setParams])
  useEffect(() => { setPage(1) }, [status, q, who, warehouse, from, to, lateOnly, sort, dir, pageSize])
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(t)
  }, [notice])
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    const arm = setTimeout(() => window.addEventListener('scroll', close, true), 200)
    window.addEventListener('keydown', onKey)
    return () => { clearTimeout(arm); window.removeEventListener('scroll', close, true); window.removeEventListener('keydown', onKey) }
  }, [menu])

  const today = todayISO()
  const all = list.data ?? []
  const of = (...names: string[]) => all.filter((r) => names.includes(r.status))
  const sum = (rows: Requisition[]) => rows.reduce((t, r) => t + Number(r.estimated_total), 0)
  const toOrder = of('approved')
  const cards: [string, string, string, string, string][] = [
    ['', 'All requisitions', String(all.length), `${rupees(sum(all))} estimated`, 'all'],
    ['submitted', 'Awaiting approval', String(of('submitted').length), rupees(sum(of('submitted'))), 'wait'],
    ['approved', 'Approved, to order', String(toOrder.length), rupees(sum(toOrder)), 'open'],
    ['closed', 'Ordered', String(of('closed').length), rupees(sum(of('closed'))), 'done'],
    ['draft', 'Drafts', String(of('draft').length), 'Not yet submitted', 'draft'],
  ]

  const needle = q.trim().toLowerCase()
  const rows = all.filter((r) => {
    if (status && r.status !== status) return false
    if (who === 'mine' && r.requested_by !== user?.id) return false
    if (warehouse && r.warehouse_id !== warehouse) return false
    if (from && r.created_at.slice(0, 10) < from) return false
    if (to && r.created_at.slice(0, 10) > to) return false
    if (lateOnly && !late(r, today)) return false
    if (!needle) return true
    return [r.number, r.title, r.purpose, r.requested_by_name, ...r.lines.map((l) => `${l.description} ${l.item_code ?? ''}`)]
      .some((v) => (v ?? '').toLowerCase().includes(needle))
  })
  const key = (r: Requisition): string | number => {
    switch (sort) {
      case 'number': return r.number
      case 'title': return r.title.toLowerCase()
      case 'requested_by': return (r.requested_by_name ?? '').toLowerCase()
      case 'required_by': return r.required_by ?? '9999'
      case 'estimate': return Number(r.estimated_total)
      case 'ordered': return ordered(r)
      case 'status': return STATUSES.findIndex(([k]) => k === r.status)
      default: return r.created_at
    }
  }
  const sorted = [...rows].sort((a, b) => {
    const x = key(a), y = key(b)
    const c = x < y ? -1 : x > y ? 1 : 0
    return dir === 'asc' ? c : -c
  })
  const total = sorted.length
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const shownPage = Math.min(page, pages)
  const pageRows = sorted.slice((shownPage - 1) * pageSize, shownPage * pageSize)
  const onSort = (col: string) => {
    if (sort === col) setDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSort(col); setDir(ASC_FIRST.includes(col) ? 'asc' : 'desc') }
  }
  const activeFilters = [status, who, warehouse, from || to, lateOnly].filter(Boolean).length
  const filtered = Boolean(needle || activeFilters)
  const clearFilters = () => { setStatus(''); setWho(''); setWarehouse(''); setFrom(''); setTo(''); setLateOnly(false) }

  function exportRows(as: 'csv' | 'xlsx') {
    setExporting(false)
    const header = ['Requisition no.', 'Raised on', 'Title', 'Justification', 'Requested by', 'Deliver to', 'Needed by',
      'Lines', 'Estimate', 'Ordered %', 'Status', 'Decided by', 'Decision note']
    const data = sorted.map((r) => [
      r.number, r.created_at.slice(0, 10), r.title, r.purpose ?? '', r.requested_by_name ?? '', house[r.warehouse_id ?? ''] ?? '',
      r.required_by ?? '', r.lines.length, Number(r.estimated_total), ordered(r), STATUS_TEXT[r.status] ?? r.status,
      r.reviewed_by_name ?? '', r.review_note ?? '',
    ])
    const name = `requisitions-${today}`
    if (as === 'csv') downloadCsv(`${name}.csv`, header, data)
    else downloadXlsx(`${name}.xlsx`, 'Requisitions', header, data, [8])
  }
  async function act(r: Requisition, fn: () => Promise<Requisition>, done: string) {
    setMenu(null)
    setFailure(null)
    try {
      await fn()
      setNotice(done)
      list.reload()
    } catch (err) {
      setFailure(erpError(err, `${r.number} could not be changed`))
    }
  }
  function openMenu(r: Requisition, button: HTMLElement) {
    const box = button.getBoundingClientRect()
    const tall = 150
    setMenu({ r, left: Math.max(8, box.right - 200), top: box.bottom + tall + 8 > window.innerHeight ? box.top - tall - 4 : box.bottom + 4 })
  }
  const mine = (r: Requisition) => r.requested_by === user?.id

  return (
    <CrmPage>
      <div className="vdl-kpis sol-kpis">
        {cards.map(([k, title, big, sub, tone]) => (
          <button key={title} type="button" className={`vdl-kpi sol-kpi is-${tone}${status === k ? ' is-on' : ''}`} onClick={() => setStatus(k)}>
            <span>{title}</span><b>{list.data ? big : '—'}</b><small>{list.data ? sub : ''}</small>
          </button>
        ))}
      </div>

      <div className="crm-bar sol-bar">
        <div className="crm-search"><IconSearch size={15} />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search number, title, requester or item" /></div>
        <div className="sol-tools">
          {filtered && <button type="button" className="btn btn-sm ivl-clear" onClick={() => { setQ(''); clearFilters() }}>Clear</button>}
          {list.data && <span className="sol-count">{total} {total === 1 ? 'requisition' : 'requisitions'}</span>}
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
                      <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
                        <option value="">All statuses</option>
                        {STATUSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select></label>
                    <label><span>Requested by</span>
                      <select value={who} onChange={(e) => setWho(e.target.value as '' | 'mine')} aria-label="Requested by">
                        <option value="">Anybody</option>
                        <option value="mine">Only mine</option>
                      </select></label>
                    <label className="is-wide"><span>Deliver to</span>
                      <select value={warehouse} onChange={(e) => setWarehouse(e.target.value)} aria-label="Deliver to">
                        <option value="">Any warehouse</option>
                        {(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                      </select></label>
                    <label><span>Raised from</span><input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></label>
                    <label><span>Raised to</span><input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></label>
                    <label className="is-wide rql-check"><input type="checkbox" checked={lateOnly} onChange={(e) => setLateOnly(e.target.checked)} /> Only those past their needed-by date</label>
                  </div>
                  <div className="ivl-filter-foot">
                    <span>{total} of {all.length} match</span>
                    <button type="button" className="btn btn-sm" disabled={!activeFilters} onClick={clearFilters}>Clear all</button>
                    <button type="button" className="btn btn-sm btn-primary" onClick={() => setFiltering(false)}>Done</button>
                  </div>
                </div>
              </>
            )}
          </div>
          <div className="ivl-export">
            <button type="button" className="btn" disabled={!total} aria-haspopup="menu" aria-expanded={exporting}
              title={total ? `Export all ${total} matching` : 'Nothing to export'} onClick={() => setExporting((v) => !v)}>
              <IconDownload size={15} /> Export
            </button>
            {exporting && (
              <div className="ivl-export-menu" role="menu" onMouseLeave={() => setExporting(false)}>
                <button type="button" role="menuitem" onClick={() => exportRows('xlsx')}><b>Excel</b><small>.xlsx · {total} rows</small></button>
                <button type="button" role="menuitem" onClick={() => exportRows('csv')}><b>CSV</b><small>.csv · {total} rows</small></button>
              </div>
            )}
          </div>
          <div className="sol-actions">
            <button className="btn btn-primary" onClick={() => setEditing('new')}><IconPlus size={15} /> New requisition</button>
          </div>
        </div>
      </div>
      {notice && <div className="notice notice-ok" role="status" style={{ marginBottom: 10 }}>{notice}</div>}
      {list.error && <ErrorNote>{erpError(list.cause, 'Could not load requisitions')}</ErrorNote>}
      {failure && <div style={{ marginBottom: 10 }}><ErrorNote>{failure}</ErrorNote></div>}

      <section className="card itl-card">
        {!list.data ? <Loading /> : pageRows.length === 0 ? (
          <EmptyState icon={<IconSheet size={22} />} title={filtered ? 'Nothing matches' : 'No requisitions yet'}
            body={filtered ? 'Change the search or the filters.' : 'Raise one for anything the company should buy. It goes to an approver, then to purchase.'} />
        ) : (
          <div className="table-wrap"><table className="itl sol rql">
            <thead><tr>
              <SortTh col="number" sort={sort} dir={dir} onSort={onSort}>Requisition no.</SortTh>
              <SortTh col="created" sort={sort} dir={dir} onSort={onSort}>Raised on</SortTh>
              <SortTh col="title" sort={sort} dir={dir} onSort={onSort}>Title</SortTh>
              <SortTh col="requested_by" sort={sort} dir={dir} onSort={onSort}>Requested by</SortTh>
              <th>Deliver to</th>
              <SortTh col="required_by" sort={sort} dir={dir} onSort={onSort}>Needed by</SortTh>
              <SortTh col="estimate" sort={sort} dir={dir} onSort={onSort} num>Estimate</SortTh>
              <SortTh col="ordered" sort={sort} dir={dir} onSort={onSort}>Ordered</SortTh>
              <SortTh col="status" sort={sort} dir={dir} onSort={onSort}>Status</SortTh>
              <th className="itl-c-act">Actions</th>
            </tr></thead>
            <tbody>{pageRows.map((r) => {
              const pct = ordered(r)
              const overdue = late(r, today)
              return (
                <tr key={r.id} onClick={() => setOpen(r)} className={`sol-row${['cancelled', 'rejected'].includes(r.status) ? ' is-off' : ''}`}>
                  <td>
                    <span className="pol-no">{r.number}</span>
                    {(overdue || r.sales_order_id) && (
                      <span className="sol-tags">
                        {overdue && <em className="is-high">Overdue</em>}
                        {r.sales_order_id && <em>Sales order</em>}
                      </span>
                    )}
                  </td>
                  <td>{fullDate(r.created_at)}</td>
                  <td className="rql-title">
                    <b title={r.title}>{r.title}</b>
                    <small>{r.lines.length} {r.lines.length === 1 ? 'item' : 'items'}{r.lines[0] ? ` · ${r.lines[0].description}${r.lines.length > 1 ? ` +${r.lines.length - 1}` : ''}` : ''}</small>
                  </td>
                  <td>{r.requested_by_name ?? '—'}</td>
                  <td>{house[r.warehouse_id ?? ''] ?? <span className="itl-muted">—</span>}</td>
                  <td className={overdue ? 'rql-late' : undefined}>{fullDate(r.required_by) ?? <span className="itl-muted">—</span>}</td>
                  <td className="crm-num"><b className="pol-amt">{rupees(r.estimated_total)}</b></td>
                  <td>
                    {['approved', 'closed'].includes(r.status) ? (
                      <span className="rql-bar" title={`${pct}% ordered`}><i style={{ width: `${pct}%` }} /><em>{pct}%</em></span>
                    ) : <span className="itl-muted">—</span>}
                  </td>
                  <td><span className={`crm-state crm-state-${TONE[r.status] ?? 'idle'}`}>{STATUS_TEXT[r.status] ?? r.status}</span></td>
                  <td className="itl-c-act" onClick={(e) => e.stopPropagation()}>
                    <div className="crm-row-actions itl-actions">
                      <button className="crm-icon-btn" title="View" aria-label={`View ${r.number}`} onClick={() => setOpen(r)}><IconSheet size={14} /></button>
                      <button className="crm-icon-btn" disabled={r.status !== 'draft' || !mine(r)} aria-label={`Edit ${r.number}`}
                        title={r.status !== 'draft' ? 'Only a draft is edited' : !mine(r) ? 'Only the requester edits it' : 'Edit draft'}
                        onClick={() => setEditing(r)}><IconEdit size={14} /></button>
                      <button className="crm-icon-btn" title="More actions" aria-label={`More actions for ${r.number}`} aria-haspopup="menu"
                        onClick={(e) => openMenu(r, e.currentTarget)}><IconMore size={14} /></button>
                    </div>
                  </td>
                </tr>
              )
            })}</tbody>
          </table></div>
        )}
        {pageRows.length > 0 && (
          <div className="crm-foot sol-foot">
            <span>{(shownPage - 1) * pageSize + 1}–{Math.min(shownPage * pageSize, total)} of {total} requisition{total === 1 ? '' : 's'}</span>
            <label className="crm-sub" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              Rows
              <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} aria-label="Rows per page">
                {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <div className="crm-pager">
              <button disabled={shownPage <= 1} onClick={() => setPage(shownPage - 1)} aria-label="Previous page">‹</button>
              {pageWindow(shownPage, pages).map((n, i, nums) => (
                <Fragment key={n}>
                  {i > 0 && n - nums[i - 1] > 1 && <span className="sol-gap" aria-hidden>…</span>}
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
            <button type="button" role="menuitem" onClick={() => { setOpen(menu.r); setMenu(null) }}><IconSheet size={14} /> View</button>
            {(() => {
              const r = menu.r
              const block = r.status !== 'draft' ? 'Only a draft is submitted' : !mine(r) ? 'Only the requester submits it' : null
              return <button type="button" role="menuitem" disabled={Boolean(block)} title={block ?? undefined}
                onClick={() => void act(r, () => erp.requisitionAction(r.id, 'submit'), `${r.number} was sent for approval.`)}><IconPlus size={14} /> Submit for approval</button>
            })()}
            {(() => {
              const r = menu.r
              const block = r.status !== 'approved' ? 'Only an approved requisition is ordered' : !procurement ? 'You cannot raise purchase orders' : null
              return <button type="button" role="menuitem" disabled={Boolean(block)} title={block ?? undefined}
                onClick={() => { setOpen(r); setMenu(null) }}><IconSheet size={14} /> Order this</button>
            })()}
            {(() => {
              const r = menu.r
              const block = ['cancelled', 'closed'].includes(r.status) ? `A ${STATUS_TEXT[r.status].toLowerCase()} requisition cannot be cancelled` : null
              return <button type="button" role="menuitem" className="is-danger" disabled={Boolean(block)} title={block ?? undefined}
                onClick={() => { setCancelling(r); setMenu(null) }}><IconClose size={14} /> Cancel requisition</button>
            })()}
          </div>
        </>
      )}
      {cancelling && <ReasonDialog title={`Cancel ${cancelling.number}`} danger confirm="Cancel requisition" onClose={() => setCancelling(null)}
        onSubmit={async (reason) => { await erp.cancelRequisition(cancelling.id, reason); setNotice(`${cancelling.number} was cancelled.`); list.reload() }} />}
      {editing && <RequisitionForm req={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
        onSaved={(r) => { setEditing(null); list.reload(); setOpen(r) }} />}
      {open && <RequisitionDrawer req={open} house={house[open.warehouse_id ?? ''] ?? null} onClose={() => setOpen(null)}
        onEdit={() => { setEditing(open); setOpen(null) }}
        onChanged={(r) => { setOpen(r); list.reload() }} />}
    </CrmPage>
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
          <Field label="Justification" wide><textarea placeholder="e.g. Replacement stock for the Pune branch" rows={2} value={purpose} onChange={(e) => setPurpose(e.target.value)} /></Field>
        </div>
        <LineEditor lines={lines} onChange={setLines} items={items.data ?? []} rateFrom="standard_cost" />
        <p className="crm-sub">Rates are estimates — the purchase order carries the vendor's price.</p>
      </div>
    </Dialog>
  )
}

/** A date with its year: a requisition is read long after it was raised. */
const fullDate = (iso: string | null | undefined) => {
  if (!iso) return null
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

function RequisitionDrawer({ req, house, onClose, onEdit, onChanged }: {
  req: Requisition; house: string | null; onClose: () => void; onEdit: () => void; onChanged: (r: Requisition) => void
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
    <>
    <Dialog wide title={req.number} subtitle={<span className="rqv-sub"><span className={`crm-state crm-state-${TONE[req.status] ?? 'idle'}`}>{STATUS_TEXT[req.status] ?? req.status}</span> {req.title}</span>}
      // Escape belongs to whatever is open on top of this window.
      onClose={cancelling || ordering ? () => undefined : onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        {!['cancelled', 'closed'].includes(req.status) && <button className="btn rqv-cancel" onClick={() => setCancelling(true)}>Cancel requisition</button>}
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
      </>
    }>
      <div className="rqv-body">
        {req.review_note && <Note>{req.status === 'rejected' ? 'Rejected: ' : 'Note: '}{req.review_note}</Note>}
        <Facts items={[
          ['Requested by', req.requested_by_name], ['Raised on', fullDate(req.created_at)],
          ['Needed by', fullDate(req.required_by)], ['Deliver to', house],
          ['Estimate', <Money value={req.estimated_total} />], ['Submitted', fullDate(req.submitted_at)],
          ['Decided by', req.reviewed_by_name], ['Ordered', ['approved', 'closed'].includes(req.status) ? `${ordered(req)}%` : null],
        ]} />
        {req.purpose && <p className="rqv-purpose">{req.purpose}</p>}
        <ChainView steps={req.chain} />
        <LinesTable lines={req.lines.map((l) => ({ ...l, rate: l.estimated_rate }))}
          extra={[{ head: 'Ordered', cell: (l: { ordered_qty: string }) => qtyText(l.ordered_qty) }]} />
      </div>
    </Dialog>
      {cancelling && <ReasonDialog title={`Cancel ${req.number}`} danger confirm="Cancel requisition" onClose={() => setCancelling(false)}
        onSubmit={async (r) => onChanged(await erp.cancelRequisition(req.id, r))} />}
      {ordering && <OrderFrom req={req} mode={ordering} onClose={() => setOrdering(null)}
        onDone={(path) => navigate(path)} />}
    </>
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
