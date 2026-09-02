/* Module overviews: the first tab of a module, answering "what is the state of
 * this, right now" before you go looking at rows.
 *
 * Four of them, and deliberately only four. Time & Work, Attendance, Leave and
 * Expenses have real summary data behind them today; the other seven modules
 * would need new backend aggregation, and an overview built on figures nobody
 * computes is a screen of zeros that teaches people to ignore the tab.
 *
 * Each one is small on purpose. An overview that repeats the module's own list
 * page has cost a click and given nothing back — so these answer questions the
 * list cannot: how does today compare, what is stuck, what is outstanding.
 */

import { Link } from 'react-router-dom'
import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { ErrorNote, Loading, StatTile, EmptyState } from '../../../components/ui'
import { IconCard, IconCheck, IconReturn } from '../../../components/Icons'
import { hm } from '../attendance/MyAttendance'
import '../../../styles/overview.css'

/* --------------------------------------------------------------- helpers -- */

/** Today in the browser's locale, as the ISO date the API expects. */
function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Paise → "₹1,23,456". The wire is integer paise everywhere (D-012). */
function rupees(paise: number): string {
  return '₹' + Math.round(paise / 100).toLocaleString('en-IN')
}

function Head({ title, sub }: { title: string; sub: string }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        <p>{sub}</p>
      </div>
    </header>
  )
}

/* ------------------------------------------------------------ Time & Work -- */

interface RangeSummary {
  totals: { tracked_s: number; active_s: number; productivity_pct: number; efficiency_pct: number }
  daily: Array<{ date: string; tracked_s: number; active_s: number }>
  top_apps: Array<{ label: string; duration_s: number }>
}

export function TimeOverview() {
  /* One request, not seven.
   *
   * The first version asked /admin/dashboard once per day for a week, because
   * that endpoint was the one already in use. Seven heavy aggregations in
   * parallel meant the page sat on its spinner long after the others had
   * finished — it was still loading when the screenshot was taken.
   * /admin/reports/summary answers the whole range in a single call, and
   * returns the per-day rows the bar row needs anyway.
   *
   * Nothing here duplicates the Company tab: that one answers "what is
   * happening now" (online, today's totals), this one answers "how did the
   * week go". Two tabs showing the same numbers would be a reason to delete
   * one of them. */
  const end = today()
  const start = daysAgo(6)
  const q = useQuery<RangeSummary>(`ov-time:${start}`, () =>
    api.get<RangeSummary>(`/admin/reports/summary?start=${start}&end=${end}`),
  )
  const sub = 'The last seven days at a glance.'

  if (q.error) return <><Head title="Time & Work" sub={sub} /><ErrorNote>{q.error}</ErrorNote></>
  if (q.loading || !q.data) return <><Head title="Time & Work" sub={sub} /><Loading /></>

  const { totals, daily, top_apps } = q.data
  const peak = Math.max(1, ...daily.map((d) => d.tracked_s))
  const worked = daily.filter((d) => d.tracked_s > 0).length

  return (
    <>
      <Head title="Time & Work" sub={sub} />
      <div className="grid grid-tiles ov-tiles">
        <StatTile label="Tracked this week" value={hm(Math.round(totals.tracked_s / 60))}
          meta={`${worked} of ${daily.length} days had activity`} />
        <StatTile label="Active" value={hm(Math.round(totals.active_s / 60))}
          meta={totals.tracked_s ? `${Math.round((totals.active_s / totals.tracked_s) * 100)}% of tracked` : 'nothing tracked'} />
        <StatTile label="Productivity" value={`${totals.productivity_pct.toFixed(1)}%`} accent="var(--prod)"
          meta="of tracked time" />
        <StatTile label="Efficiency" value={`${totals.efficiency_pct.toFixed(1)}%`}
          meta="active against tracked" />
      </div>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Tracked per day</h2>
          <span className="card-note">Oldest on the left</span>
        </div>
        {/* Bars, not the chart component: seven values against one shared
            maximum is a shape the eye compares directly, and it needs no axis. */}
        <div className="ov-spark">
          {daily.map((d) => (
            <div className="ov-spark-day" key={d.date}>
              <div className="ov-spark-bar"
                   style={{ height: `${Math.max(3, (d.tracked_s / peak) * 100)}%` }}
                   title={`${d.date} — ${hm(Math.round(d.tracked_s / 60))}`} />
              <span className="ov-spark-label">{d.date.slice(5)}</span>
            </div>
          ))}
        </div>
      </section>

      {top_apps.length > 0 && (
        <section className="card" style={{ marginTop: 14 }}>
          <div className="card-head">
            <h2 className="card-title">Top applications</h2>
            <span className="card-note">Across the week</span>
          </div>
          <ul className="ov-list">
            {top_apps.slice(0, 6).map((a) => (
              <li key={a.label}><span>{a.label}</span><b>{hm(Math.round(a.duration_s / 60))}</b></li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

/* ------------------------------------------------------------- Attendance -- */

interface DayRow {
  date: string
  status: string
  check_in_at: string | null
  check_out_at: string | null
  is_late: boolean
  is_missing_punch: boolean
  user_name: string | null
}

export function AttendanceOverview() {
  const day = today()
  const q = useQuery<DayRow[]>(`ov-att:${day}`, () =>
    api.get<DayRow[]>(`/attendance/team?start=${day}&end=${day}`),
  )
  const sub = 'Who is in today, and what needs a correction.'

  if (q.error) return <><Head title="Attendance" sub={sub} /><ErrorNote>{q.error}</ErrorNote></>
  if (q.loading || !q.data) return <><Head title="Attendance" sub={sub} /><Loading /></>

  const rows = q.data
  const count = (s: string) => rows.filter((r) => r.status === s).length
  const late = rows.filter((r) => r.is_late)
  const missing = rows.filter((r) => r.is_missing_punch)

  return (
    <>
      <Head title="Attendance" sub={sub} />
      <div className="grid grid-tiles ov-tiles">
        <StatTile label="Present" value={String(count('present'))} accent="var(--status-good)" />
        <StatTile label="Absent" value={String(count('absent'))}
          accent={count('absent') ? 'var(--status-critical)' : undefined} />
        <StatTile label="On leave" value={String(count('on_leave'))} />
        <StatTile label="Late in" value={String(late.length)}
          accent={late.length ? 'var(--status-warn)' : undefined} />
        {/* The one figure here that is a task rather than a statistic — every
            missing punch is somebody who will need a regularisation. */}
        <StatTile label="Missing a punch" value={String(missing.length)}
          accent={missing.length ? 'var(--status-warn)' : undefined}
          meta={missing.length ? <Link className="row-link" to="/attendance/team">Review</Link> : 'nothing to fix'} />
      </div>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Needs attention</h2>
          <span className="card-note">Today</span>
        </div>
        {late.length + missing.length === 0 ? (
          <EmptyState icon={<IconCheck size={22} />} title="Nothing outstanding"
            body="Nobody is late and every open day has both punches. Corrections raised later will appear in the approvals inbox." />
        ) : (
          <ul className="ov-list">
            {missing.map((r, i) => (
              <li key={`m${i}`}>
                <span>{r.user_name ?? 'Someone'}</span>
                <span className="badge badge-warning"><span className="badge-dot" style={{ background: 'var(--status-warn)' }} />No check-out</span>
              </li>
            ))}
            {late.map((r, i) => (
              <li key={`l${i}`}>
                <span>{r.user_name ?? 'Someone'}</span>
                <span className="badge badge-warning"><span className="badge-dot" style={{ background: 'var(--status-warn)' }} />Late in</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}

/* ------------------------------------------------------------------ Leave -- */

interface Balance {
  leave_type_name: string
  balance_days: number
  used_days: number
  pending_days: number
}

export function LeaveOverview() {
  const q = useQuery<Balance[]>('ov-leave', () => api.get<Balance[]>('/leave/balances'))
  const sub = 'Your balances, and what is still awaiting a decision.'

  if (q.error) return <><Head title="Leave" sub={sub} /><ErrorNote>{q.error}</ErrorNote></>
  if (q.loading || !q.data) return <><Head title="Leave" sub={sub} /><Loading /></>

  const rows = q.data
  const total = rows.reduce((n, r) => n + r.balance_days, 0)
  const pending = rows.reduce((n, r) => n + r.pending_days, 0)
  const used = rows.reduce((n, r) => n + r.used_days, 0)

  return (
    <>
      <Head title="Leave" sub={sub} />
      <div className="grid grid-tiles ov-tiles">
        <StatTile label="Available" value={String(total)} meta="days across every type" />
        {/* Shown separately from the balance rather than deducted from it: the
            figure you can actually apply for is balance minus pending, and
            hiding that distinction is how people over-apply. */}
        <StatTile label="Awaiting a decision" value={String(pending)}
          accent={pending ? 'var(--status-warn)' : undefined}
          meta={pending ? 'already counted against your balance' : 'nothing pending'} />
        <StatTile label="Taken this year" value={String(used)} meta="days" />
      </div>

      <section className="card">
        <div className="card-head"><h2 className="card-title">By leave type</h2></div>
        {rows.length === 0 ? (
          <EmptyState icon={<IconReturn size={22} />} title="No leave types"
            body="An administrator sets these up in Settings → Leave before anybody can apply." />
        ) : (
          <ul className="ov-list">
            {rows.map((r) => (
              <li key={r.leave_type_name}>
                <span>{r.leave_type_name}</span>
                <b>{r.balance_days} <span className="ov-unit">days</span></b>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}

/* --------------------------------------------------------------- Expenses -- */

interface ExpenseSummary {
  by_status: Record<string, { count: number; amount: number }>
  outstanding_amount: number
  outstanding_count: number
  awaiting_review: number
}

export function ExpenseOverview() {
  const q = useQuery<ExpenseSummary>('ov-exp', () => api.get<ExpenseSummary>('/expenses/summary'))
  const sub = 'What is owed to you, and what is still in review.'

  if (q.error) return <><Head title="Expenses & Loans" sub={sub} /><ErrorNote>{q.error}</ErrorNote></>
  if (q.loading || !q.data) return <><Head title="Expenses & Loans" sub={sub} /><Loading /></>

  const s = q.data
  const statuses = Object.entries(s.by_status)

  return (
    <>
      <Head title="Expenses & Loans" sub={sub} />
      <div className="grid grid-tiles ov-tiles">
        <StatTile label="Owed to you" value={rupees(s.outstanding_amount)}
          meta={`${s.outstanding_count} approved, awaiting payment`} />
        <StatTile label="Awaiting review" value={String(s.awaiting_review)}
          accent={s.awaiting_review ? 'var(--status-warn)' : undefined}
          meta={s.awaiting_review ? <Link className="row-link" to="/expenses">Open claims</Link> : 'nothing in review'} />
        <StatTile label="Claim statuses" value={String(statuses.length)} meta="distinct states on record" />
      </div>

      <section className="card">
        <div className="card-head"><h2 className="card-title">Claims by status</h2></div>
        {statuses.length === 0 ? (
          <EmptyState icon={<IconCard size={22} />} title="No claims yet"
            body="Submitted claims appear here grouped by where they have reached." />
        ) : (
          <ul className="ov-list">
            {statuses.map(([name, v]) => (
              <li key={name}>
                <span className="ov-cap">{name.replace(/_/g, ' ')}</span>
                <b>{rupees(v.amount)} <span className="ov-unit">· {v.count}</span></b>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}
