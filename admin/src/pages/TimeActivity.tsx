import { useState } from 'react'
import { Link } from 'react-router-dom'
import '../styles/org.css'
import '../styles/timesheets.css'
import { api } from '../lib/api'
import { useQuery } from '../lib/useQuery'
import { clockTime, duration, todayISO } from '../lib/format'
import type { Dashboard as DashboardData } from '../lib/types'
import { ChartCard } from '../components/ChartCard'
import { HourlyChart, HOURLY_LEGEND, RankedBars, TimelineStrip } from '../components/charts'
import { Loading, ErrorNote, OnlineBadge, StatTile } from '../components/ui'
import { ExportButton } from '../components/ExportButton'
import { BreakdownTable } from './Dashboard'
import { DatePresets, type Range } from '../components/DatePresets'

interface EmployeeDayData {
  date: string
  timezone: string
  employee: { full_name: string }
  totals: DashboardData['totals']
  timeline: Array<{
    id: string
    started_at: string
    ended_at: string
    duration_s: number
    active_s: number
    idle_s: number
    app_name: string
    window_title: string
    is_browser: boolean
    browser: string | null
    url_domain: string | null
    url_full: string | null
    productivity: 'productive' | 'unproductive' | 'neutral'
    is_idle: boolean
  }>
  attendance: Array<{
    started_at: string
    ended_at: string | null
    duration_s: number
    end_reason: string | null
  }>
}

/**
 * Time & Activity.
 *
 * The org-wide view answers "what did the company do today"; picking a person
 * switches to their timeline. Both live here rather than in two pages because
 * the drill-down is the normal path, and a separate URL for it would lose the
 * date and filters on the way.
 */
export default function TimeActivity() {
  const [range, setRange] = useState<Range>({ start: todayISO(), end: todayISO(), preset: 'today' })
  const [subject, setSubject] = useState<string>('')

  const dashboard = useQuery<DashboardData>(`activity-overview:${range.end}`, () =>
    api.get<DashboardData>(`/admin/dashboard?day=${range.end}`),
  )

  const day = useQuery<EmployeeDayData>(
    `activity-person:${subject}:${range.end}`,
    () => api.get<EmployeeDayData>(`/admin/employees/${subject}/day?day=${range.end}`),
    { enabled: Boolean(subject) },
  )

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Time &amp; Activity</h1>
          <p className="page-sub">
            Working time, active and idle split, and the timeline of what was on screen.
          </p>
        </div>
        <div className="head-actions">
          <ExportButton
            href={`/admin/reports/export.csv?start=${range.end}&end=${range.end}${
              subject ? `&user_id=${subject}` : ''
            }`}
            filename={`time-activity-${range.end}.csv`}
            label="Export day"
            disabled={!dashboard.data || dashboard.data.totals.tracked_s === 0}
          />
        </div>
      </div>

      <div className="filter-row">
        <DatePresets value={range} onChange={(next) => setRange(next)} singleDay />
        {subject && (
          <button className="btn btn-sm" onClick={() => setSubject('')}>
            ← Back to everyone
          </button>
        )}
      </div>

      {subject ? (
        day.error ? (
          <ErrorNote>{day.error}</ErrorNote>
        ) : day.loading || !day.data ? (
          <Loading />
        ) : (
          <PersonDay data={day.data} />
        )
      ) : dashboard.error ? (
        <ErrorNote>{dashboard.error}</ErrorNote>
      ) : dashboard.loading || !dashboard.data ? (
        <Loading />
      ) : (
        <Overview data={dashboard.data} onPick={setSubject} />
      )}
    </div>
  )
}

function Overview({
  data,
  onPick,
}: {
  data: DashboardData
  onPick: (userId: string) => void
}) {
  const { totals } = data
  return (
    <>
      <div className="grid grid-tiles" style={{ marginBottom: 14 }}>
        <StatTile label="Working time" value={duration(totals.tracked_s)} />
        <StatTile label="Active" value={duration(totals.active_s)} meta={`${totals.efficiency_pct}% of tracked`} />
        <StatTile label="Idle" value={duration(totals.idle_s)} />
        <StatTile label="Productive" value={duration(totals.productive_s)} accent="var(--prod)" />
        <StatTile label="Unproductive" value={duration(totals.unproductive_s)} accent="var(--unprod)" />
      </div>

      <div style={{ marginBottom: 14 }}>
        <ChartCard title="Activity by hour" note={data.date} legend={HOURLY_LEGEND}>
          <HourlyChart data={data.hourly} />
        </ChartCard>
      </div>

      <div className="grid grid-2" style={{ marginBottom: 14 }}>
        <ChartCard
          title="Top applications"
          legend={HOURLY_LEGEND}
          table={<BreakdownTable rows={data.top_apps} head="Application" />}
        >
          <RankedBars items={data.top_apps.slice(0, 8)} />
        </ChartCard>
        <ChartCard
          title="Top websites"
          legend={HOURLY_LEGEND}
          table={<BreakdownTable rows={data.top_domains} head="Domain" />}
        >
          <RankedBars items={data.top_domains.slice(0, 8)} emptyLabel="No browsing recorded" />
        </ChartCard>
      </div>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Employees</h2>
          <span className="card-note">pick someone to see their timeline</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Employee</th><th>Team</th><th>Status</th>
                <th className="num">Working</th><th className="num">Active</th>
                <th className="num">Idle</th><th className="num">Productivity</th>
                <th className="num">First seen</th><th className="num">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {data.employees.map((row) => (
                <tr key={row.user_id}>
                  <td>
                    <button className="link-btn" onClick={() => onPick(row.user_id)}>
                      {row.full_name}
                    </button>
                  </td>
                  <td className="muted-sm">{row.team ?? '—'}</td>
                  <td><OnlineBadge online={row.is_online} /></td>
                  <td className="num">{duration(row.tracked_s)}</td>
                  <td className="num">{duration(row.active_s)}</td>
                  <td className="num">{duration(row.idle_s)}</td>
                  <td className="num">{row.productivity_pct}%</td>
                  <td className="num">{clockTime(row.first_activity, data.timezone)}</td>
                  <td className="num">{clockTime(row.last_activity, data.timezone)}</td>
                </tr>
              ))}
              {data.employees.length === 0 && (
                <tr><td colSpan={9} className="empty">Nobody tracked on this day.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}

function PersonDay({ data }: { data: EmployeeDayData }) {
  const { totals } = data
  return (
    <>
      <div className="page-head" style={{ marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 650 }}>{data.employee.full_name}</h2>
          <p className="page-sub">{data.date} · {data.timezone}</p>
        </div>
      </div>

      <div className="grid grid-tiles" style={{ marginBottom: 14 }}>
        <StatTile label="Working time" value={duration(totals.tracked_s)} />
        <StatTile label="Active" value={duration(totals.active_s)} meta={`${totals.efficiency_pct}% of tracked`} />
        <StatTile label="Idle" value={duration(totals.idle_s)} />
        <StatTile label="Productivity" value={`${totals.productivity_pct}%`} accent="var(--prod)" />
      </div>

      <div style={{ marginBottom: 14 }}>
        <ChartCard
          title="Day timeline"
          note="each block is one focused window"
          legend={[...HOURLY_LEGEND, { label: 'Idle', color: 'var(--gridline)' }]}
        >
          <TimelineStrip segments={data.timeline} />
        </ChartCard>
      </div>

      <section className="card" style={{ marginBottom: 14 }}>
        <div className="card-head">
          <h2 className="card-title">Login / logout</h2>
          <span className="card-note">agent start and stop</span>
        </div>
        {data.attendance.length === 0 ? (
          <p className="empty">The agent did not run on this day.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Started</th><th>Ended</th><th className="num">Duration</th><th>Close</th></tr>
              </thead>
              <tbody>
                {data.attendance.map((row) => (
                  <tr key={row.started_at}>
                    <td>{clockTime(row.started_at, data.timezone)}</td>
                    <td>{row.ended_at ? clockTime(row.ended_at, data.timezone) : 'still running'}</td>
                    <td className="num">{duration(row.duration_s)}</td>
                    <td className="muted-sm">{row.end_reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Usage detail</h2>
          <Link className="btn btn-sm" to="/apps">Open full log</Link>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Start</th><th>Application</th><th>Website / window</th>
                <th className="num">Duration</th><th className="num">Idle</th><th>Class</th>
              </tr>
            </thead>
            <tbody>
              {data.timeline.slice(0, 200).map((row) => (
                <tr key={row.id}>
                  <td>{clockTime(row.started_at, data.timezone)}</td>
                  <td>{row.app_name}</td>
                  <td className="muted-sm" style={{ maxWidth: 340 }}>
                    {row.url_domain ?? row.window_title ?? '—'}
                  </td>
                  <td className="num">{duration(row.duration_s)}</td>
                  <td className="num">{duration(row.idle_s)}</td>
                  <td>
                    {row.is_idle ? <span className="badge">Idle</span> : row.productivity}
                  </td>
                </tr>
              ))}
              {data.timeline.length === 0 && (
                <tr><td colSpan={6} className="empty">No activity recorded.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}
