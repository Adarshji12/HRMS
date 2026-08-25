import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../lib/api'
import { useQuery } from '../lib/useQuery'
import { PAGES, PERMISSIONS, ROLE_SUMMARY } from '../lib/employeeFields'
import type { Department, Team, User } from '../lib/types'
import { ErrorNote } from './ui'

interface Designation {
  id: string
  name: string
}

/** Everything the server will accept on PATCH /admin/employees/{id}. */
interface Draft {
  full_name: string
  role: string
  is_active: boolean
  employee_code: string
  phone: string
  timezone: string
  team_id: string
  department_id: string
  designation_id: string
  manager_id: string
  password: string
  can_view_screenshots: boolean
  can_approve_timesheets: boolean
  can_export_data: boolean
  can_manage_projects: boolean
  // Every module that has landed since the original four adds a flag here. The
  // list is driven by PERMISSIONS in lib/employeeFields, so a flag missing from
  // this type is a checkbox that renders and then fails to typecheck — which is
  // how these were noticed absent in the first place.
  can_manage_people: boolean
  can_issue_letters: boolean
  can_approve_expenses: boolean
  can_reimburse_expenses: boolean
  can_approve_loans: boolean
  can_disburse_loans: boolean
  can_manage_payroll: boolean
  hidden_pages: string[]
}

function draftFrom(user: User): Draft {
  return {
    full_name: user.full_name,
    role: user.role,
    is_active: user.is_active,
    employee_code: user.employee_code ?? '',
    phone: user.phone ?? '',
    timezone: user.timezone ?? '',
    team_id: user.team_id ?? '',
    department_id: user.department_id ?? '',
    designation_id: user.designation_id ?? '',
    manager_id: user.manager_id ?? '',
    password: '',
    can_view_screenshots: user.can_view_screenshots,
    can_approve_timesheets: user.can_approve_timesheets,
    can_export_data: user.can_export_data,
    can_manage_projects: user.can_manage_projects,
    can_manage_people: user.can_manage_people !== false,
    can_issue_letters: user.can_issue_letters !== false,
    can_approve_expenses: user.can_approve_expenses !== false,
    can_reimburse_expenses: user.can_reimburse_expenses !== false,
    can_approve_loans: user.can_approve_loans !== false,
    can_disburse_loans: user.can_disburse_loans !== false,
    can_manage_payroll: user.can_manage_payroll === true,
    hidden_pages: user.hidden_pages ?? [],
  }
}

/**
 * Edit an existing employee.
 *
 * The API has accepted all of this since the permissions work landed; there was
 * simply no form. So changing somebody's role, resetting a forgotten password
 * or moving them to a new manager meant an API call by hand — which is not a
 * thing an administrator should have to do, and is why nobody did it.
 */
export default function EmployeeEdit({
  employee,
  onClose,
  onSaved,
}: {
  employee: User
  onClose: () => void
  onSaved: () => void
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(employee))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const teams = useQuery<Team[]>('teams', () => api.get<Team[]>('/org/teams'))
  const departments = useQuery<Department[]>('departments', () =>
    api.get<Department[]>('/org/departments'),
  )
  const designations = useQuery<Designation[]>('designations', () =>
    api.get<Designation[]>('/org/designations'),
  )
  const people = useQuery<User[]>('employees', () => api.get<User[]>('/admin/employees'))

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      // Only what changed. Sending the whole draft would rewrite fields the
      // operator never touched, and would push an empty password on every save.
      const body: Record<string, unknown> = {}
      const original = draftFrom(employee)
      for (const key of Object.keys(draft) as Array<keyof Draft>) {
        if (key === 'password') continue
        const next = draft[key]
        if (JSON.stringify(next) === JSON.stringify(original[key])) continue
        // The id selects use '' for "none"; the API wants null.
        body[key] = next === '' && key.endsWith('_id') ? null : next
      }
      if (draft.password.trim()) body.password = draft.password.trim()

      if (Object.keys(body).length === 0) {
        onClose()
        return
      }

      await api.patch(`/admin/employees/${employee.id}`, body)
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  const isEmployee = draft.role === 'employee'
  // Nobody can manage themselves, and the server refuses a loop anyway.
  const managers = (people.data ?? []).filter((p) => p.id !== employee.id)

  return (
    <div className="hx-backdrop" onMouseDown={onClose}>
      <form
        className="hx-dialog emp-dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={save}
      >
        <div className="hx-dialog-head">
          <h2 className="hx-dialog-title">Edit {employee.full_name}</h2>
          <p className="muted-sm">{employee.email}</p>
        </div>

        <div className="hx-list emp-body">
          {error && <div style={{ marginBottom: 12 }}><ErrorNote>{error}</ErrorNote></div>}

          <div className="settings-grid">
            <label className="setting">
              Full name
              <input
                value={draft.full_name}
                onChange={(e) => set('full_name', e.target.value)}
                required
              />
            </label>

            <label className="setting">
              Role
              <select value={draft.role} onChange={(e) => set('role', e.target.value)}>
                <option value="employee">Employee</option>
                <option value="manager">Manager</option>
                <option value="admin">Admin</option>
              </select>
              <span className="setting-hint">{ROLE_SUMMARY[draft.role]}</span>
            </label>

            <label className="setting">
              Reports to
              <select value={draft.manager_id} onChange={(e) => set('manager_id', e.target.value)}>
                <option value="">Nobody — top level</option>
                {managers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.full_name}
                  </option>
                ))}
              </select>
              <span className="setting-hint">
                A loop is refused by the server — somebody cannot report to their own report.
              </span>
            </label>

            <label className="setting">
              Team
              <select value={draft.team_id} onChange={(e) => set('team_id', e.target.value)}>
                <option value="">Unassigned</option>
                {(teams.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </label>

            <label className="setting">
              Department
              <select
                value={draft.department_id}
                onChange={(e) => set('department_id', e.target.value)}
              >
                <option value="">Unassigned</option>
                {(departments.data ?? []).map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </label>

            <label className="setting">
              Designation
              <select
                value={draft.designation_id}
                onChange={(e) => set('designation_id', e.target.value)}
              >
                <option value="">Unassigned</option>
                {(designations.data ?? []).map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </label>

            <label className="setting">
              Employee code
              <input
                value={draft.employee_code}
                onChange={(e) => set('employee_code', e.target.value)}
              />
            </label>

            <label className="setting">
              Phone
              <input value={draft.phone} onChange={(e) => set('phone', e.target.value)} />
            </label>

            <label className="setting">
              New password
              <input
                type="password"
                value={draft.password}
                onChange={(e) => set('password', e.target.value)}
                autoComplete="new-password"
                minLength={8}
                placeholder="leave blank to keep the current one"
              />
              <span className="setting-hint">
                There is no self-service reset, so this is how a forgotten password is fixed.
              </span>
            </label>
          </div>

          <h3 className="perm-heading">
            Account
          </h3>
          <label className="perm-row">
            <input
              type="checkbox"
              checked={draft.is_active}
              onChange={(e) => set('is_active', e.target.checked)}
            />
            <span className="perm-body">
              <span className="perm-label">Active</span>
              <span className="perm-desc">
                Switching this off signs them out immediately — any token they already
                hold stops working on the next request — and their agents stop reporting.
              </span>
            </span>
          </label>

          <h3 className="perm-heading">
            What they can do
            {isEmployee && (
              <span className="perm-note">
                An employee only ever sees their own work — these make no difference
                until the role is Manager or Admin.
              </span>
            )}
          </h3>
          <div className="perm-grid" aria-disabled={isEmployee}>
            {PERMISSIONS.map((p) => (
              <label className="perm-row" key={p.key}>
                <input
                  type="checkbox"
                  checked={draft[p.key]}
                  disabled={isEmployee}
                  onChange={(e) => set(p.key, e.target.checked)}
                />
                <span className="perm-body">
                  <span className="perm-label">{p.label}</span>
                  <span className="perm-desc">{p.description}</span>
                </span>
              </label>
            ))}
          </div>

          <h3 className="perm-heading">
            Pages they can open
            <span className="perm-note">Switched-off pages are refused by the server, not just hidden.</span>
          </h3>
          <div className="page-chips">
            {PAGES.map((page) => {
              const on = !draft.hidden_pages.includes(page.key)
              return (
                <button
                  type="button"
                  key={page.key}
                  className={`page-chip${on ? ' page-chip-on' : ''}`}
                  onClick={() =>
                    set(
                      'hidden_pages',
                      on
                        ? [...draft.hidden_pages, page.key]
                        : draft.hidden_pages.filter((k) => k !== page.key),
                    )
                  }
                  aria-pressed={on}
                >
                  {page.label}
                </button>
              )
            })}
          </div>
        </div>

        <div className="hx-dialog-foot">
          <button type="button" className="btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </div>
  )
}
