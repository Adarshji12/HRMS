import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { platformApi, rupees, bytes, type PlatformStats, type PlatformHealth } from '../../lib/platformApi'
import { dateTime, relativeTime } from '../../lib/format'
import { IconAlert, IconCheck } from '../../components/Icons'

/**
 * The operator's first screen.
 *
 * Split from Companies deliberately: that page answers "who are my customers",
 * this one answers "is anything broken". They were one page, which meant the
 * commercial numbers and the operational ones competed for the same glance and
 * neither got read.
 *
 * Every figure here is one somebody has had to dig out of the database at least
 * once — not a wall of green dots.
 */

function Tile({
  label, value, meta, tone,
}: { label: string; value: string; meta?: string; tone?: 'warn' | 'bad' | 'good' }) {
  return (
    <div className={`pf-tile${tone ? ` pf-tile-${tone}` : ''}`}>
      <div className="pf-tile-label">{label}</div>
      <div className="pf-tile-value">{value}</div>
      {meta && <div className="pf-tile-meta">{meta}</div>}
    </div>
  )
}

export default function PlatformOverview() {
  const [stats, setStats] = useState<PlatformStats | null>(null)
  const [health, setHealth] = useState<PlatformHealth | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    platformApi.stats().then(setStats).catch((e) => setError(String(e)))
    platformApi.health().then(setHealth).catch(() => setHealth(null))
  }, [])

  if (error) return <div className="pf-error">{error}</div>
  if (!stats) return <p className="pf-muted">Loading…</p>

  const mail = health?.mail
  const alerts = health?.alerts
  const agents = health?.agents

  // The runner is a cron job outside this process; its last write is the only
  // evidence here that it is being invoked at all.
  const alertsStale =
    !alerts?.last_activity_at ||
    Date.now() - new Date(alerts.last_activity_at).getTime() > 36 * 3600 * 1000

  return (
    <div>
      <div className="pf-head">
        <div>
          <h1 className="pf-title">Overview</h1>
          <p className="pf-sub">
            Every customer on this platform, and whether the machinery behind them is
            working.
          </p>
        </div>
        {health && (
          <span className="pf-muted">as of {dateTime(health.generated_at)}</span>
        )}
      </div>

      <h2 className="pf-section">Business</h2>
      <div className="pf-tiles">
        <Tile
          label="Companies" value={String(stats.companies_total)}
          meta={`${stats.companies_active} active · ${stats.companies_trialing} trialing`}
        />
        <Tile
          label="Suspended" value={String(stats.companies_suspended)}
          tone={stats.companies_suspended > 0 ? 'warn' : undefined}
        />
        <Tile
          label="Employees" value={stats.employees_total.toLocaleString('en-IN')}
          meta={`${stats.employees_online} online now`}
        />
        <Tile
          label="Active contract value" value={rupees(stats.revenue_active_paise)}
          meta="sum of active subscriptions"
        />
        <Tile
          label="Expiring in 30 days" value={String(stats.subscriptions_expiring_30d)}
          tone={stats.subscriptions_expiring_30d > 0 ? 'warn' : undefined}
          meta="renewal conversations due"
        />
      </div>

      {health && (
        <>
          <h2 className="pf-section">Operations</h2>
          <div className="pf-tiles">
            <Tile
              label="Alerts sent (7 days)" value={String(alerts?.sent_7d ?? 0)}
              meta={
                alerts?.failed_7d
                  ? `${alerts.failed_7d} failed to deliver`
                  : alerts?.logged_7d
                    ? `${alerts.logged_7d} logged — no mail server`
                    : 'all delivered'
              }
              tone={alerts?.failed_7d ? 'bad' : undefined}
            />
            <Tile
              label="Alert runner"
              value={alertsStale ? 'Not running?' : 'Active'}
              tone={alertsStale ? 'warn' : 'good'}
              meta={
                alerts?.last_activity_at
                  ? `last sent ${relativeTime(alerts.last_activity_at)}`
                  : 'has never sent anything'
              }
            />
            <Tile
              label="Agents reporting"
              value={`${(agents?.devices_total ?? 0) - (agents?.devices_stale_24h ?? 0)}/${agents?.devices_total ?? 0}`}
              meta={`${agents?.devices_stale_24h ?? 0} silent over 24h`}
              tone={agents?.devices_stale_24h ? 'warn' : 'good'}
            />
            <Tile
              label="Screenshot storage"
              value={bytes(health.storage.screenshot_bytes)}
              meta="across every customer"
            />
          </div>

          <div className="pf-card" style={{ marginTop: 18 }}>
            <div className="pf-card-head">
              <h2 className="pf-card-title">Outbound mail</h2>
              <Link to="/platform/mail" className="pf-link">Platform connector →</Link>
            </div>
            <div className="pf-mailrow">
              <span>
                {mail?.platform_configured ? <IconCheck size={15} /> : <IconAlert size={15} />}
                {' '}
                <b>
                  {mail?.platform_configured
                    ? 'Platform connector configured'
                    : 'No platform connector'}
                </b>
                {' — '}
                {mail?.platform_configured
                  ? 'used by any workspace that has not set its own.'
                  : 'workspaces without their own connector cannot send anything.'}
              </span>
            </div>
            <dl className="pf-kv">
              <div><dt>Sending from their own server</dt><dd>{mail?.own_connector ?? 0}</dd></div>
              <div><dt>Using the platform connector</dt><dd>{mail?.using_platform ?? 0}</dd></div>
              <div>
                <dt>No mail at all</dt>
                <dd className={mail?.none ? 'pf-bad' : undefined}>{mail?.none ?? 0}</dd>
              </div>
            </dl>
          </div>

          {(agents?.versions.length ?? 0) > 0 && (
            <div className="pf-card" style={{ marginTop: 14 }}>
              <div className="pf-card-head">
                <h2 className="pf-card-title">Agent versions in the field</h2>
                <span className="pf-muted">a version nobody upgrades is a support queue</span>
              </div>
              <dl className="pf-kv">
                {agents!.versions.map((v) => (
                  <div key={v.version}>
                    <dt>{v.version}</dt>
                    <dd>{v.devices} device{v.devices === 1 ? '' : 's'}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </>
      )}
    </div>
  )
}
