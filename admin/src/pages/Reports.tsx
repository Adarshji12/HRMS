import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import '../styles/org.css'
import '../styles/timesheets.css'
import { api } from '../lib/api'
import { canViewTeam, useAuth } from '../lib/auth'
import { useQuery } from '../lib/useQuery'
import { daysAgoISO, duration, todayISO } from '../lib/format'
import type { Department, Team, User } from '../lib/types'
import { DatePresets, type Range } from '../components/DatePresets'
import { ErrorNote, Loading } from '../components/ui'
import { ExportButton } from '../components/ExportButton'
import { rupees } from './Projects'

interface Column {
  key: string
  label: string
  type: 'text' | 'duration' | 'number' | 'percent' | 'money' | 'date' | 'time'
}

interface ReportData {
  key: string
  title: string
  description: string
  columns: Column[]
  rows: Array<Record<string, unknown>>
  totals: Record<string, number> | null
  row_count: number
  start: string
  end: string
  timezone: string
}

interface CatalogueEntry {
  key: string
  title: string
  group: string
}

/** One formatter for every report — the reason columns carry a type. */
function renderCell(value: unknown, type: Column['type']) {
  if (value === null || value === undefined || value === '') return <span className="muted-sm">—</span>
  switch (type) {
    case 'duration':
      return duration(Number(value))
    case 'money':
      return rupees(Number(value))
    case 'percent':
      return `${value}%`
    case 'number':
      return Number(value).toLocaleString('en-IN')
    case 'time':
      return String(value).slice(11, 16) || String(value)
    default:
      return String(value)
  }
}

const NUMERIC: Column['type'][] = ['duration', 'number', 'percent', 'money']

export default function Reports() {
  const { user } = useAuth()
  /* The chosen report lives in the URL so a search result, a bookmark and a
     shared link can all name one. Same pattern as Screenshots. */
  const [urlParams, setUrlParams] = useSearchParams()
  const selected = urlParams.get('r') ?? 'time'
  const setSelected = (key: string) => setUrlParams({ r: key }, { replace: true })
  const [range, setRange] = useState<Range>({
    start: daysAgoISO(29),
    end: todayISO(),
    preset: 'custom',
  })
  const [userId, setUserId] = useState('')
  const [teamId, setTeamId] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [search, setSearch] = useState('')

  const catalogue = useQuery<CatalogueEntry[]>('report-catalogue', () =>
    api.get<CatalogueEntry[]>('/reports/catalogue'),
  )
  const employees = useQuery<User[]>('employees', () => api.get<User[]>('/admin/employees'))
  const teams = useQuery<Team[]>('teams', () => api.get<Team[]>('/org/teams'))
  const departments = useQuery<Department[]>('departments', () =>
    api.get<Department[]>('/org/departments'),
  )

  const params = new URLSearchParams({ start: range.start, end: range.end })
  if (userId) params.set('user_id', userId)
  if (teamId) params.set('team_id', teamId)
  if (departmentId) params.set('department_id', departmentId)
  const query = params.toString()

  const { data, error, loading, refetching } = useQuery<ReportData>(
    `report:${selected}:${query}`,
    () => api.get<ReportData>(`/reports/${selected}?${query}`),
  )

  // Search filters client-side on purpose: the report is already loaded, and a
  // round-trip per keystroke would be slower and no more accurate.
  const rows = useMemo(() => {
    if (!data) return []
    const needle = search.trim().toLowerCase()
    if (!needle) return data.rows
    return data.rows.filter((row) =>
      data.columns.some((c) => String(row[c.key] ?? '').toLowerCase().includes(needle)),
    )
  }, [data, search])

  const groups = useMemo(() => {
    const map = new Map<string, CatalogueEntry[]>()
    for (const entry of catalogue.data ?? []) {
      const list = map.get(entry.group) ?? []
      list.push(entry)
      map.set(entry.group, list)
    }
    return [...map.entries()]
  }, [catalogue.data])

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Reports</h1>
          <p className="page-sub">
            {data ? data.description : 'Choose a report, set the range, export what you need.'}
          </p>
        </div>
        <div className="head-actions">
          <ExportButton
            href={`/reports/${selected}/export.csv?${query}`}
            filename={`${selected}-report-${range.start}-to-${range.end}.csv`}
            disabled={!data || data.row_count === 0}
          />
        </div>
      </div>

      <div className="rp-layout">
        <aside className="rp-picker">
          {groups.map(([group, entries]) => (
            <div key={group}>
              <div className="nav-group">{group}</div>
              {entries.map((entry) => (
                <button
                  key={entry.key}
                  className={`rp-item ${selected === entry.key ? 'rp-item-on' : ''}`}
                  onClick={() => setSelected(entry.key)}
                  aria-current={selected === entry.key ? 'true' : undefined}
                >
                  {entry.title}
                </button>
              ))}
            </div>
          ))}
        </aside>

        <div style={{ minWidth: 0 }}>
          <div className="filter-row">
            <DatePresets value={range} onChange={setRange} />
            {/* "All employees" means one person when an employee is looking,
                so the chooser is hidden rather than shown with a single entry.
                The server scopes the report either way. */}
            {canViewTeam(user) && (
              <>
                <select value={userId} onChange={(e) => setUserId(e.target.value)}>
                  <option value="">All employees</option>
                  {employees.data?.map((emp) => (
                    <option key={emp.id} value={emp.id}>{emp.full_name}</option>
                  ))}
                </select>
                <select
                  value={teamId}
                  onChange={(e) => { setTeamId(e.target.value); setDepartmentId('') }}
                >
                  <option value="">All teams</option>
                  {teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <select
                  value={departmentId}
                  onChange={(e) => { setDepartmentId(e.target.value); setTeamId('') }}
                >
                  <option value="">All departments</option>
                  {departments.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </>
            )}
            <input
              type="search"
              placeholder="Filter rows…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ minWidth: 160 }}
            />
          </div>

          {error && <ErrorNote>{error}</ErrorNote>}

          <section className={`card ${refetching ? 'refetching' : ''}`}>
            <div className="card-head">
              <h2 className="card-title">{data?.title ?? 'Report'}</h2>
              <span className="card-note">
                {loading
                  ? 'Running…'
                  : `${rows.length.toLocaleString('en-IN')}${
                      search && data ? ` of ${data.row_count}` : ''
                    } rows · ${data?.start ?? ''} → ${data?.end ?? ''}`}
              </span>
            </div>

            {loading ? (
              <Loading label="Running…" />
            ) : !data || rows.length === 0 ? (
              <p className="empty">
                {search
                  ? 'No rows match that filter.'
                  : 'Nothing recorded for this report in the selected range.'}
              </p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      {data.columns.map((c) => (
                        <th key={c.key} className={NUMERIC.includes(c.type) ? 'num' : undefined}>
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => (
                      <tr key={index}>
                        {data.columns.map((c) => (
                          <td key={c.key} className={NUMERIC.includes(c.type) ? 'num' : undefined}>
                            {renderCell(row[c.key], c.type)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                  {data.totals && (
                    <tfoot>
                      <tr className="rp-totals">
                        {data.columns.map((c, index) => (
                          <td key={c.key} className={NUMERIC.includes(c.type) ? 'num' : undefined}>
                            {index === 0
                              ? 'Total'
                              : data.totals?.[c.key] !== undefined
                                ? renderCell(data.totals[c.key], c.type)
                                : ''}
                          </td>
                        ))}
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
