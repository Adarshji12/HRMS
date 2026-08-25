import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { ErrorNote } from '../../components/ui'
import {
  platformApi,
  rupees,
  type CompanyRow,
  type PlatformStats,
} from '../../lib/platformApi'
import NewCompany from './NewCompany'

const STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'pending_setup', label: 'Pending setup' },
  { value: 'suspended', label: 'Suspended' },
]

export default function PlatformCompanies() {
  const [stats, setStats] = useState<PlatformStats | null>(null)
  const [rows, setRows] = useState<CompanyRow[]>([])
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [planFilter, setPlanFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  // tick forces the list effect to re-run after a company is provisioned.
  const [tick, setTick] = useState(0)
  // A company page that deletes its own subject navigates here and hands the
  // outcome over in route state — the page that could have reported it no
  // longer exists.
  const deletedNotice = (useLocation().state as { notice?: string } | null)?.notice
  // Refreshes the list but deliberately leaves the form mounted: it is showing
  // the new owner's password, which exists in readable form exactly once.
  // Closing the panel here threw it away before anyone could copy it.
  const reload = () => setTick((n) => n + 1)

  useEffect(() => {
    platformApi.stats().then(setStats).catch(() => setStats(null))
  }, [tick])

  // Debounced so typing a company name is one request, not one per keystroke.
  useEffect(() => {
    const id = window.setTimeout(() => {
      setLoading(true)
      platformApi
        .companies({ q: search, status: statusFilter, plan: planFilter })
        .then((data) => {
          setRows(data)
          setError(null)
        })
        .catch((err) => setError(err instanceof Error ? err.message : 'Could not load companies'))
        .finally(() => setLoading(false))
    }, 300)
    return () => window.clearTimeout(id)
  }, [search, statusFilter, planFilter, tick])

  const plans = useMemo(
    () => Array.from(new Set(rows.map((r) => r.plan_id))).sort(),
    [rows],
  )

  return (
    <div>
      <div className="pf-head">
        <div>
          <h1 className="pf-title">Companies</h1>
          <p className="pf-sub">Every customer on the platform.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : 'Add company'}
        </button>
      </div>

      {deletedNotice && <div className="pf-notice">{deletedNotice}</div>}

      {/* Reloads the list on success, so a company provisioned here appears
          without the operator wondering whether it worked. */}
      {adding && <NewCompany onCreated={reload} onClose={() => setAdding(false)} />}

      {stats && (
        <div className="pf-tiles">
          <Tile label="Companies" value={String(stats.companies_total)}
                meta={`${stats.companies_active} active · ${stats.companies_trialing} trialing`} />
          <Tile label="Suspended" value={String(stats.companies_suspended)}
                tone={stats.companies_suspended > 0 ? 'warn' : undefined} />
          <Tile label="Employees" value={stats.employees_total.toLocaleString('en-IN')}
                meta={`${stats.employees_online} online now`} />
          <Tile label="Active contract value" value={rupees(stats.revenue_active_paise)}
                meta="sum of active subscriptions" />
          <Tile label="Expiring in 30 days" value={String(stats.subscriptions_expiring_30d)}
                tone={stats.subscriptions_expiring_30d > 0 ? 'warn' : undefined}
                meta="renewals to chase" />
        </div>
      )}

      <div className="pf-filters">
        <input
          type="search"
          placeholder="Search name, subdomain or billing email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ minWidth: 280, flex: 1 }}
        />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          {STATUS_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>{f.label}</option>
          ))}
        </select>
        <select value={planFilter} onChange={(e) => setPlanFilter(e.target.value)}>
          <option value="">All plans</option>
          {plans.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="pf-card">
        <div className="table-wrap">
          <table className="pf-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Admin</th>
                <th>Plan</th>
                <th>Subscription</th>
                <th className="num">Seats</th>
                <th className="num">Online</th>
                <th>Renews</th>
                <th>Payment</th>
                <th>Account</th>
              </tr>
            </thead>
            <tbody className={loading ? 'refetching' : undefined}>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link className="pf-link" to={`/platform/companies/${row.id}`}>
                      {row.name}
                    </Link>
                    <div className="pf-muted">{row.slug}</div>
                  </td>
                  <td>
                    {row.admin_name ?? '—'}
                    <div className="pf-muted">{row.admin_email ?? row.contact_email ?? ''}</div>
                  </td>
                  <td>{row.plan_name}</td>
                  <td><StatusPill value={row.subscription_status} /></td>
                  <td className="num">
                    <SeatBar used={row.seats_used} limit={row.seat_limit} />
                  </td>
                  <td className="num">{row.employees_online}</td>
                  <td>
                    {row.period_end ? (
                      <>
                        {row.period_end.slice(0, 10)}
                        <div className={`pf-muted ${(row.days_remaining ?? 99) <= 14 ? 'pf-danger' : ''}`}>
                          {row.days_remaining !== null ? `${row.days_remaining} days left` : ''}
                        </div>
                      </>
                    ) : '—'}
                  </td>
                  <td><StatusPill value={row.payment_status} /></td>
                  <td><StatusPill value={row.status} /></td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="pf-empty">No companies match those filters.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function Tile({
  label,
  value,
  meta,
  tone,
}: {
  label: string
  value: string
  meta?: string
  tone?: 'warn'
}) {
  return (
    <div className={`pf-tile ${tone === 'warn' ? 'pf-tile-warn' : ''}`}>
      <div className="pf-tile-label">{label}</div>
      <div className="pf-tile-value">{value}</div>
      {meta && <div className="pf-tile-meta">{meta}</div>}
    </div>
  )
}

/** Status is carried by a label, not a colour alone — these gate real money. */
export function StatusPill({ value }: { value: string }) {
  const tone =
    value === 'active' || value === 'paid'
      ? 'ok'
      : value === 'suspended' || value === 'expired' || value === 'failed' || value === 'canceled'
        ? 'bad'
        : value === 'past_due' || value === 'pending_payment' || value === 'pending_setup'
          ? 'warn'
          : 'neutral'
  return <span className={`pf-pill pf-pill-${tone}`}>{value.replace(/_/g, ' ')}</span>
}

export function SeatBar({ used, limit }: { used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0
  const tight = limit > 0 && used / limit >= 0.9
  return (
    <span className="pf-seats" title={`${used} of ${limit} seats in use`}>
      <span className="pf-seats-text">
        {used}/{limit}
      </span>
      <span className="pf-seats-track">
        <span
          className={`pf-seats-fill ${tight ? 'pf-seats-tight' : ''}`}
          style={{ width: `${Math.max(3, pct)}%` }}
        />
      </span>
    </span>
  )
}
