/* Quotations — every offer the team has priced, and where each one stands.
 *
 * The list is a money list, so the tiles are values rather than counts and the
 * status filter is a row of chips with the count on each: "how much is out
 * there" and "what is waiting on a customer" are the two questions this page
 * exists to answer.
 *
 * `expired` in the tiles is counted from the validity date, not from the stored
 * status. Nothing sweeps quotations into `expired`, so a status-only count would
 * read zero forever on a workspace with a shelf full of stale offers.
 */

import { useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import '../../styles/crm.css'
import '../../styles/hrdash.css'
import { useQuery } from '../../lib/useQuery'
import { shortDate } from '../../lib/format'
import { Avatar, EmptyState, ErrorNote, Loading } from '../../components/ui'
import {
  IconAlert,
  IconCheck,
  IconClock,
  IconPlus,
  IconSearch,
  IconSheet,
} from '../../components/Icons'
import {
  crm,
  crmError,
  rupees,
  rupeesShort,
  type QuotationRow,
} from './api'
import { CrmPage, StateText } from './parts'

const FILTERS: Array<{ key: string; label: string }> = [
  { key: '', label: 'All' },
  { key: 'draft', label: 'Draft' },
  { key: 'sent', label: 'Sent' },
  { key: 'failed', label: 'Failed' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'expired', label: 'Expired' },
]

export default function Quotations() {
  const navigate = useNavigate()
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [rowError, setRowError] = useState<string | null>(null)

  const all = useQuery<QuotationRow[]>(`crm-quotations-${q}`, () =>
    crm.quotations({ q: q.trim() || undefined }),
  )
  const summary = useQuery('crm-quotation-summary', () => crm.quotationSummary())

  const list = (all.data ?? []).filter((row) => !status || row.status === status)
  const countOf = (key: string) =>
    key ? (all.data ?? []).filter((row) => row.status === key).length : (all.data ?? []).length

  async function remove(row: QuotationRow) {
    setRowError(null)
    try {
      await crm.deleteQuotation(row.id)
      all.reload()
      summary.reload()
    } catch (err) {
      setRowError(crmError(err, 'That quotation could not be deleted'))
    }
  }

  async function duplicate(row: QuotationRow) {
    setRowError(null)
    try {
      const copy = await crm.duplicateQuotation(row.id)
      navigate(`/crm/quotations/${copy.id}`)
    } catch (err) {
      setRowError(crmError(err, 'That quotation could not be copied'))
    }
  }

  if (all.error && !all.data) {
    return (
      <CrmPage title="Quotations">
        <ErrorNote>{crmError(all.cause, 'Could not load the quotations')}</ErrorNote>
      </CrmPage>
    )
  }

  const s = summary.data

  const accepted = countOf('accepted')
  const decided = accepted + countOf('rejected')

  // The HR Dashboard's KPI cards. Expired only turns amber when there is a
  // stale offer to chase — an amber zero is an alarm about nothing.
  const kpis: Array<{ label: string; value: ReactNode; hint: string; tone: string; icon: ReactNode }> = [
    { label: 'Quotations', value: s?.count ?? 0, hint: `${countOf('draft')} draft · ${countOf('sent')} sent`, tone: 'brand', icon: <IconSheet size={16} /> },
    { label: 'Open value', value: rupeesShort(s?.open_value ?? '0'), hint: 'Draft and sent', tone: 'brand', icon: <IconClock size={16} /> },
    { label: 'Accepted value', value: rupeesShort(s?.accepted_value ?? '0'), hint: decided ? `${Math.round((accepted / decided) * 100)}% win rate` : 'Signed off', tone: 'good', icon: <IconCheck size={16} /> },
    { label: 'Expired', value: s?.expired ?? 0, hint: s?.expired ? 'Past their validity date' : 'All still valid', tone: s?.expired ? 'warn' : 'idle', icon: <IconAlert size={16} /> },
  ]

  return (
    <div className="crm hrd">
      <div className="hrd-kpis ld-kpis" role="group" aria-label="Quotation summary">
        {kpis.map((k) => (
          <div key={k.label} className={`hrd-kpi tone-${k.tone}`}>
            <span className="hrd-kpi-top">
              <span className="hrd-kpi-label">{k.label}</span>
              <span className="hrd-kpi-icon" aria-hidden>{k.icon}</span>
            </span>
            <span className="hrd-kpi-value">{k.value}</span>
            <span className="hrd-kpi-hint">{k.hint}</span>
          </div>
        ))}
      </div>

      <div className="crm-bar">
        <div className="crm-search">
          <IconSearch size={15} />
          <input
            type="search"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Search number, customer"
            aria-label="Search quotations"
          />
        </div>
        <div className="crm-seg">
          {FILTERS.map((filter) => (
            <button
              key={filter.key || 'all'}
              className={status === filter.key ? 'crm-seg-on' : ''}
              onClick={() => setStatus(filter.key)}
            >
              {filter.label} <span className="crm-seg-count">{countOf(filter.key)}</span>
            </button>
          ))}
        </div>
        {/* No page header: the one action sits beside the status filters. */}
        <Link className="btn btn-primary qt-new" to="/crm/quotations/new">
          <IconPlus size={15} /> New quotation
        </Link>
      </div>

      {rowError && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNote>{rowError}</ErrorNote>
        </div>
      )}

      <section className="hrd-panel" style={{ opacity: all.refetching ? 0.6 : 1 }}>
        {list.length === 0 ? (
          all.loading ? (
            <Loading />
          ) : (
            <EmptyState
              icon={<IconSheet size={22} />}
              title={status ? 'Nothing with that status' : 'No quotations yet'}
              body={
                status
                  ? 'Clear the filter to see everything that has been priced.'
                  : 'Price an offer from your product masters. Rates and GST come from the catalogue and stay editable line by line.'
              }
              action={
                !status && (
                  <Link className="btn btn-primary" to="/crm/quotations/new">
                    Raise the first quotation
                  </Link>
                )
              }
            />
          )
        ) : (
          <>
            <div className="table-wrap">
              <table className="crm-table-wide">
                <thead>
                  <tr>
                    <th>Quotation</th>
                    <th>Customer</th>
                    <th>Date</th>
                    <th>Valid until</th>
                    <th className="crm-num">Amount</th>
                    <th>Status</th>
                    <th>Created by</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((row) => {
                    const stale =
                      row.valid_until !== null &&
                      new Date(row.valid_until) < new Date() &&
                      (row.status === 'draft' || row.status === 'sent')
                    return (
                      <tr key={row.id}>
                        <td>
                          <Link className="crm-code" to={`/crm/quotations/${row.id}`}>
                            {row.number}
                          </Link>
                        </td>
                        <td>
                          {row.customer_name ? (
                            <span className="cu-person">
                              <Avatar name={row.customer_name} small />
                              <span>
                                <span className="crm-strong">{row.customer_name}</span>
                                {row.company && <span className="crm-sub">{row.company}</span>}
                              </span>
                            </span>
                          ) : (
                            <span className="crm-muted">—</span>
                          )}
                        </td>
                        <td className="crm-nowrap">{shortDate(row.quote_date)}</td>
                        <td className="crm-nowrap">
                          {row.valid_until ? (
                            <span className={stale ? 'crm-due-over' : ''}>
                              {shortDate(row.valid_until)}
                            </span>
                          ) : (
                            <span className="crm-muted">—</span>
                          )}
                        </td>
                        <td className="crm-num crm-strong">{rupees(row.grand_total)}</td>
                        <td>
                          <StateText value={row.status} />
                        </td>
                        <td>{row.created_by_name ?? <span className="crm-muted">—</span>}</td>
                        <td>
                          <div className="crm-row-actions">
                            <Link className="link-btn" to={`/crm/quotations/${row.id}`}>
                              Open
                            </Link>
                            <button className="link-btn" onClick={() => duplicate(row)}>
                              Copy
                            </button>
                            {row.status === 'draft' && (
                              <button className="link-btn" onClick={() => remove(row)}>
                                Delete
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="crm-foot">
              <span>
                Showing {list.length} of {(all.data ?? []).length}
              </span>
            </div>
          </>
        )}
      </section>
    </div>
  )
}
