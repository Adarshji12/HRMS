/* ERP dashboard — the operational worklist in figures (PRD §8).
 *
 * Every tile links to the list it counts, so a number here can always be
 * checked against the rows behind it. */

import { Link } from 'react-router-dom'
import { useQuery } from '../../lib/useQuery'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconAlert, IconCard, IconCheck, IconClock, IconSheet } from '../../components/Icons'
import { erp, erpError, qtyText, rupeesShort } from './api'
import { ErpPage, Stat, Stats } from './parts'

export default function ErpDashboard() {
  const q = useQuery('erp-dashboard', () => erp.dashboard())
  if (q.error && !q.data) {
    return <ErpPage title="ERP"><ErrorNote>{erpError(q.cause, 'Could not load the dashboard')}</ErrorNote></ErpPage>
  }
  if (!q.data) return <ErpPage title="ERP"><Loading /></ErpPage>
  const { procurement: p, inventory: i, sales: s, billing: b, capabilities } = q.data
  const anything = Object.values(capabilities).some(Boolean)

  return (
    <ErpPage title="ERP" subtitle="What is being bought, held, sold and billed — and what is waiting on somebody">
      {!anything && (
        <EmptyState icon={<IconSheet size={22} />} title="You have no ERP role yet"
          body="You can still raise a purchase requisition. An administrator grants ERP permissions from Roles & Permissions." />
      )}

      <h3 className="crm-panel-title" style={{ margin: '8px 0' }}>Procurement</h3>
      <Stats>
        <Stat label="Requisitions awaiting approval" value={p.requisitions_pending} icon={<IconClock size={16} />} to="/erp/requisitions" />
        <Stat label="Approved, not yet ordered" value={p.requisitions_to_order} icon={<IconSheet size={16} />} to="/erp/requisitions" />
        <Stat label="POs awaiting approval" value={p.pos_pending} icon={<IconClock size={16} />} to="/erp/approvals" />
        <Stat label="Open purchase value" value={rupeesShort(p.open_po_value)} meta={`${p.pos_open} open orders`}
          icon={<IconCard size={16} />} to="/erp/purchase-orders" />
        <Stat label="Overdue deliveries" value={p.pos_overdue} icon={<IconAlert size={16} />}
          tone="var(--status-critical)" toned={Number(p.pos_overdue) > 0} to="/erp/purchase-orders" />
        <Stat label="Vendors awaiting approval" value={p.vendors_pending} icon={<IconCheck size={16} />} to="/erp/masters" />
      </Stats>

      <h3 className="crm-panel-title" style={{ margin: '18px 0 8px' }}>Inventory</h3>
      <Stats>
        <Stat label="Stock value" value={rupeesShort(i.stock_value)} meta="at weighted average cost" icon={<IconCard size={16} />} to="/erp/inventory" />
        <Stat label="At or below reorder level" value={i.low_stock} icon={<IconAlert size={16} />}
          tone="var(--status-warn)" toned={Number(i.low_stock) > 0} to="/erp/inventory" />
        <Stat label="Transfers in transit" value={i.transfers_in_transit} icon={<IconClock size={16} />} to="/erp/inventory" />
        <Stat label="Adjustments awaiting approval" value={i.adjustments_pending} icon={<IconCheck size={16} />} to="/erp/approvals" />
      </Stats>
      {i.low_stock_items.length > 0 && (
        <section className="card" style={{ marginTop: 10 }}>
          <div className="table-wrap">
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
        </section>
      )}

      <h3 className="crm-panel-title" style={{ margin: '18px 0 8px' }}>Sales & billing</h3>
      <Stats>
        <Stat label="Orders awaiting release" value={s.orders_pending} icon={<IconClock size={16} />} to="/erp/approvals" />
        <Stat label="Order backlog" value={rupeesShort(s.backlog_value)} meta={`${s.orders_open} open · ${s.orders_on_hold} on hold`}
          icon={<IconSheet size={16} />} to="/erp/sales-orders" />
        <Stat label="Dispatched, not invoiced" value={s.uninvoiced_dispatches} icon={<IconAlert size={16} />}
          tone="var(--status-warn)" toned={Number(s.uninvoiced_dispatches) > 0} to="/erp/billing" />
        <Stat label="Billed this month" value={rupeesShort(b.billed_this_month)} icon={<IconCard size={16} />} to="/erp/billing" />
        <Stat label="Receivables" value={rupeesShort(b.outstanding)} meta={`${rupeesShort(b.overdue)} overdue`}
          icon={<IconCard size={16} />} tone="var(--status-critical)" toned={Number(b.overdue) > 0} to="/erp/billing" />
      </Stats>
      <p className="crm-muted" style={{ marginTop: 18 }}>
        Quotations, projects, timesheets, expenses and the service desk stay in their own modules —{' '}
        <Link to="/crm/quotations">CRM quotations</Link> convert straight into sales orders here.
      </p>
    </ErpPage>
  )
}
