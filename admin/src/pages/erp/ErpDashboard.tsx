/* ERP dashboard — the operational worklist in figures (PRD §8).
 *
 * Every tile links to the list it counts, so a number here can always be
 * checked against the rows behind it. Laid out with the HR Dashboard's hero,
 * KPI cards and panels so the three module dashboards read as one product. */

import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import '../../styles/crm.css'
import '../../styles/hrdash.css'
import { useQuery } from '../../lib/useQuery'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconAlert, IconCard, IconCheck, IconClock, IconSheet } from '../../components/Icons'
import { erp, erpError, qtyText, rupeesShort, type Dashboard } from './api'

type Tone = 'brand' | 'good' | 'warn' | 'bad' | 'idle'

/** Amber or red only when the count asks for action — a red zero is an alarm
 *  about nothing. */
const owed = (value: number | string, tone: Tone): Tone => (Number(value) > 0 ? tone : 'idle')

function Kpi({ label, value, hint, tone, to, icon }: {
  label: string
  value: ReactNode
  hint: string
  tone: Tone
  to: string
  icon: ReactNode
}) {
  return (
    <Link to={to} className={`hrd-kpi tone-${tone}`}>
      <span className="hrd-kpi-top">
        <span className="hrd-kpi-label" title={label}>{label}</span>
        <span className="hrd-kpi-icon" aria-hidden>{icon}</span>
      </span>
      <span className="hrd-kpi-value">{value}</span>
      <span className="hrd-kpi-hint">{hint}</span>
    </Link>
  )
}

function Section({ title, note, link, children }: {
  title: string
  note: string
  link: { to: string; label: string }
  children: ReactNode
}) {
  return (
    <section className="hrd-panel">
      <div className="hrd-panel-head">
        <div>
          <h2 className="hrd-panel-title">{title}</h2>
          <span className="hrd-panel-note">{note}</span>
        </div>
        <Link className="hrd-panel-link" to={link.to}>{link.label} ›</Link>
      </div>
      <div className="hrd-panel-body">{children}</div>
    </section>
  )
}

export default function ErpDashboard() {
  const q = useQuery<Dashboard>('erp-dashboard', () => erp.dashboard())
  const dateLine = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const d = q.data
  const waiting = d
    ? Number(d.procurement.requisitions_pending) + Number(d.procurement.pos_pending)
      + Number(d.inventory.adjustments_pending) + Number(d.sales.orders_pending)
    : 0

  return (
    <div className="crm hrd">
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
          <Link className="btn btn-primary" to="/erp/requisitions">
            <IconSheet size={15} /> Requisitions
          </Link>
        </div>
      </header>

      {q.error && !d ? (
        <ErrorNote>{erpError(q.cause, 'Could not load the dashboard')}</ErrorNote>
      ) : !d ? (
        <Loading />
      ) : (
        <Body data={d} />
      )}
    </div>
  )
}

function Body({ data }: { data: Dashboard }) {
  const { procurement: p, inventory: i, sales: s, billing: b, capabilities } = data
  const anything = Object.values(capabilities).some(Boolean)

  return (
    <>
      {!anything && (
        <EmptyState icon={<IconSheet size={22} />} title="You have no ERP role yet"
          body="You can still raise a purchase requisition. An administrator grants ERP permissions from Roles & Permissions." />
      )}

      <Section title="Procurement" note="Requisitions, purchase orders and vendors" link={{ to: '/erp/purchase-orders', label: 'Purchase orders' }}>
        <div className="hrd-kpis erd-kpis">
          <Kpi label="Requisitions awaiting approval" value={p.requisitions_pending} hint="Waiting on a decision"
            tone={owed(p.requisitions_pending, 'warn')} icon={<IconClock size={16} />} to="/erp/requisitions" />
          <Kpi label="Approved, not yet ordered" value={p.requisitions_to_order} hint="Ready to become a PO"
            tone="brand" icon={<IconSheet size={16} />} to="/erp/requisitions" />
          <Kpi label="POs awaiting approval" value={p.pos_pending} hint="Waiting on a decision"
            tone={owed(p.pos_pending, 'warn')} icon={<IconClock size={16} />} to="/erp/approvals" />
          <Kpi label="Open purchase value" value={rupeesShort(p.open_po_value)} hint={`${p.pos_open} open orders`}
            tone="brand" icon={<IconCard size={16} />} to="/erp/purchase-orders" />
          <Kpi label="Overdue deliveries" value={p.pos_overdue} hint="Past the expected date"
            tone={owed(p.pos_overdue, 'bad')} icon={<IconAlert size={16} />} to="/erp/purchase-orders" />
          <Kpi label="Vendors awaiting approval" value={p.vendors_pending} hint="New vendor requests"
            tone={owed(p.vendors_pending, 'warn')} icon={<IconCheck size={16} />} to="/erp/masters" />
        </div>
      </Section>

      <Section title="Inventory" note="Stock on hand and movements in flight" link={{ to: '/erp/inventory', label: 'Inventory' }}>
        <div className="hrd-kpis erd-kpis">
          <Kpi label="Stock value" value={rupeesShort(i.stock_value)} hint="At weighted average cost"
            tone="good" icon={<IconCard size={16} />} to="/erp/inventory" />
          <Kpi label="At or below reorder level" value={i.low_stock} hint="Items to replenish"
            tone={owed(i.low_stock, 'warn')} icon={<IconAlert size={16} />} to="/erp/inventory" />
          <Kpi label="Transfers in transit" value={i.transfers_in_transit} hint="Between locations"
            tone="brand" icon={<IconClock size={16} />} to="/erp/inventory" />
          <Kpi label="Adjustments awaiting approval" value={i.adjustments_pending} hint="Waiting on a decision"
            tone={owed(i.adjustments_pending, 'warn')} icon={<IconCheck size={16} />} to="/erp/approvals" />
        </div>
        {i.low_stock_items.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 14 }}>
            <table>
              <thead><tr><th>Low stock</th><th className="crm-num">Available</th><th className="crm-num">Reorder level</th></tr></thead>
              <tbody>
                {i.low_stock_items.map((row) => (
                  <tr key={row.id}>
                    <td><span className="crm-code">{row.code}</span> {row.name}</td>
                    <td className="crm-num">{qtyText(row.available)}</td>
                    <td className="crm-num">{qtyText(row.reorder_level)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Sales & billing" note="Orders, dispatches, invoices and what is owed" link={{ to: '/erp/billing', label: 'Billing' }}>
        <div className="hrd-kpis erd-kpis">
          <Kpi label="Orders awaiting release" value={s.orders_pending} hint="Waiting on a decision"
            tone={owed(s.orders_pending, 'warn')} icon={<IconClock size={16} />} to="/erp/approvals" />
          <Kpi label="Order backlog" value={rupeesShort(s.backlog_value)} hint={`${s.orders_open} open · ${s.orders_on_hold} on hold`}
            tone="brand" icon={<IconSheet size={16} />} to="/erp/sales-orders" />
          <Kpi label="Dispatched, not invoiced" value={s.uninvoiced_dispatches} hint="Bill these next"
            tone={owed(s.uninvoiced_dispatches, 'warn')} icon={<IconAlert size={16} />} to="/erp/billing" />
          <Kpi label="Billed this month" value={rupeesShort(b.billed_this_month)} hint="Invoices raised"
            tone="good" icon={<IconCard size={16} />} to="/erp/billing" />
          <Kpi label="Receivables" value={rupeesShort(b.outstanding)} hint={`${rupeesShort(b.overdue)} overdue`}
            tone={owed(b.overdue, 'bad')} icon={<IconCard size={16} />} to="/erp/billing" />
        </div>
      </Section>

      <p className="crm-muted" style={{ margin: 0 }}>
        Quotations, projects, timesheets, expenses and the service desk stay in their own modules —{' '}
        <Link to="/crm/quotations">CRM quotations</Link> convert straight into sales orders here.
      </p>
    </>
  )
}
