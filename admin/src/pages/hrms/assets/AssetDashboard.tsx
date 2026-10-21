import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import '../../../styles/assets.css'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { canAdminister, useAuth } from '../../../lib/auth'
import { EmptyState, ErrorNote, Loading, StatTile } from '../../../components/ui'
import { IconCard } from '../../../components/Icons'
import {
  ASSET_STATUS_LABEL,
  RenewForm,
  RenewalPill,
  categoryLabel,
  day,
  dueText,
  errorText,
  rupees,
  type Asset,
  type AssetRenewal,
} from './assetLib'
import { permits } from './Assets'

/** Mirrors `AssetDashboardOut`. */
interface Dashboard {
  total: number
  active: number
  total_value_paise: number
  by_status: Record<string, number>
  by_category: Array<{ key: string; count: number; value_paise: number }>
  assigned: number
  holders: number
  renewals_tracked: number
  renewals_overdue: number
  renewals_due: number
  renewals_upcoming: number
  renewal_cost_due_paise: number
  renewal_cost_90d_paise: number
  warranty_expiring: number
  warranty_expired: number
  attention: Asset[]
  top_holders: Array<{ user_id: string; name: string; email: string | null; count: number; value_paise: number }>
  recent_renewals: AssetRenewal[]
}

const STATUS_COLOR: Record<string, string> = {
  assigned: 'var(--brand)',
  available: 'var(--status-good)',
  under_repair: 'var(--status-warn)',
  retired: 'var(--text-muted)',
}

function TileLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="as-tile-link">
      {children}
    </Link>
  )
}

export default function AssetDashboard() {
  const { user } = useAuth()
  const allowed = canAdminister(user) && permits(user, 'can_manage_assets')
  const dash = useQuery<Dashboard>('assets-dashboard', () => api.get<Dashboard>('/assets/dashboard'), {
    enabled: allowed,
  })
  const [renewing, setRenewing] = useState<Asset | null>(null)

  if (!allowed) {
    return (
      <section className="card">
        <EmptyState
          icon={<IconCard size={22} />}
          title="The asset dashboard is administrator-only"
          body="Open My assets to see what you are holding."
        />
      </section>
    )
  }
  if (dash.error) return <ErrorNote>{errorText(dash.error, 'Could not load the dashboard')}</ErrorNote>
  if (!dash.data) return <Loading />
  const d = dash.data

  const head = (
    <div className="page-head">
      <div>
        <h1 className="page-title">Asset dashboard</h1>
        <p className="page-sub">How many assets you have, who holds them, and what is due for renewal.</p>
      </div>
      <div className="head-actions">
        <Link className="btn" to="/assets/report">
          Assignment report
        </Link>
        <Link className="btn btn-primary" to="/assets?new=1">
          + Add asset
        </Link>
      </div>
    </div>
  )

  if (d.total === 0) {
    return (
      <div>
        {head}
        <section className="card">
          <EmptyState
            icon={<IconCard size={22} />}
            title="No assets yet"
            body="Add laptops, phones, furniture, vehicles, software licences, domains, insurance policies — anything the company owns. Give it a renewal date and it will show up here when it falls due."
            action={
              <Link className="btn btn-primary" to="/assets?new=1">
                Add the first asset
              </Link>
            }
          />
        </section>
      </div>
    )
  }

  const maxCat = Math.max(1, ...d.by_category.map((c) => c.count))
  const maxHolder = Math.max(1, ...d.top_holders.map((h) => h.count))
  const statusOrder = ['assigned', 'available', 'under_repair', 'retired']

  return (
    <div>
      {head}

      <div className="grid grid-tiles" style={{ marginBottom: 14 }}>
        <TileLink to="/assets">
          <StatTile label="Total assets" value={String(d.total)} meta={`${d.active} in use or in stock`} />
        </TileLink>
        <TileLink to="/assets?status=assigned">
          <StatTile
            label="Assigned"
            value={String(d.assigned)}
            meta={`to ${d.holders} ${d.holders === 1 ? 'person' : 'people'}`}
            accent="var(--brand)"
          />
        </TileLink>
        <TileLink to="/assets?status=available">
          <StatTile label="Available" value={String(d.by_status.available ?? 0)} accent="var(--status-good)" />
        </TileLink>
        <TileLink to="/assets?status=under_repair">
          <StatTile
            label="Under repair"
            value={String(d.by_status.under_repair ?? 0)}
            accent={d.by_status.under_repair ? 'var(--status-warn)' : undefined}
          />
        </TileLink>
        <StatTile label="Asset value" value={rupees(d.total_value_paise)} meta="purchase cost, excl. retired" />
      </div>

      <div className="grid grid-tiles" style={{ marginBottom: 14 }}>
        <TileLink to="/assets/renewals?state=overdue">
          <StatTile
            label="Renewal overdue"
            value={String(d.renewals_overdue)}
            meta={d.renewals_overdue ? 'past the due date' : 'nothing overdue'}
            accent={d.renewals_overdue ? 'var(--status-bad)' : undefined}
          />
        </TileLink>
        <TileLink to="/assets/renewals?state=due">
          <StatTile
            label="Renewal due soon"
            value={String(d.renewals_due)}
            meta="inside the reminder window"
            accent={d.renewals_due ? 'var(--status-warn)' : undefined}
          />
        </TileLink>
        <TileLink to="/assets/renewals?state=upcoming">
          <StatTile label="Upcoming (90 days)" value={String(d.renewals_upcoming)} meta={`${d.renewals_tracked} tracked in all`} />
        </TileLink>
        <StatTile
          label="Renewal cost due now"
          value={rupees(d.renewal_cost_due_paise)}
          meta={`${rupees(d.renewal_cost_90d_paise)} in next 90 days`}
        />
        <StatTile
          label="Warranty expiring"
          value={String(d.warranty_expiring)}
          meta={`${d.warranty_expired} already expired`}
          accent={d.warranty_expiring ? 'var(--status-warn)' : undefined}
        />
      </div>

      {renewing && (
        <RenewForm
          asset={renewing}
          onCancel={() => setRenewing(null)}
          onDone={() => {
            setRenewing(null)
            dash.reload()
          }}
        />
      )}

      <section className="card" style={{ marginBottom: 14 }}>
        <div className="card-head">
          <h2 className="card-title">Renewals needing attention</h2>
          <div className="card-tools">
            <Link className="btn btn-sm" to="/assets/renewals">
              All renewals
            </Link>
          </div>
        </div>
        {d.attention.length === 0 ? (
          <EmptyState
            icon={<IconCard size={22} />}
            title="Nothing due in the next 90 days"
            body="Assets with a renewal date show up here as they come due."
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Category</th>
                  <th>Due</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Cost</th>
                  <th style={{ textAlign: 'right' }} />
                </tr>
              </thead>
              <tbody>
                {d.attention.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <div className="as-tag">{a.asset_tag}</div>
                      {a.name && <div className="as-name">{a.name}</div>}
                    </td>
                    <td className="as-cat">{categoryLabel(a.category)}</td>
                    <td>
                      {day(a.renewal_date)}
                      <div className="as-when">{dueText(a)}</div>
                    </td>
                    <td>
                      <RenewalPill asset={a} />
                    </td>
                    <td style={{ textAlign: 'right' }}>{rupees(a.renewal_cost_paise)}</td>
                    <td>
                      <div className="as-actions">
                        <button
                          className="btn btn-sm btn-primary"
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
        )}
      </section>

      <div className="grid grid-2" style={{ marginBottom: 14 }}>
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">By status</h2>
          </div>
          <div className="as-split" role="img" aria-label="Assets by status">
            {statusOrder.map((s) =>
              d.by_status[s] ? (
                <span
                  key={s}
                  style={{ width: `${(d.by_status[s] / d.total) * 100}%`, background: STATUS_COLOR[s] }}
                  title={`${ASSET_STATUS_LABEL[s]}: ${d.by_status[s]}`}
                />
              ) : null,
            )}
          </div>
          <div className="as-legend">
            {statusOrder.map((s) => (
              <span key={s}>
                <i style={{ background: STATUS_COLOR[s] }} />
                {ASSET_STATUS_LABEL[s]} {d.by_status[s] ?? 0}
              </span>
            ))}
          </div>

          <h3 className="as-subhead" style={{ marginTop: 22 }}>By category</h3>
          <div className="as-bars">
            {d.by_category.map((c) => (
              <Link key={c.key} to={`/assets?category=${encodeURIComponent(c.key)}`} className="as-bar-row as-tile-link">
                <span className="as-bar-label">{categoryLabel(c.key)}</span>
                <span className="as-bar-value">
                  {c.count}
                  {c.value_paise ? ` · ${rupees(c.value_paise)}` : ''}
                </span>
                <span className="as-bar-track">
                  <span className="as-bar-fill" style={{ width: `${(c.count / maxCat) * 100}%`, display: 'block' }} />
                </span>
              </Link>
            ))}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2 className="card-title">Who has the most assets</h2>
            <div className="card-tools">
              <Link className="btn btn-sm" to="/assets/report">
                Full report
              </Link>
            </div>
          </div>
          {d.top_holders.length === 0 ? (
            <EmptyState icon={<IconCard size={22} />} title="Nothing assigned yet" body="Assign an asset from the register." />
          ) : (
            <div className="as-bars">
              {d.top_holders.map((h) => (
                <div key={h.user_id} className="as-bar-row">
                  <span className="as-bar-label">{h.name}</span>
                  <span className="as-bar-value">
                    {h.count} {h.count === 1 ? 'asset' : 'assets'}
                    {h.value_paise ? ` · ${rupees(h.value_paise)}` : ''}
                  </span>
                  <span className="as-bar-track">
                    <span className="as-bar-fill" style={{ width: `${(h.count / maxHolder) * 100}%`, display: 'block' }} />
                  </span>
                </div>
              ))}
            </div>
          )}

          <h3 className="as-subhead" style={{ marginTop: 22 }}>Recent renewals</h3>
          {d.recent_renewals.length === 0 ? (
            <p className="as-muted" style={{ fontSize: 13 }}>No renewals recorded yet.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <tbody>
                  {d.recent_renewals.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <div className="as-tag">{r.asset_tag}</div>
                        {r.asset_name && <div className="as-name">{r.asset_name}</div>}
                      </td>
                      <td className="as-when">{day(r.renewed_on)}</td>
                      <td className="as-when">→ {r.next_due ? day(r.next_due) : 'stopped'}</td>
                      <td style={{ textAlign: 'right' }}>{rupees(r.cost_paise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
