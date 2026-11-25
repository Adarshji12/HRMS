/* Sale — every sale bill in a date range, as a keyboard-first register.
 *
 * Same data, same drawer, same print and same new-bill form as before: this is
 * the list's layout, not a new ledger. A bill's own screen opens over the list
 * (Enter), and a new bill opens in a second tab (F2) so the register stays
 * where it was.
 *
 * Keys: ↑ ↓ move · Enter open · F2 new · F3 filters · PgUp / PgDn page.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '../../lib/useQuery'
import { Loading, ErrorNote } from '../../components/ui'
import {
  IconChevronDown, IconClose, IconDownload, IconFilter, IconFolder, IconPlus, IconPrinter, IconSearch, IconSheet,
} from '../../components/Icons'
import { downloadCsv } from '../../lib/sheet'
import { todayISO } from '../crm/api'
import { CrmPage } from '../crm/parts'
import { erp, erpError, rupees, type Invoice } from './api'
import { DateText, useAccess } from './parts'
import { Dialog } from '../crm/parts'
import { InvoiceDrawer, ManualInvoice, PAY_LABEL, PrintById, payState, type PayState } from './ErpBilling'
import { ColumnSettings, useColumns, type ColumnDef } from '../../components/ViewSettings'
import '../../styles/sale-list.css'

const PAGE_SIZE = 14

const TONE: Record<PayState, 'good' | 'warn' | 'bad' | 'idle'> = {
  paid: 'good', issued: 'good', partial: 'warn', unpaid: 'warn', pending: 'warn', overdue: 'bad',
  draft: 'idle', cancelled: 'idle', rejected: 'bad',
}

/** "INV-2026-27/0001" → series "INV-2026-27", number 1. */
const seriesOf = (n: string | null) => (n ? n.replace(/\/?\d+$/, '') : '')
const numberOf = (n: string | null) => {
  const m = n?.match(/(\d+)$/)
  return m ? Number(m[1]) : null
}
const KIND_LABEL: Record<string, string> = {
  product: 'Product invoice', service: 'Tax invoice', milestone: 'Milestone invoice', proforma: 'Proforma',
}

interface SaleCtx { index: number; mobiles: Map<string, string>; openBill: (id: string) => void; printBill: (id: string) => void }
type SaleColumn = ColumnDef & { td: (i: Invoice, ctx: SaleCtx) => ReactNode; className?: string; thClass?: string }
const dash = <span className="sl-dim">—</span>
const SALE_COLUMNS: SaleColumn[] = [
  { key: 'no', label: '#', thClass: 'sl-c', className: 'sl-c sl-dim', td: (_i, c) => <>{c.index}</> },
  { key: 'number', label: 'Bill No.', locked: true,
    td: (i, c) => <button type="button" className="sl-link" onClick={() => c.openBill(i.id)}>{i.number ?? 'Draft'}</button> },
  { key: 'date', label: 'Date', td: (i) => <DateText iso={i.invoice_date} /> },
  { key: 'party', label: 'Party', className: 'sl-party', td: (i) => <>{i.customer_name}</> },
  { key: 'station', label: 'Station', td: (i) => <>{i.place_of_supply ?? dash}</> },
  { key: 'mobile', label: 'Mobile', className: 'sl-mono', td: (i, c) => <>{c.mobiles.get(i.customer_id) ?? dash}</> },
  { key: 'taxable', label: 'Taxable', thClass: 'sl-r', className: 'sl-r', td: (i) => <>{rupees(i.sub_total)}</> },
  { key: 'gst', label: 'GST', thClass: 'sl-r', className: 'sl-r', td: (i) => <>{rupees(i.tax_total)}</> },
  { key: 'net', label: 'Net Amount', thClass: 'sl-r', className: 'sl-r sl-strong', td: (i) => <>{rupees(i.grand_total)}</> },
  { key: 'balance', label: 'Balance', thClass: 'sl-r', className: 'sl-r', td: (i) => <>{rupees(i.outstanding)}</> },
  { key: 'due', label: 'Due Date', td: (i) => <DateText iso={i.due_date} /> },
  { key: 'status', label: 'Status', td: (i) => <span className={`sl-pill sl-pill-${TONE[payState(i)]}`}>{PAY_LABEL[payState(i)]}</span> },
  { key: 'print', label: 'Print', thClass: 'sl-c', className: 'sl-c', td: (i, c) => (
    <button type="button" className="sl-icon" aria-label={`Print ${i.number ?? 'draft'}`} onClick={(e) => { e.stopPropagation(); c.printBill(i.id) }}>
      <IconPrinter size={14} />
    </button>
  ) },
  { key: 'user', label: 'User', td: (i) => <>{i.created_by_name ?? dash}</> },
  { key: 'gstin', label: 'Party GSTIN', initial: false, className: 'sl-mono', td: (i) => <>{i.gstin ?? dash}</> },
  { key: 'order', label: 'Sales order', initial: false, td: (i) => <>{i.order_number ?? dash}</> },
  { key: 'po', label: 'Customer PO', initial: false, td: (i) => <>{i.customer_po_number ?? dash}</> },
  { key: 'salesperson', label: 'Salesperson', initial: false, td: (i) => <>{i.salesperson_name ?? dash}</> },
  { key: 'eway', label: 'E-Way Bill', initial: false, td: (i) => <>{i.eway_bill_number ?? dash}</> },
  { key: 'kind', label: 'Type', initial: false, td: (i) => <>{KIND_LABEL[i.kind] ?? i.kind}</> },
]

interface SaleFilters {
  series: string
  noFrom: string
  noTo: string
  name: string
  mobile: string
  customer: string
  state: '' | PayState
  kind: string
  user: string
  station: string
  above: string
}
const NO_FILTERS: SaleFilters = {
  series: '', noFrom: '', noTo: '', name: '', mobile: '', customer: '', state: '', kind: '', user: '', station: '', above: '',
}

const firstOfMonth = () => `${todayISO().slice(0, 8)}01`

export default function ErpSale() {
  const columns = useColumns('sale-register', SALE_COLUMNS)
  const [params, setParams] = useSearchParams()
  const { can, loaded } = useAccess()
  const biller = can('can_manage_billing')

  const [from, setFrom] = useState(firstOfMonth)
  const [to, setTo] = useState(todayISO)
  const [q, setQ] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [filters, setFilters] = useState<SaleFilters>(NO_FILTERS)

  const [billOpen, setBillOpen] = useState(false)
  const [openId, setOpenId] = useState<string | null>(params.get('open'))
  const [printId, setPrintId] = useState<string | null>(null)
  useEffect(() => {
    if (params.get('open')) {
      setOpenId(params.get('open'))
      setParams({}, { replace: true })
    }
  }, [params, setParams])

  const [reload, setReload] = useState(0)
  const list = useQuery(`erp-sale-${reload}`, () =>
    erp.invoices({}).then((xs) => xs.filter((i) => i.kind !== 'credit_note')),
  )
  const accounts = useQuery('erp-sale-customers', () => erp.customers())
  const mobiles = useMemo(
    () => new Map((accounts.data ?? []).map((c) => [c.customer_id, c.mobile])),
    [accounts.data],
  )

  const all = list.data ?? []
  const needle = q.trim().toLowerCase()
  const rows = useMemo(
    () => all
      .filter((i) => (!from || i.invoice_date >= from) && (!to || i.invoice_date <= to)
        && (!filters.state || payState(i) === filters.state)
        && (!filters.customer || i.customer_id === filters.customer)
        && (!filters.series || seriesOf(i.number) === filters.series)
        && (!filters.noFrom || (numberOf(i.number) ?? -1) >= Number(filters.noFrom))
        && (!filters.noTo || (numberOf(i.number) ?? Infinity) <= Number(filters.noTo))
        && (!filters.name || i.customer_name.toLowerCase().includes(filters.name.trim().toLowerCase()))
        && (!filters.mobile || (mobiles.get(i.customer_id) ?? '').replace(/\D/g, '').includes(filters.mobile.replace(/\D/g, '')))
        && (!filters.kind || i.kind === filters.kind)
        && (!filters.user || (i.created_by_name ?? '') === filters.user)
        && (!filters.station || (i.place_of_supply ?? '') === filters.station)
        && (!filters.above || Number(i.grand_total) >= Number(filters.above))
        && (!needle || [i.number, i.customer_name, mobiles.get(i.customer_id), i.gstin]
          .some((v) => v && String(v).toLowerCase().includes(needle))))
      .sort((a, b) => (b.invoice_date + (b.number ?? '')).localeCompare(a.invoice_date + (a.number ?? ''))),
    [all, from, to, filters, needle, mobiles],
  )
  const customers = useMemo(
    () => [...new Map(all.map((i) => [i.customer_id, i.customer_name])).entries()].sort((a, b) => a[1].localeCompare(b[1])),
    [all],
  )

  const uniq = (xs: Array<string | null | undefined>) => [...new Set(xs.filter((x): x is string => Boolean(x)))].sort()
  const seriesList = useMemo(() => uniq(all.map((i) => seriesOf(i.number))), [all])
  const usersList = useMemo(() => uniq(all.map((i) => i.created_by_name)), [all])
  const stationsList = useMemo(() => uniq(all.map((i) => i.place_of_supply)), [all])
  const kindsList = useMemo(() => uniq(all.map((i) => i.kind)), [all])
  const activeFilters = Object.entries(filters).filter(([, v]) => v !== '').length

  const [page, setPage] = useState(0)
  const [cursor, setCursor] = useState(0)
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const safePage = Math.min(page, pages - 1)
  const shown = rows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)
  const current = shown[Math.min(cursor, Math.max(0, shown.length - 1))] ?? null
  useEffect(() => { setPage(0); setCursor(0) }, [from, to, q, filters])

  // The keys. Typing in a field keeps its own keys; F2 and F3 work from anywhere.
  const keys = useRef({ shown, cursor, pages, safePage, biller })
  keys.current = { shown, cursor, pages, safePage, biller }
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (openId || printId) return
      const k = keys.current
      const typing = event.target instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName)
      if (event.key === 'F2') {
        event.preventDefault()
        if (k.biller) setBillOpen(true)
      } else if (event.key === 'F3') {
        event.preventDefault()
        setFiltersOpen((open) => !open)
      } else if (!typing && !billOpen) {
        if (event.key === 'ArrowDown') { event.preventDefault(); setCursor((c) => Math.min(c + 1, k.shown.length - 1)) }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setCursor((c) => Math.max(c - 1, 0)) }
        else if (event.key === 'Enter') { const row = k.shown[k.cursor]; if (row) setOpenId(row.id) }
        else if (event.key === 'PageDown') { event.preventDefault(); setPage(Math.min(k.safePage + 1, k.pages - 1)); setCursor(0) }
        else if (event.key === 'PageUp') { event.preventDefault(); setPage(Math.max(k.safePage - 1, 0)); setCursor(0) }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openId, printId, billOpen])

  function exportRows() {
    downloadCsv(
      `sale-${from || 'start'}-to-${to || 'today'}.csv`,
      ['Bill No.', 'Date', 'Party', 'Station', 'Mobile', 'Taxable', 'GST', 'Net amount', 'Balance', 'Due date', 'Status', 'User'],
      rows.map((i) => [
        i.number ?? 'Draft', i.invoice_date, i.customer_name, i.place_of_supply ?? '', mobiles.get(i.customer_id) ?? '',
        i.sub_total, i.tax_total, i.grand_total, i.outstanding, i.due_date ?? '', PAY_LABEL[payState(i)], i.created_by_name ?? '',
      ]),
    )
  }

  return (
    <CrmPage>
      <div className="sl">
        {/* ----------------------------------------------------------- tabs -- */}
        <div className="sl-tabs" role="tablist">
          <button role="tab" aria-selected={!billOpen} className={`sl-tab${!billOpen ? ' is-on' : ''}`} onClick={() => setBillOpen(false)}>
            <IconFolder size={15} /> Sale
          </button>
          {billOpen && (
            <span role="tab" aria-selected className="sl-tab is-on sl-tab-bill">
              <IconSheet size={15} /> Sale Bill
              <button type="button" className="sl-x" aria-label="Close the bill" onClick={() => setBillOpen(false)}><IconClose size={12} /></button>
            </span>
          )}
          <button type="button" className="sl-newwin" onClick={() => window.open(window.location.href, '_blank')}>
            <IconPlus size={14} /> New Window <IconChevronDown size={12} />
          </button>
        </div>

        {!loaded ? <Loading /> : billOpen && biller ? (
          <ManualInvoice
            inline
            onClose={() => setBillOpen(false)}
            onShowAll={() => setBillOpen(false)}
            onSaved={(inv) => { setReload((n) => n + 1); setBillOpen(false); setOpenId(inv.id) }}
          />
        ) : (
          <>
            {/* ------------------------------------------------------ toolbar -- */}
            <div className="sl-bar">
              <h1 className="sl-title">Sale</h1>
              <label className="sl-search">
                <IconSearch size={15} />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Bill no. or party" aria-label="Search bills" />
              </label>
              <div className="sl-tools">
                <button type="button" className={`sl-btn${filtersOpen ? ' is-on' : ''}`} aria-pressed={filtersOpen} onClick={() => setFiltersOpen((o) => !o)}>
                  <IconFilter size={14} /> Filters{(activeFilters > 0 || from !== firstOfMonth() || to !== todayISO()) && <span className="sl-count">{activeFilters + (from !== firstOfMonth() || to !== todayISO() ? 1 : 0)}</span>}
                </button>
                <button type="button" className="sl-btn" onClick={exportRows} disabled={rows.length === 0}><IconDownload size={14} /> Export</button>
                <ColumnSettings defs={SALE_COLUMNS} order={columns.pref.order} hidden={columns.pref.hidden} onSave={columns.save} onReset={columns.reset} />
                {biller && (
                  <button type="button" className="sl-btn sl-btn-primary" onClick={() => setBillOpen(true)}>
                    <IconPlus size={14} /> New <kbd>F2</kbd>
                  </button>
                )}
              </div>
            </div>

            {filtersOpen && (
              <FilterDialog
                value={filters} from={from} to={to}
                onClose={() => setFiltersOpen(false)}
                onApply={(next, f, t) => { setFilters(next); setFrom(f); setTo(t); setFiltersOpen(false) }}
                series={seriesList} customers={customers} users={usersList} stations={stationsList} kinds={kindsList}
              />
            )}

            {list.error && <ErrorNote>{erpError(list.cause, 'Could not load the bills')}</ErrorNote>}

            {/* -------------------------------------------------------- table -- */}
            <div className="sl-table-wrap">
              <table className="sl-table">
                <thead>
                  <tr>
                    {columns.visible.map((c) => <th key={c.key} className={(c as SaleColumn).thClass}>{c.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {list.loading && !list.data ? (
                    <tr><td colSpan={columns.visible.length} className="sl-empty"><Loading /></td></tr>
                  ) : shown.map((i, index) => (
                    <tr
                      key={i.id}
                      className={index === cursor ? 'is-cur' : undefined}
                      onClick={() => setCursor(index)}
                      onDoubleClick={() => setOpenId(i.id)}
                      aria-selected={index === cursor}
                    >
                      {columns.visible.map((c) => {
                        const col = c as SaleColumn
                        return (
                          <td key={col.key} className={col.className} title={col.key === 'party' ? i.customer_name : undefined}>
                            {col.td(i, { index: safePage * PAGE_SIZE + index + 1, mobiles, openBill: setOpenId, printBill: setPrintId })}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* ------------------------------------------------ bill details -- */}
            <div className="sl-details">
              <section>
                <h2>Bill &amp; user details</h2>
                <dl>
                  <dt>No. of bills</dt><dd>{rows.length}</dd>
                  <dt>Created by</dt><dd>{current?.created_by_name ?? '—'}</dd>
                  <dt>Posted by</dt><dd>{current?.posted_by_name ?? '—'}</dd>
                </dl>
              </section>
              <section>
                <h2>Order details</h2>
                <dl>
                  <dt>Sales order</dt><dd>{current?.order_number ?? '—'}</dd>
                  <dt>Customer PO</dt><dd>{current?.customer_po_number ?? '—'}</dd>
                  <dt>Salesperson</dt><dd>{current?.salesperson_name ?? '—'}</dd>
                </dl>
              </section>
              <section>
                <h2>Other details</h2>
                <dl>
                  <dt>E-Way Bill</dt><dd>{current?.eway_bill_number ?? '—'}</dd>
                  <dt>Place of supply</dt><dd>{current?.place_of_supply ?? '—'}</dd>
                  <dt>Party GSTIN</dt><dd>{current?.gstin ?? '—'}</dd>
                </dl>
              </section>
            </div>

            <div className="sl-keys">
              <span><kbd>↑</kbd><kbd>↓</kbd> Move</span>
              <span><kbd>Enter</kbd> Open bill</span>
              {biller && <span><kbd>F2</kbd> New bill</span>}
              <span><kbd>PgUp</kbd> / <kbd>PgDn</kbd> Page {safePage + 1} of {pages}</span>
            </div>
          </>
        )}
      </div>

      {openId && (
        <InvoiceDrawer id={openId} onOpen={setOpenId} onClose={() => setOpenId(null)} onChanged={() => setReload((n) => n + 1)} />
      )}
      {printId && <PrintById id={printId} onClose={() => setPrintId(null)} />}
    </CrmPage>
  )
}

/** GST invoice filters: set a few, press Submit, and the register narrows. */
function FilterDialog({ value, from, to, onClose, onApply, series, customers, users, stations, kinds }: {
  value: SaleFilters
  from: string
  to: string
  onClose: () => void
  onApply: (next: SaleFilters, from: string, to: string) => void
  series: string[]
  customers: Array<[string, string]>
  users: string[]
  stations: string[]
  kinds: string[]
}) {
  const [f, setF] = useState(value)
  const [d1, setD1] = useState(from)
  const [d2, setD2] = useState(to)
  const set = <K extends keyof SaleFilters>(key: K, v: SaleFilters[K]) => setF((c) => ({ ...c, [key]: v }))
  const bad = (f.noFrom && f.noTo && Number(f.noFrom) > Number(f.noTo)) || (f.above !== '' && !/^\d+(\.\d{1,2})?$/.test(f.above))
  return (
    <Dialog
      title="GST Invoice Filters"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}><kbd>Esc</kbd> Close</button>
          <button type="button" className="btn" onClick={() => { setF(NO_FILTERS); onApply(NO_FILTERS, firstOfMonth(), todayISO()) }}>Reset</button>
          <button type="button" className="btn btn-primary" disabled={Boolean(bad)} onClick={() => onApply(f, d1, d2)}>Submit</button>
        </>
      }
    >
      <form className="sl-fd" onSubmit={(e) => { e.preventDefault(); if (!bad) onApply(f, d1, d2) }}>
        <div className="sl-fd-row"><span>Date From</span>
          <div className="sl-fd-pair">
            <input type="date" value={d1} max={d2 || undefined} aria-label="From date" onChange={(e) => setD1(e.target.value)} />
            <span>Date To</span>
            <input type="date" value={d2} min={d1 || undefined} aria-label="To date" onChange={(e) => setD2(e.target.value)} />
          </div>
        </div>
        <label className="sl-fd-row"><span>Multiseries</span>
          <select value={f.series} onChange={(e) => set('series', e.target.value)} autoFocus>
            <option value="">All series</option>
            {series.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <div className="sl-fd-row"><span>Bill No. From</span>
          <div className="sl-fd-pair">
            <input inputMode="numeric" placeholder="1" value={f.noFrom} aria-label="Bill number from" onChange={(e) => set('noFrom', e.target.value.replace(/\D/g, ''))} />
            <span>Bill No. To</span>
            <input inputMode="numeric" placeholder="9999" value={f.noTo} aria-label="Bill number to" onChange={(e) => set('noTo', e.target.value.replace(/\D/g, ''))} />
          </div>
        </div>
        <div className="sl-fd-row"><span>Customer Name</span>
          <div className="sl-fd-pair">
            <input value={f.name} aria-label="Customer name" placeholder="e.g. Sharma Traders" onChange={(e) => set('name', e.target.value)} />
            <span>Customer Mob.</span>
            <input inputMode="numeric" value={f.mobile} aria-label="Customer mobile" placeholder="e.g. 9876543210" onChange={(e) => set('mobile', e.target.value.replace(/[^\d+ ]/g, ''))} />
          </div>
        </div>
        <label className="sl-fd-row"><span>Party</span>
          <select value={f.customer} onChange={(e) => set('customer', e.target.value)}>
            <option value="">All Ledgers</option>
            {customers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <label className="sl-fd-row"><span>Status</span>
          <select value={f.state} onChange={(e) => set('state', e.target.value as '' | PayState)}>
            <option value="">All</option>
            {(Object.keys(PAY_LABEL) as PayState[]).map((st) => <option key={st} value={st}>{PAY_LABEL[st]}</option>)}
          </select>
        </label>
        <label className="sl-fd-row"><span>Sale Type</span>
          <select value={f.kind} onChange={(e) => set('kind', e.target.value)}>
            <option value="">All</option>
            {kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k] ?? k}</option>)}
          </select>
        </label>
        <label className="sl-fd-row"><span>User Name</span>
          <select value={f.user} onChange={(e) => set('user', e.target.value)}>
            <option value="">All Users</option>
            {users.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </label>
        <label className="sl-fd-row"><span>Station</span>
          <select value={f.station} onChange={(e) => set('station', e.target.value)}>
            <option value="">All Stations</option>
            {stations.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <label className="sl-fd-row"><span>Sale Above</span>
          <input type="number" data-spin min={0} step="any" value={f.above} placeholder="₹ amount" onChange={(e) => set('above', e.target.value.replace(/,/g, ''))} />
        </label>
        {bad && <p className="sl-fd-err">Check the bill numbers (From is above To) and the amount.</p>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

export type { Invoice }
