import '../styles/org.css'
import '../styles/timesheets.css'
import { api } from '../lib/api'
import { useQuery } from '../lib/useQuery'
import { canAdminister, useAuth } from '../lib/auth'
import { dateTime } from '../lib/format'
import { ErrorNote, Loading, Meter, StatTile } from '../components/ui'
import { rupees } from './Projects'

interface Subscription {
  organization: { name: string; slug: string; status: string }
  plan: {
    id: string
    name: string
    features: string[]
    base_price_annual: number
    per_employee_month: number
    max_screenshot_retention_days: number
    max_activity_retention_days: number
    min_screenshot_interval_s: number
  }
  status: string
  billing_cycle: string | null
  period_start: string | null
  period_end: string | null
  days_remaining: number | null
  total_amount: number
  currency: string
  usage: {
    seats_used: number
    seat_limit: number
    seats_available: number
    screenshots: number
    storage_bytes: number
    storage_gb_limit: number
  }
}

const STATUS_TEXT: Record<string, string> = {
  trialing: 'Trial',
  active: 'Active',
  past_due: 'Payment overdue',
  pending_payment: 'Awaiting payment',
  expired: 'Expired',
  canceled: 'Cancelled',
  suspended: 'Suspended',
}

function gb(bytes: number): string {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export default function Billing() {
  const { user } = useAuth()
  const isAdmin = canAdminister(user)
  const { data, error, loading } = useQuery<Subscription>('subscription', () =>
    api.get<Subscription>('/admin/subscription'),
  )

  if (error) return <ErrorNote>{error}</ErrorNote>
  if (loading || !data) return <Loading />

  const { usage, plan } = data
  const seatPct = usage.seat_limit ? Math.round((usage.seats_used / usage.seat_limit) * 100) : 0
  const expiringSoon = data.days_remaining !== null && data.days_remaining <= 14
  const seatsTight = usage.seats_available <= 2

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Subscription &amp; Billing</h1>
          <p className="page-sub">{data.organization.name} · {data.organization.slug}</p>
        </div>
      </div>

      {data.status === 'past_due' && (
        <div className="ts-warn" style={{ marginBottom: 16 }}>
          <b>Payment is overdue.</b> Tracking continues so no data is lost, but dashboard access
          will be restricted if this is not settled.
        </div>
      )}
      {expiringSoon && data.status === 'active' && (
        <div className="notice" style={{ marginBottom: 16 }}>
          This subscription renews in <b>{data.days_remaining} days</b>
          {data.period_end ? ` (${data.period_end.slice(0, 10)})` : ''}.
        </div>
      )}
      {seatsTight && (
        <div className="notice" style={{ marginBottom: 16 }}>
          {usage.seats_available === 0
            ? 'All seats are in use. Adding another employee needs more seats.'
            : `Only ${usage.seats_available} seat${usage.seats_available === 1 ? '' : 's'} left.`}
        </div>
      )}

      <div className="grid grid-tiles" style={{ marginBottom: 14 }}>
        <StatTile label="Plan" value={plan.name} meta={STATUS_TEXT[data.status] ?? data.status} />
        {/* A seat count is a quota, and a quota is easier to judge as a bar than
            as a fraction — "6/25" needs arithmetic, the bar does not. */}
        <StatTile
          label="Seats"
          value={`${usage.seats_used}/${usage.seat_limit}`}
          meta={
            <>
              {seatPct}% used
              <Meter
                value={usage.seats_used}
                max={usage.seat_limit}
                accent={seatsTight ? 'var(--status-critical)' : undefined}
              />
            </>
          }
          accent={seatsTight ? 'var(--status-critical)' : undefined}
        />
        <StatTile
          label="Renews in"
          value={data.days_remaining !== null ? `${data.days_remaining} days` : '—'}
          meta={data.period_end?.slice(0, 10) ?? 'no period set'}
        />
        <StatTile
          label="Current term"
          value={rupees(data.total_amount)}
          meta={data.billing_cycle ? `billed ${data.billing_cycle}, incl. GST` : undefined}
        />
        <StatTile
          label="Storage"
          value={gb(usage.storage_bytes)}
          meta={`${usage.screenshots.toLocaleString('en-IN')} screenshots · ${usage.storage_gb_limit} GB limit`}
        />
      </div>

      <div className="grid grid-2">
        <section className="card">
          <div className="card-head"><h2 className="card-title">What this plan includes</h2></div>
          <ul className="check-list">
            {plan.features.map((feature) => <li key={feature}>{feature}</li>)}
          </ul>
          <table style={{ marginTop: 16 }}>
            <tbody>
              <tr>
                <td>Base price</td>
                <td className="num">{rupees(plan.base_price_annual)} / year</td>
              </tr>
              <tr>
                <td>Per employee</td>
                <td className="num">{rupees(plan.per_employee_month)} / month</td>
              </tr>
              <tr>
                <td>Screenshot retention</td>
                <td className="num">up to {plan.max_screenshot_retention_days} days</td>
              </tr>
              <tr>
                <td>Activity retention</td>
                <td className="num">up to {plan.max_activity_retention_days} days</td>
              </tr>
              <tr>
                <td>Screenshot interval</td>
                <td className="num">as often as {Math.round(plan.min_screenshot_interval_s / 60)} min</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="card">
          <div className="card-head"><h2 className="card-title">Term</h2></div>
          <dl className="kv">
            <div><dt>Status</dt><dd>{STATUS_TEXT[data.status] ?? data.status}</dd></div>
            <div><dt>Billing cycle</dt><dd>{data.billing_cycle ?? '—'}</dd></div>
            <div><dt>Started</dt><dd>{data.period_start ? dateTime(data.period_start) : '—'}</dd></div>
            <div><dt>Renews</dt><dd>{data.period_end ? dateTime(data.period_end) : '—'}</dd></div>
            <div><dt>Amount</dt><dd>{rupees(data.total_amount, true)}</dd></div>
            <div><dt>Seats available</dt><dd>{usage.seats_available}</dd></div>
          </dl>

          <p className="setting-hint" style={{ marginTop: 16 }}>
            {isAdmin
              ? 'Plan and seat changes are handled by support — contact us and the change applies immediately, with the next invoice adjusted.'
              : 'Contact an administrator to change the plan or add seats.'}
          </p>
        </section>
      </div>
    </div>
  )
}
