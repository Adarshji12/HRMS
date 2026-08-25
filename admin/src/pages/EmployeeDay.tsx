import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../lib/api'
import { canAdminister, useAuth } from '../lib/auth'
import { useQuery } from '../lib/useQuery'
import { clockTime, dateTime, duration, relativeTime, todayISO } from '../lib/format'
import type {
  Breakdown,
  DailyPoint,
  Device,
  EmployeeDay as DayData,
  Totals,
  User,
} from '../lib/types'
import { ChartCard } from '../components/ChartCard'
import {
  DailyBars,
  HourlyChart,
  HOURLY_LEGEND,
  RankedBars,
  TimelineStrip,
} from '../components/charts'
import { DatePresets, resolvePreset, type Range } from '../components/DatePresets'
import EmployeeEdit from '../components/EmployeeEdit'
import { ExportButton } from '../components/ExportButton'
import { BreakdownTable } from './Dashboard'
import { Loading, ErrorNote, ProductivityBadge, StatTile } from '../components/ui'

interface RangeData {
  start: string
  end: string
  timezone: string
  employee: User
  totals: Totals
  days_in_range: number
  days_worked: number
  avg_tracked_s: number
  screenshot_count: number
  daily: DailyPoint[]
  attendance: Array<{
    started_at: string
    ended_at: string | null
    duration_s: number
    end_reason: string | null
  }>
  top_apps: Breakdown[]
  top_domains: Breakdown[]
}

export default function EmployeeDay() {
  const { userId = '' } = useParams()
  const { user } = useAuth()
  const [editing, setEditing] = useState(false)
  const [range, setRange] = useState<Range>(() => resolvePreset('today', {
    start: todayISO(), end: todayISO(), preset: 'today',
  }))

  // One day means the day view; anything wider means the range view. Deciding
  // from the dates rather than a separate mode switch keeps it to one control:
  // picking "This week" is already an unambiguous request for the other shape.
  const single = range.start === range.end

  const dayQuery = useQuery<DayData>(
    `employee:${userId}:${range.end}`,
    () => api.get<DayData>(`/admin/employees/${userId}/day?day=${range.end}`),
    { pollMs: 60_000, enabled: single },
  )
  const rangeQuery = useQuery<RangeData>(
    `employee-range:${userId}:${range.start}:${range.end}`,
    () =>
      api.get<RangeData>(
        `/admin/employees/${userId}/range?start=${range.start}&end=${range.end}`,
      ),
    { enabled: !single },
  )

  const devices = useQuery<Device[]>(`devices:${userId}`, () =>
    api.get<Device[]>(`/admin/employees/${userId}/devices`),
  )

  const active = single ? dayQuery : rangeQuery
  if (active.error) return <ErrorNote>{active.error}</ErrorNote>
  if (active.loading || !active.data) return <Loading />

  // Both payloads carry the same employee, timezone and totals, so the header
  // and the tiles are written once rather than duplicated per branch.
  const head = active.data as DayData | RangeData
  const totals = head.totals
  const employee = head.employee
  const refetching = active.refetching

  return (
    <div className={refetching ? 'refetching' : undefined}>
      <div className="page-head">
        <div>
          <h1 className="page-title">{employee.full_name}</h1>
          <p className="page-sub">
            {employee.email} ·{' '}
            {[employee.designation_name, employee.team_name, employee.department_name]
              .filter(Boolean)
              .join(' · ') || 'Unassigned'}{' '}
            · times in {head.timezone}
          </p>
        </div>
        <div className="btn-group">
          {/* The API has accepted these edits since the permissions work
              landed; there was simply no form, so changing a role or resetting
              a forgotten password meant an API call by hand. */}
          {canAdminister(user) && (
            <button className="btn" onClick={() => setEditing(true)}>
              Edit employee
            </button>
          )}
          <Link className="btn" to="/employees">
            All employees
          </Link>
        </div>
      </div>

      <div className="filter-row">
        <DatePresets value={range} onChange={setRange} />
        <Link
          className="btn btn-sm"
          to={
            single
              ? `/screenshots?user=${userId}&day=${range.end}`
              : `/screenshots?user=${userId}&from=${range.start}&to=${range.end}`
          }
        >
          {head.screenshot_count} screenshots
        </Link>
        {/* Scoped to this one person and this exact range. The report export
            used to ignore both and hand back everyone the viewer could see. */}
        <ExportButton
          href={`/admin/reports/export.csv?start=${range.start}&end=${range.end}&user_id=${userId}`}
          filename={`${employee.full_name.replace(/\s+/g, '-').toLowerCase()}-${range.start}-to-${range.end}.csv`}
        />
      </div>

      <div className="grid grid-tiles" style={{ marginBottom: 14 }}>
        <StatTile label="Tracked" value={duration(totals.tracked_s)} />
        <StatTile label="Active" value={duration(totals.active_s)} meta={`${totals.efficiency_pct}% of tracked`} />
        <StatTile label="Idle" value={duration(totals.idle_s)} />
        <StatTile label="Productivity" value={`${totals.productivity_pct}%`} accent="var(--prod)" />
        <StatTile label="Unproductive" value={duration(totals.unproductive_s)} accent="var(--unprod)" />
        {!single && (
          <>
            {/* Averaged over the days actually worked, not the days in the
                range. Dividing by calendar days turns a week off into an
                apparent collapse in someone's working day. */}
            <StatTile
              label="Average day"
              value={duration((rangeQuery.data as RangeData).avg_tracked_s)}
              meta={`over ${(rangeQuery.data as RangeData).days_worked} day${
                (rangeQuery.data as RangeData).days_worked === 1 ? '' : 's'
              } worked`}
            />
            <StatTile
              label="Days worked"
              value={`${(rangeQuery.data as RangeData).days_worked} / ${
                (rangeQuery.data as RangeData).days_in_range
              }`}
              meta="days with any activity"
            />
          </>
        )}
      </div>

      {/* A timeline strip and an hour histogram describe one day. Across a
          month they are unreadable, so the range view answers with a per-day
          series instead of squeezing the same charts into the wrong question. */}
      {single && dayQuery.data && (
        <>
          <div style={{ marginBottom: 14 }}>
            <ChartCard
              title="Day timeline"
              note="each block is one focused window"
              legend={[...HOURLY_LEGEND, { label: 'Idle', color: 'var(--gridline)' }]}
              table={<TimelineTable data={dayQuery.data} />}
            >
              <TimelineStrip segments={dayQuery.data.timeline} />
            </ChartCard>
          </div>

          <div style={{ marginBottom: 14 }}>
            <ChartCard title="Activity by hour" legend={HOURLY_LEGEND}>
              <HourlyChart data={dayQuery.data.hourly} />
            </ChartCard>
          </div>
        </>
      )}

      {!single && rangeQuery.data && (
        <div style={{ marginBottom: 14 }}>
          <ChartCard
            title="Day by day"
            note={`${rangeQuery.data.days_in_range} days`}
            legend={HOURLY_LEGEND}
            table={<DailyTable data={rangeQuery.data} onPick={setRange} />}
          >
            <DailyBars data={rangeQuery.data.daily} />
          </ChartCard>
        </div>
      )}

      <div className="grid grid-2" style={{ marginBottom: 14 }}>
        <ChartCard
          title="Applications"
          legend={HOURLY_LEGEND}
          table={<BreakdownTable rows={head.top_apps} head="Application" />}
        >
          <RankedBars items={head.top_apps.slice(0, 10)} />
        </ChartCard>
        <ChartCard
          title="Websites"
          legend={HOURLY_LEGEND}
          table={<BreakdownTable rows={head.top_domains} head="Domain" />}
        >
          <RankedBars items={head.top_domains.slice(0, 10)} emptyLabel="No browsing recorded" />
        </ChartCard>
      </div>

      <div className="grid grid-2">
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">Attendance</h2>
            <span className="card-note">agent start / stop</span>
          </div>
          {head.attendance.length === 0 ? (
            <p className="empty">
              The agent did not run {single ? 'on this day' : 'in this period'}
            </p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {!single && <th>Day</th>}
                    <th>Started</th>
                    <th>Ended</th>
                    <th className="num">Duration</th>
                    <th>Close</th>
                  </tr>
                </thead>
                <tbody>
                  {head.attendance.map((row) => (
                    <tr key={row.started_at}>
                      {/* Across a range the clock time alone is ambiguous —
                          three rows reading 09:02 could be three days or three
                          restarts on one. */}
                      {!single && (
                        <td style={{ color: 'var(--text-secondary)' }}>
                          {row.started_at.slice(0, 10)}
                        </td>
                      )}
                      <td>{clockTime(row.started_at)}</td>
                      <td>{row.ended_at ? clockTime(row.ended_at) : 'still running'}</td>
                      <td className="num">{duration(row.duration_s)}</td>
                      <td style={{ color: 'var(--text-secondary)' }}>{row.end_reason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2 className="card-title">Devices</h2>
          </div>
          {devices.data && devices.data.length > 0 ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Host</th>
                    <th>OS</th>
                    <th>Agent</th>
                    <th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {devices.data.map((device) => (
                    <tr key={device.id}>
                      <td>
                        {device.hostname}
                        {/* A machine can be online, current and enrolled and
                            still capture nothing — a Wayland session, or macOS
                            Screen Recording never granted. Both look identical
                            to a healthy device everywhere else on this page,
                            so the warning goes next to the name rather than in
                            a column someone has to think to read. */}
                        {device.capture_blocked && (
                          <div className="device-warning" title={device.capture_blocked}>
                            No screenshots — {device.capture_blocked}
                          </div>
                        )}
                      </td>
                      <td style={{ color: 'var(--text-secondary)' }}>{device.os}</td>
                      <td style={{ color: 'var(--text-secondary)' }}>{device.agent_version || '—'}</td>
                      <td title={dateTime(device.last_seen_at)}>{relativeTime(device.last_seen_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty">No device enrolled</p>
          )}
        </section>
      </div>

      {editing && (
        <EmployeeEdit
          employee={employee}
          onClose={() => setEditing(false)}
          onSaved={() => {
            // Refetch whichever view is live, so the header, team and
            // designation reflect the change straight away.
            if (single) dayQuery.reload()
            else rangeQuery.reload()
          }}
        />
      )}
    </div>
  )
}

function TimelineTable({ data }: { data: DayData }) {
  if (data.timeline.length === 0) return <p className="empty">No activity recorded</p>
  return (
    <table>
      <thead>
        <tr>
          <th>Start</th>
          <th>Application</th>
          <th>Window / site</th>
          <th>Class</th>
          <th className="num">Duration</th>
          <th className="num">Idle</th>
        </tr>
      </thead>
      <tbody>
        {data.timeline.map((segment) => (
          <tr key={segment.id}>
            <td>{clockTime(segment.started_at)}</td>
            <td>{segment.app_name}</td>
            <td style={{ color: 'var(--text-secondary)', maxWidth: 380 }}>
              {segment.url_domain ?? segment.window_title ?? '—'}
            </td>
            <td>
              {segment.is_idle ? (
                <span className="badge">Idle</span>
              ) : (
                <ProductivityBadge value={segment.productivity} />
              )}
            </td>
            <td className="num">{duration(segment.duration_s)}</td>
            <td className="num">{duration(segment.idle_s)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Per-day rows behind the "Day by day" chart.
 *
 * Each row jumps the whole page to that single day, which is the question a
 * spike or a gap in the chart immediately raises. Without it, seeing an odd
 * Tuesday means retyping two dates.
 */
function DailyTable({
  data,
  onPick,
}: {
  data: RangeData
  onPick: (range: Range) => void
}) {
  const worked = data.daily.filter((d) => d.tracked_s > 0)
  if (worked.length === 0) return <p className="empty">No activity in this period</p>

  return (
    <table>
      <thead>
        <tr>
          <th>Day</th>
          <th className="num">Tracked</th>
          <th className="num">Active</th>
          <th className="num">Productive</th>
          <th className="num">Productivity</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {data.daily.map((row) => {
          const idle = row.tracked_s === 0
          return (
            <tr key={row.date} style={idle ? { color: 'var(--text-muted)' } : undefined}>
              <td>
                {new Date(`${row.date}T00:00:00`).toLocaleDateString(undefined, {
                  weekday: 'short', day: 'numeric', month: 'short',
                })}
              </td>
              <td className="num">{idle ? '—' : duration(row.tracked_s)}</td>
              <td className="num">{idle ? '—' : duration(row.active_s)}</td>
              <td className="num">{idle ? '—' : duration(row.productive_s)}</td>
              <td className="num">{idle ? '—' : `${row.productivity_pct}%`}</td>
              <td className="num">
                {!idle && (
                  <button
                    className="btn btn-sm"
                    onClick={() => onPick({ start: row.date, end: row.date, preset: 'custom' })}
                    title={`Open ${row.date} in full`}
                  >
                    Open day
                  </button>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
