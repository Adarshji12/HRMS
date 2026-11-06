/* RFQs — several vendors quote, the comparison ranks them on landed cost, one
 * is awarded, and the award becomes a draft purchase order.
 *
 * Choosing anything but the cheapest landed quote — or awarding the only quote
 * received — asks for a reason, because the server will (PRD FR-06.07). */

import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '../../lib/useQuery'
import { downloadCsv, downloadXlsx } from '../../lib/sheet'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import {
  IconClose, IconDownload, IconEdit, IconMore, IconPlus, IconPrinter, IconSearch, IconSheet, IconSliders, IconTrash,
} from '../../components/Icons'
import { CrmPage } from '../crm/parts'
import { todayISO } from '../crm/api'
import { erp, erpError, qtyText, rupees, type Comparison, type Rfq, type Vendor } from './api'
import RfqPrint from './RfqPrint'
import '../../styles/invoice.css'
import '../../styles/so-view.css'
import '../../styles/rfq.css'
import { Dialog, Field, Note, ReasonDialog, SearchSelect, useAccess, useItems, useRun, type PickOption } from './parts'

type Status = Rfq['status']
const STATUS_TEXT: Record<Status, string> = { draft: 'Draft', issued: 'Issued', awarded: 'Awarded', cancelled: 'Cancelled' }
const TONE: Record<Status, string> = { draft: 'idle', issued: 'warn', awarded: 'good', cancelled: 'idle' }
const PAGE_SIZES = [10, 25, 50, 100]
const ASC_FIRST = ['number', 'title', 'status', 'due_date']
const GST = ['0', '5', '12', '18', '28']
const UNITS = ['Nos', 'Pcs', 'Set', 'Box', 'Pack', 'Kg', 'Mtr', 'Ltr', 'Roll', 'Pair', 'Hrs', 'Lot']
const PAYMENT_TERMS = ['100% advance', '50% advance, balance on delivery', 'Against delivery', '15 days from invoice', '30 days from invoice', '45 days from invoice', '60 days from invoice']
const DELIVERY_TERMS = ['FOR destination (our warehouse)', 'Ex-works', 'Door delivery', 'Freight extra at actuals', 'CIF', 'FOB']

/** A date with its year: an RFQ is read long after it went out. */
export const fullDate = (iso: string | null | undefined) => {
  if (!iso) return null
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}
const overdue = (r: Rfq, today: string) => r.status === 'issued' && Boolean(r.due_date && r.due_date < today)
const quoted = (r: Rfq) => r.vendors.filter((v) => v.quoted).length
/** The stage a buyer acts on, finer than the stored status. */
const stage = (r: Rfq) => r.status === 'issued' ? (quoted(r) === 0 ? 'awaiting' : 'to_award') : r.status
const STAGE_TEXT: Record<string, string> = { ...STATUS_TEXT, awaiting: 'Awaiting quotes', to_award: 'Quotes in' }

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

export default function ErpRfqs() {
  const { can } = useAccess()
  const buyer = can('can_manage_procurement')
  const navigate = useNavigate()
  const list = useQuery('erp-rfqs', () => erp.rfqs(), { pollMs: 60_000 })
  const [params, setParams] = useSearchParams()
  const [openId, setOpenId] = useState<string | null>(params.get('open'))
  useEffect(() => { if (params.get('open')) { setOpenId(params.get('open')); setParams({}, { replace: true }) } }, [params, setParams])
  const [stageKey, setStageKey] = useState('')
  const [q, setQ] = useState('')
  const [vendor, setVendor] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [lateOnly, setLateOnly] = useState(false)
  const [filtering, setFiltering] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [sort, setSort] = useState('created')
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [editing, setEditing] = useState<Rfq | 'new' | null>(null)
  const [menu, setMenu] = useState<{ r: Rfq; top: number; left: number } | null>(null)
  const [printing, setPrinting] = useState<Rfq | null>(null)
  const [cancelling, setCancelling] = useState<Rfq | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(() => { setPage(1) }, [stageKey, q, vendor, from, to, lateOnly, sort, dir, pageSize])
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
  const at = (...keys: string[]) => all.filter((r) => keys.includes(stage(r)))
  const vendorsSeen = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of list.data ?? []) for (const v of r.vendors) seen.set(v.vendor_id, v.legal_name)
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]))
  }, [list.data])
  const awarded = at('awarded')
  const cards: [string, string, string, string, string][] = [
    ['', 'All RFQs', String(all.length), `${at('awaiting', 'to_award').length} out with vendors`, 'all'],
    ['awaiting', 'Awaiting quotes', String(at('awaiting').length), `${all.filter((r) => overdue(r, today)).length} past due date`, 'wait'],
    ['to_award', 'Quotes in, to award', String(at('to_award').length), 'Compare and award', 'open'],
    ['awarded', 'Awarded', String(awarded.length), rupees(awarded.reduce((t, r) => t + Number(r.awarded_total ?? 0), 0)), 'done'],
    ['draft', 'Drafts', String(at('draft').length), 'Not yet issued', 'draft'],
  ]

  const needle = q.trim().toLowerCase()
  const rows = all.filter((r) => {
    if (stageKey && stage(r) !== stageKey && !(stageKey === 'issued' && r.status === 'issued')) return false
    if (vendor && !r.vendors.some((v) => v.vendor_id === vendor)) return false
    const day = (r.rfq_date ?? r.created_at).slice(0, 10)
    if (from && day < from) return false
    if (to && day > to) return false
    if (lateOnly && !overdue(r, today)) return false
    if (!needle) return true
    return [r.number, r.title, r.requisition_number, r.awarded_vendor, ...r.vendors.map((v) => v.legal_name), ...r.lines.map((l) => `${l.description} ${l.item_code ?? ''}`)]
      .some((v) => (v ?? '').toLowerCase().includes(needle))
  })
  const key = (r: Rfq): string | number => {
    switch (sort) {
      case 'number': return r.number
      case 'title': return r.title.toLowerCase()
      case 'due_date': return r.due_date ?? '9999'
      case 'quotes': return quoted(r) / Math.max(1, r.vendors.length)
      case 'lowest': return Number(r.lowest_landed ?? -1)
      case 'status': return Object.keys(STAGE_TEXT).indexOf(stage(r))
      default: return `${r.rfq_date ?? ''}${r.created_at}`
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
  const activeFilters = [stageKey, vendor, from || to, lateOnly].filter(Boolean).length
  const filtered = Boolean(needle || activeFilters)
  const clearFilters = () => { setStageKey(''); setVendor(''); setFrom(''); setTo(''); setLateOnly(false) }

  function exportRows(as: 'csv' | 'xlsx') {
    setExporting(false)
    const header = ['RFQ no.', 'RFQ date', 'Title', 'Requisition', 'Deliver to', 'Quotes due', 'Needed by', 'Lines',
      'Vendors invited', 'Quotes received', 'Lowest landed', 'Awarded to', 'Awarded value', 'Purchase order', 'Status']
    const data = sorted.map((r) => [
      r.number, r.rfq_date ?? r.created_at.slice(0, 10), r.title, r.requisition_number ?? '', r.warehouse_name ?? '',
      r.due_date ?? '', r.required_by ?? '', r.lines.length, r.vendors.length, quoted(r),
      r.lowest_landed ? Number(r.lowest_landed) : '', r.awarded_vendor ?? '', r.awarded_total ? Number(r.awarded_total) : '',
      r.purchase_order_number ?? '', STAGE_TEXT[stage(r)],
    ])
    const name = `rfqs-${today}`
    if (as === 'csv') downloadCsv(`${name}.csv`, header, data)
    else downloadXlsx(`${name}.xlsx`, 'RFQs', header, data, [10, 12])
  }
  async function act(r: Rfq, fn: () => Promise<unknown>, done: string) {
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
  async function raisePo(r: Rfq) {
    setMenu(null)
    setFailure(null)
    try {
      const po = await erp.rfqToPo(r.id)
      navigate(`/erp/purchase-orders?open=${po.id}`)
    } catch (err) {
      setFailure(erpError(err, 'The purchase order could not be raised'))
    }
  }
  function openMenu(r: Rfq, button: HTMLElement) {
    const box = button.getBoundingClientRect()
    const tall = 190
    setMenu({ r, left: Math.max(8, box.right - 210), top: box.bottom + tall + 8 > window.innerHeight ? box.top - tall - 4 : box.bottom + 4 })
  }

  return (
    <CrmPage>
      <div className="vdl-kpis sol-kpis">
        {cards.map(([k, title, big, sub, tone]) => (
          <button key={title} type="button" className={`vdl-kpi sol-kpi is-${tone}${stageKey === k ? ' is-on' : ''}`} onClick={() => setStageKey(k)}>
            <span>{title}</span><b>{list.data ? big : '—'}</b><small>{list.data ? sub : ''}</small>
          </button>
        ))}
      </div>

      <div className="crm-bar sol-bar">
        <div className="crm-search"><IconSearch size={15} />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search RFQ no., title, vendor or item" /></div>
        <div className="sol-tools">
          {filtered && <button type="button" className="btn btn-sm ivl-clear" onClick={() => { setQ(''); clearFilters() }}>Clear</button>}
          {list.data && <span className="sol-count">{total} {total === 1 ? 'RFQ' : 'RFQs'}</span>}
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
                      <select value={stageKey} onChange={(e) => setStageKey(e.target.value)} aria-label="Status">
                        <option value="">All statuses</option>
                        {['draft', 'awaiting', 'to_award', 'issued', 'awarded', 'cancelled'].map((k) => (
                          <option key={k} value={k}>{k === 'issued' ? 'Issued (any)' : STAGE_TEXT[k]}</option>
                        ))}
                      </select></label>
                    <label><span>Vendor</span>
                      <select value={vendor} onChange={(e) => setVendor(e.target.value)} aria-label="Vendor">
                        <option value="">Any vendor</option>
                        {vendorsSeen.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                      </select></label>
                    <label><span>RFQ date from</span><input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></label>
                    <label><span>RFQ date to</span><input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></label>
                    <label className="is-wide rfq-check"><input type="checkbox" checked={lateOnly} onChange={(e) => setLateOnly(e.target.checked)} /> Only those past their quote due date</label>
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
          {buyer && (
            <div className="sol-actions">
              <button className="btn btn-primary" onClick={() => setEditing('new')}><IconPlus size={15} /> New RFQ</button>
            </div>
          )}
        </div>
      </div>
      {notice && <div className="notice notice-ok" role="status" style={{ marginBottom: 10 }}>{notice}</div>}
      {list.error && <ErrorNote>{erpError(list.cause, 'Could not load RFQs')}</ErrorNote>}
      {failure && <div style={{ marginBottom: 10 }}><ErrorNote>{failure}</ErrorNote></div>}

      <section className="card itl-card">
        {!list.data ? <Loading /> : pageRows.length === 0 ? (
          <EmptyState icon={<IconSheet size={22} />} title={filtered ? 'Nothing matches' : 'No RFQs yet'}
            body={filtered ? 'Change the search or the filters.' : 'Create one here, or open an approved requisition and choose Request quotes.'} />
        ) : (
          <div className="table-wrap"><table className="itl sol rfl">
            <thead><tr>
              <SortTh col="number" sort={sort} dir={dir} onSort={onSort}>RFQ no.</SortTh>
              <SortTh col="created" sort={sort} dir={dir} onSort={onSort}>RFQ date</SortTh>
              <SortTh col="title" sort={sort} dir={dir} onSort={onSort}>Title</SortTh>
              <SortTh col="due_date" sort={sort} dir={dir} onSort={onSort}>Quotes due</SortTh>
              <SortTh col="quotes" sort={sort} dir={dir} onSort={onSort}>Quotes</SortTh>
              <SortTh col="lowest" sort={sort} dir={dir} onSort={onSort} num>Lowest landed</SortTh>
              <th>Awarded to</th>
              <SortTh col="status" sort={sort} dir={dir} onSort={onSort}>Status</SortTh>
              <th className="itl-c-act">Actions</th>
            </tr></thead>
            <tbody>{pageRows.map((r) => {
              const late = overdue(r, today)
              const got = quoted(r)
              const st = stage(r)
              return (
                <tr key={r.id} onClick={() => setOpenId(r.id)} className={`sol-row${r.status === 'cancelled' ? ' is-off' : ''}`}>
                  <td>
                    <span className="pol-no">{r.number}</span>
                    {(late || r.requisition_number) && (
                      <span className="sol-tags">
                        {late && <em className="is-high">Overdue</em>}
                        {r.requisition_number && <em title="Raised from this requisition">{r.requisition_number}</em>}
                      </span>
                    )}
                  </td>
                  <td>{fullDate(r.rfq_date ?? r.created_at)}</td>
                  <td className="rfl-title">
                    <b title={r.title}>{r.title}</b>
                    <small>{r.lines.length} {r.lines.length === 1 ? 'item' : 'items'}{r.lines[0] ? ` · ${r.lines[0].description}${r.lines.length > 1 ? ` +${r.lines.length - 1}` : ''}` : ''}</small>
                  </td>
                  <td className={late ? 'rfl-late' : undefined}>{fullDate(r.due_date) ?? <span className="itl-muted">—</span>}</td>
                  <td>
                    <span className="rfl-bar" title={`${got} of ${r.vendors.length} vendors have quoted`}>
                      <i style={{ width: `${r.vendors.length ? (got / r.vendors.length) * 100 : 0}%` }} /><em>{got} / {r.vendors.length}</em>
                    </span>
                  </td>
                  <td className="crm-num">{r.lowest_landed ? <b className="pol-amt">{rupees(r.lowest_landed)}</b> : <span className="itl-muted">—</span>}</td>
                  <td className="rfl-award">
                    {r.awarded_vendor ? <><b title={r.awarded_vendor}>{r.awarded_vendor}</b>{r.purchase_order_number && <small>{r.purchase_order_number}</small>}</> : <span className="itl-muted">—</span>}
                  </td>
                  <td><span className={`crm-state crm-state-${st === 'to_award' ? 'good' : TONE[r.status]}`}>{STAGE_TEXT[st]}</span></td>
                  <td className="itl-c-act" onClick={(e) => e.stopPropagation()}>
                    <div className="crm-row-actions itl-actions">
                      <button className="crm-icon-btn" title="View" aria-label={`View ${r.number}`} onClick={() => setOpenId(r.id)}><IconSheet size={14} /></button>
                      <button className="crm-icon-btn" disabled={r.status !== 'draft' || !buyer} aria-label={`Edit ${r.number}`}
                        title={r.status !== 'draft' ? 'Only a draft is edited' : !buyer ? 'You cannot change RFQs' : 'Edit draft'}
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
            <span>{(shownPage - 1) * pageSize + 1}–{Math.min(shownPage * pageSize, total)} of {total} RFQ{total === 1 ? '' : 's'}</span>
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
          <div className="ivl-export-menu sol-menu" role="menu" style={{ top: menu.top, left: menu.left, width: 210 }}>
            <button type="button" role="menuitem" onClick={() => { setOpenId(menu.r.id); setMenu(null) }}><IconSheet size={14} /> View &amp; compare</button>
            <button type="button" role="menuitem" onClick={() => { setPrinting(menu.r); setMenu(null) }}><IconPrinter size={14} /> Print RFQ</button>
            {(() => {
              const r = menu.r
              const block = !buyer ? 'You cannot issue RFQs' : r.status !== 'draft' ? 'Only a draft is issued' : null
              return <button type="button" role="menuitem" disabled={Boolean(block)} title={block ?? undefined}
                onClick={() => void act(r, () => erp.issueRfq(r.id), `${r.number} was issued to ${r.vendors.length} vendors.`)}><IconPlus size={14} /> Issue to vendors</button>
            })()}
            {(() => {
              const r = menu.r
              const block = !buyer ? 'You cannot raise purchase orders' : r.status !== 'awarded' ? 'Award the RFQ first' : r.purchase_order_number ? `Already ordered on ${r.purchase_order_number}` : null
              return <button type="button" role="menuitem" disabled={Boolean(block)} title={block ?? undefined} onClick={() => void raisePo(r)}><IconSheet size={14} /> Raise purchase order</button>
            })()}
            {(() => {
              const r = menu.r
              const block = !buyer ? 'You cannot cancel RFQs' : !['draft', 'issued'].includes(r.status) ? `An ${STATUS_TEXT[r.status].toLowerCase()} RFQ cannot be cancelled` : null
              return <button type="button" role="menuitem" className="is-danger" disabled={Boolean(block)} title={block ?? undefined}
                onClick={() => { setCancelling(r); setMenu(null) }}><IconClose size={14} /> Cancel RFQ</button>
            })()}
          </div>
        </>
      )}
      {printing && <RfqPrint rfq={printing} onClose={() => setPrinting(null)} />}
      {cancelling && <ReasonDialog title={`Cancel ${cancelling.number}`} danger confirm="Cancel RFQ" onClose={() => setCancelling(null)}
        hint="Vendors who were asked to quote should be told it is off."
        onSubmit={async (reason) => { await erp.cancelRfq(cancelling.id, reason); setNotice(`${cancelling.number} was cancelled.`); list.reload() }} />}
      {editing && <RfqForm rfq={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
        onSaved={(r, issued) => { setEditing(null); list.reload(); setOpenId(r.id); setNotice(issued ? `${r.number} was issued to ${r.vendors.length} vendors.` : `${r.number} was saved as a draft.`) }} />}
      {openId && <RfqView id={openId} onClose={() => setOpenId(null)} onEdit={(r) => { setOpenId(null); setEditing(r) }} onChanged={() => list.reload()} />}
    </CrmPage>
  )
}

/* ------------------------------------------------------------------ form */

interface FormLine { key: string; id?: string; item_id: string; description: string; specification: string; quantity: string; uom: string; target_rate: string; linked: boolean }
const newKey = () => Math.random().toString(36).slice(2)
const blank = (): FormLine => ({ key: newKey(), item_id: '', description: '', specification: '', quantity: '1', uom: 'Nos', target_rate: '', linked: false })

function RfqForm({ rfq, onClose, onSaved }: { rfq: Rfq | null; onClose: () => void; onSaved: (r: Rfq, issued: boolean) => void }) {
  const items = useItems()
  const warehouses = useQuery('erp-wh-active', () => erp.warehouses(true))
  const vendors = useQuery('erp-vendors-active', () => erp.vendors({ status: 'active' }))
  const [head, setHead] = useState({
    title: rfq?.title ?? '', rfq_date: rfq?.rfq_date ?? todayISO(), due_date: rfq?.due_date ?? '', required_by: rfq?.required_by ?? '',
    warehouse_id: rfq?.warehouse_id ?? '', contact_person: rfq?.contact_person ?? '', payment_terms: rfq?.payment_terms ?? '',
    delivery_terms: rfq?.delivery_terms ?? '', quote_validity_days: rfq?.quote_validity_days != null ? String(rfq.quote_validity_days) : '30',
    terms: rfq?.terms ?? '', notes: rfq?.notes ?? '',
  })
  const [lines, setLines] = useState<FormLine[]>(rfq ? rfq.lines.map((l) => ({
    key: l.id, id: l.id, item_id: l.item_id ?? '', description: l.description, specification: l.specification ?? '',
    quantity: String(Number(l.quantity)), uom: l.uom ?? 'Nos', target_rate: l.target_rate ? String(Number(l.target_rate)) : '', linked: Boolean(l.requisition_line_id),
  })) : [blank()])
  const [picked, setPicked] = useState<string[]>(rfq?.vendors.map((v) => v.vendor_id) ?? [])
  const [vq, setVq] = useState('')
  const { busy, error, run } = useRun()
  const set = (k: keyof typeof head) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setHead({ ...head, [k]: e.target.value })
  const setLine = (key: string, patch: Partial<FormLine>) => setLines(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  const options: PickOption[] = (items.data ?? []).filter((i) => i.can_be_purchased !== false || lines.some((l) => l.item_id === i.id))
    .map((i) => ({ value: i.id, label: i.name, hint: i.code }))
  const pick = (key: string, id: string) => {
    const it = (items.data ?? []).find((i) => i.id === id)
    if (!it) { setLine(key, { item_id: '' }); return }
    setLine(key, { item_id: it.id, description: it.name, uom: it.uom || 'Nos', target_rate: Number(it.standard_cost) ? String(Number(it.standard_cost)) : '' })
  }
  const used = lines.filter((l) => l.item_id || l.description.trim())
  const lineBad = used.some((l) => !(Number(l.quantity) > 0))
  const dueBad = Boolean(head.due_date && head.due_date < head.rfq_date)
  const needBad = Boolean(head.required_by && head.required_by < head.rfq_date)
  const target = used.reduce((t, l) => t + Number(l.quantity || 0) * Number(l.target_rate || 0), 0)
  const block = !head.title.trim() ? 'Give the RFQ a title' : !used.length ? 'Add at least one item' : lineBad ? 'Every item needs a quantity above 0'
    : dueBad ? 'Quotes cannot be due before the RFQ date' : needBad ? 'The goods cannot be needed before the RFQ date' : !picked.length ? 'Pick at least one vendor' : null
  const shownVendors = (vendors.data ?? []).filter((v) => !vq.trim() || `${v.legal_name} ${v.code} ${v.category ?? ''}`.toLowerCase().includes(vq.trim().toLowerCase()))
  const vendorName = (id: string) => (vendors.data ?? []).find((v) => v.id === id)?.legal_name ?? rfq?.vendors.find((v) => v.vendor_id === id)?.legal_name ?? 'Vendor'

  function save(issue: boolean) {
    void run(async () => {
      const body = {
        ...head, title: head.title.trim(), requisition_id: rfq?.requisition_id ?? null,
        due_date: head.due_date || null, required_by: head.required_by || null, warehouse_id: head.warehouse_id || null,
        quote_validity_days: head.quote_validity_days ? Number(head.quote_validity_days) : null,
        vendor_ids: picked,
        lines: used.map((l) => ({
          id: l.id ?? null, item_id: l.item_id || null, description: l.description.trim() || null, specification: l.specification.trim() || null,
          quantity: l.quantity, uom: l.uom || 'Nos', target_rate: l.target_rate || null,
        })),
      }
      let saved = rfq ? await erp.updateRfq(rfq.id, body) : await erp.createRfq(body)
      if (issue) saved = await erp.issueRfq(saved.id)
      onSaved(saved, issue)
    })
  }

  return (
    <Dialog wide title={rfq ? `Edit ${rfq.number}` : 'New request for quotation'} onClose={onClose} footer={
      <>
        {(error || block) && <span className="error">{error ?? block}</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={busy || Boolean(block)} onClick={() => save(false)}>Save draft</button>
        <button className="btn btn-primary" disabled={busy || Boolean(block)} onClick={() => save(true)}>Save &amp; issue</button>
      </>
    }>
      <div className="rff-body">
        <section className="rff-sec">
          <h3>RFQ details</h3>
          <div className="rff-grid">
            <Field label="Title" required wide><input value={head.title} maxLength={200} onChange={set('title')} placeholder="e.g. Network switches for the Pune branch" /></Field>
            <Field label="RFQ date"><input type="date" value={head.rfq_date} onChange={set('rfq_date')} /></Field>
            <Field label="Quotes due by"><input type="date" value={head.due_date} min={head.rfq_date} className={dueBad ? 'is-bad' : undefined} onChange={set('due_date')} /></Field>
            <Field label="Goods needed by"><input type="date" value={head.required_by} min={head.rfq_date} className={needBad ? 'is-bad' : undefined} onChange={set('required_by')} /></Field>
            <Field label="Deliver to">
              <select value={head.warehouse_id} onChange={set('warehouse_id')}>
                <option value="">Select warehouse</option>
                {(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </Field>
            <Field label="Contact person"><input value={head.contact_person} maxLength={120} onChange={set('contact_person')} placeholder="Who vendors should call" /></Field>
            <Field label="Payment terms"><input list="rff-pay" value={head.payment_terms} maxLength={160} onChange={set('payment_terms')} placeholder="e.g. 30 days from invoice" /></Field>
            <Field label="Delivery terms"><input list="rff-del" value={head.delivery_terms} maxLength={160} onChange={set('delivery_terms')} placeholder="e.g. FOR destination" /></Field>
            <Field label="Quote valid for (days)"><input inputMode="numeric" value={head.quote_validity_days} onChange={(e) => setHead({ ...head, quote_validity_days: e.target.value.replace(/\D/g, '').slice(0, 3) })} placeholder="30" /></Field>
          </div>
          <datalist id="rff-pay">{PAYMENT_TERMS.map((t) => <option key={t} value={t} />)}</datalist>
          <datalist id="rff-del">{DELIVERY_TERMS.map((t) => <option key={t} value={t} />)}</datalist>
          <datalist id="rff-units">{UNITS.map((t) => <option key={t} value={t} />)}</datalist>
        </section>

        <section className="rff-sec">
          <header className="rff-sec-head">
            <h3>Items to quote</h3>
            <span>{used.length} {used.length === 1 ? 'item' : 'items'}{target > 0 ? ` · target ${rupees(target)}` : ''}</span>
          </header>
          <div className="table-wrap rff-lines"><table>
            <thead><tr>
              <th className="rff-c-no">#</th><th className="rff-c-item">Item</th><th>Description</th><th>Specification / make</th>
              <th className="rff-c-qty">Qty</th><th className="rff-c-unit">Unit</th><th className="rff-c-rate">Target rate (₹)</th><th className="rff-c-x" />
            </tr></thead>
            <tbody>{lines.map((l, n) => (
              <tr key={l.key}>
                <td className="rff-c-no">{n + 1}</td>
                <td className="rff-c-item">
                  <SearchSelect label={`Item, line ${n + 1}`} value={l.item_id} onChange={(v) => pick(l.key, v)} options={options} clearable placeholder="Search item…" empty="No item matches" />
                </td>
                <td><input value={l.description} maxLength={300} onChange={(e) => setLine(l.key, { description: e.target.value })} placeholder={l.item_id ? 'Description' : 'Or type the item'} aria-label={`Description, line ${n + 1}`} /></td>
                <td><input value={l.specification} maxLength={2000} onChange={(e) => setLine(l.key, { specification: e.target.value })} placeholder="e.g. 24 port, managed, rack mount" aria-label={`Specification, line ${n + 1}`} /></td>
                <td className="rff-c-qty"><input inputMode="decimal" className={(l.item_id || l.description.trim()) && !(Number(l.quantity) > 0) ? 'is-bad' : undefined}
                  value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} aria-label={`Quantity, line ${n + 1}`}
                  title={l.linked ? 'From the requisition: no more than it still needs' : undefined} /></td>
                <td className="rff-c-unit"><input list="rff-units" value={l.uom} maxLength={16} onChange={(e) => setLine(l.key, { uom: e.target.value })} aria-label={`Unit, line ${n + 1}`} /></td>
                <td className="rff-c-rate"><input inputMode="decimal" value={l.target_rate} onChange={(e) => setLine(l.key, { target_rate: e.target.value })} placeholder="Optional" title="Your expected rate. Never printed for vendors." aria-label={`Target rate, line ${n + 1}`} /></td>
                <td className="rff-c-x">
                  <button type="button" className="crm-icon-btn" aria-label={`Remove line ${n + 1}`} disabled={lines.length === 1}
                    onClick={() => setLines(lines.filter((x) => x.key !== l.key))}><IconTrash size={13} /></button>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
          <button type="button" className="btn btn-sm rff-add" onClick={() => setLines([...lines, blank()])}><IconPlus size={13} /> Add item</button>
        </section>

        <section className="rff-sec">
          <header className="rff-sec-head">
            <h3>Vendors to ask</h3>
            <span>{picked.length} selected</span>
          </header>
          {picked.length > 0 && (
            <div className="rff-chips">
              {picked.map((id) => (
                <span key={id} className="rff-chip">{vendorName(id)}
                  <button type="button" aria-label={`Remove ${vendorName(id)}`} onClick={() => setPicked(picked.filter((x) => x !== id))}><IconClose size={11} /></button>
                </span>
              ))}
            </div>
          )}
          <div className="crm-search rff-vsearch"><IconSearch size={14} />
            <input type="search" value={vq} onChange={(e) => setVq(e.target.value)} placeholder="Search vendor name, code or category" /></div>
          <div className="rff-vendors">
            {vendors.data && shownVendors.length === 0 && <p className="crm-muted">{vendors.data.length ? 'No vendor matches.' : 'No active vendors. Approve one under Masters first.'}</p>}
            {shownVendors.map((v: Vendor) => (
              <label key={v.id} className={`rff-vendor${picked.includes(v.id) ? ' is-on' : ''}`}>
                <input type="checkbox" checked={picked.includes(v.id)} onChange={() => setPicked(picked.includes(v.id) ? picked.filter((x) => x !== v.id) : [...picked, v.id])} />
                <span><b>{v.legal_name}</b><small>{[v.code, v.category, v.state].filter(Boolean).join(' · ')}</small></span>
                {v.performance_score && <em title="Vendor score">{Number(v.performance_score).toFixed(0)}</em>}
              </label>
            ))}
          </div>
        </section>

        <section className="rff-sec rff-two">
          <Field label="Terms and instructions for vendors"><textarea rows={3} value={head.terms} onChange={set('terms')} placeholder="e.g. Quote with make and model. Prices inclusive of packing. Mention GST separately." /></Field>
          <Field label="Internal notes (not printed)"><textarea rows={3} value={head.notes} onChange={set('notes')} placeholder="e.g. Budget approved up to ₹1.2 lakh" /></Field>
        </section>
      </div>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ view */

function RfqView({ id, onClose, onEdit, onChanged }: { id: string; onClose: () => void; onEdit: (r: Rfq) => void; onChanged: () => void }) {
  const navigate = useNavigate()
  const { can } = useAccess()
  const rfq = useQuery(`erp-rfq-${id}`, () => erp.rfq(id))
  const cmp = useQuery(`erp-rfq-cmp-${id}`, () => erp.comparison(id), { enabled: Boolean(rfq.data?.quotes.length) })
  const refresh = () => { rfq.reload(); cmp.reload(); onChanged() }
  const { busy, error, run } = useRun(refresh)
  const [quoting, setQuoting] = useState<string | null>(null)
  const [award, setAward] = useState<Comparison['quotes'][number] | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [inviting, setInviting] = useState(false)
  const [printing, setPrinting] = useState(false)
  const r = rfq.data
  const covered = Boolean(quoting || award || cancelling || inviting || printing)
  if (!r) return <Dialog wide title="RFQ" onClose={onClose}><div style={{ padding: 20 }}>{rfq.error ? <ErrorNote>{erpError(rfq.cause, 'Could not load the RFQ')}</ErrorNote> : <Loading />}</div></Dialog>
  const mine = can('can_manage_procurement')
  const today = todayISO()
  const late = overdue(r, today)
  const st = stage(r)
  const quotes = cmp.data?.quotes ?? []
  const targetTotal = r.lines.reduce((t, l) => t + Number(l.quantity) * Number(l.target_rate ?? 0), 0)
  /** What a quote asks for the lines that have a target, against that target. */
  const vsTarget = (quoteId: string) => {
    if (!cmp.data || targetTotal <= 0) return null
    let asked = 0
    for (const line of cmp.data.lines) {
      const cell = line.rates[quoteId]
      if (Number(line.target_rate ?? 0) > 0 && cell && Number(cell.net_rate) > 0) asked += Number(line.quantity) * Number(cell.net_rate)
    }
    return asked > 0 ? ((asked - targetTotal) / targetTotal) * 100 : null
  }
  const latest = (vendorId: string) => quotes.find((q) => q.vendor_id === vendorId)

  return (
    <>
    <Dialog wide title={r.number} subtitle={
      <span className="rfv-sub">
        <span className={`crm-state crm-state-${st === 'to_award' ? 'good' : TONE[r.status]}`}>{STAGE_TEXT[st]}</span>
        {late && <span className="crm-state crm-state-bad">Overdue</span>}
        {r.title}
      </span>
    } onClose={covered ? () => undefined : onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        {mine && ['draft', 'issued'].includes(r.status) && <button className="btn rfv-cancel" onClick={() => setCancelling(true)}>Cancel RFQ</button>}
        <button className="btn" onClick={() => setPrinting(true)}><IconPrinter size={14} /> Print</button>
        {mine && ['draft', 'issued'].includes(r.status) && <button className="btn" onClick={() => setInviting(true)}><IconPlus size={14} /> Add vendor</button>}
        {mine && r.status === 'draft' && <button className="btn" onClick={() => onEdit(r)}><IconEdit size={14} /> Edit</button>}
        {mine && r.status === 'draft' && <button className="btn btn-primary" disabled={busy} onClick={() => void run(() => erp.issueRfq(r.id))}>Issue to vendors</button>}
        {mine && r.status === 'awarded' && !r.purchase_order_id && (
          <button className="btn btn-primary" disabled={busy} onClick={() => void run(async () => {
            const po = await erp.rfqToPo(r.id)
            navigate(`/erp/purchase-orders?open=${po.id}`)
          })}>Raise purchase order</button>
        )}
        {r.purchase_order_id && <button className="btn btn-primary" onClick={() => navigate(`/erp/purchase-orders?open=${r.purchase_order_id}`)}>Open {r.purchase_order_number}</button>}
      </>
    }>
      <div className="rfv-body">
        {r.award_reason && <Note tone="ok">Award reason: {r.award_reason}</Note>}
        {r.status === 'awarded' && r.awarded_vendor && (
          <div className="rfv-won"><b>Awarded to {r.awarded_vendor}</b><span>{rupees(r.awarded_total)} landed{r.purchase_order_number ? ` · ordered on ${r.purchase_order_number}` : ' · purchase order not raised yet'}</span></div>
        )}
        <dl className="rfv-facts">
          {([
            ['RFQ date', fullDate(r.rfq_date ?? r.created_at)], ['Quotes due', fullDate(r.due_date)], ['Goods needed by', fullDate(r.required_by)],
            ['Deliver to', r.warehouse_name], ['Requisition', r.requisition_number], ['Payment terms', r.payment_terms],
            ['Delivery terms', r.delivery_terms], ['Quote validity', r.quote_validity_days ? `${r.quote_validity_days} days` : null],
            ['Contact person', r.contact_person], ['Raised by', r.created_by_name],
          ] as [string, ReactNode][]).map(([k, v]) => <div key={k}><dt>{k}</dt><dd className={k === 'Quotes due' && late ? 'rfl-late' : undefined}>{v ?? '—'}</dd></div>)}
        </dl>
        {(r.terms || r.notes) && (
          <div className="rfv-notes">
            {r.terms && <div><h4>Terms for vendors</h4><p>{r.terms}</p></div>}
            {r.notes && <div><h4>Internal notes</h4><p>{r.notes}</p></div>}
          </div>
        )}

        <section>
          <h4 className="rfv-h">Items <span>{r.lines.length}{targetTotal > 0 ? ` · target ${rupees(targetTotal)}` : ''}</span></h4>
          <div className="table-wrap"><table className="rfv-table">
            <thead><tr><th>#</th><th>Item</th><th>Specification</th><th className="crm-num">Qty</th><th>Unit</th><th className="crm-num">Target rate</th><th className="crm-num">Target value</th></tr></thead>
            <tbody>{r.lines.map((l, i) => (
              <tr key={l.id}>
                <td>{i + 1}</td>
                <td><b>{l.description}</b>{l.item_code && <small> {l.item_code}</small>}</td>
                <td className="rfv-spec">{l.specification || <span className="itl-muted">—</span>}</td>
                <td className="crm-num">{qtyText(l.quantity)}</td><td>{l.uom}</td>
                <td className="crm-num">{l.target_rate ? rupees(l.target_rate) : <span className="itl-muted">—</span>}</td>
                <td className="crm-num">{l.target_rate ? rupees(Number(l.quantity) * Number(l.target_rate)) : <span className="itl-muted">—</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </section>

        <section>
          <h4 className="rfv-h">Vendors <span>{quoted(r)} of {r.vendors.length} quoted</span></h4>
          <div className="table-wrap"><table className="rfv-table">
            <thead><tr><th>Vendor</th><th>Contact</th><th>Status</th><th className="crm-num">Latest landed</th><th>Valid until</th><th /></tr></thead>
            <tbody>{r.vendors.map((v) => {
              const q = latest(v.vendor_id)
              const expired = Boolean(q?.valid_until && q.valid_until < today)
              return (
                <tr key={v.vendor_id}>
                  <td><b>{v.legal_name}</b><small> {v.code}</small></td>
                  <td className="rfv-contact">{[v.contact_name, v.phone, v.email].filter(Boolean).join(' · ') || <span className="itl-muted">—</span>}</td>
                  <td>{v.quoted
                    ? <span className="crm-state crm-state-good">Quoted{v.rounds > 1 ? ` · ${v.rounds} rounds` : ''}</span>
                    : <span className="crm-state crm-state-idle">{r.status === 'draft' ? 'Not sent yet' : 'Awaiting quote'}</span>}</td>
                  <td className="crm-num">{q ? <b className={q.is_lowest ? 'rfv-best' : undefined}>{rupees(q.landed_total)}</b> : <span className="itl-muted">—</span>}</td>
                  <td className={expired ? 'rfl-late' : undefined}>{q?.valid_until ? <>{fullDate(q.valid_until)}{expired && ' · expired'}</> : <span className="itl-muted">—</span>}</td>
                  <td className="crm-num">
                    {mine && r.status === 'issued' && <button className="btn btn-sm" onClick={() => setQuoting(v.vendor_id)}>{v.quoted ? 'New round' : 'Record quote'}</button>}
                  </td>
                </tr>
              )
            })}</tbody>
          </table></div>
        </section>

        {cmp.data && quotes.length > 0 && (
          <section>
            <h4 className="rfv-h">Comparison <span>ranked on landed cost (after discount, with GST and freight)</span></h4>
            <div className="table-wrap rfv-cmp"><table className="rfv-table">
              <thead>
                <tr>
                  <th>Item</th>
                  {targetTotal > 0 && <th className="crm-num">Target</th>}
                  {quotes.map((q) => (
                    <th key={q.id} className={`crm-num${q.is_lowest ? ' rfv-col-best' : ''}`}>
                      <span className="rfv-rank">#{q.rank}</span> {q.vendor_name}{q.round > 1 ? ` · R${q.round}` : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cmp.data.lines.map((line) => (
                  <tr key={line.id}>
                    <td>{line.description} <span className="crm-sub">× {qtyText(line.quantity)} {line.uom}</span></td>
                    {targetTotal > 0 && <td className="crm-num crm-sub">{line.target_rate ? rupees(line.target_rate) : '—'}</td>}
                    {quotes.map((q) => {
                      const cell = line.rates[q.id]
                      const off = !cell || Number(cell.net_rate) <= 0
                      const best = !off && line.lowest_rate && Number(cell.net_rate) === Number(line.lowest_rate)
                      return (
                        <td key={q.id} className={`crm-num${best ? ' rfv-best' : ''}`}>
                          {off ? <span className="itl-muted">Not offered</span> : <>
                            {rupees(cell.net_rate)}
                            <small className="rfv-cell-sub">
                              {Number(cell.discount_percent) > 0 ? `${rupees(cell.rate)} less ${Number(cell.discount_percent)}% · ` : ''}GST {Number(cell.gst_percent)}%{cell.make ? ` · ${cell.make}` : ''}
                            </small>
                          </>}
                        </td>
                      )
                    })}
                  </tr>
                ))}
                {([
                  ['Taxable', (q) => rupees(q.taxable_total)],
                  ['GST', (q) => rupees(q.tax_total)],
                  ['Freight', (q) => rupees(q.freight)],
                ] as [string, (q: Comparison['quotes'][number]) => ReactNode][]).map(([k, f]) => (
                  <tr key={k} className="rfv-sum"><td>{k}</td>
                    {targetTotal > 0 && <td className="crm-num crm-sub">{k === 'Taxable' ? rupees(targetTotal) : ''}</td>}
                    {quotes.map((q) => <td key={q.id} className="crm-num">{f(q)}</td>)}</tr>
                ))}
                <tr className="rfv-total">
                  <td>Landed total</td>
                  {targetTotal > 0 && <td />}
                  {quotes.map((q) => {
                    const vs = vsTarget(q.id)
                    return (
                      <td key={q.id} className={`crm-num${q.is_lowest ? ' rfv-best' : ''}`}>
                        {rupees(q.landed_total)}
                        {vs !== null && <small className={`rfv-cell-sub ${vs > 0 ? 'is-up' : 'is-down'}`} title="Items with a target rate, before GST">{vs > 0 ? '+' : ''}{vs.toFixed(1)}% vs target</small>}
                      </td>
                    )
                  })}
                </tr>
                {([
                  ['Delivery', (q) => q.delivery_days != null ? `${q.delivery_days} days` : '—'],
                  ['Payment terms', (q) => q.payment_terms || '—'],
                  ['Warranty', (q) => q.warranty || '—'],
                  ['Valid until', (q) => fullDate(q.valid_until) ?? '—'],
                  ['Quote ref', (q) => [q.quote_ref, fullDate(q.quote_date)].filter(Boolean).join(' · ') || '—'],
                  ['Vendor score', (q) => q.vendor_score ? Number(q.vendor_score).toFixed(0) : '—'],
                ] as [string, (q: Comparison['quotes'][number]) => ReactNode][]).map(([k, f]) => (
                  <tr key={k} className="rfv-term"><td>{k}</td>{targetTotal > 0 && <td />}{quotes.map((q) => <td key={q.id} className="crm-num">{f(q)}</td>)}</tr>
                ))}
                {mine && r.status === 'issued' && (
                  <tr className="rfv-award"><td />{targetTotal > 0 && <td />}{quotes.map((q) => (
                    <td key={q.id} className="crm-num"><button className={`btn btn-sm${q.is_lowest ? ' btn-primary' : ''}`} onClick={() => setAward(q)}>Award</button></td>
                  ))}</tr>
                )}
              </tbody>
            </table></div>
          </section>
        )}
      </div>
    </Dialog>
      {quoting && <QuoteForm rfq={r} vendorId={quoting} onClose={() => setQuoting(null)} onSaved={() => { setQuoting(null); refresh() }} />}
      {inviting && <InviteVendors rfq={r} onClose={() => setInviting(false)} onDone={() => { setInviting(false); refresh() }} />}
      {printing && <RfqPrint rfq={r} onClose={() => setPrinting(false)} />}
      {award && (
        award.is_lowest && quotes.length > 1 ? (
          <Dialog title={`Award to ${award.vendor_name}?`} subtitle={`Lowest landed cost: ${rupees(award.landed_total)}. The RFQ closes and a purchase order can be raised.`} onClose={() => setAward(null)} footer={
            <>
              <button className="btn" onClick={() => setAward(null)}>Back</button>
              <button className="btn btn-primary" disabled={busy} onClick={() => void run(async () => { await erp.award(r.id, award.id); setAward(null) })}>Award</button>
            </>
          }><div style={{ padding: '0 20px 12px' }} /></Dialog>
        ) : (
          <ReasonDialog title={`Award to ${award.vendor_name}`} confirm="Award"
            hint={quotes.length === 1 ? 'Only one quote was received. Say why that is acceptable.' : 'This is not the lowest landed cost. Say why it wins.'}
            onClose={() => setAward(null)} onSubmit={async (reason) => { await erp.award(r.id, award.id, reason); refresh() }} />
        )
      )}
      {cancelling && <ReasonDialog title={`Cancel ${r.number}`} danger confirm="Cancel RFQ" onClose={() => setCancelling(false)}
        onSubmit={async (reason) => { await erp.cancelRfq(r.id, reason); refresh() }} />}
    </>
  )
}

function InviteVendors({ rfq, onClose, onDone }: { rfq: Rfq; onClose: () => void; onDone: () => void }) {
  const vendors = useQuery('erp-vendors-active', () => erp.vendors({ status: 'active' }))
  const [picked, setPicked] = useState<string[]>([])
  const { busy, error, run } = useRun()
  const asked = new Set(rfq.vendors.map((v) => v.vendor_id))
  const open = (vendors.data ?? []).filter((v) => !asked.has(v.id))
  return (
    <Dialog title={`Add vendors to ${rfq.number}`} subtitle="They quote on the same items and terms." onClose={onClose} footer={
      <>
        {error && <span className="error">{error}</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !picked.length} onClick={() => void run(async () => { await erp.inviteRfqVendors(rfq.id, picked); onDone() })}>Add {picked.length || ''} vendor{picked.length === 1 ? '' : 's'}</button>
      </>
    }>
      <div className="rff-vendors" style={{ margin: '0 20px 14px', maxHeight: 340 }}>
        {vendors.data && open.length === 0 && <p className="crm-muted">Every active vendor is already on this RFQ.</p>}
        {open.map((v) => (
          <label key={v.id} className={`rff-vendor${picked.includes(v.id) ? ' is-on' : ''}`}>
            <input type="checkbox" checked={picked.includes(v.id)} onChange={() => setPicked(picked.includes(v.id) ? picked.filter((x) => x !== v.id) : [...picked, v.id])} />
            <span><b>{v.legal_name}</b><small>{[v.code, v.category, v.state].filter(Boolean).join(' · ')}</small></span>
          </label>
        ))}
      </div>
    </Dialog>
  )
}

function QuoteForm({ rfq, vendorId, onClose, onSaved }: { rfq: Rfq; vendorId: string; onClose: () => void; onSaved: () => void }) {
  const vendor = rfq.vendors.find((v) => v.vendor_id === vendorId)
  // A new round starts from the vendor's last offer.
  const last = [...rfq.quotes].filter((q) => q.vendor_id === vendorId).sort((a, b) => b.round - a.round)[0]
  const prior = (lineId: string) => last?.lines.find((l) => l.rfq_line_id === lineId)
  const [rates, setRates] = useState<Record<string, { rate: string; disc: string; gst: string; make: string }>>(
    Object.fromEntries(rfq.lines.map((l) => {
      const p = prior(l.id)
      return [l.id, { rate: p ? String(Number(p.rate)) : '', disc: p && Number(p.discount_percent) ? String(Number(p.discount_percent)) : '', gst: p ? String(Number(p.gst_percent)) : '18', make: p?.make ?? '' }]
    })))
  const [meta, setMeta] = useState({
    quote_ref: '', quote_date: todayISO(), valid_until: '', delivery_days: last?.delivery_days != null ? String(last.delivery_days) : '',
    payment_terms: last?.payment_terms ?? rfq.payment_terms ?? '', warranty: last?.warranty ?? '', freight: last ? String(Number(last.freight)) : '0', notes: '',
  })
  const { busy, error, run } = useRun()
  const priced = rfq.lines.map((l) => {
    const r = rates[l.id]
    const net = Number(r.rate || 0) * (1 - Math.min(100, Number(r.disc || 0)) / 100)
    const taxable = Math.round(Number(l.quantity) * net * 100) / 100
    return { taxable, gst: Math.round(taxable * Number(r.gst || 0)) / 100 }
  })
  const taxable = priced.reduce((t, p) => t + p.taxable, 0)
  const gst = priced.reduce((t, p) => t + p.gst, 0)
  const freight = Number(meta.freight || 0)
  const validBad = Boolean(meta.valid_until && meta.quote_date && meta.valid_until < meta.quote_date)
  const discBad = rfq.lines.some((l) => Number(rates[l.id].disc || 0) > 100)
  const setRate = (id: string, patch: Partial<{ rate: string; disc: string; gst: string; make: string }>) => setRates({ ...rates, [id]: { ...rates[id], ...patch } })
  return (
    <Dialog wide title={`${last ? `Round ${last.round + 1}` : 'Quote'} from ${vendor?.legal_name ?? 'vendor'}`} subtitle="Leave the rate empty for an item the vendor did not offer." onClose={onClose} footer={
      <>
        {(error || validBad || discBad) && <span className="error">{error ?? (validBad ? 'The quote cannot expire before its date' : 'A discount cannot be above 100%')}</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || validBad || discBad || taxable <= 0} onClick={() => void run(async () => {
          await erp.addQuote(rfq.id, {
            vendor_id: vendorId, ...meta, delivery_days: meta.delivery_days ? Number(meta.delivery_days) : null,
            quote_date: meta.quote_date || null, valid_until: meta.valid_until || null, freight: meta.freight || '0',
            lines: rfq.lines.map((l) => ({
              rfq_line_id: l.id, rate: rates[l.id].rate || '0', discount_percent: rates[l.id].disc || '0',
              gst_percent: rates[l.id].gst || '0', make: rates[l.id].make.trim() || null,
            })),
          })
          onSaved()
        })}>Save quote</button>
      </>
    }>
      <div className="rff-body">
        <section className="rff-sec">
          <div className="rff-grid">
            <Field label="Vendor quote ref"><input placeholder="e.g. Q-2026-0142" maxLength={60} value={meta.quote_ref} onChange={(e) => setMeta({ ...meta, quote_ref: e.target.value })} /></Field>
            <Field label="Quote date"><input type="date" value={meta.quote_date} onChange={(e) => setMeta({ ...meta, quote_date: e.target.value })} /></Field>
            <Field label="Valid until"><input type="date" value={meta.valid_until} min={meta.quote_date || undefined} className={validBad ? 'is-bad' : undefined} onChange={(e) => setMeta({ ...meta, valid_until: e.target.value })} /></Field>
            <Field label="Delivery (days)"><input placeholder="e.g. 7" inputMode="numeric" value={meta.delivery_days} onChange={(e) => setMeta({ ...meta, delivery_days: e.target.value.replace(/\D/g, '').slice(0, 3) })} /></Field>
            <Field label="Payment terms"><input list="rff-pay2" maxLength={160} placeholder="e.g. 30 days from invoice" value={meta.payment_terms} onChange={(e) => setMeta({ ...meta, payment_terms: e.target.value })} /></Field>
            <Field label="Warranty"><input placeholder="e.g. 12 months" maxLength={160} value={meta.warranty} onChange={(e) => setMeta({ ...meta, warranty: e.target.value })} /></Field>
            <Field label="Freight (₹)"><input placeholder="0" inputMode="decimal" value={meta.freight} onChange={(e) => setMeta({ ...meta, freight: e.target.value })} /></Field>
          </div>
          <datalist id="rff-pay2">{PAYMENT_TERMS.map((t) => <option key={t} value={t} />)}</datalist>
        </section>
        <section className="rff-sec">
          <div className="table-wrap rff-lines"><table>
            <thead><tr>
              <th className="rff-c-no">#</th><th>Item</th><th className="rff-c-qty">Qty</th><th className="rff-c-rate">Rate (₹)</th><th className="rff-c-disc">Disc %</th>
              <th className="rff-c-gst">GST %</th><th>Make / model offered</th><th className="rff-c-amt">Amount (₹)</th>
            </tr></thead>
            <tbody>{rfq.lines.map((l, i) => {
              const r = rates[l.id]
              const g = String(Number(r.gst || 0))
              return (
                <tr key={l.id}>
                  <td className="rff-c-no">{i + 1}</td>
                  <td className="rff-c-desc"><b>{l.description}</b>{l.specification && <small>{l.specification}</small>}</td>
                  <td className="rff-c-qty rff-ro">{qtyText(l.quantity)} {l.uom}</td>
                  <td className="rff-c-rate"><input placeholder="Not offered" inputMode="decimal" value={r.rate} onChange={(e) => setRate(l.id, { rate: e.target.value })} aria-label={`Rate, ${l.description}`} /></td>
                  <td className="rff-c-disc"><input placeholder="0" inputMode="decimal" className={Number(r.disc || 0) > 100 ? 'is-bad' : undefined} value={r.disc} onChange={(e) => setRate(l.id, { disc: e.target.value })} aria-label={`Discount, ${l.description}`} /></td>
                  <td className="rff-c-gst">
                    <select value={g} onChange={(e) => setRate(l.id, { gst: e.target.value })} aria-label={`GST, ${l.description}`}>
                      {!GST.includes(g) && <option value={g}>{g}%</option>}
                      {GST.map((x) => <option key={x} value={x}>{x}%</option>)}
                    </select>
                  </td>
                  <td><input placeholder="e.g. Cisco CBS350" maxLength={120} value={r.make} onChange={(e) => setRate(l.id, { make: e.target.value })} aria-label={`Make, ${l.description}`} /></td>
                  <td className="rff-c-amt rff-ro">{priced[i].taxable > 0 ? rupees(priced[i].taxable) : '—'}</td>
                </tr>
              )
            })}</tbody>
          </table></div>
          <div className="rff-totals">
            <Field label="Notes"><input placeholder="e.g. Prices firm till 30 Nov" value={meta.notes} onChange={(e) => setMeta({ ...meta, notes: e.target.value })} /></Field>
            <dl>
              <div><dt>Taxable</dt><dd>{rupees(taxable)}</dd></div>
              <div><dt>GST</dt><dd>{rupees(gst)}</dd></div>
              <div><dt>Freight</dt><dd>{rupees(freight)}</dd></div>
              <div className="is-total"><dt>Landed total</dt><dd>{rupees(taxable + gst + freight)}</dd></div>
            </dl>
          </div>
        </section>
      </div>
    </Dialog>
  )
}
