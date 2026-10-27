import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { useQuery } from '../lib/useQuery'
import { canAdminister, useAuth } from '../lib/auth'
import { dateTime } from '../lib/format'
import type { Department, Team, User } from '../lib/types'
import { Avatar, Empty, ErrorNote, Loading } from '../components/ui'
import { ExportButton } from '../components/ExportButton'
import AgentInstall from '../components/AgentInstall'
import { IconClose, IconEdit, IconFilter, IconPlus, IconSearch, IconUpload } from '../components/Icons'
import EmployeeImport from '../components/EmployeeImport'
import '../styles/org.css'
import '../styles/employees.css'

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
  const [importing, setImporting] = useState(false)

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
  /* How many popover filters differ from the defaults — the badge on the
     Filters button, so a narrowed list is never mistaken for the whole one. */
  const activeFilters = [teamId, departmentId, role].filter(Boolean).length + (status !== 'active' ? 1 : 0)
  const reset = () => {
    setQ(''); setTeamId(''); setDepartmentId(''); setRole(''); setStatus('active')
  }

  /* The popover edits a draft and applies it on Search, so changing three
     selects does not reflow the table three times underneath the popover. */
  const [filterOpen, setFilterOpen] = useState(false)
  const [draft, setDraft] = useState({ teamId, departmentId, role, status })
  const popRef = useRef<HTMLDivElement>(null)
  const openFilters = () => {
    setDraft({ teamId, departmentId, role, status })
    setFilterOpen(true)
  }
  const applyFilters = () => {
    setTeamId(draft.teamId); setDepartmentId(draft.departmentId)
    setRole(draft.role); setStatus(draft.status)
    setFilterOpen(false)
  }
  const clearFilters = () => {
    setDraft({ teamId: '', departmentId: '', role: '', status: 'active' })
    setTeamId(''); setDepartmentId(''); setRole(''); setStatus('active')
    setFilterOpen(false)
  }
  useEffect(() => {
    if (!filterOpen) return
    const onDown = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node)) setFilterOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFilterOpen(false) }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [filterOpen])

  if (error) return <ErrorNote>{error}</ErrorNote>
  if (loading || !data) return <Loading />

  return (
    <div>
      {/* One toolbar: search and filters on the left, the actions on the
          right. The page title is the panel tab above; a second heading here
          only pushed the roster down the screen. */}
      <div className="emp-toolbar">
        <div className="emp-tools-left">
          <label className="emp-search">
            <IconSearch size={16} />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, email or employee code…"
              aria-label="Search employees"
            />
          </label>

          <div className="emp-filter" ref={popRef}>
            <button
              type="button"
              className={`emp-filter-btn${activeFilters ? ' is-active' : ''}${filterOpen ? ' is-open' : ''}`}
              onClick={() => (filterOpen ? setFilterOpen(false) : openFilters())}
              aria-expanded={filterOpen}
              aria-haspopup="dialog"
            >
              <IconFilter size={15} />
              Filters
              {activeFilters > 0 && <span className="emp-filter-count">{activeFilters}</span>}
            </button>

            {filterOpen && (
              <div className="emp-pop" role="dialog" aria-label="Filter employees">
                <div className="emp-pop-head">
                  <strong>Filter employees</strong>
                  <button type="button" className="emp-pop-x" onClick={() => setFilterOpen(false)} aria-label="Close filters">
                    <IconClose size={14} />
                  </button>
                </div>
                <div className="emp-pop-body">
                  <label className="emp-pop-field">
                    <span>Team</span>
                    <select value={draft.teamId} onChange={(e) => setDraft({ ...draft, teamId: e.target.value })}>
                      <option value="">All teams</option>
                      {teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </label>
                  <label className="emp-pop-field">
                    <span>Department</span>
                    <select value={draft.departmentId} onChange={(e) => setDraft({ ...draft, departmentId: e.target.value })}>
                      <option value="">All departments</option>
                      {departments.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </label>
                  <label className="emp-pop-field">
                    <span>Role</span>
                    <select value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })}>
                      <option value="">All roles</option>
                      <option value="owner">Owner</option>
                      <option value="admin">Admin</option>
                      <option value="manager">Manager</option>
                      <option value="employee">Employee</option>
                    </select>
                  </label>
                  {/* Defaults to active. A deactivated employee keeps their
                      history, so the full list is the wrong default for "who
                      works here". */}
                  <label className="emp-pop-field">
                    <span>Status</span>
                    <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
                      <option value="active">Active only</option>
                      <option value="inactive">Deactivated only</option>
                      <option value="">Any status</option>
                    </select>
                  </label>
                </div>
                <div className="emp-pop-foot">
                  <button type="button" className="btn" onClick={clearFilters}>Clear</button>
                  <button type="button" className="btn btn-primary" onClick={applyFilters}>
                    <IconSearch size={14} /> Search
                  </button>
                </div>
              </div>
            )}
          </div>

          <span className="emp-count">
            <strong>{rows.length}</strong> of {data.length}
          </span>
          {filtered && (
            <button className="emp-reset" onClick={reset}>Reset</button>
          )}
        </div>

        <div className="emp-tools-right">
          {/* The software itself, next to the people it tracks. */}
          <button
            className="emp-icon-btn"
            onClick={() => setInstallFor(null)}
            title="Install agent — download the desktop app (.exe)"
            aria-label="Install agent"
          >
            <IconInstaller />
          </button>
          {/* Excel both ways: the export uses the import's own columns, so a
              file can be edited and imported back elsewhere. */}
          {isAdmin && (
            <button
              className="emp-icon-btn"
              onClick={() => setImporting(true)}
              title="Import employees from Excel"
              aria-label="Import employees from Excel"
            >
              <IconUpload size={17} />
            </button>
          )}
          <ExportButton
            href="/admin/employees/export.xlsx"
            filename="employees.xlsx"
            label="Export to Excel"
            iconOnly
            className="emp-icon-btn"
            disabled={rows.length === 0}
          />
          {isAdmin && (
            <Link className="btn btn-primary emp-add" to="/employees/new">
              <IconPlus size={15} /> Add employee
            </Link>
          )}
        </div>
      </div>

      <section className="card emp-card">
        <div className="table-wrap">
          <table className="emp-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Team</th>
                <th>Designation</th>
                <th>Monitoring notice</th>
                <th>Enrollment key</th>
                {isAdmin && <th style={{ textAlign: 'center' }}>Edit</th>}
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
                  {/* Opens the same ten-step form as Add employee, filled in. */}
                  {isAdmin && (
                    <td style={{ textAlign: 'center' }}>
                      <Link
                        className="icon-btn"
                        to={`/employees/${employee.id}/edit`}
                        aria-label={`Edit ${employee.full_name}`}
                        title="Edit employee"
                      >
                        <IconEdit size={16} />
                      </Link>
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

      {importing && (
        <EmployeeImport onClose={() => setImporting(false)} onImported={reload} />
      )}

      {installFor !== undefined && (
        <AgentInstall employee={installFor} onClose={() => setInstallFor(undefined)} />
      )}


    </div>
  )
}

/* An installer: a program window with a download arrow — what "install the
   desktop agent (.exe)" looks like at icon size. */
function IconInstaller() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3.5" width="18" height="14" rx="2" />
      <path d="M3 7.5h18" />
      <path d="M12 10v5" />
      <path d="m9.5 12.5 2.5 2.5 2.5-2.5" />
      <path d="M8 21h8" />
    </svg>
  )
}
