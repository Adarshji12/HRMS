import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import '../../../styles/assets.css'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { canAdminister, useAuth } from '../../../lib/auth'
import { EmptyState, ErrorNote, Loading } from '../../../components/ui'
import { IconCard, IconDownload } from '../../../components/Icons'
import {
  CYCLE_LABEL,
  RENEWAL_STATE_LABEL,
  RenewForm,
  RenewalPill,
  categoryLabel,
  day,
  downloadCsv,
  dueText,
  errorText,
  rupees,
  todayISODate,
  type Asset,
  type AssetRenewal,
  type RenewalState,
} from './assetLib'
import { permits } from './Assets'

const STATES: Array<RenewalState | 'all'> = ['overdue', 'due', 'upcoming', 'ok', 'all']

export default function AssetRenewals() {
  const { user } = useAuth()
  const allowed = canAdminister(user) && permits(user, 'can_manage_assets')
  const [params, setParams] = useSearchParams()
  const state = (params.get('state') as RenewalState | 'all' | null) ?? 'all'
  const [tab, setTab] = useState<'schedule' | 'history'>('schedule')
  const [renewing, setRenewing] = useState<Asset | null>(null)

  const assets = useQuery<Asset[]>('assets', () => api.get<Asset[]>('/assets'), { enabled: allowed })
  const history = useQuery<AssetRenewal[]>('asset-renewals', () => api.get<AssetRenewal[]>('/assets/renewals'), {
    enabled: allowed,
  })

  const tracked = useMemo(
    () =>
      (assets.data ?? [])
        .filter((a) => a.renewal_state !== 'none')
        .sort((a, b) => (a.renewal_date ?? '').localeCompare(b.renewal_date ?? '')),
    [assets.data],
  )
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: tracked.length }
    for (const a of tracked) c[a.renewal_state] = (c[a.renewal_state] ?? 0) + 1
    return c
  }, [tracked])
  const rows = state === 'all' ? tracked : tracked.filter((a) => a.renewal_state === state)
  const totalCost = rows.reduce((sum, a) => sum + (a.renewal_cost_paise ?? 0), 0)

  if (!allowed) {
    return (
      <section className="card">
        <EmptyState icon={<IconCard size={22} />} title="Renewals are administrator-only" body="" />
      </section>
    )
  }
  if (assets.error) return <ErrorNote>{errorText(assets.error, 'Could not load renewals')}</ErrorNote>

  function exportSchedule() {
    downloadCsv(
      `asset-renewals-${todayISODate()}.csv`,
      ['Asset tag', 'Name', 'Category', 'Vendor', 'Due date', 'Days left', 'Status', 'Cycle', 'Cost (₹)', 'Auto-renew', 'Assigned to'],
      rows.map((a) => [
        a.asset_tag,
        a.name,
        categoryLabel(a.category),
        a.vendor,
        a.renewal_date,
        a.days_to_renewal,
        RENEWAL_STATE_LABEL[a.renewal_state],
        CYCLE_LABEL[a.renewal_cycle] ?? a.renewal_cycle,
        a.renewal_cost_paise == null ? null : a.renewal_cost_paise / 100,
        a.auto_renew ? 'Yes' : 'No',
        a.current_holder_name,
      ]),
    )
  }

  function exportHistory() {
    downloadCsv(
      `asset-renewal-history-${todayISODate()}.csv`,
      ['Asset tag', 'Name', 'Renewed on', 'Previous due', 'Next due', 'Cost (₹)', 'Reference', 'Note', 'Recorded by'],
      (history.data ?? []).map((r) => [
        r.asset_tag,
        r.asset_name,
        r.renewed_on,
        r.previous_due,
        r.next_due,
        r.cost_paise == null ? null : r.cost_paise / 100,
        r.reference,
        r.note,
        r.renewed_by_name,
      ]),
    )
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Renewals</h1>
          <p className="page-sub">
            Licences, subscriptions, domains, insurance, AMCs — everything with a renewal date, most
            urgent first.
          </p>
        </div>
        <div className="head-actions">
          <button
            className="btn"
            onClick={tab === 'schedule' ? exportSchedule : exportHistory}
            disabled={tab === 'schedule' ? rows.length === 0 : (history.data ?? []).length === 0}
          >
            <IconDownload size={14} /> Export
          </button>
        </div>
      </div>

      <div className="filter-row">
        <div className="btn-group">
          <button className={`btn btn-sm${tab === 'schedule' ? ' btn-primary' : ''}`} onClick={() => setTab('schedule')}>
            Renewal schedule
          </button>
          <button className={`btn btn-sm${tab === 'history' ? ' btn-primary' : ''}`} onClick={() => setTab('history')}>
            Renewal history
          </button>
        </div>
        {tab === 'schedule' && (
          <div className="btn-group">
            {STATES.map((s) => (
              <button
                key={s}
                className={`btn btn-sm${state === s ? ' btn-primary' : ''}`}
                onClick={() => setParams(s === 'all' ? {} : { state: s }, { replace: true })}
              >
                {s === 'all' ? 'All tracked' : RENEWAL_STATE_LABEL[s]} ({counts[s] ?? 0})
              </button>
            ))}
          </div>
        )}
      </div>

      {renewing && (
        <RenewForm
          asset={renewing}
          onCancel={() => setRenewing(null)}
          onDone={() => {
            setRenewing(null)
            assets.reload()
            history.reload()
          }}
        />
      )}

      {tab === 'schedule' ? (
        <section className="card">
          {assets.loading && !assets.data ? (
            <Loading />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<IconCard size={22} />}
              title={tracked.length === 0 ? 'No asset is tracked for renewal yet' : 'Nothing in this bucket'}
              body={
                tracked.length === 0
                  ? 'Edit an asset and tick “This asset needs renewal” to give it a renewal date.'
                  : 'Pick another filter above.'
              }
              action={
                tracked.length === 0 ? (
                  <Link className="btn btn-primary" to="/assets?new=1">
                    Add an asset
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Asset</th>
                      <th>Category</th>
                      <th>Vendor</th>
                      <th>Due date</th>
                      <th>Status</th>
                      <th>Cycle</th>
                      <th style={{ textAlign: 'right' }}>Cost</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((a) => (
                      <tr key={a.id}>
                        <td>
                          <div className="as-tag">{a.asset_tag}</div>
                          {a.name && <div className="as-name">{a.name}</div>}
                        </td>
                        <td className="as-cat">{categoryLabel(a.category)}</td>
                        <td>{a.vendor ?? <span className="as-muted">—</span>}</td>
                        <td>
                          {day(a.renewal_date)}
                          <div className="as-when">{dueText(a)}</div>
                        </td>
                        <td>
                          <RenewalPill asset={a} />
                        </td>
                        <td className="as-when">
                          {CYCLE_LABEL[a.renewal_cycle] ?? a.renewal_cycle}
                          {a.auto_renew ? ' · auto' : ''}
                        </td>
                        <td style={{ textAlign: 'right' }}>{rupees(a.renewal_cost_paise)}</td>
                        <td>
                          <div className="as-actions">
                            <button
                              className={`btn btn-sm${a.renewal_state === 'overdue' || a.renewal_state === 'due' ? ' btn-primary' : ''}`}
                              onClick={() => {
                                setRenewing(a)
                                window.scrollTo({ top: 0, behavior: 'smooth' })
                              }}
                            >
                              Renew
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="as-group-meta" style={{ marginTop: 10 }}>
                {rows.length} {rows.length === 1 ? 'asset' : 'assets'} · total renewal cost {rupees(totalCost)}
              </p>
            </>
          )}
        </section>
      ) : (
        <section className="card">
          {history.loading && !history.data ? (
            <Loading />
          ) : (history.data ?? []).length === 0 ? (
            <EmptyState icon={<IconCard size={22} />} title="No renewals recorded yet" body="Every renewal you record shows up here." />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Renewed on</th>
                    <th>Due moved</th>
                    <th style={{ textAlign: 'right' }}>Paid</th>
                    <th>Reference</th>
                    <th>Recorded by</th>
                  </tr>
                </thead>
                <tbody>
                  {(history.data ?? []).map((r) => (
                    <tr key={r.id}>
                      <td>
                        <div className="as-tag">{r.asset_tag}</div>
                        {r.asset_name && <div className="as-name">{r.asset_name}</div>}
                      </td>
                      <td>{day(r.renewed_on)}</td>
                      <td className="as-when">
                        {day(r.previous_due)} → {r.next_due ? day(r.next_due) : 'stopped'}
                      </td>
                      <td style={{ textAlign: 'right' }}>{rupees(r.cost_paise)}</td>
                      <td>{[r.reference, r.note].filter(Boolean).join(' — ') || <span className="as-muted">—</span>}</td>
                      <td>{r.renewed_by_name ?? <span className="as-muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
