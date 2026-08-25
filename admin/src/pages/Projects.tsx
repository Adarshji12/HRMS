import { useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import '../styles/projects.css'
import { api } from '../lib/api'
import { useQuery } from '../lib/useQuery'
import { canAdminister, useAuth } from '../lib/auth'
import { duration } from '../lib/format'
import type { Department, Project, ProjectReport, User } from '../lib/types'
import { EmptyState, ErrorNote, Loading, StatTile } from '../components/ui'
import { ExportButton } from '../components/ExportButton'
import { IconFolder } from '../components/Icons'

/** Paise → "₹1,23,456". Money is integer paise everywhere; format only here. */
export function rupees(paise: number, withDecimals = false): string {
  return `₹${(paise / 100).toLocaleString('en-IN', {
    minimumFractionDigits: withDecimals ? 2 : 0,
    maximumFractionDigits: withDecimals ? 2 : 0,
  })}`
}

export const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  on_hold: 'On hold',
  completed: 'Completed',
  archived: 'Archived',
}

export function ProjectStatusPill({ value }: { value: string }) {
  return <span className={`pj-pill pj-${value}`}>{STATUS_LABEL[value] ?? value}</span>
}

export default function Projects() {
  const { user } = useAuth()
  const isAdmin = canAdminister(user)
  const [showArchived, setShowArchived] = useState(false)
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [managerId, setManagerId] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [billable, setBillable] = useState('')

  const projects = useQuery<Project[]>(`projects:${showArchived}`, () =>
    api.get<Project[]>(`/projects?include_archived=${showArchived}`),
  )
  const report = useQuery<ProjectReport>('project-report', () =>
    api.get<ProjectReport>('/projects/report'),
  )
  const departments = useQuery<Department[]>('departments', () =>
    api.get<Department[]>('/org/departments'),
  )
  /* Managers come from the projects themselves rather than the employee list:
     the set of people who actually manage something is far shorter than the
     roster, and it cannot contain a name that matches nothing. */
  const managers = useMemo(() => {
    const seen = new Map<string, string>()
    for (const p of projects.data ?? []) {
      if (p.manager_user_id && p.manager_name) seen.set(p.manager_user_id, p.manager_name)
    }
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]))
  }, [projects.data])

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const base = (projects.data ?? []).filter((p) => {
      if (status && p.status !== status) return false
      if (managerId && p.manager_user_id !== managerId) return false
      if (departmentId && p.department_id !== departmentId) return false
      if (billable === 'yes' && !p.is_billable) return false
      if (billable === 'no' && p.is_billable) return false
      return true
    })
    if (!needle) return base
    return base.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        (p.code ?? '').toLowerCase().includes(needle) ||
        (p.client_name ?? '').toLowerCase().includes(needle),
    )
  }, [projects.data, query, status, managerId, departmentId, billable])

  if (projects.error) return <ErrorNote>{projects.error}</ErrorNote>

  const totals = report.data?.totals

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Projects</h1>
          <p className="page-sub">
            Tracked time is attributed to projects by rule or by the employee's own selection.
            Billable hours drive the amounts below.
          </p>
        </div>
        <div className="head-actions">
          {/* Reuses the Project Report rather than adding a second, subtly
              different definition of "project hours" — one engine, one answer,
              whichever page you asked from. */}
          <ExportButton
            href="/reports/project/export.csv"
            filename="project-report.csv"
            disabled={(projects.data ?? []).length === 0}
          />
          {isAdmin && (
            <button className="btn btn-primary" onClick={() => setAdding((v) => !v)}>
              {adding ? 'Cancel' : 'New project'}
            </button>
          )}
        </div>
      </div>

      {totals && (
        <div className="grid grid-tiles" style={{ marginBottom: 14 }}>
          <StatTile label="Tracked (30 days)" value={duration(totals.tracked_s)} />
          <StatTile
            label="Billable"
            value={duration(totals.billable_s)}
            meta={
              totals.tracked_s
                ? `${Math.round((totals.billable_s / totals.tracked_s) * 100)}% of tracked`
                : undefined
            }
            accent="var(--prod)"
          />
          <StatTile
            label="Billable value"
            value={rupees(totals.billable_amount)}
            meta="at project rates"
          />
          <StatTile
            label="Active projects"
            value={String((projects.data ?? []).filter((p) => p.status === 'active').length)}
          />
        </div>
      )}

      {adding && <NewProject onDone={() => { setAdding(false); projects.reload(); report.reload() }} />}

      <div className="filter-row">
        <input
          type="search"
          placeholder="Search name, code or client…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ minWidth: 260 }}
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="on_hold">On hold</option>
          <option value="completed">Completed</option>
          <option value="archived">Archived</option>
        </select>
        <select
          value={managerId}
          onChange={(e) => setManagerId(e.target.value)}
          aria-label="Manager"
        >
          <option value="">Any manager</option>
          {managers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <select
          value={departmentId}
          onChange={(e) => setDepartmentId(e.target.value)}
          aria-label="Department"
        >
          <option value="">All departments</option>
          {departments.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select value={billable} onChange={(e) => setBillable(e.target.value)} aria-label="Billing">
          <option value="">Billable and not</option>
          <option value="yes">Billable only</option>
          <option value="no">Non-billable only</option>
        </select>
        <label className="check-field">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          <span>Include archived</span>
        </label>
        <span className="filter-count">
          {rows.length} of {(projects.data ?? []).length}
        </span>
        {(query || status || managerId || departmentId || billable) && (
          <button
            className="filter-reset"
            onClick={() => {
              setQuery(''); setStatus(''); setManagerId(''); setDepartmentId(''); setBillable('')
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <section className="card">
          {projects.loading ? (
            <Loading />
          ) : query ? (
            <EmptyState
              icon={<IconFolder size={22} />}
              title="No projects match that search"
              body={<>Nothing matches “{query}”. Clear the search, or tick “Include archived” if the project has been closed.</>}
            />
          ) : (
            <EmptyState
              icon={<IconFolder size={22} />}
              title="No projects yet"
              body="Create one, then add an attribution rule so tracked time lands on it automatically. Until a project exists, tracked time stays unattributed."
              action={
                isAdmin && (
                  <button className="btn btn-primary" onClick={() => setAdding(true)}>
                    Create the first project
                  </button>
                )
              }
            />
          )}
        </section>
      ) : (
        <div className="pj-grid">
          {rows.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
    </div>
  )
}

function ProjectCard({ project }: { project: Project }) {
  const budgetPct = project.budget_minutes
    ? Math.round((project.tracked_seconds / 60 / project.budget_minutes) * 100)
    : null
  const over = budgetPct !== null && budgetPct > 100

  return (
    <Link className="pj-card" to={`/projects/${project.id}`}>
      <div className="pj-card-head">
        <span
          className="pj-swatch"
          style={{ background: project.color || 'var(--brand)' }}
          aria-hidden="true"
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="pj-name">{project.name}</div>
          <div className="pj-sub">
            {[project.code, project.client_name].filter(Boolean).join(' · ') || 'No client'}
          </div>
        </div>
        <ProjectStatusPill value={project.status} />
      </div>

      <div className="pj-stats">
        <div>
          <span className="pj-stat-label">Tracked</span>
          <b>{duration(project.tracked_seconds)}</b>
        </div>
        <div>
          <span className="pj-stat-label">Billable</span>
          <b>{duration(project.billable_seconds)}</b>
        </div>
        <div>
          <span className="pj-stat-label">Tasks</span>
          <b>
            {project.open_task_count}
            <span className="pj-of">/{project.task_count}</span>
          </b>
        </div>
        <div>
          <span className="pj-stat-label">People</span>
          <b>{project.member_count}</b>
        </div>
      </div>

      {budgetPct !== null && (
        <div className="pj-budget">
          <div className="pj-budget-head">
            <span>Budget {Math.round(project.budget_minutes / 60)}h</span>
            {/* The number is stated, not only implied by bar length — an
                over-budget project must be readable without measuring. */}
            <b className={over ? 'pj-over' : undefined}>{budgetPct}%</b>
          </div>
          <span className="pj-budget-track">
            <span
              className={`pj-budget-fill ${over ? 'pj-budget-over' : ''}`}
              style={{ width: `${Math.min(100, Math.max(2, budgetPct))}%` }}
            />
          </span>
        </div>
      )}

      {!project.is_billable && <div className="pj-flag">Non-billable</div>}
    </Link>
  )
}

function NewProject({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({
    name: '',
    code: '',
    client_name: '',
    status: 'active',
    is_billable: true,
    hourly_rate_rupees: 0,
    budget_hours: 0,
    manager_user_id: '',
    department_id: '',
    color: '#5b18d9',
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const people = useQuery<User[]>('employees', () => api.get<User[]>('/admin/employees'))
  const departments = useQuery<Department[]>('departments', () =>
    api.get<Department[]>('/org/departments'),
  )

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post('/projects', {
        ...form,
        code: form.code || null,
        client_name: form.client_name || null,
        manager_user_id: form.manager_user_id || null,
        department_id: form.department_id || null,
      })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the project')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card" style={{ marginBottom: 16 }} onSubmit={submit}>
      <div className="card-head">
        <h2 className="card-title">New project</h2>
      </div>
      {error && <div style={{ marginBottom: 12 }}><ErrorNote>{error}</ErrorNote></div>}

      <div className="settings-grid">
        <label className="setting">
          Project name
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoFocus />
        </label>
        <label className="setting">
          Code
          <input
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
            placeholder="ACME-WEB"
          />
          <span className="setting-hint">Short handle used in reports and rules.</span>
        </label>
        <label className="setting">
          Client
          <input value={form.client_name} onChange={(e) => setForm({ ...form, client_name: e.target.value })} />
        </label>
        <label className="setting">
          Project manager
          <select value={form.manager_user_id} onChange={(e) => setForm({ ...form, manager_user_id: e.target.value })}>
            <option value="">Unassigned</option>
            {people.data?.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
          </select>
        </label>
        <label className="setting">
          Department
          <select value={form.department_id} onChange={(e) => setForm({ ...form, department_id: e.target.value })}>
            <option value="">None</option>
            {departments.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <label className="setting">
          Hourly rate (₹)
          <input
            type="number"
            min={0}
            step={50}
            value={form.hourly_rate_rupees}
            onChange={(e) => setForm({ ...form, hourly_rate_rupees: Number(e.target.value) })}
          />
        </label>
        <label className="setting">
          Budget (hours)
          <input
            type="number"
            min={0}
            step={10}
            value={form.budget_hours}
            onChange={(e) => setForm({ ...form, budget_hours: Number(e.target.value) })}
          />
          <span className="setting-hint">0 means no budget tracking.</span>
        </label>
        <label className="setting">
          Colour
          <input type="color" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} />
        </label>
        <div className="setting">
          <label className="switch-row">
            <input
              type="checkbox"
              checked={form.is_billable}
              onChange={(e) => setForm({ ...form, is_billable: e.target.checked })}
            />
            <span>Billable project</span>
          </label>
          <span className="setting-hint">
            Applies to time recorded from now on. Existing entries keep the flag they were saved with.
          </span>
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create project'}
        </button>
      </div>
    </form>
  )
}
