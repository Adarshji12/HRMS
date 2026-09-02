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

import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import '../../styles/crm.css'
import { useQuery } from '../../lib/useQuery'
import { shortDate } from '../../lib/format'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
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
import { CrmPage, Stat, StateText, Stats } from './parts'

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

  return (
    <CrmPage
      title="Quotations"
      subtitle="Every offer your team has priced — and where each one stands"
      actions={
        <Link className="btn btn-primary" to="/crm/quotations/new">
          <IconPlus size={15} /> New quotation
        </Link>
      }
    >
      <Stats>
        <Stat label="Quotations" value={s?.count ?? 0} icon={<IconSheet size={16} />} />
        <Stat
          label="Open value"
          value={rupeesShort(s?.open_value ?? '0')}
          meta="draft and sent"
          icon={<IconClock size={16} />}
        />
        <Stat
          label="Accepted value"
          value={rupeesShort(s?.accepted_value ?? '0')}
          meta="signed off"
          icon={<IconCheck size={16} />}
          tone="var(--status-good)"
          toned={Number(s?.accepted_value ?? 0) > 0}
        />
        <Stat
          label="Expired"
          value={s?.expired ?? 0}
          meta={s?.expired ? 'past their validity date' : 'all still valid'}
          icon={<IconAlert size={16} />}
          tone="var(--status-warn)"
          toned={Boolean(s?.expired)}
        />
      </Stats>

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
      </div>

      {rowError && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNote>{rowError}</ErrorNote>
        </div>
      )}

      <section className="card" style={{ opacity: all.refetching ? 0.6 : 1 }}>
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
              <table>
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
                          <div className="crm-strong">
                            {row.customer_name ?? <span className="crm-muted">—</span>}
                          </div>
                          {row.company && <div className="crm-sub">{row.company}</div>}
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
                        <td className="crm-num">{rupees(row.grand_total)}</td>
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
    </CrmPage>
  )
}
