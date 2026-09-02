import { useState } from 'react'
import { Link } from 'react-router-dom'
import '../styles/org.css'
import { api } from '../lib/api'
import { canViewTeam, useAuth } from '../lib/auth'
import { useQuery } from '../lib/useQuery'
import { clockTime, duration, todayISO } from '../lib/format'
import type { Department, Productivity, Team, User } from '../lib/types'
import { ErrorNote, ProductivityBadge } from '../components/ui'
import { ExportButton } from '../components/ExportButton'

interface ActivityRow {
  id: string
  user_id: string
  employee: string
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
  productivity: Productivity
  is_idle: boolean
  project_id: string | null
  is_billable: boolean
}

interface ActivityLog {
  start: string
  end: string
  timezone: string
  total: number
  items: ActivityRow[]
}

const PAGE = 100

export default function AppsWebsites() {
  const { user } = useAuth()
  const [start, setStart] = useState(todayISO())
  const [end, setEnd] = useState(todayISO())
  const [userId, setUserId] = useState('')
  const [teamId, setTeamId] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [kind, setKind] = useState<'all' | 'apps' | 'websites'>('all')
  const [productivity, setProductivity] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)

  const employees = useQuery<User[]>('employees', () => api.get<User[]>('/admin/employees'))
  const teams = useQuery<Team[]>('teams', () => api.get<Team[]>('/org/teams'))
  const departments = useQuery<Department[]>('departments', () =>
    api.get<Department[]>('/org/departments'),
  )

  const params = new URLSearchParams({
    start,
    end,
    kind,
    limit: String(PAGE),
    offset: String(page * PAGE),
  })
  if (userId) params.set('user_id', userId)
  if (teamId) params.set('team_id', teamId)
  if (departmentId) params.set('department_id', departmentId)
  if (productivity) params.set('productivity', productivity)
  if (q.trim()) params.set('q', q.trim())

  /* The export carries every filter but neither limit nor offset: the table
     pages at 200 rows and the file must be the whole answer, not the page
     you happen to be looking at. */
  const exportParams = new URLSearchParams(params)
  exportParams.delete('limit')
  exportParams.delete('offset')

  const key = params.toString()
  const { data, error, loading, refetching } = useQuery<ActivityLog>(`activity:${key}`, () =>
    api.get<ActivityLog>(`/admin/activity?${key}`),
  )

  function reset<T>(setter: (v: T) => void) {
    return (value: T) => {
      // Any filter change invalidates the current page — staying on page 4 of a
      // narrower result set shows an empty table that looks like a bug.
      setPage(0)
      setter(value)
    }
  }

  return (
    <div className={refetching ? 'refetching' : undefined}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Apps &amp; Websites</h1>
          <p className="page-sub">
            Every recorded usage, with idle stretches marked rather than hidden.
          </p>
        </div>
        <div className="head-actions">
          <ExportButton
            href={`/admin/activity/export.csv?${exportParams.toString()}`}
            filename={`apps-websites-${start}-to-${end}.csv`}
            disabled={!data || data.total === 0}
          />
        </div>
      </div>

      <div className="filter-row">
        <label className="field">
          From
          <input type="date" value={start} max={end} onChange={(e) => reset(setStart)(e.target.value)} />
        </label>
        <label className="field">
          To
          <input type="date" value={end} max={todayISO()} onChange={(e) => reset(setEnd)(e.target.value)} />
        </label>
        {/* An employee's own list holds one name, so this rendered a chooser
            labelled "Everyone" offering only themselves. The server refuses a
            colleague's id regardless; hiding the control stops it reading as a
            broken feature. */}
        {canViewTeam(user) && (
          <>
            <select value={userId} onChange={(e) => reset(setUserId)(e.target.value)}>
              <option value="">Everyone</option>
              {employees.data?.map((emp) => (
                <option key={emp.id} value={emp.id}>{emp.full_name}</option>
              ))}
            </select>
            <select
              value={teamId}
              onChange={(e) => reset(setTeamId)(e.target.value)}
              aria-label="Team"
            >
              <option value="">All teams</option>
              {teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <select
              value={departmentId}
              onChange={(e) => reset(setDepartmentId)(e.target.value)}
              aria-label="Department"
            >
              <option value="">All departments</option>
              {departments.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </>
        )}
        <select value={kind} onChange={(e) => reset(setKind)(e.target.value as typeof kind)}>
          <option value="all">Apps &amp; websites</option>
          <option value="apps">Applications only</option>
          <option value="websites">Websites only</option>
        </select>
        <select value={productivity} onChange={(e) => reset(setProductivity)(e.target.value)}>
          <option value="">Any classification</option>
          <option value="productive">Productive</option>
          <option value="neutral">Neutral</option>
          <option value="unproductive">Unproductive</option>
        </select>
        <input
          type="search"
          placeholder="Search app, site or title…"
          value={q}
          onChange={(e) => reset(setQ)(e.target.value)}
          style={{ minWidth: 210 }}
        />
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Usage log</h2>
          <span className="card-note">
            {loading ? 'Loading…' : `${data?.total.toLocaleString('en-IN') ?? 0} entries`}
          </span>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Employee</th>
                <th>Application</th>
                <th>Website / window</th>
                <th>Start</th>
                <th>End</th>
                <th className="num">Duration</th>
                <th className="num">Active</th>
                <th>Class</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link className="row-link" to={`/employees/${row.user_id}`}>{row.employee}</Link>
                  </td>
                  <td>
                    {row.app_name || '—'}
                    {row.browser && <div className="muted-sm">{row.browser}</div>}
                  </td>
                  <td style={{ maxWidth: 320 }}>
                    {row.url_domain ? (
                      <>
                        <b>{row.url_domain}</b>
                        {row.window_title && <div className="muted-sm">{row.window_title}</div>}
                      </>
                    ) : (
                      <span className="muted-sm">{row.window_title || '—'}</span>
                    )}
                  </td>
                  <td>{clockTime(row.started_at)}</td>
                  <td>{clockTime(row.ended_at)}</td>
                  <td className="num">{duration(row.duration_s)}</td>
                  <td className="num">
                    {duration(row.active_s)}
                    {row.idle_s > 0 && (
                      <div className="muted-sm">{duration(row.idle_s)} idle</div>
                    )}
                  </td>
                  <td>
                    {row.is_idle ? (
                      <span className="badge">Idle</span>
                    ) : (
                      <ProductivityBadge value={row.productivity} />
                    )}
                    {row.is_billable && (
                      <div style={{ marginTop: 4 }}><span className="badge">Billable</span></div>
                    )}
                  </td>
                </tr>
              ))}
              {!loading && data?.items.length === 0 && (
                <tr>
                  <td colSpan={8} className="empty">
                    Nothing recorded for those filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {data && data.total > PAGE && (
          <div className="pager">
            <button className="btn btn-sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              Previous
            </button>
            <span className="muted-sm">
              {page * PAGE + 1}–{Math.min((page + 1) * PAGE, data.total)} of{' '}
              {data.total.toLocaleString('en-IN')}
            </span>
            <button
              className="btn btn-sm"
              disabled={(page + 1) * PAGE >= data.total}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        )}
      </section>
    </div>
  )
}
