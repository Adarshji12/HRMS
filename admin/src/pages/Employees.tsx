import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { useQuery } from '../lib/useQuery'
import { canAdminister, useAuth } from '../lib/auth'
import { dateTime } from '../lib/format'
import type { Department, Team, User } from '../lib/types'
import { Avatar, Empty, ErrorNote, Loading } from '../components/ui'
import { ExportButton } from '../components/ExportButton'
import AgentInstall from '../components/AgentInstall'
import EmployeeEdit from '../components/EmployeeEdit'
import { IconEdit } from '../components/Icons'
import '../styles/org.css'

export default function Employees() {
  const { user } = useAuth()
  const isAdmin = canAdminister(user)
  const { data, error, loading, reload } = useQuery<User[]>('employees', () =>
    api.get<User[]>('/admin/employees'),
  )
  const teams = useQuery<Team[]>('teams', () => api.get<Team[]>('/org/teams'))
  const departments = useQuery<Department[]>('departments', () =>
    api.get<Department[]>('/org/departments'),
  )
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  /* undefined = closed. null = the generic version, opened from the header.
     A user = that person's key filled in, ready to send to them. */
  const [installFor, setInstallFor] = useState<User | null | undefined>(undefined)
  const [editing, setEditing] = useState<User | null>(null)

  const [q, setQ] = useState('')
  const [teamId, setTeamId] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [role, setRole] = useState('')
  const [status, setStatus] = useState('active')

  /* Filtered in the browser, not re-fetched. The roster is loaded whole and is
     a few hundred rows at most, so a round trip per keystroke would be slower
     and no more correct — the same call the Reports table makes. */
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (data ?? []).filter((e) => {
      if (teamId && e.team_id !== teamId) return false
      if (departmentId && e.department_id !== departmentId) return false
      if (role && e.role !== role) return false
      if (status === 'active' && !e.is_active) return false
      if (status === 'inactive' && e.is_active) return false
      if (!needle) return true
      return (
        e.full_name.toLowerCase().includes(needle) ||
        e.email.toLowerCase().includes(needle) ||
        (e.employee_code ?? '').toLowerCase().includes(needle)
      )
    })
  }, [data, q, teamId, departmentId, role, status])

  const filtered = q || teamId || departmentId || role || status !== 'active'
  const reset = () => {
    setQ(''); setTeamId(''); setDepartmentId(''); setRole(''); setStatus('active')
  }

  if (error) return <ErrorNote>{error}</ErrorNote>
  if (loading || !data) return <Loading />

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Employees</h1>
          <p className="page-sub">
            One enrollment key each. It binds a machine the first time the agent runs.
          </p>
        </div>
        <div className="head-actions">
          {/* The software itself, next to the people it tracks. It used to live
              only in a deployment document, which is not where anybody
              onboarding an employee was looking. */}
          <button className="btn" onClick={() => setInstallFor(null)}>
            Install agent
          </button>
          <ExportButton
            href="/admin/employees/export.csv"
            filename="employees.csv"
            disabled={rows.length === 0}
          />
          {isAdmin && (
            <Link className="btn btn-primary" to="/employees/new">
              + Add employee
            </Link>
          )}
        </div>
      </div>

      <div className="filter-row">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, email or code…"
          aria-label="Search employees"
          style={{ minWidth: 220 }}
        />
        <select value={teamId} onChange={(e) => setTeamId(e.target.value)} aria-label="Team">
          <option value="">All teams</option>
          {teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select
          value={departmentId}
          onChange={(e) => setDepartmentId(e.target.value)}
          aria-label="Department"
        >
          <option value="">All departments</option>
          {departments.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
          <option value="">All roles</option>
          <option value="owner">Owner</option>
          <option value="admin">Admin</option>
          <option value="manager">Manager</option>
          <option value="employee">Employee</option>
        </select>
        {/* Defaults to active. A deactivated employee keeps their history, so
            the full list is the wrong default for "who works here". */}
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="active">Active only</option>
          <option value="inactive">Deactivated only</option>
          <option value="">Any status</option>
        </select>
        <span className="filter-count">
          {rows.length} of {data.length}
        </span>
        {filtered && (
          <button className="filter-reset" onClick={reset}>Clear filters</button>
        )}
      </div>

      <section className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Team</th>
                <th>Designation</th>
                <th>Monitoring notice</th>
                <th>Enrollment key</th>
                {isAdmin && <th />}
              </tr>
            </thead>
            <tbody>
              {rows.map((employee) => (
                <tr key={employee.id}>
                  {/* Email rides along under the name rather than holding its own
                      column — it identifies the person, it is not a facet anyone
                      scans down. */}
                  <td>
                    <div className="identity">
                      <Avatar name={employee.full_name} />
                      <div className="identity-body">
                        <div className="identity-name">
                          <Link className="row-link" to={`/employees/${employee.id}`}>
                            {employee.full_name}
                          </Link>
                          {!employee.is_active && (
                            <span className="badge" style={{ marginLeft: 8 }}>
                              Disabled
                            </span>
                          )}
                        </div>
                        <div className="identity-meta">
                          {employee.email}
                          {/* Two different records, deliberately reachable from
                              one row. `/employees/:id` is the account — role,
                              placement, permissions, the agent key. `/people/:id`
                              is the person — statutory identity, documents,
                              probation. HR administering somebody needs both and
                              was otherwise routed via the Directory to reach the
                              second, which is silly. The server refuses the
                              profile link for anyone without the people
                              permission, so this is a shortcut, not a grant. */}
                          <Link className="row-sublink" to={`/people/${employee.id}`}>
                            HR record
                          </Link>
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>
                    {employee.team_name ?? <span className="muted-sm">unassigned</span>}
                    {employee.department_name && (
                      <div className="muted-sm">{employee.department_name}</div>
                    )}
                  </td>
                  <td style={{ color: 'var(--text-secondary)' }}>
                    {employee.designation_name ?? employee.role}
                  </td>
                  {/* Enrolment is refused until this is accepted, so a pending
                      row is an actionable state, not a blank field. */}
                  <td>
                    {employee.notice_accepted_at ? (
                      <span className="badge badge-ok" title={dateTime(employee.notice_accepted_at)}>
                        <span className="badge-dot" style={{ background: 'var(--status-good)' }} />
                        Accepted
                      </span>
                    ) : (
                      <span className="badge badge-warn">
                        <span className="badge-dot" style={{ background: 'var(--status-warn)' }} />
                        Pending
                      </span>
                    )}
                  </td>
                  <td>
                    <div className="btn-group">
                      {revealed[employee.id] ? (
                        <span className="key-chip">{employee.enrollment_key}</span>
                      ) : (
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() => setRevealed((r) => ({ ...r, [employee.id]: true }))}
                        >
                          Reveal
                        </button>
                      )}
                      {isAdmin && (
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={async () => {
                            await api.post(`/admin/employees/${employee.id}/rotate-key`)
                            setRevealed((r) => ({ ...r, [employee.id]: true }))
                            reload()
                          }}
                        >
                          Rotate
                        </button>
                      )}
                      {/* The key on its own is half of what this person needs.
                          This is the key, the download and the steps together. */}
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => setInstallFor(employee)}
                        title={`Download the agent and the setup steps for ${employee.full_name}`}
                      >
                        Set up
                      </button>
                    </div>
                  </td>
                  {/* The same form as "Edit employee" on the person's own page,
                      so a role or department change no longer needs the detour. */}
                  {isAdmin && (
                    <td className="num">
                      <button
                        className="icon-btn"
                        onClick={() => setEditing(employee)}
                        aria-label={`Edit ${employee.full_name}`}
                        title="Edit employee"
                      >
                        <IconEdit size={16} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && (
            <Empty>No employee matches these filters.</Empty>
          )}
        </div>
      </section>

      {installFor !== undefined && (
        <AgentInstall employee={installFor} onClose={() => setInstallFor(undefined)} />
      )}

      {editing && (
        <EmployeeEdit employee={editing} onClose={() => setEditing(null)} onSaved={reload} />
      )}
    </div>
  )
}
