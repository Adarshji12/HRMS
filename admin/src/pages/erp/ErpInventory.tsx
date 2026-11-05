/* Inventory — what is where, how it got there, and the documents that move it.
 *
 * Stock arrives through GRNs (on the purchase order) and leaves through
 * dispatches (on the sales order). Everything else — an issue to a project, a
 * return, a transfer, a counted adjustment — is a stock document here. Only
 * the adjustment is approved: it changes what the company owns without
 * anything physically moving. */

import { useState, type ReactNode } from 'react'
import { useQuery } from '../../lib/useQuery'
import { useAuth } from '../../lib/auth'
import { asUTC, dateTime } from '../../lib/format'
import { downloadCsv, downloadXlsx } from '../../lib/sheet'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconCard, IconDownload, IconPlus, IconSearch, IconSliders, IconTrash } from '../../components/Icons'
import { todayISO } from '../crm/api'
import { CONDITIONS, erp, erpError, qtyText, rupees, type StockDoc } from './api'
import { DATE_RANGES, rangeDates, type DateRange } from './ErpBilling'
import {
  ChainView, DecideBar, Dialog, ErpPage, ErpState, Facts, label, Note, ReasonDialog, SearchSelect,
  useAccess, useItems, useRun, type PickOption,
} from './parts'
import '../../styles/invoice.css'
import '../../styles/salebill.css'
import '../../styles/inventory.css'

type Tab = 'stock' | 'movements' | 'serials' | 'docs'

const TABS: [Tab, string][] = [
  ['stock', 'Stock on hand'], ['movements', 'Ledger'], ['serials', 'Serial lookup'], ['docs', 'Issues, transfers & adjustments'],
]
type DocKind = StockDoc['kind']
const DOC_KINDS: DocKind[] = ['opening', 'issue', 'return', 'transfer', 'adjustment']

export default function ErpInventory() {
  const [tab, setTab] = useState<Tab>(() => (new URLSearchParams(window.location.search).get('tab') === 'docs' ? 'docs' : 'stock'))
  // A stock row opens the ledger behind it.
  const [ledger, setLedger] = useState({ itemId: '', warehouseId: '' })
  // Set when a document is started from elsewhere; the documents tab opens it.
  const [startKind, setStartKind] = useState<DocKind | null>(null)
  return (
    <ErpPage>
      <div className="bil-tabs" role="tablist" aria-label="Inventory sections">
        {TABS.map(([key, name]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'is-on' : undefined}
                  onClick={() => setTab(key)}>{name}</button>
        ))}
      </div>
      {tab === 'stock' && (
        <StockTab onLedger={(itemId, warehouseId) => { setLedger({ itemId, warehouseId }); setTab('movements') }}
                  onStart={(kind) => { setStartKind(kind); setTab('docs') }} />
      )}
      {tab === 'movements' && <MovementsTab initial={ledger} />}
      {tab === 'serials' && <SerialsTab />}
      {tab === 'docs' && <DocsTab startKind={startKind} onStarted={() => setStartKind(null)} />}
    </ErpPage>
  )
}

function useWarehouses() {
  return useQuery('erp-wh-all', () => erp.warehouses())
}

/* ------------------------------------------------------------ shared bar --- */

/** The Filters button and its panel, as on the invoice list. */
function FilterMenu({ count, shown, total, onClear, children }: {
  count: number; shown: number; total: number; onClear: () => void; children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="ivl-filter">
      <button type="button" className={`btn ivl-filter-btn${count ? ' is-on' : ''}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <IconSliders size={15} /> Filters{count > 0 && <span className="ivl-filter-n">{count}</span>}
      </button>
      {open && (
        <>
          <div className="ivl-filter-scrim" onClick={() => setOpen(false)} />
          <div className="ivl-filter-pop" role="dialog" aria-label="Filters">
            <div className="ivl-filter-grid">{children}</div>
            <div className="ivl-filter-foot">
              <span>{shown} of {total} match</span>
              <button type="button" className="btn btn-sm" disabled={!count} onClick={onClear}>Clear all</button>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => setOpen(false)}>Done</button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

type Cell = string | number | null
function ExportMenu({ name, sheet, header, rows, money }: { name: string; sheet: string; header: string[]; rows: Cell[][]; money: number[] }) {
  const [open, setOpen] = useState(false)
  const file = `${name}-${todayISO()}`
  return (
    <div className="ivl-export">
      <button type="button" className="btn" disabled={!rows.length} aria-haspopup="menu" aria-expanded={open}
        title={rows.length ? `Export the ${rows.length} shown` : 'Nothing to export'} onClick={() => setOpen((v) => !v)}>
        <IconDownload size={15} /> Export
      </button>
      {open && (
        <div className="ivl-export-menu" role="menu" onMouseLeave={() => setOpen(false)}>
          <button type="button" role="menuitem" onClick={() => { downloadXlsx(`${file}.xlsx`, sheet, header, rows, money); setOpen(false) }}><b>Excel</b><small>.xlsx · {rows.length} rows</small></button>
          <button type="button" role="menuitem" onClick={() => { downloadCsv(`${file}.csv`, header, rows); setOpen(false) }}><b>CSV</b><small>.csv · {rows.length} rows</small></button>
        </div>
      )}
    </div>
  )
}

/** A from / to date pair with its quick ranges, for a filter panel. */
function useDates() {
  const [range, setRange] = useState<DateRange>('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const pick = (r: DateRange) => {
    setRange(r)
    if (r === 'custom') return
    const [f, t] = r ? rangeDates(r) : ['', '']
    setFrom(f)
    setTo(t)
  }
  return {
    from, to, active: Boolean(from || to), clear: () => pick(''),
    fields: (
      <>
        <label className="is-wide"><span>Date</span>
          <select value={range} onChange={(e) => pick(e.target.value as DateRange)} aria-label="Date range">
            <option value="">Any date</option>
            {DATE_RANGES.map(([k, name]) => <option key={k} value={k}>{name}</option>)}
          </select></label>
        <label><span>From</span><input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setRange('custom') }} /></label>
        <label><span>To</span><input type="date" value={to} min={from || undefined} onChange={(e) => { setTo(e.target.value); setRange('custom') }} /></label>
      </>
    ),
  }
}

/** A date with its year: opening stock and warranties cross financial years. */
const fullDate = (iso: string | null | undefined) => (iso
  ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  : '—')

const has = (needle: string, values: Array<string | null | undefined>) => !needle || values.some((v) => v && v.toLowerCase().includes(needle))

/** The calendar day a timestamp falls on here, for comparing with a date filter. */
function localDay(iso: string) {
  const d = new Date(asUTC(iso))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/* --------------------------------------------------------- stock on hand --- */

type StockView = '' | 'low' | 'reserved' | 'unsaleable'
const STOCK_VIEWS: [Exclude<StockView, ''>, string][] = [['low', 'Low stock'], ['reserved', 'Reserved'], ['unsaleable', 'Not saleable']]

function StockTab({ onLedger, onStart }: { onLedger: (itemId: string, warehouseId: string) => void; onStart: (kind: DocKind) => void }) {
  const { can } = useAccess()
  const warehouses = useWarehouses()
  const q = useQuery('erp-stock', () => erp.stock())
  const [term, setTerm] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  const [condition, setCondition] = useState('')
  const [view, setView] = useState<StockView>('')
  const isLow = (r: { reorder_level: string; available_qty: string }) => Number(r.reorder_level) > 0 && Number(r.available_qty) <= Number(r.reorder_level)
  const all = q.data ?? []
  // The figures follow the warehouse and condition chosen, not the search.
  const scope = all.filter((r) => (!warehouseId || r.warehouse_id === warehouseId) && (!condition || r.condition === condition))
  const needle = term.trim().toLowerCase()
  const rows = scope.filter((r) => has(needle, [r.item_code, r.item_name, r.warehouse_name])
    && (view !== 'low' || isLow(r)) && (view !== 'reserved' || Number(r.reserved_qty) > 0) && (view !== 'unsaleable' || r.condition !== 'good'))
  const sum = (xs: typeof all, f: (r: (typeof all)[number]) => string) => xs.reduce((n, r) => n + Number(f(r) || 0), 0)
  const low = scope.filter(isLow)
  const reserved = scope.filter((r) => Number(r.reserved_qty) > 0)
  const unsaleable = scope.filter((r) => r.condition !== 'good')
  const clear = () => { setTerm(''); setWarehouseId(''); setCondition(''); setView('') }
  const active = [warehouseId, condition, view].filter(Boolean).length
  return (
    <>
      {q.data && (
        <div className="ivl-kpis">
          <button type="button" className="ivl-kpi" onClick={() => setView('')}>
            <span>Stock value</span><b>{rupees(sum(scope, (r) => r.value))}</b><small>at weighted average cost</small>
          </button>
          <div className="ivl-kpi is-static is-idle"><span>Items in stock</span><b>{new Set(scope.map((r) => r.item_id)).size}</b><small>{(() => { const n = new Set(scope.map((r) => r.warehouse_id)).size; return `in ${n} ${n === 1 ? 'warehouse' : 'warehouses'}` })()}</small></div>
          <button type="button" className="ivl-kpi is-good" onClick={() => setView('reserved')}>
            <span>Reserved</span><b>{qtyText(sum(reserved, (r) => r.reserved_qty))}</b><small>units held for sales orders</small>
          </button>
          <button type="button" className="ivl-kpi is-warn" onClick={() => setView('low')}>
            <span>Low stock</span><b>{low.length}</b><small>at or below reorder level</small>
          </button>
          <button type="button" className="ivl-kpi is-bad" onClick={() => setView('unsaleable')}>
            <span>Not saleable</span><b>{rupees(sum(unsaleable, (r) => r.value))}</b><small>defective, RMA, scrap and so on</small>
          </button>
        </div>
      )}
      <div className="crm-bar ivl-bar">
        <div className="crm-search"><IconSearch size={15} />
          <input type="search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search item code, name or warehouse…" /></div>
        <div className="ivl-tools">
          {(term || active > 0) && <button type="button" className="btn btn-sm ivl-clear" onClick={clear}>Clear</button>}
          {q.data && <span className="ivl-count">{rows.length} of {all.length}</span>}
          <FilterMenu count={active} shown={rows.length} total={all.length} onClear={clear}>
            <label className="is-wide"><span>Warehouse</span>
              <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                <option value="">All warehouses</option>{(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select></label>
            <label><span>Condition</span>
              <select value={condition} onChange={(e) => setCondition(e.target.value)}>
                <option value="">All conditions</option>{CONDITIONS.map((c) => <option key={c} value={c}>{label(c)}</option>)}
              </select></label>
            <label><span>Show</span>
              <select value={view} onChange={(e) => setView(e.target.value as StockView)}>
                <option value="">All stock</option>{STOCK_VIEWS.map(([k, name]) => <option key={k} value={k}>{name}</option>)}
              </select></label>
          </FilterMenu>
          <ExportMenu name="stock-on-hand" sheet="Stock on hand" money={[9, 10]}
            header={['Item code', 'Item', 'Warehouse', 'Condition', 'On hand', 'Unit', 'Reserved', 'Available', 'Reorder level', 'Avg cost', 'Value']}
            rows={rows.map((r) => [r.item_code, r.item_name, r.warehouse_name, label(r.condition), Number(r.quantity), r.uom, Number(r.reserved_qty), Number(r.available_qty), Number(r.reorder_level), Number(r.avg_cost), Number(r.value)])} />
          {can('can_manage_inventory') && all.length > 0 && <button className="btn" onClick={() => onStart('issue')}>Issue stock</button>}
          {can('can_manage_inventory') && <button className="btn btn-primary" onClick={() => onStart('opening')}><IconPlus size={15} /> Opening stock</button>}
        </div>
      </div>
      {q.error && <ErrorNote>{erpError(q.cause, 'Could not load stock')}</ErrorNote>}
      <section className="card ivl-card">
        {q.error ? null : !q.data ? <Loading /> : all.length === 0 ? (
          <div className="stk-empty">
            <EmptyState icon={<IconCard size={22} />} title="Nothing in stock yet"
              body="Stock arrives when goods are received against a purchase order. For stock you already hold, enter it as opening stock." />
            {can('can_manage_inventory') && <button type="button" className="btn btn-primary" onClick={() => onStart('opening')}><IconPlus size={15} /> Add opening stock</button>}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<IconSearch size={22} />} title="Nothing matches" body="Change the search or the filters." />
        ) : (
          <div className="table-wrap"><table className="ivl">
            <thead><tr><th>Item</th><th>Warehouse</th><th>Condition</th><th className="crm-num">On hand</th><th className="crm-num">Reserved</th><th className="crm-num">Available</th><th className="crm-num">Avg cost</th><th className="crm-num">Value</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} onClick={() => onLedger(r.item_id, r.warehouse_id)} title="Open the ledger for this item here">
                <td><span className="ivl-no">{r.item_code}</span><small className="ivl-kind stk-name" title={r.item_name}>{r.item_name}</small></td>
                <td>{r.warehouse_name}</td>
                <td><span className={`stk-kind is-${r.condition === 'good' ? 'in' : 'adjustment'}`}>{label(r.condition)}</span></td>
                <td className="crm-num ivl-amt">{qtyText(r.quantity)} <small className="stk-uom">{r.uom}</small></td>
                <td className={`crm-num${Number(r.reserved_qty) > 0 ? '' : ' ivl-zero'}`}>{qtyText(r.reserved_qty)}</td>
                <td className="crm-num">
                  <span className={isLow(r) ? 'ivl-due' : 'ivl-amt'}>{qtyText(r.available_qty)}</span>
                  {isLow(r) && <small className="ivl-kind">Reorder at {qtyText(r.reorder_level)}</small>}
                </td>
                <td className="crm-num">{rupees(r.avg_cost)}</td>
                <td className="crm-num ivl-amt">{rupees(r.value)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </>
  )
}

/* ---------------------------------------------------------------- ledger --- */

const LEDGER_LIMIT = 300
const MOVE_KINDS = ['opening', 'grn', 'issue', 'return', 'transfer_out', 'transfer_in', 'adjustment', 'dispatch', 'reversal']
const moveName = (kind: string) => (kind === 'grn' ? 'Goods receipt' : kind === 'opening' ? 'Opening stock' : label(kind))

function MovementsTab({ initial }: { initial: { itemId: string; warehouseId: string } }) {
  const items = useItems('goods')
  const warehouses = useWarehouses()
  const [itemId, setItemId] = useState(initial.itemId)
  const [warehouseId, setWarehouseId] = useState(initial.warehouseId)
  const [kind, setKind] = useState('')
  const [term, setTerm] = useState('')
  const dates = useDates()
  const q = useQuery(`erp-moves-${itemId}-${warehouseId}`, () => erp.movements({ item_id: itemId || undefined, warehouse_id: warehouseId || undefined }))
  const all = q.data ?? []
  const needle = term.trim().toLowerCase()
  const rows = all.filter((m) => (!kind || m.kind === kind) && has(needle, [m.item_code, m.item_name, m.ref_number, m.reason, m.created_by_name, m.warehouse_name])
    && (!dates.from || localDay(m.created_at) >= dates.from) && (!dates.to || localDay(m.created_at) <= dates.to))
  const moved = (sign: 1 | -1) => rows.filter((m) => Number(m.quantity) * sign > 0)
  const units = (xs: typeof rows) => xs.reduce((n, m) => n + Math.abs(Number(m.quantity)), 0)
  const value = (xs: typeof rows) => xs.reduce((n, m) => n + Math.abs(Number(m.value)), 0)
  const clear = () => { setItemId(''); setWarehouseId(''); setKind(''); setTerm(''); dates.clear() }
  const active = [itemId, warehouseId, kind, dates.active].filter(Boolean).length
  return (
    <>
      {q.data && (
        <div className="ivl-kpis bil-kpis-4">
          <div className="ivl-kpi is-static"><span>Movements</span><b>{rows.length}</b><small>{all.length >= LEDGER_LIMIT ? `from the latest ${LEDGER_LIMIT}` : 'lines in this view'}</small></div>
          <div className="ivl-kpi is-static is-good"><span>Stock in</span><b>{qtyText(units(moved(1)))}</b><small>{rupees(value(moved(1)))}</small></div>
          <div className="ivl-kpi is-static is-bad"><span>Stock out</span><b>{qtyText(units(moved(-1)))}</b><small>{rupees(value(moved(-1)))}</small></div>
          <div className="ivl-kpi is-static is-idle"><span>Net change</span><b>{qtyText(units(moved(1)) - units(moved(-1)))}</b><small>units in this view</small></div>
        </div>
      )}
      <div className="crm-bar ivl-bar">
        <div className="crm-search"><IconSearch size={15} />
          <input type="search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search item, document, reason or person…" /></div>
        <div className="ivl-tools">
          {(term || active > 0) && <button type="button" className="btn btn-sm ivl-clear" onClick={clear}>Clear</button>}
          {q.data && <span className="ivl-count">{rows.length} of {all.length}</span>}
          <FilterMenu count={active} shown={rows.length} total={all.length} onClear={clear}>
            <label className="is-wide"><span>Item</span>
              <select value={itemId} onChange={(e) => setItemId(e.target.value)} aria-label="Item">
                <option value="">All items</option>{(items.data ?? []).map((i) => <option key={i.id} value={i.id}>{i.code} · {i.name}</option>)}
              </select></label>
            <label><span>Warehouse</span>
              <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} aria-label="Warehouse">
                <option value="">All warehouses</option>{(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select></label>
            <label><span>Movement</span>
              <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Movement">
                <option value="">All movements</option>{MOVE_KINDS.map((k) => <option key={k} value={k}>{moveName(k)}</option>)}
              </select></label>
            {dates.fields}
          </FilterMenu>
          <ExportMenu name="stock-ledger" sheet="Stock ledger" money={[8]}
            header={['When', 'Item code', 'Item', 'Warehouse', 'Condition', 'Movement', 'Document', 'Quantity', 'Value', 'Balance', 'Reason', 'By']}
            rows={rows.map((m) => [dateTime(m.created_at), m.item_code, m.item_name, m.warehouse_name, label(m.condition), moveName(m.kind), m.ref_number, Number(m.quantity), Number(m.value), Number(m.balance_after), m.reason, m.created_by_name])} />
        </div>
      </div>
      {q.error && <ErrorNote>{erpError(q.cause, 'Could not load the ledger')}</ErrorNote>}
      <section className="card ivl-card">
        {q.error ? null : !q.data ? <Loading /> : all.length === 0 ? <EmptyState icon={<IconCard size={22} />} title="No movements" body="Every receipt, issue, transfer and dispatch writes a line here." />
          : rows.length === 0 ? <EmptyState icon={<IconSearch size={22} />} title="Nothing matches" body="Change the search or the filters." /> : (
          <div className="table-wrap"><table className="ivl is-plain">
            <thead><tr><th>When</th><th>Item</th><th>Warehouse</th><th>Movement</th><th>Document</th><th className="crm-num">Qty</th><th className="crm-num">Balance</th><th className="crm-num">Value</th><th>By</th></tr></thead>
            <tbody>{rows.map((m) => (
              <tr key={m.id}>
                <td className="ivl-date-cell">{dateTime(m.created_at)}</td>
                <td><span className="ivl-no">{m.item_code}</span><small className="ivl-kind stk-name" title={m.item_name}>{m.item_name}</small></td>
                <td>{m.warehouse_name}{m.condition !== 'good' && <small className="ivl-kind">{label(m.condition)}</small>}</td>
                <td><span className={`stk-kind is-${Number(m.quantity) < 0 ? 'out' : 'in'}`}>{moveName(m.kind)}</span></td>
                <td>{m.ref_number ?? '—'}{m.reason && <small className="ivl-kind stk-name" title={m.reason}>{m.reason}</small>}</td>
                <td className={`crm-num stk-qty is-${Number(m.quantity) < 0 ? 'out' : 'in'}`}>{Number(m.quantity) > 0 ? '+' : ''}{qtyText(m.quantity)}</td>
                <td className="crm-num ivl-amt">{qtyText(m.balance_after)}</td>
                <td className="crm-num">{rupees(Math.abs(Number(m.value)))}</td>
                <td>{m.created_by_name ?? '—'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </>
  )
}

/* --------------------------------------------------------- serial lookup --- */

function SerialsTab() {
  const [term, setTerm] = useState('')
  const [search, setSearch] = useState('')
  const q = useQuery(`erp-serial-${search}`, () => erp.serials(search), { enabled: search.length >= 2 })
  const typed = term.trim()
  const expired = (iso: string | null) => Boolean(iso && iso.slice(0, 10) < todayISO())
  return (
    <>
      <form className="crm-bar ivl-bar" onSubmit={(e) => { e.preventDefault(); setSearch(typed) }}>
        <div className="crm-search"><IconSearch size={15} />
          <input type="search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Serial number, MAC or service tag" aria-label="Serial number" /></div>
        <button className="btn btn-primary" disabled={typed.length < 2}>Find</button>
        {search.length >= 2 && q.data && <span className="ivl-count stk-push">{q.data.length} {q.data.length === 1 ? 'unit' : 'units'} found</span>}
      </form>
      {q.error && search.length >= 2 && <ErrorNote>{erpError(q.cause, 'Could not look that up')}</ErrorNote>}
      {search.length < 2 ? (
        <section className="card ivl-card">
          <EmptyState icon={<IconSearch size={22} />} title="Find any serial-tracked unit" body="See where it is now, its condition and warranty, and everything that has happened to it." />
        </section>
      ) : q.error ? null : !q.data ? <Loading /> : q.data.length === 0 ? (
        <section className="card ivl-card">
          <EmptyState icon={<IconSearch size={22} />} title="No unit with that serial" body={`Nothing matches “${search}”. Check it and try again.`} />
        </section>
      ) : q.data.map((s) => (
        <section key={s.id} className="card stk-serial">
          <header>
            <div><span className="ivl-no stk-serial-no">{s.serial_no}</span><small className="ivl-kind">{s.item_code} · {s.item_name}</small></div>
            <ErpState value={s.status} />
          </header>
          <dl>
            <div><dt>Where</dt><dd>{s.warehouse_name ?? (s.customer_id ? 'With the customer' : s.status === 'issued' ? 'Issued out' : '—')}</dd></div>
            <div><dt>Condition</dt><dd>{label(s.condition)}</dd></div>
            <div><dt>Warranty until</dt><dd className={expired(s.warranty_until) ? 'stk-late' : undefined}>{fullDate(s.warranty_until)}{expired(s.warranty_until) ? ' · expired' : ''}</dd></div>
            <div><dt>History</dt><dd>{s.history.length} {s.history.length === 1 ? 'event' : 'events'}</dd></div>
          </dl>
          {s.history.length > 0 && (
            <ol className="stk-history">
              {s.history.map((h) => (
                <li key={h.id}>
                  <b>{moveName(h.kind)}</b>{h.ref_number ? ` on ${h.ref_number}` : ''}{h.warehouse_name ? ` at ${h.warehouse_name}` : ''}
                  <small>{dateTime(h.created_at)}</small>
                </li>
              ))}
            </ol>
          )}
        </section>
      ))}
    </>
  )
}

/* ------------------------------------------------------------- documents --- */

function DocsTab({ startKind, onStarted }: { startKind: DocKind | null; onStarted: () => void }) {
  const { can } = useAccess()
  const [kind, setKind] = useState('')
  const [status, setStatus] = useState('')
  const [term, setTerm] = useState('')
  const dates = useDates()
  const q = useQuery('erp-docs', () => erp.stockDocs())
  const [open, setOpen] = useState<StockDoc | null>(null)
  // A document that saved but could not then be posted opens saying why.
  const [problem, setProblem] = useState<string | null>(null)
  const [creating, setCreating] = useState<DocKind | null>(startKind)
  const all = q.data ?? []
  const needle = term.trim().toLowerCase()
  const rows = all.filter((d) => (!kind || d.kind === kind) && (!status || d.status === status)
    && has(needle, [d.number, d.reason, d.notes, d.from_warehouse_name, d.to_warehouse_name, d.created_by_name, d.recipient_name, d.project_name])
    && (!dates.from || d.doc_date >= dates.from) && (!dates.to || d.doc_date <= dates.to))
  const count = (st: string) => all.filter((d) => d.status === st).length
  const statuses = ['draft', 'submitted', 'approved', 'rejected', 'posted', 'in_transit', 'received', 'cancelled']
  const clear = () => { setKind(''); setStatus(''); setTerm(''); dates.clear() }
  const active = [kind, status, dates.active].filter(Boolean).length
  const closeForm = () => { setCreating(null); onStarted() }
  return (
    <>
      {q.data && (
        <div className="ivl-kpis bil-kpis-4">
          <button type="button" className="ivl-kpi" onClick={() => setStatus('')}><span>Documents</span><b>{all.length}</b><small>{rupees(all.reduce((n, d) => n + Number(d.value || 0), 0))} in value</small></button>
          <button type="button" className="ivl-kpi is-idle" onClick={() => setStatus('draft')}><span>Drafts</span><b>{count('draft')}</b><small>stock has not moved yet</small></button>
          <button type="button" className="ivl-kpi is-warn" onClick={() => setStatus('submitted')}><span>Awaiting approval</span><b>{count('submitted')}</b><small>adjustments to decide</small></button>
          <button type="button" className="ivl-kpi is-good" onClick={() => setStatus('in_transit')}><span>In transit</span><b>{count('in_transit')}</b><small>transfers to receive</small></button>
        </div>
      )}
      <div className="crm-bar ivl-bar">
        <div className="crm-search"><IconSearch size={15} />
          <input type="search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search number, warehouse, person, project or reason…" /></div>
        <div className="ivl-tools">
          {(term || active > 0) && <button type="button" className="btn btn-sm ivl-clear" onClick={clear}>Clear</button>}
          {q.data && <span className="ivl-count">{rows.length} of {all.length}</span>}
          <FilterMenu count={active} shown={rows.length} total={all.length} onClear={clear}>
            <label><span>Kind</span>
              <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
                <option value="">All kinds</option>{DOC_KINDS.map((k) => <option key={k} value={k}>{KIND_TITLE[k]}</option>)}
              </select></label>
            <label><span>Status</span>
              <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
                <option value="">All statuses</option>{statuses.map((st) => <option key={st} value={st}>{label(st)}</option>)}
              </select></label>
            {dates.fields}
          </FilterMenu>
          <ExportMenu name="stock-documents" sheet="Stock documents" money={[8]}
            header={['Number', 'Kind', 'From', 'To', 'Issued to', 'Project', 'Date', 'Reason', 'Value', 'Status', 'Raised by']}
            rows={rows.map((d) => [d.number, KIND_TITLE[d.kind], d.from_warehouse_name, d.to_warehouse_name, d.recipient_name, d.project_name, d.doc_date, d.reason, Number(d.value), label(d.status), d.created_by_name])} />
          {can('can_manage_inventory') && <button className="btn btn-primary" onClick={() => setCreating('issue')}><IconPlus size={15} /> New document</button>}
        </div>
      </div>
      {q.error && <ErrorNote>{erpError(q.cause, 'Could not load the documents')}</ErrorNote>}
      <section className="card ivl-card">
        {q.error ? null : !q.data ? <Loading /> : all.length === 0 ? <EmptyState icon={<IconCard size={22} />} title="No stock documents" body="Issue to a project, return, transfer between warehouses, or adjust after a count." />
          : rows.length === 0 ? <EmptyState icon={<IconSearch size={22} />} title="Nothing matches" body="Change the search or the filters." /> : (
          <div className="table-wrap"><table className="ivl">
            <thead><tr><th>Number</th><th>Kind</th><th>From → to</th><th>Date</th><th>Reason</th><th>Raised by</th><th className="crm-num">Value</th><th>Status</th></tr></thead>
            <tbody>{rows.map((d) => (
              <tr key={d.id} onClick={() => setOpen(d)}>
                <td><span className="ivl-no">{d.number}</span></td>
                <td><span className={`stk-kind is-${d.kind}`}>{KIND_TITLE[d.kind]}</span></td>
                <td className="stk-route">{d.from_warehouse_name && (d.to_warehouse_name || d.recipient_name || d.project_name)
                  ? <>{d.from_warehouse_name} <i aria-hidden>→</i> {d.to_warehouse_name ?? d.recipient_name ?? d.project_name}{d.recipient_name && d.project_name && <small className="ivl-kind">{d.project_name}</small>}</>
                  : d.from_warehouse_name ?? d.to_warehouse_name ?? '—'}</td>
                <td className="ivl-date-cell">{fullDate(d.doc_date)}</td>
                <td><span className="stk-name" title={d.reason ?? undefined}>{d.reason ?? '—'}</span></td>
                <td>{d.created_by_name ?? '—'}</td>
                <td className="crm-num ivl-amt">{rupees(d.value)}</td>
                <td><ErpState value={d.status} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      {creating && <DocForm initialKind={creating} onClose={closeForm} onSaved={(d, why) => { closeForm(); q.reload(); setProblem(why ?? null); setOpen(d) }} />}
      {open && <DocDrawer doc={open} problem={problem} onClose={() => { setOpen(null); setProblem(null) }} onChanged={(d) => { setProblem(null); setOpen(d); q.reload() }} />}
    </>
  )
}

interface DocRow { key: string; item_id: string; quantity: string; condition: string; serials: string; unit_cost: string }
const blankRow = (key: string): DocRow => ({ key, item_id: '', quantity: '1', condition: 'good', serials: '', unit_cost: '' })
const serialList = (text: string) => text.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean)

const KIND_NOTE: Record<DocKind, string> = {
  opening: 'Enters stock you already hold that is not in the system yet, at what it cost. For new purchases, use a purchase order.',
  issue: 'Takes stock out of a warehouse for a project, an engineer or a department.',
  return: 'Brings issued or delivered goods back into a warehouse: unused, defective or RMA.',
  transfer: 'Moves stock between two warehouses. It stays in transit until the receiving warehouse takes it.',
  adjustment: 'Corrects stock after a count. Somebody other than you has to approve it. Use + to add and − to remove.',
}

const KIND_TITLE: Record<DocKind, string> = {
  opening: 'Opening stock', issue: 'Issue stock', return: 'Return to stock', transfer: 'Transfer stock', adjustment: 'Stock adjustment',
}

/** What is about to happen, asked before stock moves: a posted document stays. */
const confirmPost = (kind: DocKind, value: number, warehouse: string | null | undefined) => window.confirm(
  kind === 'opening'
    ? `Post this opening stock?\n\n${rupees(value)} goes into ${warehouse ?? 'the warehouse'} now. A posted document cannot be changed; correcting it takes an approved adjustment.`
    : kind === 'issue'
      ? `Issue this stock?\n\n${rupees(value)} of stock leaves ${warehouse ?? 'the warehouse'} now. A posted document cannot be changed; bring goods back with a Return.`
      : 'Post this document?\n\nStock moves now, and a posted document cannot be changed.',
)

/** Tick the units leaving, from what this warehouse holds in that condition. */
function SerialPick({ itemId, warehouseId, condition, needed, value, label: name, onChange }: {
  itemId: string; warehouseId: string; condition: string; needed: number; value: string; label: string; onChange: (v: string) => void
}) {
  const q = useQuery(`erp-serials-${itemId}-${warehouseId}-${condition}`, () => erp.availableSerials(itemId, warehouseId, condition), { enabled: Boolean(warehouseId) })
  const [open, setOpen] = useState(false)
  const chosen = serialList(value)
  const toggle = (sn: string) => onChange((chosen.includes(sn) ? chosen.filter((x) => x !== sn) : [...chosen, sn]).join(', '))
  const units = q.data ?? []
  return (
    <div className="stk-pick">
      <button type="button" aria-label={name} aria-expanded={open} disabled={!warehouseId} title={value || undefined}
        className={chosen.length > 0 && chosen.length !== needed ? 'is-bad' : undefined} onClick={() => setOpen((v) => !v)}>
        {!warehouseId ? 'Choose the warehouse' : chosen.length === 0 ? `Pick ${needed || ''} serial${needed === 1 ? '' : 's'}…` : `${chosen.length} of ${needed} picked`}
      </button>
      {open && (
        <>
          <div className="ivl-filter-scrim" onClick={() => setOpen(false)} />
          <div className="stk-pick-pop">
            {q.data && units.length === 0 && <p>No units of this item here in that condition.</p>}
            {units.map((sn) => (
              <label key={sn}><input type="checkbox" checked={chosen.includes(sn)} onChange={() => toggle(sn)} /> {sn}</label>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function DocForm({ initialKind, onClose, onSaved }: { initialKind: DocKind; onClose: () => void; onSaved: (d: StockDoc, problem?: string) => void }) {
  const items = useItems('goods')
  const warehouses = useQuery('erp-wh-active', () => erp.warehouses(true))
  const [head, setHead] = useState<{ kind: DocKind; from_warehouse_id: string; to_warehouse_id: string; doc_date: string; recipient_id: string; project_id: string; reason: string; notes: string }>({ kind: initialKind, from_warehouse_id: '', to_warehouse_id: '', doc_date: todayISO(), recipient_id: '', project_id: '', reason: '', notes: '' })
  const [rows, setRows] = useState<DocRow[]>([blankRow('a')])
  const { busy, error, run } = useRun()
  const opening = head.kind === 'opening'
  const adjusting = head.kind === 'adjustment'
  const needsFrom = head.kind !== 'return' && !opening
  const needsTo = head.kind === 'return' || head.kind === 'transfer' || opening
  const issuing = head.kind === 'issue'
  // Stock leaving a warehouse: what is free there limits it, and units are picked.
  const leaving = issuing || head.kind === 'transfer'
  const parties = useQuery('erp-doc-parties', () => erp.stockDocParties(), { enabled: issuing })
  const settings = useQuery('erp-settings', () => erp.settings())
  const warehouseId = needsFrom ? head.from_warehouse_id : head.to_warehouse_id
  const warehouseName = (warehouses.data ?? []).find((w) => w.id === warehouseId)?.name
  const held = useQuery(`erp-doc-stock-${warehouseId}`, () => erp.stock({ warehouse_id: warehouseId }), { enabled: Boolean(warehouseId) })
  const itemOf = (r: DocRow) => (items.data ?? []).find((i) => i.id === r.item_id)
  const heldOf = (r: DocRow) => (held.data ?? []).filter((b) => b.item_id === r.item_id && b.condition === r.condition)
    .reduce((n, b) => n + Number(leaving ? b.available_qty : b.quantity), 0)
  // Two lines of one item draw on the same stock.
  const wanted = (r: DocRow) => rows.filter((x) => x.item_id === r.item_id && x.condition === r.condition).reduce((n, x) => n + (Number(x.quantity) || 0), 0)
  const tooMuch = (r: DocRow) => leaving && Boolean(r.item_id && warehouseId && held.data) && !settings.data?.allow_negative_stock && wanted(r) > heldOf(r)
  // A fresh row appears once the last one is used, as on the sales order.
  const withSpare = (xs: DocRow[]) => (xs.length === 0 || xs[xs.length - 1].item_id ? [...xs, blankRow(Math.random().toString(36))] : xs)
  const set = (key: string, patch: Partial<DocRow>) => setRows(withSpare(rows.map((r) => (r.key === key ? { ...r, ...patch } : r))))
  const used = rows.filter((r) => r.item_id)
  const short = used.find(tooMuch)
  const serialBad = (r: DocRow) => Boolean(itemOf(r)?.is_serialized) && serialList(r.serials).length !== Math.abs(Number(r.quantity))
  const serialShort = used.find(serialBad)
  const anySerial = used.some((r) => itemOf(r)?.is_serialized)
  const units = used.reduce((n, r) => n + Math.abs(Number(r.quantity) || 0), 0)
  const value = used.reduce((n, r) => n + Number(r.quantity || 0) * Number(r.unit_cost || 0), 0)
  const blocker = needsFrom && !head.from_warehouse_id ? `Choose the ${adjusting ? 'warehouse' : '“from” warehouse'}`
    : needsTo && !head.to_warehouse_id ? `Choose the ${opening ? 'warehouse' : '“to” warehouse'}`
      : head.kind === 'transfer' && head.from_warehouse_id === head.to_warehouse_id ? 'A transfer needs two different warehouses'
        : issuing && !head.recipient_id && !head.project_id ? 'Choose who or which project it is issued to'
        : adjusting && !head.reason.trim() ? 'Enter the reason for the adjustment'
          : !head.doc_date ? 'Choose the date'
            : used.length === 0 ? 'Add at least one item'
              : used.some((r) => !Number(r.quantity) || (!adjusting && Number(r.quantity) < 0)) ? 'Enter a quantity on every line'
                : short ? `${itemOf(short)?.code}: only ${qtyText(heldOf(short))} available at ${warehouseName ?? 'this warehouse'}`
                : opening && used.some((r) => r.unit_cost.trim() === '' || !(Number(r.unit_cost) >= 0)) ? 'Enter the unit cost on every line'
                  : serialShort ? `${itemOf(serialShort)?.code}: enter ${Math.abs(Number(serialShort.quantity))} serial ${Math.abs(Number(serialShort.quantity)) === 1 ? 'number' : 'numbers'}`
                    : null
  const options: PickOption[] = (items.data ?? []).map((i) => ({
    value: i.id, label: `${i.code} · ${i.name}`,
    hint: [`₹${Number(i.standard_cost || 0).toLocaleString('en-IN')} / ${i.uom}`, i.is_stocked && `${qtyText(i.available_qty)} available`].filter(Boolean).join(' · '),
    tag: i.is_serialized ? 'Serial' : undefined,
  }))
  const whSelect = (field: 'from_warehouse_id' | 'to_warehouse_id', name: string) => (
    <select value={head[field]} aria-label={name} onChange={(e) => {
      setHead({ ...head, [field]: e.target.value })
      // Units picked from the old warehouse are not in the new one.
      if (leaving) setRows(rows.map((r) => ({ ...r, serials: '' })))
    }}>
      <option value="">Choose</option>{(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
    </select>
  )
  const body = () => ({
    ...head, from_warehouse_id: needsFrom ? head.from_warehouse_id : null, to_warehouse_id: needsTo ? head.to_warehouse_id : null,
    recipient_id: issuing && head.recipient_id ? head.recipient_id : null, project_id: issuing && head.project_id ? head.project_id : null,
    lines: used.map((r) => ({ item_id: r.item_id, quantity: r.quantity, condition: r.condition,
      serials: serialList(r.serials), ...(opening ? { unit_cost: r.unit_cost } : {}) })),
  })
  const action = adjusting ? 'submit' : 'post'
  function saveAndGo() {
    if (!adjusting && !confirmPost(head.kind, value, warehouseName)) return
    void run(async () => {
      const saved = await erp.saveStockDoc(body())
      try {
        onSaved(await erp.stockDocAction(saved.id, action))
      } catch (err) {
        onSaved(saved, erpError(err, 'It is saved as a draft, but could not be posted'))
      }
    })
  }
  const cols = 7 + (opening ? 2 : 0) + (anySerial ? 1 : 0)
  return (
    <Dialog wide title={KIND_TITLE[head.kind]} subtitle={KIND_NOTE[head.kind]} onClose={onClose} footer={
      <>
        {error ? <span className="error stk-foot-note">{error}</span>
          : blocker ? <span className="stk-foot-note">{blocker}</span>
            : <span className="stk-foot-sum">{used.length} {used.length === 1 ? 'line' : 'lines'} · {qtyText(units)} {units === 1 ? 'unit' : 'units'}{opening && <> · <b>{rupees(value)}</b></>}</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={busy || Boolean(blocker)} onClick={() => void run(async () => onSaved(await erp.saveStockDoc(body())))}>Save draft</button>
        <button className="btn btn-primary" disabled={busy || Boolean(blocker)} onClick={saveAndGo}>
          {adjusting ? 'Save & submit' : head.kind === 'transfer' ? 'Save & dispatch' : 'Save & post'}
        </button>
      </>
    }>
      <div className="stk-doc">
        <div className="stk-head">
          <label className="stk-f"><span>Type</span>
            <select value={head.kind} aria-label="Type" onChange={(e) => setHead({ ...head, kind: e.target.value as DocKind })}>
              {DOC_KINDS.map((k) => <option key={k} value={k}>{KIND_TITLE[k]}</option>)}
            </select></label>
          {needsFrom && <label className="stk-f"><span>{adjusting ? 'Warehouse' : 'From'} <b className="pof-req">*</b></span>{whSelect('from_warehouse_id', adjusting ? 'Warehouse' : 'From')}</label>}
          {needsTo && <label className="stk-f"><span>{opening ? 'Warehouse' : 'To'} <b className="pof-req">*</b></span>{whSelect('to_warehouse_id', opening ? 'Warehouse' : 'To')}</label>}
          {issuing && (
            <>
              <div className="stk-f"><span>Issued to</span>
                <SearchSelect label="Issued to" value={head.recipient_id} onChange={(v) => setHead({ ...head, recipient_id: v })} clearable placeholder="Search person…" empty="Nobody matches"
                  options={(parties.data?.people ?? []).map((x) => ({ value: x.id, label: x.name }))} /></div>
              <div className="stk-f"><span>Project</span>
                <SearchSelect label="Project" value={head.project_id} onChange={(v) => setHead({ ...head, project_id: v })} clearable placeholder="Search project…" empty="No active project"
                  options={(parties.data?.projects ?? []).map((x) => ({ value: x.id, label: x.code ? `${x.code} · ${x.name}` : x.name, hint: x.client ?? undefined }))} /></div>
            </>
          )}
          <label className="stk-f"><span>Date <b className="pof-req">*</b></span>
            <input type="date" aria-label="Date" value={head.doc_date} max={todayISO()} onChange={(e) => setHead({ ...head, doc_date: e.target.value })} /></label>
          {!opening && (
            <label className="stk-f"><span>Reason{adjusting && <> <b className="pof-req">*</b></>}</span>
              <input aria-label="Reason" placeholder={adjusting ? 'e.g. Cycle count shortfall' : 'Optional'} value={head.reason} onChange={(e) => setHead({ ...head, reason: e.target.value })} /></label>
          )}
          <label className="stk-f"><span>Notes</span>
            <input aria-label="Notes" placeholder="Optional" value={head.notes} onChange={(e) => setHead({ ...head, notes: e.target.value })} /></label>
        </div>
        <div className="sb-grid stk-sheet">
          <table>
            <thead><tr>
              <th className="sb-c-sr">Sr</th><th className="sb-c-item">Item</th><th className="stk-c-held" title={leaving ? 'Free to move: on hand, less what is reserved' : 'What this warehouse already holds in that condition'}>{leaving ? 'Available' : 'In stock'}</th>
              <th className="sb-c-qty">{adjusting ? 'Qty (+/−)' : 'Qty'}</th><th className="stk-c-unit">Unit</th>
              {opening && <th className="sb-c-rate">Unit cost (₹)</th>}
              <th className="stk-c-cond">Condition</th>
              {anySerial && <th className="stk-c-serial">Serial numbers</th>}
              {opening && <th className="sb-c-amt">Value (₹)</th>}
              <th className="sb-c-x" aria-label="Remove" />
            </tr></thead>
            <tbody>
              {rows.map((r, n) => {
                const item = itemOf(r)
                return (
                  <tr key={r.key}>
                    <td className="sb-c-sr">{n + 1}</td>
                    <td className="sb-c-item">
                      <SearchSelect label={`Item, line ${n + 1}`} value={r.item_id} options={options} placeholder="Search item name or code…" empty="No item matches" clearable
                        onChange={(id) => {
                          const picked = (items.data ?? []).find((i) => i.id === id)
                          // The cost starts at the item's standard cost, and can be typed over.
                          set(r.key, { item_id: id, serials: '', unit_cost: picked ? String(Number(picked.standard_cost)) : '' })
                        }} />
                    </td>
                    <td className="stk-c-held">{item && warehouseId && held.data ? qtyText(heldOf(r)) : ''}</td>
                    <td className="sb-c-qty"><input inputMode="decimal" aria-label={`Quantity, line ${n + 1}`} disabled={!item} value={item ? r.quantity : ''} placeholder={item ? '0' : ''} className={tooMuch(r) ? 'is-bad' : undefined}
                      onChange={(e) => set(r.key, { quantity: e.target.value })} /></td>
                    <td className="stk-c-unit">{item?.uom ?? ''}</td>
                    {opening && <td className="sb-c-rate"><input inputMode="decimal" aria-label={`Unit cost, line ${n + 1}`} disabled={!item} value={r.unit_cost} placeholder={item ? '0.00' : ''}
                      onChange={(e) => set(r.key, { unit_cost: e.target.value })} /></td>}
                    <td className="stk-c-cond">
                      {item && <select value={r.condition} aria-label={`Condition, line ${n + 1}`} onChange={(e) => set(r.key, { condition: e.target.value, ...(leaving ? { serials: '' } : {}) })}>{CONDITIONS.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select>}
                    </td>
                    {anySerial && (
                      <td className="stk-c-serial">
                        {item?.is_serialized && leaving && (
                          <SerialPick itemId={item.id} warehouseId={warehouseId} condition={r.condition} needed={Math.abs(Number(r.quantity)) || 0} value={r.serials}
                            label={`Serial numbers, line ${n + 1}`} onChange={(v) => set(r.key, { serials: v })} />
                        )}
                        {item?.is_serialized && !leaving && <input aria-label={`Serial numbers, line ${n + 1}`} placeholder={`${Math.abs(Number(r.quantity)) || 0} needed: SN1, SN2…`} title={r.serials}
                          className={r.serials && serialBad(r) ? 'is-bad' : undefined} value={r.serials} onChange={(e) => set(r.key, { serials: e.target.value })} />}
                      </td>
                    )}
                    {opening && <td className="sb-c-amt">{item ? rupees(Number(r.quantity || 0) * Number(r.unit_cost || 0)) : ''}</td>}
                    <td className="sb-c-x">
                      {item && <button type="button" className="sb-del" title="Remove line" aria-label={`Remove line ${n + 1}`}
                        onClick={() => setRows(withSpare(rows.filter((x) => x.key !== r.key)))}><IconTrash size={13} /></button>}
                    </td>
                  </tr>
                )
              })}
              {used.length === 0 && <tr className="sb-pad"><td className="sb-c-sr" /><td colSpan={cols - 1} /></tr>}
              {used.length === 0 && <tr className="sb-pad"><td className="sb-c-sr" /><td colSpan={cols - 1} /></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </Dialog>
  )
}

function DocDrawer({ doc, problem, onClose, onChanged }: { doc: StockDoc; problem?: string | null; onClose: () => void; onChanged: (d: StockDoc) => void }) {
  const { can } = useAccess()
  const { user } = useAuth()
  const { busy, error, run } = useRun()
  const [cancelling, setCancelling] = useState(false)
  const act = (fn: () => Promise<StockDoc>) => void run(async () => onChanged(await fn()))
  const keeper = can('can_manage_inventory')
  return (
    <Dialog wide title={`${doc.number} · ${KIND_TITLE[doc.kind]}`} subtitle={<ErpState value={doc.status} />} onClose={onClose} footer={
      <div className="crm-row-actions">
        {(error ?? problem) && <span className="error">{error ?? problem}</span>}
        {doc.status === 'draft' && keeper && doc.kind !== 'adjustment' && (
          <button className="btn btn-primary" disabled={busy} onClick={() => {
            if (doc.kind === 'transfer' || confirmPost(doc.kind, Number(doc.value), doc.to_warehouse_name ?? doc.from_warehouse_name)) act(() => erp.stockDocAction(doc.id, 'post'))
          }}>{doc.kind === 'transfer' ? 'Dispatch transfer' : 'Post'}</button>
        )}
        {doc.status === 'draft' && keeper && doc.kind === 'adjustment' && (
          <button className="btn btn-primary" disabled={busy} onClick={() => act(() => erp.stockDocAction(doc.id, 'submit'))}>Submit for approval</button>
        )}
        {doc.status === 'in_transit' && keeper && <button className="btn btn-primary" disabled={busy} onClick={() => act(() => erp.stockDocAction(doc.id, 'receive'))}>Receive at {doc.to_warehouse_name}</button>}
        {doc.status === 'submitted' && doc.created_by !== user?.id && <DecideBar onDecide={async (a, n) => onChanged(await erp.decideStockDoc(doc.id, a, n))} />}
        {['draft', 'submitted'].includes(doc.status) && keeper && <button className="btn" onClick={() => setCancelling(true)}>Cancel document</button>}
      </div>
    }>
      <div className="stk-doc">
      {doc.status === 'draft' && doc.kind !== 'adjustment' && <Note>Saved as a draft. Stock does not move until you {doc.kind === 'transfer' ? 'dispatch the transfer' : 'post it'}.</Note>}
      {doc.status === 'submitted' && doc.created_by === user?.id && <Note>Waiting for somebody else to approve this adjustment.</Note>}
      {doc.review_note && <Note>{doc.review_note}</Note>}
      <Facts items={[
        ...(doc.from_warehouse_name ? [['From', doc.from_warehouse_name] as [string, ReactNode]] : []),
        ...(doc.to_warehouse_name ? [[doc.kind === 'opening' ? 'Warehouse' : 'To', doc.to_warehouse_name] as [string, ReactNode]] : []),
        ['Date', fullDate(doc.doc_date)],
        ...(doc.recipient_name ? [['Issued to', doc.recipient_name] as [string, ReactNode]] : []),
        ...(doc.project_name ? [['Project', doc.project_name] as [string, ReactNode]] : []),
        ...(doc.reason ? [['Reason', doc.reason] as [string, ReactNode]] : []),
        ...(doc.notes ? [['Notes', doc.notes] as [string, ReactNode]] : []),
        ['Value', rupees(doc.value)], ['Raised by', doc.created_by_name],
        ...(doc.kind === 'adjustment' ? [['Approved by', doc.reviewed_by_name] as [string, ReactNode]] : []),
      ]} />
      <ChainView steps={doc.chain} />
      <section className="card ivl-card stk-lines"><div className="table-wrap"><table className="ivl is-plain">
        <thead><tr><th>Item</th><th className="crm-num">Qty</th><th>Condition</th><th className="crm-num">Unit cost</th><th className="crm-num">Value</th><th>Serials</th></tr></thead>
        <tbody>
          {doc.lines.map((l) => (
            <tr key={l.id}>
              <td><span className="ivl-no">{l.item_code}</span><small className="ivl-kind stk-name" title={l.item_name ?? undefined}>{l.item_name}</small></td>
              <td className="crm-num ivl-amt">{qtyText(l.quantity)} <small className="stk-uom">{l.uom}</small></td>
              <td>{label(l.condition)}</td><td className="crm-num">{rupees(l.unit_cost)}</td>
              <td className="crm-num ivl-amt">{rupees(Math.abs(Number(l.quantity)) * Number(l.unit_cost))}</td>
              <td className="crm-sub">{l.serials?.join(', ') ?? '—'}</td>
            </tr>
          ))}
          <tr className="bil-total"><td colSpan={4}>Total</td><td className="crm-num">{rupees(doc.value)}</td><td /></tr>
        </tbody>
      </table></div></section>
      {cancelling && <ReasonDialog title={`Cancel ${doc.number}`} danger onClose={() => setCancelling(false)} onSubmit={async (r) => onChanged(await erp.cancelStockDoc(doc.id, r))} />}
      </div>
    </Dialog>
  )
}
