/* ERP Approvals: everything that has been through approval, in one place.
 *
 * The cards count, the tabs and filters narrow, and a pending row the viewer can
 * decide is decided inline. The server applies the same rule that sets
 * `can_decide` — the chain's current rung, or the capability when there is no
 * chain — so an Approve button that appears is one that will be accepted. */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '../../lib/useQuery'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconAlert, IconCheck, IconClock, IconClose, IconSearch, IconSliders } from '../../components/Icons'
import { CrmPage } from '../crm/parts'
import { erp, erpError, FLOW_LABEL, rupees, type ApprovalRow, type PendingApproval } from './api'
import { ReasonDialog, useRun } from './parts'
import '../../styles/approvals.css'

type Kind = PendingApproval['kind']
type TabKey = 'pending' | 'approved' | 'rejected' | 'all'
type Range = '' | 'today' | 'week' | 'month'

const PAGE = 15

const LINK: Record<Kind, string> = {
  purchase_requisition: '/erp/requisitions?open=',
  purchase_order: '/erp/purchase-orders?open=',
  stock_adjustment: '/erp/inventory?tab=docs',
  sales_order: '/erp/sales-orders?open=',
  credit_note: '/erp/billing?open=',
}
const linkTo = (r: ApprovalRow) => (LINK[r.kind].endsWith('=') ? `${LINK[r.kind]}${r.id}` : LINK[r.kind])

function decide(row: ApprovalRow, approve: boolean, note?: string) {
  switch (row.kind) {
    case 'purchase_requisition': return erp.decideRequisition(row.id, approve, note)
    case 'purchase_order': return erp.decidePurchaseOrder(row.id, approve, note)
    case 'stock_adjustment': return erp.decideStockDoc(row.id, approve, note)
    case 'sales_order': return erp.decideSalesOrder(row.id, approve, note)
    case 'credit_note': return erp.decideCreditNote(row.id, approve, note)
  }
}

const stamp = (iso: string | null) => (iso
  ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })
  : '—')

function inRange(iso: string | null, range: Range) {
  if (!range) return true
  if (!iso) return false
  const when = new Date(iso)
  const now = new Date()
  if (range === 'month') return when.getFullYear() === now.getFullYear() && when.getMonth() === now.getMonth()
  if (range === 'today') return when.toDateString() === now.toDateString()
  return now.getTime() - when.getTime() <= 7 * 86_400_000
}

export default function ErpApprovals() {
  const q = useQuery('erp-approval-register', () => erp.approvalRegister())
  const [tab, setTab] = useState<TabKey>('pending')
  const [text, setText] = useState('')
  const [kind, setKind] = useState<'' | Kind>('')
  const [range, setRange] = useState<Range>('')
  const [page, setPage] = useState(0)
  const [filtering, setFiltering] = useState(false)
  const [rejecting, setRejecting] = useState<ApprovalRow | null>(null)
  const { busy, error, run } = useRun(() => q.reload())

  const all = q.data ?? []
  const needle = text.trim().toLowerCase()
  const base = all.filter((r) => (!kind || r.kind === kind) && inRange(r.submitted_at, range)
    && (!needle || [r.number, r.title, r.subject_name, FLOW_LABEL[r.kind]].some((v) => v?.toLowerCase().includes(needle))))
  const rows = tab === 'all' ? base : base.filter((r) => r.state === tab)
  const pages = Math.max(1, Math.ceil(rows.length / PAGE))
  const at = Math.min(page, pages - 1)
  const shown = rows.slice(at * PAGE, at * PAGE + PAGE)

  const thisMonth = (s: ApprovalRow['state']) => all.filter((r) => r.state === s && inRange(r.reviewed_at, 'month')).length
  const total = (s: ApprovalRow['state']) => all.filter((r) => r.state === s).length
  const pending = total('pending')
  const mine = all.filter((r) => r.state === 'pending' && r.can_decide).length
  const filtered = Boolean(text || kind || range || tab !== 'pending')
  const active = [kind, range, tab !== 'pending'].filter(Boolean).length
  const go = (t: TabKey) => { setTab(t); setPage(0) }
  const clearFilters = () => { setKind(''); setRange(''); setTab('pending'); setPage(0) }
  const reset = () => { setText(''); clearFilters() }

  const cards: { key: TabKey; tone: string; icon: React.ReactNode; value: number; label: string; sub: string }[] = [
    { key: 'pending', tone: 'wait', icon: <IconClock size={19} />, value: mine, label: 'Waiting on you', sub: `${pending} pending in all` },
    { key: 'approved', tone: 'good', icon: <IconCheck size={19} />, value: thisMonth('approved'), label: 'Approved this month', sub: `${total('approved')} in all` },
    { key: 'rejected', tone: 'bad', icon: <IconClose size={19} />, value: thisMonth('rejected'), label: 'Rejected this month', sub: `${total('rejected')} in all` },
    { key: 'pending', tone: 'info', icon: <IconAlert size={19} />, value: pending - mine, label: 'Waiting on others', sub: 'Your own, or another approver’s' },
  ]

  return (
    <CrmPage>
      <div className="apl-cards">
        {cards.map((c) => (
          <button key={c.label} type="button" className={`apl-card is-${c.tone}`} onClick={() => go(c.key)}>
            <span className="apl-card-ic" aria-hidden>{c.icon}</span>
            <span className="apl-card-txt">
              <b>{q.data ? c.value : '—'}</b>
              <span>{c.label}</span>
              <small>{c.sub}</small>
            </span>
          </button>
        ))}
      </div>

      <div className="crm-bar apl-bar">
        <div className="crm-search"><IconSearch size={15} />
          <input type="search" value={text} onChange={(e) => { setText(e.target.value); setPage(0) }}
            placeholder="Search document no., customer, vendor or requester" /></div>
        <div className="apl-filter">
          <button type="button" className={`btn apl-filter-btn${active ? ' is-on' : ''}`} aria-haspopup="dialog" aria-expanded={filtering}
            onClick={() => setFiltering((v) => !v)}>
            <IconSliders size={15} /> Filters{active > 0 && <span className="apl-filter-n">{active}</span>}
          </button>
          {filtering && (
            <>
              <div className="apl-filter-scrim" onClick={() => setFiltering(false)} />
              <div className="apl-filter-pop" role="dialog" aria-label="Filters"
                onKeyDown={(e) => { if (e.key === 'Escape') setFiltering(false) }}>
                <label><span>Status</span>
                  <select value={tab} aria-label="Status" onChange={(e) => go(e.target.value as TabKey)}>
                    <option value="pending">Pending</option>
                    <option value="approved">Approved</option>
                    <option value="rejected">Rejected</option>
                    <option value="all">All requests</option>
                  </select></label>
                <label><span>Document type</span>
                  <select value={kind} aria-label="Document type" onChange={(e) => { setKind(e.target.value as typeof kind); setPage(0) }}>
                    <option value="">All document types</option>
                    {(Object.keys(FLOW_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{FLOW_LABEL[k]}</option>)}
                  </select></label>
                <label><span>Request date</span>
                  <select value={range} aria-label="Request date" onChange={(e) => { setRange(e.target.value as Range); setPage(0) }}>
                    <option value="">Any date</option>
                    <option value="today">Today</option>
                    <option value="week">Last 7 days</option>
                    <option value="month">This month</option>
                  </select></label>
                <div className="apl-filter-foot">
                  <span>{rows.length} of {all.length} match</span>
                  <button type="button" className="btn btn-sm" disabled={!active} onClick={clearFilters}>Clear all</button>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => setFiltering(false)}>Done</button>
                </div>
              </div>
            </>
          )}
        </div>
        {filtered && <button type="button" className="btn" onClick={reset}>Clear</button>}
      </div>

      {q.error && <ErrorNote>{erpError(q.cause, 'Could not load approvals')}</ErrorNote>}
      {error && <div className="apl-err"><ErrorNote>{error}</ErrorNote></div>}

      <section className="card apl-table-card">
        {!q.data ? (q.error ? null : <Loading />) : shown.length === 0 ? (
          <EmptyState icon={<IconCheck size={22} />}
            title={filtered ? 'Nothing matches' : tab === 'pending' ? 'Nothing pending' : 'Nothing here yet'}
            body={filtered ? 'Change the search or the filters.' : 'Requisitions, purchase orders, stock adjustments, sales orders and credit notes appear here once submitted.'} />
        ) : (
          <>
            <div className="table-wrap"><table className="apl-table">
              <thead><tr>
                <th className="apl-n">#</th><th>Document type</th><th>Document no.</th><th>Party / details</th><th className="crm-num">Amount</th>
                <th>Requested by</th><th>Request date</th><th>Status</th><th className="apl-act">Actions</th>
              </tr></thead>
              <tbody>{shown.map((r, i) => (
                <tr key={`${r.kind}-${r.id}`}>
                  <td className="apl-n">{at * PAGE + i + 1}</td>
                  <td><span className={`apl-kind is-${r.kind}`}>{FLOW_LABEL[r.kind]}</span>{r.level && <small className="apl-sub">{r.level}</small>}</td>
                  <td><Link className="apl-no" to={linkTo(r)}>{r.number ?? 'Awaiting number'}</Link></td>
                  <td className="apl-title" title={r.title}>{r.title}</td>
                  <td className="crm-num apl-amt">{rupees(r.amount)}</td>
                  <td>{r.subject_name ?? '—'}</td>
                  <td className="apl-when">{stamp(r.submitted_at)}</td>
                  <td className="apl-status">
                    <span className={`apl-state is-${r.state}`}><i aria-hidden />{r.state === 'pending' ? 'Pending' : r.state === 'approved' ? 'Approved' : 'Rejected'}</span>
                    {r.state !== 'pending' && <small className="apl-sub">{r.reviewed_by_name ? `by ${r.reviewed_by_name}` : ''}</small>}
                    {r.review_note && <small className="apl-sub apl-note" title={r.review_note}>“{r.review_note}”</small>}
                  </td>
                  <td className="apl-act">
                    <div className="apl-btns">
                      <Link className="btn btn-sm" to={linkTo(r)}>View</Link>
                      {r.can_decide && <>
                        <button type="button" className="btn btn-sm apl-yes" disabled={busy}
                          onClick={() => void run(() => decide(r, true) as Promise<unknown>, 'That could not be approved')}>Approve</button>
                        <button type="button" className="btn btn-sm apl-reject" disabled={busy} onClick={() => setRejecting(r)}>Reject</button>
                      </>}
                      {r.state === 'pending' && !r.can_decide && <small className="apl-sub">{r.own ? 'Your request: needs another approver' : 'With another approver'}</small>}
                    </div>
                  </td>
                </tr>
              ))}</tbody>
            </table></div>
            <footer className="apl-foot">
              <span>Showing {at * PAGE + 1} to {Math.min((at + 1) * PAGE, rows.length)} of {rows.length} {rows.length === 1 ? 'request' : 'requests'}</span>
              {pages > 1 && (
                <span className="apl-pager">
                  <button type="button" className="btn btn-sm" disabled={at === 0} onClick={() => setPage(at - 1)}>Previous</button>
                  <b>{at + 1} / {pages}</b>
                  <button type="button" className="btn btn-sm" disabled={at >= pages - 1} onClick={() => setPage(at + 1)}>Next</button>
                </span>
              )}
            </footer>
          </>
        )}
      </section>

      {rejecting && (
        <ReasonDialog title={`Reject ${rejecting.number ?? FLOW_LABEL[rejecting.kind]}`} confirm="Reject" danger
          hint="The requester sees this — say what would make it approvable."
          onClose={() => setRejecting(null)}
          onSubmit={async (reason) => { await decide(rejecting, false, reason); q.reload() }} />
      )}
    </CrmPage>
  )
}
