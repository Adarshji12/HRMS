/**
 * Costsheet approvals: every opportunity whose costsheet has been ticked
 * "Approve", as a table.
 *
 * It lives in the Employee tabs because that is where the people who sign
 * these off already work, but the data is the CRM's: the same opportunities the
 * lead pages show, read through the same ownership scope. An account that is
 * not licensed for CRM gets an explanation here, not a broken table.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import '../../styles/crm.css'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { IconDownload } from '../../components/Icons'
import { api, download } from '../../lib/api'
import { dateTime } from '../../lib/format'
import { useQuery } from '../../lib/useQuery'
import { crm, crmError, rupees, type Opportunity } from './api'

export default function CostsheetApprovals() {
  const approved = useQuery<Opportunity[]>('crm-costsheet-approvals', () =>
    api.get<Opportunity[]>('/crm/opportunities?costsheet_status=requested'),
  )
  const rows = approved.data ?? []
  const [busy, setBusy] = useState<string | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)

  async function decide(row: Opportunity, decision: 'approved' | 'rejected') {
    if (row.costsheet_status === decision) return
    setBusy(row.id)
    setRowError(null)
    try {
      await crm.decideCostsheet(row.id, decision)
      approved.reload()
    } catch (err) {
      setRowError(crmError(err, 'That decision could not be saved'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="crm">
      <header className="hrd-hero">
        <div className="hrd-hero-text">
          <h1 className="hrd-title">Costsheet approval</h1>
          <p className="crm-sub">Costsheets sent for approval. Approve or reject each one.</p>
        </div>
      </header>

      {approved.error ? (
        <ErrorNote>{crmError(approved.cause, 'Could not load the approved costsheets')}</ErrorNote>
      ) : !approved.data ? (
        <Loading label="Loading approvals…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No costsheet sent for approval"
          body="Tick Approve beside the costsheet on an opportunity and it appears here."
        />
      ) : (
        <section className="card">
          {rowError && <ErrorNote>{rowError}</ErrorNote>}
          <div className="table-wrap">
            <table className="crm-table-wide">
              <thead>
                <tr>
                  <th>Opportunity</th>
                  <th>Lead</th>
                  <th>Customer</th>
                  <th>Salesperson</th>
                  <th className="crm-num">Revenue</th>
                  <th className="crm-num">Margin</th>
                  <th>Costsheet</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link className="crm-strong" to={`/crm/leads/${row.lead_id}`}>{row.title}</Link>
                    </td>
                    <td>
                      {row.lead_name ?? '—'}
                      {row.lead_code && <span className="crm-sub"> #{row.lead_code}</span>}
                    </td>
                    <td>{row.customer_name ?? <span className="crm-muted">—</span>}</td>
                    <td>{row.owner_name ?? <span className="crm-muted">Unassigned</span>}</td>
                    <td className="crm-num">{rupees(row.expected_revenue)}</td>
                    <td className="crm-num">{row.margin_percent === null ? '—' : `${row.margin_percent}%`}</td>
                    <td>
                      {row.costsheet ? (
                        <button
                          type="button"
                          className="ldp-link"
                          title="Download the costsheet"
                          onClick={() =>
                            void download(`/crm/opportunities/${row.id}/files/costsheet`, row.costsheet?.name ?? 'costsheet')
                          }
                        >
                          <IconDownload size={13} /> {row.costsheet.name}
                        </button>
                      ) : (
                        <span className="crm-muted">No file</span>
                      )}
                    </td>
                    <td>
                      <div className="cs-decide" role="group" aria-label={`Decision for ${row.title}`}>
                        <button type="button" className={`cs-btn is-approved${row.costsheet_status === 'approved' ? ' is-on' : ''}`}
                                aria-pressed={row.costsheet_status === 'approved'}
                                disabled={busy === row.id} onClick={() => void decide(row, 'approved')}>
                          Approved
                        </button>
                        <button type="button" className={`cs-btn is-rejected${row.costsheet_status === 'rejected' ? ' is-on' : ''}`}
                                aria-pressed={row.costsheet_status === 'rejected'}
                                disabled={busy === row.id} onClick={() => void decide(row, 'rejected')}>
                          Rejected
                        </button>
                      </div>
                    </td>
                    <td className="crm-nowrap">{dateTime(row.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}
