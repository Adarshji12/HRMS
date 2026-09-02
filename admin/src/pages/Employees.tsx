import { useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { PAGES, PERMISSIONS } from '../lib/employeeFields'
import type { OrgRole } from './hrms/roles/Roles'
import { useQuery } from '../lib/useQuery'
import { canAdminister, useAuth } from '../lib/auth'
import { dateTime } from '../lib/format'
import type { Department, Designation, Team, User } from '../lib/types'
import { Avatar, Empty, ErrorNote, Loading } from '../components/ui'
import { ExportButton } from '../components/ExportButton'
import AgentInstall from '../components/AgentInstall'
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
  const [adding, setAdding] = useState(false)
  /* undefined = closed. null = the generic version, opened from the header.
     A user = that person's key filled in, ready to send to them. */
  const [installFor, setInstallFor] = useState<User | null | undefined>(undefined)

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
            <button className="btn btn-primary" onClick={() => setAdding((v) => !v)}>
              {adding ? 'Cancel' : 'Add employee'}
            </button>
          )}
        </div>
      </div>

      {adding && <AddEmployee onDone={() => { setAdding(false); reload() }} />}

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
    </div>
  )
}
/* What each role reaches, in the words someone choosing one needs. */


function AddEmployee({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({
    full_name: '',
    email: '',
    team_id: '',
    department_id: '',
    designation_id: '',
    manager_id: '',
    employee_code: '',
    role: 'employee',
    password: '',
    can_view_screenshots: true,
    can_approve_timesheets: true,
    // Off by default, unlike its neighbours: this one removes the geofence
    // rather than granting a capability.
    can_punch_anywhere: false,
    role_id: '',
    can_approve_leave: true,
    can_approve_regularization: true,
    can_manage_assets: true,
    can_manage_onboarding: true,
    can_manage_helpdesk: true,
    can_manage_performance: true,
    can_manage_engagement: true,
    can_export_data: true,
    can_manage_projects: true,
    can_manage_people: true,
    can_issue_letters: true,
    can_approve_expenses: true,
    can_reimburse_expenses: true,
    can_approve_loans: true,
    can_disburse_loans: true,
    can_manage_payroll: false,
    hidden_pages: [] as string[],
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /* The company's named roles. Assigning one is how permissions are set now —
     the four hardcoded levels became four built-in roles, and a company can add
     its own beside them. */
  const rolesQ = useQuery<OrgRole[]>('org-roles', () => api.get<OrgRole[]>('/roles'))
  const teams = useQuery<Team[]>('teams', () => api.get<Team[]>('/org/teams'))
  const departments = useQuery<Department[]>('departments', () =>
    api.get<Department[]>('/org/departments'),
  )
  const designations = useQuery<Designation[]>('designations', () =>
    api.get<Designation[]>('/org/designations'),
  )
  const people = useQuery<User[]>('employees', () => api.get<User[]>('/admin/employees'))

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post('/admin/employees', {
        full_name: form.full_name,
        email: form.email,
        role: form.role,
        can_view_screenshots: form.can_view_screenshots,
        can_approve_timesheets: form.can_approve_timesheets,
        can_punch_anywhere: form.can_punch_anywhere,
        role_id: form.role_id || null,
        can_approve_leave: form.can_approve_leave,
        can_approve_regularization: form.can_approve_regularization,
        can_manage_assets: form.can_manage_assets,
        can_manage_onboarding: form.can_manage_onboarding,
        can_manage_helpdesk: form.can_manage_helpdesk,
        can_manage_performance: form.can_manage_performance,
        can_manage_engagement: form.can_manage_engagement,
        can_export_data: form.can_export_data,
        can_manage_projects: form.can_manage_projects,
        can_manage_people: form.can_manage_people,
        can_issue_letters: form.can_issue_letters,
        can_approve_expenses: form.can_approve_expenses,
        can_reimburse_expenses: form.can_reimburse_expenses,
        can_approve_loans: form.can_approve_loans,
        can_disburse_loans: form.can_disburse_loans,
        can_manage_payroll: form.can_manage_payroll,
        hidden_pages: form.hidden_pages,
        employee_code: form.employee_code || null,
        // Empty select values are "" — send null, or the UUID parse fails.
        team_id: form.team_id || null,
        department_id: form.department_id || null,
        designation_id: form.designation_id || null,
        manager_id: form.manager_id || null,
        // Employees who never sign in to the console do not need a password;
        // they only ever use their enrollment key.
        password: form.password || null,
      })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the employee')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card" style={{ marginBottom: 16 }} onSubmit={submit}>
      <div className="card-head">
        <h2 className="card-title">New employee</h2>
      </div>
      {error && <div style={{ marginBottom: 12 }}><ErrorNote>{error}</ErrorNote></div>}
      <div className="settings-grid">
        <label className="setting">
          Full name
          <input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} required />
        </label>
        <label className="setting">
          Work email
          <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
        </label>
        <label className="setting">
          Team
          <select value={form.team_id} onChange={(e) => setForm({ ...form, team_id: e.target.value })}>
            <option value="">Unassigned</option>
            {teams.data?.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </label>
        <label className="setting">
          Department
          <select
            value={form.department_id}
            onChange={(e) => setForm({ ...form, department_id: e.target.value })}
          >
            <option value="">Unassigned</option>
            {departments.data?.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </label>
        <label className="setting">
          Designation
          <select
            value={form.designation_id}
            onChange={(e) => setForm({ ...form, designation_id: e.target.value })}
          >
            <option value="">None</option>
            {designations.data?.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </label>
        <label className="setting">
          Reports to
          <select value={form.manager_id} onChange={(e) => setForm({ ...form, manager_id: e.target.value })}>
            <option value="">Nobody</option>
            {people.data?.map((p) => (
              <option key={p.id} value={p.id}>{p.full_name}</option>
            ))}
          </select>
          <span className="setting-hint">
            Managers see everyone beneath them, not just their own team.
          </span>
        </label>
        <label className="setting">
          Employee code
          <input
            value={form.employee_code}
            onChange={(e) => setForm({ ...form, employee_code: e.target.value })}
            placeholder="EMP-014"
          />
        </label>
        <label className="setting">
          Role
          <select
            value={form.role_id || form.role}
            onChange={(e) => {
              const value = e.target.value
              const named = (rolesQ.data ?? []).find((r) => r.id === value)
              /* A named role supplies the level; the legacy `role` field
                 mirrors it so anything still reading that column agrees with
                 what the role actually grants. */
              setForm(named
                ? { ...form, role_id: named.id, role: named.base_role }
                : { ...form, role_id: '', role: value })
            }}
          >
            {(rolesQ.data ?? []).filter((r) => r.base_role !== 'owner').map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
          {/* What the chosen role actually reaches — the whole question being
              asked here. For a named role it is that role's own description and
              scope rather than a hardcoded sentence about four levels. */}
          <span className="setting-hint">{roleSummary(rolesQ.data ?? [], form)}</span>
        </label>
        <label className="setting">
          Console password
          <input
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            minLength={8}
            placeholder="leave blank for agent-only"
          />
          <span className="setting-hint">Only needed if this person signs in to the dashboard.</span>
        </label>
      </div>

      {/* Most permissions narrow what the role already allows and never widen
          it: an employee with every box ticked still only ever sees themselves,
          so the form greys them out rather than rendering checkboxes that
          quietly mean nothing.

          `selfScoped` ones are the exception and stay live at every role — they
          act on the holder, not on other people. Blanket-disabling the section
          had taken "can punch from anywhere" away from field staff and remote
          hires, who are precisely the plain employees it exists for. */}
      <h3 className="perm-heading">
        What they can do
        {form.role === 'employee' && (
          <span className="perm-note">
            An employee only ever sees their own work — the greyed ones make no
            difference until the role is Manager or Admin.
          </span>
        )}
      </h3>
      <div className="perm-grid">
        {PERMISSIONS.map((p) => (
          <label className="perm-row" key={p.key}>
            <input
              type="checkbox"
              checked={form[p.key]}
              disabled={form.role === 'employee' && !('selfScoped' in p && p.selfScoped)}
              onChange={(e) => setForm({ ...form, [p.key]: e.target.checked })}
            />
            <span className="perm-body">
              <span className="perm-label">{p.label}</span>
              <span className="perm-desc">{p.description}</span>
            </span>
          </label>
        ))}
      </div>

      {/* Ticking a page here hides the nav link, blocks the route, AND makes the
          server refuse its endpoints. All three, or a kept bookmark walks past
          the first two. */}
      <h3 className="perm-heading">
        Pages they can open
        <span className="perm-note">
          Everything is on by default. Dashboard, My performance and Notifications
          are always available.
        </span>
      </h3>
      <div className="page-chips">
        {PAGES.map((p) => {
          const on = !form.hidden_pages.includes(p.key)
          return (
            <button
              type="button"
              key={p.key}
              className={`page-chip${on ? ' page-chip-on' : ''}`}
              aria-pressed={on}
              onClick={() =>
                setForm({
                  ...form,
                  hidden_pages: on
                    ? [...form.hidden_pages, p.key]
                    : form.hidden_pages.filter((k) => k !== p.key),
                })
              }
            >
              {p.label}
            </button>
          )
        })}
      </div>

      <div style={{ marginTop: 16 }}>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create employee'}
        </button>
      </div>
    </form>
  )
}

/* What the chosen role reaches, in the role's own words.
 *
 * Replaces a hardcoded sentence per level, which could only ever describe the
 * four the product shipped with. A company's own "Finance Officer" has a
 * description and a scope, and those are the true answer to "what will this
 * person be able to do" — the level alone stopped being it the moment scope
 * became a field of its own. */
function roleSummary(roles: OrgRole[], form: { role_id: string; role: string }): string {
  const named = roles.find((r) => r.id === form.role_id)
  if (!named) return 'Choose a role. Roles are defined in Settings → Roles & Permissions.'
  const scope: Record<string, string> = {
    self: 'only their own record',
    team: 'their reporting line',
    department: 'their whole department',
    company: 'the whole company',
  }
  const count = Object.values(named.permissions).filter(Boolean).length
  return `${named.description ? named.description + ' ' : ''}Sees ${
    scope[named.data_scope] ?? named.data_scope
  }, with ${count} permission${count === 1 ? '' : 's'}.`
}
