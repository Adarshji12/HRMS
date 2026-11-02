/* ERP dashboard — the business at a glance, then the worklist (PRD §8).
 *
 * Built from the HR dashboard's pieces (hero, toned KPI tiles, panels) so the
 * three dashboards read as one family. Top to bottom: this month's money
 * against last month, six months of sales and purchases, what customers owe
 * by age, who and what the revenue comes from, the latest documents, and what
 * is waiting on someone. Every figure links to the list it counts. */

import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import '../../styles/crm.css'
import '../../styles/hrdash.css'
import '../../styles/erpdash.css'
import { useQuery } from '../../lib/useQuery'
import { useTooltip } from '../../components/Tooltip'
import { Donut, type Slice } from '../../components/charts'
import { ErrorNote, Loading } from '../../components/ui'
import {
  IconAlert, IconBuilding, IconCard, IconChart, IconCheck, IconChevronRight, IconClock, IconFolder,
  IconGauge, IconPlus, IconSheet, IconStar, IconUpload,
} from '../../components/Icons'
import { erp, erpError, qtyText, rupeesShort, type Dashboard, type DashboardAnalytics } from './api'
import { DateText, ErpState } from './parts'

export default function ErpDashboard() {
  const q = useQuery<Dashboard>('erp-dashboard', () => erp.dashboard())
  const dateLine = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const waiting = q.data ? approvalsWaiting(q.data) : 0
  return (
    <div className="crm hrd ed">
      <header className="hrd-hero">
        <div className="hrd-hero-text">
          <span className="hrd-eyebrow">ERP · {dateLine}</span>
          <h1 className="hrd-title">ERP Dashboard</h1>
        </div>
        <div className="hrd-hero-actions">
          <Link className="btn" to="/erp/approvals">
            Approvals
            {waiting > 0 && <span className="hrd-pill-count">{waiting}</span>}
          </Link>
          <Link className="btn" to="/erp/purchase-orders"><IconCard size={15} /> Purchase order</Link>
          <Link className="btn btn-primary" to="/erp/sales-orders"><IconPlus size={15} /> Sales order</Link>
        </div>
      </header>
      {q.error && !q.data ? (
        <ErrorNote>{erpError(q.cause, 'Could not load the dashboard')}</ErrorNote>
      ) : !q.data ? (
        <Loading label="Building the ERP overview…" />
      ) : (
        <Body data={q.data} />
      )}
    </div>
  )
}

/* ------------------------------------------------------------ helpers --- */

function approvalsWaiting({ procurement: p, inventory: i, sales: s, billing: b }: Dashboard): number {
  return [p.requisitions_pending, p.pos_pending, i.adjustments_pending, s.orders_pending, b.credit_notes_pending]
    .reduce<number>((n, v) => n + Number(v || 0), 0)
}

/** ₹ in lakh / crore for tiles and axes, where the full figure won't fit. */
function inr(value: string | number): string {
  const n = Number(value) || 0
  const abs = Math.abs(n)
  if (abs >= 1e7) return `₹${(n / 1e7).toFixed(abs >= 1e8 ? 0 : 1)}Cr`
  if (abs >= 1e5) return `₹${(n / 1e5).toFixed(abs >= 1e6 ? 0 : 1)}L`
  if (abs >= 1e3) return `₹${(n / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}K`
  return `₹${Math.round(n)}`
}

/** "▲ 6.7% vs ₹6.0L", toned by whether the move is good news. */
function Versus({ now, before, upIsGood = true }: { now: string; before: string; upIsGood?: boolean }) {
  const a = Number(now) || 0
  const b = Number(before) || 0
  if (b === 0) return <>{inr(before)} last month</>
  const pct = ((a - b) / b) * 100
  const good = (pct >= 0) === upIsGood
  return (
    <>
      <b className={`ed-delta ${good ? 'is-good' : 'is-bad'}`}>
        {pct >= 0 ? '▲' : '▼'} {Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)}%
      </b>{' '}
      vs {inr(before)} last month
    </>
  )
}

function Panel({ title, note, link, tools, children, flush }: {
  title: string
  note?: string
  link?: { to: string; label: string }
  tools?: ReactNode
  children: ReactNode
  /** Body without padding, for tables that run edge to edge. */
  flush?: boolean
}) {
  return (
    <section className="hrd-panel">
      <header className="hrd-panel-head">
        <div>
          <h2 className="hrd-panel-title">{title}</h2>
          {note && <span className="hrd-panel-note">{note}</span>}
        </div>
        {tools}
        {link && (
          <Link className="hrd-panel-link" to={link.to}>{link.label} <IconChevronRight size={13} /></Link>
        )}
      </header>
      <div className={`hrd-panel-body${flush ? ' ed-flush' : ''}`}>{children}</div>
    </section>
  )
}

/* --------------------------------------------------------------- body --- */

function Body({ data }: { data: Dashboard }) {
  const { inventory: i, sales: s, billing: b, analytics: a } = data
  const k = a.kpis
  const overdue = Number(b.overdue) > 0
  const low = Number(i.low_stock) > 0

  const kpis: Array<{ label: string; value: string; hint: ReactNode; tone: string; to: string; icon: ReactNode }> = [
    { label: 'Sales this month', value: inr(k.sales_month), hint: <Versus now={k.sales_month} before={k.sales_last_month} />, tone: 'brand', to: '/erp/billing', icon: <IconChart size={16} /> },
    { label: 'Collections', value: inr(k.collections_month), hint: <Versus now={k.collections_month} before={k.collections_last_month} />, tone: 'good', to: '/erp/billing', icon: <IconCheck size={16} /> },
    { label: 'Purchases this month', value: inr(k.purchases_month), hint: <Versus now={k.purchases_month} before={k.purchases_last_month} upIsGood={false} />, tone: 'idle', to: '/erp/purchase-orders', icon: <IconCard size={16} /> },
    { label: 'Receivables', value: inr(b.outstanding), hint: overdue ? <span className="hrd-late">{inr(b.overdue)} overdue</span> : 'Nothing overdue', tone: overdue ? 'bad' : 'good', to: '/erp/billing', icon: <IconGauge size={16} /> },
    { label: 'Sales this FY', value: inr(k.sales_fy), hint: 'Invoiced since 1 April', tone: 'brand', to: '/erp/billing', icon: <IconStar size={16} /> },
    { label: 'Order backlog', value: inr(s.backlog_value), hint: `${s.orders_open} open sales orders`, tone: 'warn', to: '/erp/sales-orders', icon: <IconSheet size={16} /> },
    { label: 'Stock value', value: inr(i.stock_value), hint: low ? <span className="hrd-late">{i.low_stock} items low on stock</span> : 'All items above reorder level', tone: low ? 'bad' : 'good', to: '/erp/inventory', icon: <IconFolder size={16} /> },
    { label: 'Days sales outstanding', value: k.dso_days == null ? '—' : `${k.dso_days}`, hint: k.dso_days == null ? 'No billing in 90 days' : 'Days to collect, last 90 days', tone: 'idle', to: '/erp/billing', icon: <IconClock size={16} /> },
  ]

  return (
    <>
      <div className="hrd-kpis ed-kpis" role="group" aria-label="ERP summary">
        {kpis.map((t) => (
          <Link key={t.label} to={t.to} className={`hrd-kpi tone-${t.tone}`}>
            <span className="hrd-kpi-top">
              <span className="hrd-kpi-label">{t.label}</span>
              <span className="hrd-kpi-icon" aria-hidden>{t.icon}</span>
            </span>
            <span className="hrd-kpi-value">{t.value}</span>
            <span className="hrd-kpi-hint">{t.hint}</span>
          </Link>
        ))}
      </div>

      <div className="hrd-row hrd-row-wide">
        <TrendPanel trend={a.trend} />
        <AgeingPanel ageing={a.ageing} />
      </div>

      <div className="hrd-row hrd-row-3">
        <Panel title="Top customers" note="Billed, last 12 months" link={{ to: '/erp/billing', label: 'Billing' }}>
          <Ranked empty="No invoices in the last year."
            rows={a.top_customers.map((c) => ({ name: c.name, value: Number(c.total), meta: `${c.invoices} invoice${c.invoices === 1 ? '' : 's'}` }))} />
        </Panel>
        <Panel title="Top selling items" note="Billed, last 12 months" link={{ to: '/masters/erp/items', label: 'Items' }}>
          <Ranked empty="No items billed in the last year."
            rows={a.top_items.map((t) => ({ name: t.name, value: Number(t.total), meta: `${qtyText(t.quantity)} sold` }))} />
        </Panel>
        <OrdersPanel status={a.order_status} />
      </div>

      <div className="hrd-row hrd-row-wide">
        <RecentPanel rows={a.recent} />
        <Worklist data={data} />
      </div>

      {i.low_stock_items.length > 0 && (
        <Panel title="Low stock" note="Items at or below their reorder level" link={{ to: '/erp/inventory', label: 'Inventory' }} flush>
          <div className="table-wrap">
            <table className="hrd-table">
              <thead><tr><th>Code</th><th>Item</th><th className="num">Available</th><th className="num">Reorder level</th></tr></thead>
              <tbody>
                {i.low_stock_items.map((row) => (
                  <tr key={row.id}>
                    <td><span className="crm-code">{row.code}</span></td>
                    <td>{row.name}</td>
                    <td className="num hrd-late">{qtyText(row.available)}</td>
                    <td className="num">{qtyText(row.reorder_level)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <Setup />
    </>
  )
}

/* ------------------------------------------------------------- charts --- */

const SERIES = [
  { key: 'sales', label: 'Sales', color: 'var(--ed-sales)' },
  { key: 'purchases', label: 'Purchases', color: 'var(--ed-purchases)' },
] as const

function TrendPanel({ trend }: { trend: DashboardAnalytics['trend'] }) {
  const [asTable, setAsTable] = useState(false)
  const totals = SERIES.map((series) => trend.reduce((n, m) => n + Number(m[series.key]), 0))
  return (
    <Panel title="Sales vs purchases" note="Last 6 months, by month"
      tools={
        <div className="ts-toggle ts-toggle-xs" role="group" aria-label="Chart or table">
          {([false, true] as const).map((table) => (
            <button key={String(table)} className={`ts-toggle-btn ${asTable === table ? 'ts-toggle-on' : ''}`}
              onClick={() => setAsTable(table)} aria-pressed={asTable === table}>
              {table ? 'Table' : 'Chart'}
            </button>
          ))}
        </div>
      }
      flush={asTable}>
      {asTable ? (
        <div className="table-wrap">
          <table className="hrd-table">
            <thead><tr><th>Month</th><th className="num">Sales</th><th className="num">Purchases</th><th className="num">Collections</th></tr></thead>
            <tbody>
              {trend.map((m) => (
                <tr key={m.month}>
                  <td>{m.label} {m.month.slice(0, 4)}</td>
                  <td className="num">{rupeesShort(m.sales)}</td>
                  <td className="num">{rupeesShort(m.purchases)}</td>
                  <td className="num">{rupeesShort(m.collections)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="ed-legend-top">
            {SERIES.map((series, index) => (
              <span key={series.key}>
                <i style={{ background: series.color }} aria-hidden /> {series.label} <b>{inr(totals[index])}</b>
              </span>
            ))}
          </div>
          <GroupedColumns trend={trend} />
        </>
      )}
    </Panel>
  )
}

/** Bar with only its data-end rounded. */
function barPath(x: number, y: number, w: number, h: number, r = 4): string {
  const radius = Math.max(0, Math.min(r, w / 2, h))
  return `M${x},${y + h}L${x},${y + radius}Q${x},${y} ${x + radius},${y}L${x + w - radius},${y}` +
    `Q${x + w},${y} ${x + w},${y + radius}L${x + w},${y + h}Z`
}

function GroupedColumns({ trend }: { trend: DashboardAnalytics['trend'] }) {
  const tooltip = useTooltip()
  const W = 720
  const H = 230
  const padL = 52
  const padR = 8
  const padT = 10
  const padB = 26
  const plotW = W - padL - padR
  const plotH = H - padT - padB
  const peak = Math.max(0, ...trend.flatMap((m) => [Number(m.sales), Number(m.purchases)]))
  const max = peak > 0 ? peak * 1.1 : 1
  const slot = plotW / trend.length
  const barW = Math.min(30, (slot - 24) / 2)
  const ticks = [0, max / 4, max / 2, (max * 3) / 4, max]

  return (
    <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Sales and purchases by month, last six months">
      {ticks.map((value) => {
        const y = padT + plotH - (value / max) * plotH
        return (
          <g key={value}>
            <line className="gridline" x1={padL} x2={W - padR} y1={y} y2={y} />
            <text className="axis-label" x={padL - 8} y={y + 3} textAnchor="end">{peak > 0 ? inr(value) : value === 0 ? '0' : ''}</text>
          </g>
        )
      })}
      {trend.map((m, index) => {
        const x0 = padL + index * slot + (slot - barW * 2 - 2) / 2
        return (
          <g key={m.month}
            onMouseMove={(event) => tooltip.show(event, {
              title: `${m.label} ${m.month.slice(0, 4)}`,
              rows: [['Sales', rupeesShort(m.sales)], ['Purchases', rupeesShort(m.purchases)], ['Collections', rupeesShort(m.collections)]],
            })}
            onMouseLeave={tooltip.hide}>
            <rect x={padL + index * slot} y={padT} width={slot} height={plotH} fill="transparent" />
            {SERIES.map((series, si) => {
              const value = Number(m[series.key])
              if (value <= 0) return null
              const h = Math.max(2, (value / max) * plotH)
              return <path key={series.key} d={barPath(x0 + si * (barW + 2), padT + plotH - h, barW, h)} fill={series.color} />
            })}
            <text className="axis-label" x={padL + index * slot + slot / 2} y={H - 6} textAnchor="middle">{m.label}</text>
          </g>
        )
      })}
      <line className="baseline" x1={padL} x2={W - padR} y1={padT + plotH} y2={padT + plotH} />
    </svg>
  )
}

const AGE_LABEL: Record<string, string> = {
  current: 'Not yet due', '1-30': '1–30 days', '31-60': '31–60 days', '61-90': '61–90 days', '90+': 'Over 90 days',
}

function AgeingPanel({ ageing }: { ageing: DashboardAnalytics['ageing'] }) {
  const total = ageing.reduce((n, row) => n + Number(row.amount), 0)
  const max = Math.max(1, ...ageing.map((row) => Number(row.amount)))
  return (
    <Panel title="Receivables ageing" note={`${rupeesShort(total)} outstanding`} link={{ to: '/erp/billing', label: 'Billing' }}>
      {total === 0 ? (
        <p className="hrd-empty">Nothing is owed right now.</p>
      ) : (
        <ul className="hrd-legend ed-age">
          {ageing.map((row, index) => (
            <li key={row.bucket}>
              <span className="hrd-swatch" style={{ background: `var(--ed-age-${index})` }} aria-hidden />
              <span className="hrd-legend-name">{AGE_LABEL[row.bucket] ?? row.bucket}</span>
              <span className="hrd-legend-value">{rupeesShort(row.amount)}</span>
              <span className="hrd-legend-pct">{Math.round((Number(row.amount) / total) * 100)}%</span>
              <span className="ed-age-track" aria-hidden>
                <span style={{ width: `${(Number(row.amount) / max) * 100}%`, background: `var(--ed-age-${index})` }} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function Ranked({ rows, empty }: { rows: { name: string; value: number; meta: string }[]; empty: string }) {
  const max = Math.max(1, ...rows.map((row) => row.value))
  if (rows.length === 0) return <p className="hrd-empty">{empty}</p>
  return (
    <ul className="hrd-progress">
      {rows.map((row, index) => (
        <li key={row.name}>
          <span className="ed-rank" aria-hidden>{index + 1}</span>
          <span className="hrd-person">
            <span className="hrd-person-name" title={row.name}>{row.name}</span>
            <span className="hrd-person-meta">{row.meta}</span>
          </span>
          <span className="hrd-meter ed-meter">
            <span className="hrd-meter-track"><span style={{ width: `${(row.value / max) * 100}%` }} /></span>
            <span className="hrd-meter-text">{inr(row.value)}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

/** Sales-order statuses folded into the five a manager reads. */
const ORDER_GROUPS: { key: string; label: string; color: string; statuses: string[] }[] = [
  { key: 'open', label: 'In fulfilment', color: 'var(--series-2)', statuses: ['approved', 'partially_dispatched'] },
  { key: 'waiting', label: 'Awaiting approval', color: 'var(--series-3)', statuses: ['submitted'] },
  { key: 'hold', label: 'On hold', color: 'var(--series-4)', statuses: ['on_hold'] },
  { key: 'done', label: 'Completed', color: 'var(--series-1)', statuses: ['dispatched', 'closed'] },
  { key: 'draft', label: 'Draft', color: 'var(--neutral-mark)', statuses: ['draft'] },
]

function OrdersPanel({ status }: { status: Record<string, number> }) {
  const slices: Slice[] = ORDER_GROUPS.map((g) => ({
    key: g.key, label: g.label, color: g.color,
    value: g.statuses.reduce((n, st) => n + (status[st] ?? 0), 0),
  }))
  const total = slices.reduce((n, slice) => n + slice.value, 0)
  return (
    <Panel title="Sales orders" note={total ? `${total} orders by status` : undefined} link={{ to: '/erp/sales-orders', label: 'All orders' }}>
      {total === 0 ? <p className="hrd-empty">No sales orders yet.</p> : (
        <div className="hrd-att ed-orders">
          <Donut slices={slices} total={total} caption="orders" unit="orders" size={124} />
          <ul className="hrd-legend">
            {slices.map((slice) => (
              <li key={slice.key}>
                <span className="hrd-swatch" style={{ background: slice.color }} aria-hidden />
                <span className="hrd-legend-name">{slice.label}</span>
                <span className="hrd-legend-value">{slice.value}</span>
                <span className="hrd-legend-pct">{Math.round((slice.value / total) * 100)}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  )
}

/* ---------------------------------------------------------- worklists --- */

const KIND: Record<string, { label: string; to: string }> = {
  invoice: { label: 'Invoice', to: '/erp/billing' },
  credit_note: { label: 'Credit note', to: '/erp/billing' },
  sales_order: { label: 'Sales order', to: '/erp/sales-orders' },
  purchase_order: { label: 'Purchase order', to: '/erp/purchase-orders' },
}

function RecentPanel({ rows }: { rows: DashboardAnalytics['recent'] }) {
  return (
    <Panel title="Recent transactions" note="Latest invoices, sales and purchase orders" flush={rows.length > 0}>
      {rows.length === 0 ? <p className="hrd-empty">No documents yet.</p> : (
        <div className="table-wrap">
          <table className="hrd-table">
            <thead><tr><th>Document</th><th>Party</th><th>Date</th><th className="num">Amount</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.kind}-${row.id}`}>
                  <td>
                    <Link to={KIND[row.kind].to} className="hrd-person">
                      <span className="hrd-person-name">{row.number ?? 'Draft'}</span>
                      <span className="hrd-person-meta">{KIND[row.kind].label}</span>
                    </Link>
                  </td>
                  <td className="ed-party">{row.party ?? '—'}</td>
                  <td><DateText iso={row.date} /></td>
                  <td className="num">{rupeesShort(row.amount)}</td>
                  <td><ErpState value={row.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}

/** Everything waiting on someone. Late and short come first, in red. */
function Worklist({ data }: { data: Dashboard }) {
  const { procurement: p, inventory: i, sales: s, billing: b } = data
  const rows: { label: string; value: number; to: string; hot?: boolean }[] = [
    { label: 'Late purchase deliveries', value: Number(p.pos_overdue), to: '/erp/purchase-orders', hot: true },
    { label: 'Items below reorder level', value: Number(i.low_stock), to: '/erp/inventory', hot: true },
    { label: 'Sales orders to release', value: Number(s.orders_pending), to: '/erp/approvals' },
    { label: 'Purchase orders to approve', value: Number(p.pos_pending), to: '/erp/approvals' },
    { label: 'Requisitions to approve', value: Number(p.requisitions_pending), to: '/erp/requisitions' },
    { label: 'Requisitions ready to order', value: Number(p.requisitions_to_order), to: '/erp/requisitions' },
    { label: 'Dispatched, not invoiced', value: Number(s.uninvoiced_dispatches), to: '/erp/billing' },
    { label: 'Stock adjustments to approve', value: Number(i.adjustments_pending), to: '/erp/approvals' },
    { label: 'Credit notes to approve', value: Number(b.credit_notes_pending), to: '/erp/approvals' },
    { label: 'Vendors to approve', value: Number(p.vendors_pending), to: '/masters/erp/vendors' },
    { label: 'Draft invoices', value: Number(b.drafts), to: '/erp/billing' },
  ]
  const open = rows.filter((row) => row.value > 0)
  return (
    <Panel title="Needs attention" note={open.length ? `${open.length} worklists waiting` : 'All clear'}
      link={{ to: '/erp/approvals', label: 'Open inbox' }}>
      {open.length === 0 ? <p className="hrd-empty">Nothing is waiting on anyone.</p> : (
        <ul className="hrd-list">
          {open.map((row) => (
            <li key={row.label}>
              <Link to={row.to} className="hrd-list-row">
                <span className={`hrd-dot-icon ${row.hot ? 'tone-bad' : 'tone-warn'}`} aria-hidden>
                  {row.hot ? <IconAlert size={13} /> : <IconClock size={13} />}
                </span>
                <span className="hrd-list-main">{row.label}</span>
                <span className={`hrd-count${row.hot ? ' is-hot' : ''}`}>{row.value}</span>
                <IconChevronRight size={14} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

/** First-run steps, shown until every one is done. */
function Setup() {
  const warehouses = useQuery('erp-warehouses', () => erp.warehouses())
  const items = useQuery('erp-items-list-', () => erp.items({}))
  const vendors = useQuery('erp-vendors--', () => erp.vendors({}))
  const settings = useQuery('erp-settings', () => erp.settings())
  if (!warehouses.data || !items.data || !vendors.data || !settings.data) return null
  const steps = [
    { label: 'Add a warehouse', to: '/masters/erp/warehouses', done: warehouses.data.length > 0, icon: <IconBuilding size={15} /> },
    { label: 'Add your items', to: '/masters/erp/items', done: items.data.length > 0, icon: <IconFolder size={15} /> },
    { label: 'Add vendors', to: '/masters/erp/vendors', done: vendors.data.length > 0, icon: <IconUpload size={15} /> },
    { label: 'Set invoice terms', to: '/erp/settings', done: Boolean(settings.data.invoice_terms), icon: <IconSheet size={15} /> },
  ]
  const done = steps.filter((step) => step.done).length
  if (done === steps.length) return null
  return (
    <Panel title="Finish setting up" note={`${done} of ${steps.length} done — the masters every document draws on`}>
      <div className="hrd-shortcuts ed-steps">
        {steps.map((step) => (
          <Link key={step.label} to={step.to} className={`hrd-shortcut${step.done ? ' is-done' : ''}`}>
            {step.done ? <IconCheck size={15} /> : step.icon}
            {step.label}
          </Link>
        ))}
      </div>
    </Panel>
  )
}
