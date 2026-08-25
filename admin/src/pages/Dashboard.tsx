import { useState } from 'react'
import { Link } from 'react-router-dom'
import '../styles/org.css'
import '../styles/timesheets.css'
import { api } from '../lib/api'
import { useQuery } from '../lib/useQuery'
import { clockTime, duration, hours, todayISO } from '../lib/format'
import type { Dashboard as DashboardData, Department, Team } from '../lib/types'
import { ChartCard } from '../components/ChartCard'
import { HourlyChart, HOURLY_LEGEND, RankedBars } from '../components/charts'
import { DatePresets, type Range } from '../components/DatePresets'
import { Loading, ErrorNote, OnlineBadge, StatTile } from '../components/ui'
import { ExportButton } from '../components/ExportButton'

const PRODUCTIVITY_LEGEND = HOURLY_LEGEND

export default function Dashboard() {
  const [range, setRange] = useState<Range>({
    start: todayISO(),
    end: todayISO(),
    preset: 'today',
  })
  const [teamId, setTeamId] = useState('')
  const [departmentId, setDepartmentId] = useState('')

  const teams = useQuery<Team[]>('teams', () => api.get<Team[]>('/org/teams'))
  const departments = useQuery<Department[]>('departments', () =>
    api.get<Department[]>('/org/departments'),
  )

  const params = new URLSearchParams({ day: range.end })
  if (teamId) params.set('team_id', teamId)
  if (departmentId) params.set('department_id', departmentId)
  const key = params.toString()

  const { data, error, loading, refetching } = useQuery<DashboardData>(
    `dashboard:${key}`,
    () => api.get<DashboardData>(`/admin/dashboard?${key}`),
    { pollMs: 30_000 },
  )

  if (error) return <ErrorNote>{error}</ErrorNote>
  if (loading || !data) return <Loading />

  const { totals } = data
  /* The API says what it actually returned. Guessing "Whole company" from the
     absence of a filter told an employee — who only ever sees themselves — that
     they were looking at the organisation. */
  const scopeLabel =
    departments.data?.find((d) => d.id === departmentId)?.name ??
    teams.data?.find((t) => t.id === teamId)?.name ??
    (data.scope === 'self' ? 'Your activity'
      : data.scope === 'team' ? 'Your team'
      : 'Whole company')
  const isSelf = data.scope === 'self' && !teamId && !departmentId

  return (
    <div className={refetching ? 'refetching' : undefined}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-sub">
            {scopeLabel}
            {!isSelf && ` · ${data.online_count} of ${data.employee_count} online`}
            {' · times in '}
            {data.timezone}
          </p>
        </div>
        <div className="head-actions">
          {/* The day on screen, but per-employee per-day rows. A dashboard is a
              summary and a spreadsheet is not, so the file carries the detail
              behind the tiles rather than a transcript of them. */}
          <ExportButton
            href={`/admin/reports/export.csv?start=${range.end}&end=${range.end}${
              departmentId ? `&department_id=${departmentId}` : ''
            }${teamId ? `&team_id=${teamId}` : ''}`}
            filename={`activity-${range.end}.csv`}
            label="Export day"
            disabled={totals.tracked_s === 0}
          />
        </div>
      </div>

      {/* One filter row above everything it scopes. */}
      <div className="filter-row">
        <DatePresets value={range} onChange={setRange} singleDay />
        <select
          value={departmentId}
          onChange={(e) => { setDepartmentId(e.target.value); setTeamId('') }}
        >
          <option value="">All departments</option>
          {departments.data?.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
        <select value={teamId} onChange={(e) => { setTeamId(e.target.value); setDepartmentId('') }}>
          <option value="">All teams</option>
          {teams.data?.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
        {(teamId || departmentId) && (
          <button className="btn btn-sm" onClick={() => { setTeamId(''); setDepartmentId('') }}>
            Clear
          </button>
        )}
      </div>

      {/* Headcount first: who is here. Then how long they worked. Mixing the
          two in one row makes "6" and "36h" look like the same kind of fact. */}
      <div className="grid grid-tiles" style={{ marginBottom: 14 }}>
        <StatTile label="Employees" value={String(data.employee_count)} meta={`${data.team_count} teams`} />
        <StatTile
          label="Online now"
          value={String(data.online_count)}
          accent={data.online_count > 0 ? 'var(--success-text)' : undefined}
        />
        <StatTile label="Offline" value={String(data.offline_count ?? 0)} />
        <StatTile
          label="Worked today"
          value={String(data.working_count ?? 0)}
          meta="have tracked time"
        />
        <StatTile label="Active projects" value={String(data.project_count ?? 0)} />
      </div>

      <div className="grid grid-tiles" style={{ marginBottom: 14 }}>
        <StatTile label="Total work" value={duration(totals.tracked_s)} meta={`${hours(totals.tracked_s)} h`} />
        <StatTile label="Active" value={duration(totals.active_s)} meta={`${totals.efficiency_pct}% of tracked`} />
        <StatTile label="Idle" value={duration(totals.idle_s)} />
        <StatTile
          label="Productivity"
          value={`${totals.productivity_pct}%`}
          meta={duration(totals.productive_s)}
          accent="var(--prod)"
        />
        <StatTile
          label="Unproductive"
          value={duration(totals.unproductive_s)}
          accent="var(--unprod)"
        />
        <StatTile
          label="Screenshots"
          value={String(data.screenshot_count ?? 0)}
          meta={<Link className="row-link" to="/screenshots">View</Link>}
        />
      </div>

      <div style={{ marginBottom: 14 }}>
        <ChartCard
          title="Activity by hour"
          note={data.date}
          legend={PRODUCTIVITY_LEGEND}
          table={<HourlyTable data={data} />}
        >
          <HourlyChart data={data.hourly} />
        </ChartCard>
      </div>

      <div className="grid grid-2" style={{ marginBottom: 14 }}>
        <ChartCard
          title="Top applications"
          legend={PRODUCTIVITY_LEGEND}
          table={<BreakdownTable rows={data.top_apps} head="Application" />}
        >
          <RankedBars items={data.top_apps.slice(0, 8)} />
        </ChartCard>

        <ChartCard
          title="Top websites"
          legend={PRODUCTIVITY_LEGEND}
          table={<BreakdownTable rows={data.top_domains} head="Domain" />}
        >
          <RankedBars items={data.top_domains.slice(0, 8)} emptyLabel="No browsing recorded" />
        </ChartCard>
      </div>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Employees</h2>
          <Link className="btn btn-sm" to="/activity">Time &amp; Activity</Link>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Employee</th>
                <th>Team</th>
                <th>Status</th>
                <th className="num">Worked</th>
                <th className="num">Active</th>
                <th className="num">Idle</th>
                <th className="num">Productivity</th>
                <th className="num">First seen</th>
                <th className="num">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {data.employees.map((row) => (
                <tr key={row.user_id}>
                  <td>
                    <Link className="row-link" to={`/employees/${row.user_id}`}>
                      {row.full_name}
                    </Link>
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
                <tr>
                  <td colSpan={9} className="empty">
                    {teamId || departmentId
                      ? 'Nobody in that team or department yet.'
                      : 'No employees enrolled yet.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function HourlyTable({ data }: { data: DashboardData }) {
  const rows = data.hourly.filter((bucket) => bucket.active_s > 0)
  if (rows.length === 0) return <p className="empty">No activity recorded</p>
  return (
    <table>
      <thead>
        <tr>
          <th>Hour</th>
          <th className="num">Active</th>
          <th className="num">Productive</th>
          <th className="num">Unproductive</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((bucket) => (
          <tr key={bucket.hour}>
            <td>{String(bucket.hour).padStart(2, '0')}:00</td>
            <td className="num">{duration(bucket.active_s)}</td>
            <td className="num">{duration(bucket.productive_s)}</td>
            <td className="num">{duration(bucket.unproductive_s)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function BreakdownTable({
  rows,
  head,
}: {
  rows: Array<{ label: string; duration_s: number; active_s: number; productivity: string }>
  head: string
}) {
  if (rows.length === 0) return <p className="empty">Nothing recorded</p>
  return (
    <table>
      <thead>
        <tr>
          <th>{head}</th>
          <th>Class</th>
          <th className="num">Total</th>
          <th className="num">Active</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <td>{row.label}</td>
            <td style={{ color: 'var(--text-secondary)' }}>{row.productivity}</td>
            <td className="num">{duration(row.duration_s)}</td>
            <td className="num">{duration(row.active_s)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
