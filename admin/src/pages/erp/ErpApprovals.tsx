/* Everything in the ERP waiting on this person's decision, oldest first.
 *
 * Decided inline. The server applies the same rule that put a row here — the
 * chain's current rung, or the capability when there is no chain — so a row
 * that appears is one the viewer can actually decide. */

import { Link } from 'react-router-dom'
import { useQuery } from '../../lib/useQuery'
import { relativeTime } from '../../lib/format'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconCheck } from '../../components/Icons'
import { erp, erpError, FLOW_LABEL, type PendingApproval } from './api'
import { DecideBar, ErpPage, Money } from './parts'

const LINK: Record<PendingApproval['kind'], string> = {
  purchase_requisition: '/erp/requisitions',
  purchase_order: '/erp/purchase-orders',
  stock_adjustment: '/erp/inventory',
  sales_order: '/erp/sales-orders',
  credit_note: '/erp/billing',
}

function decide(row: PendingApproval, approve: boolean, note?: string) {
  switch (row.kind) {
    case 'purchase_requisition': return erp.decideRequisition(row.id, approve, note)
    case 'purchase_order': return erp.decidePurchaseOrder(row.id, approve, note)
    case 'stock_adjustment': return erp.decideStockDoc(row.id, approve, note)
    case 'sales_order': return erp.decideSalesOrder(row.id, approve, note)
    case 'credit_note': return erp.decideCreditNote(row.id, approve, note)
  }
}

export default function ErpApprovals() {
  const q = useQuery('erp-approvals', () => erp.approvals())
  return (
    <ErpPage title="ERP approvals" subtitle="Requisitions, purchase orders, adjustments, orders and credit notes waiting on you">
      {q.error && <ErrorNote>{erpError(q.cause, 'Could not load the queue')}</ErrorNote>}
      <section className="card">
        {!q.data ? <Loading /> : q.data.length === 0 ? (
          <EmptyState icon={<IconCheck size={22} />} title="Nothing waiting on you"
            body="Anything you raised yourself goes to somebody else — that is the point of the approval." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Document</th><th>For</th><th>Raised by</th><th className="crm-num">Value</th><th>Waiting</th><th style={{ textAlign: 'right' }}>Decision</th></tr>
              </thead>
              <tbody>
                {q.data.map((row) => (
                  <tr key={`${row.kind}-${row.id}`}>
                    <td>
                      <div className="crm-strong">{FLOW_LABEL[row.kind]} <Link to={LINK[row.kind]}>{row.number}</Link></div>
                      {row.level && <div className="crm-sub">{row.level}</div>}
                    </td>
                    <td>{row.title}</td>
                    <td>{row.subject_name ?? '—'}</td>
                    <td className="crm-num"><Money value={row.amount} /></td>
                    <td className="crm-muted">{relativeTime(row.submitted_at)}</td>
                    <td><div className="crm-row-actions" style={{ justifyContent: 'flex-end' }}>
                      <DecideBar onDecide={async (approve, note) => { await decide(row, approve, note); q.reload() }} />
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </ErpPage>
  )
}
