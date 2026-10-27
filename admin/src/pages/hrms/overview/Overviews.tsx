/* Working Hours — the HRMS module's team summary of hours worked.
 *
 * This file used to hold four module overviews that sat under the Dashboard
 * module. The Dashboard is gone; this one survives because HRMS links to it.
 * It answers what the timesheet list cannot: how the week compares.
 */

import { api } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { ErrorNote, Loading, StatTile } from '../../../components/ui'
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

